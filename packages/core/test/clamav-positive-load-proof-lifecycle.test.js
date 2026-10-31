import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ClamavBridge, clamavSlotStats, releasePoisonedClamavSlot } from "../dist/clamav.js";

/**
 * CICLO DE VIDA DA PROVA DE CARGA (rev 2 — revisão Codex, HOLD).
 *
 * A prova NÃO é um `execFileAsync` avulso: passa pelo mesmo caminho dos scans
 * — lease da base (exclusão com troca FreshClam), `liveHandles` (o `dispose`
 * mata-a), deadline com `killTree()` e morte CONFIRMADA, single-flight (nem
 * `force` arranca duas) e políticas de modos (`loadProofEnabled: false` →
 * nenhum spawn, nenhuma fixture).
 *
 * Requer `CYBERSAFE_CLAMSCAN_PATH` (versão real do clamscan) porque a sonda
 * de VERSÃO também executa o binário — mesmo padrão dos testes do serviço
 * (`fecho14`). Sem o env, os testes são `skip`, nunca falhos.
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
    pid: 4242 + Math.floor(Math.random() * 1000),
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
  // Diretório com a base FALSA (só existência+mtime conta para escolher):
  // o classificador diz `ready` e a versão real + spawn mock decidem o resto.
  const dir = path.join(os.tmpdir(), `cs-probe-db-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(path.join(dir, f), f === "main.cvd" ? "fake bytes" : "x");
  return dir;
}

function fakeLease() {
  const lease = { released: false, release() { this.released = true; } };
  return lease;
}

ok("lifecycle | lease recusada → SEM spawn, degradado honesto (exclusão FreshClam)", async (t) => {
  const dir = fakeDbDir();
  const spawns = [];
  const bridge = new ClamavBridge({
    datadir: dir,
    spawn: (file, args) => {
      spawns.push({ file, args });
      return mockHandle();
    },
    acquireDatabaseLease: () => ({ refused: true, reason: "update-active" }),
  });
  try {
    const available = await bridge.isAvailable();
    assert.equal(available, false);
    assert.equal(spawns.length, 0, "recusa de lease NUNCA faz spawn");
    assert.match(bridge.health.detail, /actualizadas|lease/i);
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

ok("lifecycle | mode readonly (loadProofEnabled=false) → SEM spawn, SEM fixture", async (t) => {
  const dir = fakeDbDir();
  const spawns = [];
  const bridge = new ClamavBridge({
    datadir: dir,
    spawn: (file, args) => {
      spawns.push({ file, args });
      return mockHandle();
    },
    loadProofEnabled: false,
  });
  try {
    const available = await bridge.isAvailable();
    assert.equal(available, false);
    assert.equal(spawns.length, 0, "modo readonly/fixture NUNCA faz spawn");
    assert.match(bridge.health.detail, /prova de carga desativada/i);
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

ok("lifecycle | prova OK via spawn → active comprovado", async (t) => {
  const dir = fakeDbDir();
  const bridge = new ClamavBridge({
    datadir: dir,
    spawn: () => mockHandle({ value: { code: 0, stdout: SUMMARY_OK, stderr: "" }, resolveImmediately: true }),
  });
  try {
    assert.equal(await bridge.isAvailable(), true);
    assert.equal(bridge.health.status, "active");
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

ok("lifecycle | prova com exit 2 (base truncada) → degradado, nunca active", async (t) => {
  const dir = fakeDbDir();
  const stderr = "LibClamAV Error: cli_cvdparse: Not a CVD file\nERROR: Broken or not a CVD file";
  const bridge = new ClamavBridge({
    datadir: dir,
    spawn: () => mockHandle({ value: { code: 2, stdout: "", stderr }, resolveImmediately: true }),
  });
  try {
    assert.equal(await bridge.isAvailable(), false);
    assert.equal(bridge.health.status, "degraded");
    assert.match(bridge.health.detail, /carga/);
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

ok("lifecycle | single-flight: duas chamadas (mesmo force) → um só spawn", async (t) => {
  const dir = fakeDbDir();
  const spawns = [];
  const h = mockHandle({ autoKill: true, value: { code: 0, stdout: SUMMARY_OK, stderr: "" } });
  const bridge = new ClamavBridge({
    datadir: dir,
    probeTimeoutMs: 10_000,
    spawn: () => {
      spawns.push(1);
      return mockHandle({ value: { code: 0, stdout: SUMMARY_OK, stderr: "" }, resolveImmediately: true });
    },
  });
  try {
    const [r1, r2] = await Promise.all([bridge.isAvailable(true), bridge.isAvailable(true)]);
    assert.equal(r1, true);
    assert.equal(r2, true);
    assert.equal(spawns.length, 1, "duas force concorrentes = UMA prova");
    // Depois de resolvida, cache: nova chamada sem force não faz spawn.
    assert.equal(await bridge.isAvailable(), true);
    assert.equal(spawns.length, 1);
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

ok("lifecycle | timeout → killTree e morte confirmada; lease libertada", async (t) => {
  const dir = fakeDbDir();
  const handle = mockHandle({ autoKill: true, value: { code: null, stdout: "", stderr: "", killed: true } });
  const lease = fakeLease();
  const bridge = new ClamavBridge({
    datadir: dir,
    probeTimeoutMs: 60,
    spawn: () => handle,
    acquireDatabaseLease: () => lease,
  });
  try {
    assert.equal(await bridge.isAvailable(), false);
    assert.equal(handle.killCalls, 1, "o deadline matou o filho");
    assert.equal(bridge.health.status, "degraded");
    assert.match(bridge.health.detail, /timeout|carga/);
    assert.equal(lease.released, true, "morte confirmada → lease libertada");
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

ok("lifecycle | morte NÃO confirmada → prova falha, vaga ENVENENADA (posse) e lease SÓ liberta com prova do SO", async (t) => {
  const dir = fakeDbDir();
  const handle = mockHandle({
    autoKill: true,
    value: { code: null, stdout: "", stderr: "", killed: true, deathUnconfirmed: true },
  });
  const lease = fakeLease();
  const bridge = new ClamavBridge({
    datadir: dir,
    probeTimeoutMs: 60,
    spawn: () => handle,
    acquireDatabaseLease: () => lease,
  });
  try {
    assert.equal(await bridge.isAvailable(), false);
    assert.equal(bridge.health.status, "degraded");
    assert.match(bridge.health.detail, /morte/i);
    assert.equal(lease.released, false, "morte não confirmada → lease presa (honesto)");
    // REV4: a prova adquiriu a vaga ANTES de spawnar, por isso pode (deve)
    // envenená-la quando a morte não é confirmada — o contrário era o HOLD:
    // envenenar uma vaga que nunca se tinha adquirido (bloqueava TUDO).
    assert.equal(clamavSlotStats().poisoned, 1, "a prova envenenou a vaga QUE POSSUI");
    // Quando o SO confirmar a morte, o gancho liberta (e o `close` do spawner
    // faria o mesmo para a vaga — emulado em teste):
    assert.equal(handle.deathHooks.length, 1);
    handle.deathHooks[0]();
    assert.equal(lease.released, true);
    releasePoisonedClamavSlot();
    assert.equal(clamavSlotStats().poisoned, 0, "close tardio devolve a vaga à circulação");
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

ok("lifecycle | dispose durante a prova → killTree + sem prova em voo (shutdown)", async (t) => {
  const dir = fakeDbDir();
  const handle = mockHandle({ autoKill: true, value: { code: null, stdout: "", stderr: "", killed: true } });
  const bridge = new ClamavBridge({
    datadir: dir,
    probeTimeoutMs: 60_000,
    spawn: () => handle,
  });
  const probe = bridge.isAvailable(); // fica em curso com o handle pendente
  // Espera DETERMINÍSTICA pelo registo do handle em `liveHandles` (a sonda de
  // versão real + candidatos correm antes do spawn da prova). Só depois o
  // dispose pode provar que mata o filho.
  let registado = false;
  for (let i = 0; i < 100; i += 1) {
    if (bridge.liveChildPids().length > 0) {
      registado = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(registado, true, "o handle da prova devia estar registado em liveHandles");
  await bridge.dispose(); // mata o handle da prova e espera pelo outcome
  const result = await probe;
  assert.equal(handle.killCalls, 1, "dispose matou o filho da prova");
  assert.equal(result, false);
  assert.equal(bridge.health.status, "degraded");
  await fs.rm(dir, { recursive: true, force: true });
});