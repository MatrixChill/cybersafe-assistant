import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ClamavBridge,
  clamavSlotStats,
  releasePoisonedClamavSlot,
} from "../dist/clamav.js";

/**
 * REV 4 (HOLD Codex #1 e #3) — POSSE DA VAGA, CONCORRÊNCIA AOS DOIS SENTIDOS,
 * MORTE TARDIA E CANCELAMENTO DA PROVA DE CARGA.
 *
 * HOLD #1: a prova fazia spawn sem `acquireClamavSlot` (podia correr
 * CONCORRENTE com um scan) e, no `deathUnconfirmed`, envenenava a vaga SEM
 * nunca a ter adquirido (bloqueava o motor inteiro para sempre). Esta suite
 * prova o contrário: posse durante a corrida, libertação/envenenamento só por
 * quem possui, e cancelamento da espera.
 *
 * HOLD #3: `dispose()` armava um `setTimeout` de 5 s que ficava armado mesmo
 * com zero filhos e mantinha o processo vivo — reproduzido aqui num processo
 * filho, a medir o tempo real de saída (o sintoma do Codex: dispose_ms=1 mas
 * process_wall_ms≈5063).
 *
 * Requer `CYBERSAFE_CLAMSCAN_PATH` (sonda de versão real). Sem o env → skip.
 */

const CLAMSCAN = process.env.CYBERSAFE_CLAMSCAN_PATH;
const ok = CLAMSCAN ? test : test.skip;

const SUMMARY_OK =
  "----------- SCAN SUMMARY -----------\nKnown viruses: 3628193\nEngine version: 1.5.4\nScanned files: 1\nInfected files: 0\n";

function mockHandle({ value, autoKill = false, resolveImmediately = false } = {}) {
  let resolveOutcome;
  const outcome = new Promise((res) => {
    resolveOutcome = res;
  });
  const handle = {
    pid: 9100 + Math.floor(Math.random() * 1000),
    killCalls: 0,
    deathHooks: [],
    killTree() {
      this.killCalls += 1;
      if (autoKill) resolveOutcome(value);
    },
    onDeathConfirmed(fn) {
      this.deathHooks.push(fn);
    },
    outcome,
    _resolve: resolveOutcome,
  };
  if (resolveImmediately) resolveOutcome(value);
  return handle;
}

function fakeDbDir(files = ["main.cvd"]) {
  const dir = path.join(os.tmpdir(), `cs-rev4-db-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(path.join(dir, f), f === "main.cvd" ? "fake bytes" : "x");
  return dir;
}

async function registado(bridge) {
  for (let i = 0; i < 100; i += 1) {
    if (bridge.liveChildPids().length > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

ok("rev4 | posse: durante a prova active=1; morte confirmada → active=0", async (t) => {
  const dir = fakeDbDir();
  const handle = mockHandle(); // fica pendente: a prova SEGURA a vaga
  const bridge = new ClamavBridge({
    datadir: dir,
    loadProofEnabled: true,
    probeTimeoutMs: 60_000,
    spawn: () => handle,
  });
  const probe = bridge.isAvailable();
  try {
    assert.equal(await registado(bridge), true, "o handle devia estar registado");
    assert.equal(clamavSlotStats().active, 1, "a prova POSSUI a vaga durante a corrida");
    handle._resolve({ code: 0, stdout: SUMMARY_OK, stderr: "" });
    assert.equal(await probe, true);
    assert.equal(clamavSlotStats().active, 0, "morte confirmada → vaga liberta");
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

ok("rev4 | conCorrência SENTIDO 1: prova B espera a vaga de A (nunca spawna em paralelo)", async () => {
  const dirA = fakeDbDir();
  const dirB = fakeDbDir();
  const holdA = mockHandle(); // A fica em curso: vaga ocupada
  const bridgeA = new ClamavBridge({
    datadir: dirA,
    loadProofEnabled: true,
    probeTimeoutMs: 60_000,
    spawn: () => holdA,
  });
  const probeA = bridgeA.isAvailable();
  const spawnsB = [];
  const bridgeB = new ClamavBridge({
    datadir: dirB,
    loadProofEnabled: true,
    probeTimeoutMs: 60_000,
    spawn: () => {
      spawnsB.push(1);
      return mockHandle({ value: { code: 0, stdout: SUMMARY_OK, stderr: "" }, resolveImmediately: true });
    },
  });
  try {
    assert.equal(await registado(bridgeA), true, "A devia ter a vaga");
    assert.equal(clamavSlotStats().active, 1);
    const probeB = bridgeB.isAvailable(true);
    // mentre a vaga está ocupada por A, B NÃO spawna:
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(spawnsB.length, 0, "B nunca pode spawnar com a vaga ocupada por A");
    // A termina com morte confirmada → a vaga transita para B.
    holdA._resolve({ code: 0, stdout: SUMMARY_OK, stderr: "" });
    assert.equal(await probeA, true);
    assert.equal(await probeB, true);
    assert.equal(spawnsB.length, 1, "B spawna só depois de A libertar a vaga");
    assert.equal(clamavSlotStats().active, 0);
  } finally {
    await bridgeA.dispose();
    await bridgeB.dispose();
    await fs.rm(dirA, { recursive: true, force: true });
    await fs.rm(dirB, { recursive: true, force: true });
  }
});

ok("rev4 | conCorrência SENTIDO 2: vaga envenenada → prova NÃO spawna (recusa honesta)", async () => {
  const dirA = fakeDbDir();
  const dirB = fakeDbDir();
  // A morre sem confirmação → envenena a vaga QUE POSSUI.
  // O `close` do filho (outcome com `deathUnconfirmed`) chega IMEDIATAMENTE:
  // este cenário não é um timeout — é o spawner a reportar morte não
  // confirmada pelo SO. (`autoKill` aqui só resolveria no deadline de 60 s,
  // desperdiçando 60 s por corrida e testando o deadline, não o cenário.)
  const holdA = mockHandle({
    resolveImmediately: true,
    value: { code: null, stdout: "", stderr: "", killed: true, deathUnconfirmed: true },
  });
  const bridgeA = new ClamavBridge({ datadir: dirA, loadProofEnabled: true, probeTimeoutMs: 60_000, spawn: () => holdA });
  try {
    assert.equal(await bridgeA.isAvailable(), false);
    assert.equal(clamavSlotStats().poisoned, 1, "A envenenou a vaga (posse)");
    // B chega depois: a vaga está envenenada → NUNCA spawna, degradado honesto.
    const spawnsB = [];
    const bridgeB = new ClamavBridge({
      datadir: dirB,
      loadProofEnabled: true,
      probeTimeoutMs: 60_000,
      spawn: () => {
        spawnsB.push(1);
        return mockHandle({ value: { code: 0, stdout: SUMMARY_OK, stderr: "" }, resolveImmediately: true });
      },
    });
    try {
      assert.equal(await bridgeB.isAvailable(true), false);
      assert.equal(spawnsB.length, 0, "vaga envenenada → B não spawna");
      assert.equal(bridgeB.health.status, "degraded");
      assert.match(bridgeB.health.detail, /envenenada|indispon/i);
    } finally {
      await bridgeB.dispose();
    }
    // Morte tardia de A (como o `close` real do spawner): a vaga volta.
    releasePoisonedClamavSlot();
    assert.equal(clamavSlotStats().poisoned, 0);
  } finally {
    await bridgeA.dispose();
    await fs.rm(dirA, { recursive: true, force: true });
    await fs.rm(dirB, { recursive: true, force: true });
  }
});

ok("rev4 | cancelamento: dispose durante a ESPERA pela vaga → abort, sem spawn", async () => {
  const dirA = fakeDbDir();
  const dirB = fakeDbDir();
  const holdA = mockHandle(); // A fica em curso, vaga ocupada
  const bridgeA = new ClamavBridge({ datadir: dirA, loadProofEnabled: true, probeTimeoutMs: 60_000, spawn: () => holdA });
  const probeA = bridgeA.isAvailable();
  const spawnsB = [];
  const bridgeB = new ClamavBridge({
    datadir: dirB,
    loadProofEnabled: true,
    probeTimeoutMs: 60_000,
    spawn: () => {
      spawnsB.push(1);
      return mockHandle({ value: { code: 0, stdout: SUMMARY_OK, stderr: "" }, resolveImmediately: true });
    },
  });
  try {
    assert.equal(await registado(bridgeA), true, "A devia ter a vaga");
    const probeB = bridgeB.isAvailable(true);
    await new Promise((r) => setTimeout(r, 200));
    const inicio = Date.now();
    await bridgeB.dispose(); // aborta a espera pela vaga
    const decorrido = Date.now() - inicio;
    assert.ok(decorrido < 2_000, `dispose devia abortar a espera (${decorrido} ms)`);
    assert.equal(await probeB, false, "prova cancelada");
    assert.equal(spawnsB.length, 0, "B nunca spawnou");
    // A continua e termina normalmente (morte confirmada).
    holdA._resolve({ code: 0, stdout: SUMMARY_OK, stderr: "" });
    await probeA;
  } finally {
    await bridgeA.dispose();
    await fs.rm(dirA, { recursive: true, force: true });
    await fs.rm(dirB, { recursive: true, force: true });
  }
});

ok("rev4 | posse SEM fuga: lease recusada liberta a vaga (active=0)", async () => {
  const dir = fakeDbDir();
  const bridge = new ClamavBridge({
    datadir: dir,
    loadProofEnabled: true,
    probeTimeoutMs: 60_000,
    spawn: () => mockHandle({ value: { code: 0, stdout: SUMMARY_OK, stderr: "" }, resolveImmediately: true }),
    acquireDatabaseLease: () => ({ refused: true, reason: "update-active" }),
  });
  try {
    assert.equal(await bridge.isAvailable(), false);
    assert.equal(clamavSlotStats().active, 0, "lease recusada não pode deixar a vaga presa");
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── HOLD #3: dispose não pode deixar um timer de 5 s vivo ────────────────
ok("rev4 | dispose SEM handles: o processo saí imediatamente (reprodução do Codex)", async () => {
  // O sintoma medido pelo Codex: `dispose` de bridge vazia devolvia em 1 ms,
  // mas o PROCESSO ficava vivo ~5 s (setTimeout do órçamento sem ninguém a
  // esperar). Um filho real mede o tempo de saída — 0 handle → saída rápida.
  const distUrl = new URL("../dist/clamav.js", import.meta.url).href;
  const script = `
    const { ClamavBridge } = await import(${JSON.stringify(distUrl)});
    const b = new ClamavBridge({ disposeBudgetMs: 5000 });
    const t0 = Date.now();
    await b.dispose();
    process.stdout.write("EXIT_MS=" + (Date.now() - t0));
  `;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 20_000,
  });
  const wall = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  const match = /EXIT_MS=(\d+)/.exec(r.stdout ?? "");
  assert.ok(match, `saída inesperada: ${r.stdout}`);
  const exitMs = Number(match[1]);
  assert.ok(exitMs < 3_000, `processo viveu ${exitMs} ms após dispose vazio — timer residual!`);
  assert.ok(wall < 10_000, `wall total ${wall} ms excedeu o limite de segurança`);
});

ok("rev4 | dispose com filho que resolve JÁ → timer do órçamento limpo (saída rápida)", async () => {
  // O órgamento (5 s) existe para um filho que NUNCA emite close. Quando o
  // child resolve primeiro, o timer tem de ser LIMPO — senão o processo fica
  // vivo ~5 s. Medido num processo-filho real.
  const distUrl = new URL("../dist/clamav.js", import.meta.url).href;
  const dir = fakeDbDir();
  const script = `
    import { ClamavBridge, clamavSlotStats } from ${JSON.stringify("file://" + distUrl.replace("file://", ""))};
    const b = new ClamavBridge({ datadir: ${JSON.stringify(dir)}, disposeBudgetMs: 5000 });
    const handle = {
      pid: 4242,
      killTree() {},
      onDeathConfirmed() {},
      killCalls: 0,
      outcome: Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    };
    // Corrida real: dispose espera pelo outcome; o outcome resolve JA.
    const t0 = Date.now();
    b.liveHandles.add = b.liveHandles.add ?? (() => {});
    b.liveHandles.add(handle);
    await b.dispose();
    process.stdout.write("EXIT_MS=" + (Date.now() - t0));
  `;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 20_000,
  });
  const wall = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  const match = /EXIT_MS=(\d+)/.exec(r.stdout ?? "");
  assert.ok(match, `saída inesperada: ${r.stdout}`);
  const exitMs = Number(match[1]);
  assert.ok(exitMs < 3_000, `dispose esperou ${exitMs} ms por um filho já morto — timer residual!`);
  assert.ok(wall < 10_000, `wall total ${wall} ms excedeu o limite de segurança`);
  await fs.rm(dir, { recursive: true, force: true });
});