import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClamavBridge, clamavSlotStats } from "../dist/index.js";
import { isLoadProof, makeLoadProofHandle } from "./fixtures/clamav-load-proof.js";

/**
 * P0 STARVATION — BACKPRESSURE na fila de background.
 *
 * A prioridade resolve o scan do utilizador, mas não impede a fila de crescer
 * sem fim: uma proteção em tempo real cujo motor gasta ~6 s por ficheiro recebe
 * eventos muito mais depressa do que os consegue analisar. Sem tecto, o
 * resultado é memória a crescer e um backlog de minutos que ninguém vê.
 *
 * O que se afirma aqui:
 *   1. a fila de BACKGROUND tem tecto, e acima dele a recusa é HONESTA
 *      (`unavailable` + detalhe), NUNCA um veredicto "limpo" fabricado;
 *   2. a recusa é CONTABILIZADA (telemetria), não silenciosa;
 *   3. um scan do UTILIZADOR nunca é recusado por causa do tecto — é uma ação
 *      explícita e entra sempre;
 *   4. o limite de clamscan simultâneos continua a ser 1.
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

/** Spawner com portão (o filho só termina quando o teste o libertar). */
function makeGatedSpawner() {
  const state = { spawned: 0, live: 0, peak: 0, pids: [] };
  const releases = new Map();
  const spawn = (_file, args, request) => {
    // A prova passa pela bridge e pela vaga global, mas não é um job retido.
    if (isLoadProof(request)) return makeLoadProofHandle();
    state.spawned++;
    state.live++;
    state.peak = Math.max(state.peak, state.live);
    const pid = 50000 + state.spawned;
    const target = String(args[args.length - 1]);
    state.pids.push(pid);
    let resolveOutcome;
    let dead = false;
    const finish = (outcome) => {
      if (dead) return;
      dead = true;
      state.live--;
      resolveOutcome(outcome);
    };
    releases.set(pid, () =>
      finish({ code: 0, stdout: `${target}: OK\n`, stderr: "", timedOut: false, killed: false }),
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
    releaseAll() {
      for (const pid of [...state.pids]) releases.get(pid)?.();
    },
  };
}

let tmp;
let gate;
let bridge;
const fired = [];

function target(i) {
  return path.join(tmp, `bp-${String(i).padStart(4, "0")}.txt`);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-slotbp-"));
  gate = makeGatedSpawner();
  bridge = new ClamavBridge({
    definitionsDir: await makeFakeReadyDefinitions(tmp),
    spawn: gate.spawn,
    scanTimeoutMs: 5_000,
  });
  fired.length = 0;
  assert.equal(await bridge.isAvailable(), true, "a prova de carga conclui antes de medir a fila");
  assert.equal(gate.state.spawned, 0, "a prova de carga não é um job do portão");
});

afterEach(async () => {
  // A vaga é GLOBAL: drenar sempre, mesmo que o teste falhe, para o teste
  // seguinte não herdar uma fila.
  for (let i = 0; i < 600; i++) {
    gate?.releaseAll();
    await sleep(3);
  }
  gate?.releaseAll();
  await Promise.allSettled(fired);
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("P0 STARVATION — a fila de background é LIMITADA", () => {
  it("acima do tecto a recusa é honesta e contabilizada; o scan do utilizador nunca é recusado", async () => {
    const limit = clamavSlotStats().maxQueuedBackground;
    assert.ok(limit > 0 && Number.isFinite(limit), "o tecto tem de existir e ser finito");

    // 1 job ativo prende a vaga.
    fired.push(bridge.scanFiles([target(0)], {}));
    await waitFor(() => gate.state.spawned === 1, { label: "job ativo" });

    // Enche a fila de BACKGROUND até ao tecto (sem scanId = background).
    for (let i = 1; i <= limit; i++) fired.push(bridge.scanFiles([target(i)], {}));
    await waitFor(() => clamavSlotStats().waitingBackground === limit, {
      label: "fila de background cheia",
    });

    // Um scan do UTILIZADOR entra na mesma — a ação explícita não é recusada.
    fired.push(bridge.scanFiles([target(9000)], { scanId: "user-na-fila-cheia" }));
    await waitFor(() => clamavSlotStats().waitingUser === 1, { label: "scan do utilizador na fila" });

    // O job a mais é RECUSADO — e a recusa diz o que é.
    const overflow = await bridge.scanFiles([target(9999)], {});
    assert.equal(overflow.status.status, "unavailable", "recusa = indisponível");
    assert.match(
      String(overflow.status.detail),
      /ocupado/i,
      "o detalhe tem de dizer que o motor estava ocupado",
    );
    assert.equal(
      overflow.files[0].verdict,
      "error",
      "um ficheiro que não foi analisado NUNCA pode ser reportado como 'clean'",
    );

    const stats = clamavSlotStats();
    assert.equal(stats.droppedBackground, 1, "a recusa é contabilizada, não silenciosa");
    assert.equal(stats.active, 1, "MAX_ACTIVE_CLAMSCAN continua a ser 1");
    assert.equal(stats.poisoned, 0, "nenhuma vaga foi envenenada por backpressure");
  });
});
