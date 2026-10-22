/**
 * CODEX (2026-10-03), achado 5 — A LEASE SEM GANCHO TAMBÉM FICA PRESA.
 *
 * Este caso mora num FICHEIRO À PARTE, e não por estilo. O caso anterior
 * envenena o semáforo do ClamAV (`poisonClamavSlot`, que é o que impede um
 * segundo clamscan enquanto não há prova de morte), e o veneno é de PROCESSO.
 * Com os dois no mesmo ficheiro, este teste correria com o semáforo já
 * envenenado: o `runScan` responderia `unavailable` sem sequer chegar a
 * spawnar, e o teste passaria pelo motivo errado.
 *
 * Foi exactamente o que aconteceu na primeira versão: `releases` contava 1 e o
 * teste parecia provar que a lease era libertada — quando na verdade não havia
 * scan nenhum. `node --test` corre cada ficheiro no seu processo, e é isso que
 * isola o veneno.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ClamavBridge, createSpawnClamav } from "../dist/index.js";

/** Filho que, quando mata, NÃO emite `close` — a morte nunca é confirmada. */
function makeStubbornChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.state = { died: false, kills: 0 };
  child.kill = () => {
    child.state.kills++;
    return true; // mente: não morre
  };
  return child;
}

describe("CODEX P1-1 achado 5 — sem gancho de prova de morte", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-lease-nohook-"));
  });
  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });


  it("a lease fica presa mesmo quando a handle não traz o gancho", async () => {
    // O achado: o ramo `else` do `finally` libertava a lease quando a handle
    // não trazia `onDeathConfirmed`. Com `deathUnconfirmed`, a verdade é que
    // NINGUÉM PROVOU que o clamscan morreu — libertar a lease dizia ao gate que
    // a base estava livre, e um freshclam escreveria por cima de um processo
    // que pode ter 1 GB dela abertos. Era a corrida que o gate existe para
    // fechar, reintroduzida pela porta do "não sei".
    let releases = 0;

    let child = null;
    const base = createSpawnClamav({
      spawn: () => {
        child = makeStubbornChild(4444);
        return child;
      },
      spawnSync: () => {
        throw new Error("a terminação NÃO pode correr");
      },
      probeIdentity: () => ({ row: null, probeFailed: true, detail: "sem identidade" }),
      captureIdentity: async () => ({ row: null, probeFailed: true, detail: "sem captura" }),
    });

    const bridge = new ClamavBridge({
      acquireDatabaseLease: () => ({
        release() {
          releases++;
        },
        released: false,
      }),
      // A handle sai SEM `onDeathConfirmed` — que é o spawner antigo, o
      // injectado, o que não tem o gancho. É o único cenário onde o `else`
      // corre, e é por isso que o `else` tem de estar certo.
      //
      // A assinatura tem de ser a de `ClamavSpawnFn` — `(file, args, request)`.
      // A primeira versão escrevia `(args, opts)`, que desliava os argumentos: o
      // spawner real recebia o executable como `file` e morria a meio, sem
      // spawnar nada. O teste falhava, mas por um motivo que não era o que
      // estava a testar.
      spawn: (file, args, request) => {
        const handle = base(file, args, request);
        return { pid: handle.pid, killTree: handle.killTree, outcome: handle.outcome };
      },
      spawnSync: () => {
        throw new Error("a terminação NÃO pode correr");
      },
      probeIdentity: () => ({ row: null, probeFailed: true, detail: "sem identidade" }),
      captureIdentity: async () => ({ row: null, probeFailed: true, detail: "sem captura" }),
    });
    bridge._dbDir = tmpDir;
    bridge._hasSignatures = true;

    await bridge.scanFile(path.join(tmpDir, "alvo.exe"), { scanTimeoutMs: 30 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    // Prova de que o scan chegou sequer a nascer: sem isto, um `unavailable`
    // por semáforo envenenado contaria como "não libertou" e o teste passaria
    // sem provar nada.
    assert.ok(child, "o scan tem de ter nascido — senão o teste não prova nada");

    assert.equal(
      releases,
      0,
      `sem prova de morte, a lease NÃO pode ser libertada: é a mentira que o resto do bloco existe para não contar (libertada ${releases}x)`,
    );
  });
});
