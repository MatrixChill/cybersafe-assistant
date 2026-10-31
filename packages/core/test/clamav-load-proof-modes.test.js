import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync, readdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ClamavBridge, clamavLoadProofDefaultEnabled } from "../dist/clamav.js";

/**
 * MODOS E BOOTSTRAP DA PROVA DE CARGA (rev 3 — HOLD Codex, fronteira serviço).
 *
 * A bridge real (engine.ts) é construída SÓ com `acquireDatabaseLease`, sem
 * `loadProofEnabled`. Num run de desenvolvimento isolado em modo de leitura
 * (`CYBERSAFE_DEV_WINDOWS_READONLY=1`) ou de sessão de fixture
 * (`CYBERSAFE_REALDEV_FIXTURE_SCAN=1`), a prova de carga NÃO pode fazer spawn
 * nem escrever fixture: é uma superfície que esses modos fecham. O default
 * FAIL-CLOSED deriva do ambiente (`clamavLoadProofDefaultEnabled`); a opção
 * explícita continua a mandar (seam de teste).
 *
 * Também cobre: dispose com órgamento quando o filho nunca emite `close`
 * (`disposeBudgetMs`) e `force` durante uma actualização (lease recusada →
 * nenhum spawn).
 *
 * Requer `CYBERSAFE_CLAMSCAN_PATH` porque a sonda de VERSÃO executa o binário
 * real — mesmo padrão dos restantes testes de ciclo de vida. Sem o env, os
 * testes são `skip`, nunca falhos.
 */

const CLAMSCAN = process.env.CYBERSAFE_CLAMSCAN_PATH;
const ok = CLAMSCAN ? test : test.skip;

const SUMMARY_OK =
  "----------- SCAN SUMMARY -----------\nKnown viruses: 3628193\nEngine version: 1.5.4\nScanned files: 1\nInfected files: 0\n";

const READONLY_ENV = "CYBERSAFE_DEV_WINDOWS_READONLY";
const FIXTURE_ENV = "CYBERSAFE_REALDEV_FIXTURE_SCAN";
const FIXTURE_GLOB = "cybersafe-clamav-load-probe-";

function mockHandle({ value, resolveImmediately = false } = {}) {
  let resolveOutcome;
  const outcome = new Promise((res) => {
    resolveOutcome = res;
  });
  const handle = {
    pid: 7200 + Math.floor(Math.random() * 1000),
    killCalls: 0,
    deathHooks: [],
    killTree() {
      this.killCalls += 1;
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

/** Define vars de ambiente SÓ durante `fn`; repõe tudo no finally. */
async function withEnv(vars, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function fakeDbDir(files = ["main.cvd"]) {
  const dir = path.join(os.tmpdir(), `cs-probe-db-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(path.join(dir, f), f === "main.cvd" ? "fake bytes" : "x");
  return dir;
}

/**
 * Stub do `os.tmpdir` do processo para um diretório privado só deste teste
 * (`t.mock` repõe no fim). Hermético: outros ficheiros de teste correm em
 * paralelo e escrevem fixtures no tmpdir REAL — contar no global era
 * corredor. Com o stub, o assert prova que ESTE bridge nunca escreveu.
 */
function tmpdirStub(t) {
  const stubDir = mkdtempSync(path.join(os.tmpdir(), `cs-modes-stub-`));
  t.mock.method(os, "tmpdir", () => stubDir);
  return stubDir;
}

function fixturesNoStub(stubDir) {
  return readdirSync(stubDir).filter((n) => n.startsWith(FIXTURE_GLOB)).length;
}

ok("modes | default deriva do ambiente (unit): readonly e fixture -1, normal 1", async () => {
  await withEnv({ [READONLY_ENV]: "1", [FIXTURE_ENV]: undefined }, () => {
    assert.equal(clamavLoadProofDefaultEnabled(), false, "readonly fecha a prova");
  });
  await withEnv({ [READONLY_ENV]: undefined, [FIXTURE_ENV]: "1" }, () => {
    assert.equal(clamavLoadProofDefaultEnabled(), false, "fixture fecha a prova");
  });
  await withEnv({ [READONLY_ENV]: "1", [FIXTURE_ENV]: "1" }, () => {
    assert.equal(clamavLoadProofDefaultEnabled(), false, "ambos fecham a prova");
  });
  await withEnv({ [READONLY_ENV]: "0", [FIXTURE_ENV]: "0" }, () => {
    assert.equal(clamavLoadProofDefaultEnabled(), true, "\"0\" não liga o modo");
  });
  await withEnv({ [READONLY_ENV]: undefined, [FIXTURE_ENV]: undefined }, () => {
    assert.equal(clamavLoadProofDefaultEnabled(), true, "sem flags: prova normal");
  });
});

ok("bootstrap | engine.ts SEM opção + ENV readonly=1 → SEM spawn, SEM fixture, degradado honesto", async (t) => {
  const dir = fakeDbDir();
  const stubDir = tmpdirStub(t);
  const spawns = [];
  await withEnv({ [READONLY_ENV]: "1" }, async () => {
    const bridge = new ClamavBridge({
      datadir: dir,
      spawn: (file, args) => {
        spawns.push({ file, args });
        return mockHandle({ value: { code: 0, stdout: SUMMARY_OK, stderr: "" }, resolveImmediately: true });
      },
    });
    try {
      assert.equal(await bridge.isAvailable(), false, "readonly nunca activa por prova");
      assert.equal(spawns.length, 0, "readonly NUNCA faz spawn da prova");
      assert.equal(bridge.health.status, "degraded");
      assert.match(bridge.health.detail, /prova de carga desativada/i);
    } finally {
      await bridge.dispose();
    }
  });
  assert.equal(fixturesNoStub(stubDir), 0, "readonly NUNCA escreve fixture");
  await fs.rm(dir, { recursive: true, force: true });
});
ok("bootstrap | engine.ts SEM opção + ENV fixture=1 → SEM spawn, SEM fixture, degradado honesto", async (t) => {
  const dir = fakeDbDir();
  const stubDir = tmpdirStub(t);
  const spawns = [];
  await withEnv({ [FIXTURE_ENV]: "1" }, async () => {
    const bridge = new ClamavBridge({
      datadir: dir,
      spawn: (file, args) => {
        spawns.push({ file, args });
        return mockHandle({ value: { code: 0, stdout: SUMMARY_OK, stderr: "" }, resolveImmediately: true });
      },
    });
    try {
      assert.equal(await bridge.isAvailable(), false, "fixture nunca activa por prova");
      assert.equal(spawns.length, 0, "fixture NUNCA faz spawn da prova");
      assert.equal(bridge.health.status, "degraded");
      assert.match(bridge.health.detail, /prova de carga desativada/i);
    } finally {
      await bridge.dispose();
    }
  });
  assert.equal(fixturesNoStub(stubDir), 0, "fixture NUNCA escreve fixture");
  await fs.rm(dir, { recursive: true, force: true });
});

ok("bootstrap | opção explícita manda sobre o ambiente (seam de teste)", async () => {
  const dir = fakeDbDir();
  const spawns = [];
  await withEnv({ [READONLY_ENV]: "1" }, async () => {
    const bridge = new ClamavBridge({
      datadir: dir,
      loadProofEnabled: true,
      spawn: (file, args) => {
        spawns.push({ file, args });
        return mockHandle({ value: { code: 0, stdout: SUMMARY_OK, stderr: "" }, resolveImmediately: true });
      },
    });
    try {
      assert.equal(await bridge.isAvailable(), true, "opção explícita sobrepõe-se à ENV");
      assert.equal(spawns.length, 1, "opção explícita true → prova corre");
      assert.equal(bridge.health.status, "active");
    } finally {
      await bridge.dispose();
    }
  });
  await fs.rm(dir, { recursive: true, force: true });
});

ok("bootstrap | sem flags + base válida → prova corre e active (caminho normal)", async () => {
  const dir = fakeDbDir();
  const spawns = [];
  await withEnv({ [READONLY_ENV]: undefined, [FIXTURE_ENV]: undefined }, async () => {
    const bridge = new ClamavBridge({
      datadir: dir,
      loadProofEnabled: true,
      spawn: (file, args) => {
        spawns.push({ file, args });
        return mockHandle({ value: { code: 0, stdout: SUMMARY_OK, stderr: "" }, resolveImmediately: true });
      },
    });
    try {
      assert.equal(await bridge.isAvailable(), true, "prova positiva → active");
      assert.equal(bridge.health.status, "active");
      assert.equal(spawns.length, 1);
    } finally {
      await bridge.dispose();
    }
  });
  await fs.rm(dir, { recursive: true, force: true });
});

ok("force durante UPDATE | lease recusada (update activa) → SEM spawn mesmo com force", async () => {
  const dir = fakeDbDir();
  const spawns = [];
  const bridge = new ClamavBridge({
    datadir: dir,
    loadProofEnabled: true,
    spawn: (file, args) => {
      spawns.push({ file, args });
      return mockHandle({ value: { code: 0, stdout: SUMMARY_OK, stderr: "" }, resolveImmediately: true });
    },
    acquireDatabaseLease: () => ({ refused: true, reason: "update-active" }),
  });
  try {
    assert.equal(await bridge.isAvailable(true), false, "force não contorna a lease");
    assert.equal(spawns.length, 0, "update activa NUNCA faz spawn da prova");
    assert.equal(bridge.health.status, "degraded");
    assert.match(bridge.health.detail, /lease|actualizadas/i);
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

ok("dispose | filho que nunca emite close → órgamento resolve o shutdown (não pendura)", async () => {
  const dir = fakeDbDir();
  const handle = mockHandle(); // outcome nunca resolve sozinho
  const bridge = new ClamavBridge({
    datadir: dir,
    loadProofEnabled: true,
    probeTimeoutMs: 60_000,
    disposeBudgetMs: 250,
    spawn: () => handle,
  });
  const probe = bridge.isAvailable();
  // Espera o registo do handle (a sonda de versão/candidatos correm antes).
  let registado = false;
  for (let i = 0; i < 100; i += 1) {
    if (bridge.liveChildPids().length > 0) {
      registado = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(registado, true, "o handle da prova devia estar registado");
  const inicio = Date.now();
  await bridge.dispose(); // órgamento: resolve mesmo com outcome nunca emitido
  const decorrido = Date.now() - inicio;
  assert.ok(decorrido < 5_000, `dispose pendurado no handle sem close (${decorrido} ms)`);
  assert.equal(bridge.liveChildPids().length, 0, "dispose limpa o registo");
  // Fecha o filho agora: a prova em curso termina com shutdown honesto.
  handle._resolve({ code: null, stdout: "", stderr: "", killed: true });
  assert.equal(await probe, false);
  assert.equal(bridge.health.status, "degraded");
  await fs.rm(dir, { recursive: true, force: true });
});
