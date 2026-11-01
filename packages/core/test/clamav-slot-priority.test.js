import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClamavBridge, clamavSlotStats } from "../dist/index.js";
import { isLoadProof, makeLoadProofHandle } from "./fixtures/clamav-load-proof.js";

/**
 * P0 SCANNER_RUNTIME_ZERO_PROGRESS — STARVATION DA VAGA GLOBAL DO CLAMAV.
 *
 * Evidência runtime (Quick Scan real, scanId ea56fe6a-3639-40e9-9d85-f8d82a884a48):
 *
 *   FILES_DISCOVERED 800 / FILES_SELECTED 800 / gather 88 920 ms
 *   PREFETCH 730 candidatos -> FILE_LIST 730 entries, 48 996 bytes
 *   CLAMAV_SLOT_ACQUIRE_BEGIN active=1 waiting=79 limit=1
 *   CLAMAV_SLOT_WAIT waitedMs≈35 019 active=1 waiting=80   (e 40 019, waiting=79)
 *   ... e o scan foi CANCELADO antes de CLAMAV_SLOT_ACQUIRE_END.
 *
 * Ou seja: o batch 730 não estava lento — NUNCA COMEÇOU. Ficou atrás de ~80
 * análises unitárias de background que disputavam a única vaga.
 *
 * A impressão digital que separa as duas classes é MEDIDA, não inventada: os
 * jobs de background chegam ao tracing como `scanId=n/a` + `count=1 strategy=argv`
 * (passam por `analysis.ts` -> `clamav.scanFile` sem scanId), enquanto o scan do
 * utilizador traz um scanId real (ScanManager). É por isso que estes testes
 * exprimem a prioridade da forma que o produto já usa — `scanId` presente ou
 * ausente — sem precisarem de nenhuma API nova.
 *
 * Todos os filhos são FALSOS e ficam presos num PORTÃO: a ordem de atribuição da
 * vaga fica observável sem timers nem corridas.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 5_000, label = "condição" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(5);
  }
  throw new Error(`waitFor(${label}) expirou após ${timeoutMs} ms`);
}

async function makeFakeReadyDefinitions(root) {
  const dir = path.join(root, "definitions", "clamav");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "main.cvd"), "x");
  await fs.writeFile(path.join(dir, "daily.cld"), "x");
  return path.join(root, "definitions");
}

/**
 * Spawner com PORTÃO. Cada filho só termina quando o teste o libertar, o que
 * torna a FILA observável: o job ativo fica preso o tempo que for preciso.
 */
function makeGatedSpawner() {
  const state = { spawned: 0, live: 0, peak: 0, order: [] };
  const releases = new Map();

  const spawn = (_file, args, request) => {
    // A prova exerce o semáforo real, mas não é um scan preso no portão.
    if (isLoadProof(request)) return makeLoadProofHandle();
    state.spawned++;
    state.live++;
    state.peak = Math.max(state.peak, state.live);
    const pid = 40000 + state.spawned;
    // O último argumento identifica o alvo (argv: [--database=…, …ficheiros]).
    const target = String(args[args.length - 1]);
    state.order.push({ pid, target });

    let resolveOutcome;
    let dead = false;
    const finish = (outcome) => {
      if (dead) return;
      dead = true;
      state.live--;
      resolveOutcome(outcome);
    };
    releases.set(pid, (outcome) =>
      finish(outcome ?? { code: 0, stdout: `${target}: OK\n`, stderr: "", timedOut: false, killed: false }),
    );

    return {
      pid,
      killTree() {
        finish({ code: null, stdout: "", stderr: "", timedOut: false, killed: true });
      },
      outcome: new Promise((resolve) => {
        resolveOutcome = resolve;
      }),
    };
  };

  return {
    spawn,
    state,
    release(pid, outcome) {
      const fn = releases.get(pid);
      assert.ok(fn, `sem filho vivo com pid=${pid}`);
      fn(outcome);
    },
    /** Liberta quantos filhos estiverem vivos (drenagem). */
    releaseAll(outcome) {
      for (const { pid } of [...state.order]) releases.get(pid)?.(outcome);
    },
  };
}

let tmp;
let gate;
let bridge;
let paths;
const fired = [];

function target(i) {
  return path.join(tmp, `bg-${String(i).padStart(3, "0")}.txt`);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-slotprio-"));
  gate = makeGatedSpawner();
  bridge = new ClamavBridge({
    definitionsDir: await makeFakeReadyDefinitions(tmp),
    spawn: gate.spawn,
    // O job ativo fica preso no portão, não no deadline. 5 s é só o seguro
    // para que um teste falhado não deixe um timer vivo a segurar o processo.
    scanTimeoutMs: 5_000,
  });
  fired.length = 0;
  assert.equal(await bridge.isAvailable(), true, "a prova de carga conclui antes de medir a fila");
  assert.equal(gate.state.spawned, 0, "a prova de carga não é um job do portão");
});

afterEach(async () => {
  // DRENAGEM OBRIGATÓRIA: a vaga é GLOBAL (estado de módulo) e partilhada por
  // todos os testes deste ficheiro. Se um teste falhar antes de drenar, os
  // waiters dele continuariam à espera e o teste SEGUINTE falharia por um
  // motivo que não é dele — foi o que aconteceu na primeira corrida RED.
  // Cada `release` transfere a vaga para o waiter seguinte, que spawna de
  // imediato, logo largar em ciclo esvazia as duas filas.
  for (let i = 0; i < 500; i++) {
    gate?.releaseAll();
    await sleep(3);
  }
  gate?.releaseAll();
  await Promise.allSettled(fired);
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("P0 STARVATION — o scan do utilizador não espera atrás da fila de background", () => {
  it("1 job ativo + 80 em espera + 1 scan do utilizador -> o utilizador recebe a vaga SEGUINTE", async () => {
    const manualTarget = target(901);

    // 1 job ATIVO de background: SEM scanId — a impressão digital real
    // (`scanId=n/a`, `count=1 strategy=argv`).
    fired.push(bridge.scanFiles([target(0)], {}));
    await waitFor(() => gate.state.spawned === 1, { label: "job ativo a spawnar" });

    // 80 jobs de background à espera da vaga (o cenário medido: waiting=79/80).
    for (let i = 1; i <= 80; i++) fired.push(bridge.scanFiles([target(i)], {}));
    await waitFor(() => clamavSlotStats().waitingBackground === 80, {
      label: "80 análises de background na fila",
    });

    // 1 scan do UTILIZADOR: tem scanId, como o Quick Scan real.
    fired.push(
      bridge.scanFiles([target(900), manualTarget], { scanId: "ea56fe6a-3639-40e9-9d85-f8d82a884a48" }),
    );
    await waitFor(() => clamavSlotStats().waitingUser === 1, { label: "utilizador na fila" });

    assert.equal(gate.state.spawned, 1, "só pode existir 1 clamscan vivo (MAX_CLAMSCAN=1)");

    // O job ativo termina: a vaga é TRANSFERIDA. Para quem?
    gate.release(gate.state.order[0].pid);
    await waitFor(() => gate.state.spawned === 2, { label: "atribuição da vaga seguinte" });

    assert.equal(
      gate.state.order[1].target,
      manualTarget,
      "RED: a vaga seguinte tem de ser o SCAN DO UTILIZADOR; foi atribuída a " +
        `${gate.state.order[1].target} (a fila de background ultrapassou o scan real — ` +
        "é este o bug que deixou o Quick Scan em 0/800)",
    );

    // E o background só retoma DEPOIS do scan do utilizador.
    gate.release(gate.state.order[1].pid);
    await waitFor(() => gate.state.spawned === 3, { label: "retoma do background" });
    assert.equal(
      gate.state.order[2].target,
      target(1),
      "o background retoma logo a seguir, e pela ordem em que chegou",
    );

    // Drena os 82 jobs e prova três coisas: nada se perdeu, o cap nunca subiu
    // de 1, e o background é FIFO dentro da sua classe.
    for (let i = 0; i < 400 && gate.state.spawned < 82; i++) {
      gate.releaseAll();
      await sleep(3);
    }
    gate.releaseAll();
    await Promise.allSettled(fired);

    assert.equal(gate.state.spawned, 82, "82 jobs submetidos, 82 atribuições");
    assert.equal(gate.state.peak, 1, "MAX_ACTIVE_CLAMSCAN tem de continuar a ser 1");
    assert.deepEqual(
      gate.state.order.slice(2).map((o) => o.target),
      Array.from({ length: 80 }, (_, i) => target(i + 1)),
      "FIFO dentro do background (a prioridade não pode baralhar a ordem da mesma classe)",
    );
  });

  it("um scan do utilizador CANCELADO enquanto espera desaparece da fila", async () => {
    fired.push(bridge.scanFiles([target(0)], {}));
    await waitFor(() => gate.state.spawned === 1, { label: "job ativo" });

    const ac = new AbortController();
    const cancelled = bridge.scanFiles([target(900)], { scanId: "cancel-me", signal: ac.signal });
    const background = bridge.scanFiles([target(1)], {});
    fired.push(cancelled, background);
    await waitFor(() => clamavSlotStats().waitingUser === 1 && clamavSlotStats().waitingBackground === 1, {
      label: "ambas as classes na fila antes do aborto",
    });

    ac.abort();
    await waitFor(() => clamavSlotStats().waitingUser === 0, { label: "cancelado removido da fila" });

    gate.release(gate.state.order[0].pid);
    await waitFor(() => gate.state.spawned === 2, { label: "vaga seguinte" });

    assert.equal(
      gate.state.order[1].target,
      target(1),
      "o scan cancelado não pode consumir a vaga (nem atrasar o background)",
    );
    const res = await cancelled;
    assert.equal(res.status.status, "unavailable", "cancelado = indisponível, nunca 'clean'");

    gate.releaseAll();
    await Promise.allSettled([...fired, background]);
  });

  it("dispose com fila à espera drena a fila — nenhum scan fica pendurado", async () => {
    fired.push(bridge.scanFiles([target(0)], {}));
    await waitFor(() => gate.state.spawned === 1, { label: "job ativo" });

    // Jobs de background À ESPERA da vaga (o cenário real tinha ~80). Um
    // shutdown tem de os acordar: uma promessa que nunca resolve é a mesma
    // classe de falha silenciosa que deixou o Quick Scan em 0/800.
    const queued = [1, 2, 3].map((i) => bridge.scanFiles([target(i)], {}));
    fired.push(...queued);
    await waitFor(() => clamavSlotStats().waitingBackground === queued.length, {
      label: "fila de background com os jobs à espera",
    });

    await bridge.dispose();

    // Corrida contra o relógio de propósito: se a fila NÃO drenar, a falha é um
    // teste vermelho legível em vez de uma suite pendurada.
    const results = await Promise.race([
      Promise.all(queued),
      sleep(3_000).then(() => null),
    ]);
    assert.ok(
      results,
      "scans ficaram PENDURADOS depois do dispose: a fila não foi drenada",
    );
    for (const res of results) {
      assert.equal(res.status.status, "unavailable", "dispose = indisponível, nunca 'clean'");
    }
    assert.equal(
      gate.state.spawned,
      1,
      "o dispose não pode deixar nascer um clamscan novo só para recusá-lo a seguir",
    );
  });

  it("um cancelamento que chega DURANTE a escrita da lista não deixa nascer o clamscan", async (t) => {
    // Interceta só a conclusão da escrita: os bytes e o cleanup são reais.
    // O portão evita depender da velocidade do disco ou de uma lista de 22 MB.
    const many = Array.from({ length: 200 }, (_, i) => target(i));
    const prefix = `cybersafe-clamav-batch-${process.pid}-`;
    const originalWriteFile = fs.writeFile;
    let releaseWrite;
    const writing = new Promise((resolve) => { releaseWrite = resolve; });
    let listFile;
    const writeMock = t.mock.method(fs, "writeFile", async (file, ...args) => {
      await originalWriteFile(file, ...args);
      if (path.basename(String(file)).startsWith(prefix)) {
        listFile = String(file);
        await writing;
      }
    });
    syncBuiltinESMExports();
    const ac = new AbortController();
    try {
      fired.push(bridge.scanFiles(many, { signal: ac.signal }));
      await waitFor(() => Boolean(listFile), { label: "escrita da lista em curso" });
      assert.equal(await fs.readFile(listFile, "utf8"), many.join("\n") + "\n");
      ac.abort();
      releaseWrite();
      const res = await Promise.race([fired[0], sleep(5_000).then(() => null)]);
      assert.ok(res, "o scan cancelado ficou pendurado no portão do subprocesso");
      assert.equal(res.status.status, "unavailable", "cancelado = indisponível, nunca 'clean'");
      assert.ok(res.files.every((file) => file.verdict === "error"), "nenhum ficheiro cancelado é limpo");
      assert.equal(gate.state.spawned, 0, "o clamscan NÃO pode nascer depois do cancelamento");
      await assert.rejects(fs.stat(listFile), { code: "ENOENT" }, "a lista tem de ser removida");
    } finally {
      releaseWrite();
      writeMock.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it("uma vaga ENVENENADA acorda as DUAS filas (ninguém fica preso à espera)", async () => {
    fired.push(bridge.scanFiles([target(0)], {}));
    await waitFor(() => gate.state.spawned === 1, { label: "job ativo" });

    const user = bridge.scanFiles([target(900)], { scanId: "u-que-espera" });
    const background = bridge.scanFiles([target(1)], {});
    fired.push(user, background);
    await waitFor(() => clamavSlotStats().waitingUser === 1 && clamavSlotStats().waitingBackground === 1, {
      label: "ambas as classes na fila antes da morte não confirmada",
    });

    // Morte NÃO confirmada: é isto que envenena a vaga no `finally` da bridge.
    gate.release(gate.state.order[0].pid, {
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      killed: false,
      deathUnconfirmed: true,
    });

    const [u, b] = await Promise.all([user, background]);
    assert.equal(u.status.status, "unavailable", "a fila do utilizador não pode ficar presa");
    assert.equal(b.status.status, "unavailable", "a fila de background não pode ficar presa");
    assert.equal(
      gate.state.spawned,
      1,
      "com a vaga envenenada não pode nascer outro clamscan (~2 GB em voo)",
    );
  });
});
