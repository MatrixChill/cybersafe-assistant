import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClamavBridge, createSpawnClamav, isTrackedClamavPid } from "../dist/index.js";
import { isLoadProof, makeLoadProofHandle } from "./fixtures/clamav-load-proof.js";

/**
 * CODEX Scanner lifecycle — a cauda de stdout que chega DEPOIS do grace.
 *
 * ── O que estes testes provam ────────────────────────────────────────────────
 * Quando `killTree()` não consegue confirmar a morte do clamscan, o grace
 * resolve a `outcome` como `deathUnconfirmed` (não como "morreu"). O contrato
 * honesto a partir daí é:
 *   1. o resultado publicado é `unavailable` — nunca `clean`;
 *   2. stdout tardio não pode introduzir um veredicto limpo num resultado já
 *      publicado;
 *   3. o PID é untracked e a vaga fica envenenada até o `close` (a prova do SO)
 *      chegar — só então a vaga volta;
 *   4. a `--file-list` temporária sai de disco mesmo em `deathUnconfirmed`.
 *
 * ── Porque os hooks de identidade capturam no SPAWN ─────────────────────────
 * A classificação de identidade compara a `CreationDate` lida com o instante
 * do spawn. Se a leitura for derivada de `Date.now()` NO MOMENTO DA LEITURA (e
 * não no spawn), a criação aparece "anterior ao spawn" e a classificação
 * rejeita (`unavailable`) — o kill nunca é tentado, o `close` nunca chega, e
 * TODOS os scans resolvem pelo grace. Era um bug do harness: o teste dizia
 * exercitar o caminho de kill/soltura da vaga sem nunca o exercitar. Aqui a
 * criação e a command line são capturadas por PID no instante do spawn e
 * reutilizadas por `probeIdentity`/`captureIdentity` (o mesmo padrão de
 * `clamav-kill-grace-cap.test.js`).
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeFakeReadyDefinitions(root) {
  const dir = path.join(root, "definitions", "clamav");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "main.cvd"), "x");
  await fs.writeFile(path.join(dir, "daily.cld"), "x");
  return path.join(root, "definitions");
}

function makeFakeChild({ pid, unkillable }) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const state = { killCalls: 0, died: false };
  child.state = state;
  child.kill = () => {
    state.killCalls++;
    if (unkillable) return false; // não matou — é o caso do grace
    child.die(0);
    return true;
  };
  child.die = (code) => {
    if (state.died) return;
    state.died = true;
    setImmediate(() => child.emit("close", code));
  };
  return child;
}

/**
 * Hooks com identidade REAL por PID, capturada no spawn.
 *
 * `identities` guarda, para cada PID, a `CreationDate` e a command line que o
 * SO teria lido NO INSTANTE do spawn. É essa a linha que `probeIdentity` e
 * `captureIdentity` devolvem — nunca uma re-derivada mais tarde.
 */
function makeHooks({ pidBase, firstUnkillable }) {
  const children = [];
  const counts = { spawn: 0 };
  const identities = new Map();
  const reading = (pid) => {
    const known = identities.get(pid) ?? { created: new Date().toISOString(), cmd: "" };
    return {
      row: {
        pid,
        ppid: process.pid,
        name: "clamscan.exe",
        exe: "C:\\Program Files\\ClamAV\\clamscan.exe",
        created: known.created,
        cmd: known.cmd,
      },
      probeFailed: false,
      detail: "simulado",
    };
  };
  return {
    children,
    spawn: (file, args) => {
      const pid = pidBase + counts.spawn;
      const unkillable = firstUnkillable && counts.spawn === 0;
      const child = makeFakeChild({ pid, unkillable });
      children.push(child);
      counts.spawn++;
      identities.set(pid, {
        created: new Date(Date.now() - 50).toISOString(),
        cmd: [file, ...(args ?? [])].join(" "),
      });
      return child;
    },
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({ v: "killed", root: true, descendants: 0, refused: 0 }),
    }),
    probeIdentity: reading,
    captureIdentity: async (pid) => reading(pid),
  };
}

async function newScenario({ firstUnkillable = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cs-late-stdout-"));
  await makeFakeReadyDefinitions(root);
  const hooks = makeHooks({ pidBase: 50000, firstUnkillable });
  const clamavSpawn = createSpawnClamav(hooks);
  const bridge = new ClamavBridge({
    definitionsDir: path.join(root, "definitions"),
    // A prova de carga spawna pelo mesmo seam e, sem filtro, ficava com o
    // índice 0 — que é precisamente o filho `firstUnkillable` do scan, o
    // `children[0]` observado e a contagem de spawns. Ela responde fora da
    // simulação; o primeiro filho passa a ser o do scan.
    spawn: (file, args, request) =>
      isLoadProof(request) ? makeLoadProofHandle() : clamavSpawn(file, args, request),
    scanTimeoutMs: 30,
  });
  return { root, hooks, bridge };
}

async function cleanup({ root, hooks }) {
  for (const c of hooks.children) c.die(0);
  await sleep(30);
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

function batchFilesForOurPidSync() {
  // Read-only, síncrono, para poder ser usado antes de um await sem perder a
  // janela de observação. Só devolve nomes; não abre nem apaga nada.
  try {
    return readdirSync(os.tmpdir()).filter((f) => f.startsWith(`cybersafe-clamav-batch-${process.pid}-`));
  } catch {
    return [];
  }
}

describe("CODEX Scanner lifecycle — late stdout tail after grace timeout", () => {
  it("grace resolves enquanto o filho está vivo; stdout tardio não vira veredicto limpo", async () => {
    const s = await newScenario();
    try {
      const alvo = path.join(s.root, "alvo.exe");
      const outcome = await s.bridge.scanFiles([alvo], { scanTimeoutMs: 30 });

      // A morte não foi confirmada: o resultado é `unavailable`, não `clean`.
      assert.equal(outcome.status.status, "unavailable", "scan deve ser unavailable com morte não confirmada");
      assert.equal(
        s.hooks.children[0].state.died,
        false,
        "o `close` não chegou: o filho está vivo e o grace resolveu sozinho",
      );
      assert.ok(s.hooks.children[0].state.killCalls >= 1, "o caminho de kill tinha de ser exercitado");

      const cleanPublicados = (outcome.files ?? []).filter((f) => f.verdict === "clean");
      assert.equal(
        cleanPublicados.length,
        0,
        `o resultado já publicado não pode ser limpo: ${cleanPublicados.length} veredicto(s) clean`,
      );

      // stdout TARDIO chega DEPOIS de a promise ter resolvido. Não pode existir
      // outro caminho para a cauda contar como um ficheiro avaliado.
      s.hooks.children[0].stdout.emit("data", Buffer.from(`${alvo}: OK\n`));
      await sleep(30);
      const cleanDepois = (outcome.files ?? []).filter((f) => f.verdict === "clean");
      assert.equal(
        cleanDepois.length,
        0,
        `stdout tardio introduziu um veredicto limpo num resultado publicado: ${cleanDepois.length}`,
      );
      assert.equal(outcome.status.status, "unavailable", "e o estado do motor continua indisponível");
    } finally {
      await cleanup(s);
    }
  });

  it("PID é untracked após grace e a vaga volta apenas após o close", async () => {
    const s = await newScenario();
    try {
      const pid = s.hooks.children[0]?.pid ?? 50000;
      const r1 = await s.bridge.scanFile(path.join(s.root, "alvo.exe"));
      assert.equal(r1.status.status, "unavailable", "primeiro scan deve ser unavailable");
      assert.equal(s.hooks.children[0].state.died, false, "a morte não foi confirmada");

      // `finish()` corre `untrackClamavPid(child.pid)`: o PID sai do tracking já
      // aqui, mesmo com o processo potencialmente vivo. O que preserva a posse é
      // a vaga envenenada + a lease presa, não o tracking.
      assert.equal(isTrackedClamavPid(pid), false, `PID ${pid} não deve estar tracked após o grace`);

      const r2 = await s.bridge.scanFile(path.join(s.root, "b.txt"));
      assert.equal(r2.status.status, "unavailable", "a vaga envenenada não deve aceitar um segundo scan");

      // A prova do SO chega: o `close` liberta a vaga envenenada.
      s.hooks.children[0].die(0);
      await sleep(300);

      const r3 = await s.bridge.scanFile(path.join(s.root, "c.txt"));
      assert.equal(
        r3.status.status,
        "degraded",
        "depois do close, a vaga volta e o scan seguinte corre até ao deadline",
      );
      assert.equal(s.hooks.children.length, 2, "tem de ter havido um segundo spawn, não uma vaga presa");
    } finally {
      await cleanup(s);
    }
  });

  it("a --file-list temporária é removida mesmo em morte não confirmada", async () => {
    const s = await newScenario();
    try {
      // Forçar o caminho da `--file-list`: muitos caminhos, somados acima de
      // MAX_CLAMSCAN_ARGV_CHARS (8000). Com 1 ficheiro o argv cabe e a lista
      // nunca é criada — era outro bug do harness (o teste não exercitava o
      // caminho que dizia testar).
      const files = [];
      for (let i = 0; i < 160; i++) {
        const f = path.join(s.root, "p".repeat(30), `file-${i}.txt`);
        files.push(f);
      }
      const argvChars = files.reduce((n, f) => n + f.length, 0);
      assert.ok(argvChars > 8000, `o cenário tem de forçar a file-list: ${argvChars} chars`);

      const antes = new Set(batchFilesForOurPidSync());

      const scanP = s.bridge.scanFiles(files, { scanTimeoutMs: 30 });

      // Durante o scan a lista tem de estar em disco (prova de que foi usada).
      let observada = false;
      for (let i = 0; i < 40 && !observada; i++) {
        await sleep(50);
        observada = batchFilesForOurPidSync().some((f) => !antes.has(f));
      }
      assert.equal(observada, true, "a --file-list devia ter sido criada durante o scan");

      const outcome = await scanP;
      assert.equal(outcome.status.status, "unavailable", "a morte não confirmada deve dar unavailable");

      // E tem de sair de disco — mesmo com o filho potencialmente vivo — sem
      // deixar rasto novo. O escopo é SÓ os ficheiros do nosso PID criados por
      // este cenário: varrer o tmpdir global apanhava lixo de runs anteriores.
      const depois = batchFilesForOurPidSync();
      const vazados = depois.filter((f) => !antes.has(f));
      assert.equal(vazados.length, 0, `nenhuma --file-list nova pode ficar em disco: ${vazados.join(", ")}`);
    } finally {
      await cleanup(s);
    }
  });
});
