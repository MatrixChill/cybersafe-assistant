/**
 * CODEX (2026-10-03), achado 1 — O `error` DO CLAMSCAN NÃO É PROVA DE MORTE.
 *
 * Este caso mora num FICHEIRO À PARTE. Ele envenena o semáforo do ClamAV — que
 * é o que se quer verificar — e o veneno é de PROCESSO. Com outro caso que o
 * envenene no mesmo ficheiro, um deles correria já envenado: o `runScan`
 * responderia `unavailable` sem spawnar nada, e passaria pelo motivo errado.
 *
 * Foi o que aconteceu duas vezes enquanto se escrevia isto, em sentido inverso:
 * a versão que accentava o `error` envenenava o caso "sem gancho", e o
 * inverso também. `node --test` corre cada ficheiro no seu processo.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ClamavBridge, createSpawnClamav } from "../dist/index.js";

describe("CODEX P1-1 achado 1 — `error` com filho vivo", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-err-death-"));
  });
  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("um `error` com filho VIVO não resolve o scan nem liberta a lease", async () => {
    // O Codex reproduziu sobreposição em 10 de 10 rondas: o freshclam arrancava
    // com um clamscan vivo.
    //
    // O Node emite `error` também quando NÃO CONSEGUIR MATAR o filho, e não só
    // quando o spawn falha. O handler resolvia o outcome a rigor, sem marcar
    // `deathUnconfirmed`: a vaga e a lease da base voltavam à circulação com o
    // clamscan ainda a correr.
    //
    // A correcção: sem `child.pid` o processo nunca nasceu e o scan pode
    // resolver; com `child.pid` há processo, e quem traz a prova de que acabou
    // é o `close` — ou, na falta dele, o temporizador de tolerância, que marca
    // `deathUnconfirmed` e deixa tudo preso.
    let releases = 0;

    let child = null;
    const base = createSpawnClamav({
      spawn: () => {
        child = new EventEmitter();
        child.pid = 6161;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        // `kill` mente: o processo não morre e não emite `close`.
        child.kill = () => true;
        // `error` depois de o spawner ligar os ouvintes — é o "não consegui
        // matar", não o "spawn falhou".
        setImmediate(() => child.emit("error", new Error("não foi possível matar")));
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
      spawn: base,
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

    assert.ok(child, "o clamscan tem de ter nascido — senão o teste não prova nada");
    assert.equal(
      releases,
      0,
      `com o filho vivo, um \`error\` NÃO pode devolver a lease: o freshclam escreveria por cima do clamscan (libertada ${releases}x)`,
    );
  });
});
