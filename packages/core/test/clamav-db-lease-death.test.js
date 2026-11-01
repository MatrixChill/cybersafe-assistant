/**
 * CODEX (2026-10-03) — A LEASE DA BASE SÓ SE LIBERTA COM PROVA DE MORTE.
 *
 * O buraco que o Codex encontrou, e que era MEU:
 *
 * O `finally` do scan libertava a lease da base SEMPRE. Mas `deathUnconfirmed`
 * não quer dizer "o scan acabou" — quer dizer "ninguém provou que o clamscan
 * morreu". O semáforo tratava disso (envenenava a vaga), a lease da base não.
 * O gate via a base como livre enquanto o clamscan podia ter 1 GB dela abertos,
 * e o freshclam escrevia por cima.
 *
 * O teste usa um filho SIMULADO, como os outros do pacote: um clamscan real a
 * recusar morrer é impossível de fabricar, e o caminho que interessa é
 * precisamente esse.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ClamavBridge, createSpawnClamav } from "../dist/index.js";
import {
  isLoadProof,
  makeLoadProofHandle,
  withLoadProofLease,
} from "./fixtures/clamav-load-proof.js";

const SCAN_ARGS = ["--database=definitions", "C:\\scan\\alvo.exe"];

/**
 * Filho simulado que, quando mata, NÃO emite `close` — o caso em que o grace
 * expira e a morte nunca é confirmada.
 */
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
  child.confirmDeath = (code = 0) => {
    if (child.state.died) return;
    child.state.died = true;
    child.emit("close", code);
  };
  return child;
}

describe("CODEX P1-1 — a lease só se liberta com prova de morte", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-lease-"));
  });
  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });


  /*
   * ORDEM COM RAZÃO.
   *
   * O primeiro caso ENVENOENA o semáforo do ClamAV - é o que ele faz de
   * propósito, ao ficar sem prova de morte. O veneno é de PROCESSO. Na ordem
   * antiga, este caso normal corria já envenenado: o runScan respondia
   * unavailable sem spawnar nada, e a libertação da lease observada era a do
   * caminho normal, não a que se queria medir.
   *
   * Passava na mesma, pelo motivo errado - que é o pior resultado que um teste
   * pode ter. Por isso a ordem conta, e por isso o caso sem gancho mora noutro
   * ficheiro.
   */
  it("a lease é libertada normalmente quando o scan morre com certeza", async () => {
    let releases = 0;
    const child = new EventEmitter();
    child.pid = 4343;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.emit("close", 0);
      return true;
    };

    const bridge = new ClamavBridge({
      // A prova de carga pede a lease com a chave `"load-proof"` e liberta-a no
      // seu próprio `finally`. Contar essa libertação como se fosse a do scan é
      // exatamente o "passar pelo motivo errado" que este ficheiro existe para
      // evitar; por isso o pedido da prova tem lease própria.
      acquireDatabaseLease: withLoadProofLease(() => ({
        release() {
          releases++;
        },
        released: false,
      })),
      spawn: (file, args, request) => (isLoadProof(request) ? makeLoadProofHandle() : child),
      spawnSync: () => ({ status: 0, stdout: "Scanned files: 1\nInfected files: 0\n", stderr: "", error: undefined }),
      probeIdentity: () => ({ row: null, probeFailed: true, detail: "sem identidade" }),
      captureIdentity: async () => ({ row: null, probeFailed: true, detail: "sem captura" }),
    });
    bridge._dbDir = tmpDir;
    bridge._hasSignatures = true;

    await bridge.scanFile(path.join(tmpDir, "alvo2.exe"), { scanTimeoutMs: 2_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(releases, 1, `um scan que morreu com certeza liberta a lease uma vez (libertada ${releases}x)`);
  });

  it("com morte NÃO confirmada, a lease fica presa até o SO confirmar", async () => {
    let child = null;
    let releases = 0;

    const clamavSpawn = createSpawnClamav({
      spawn: () => {
        child = makeStubbornChild(4242);
        return child;
      },
      spawnSync: () => {
        throw new Error("a terminação NÃO pode correr");
      },
      probeIdentity: () => ({ row: null, probeFailed: true, detail: "sem identidade" }),
      captureIdentity: async () => ({ row: null, probeFailed: true, detail: "sem captura" }),
    });

    const bridge = new ClamavBridge({
      // A lease: conta quantas vezes foi libertada. O pedido da prova de carga
      // (`"load-proof"`) tem lease própria: este contador é sobre o scan, e a
      // prova liberta a dela no `finally` dela.
      acquireDatabaseLease: withLoadProofLease(() => ({
        release() {
          releases++;
        },
        released: false,
      })),
      // O spawner é o de PRODUÇÃO (`createSpawnClamav`), com o filho trocado.
      //
      // A primeira versão deste teste passava um handle feito à mão, sem o
      // `whenDeathConfirmed` — e o gancho de produção nunca era exercitado. O
      // teste passou a provar o dublê, não o código. Aqui o handle é o real, e
      // o que é simulado é SÓ o processo.
      //
      // A prova de carga spawna pelo MESMO seam e, sem filtro, o filho
      // teimoso dela envenenava a vaga ANTES do scan nascer — `child` ficava a
      // apontar para o filho da prova e o teste media a prova. Ela responde
      // fora da simulação, com morte confirmada.
      spawn: (file, args, request) =>
        isLoadProof(request) ? makeLoadProofHandle() : clamavSpawn(file, args, request),
    });

    // A ponte tem de ter assinaturas para chegar ao spawn.
    bridge._dbDir = tmpDir;
    bridge._hasSignatures = true;

    // scan curto + kill por timeout, para o grace expirar sem prova de morte.
    const scan = bridge.scanFile(path.join(tmpDir, "alvo.exe"), { scanTimeoutMs: 30 });
    const result = await scan.catch((e) => ({ erro: String(e) }));

    // O que interessa não é o veredicto: é a lease.
    assert.equal(
      releases,
      0,
      `a lease NÃO pode ser libertada enquanto o clamscan puder estar vivo (libertada ${releases}x)`,
    );

    // Agora o SO confirma a morte. Aí, e só aí, a lease sai.
    child.confirmDeath();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(
      releases,
      1,
      `a prova de morte do SO é o que liberta a lease — nem mais, nem menos (libertada ${releases}x)`,
    );

    void result;
  });

});
