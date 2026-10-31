import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ClamavBridge } from "../dist/clamav.js";

/**
 * INTEGRAÇÃO COM O BINÁRIO REAL (rev 2 — BEHAVIOURAL RED/GREEN).
 *
 * Requer `CYBERSAFE_CLAMSCAN_PATH` (clamscan real, ex.: vendor 1.5.4). Sem o
 * env os testes são `skip`. Usa só bases benignas/truncadas em tmpdir e a base
 * REAL AUTORIZADA (somente leitura) via `CYBERSAFE_CLAMAV_REAL_BASE`.
 *
 * Comportamento reproduzido (REV 2):
 *  - PRE (sem prova de carga): um `.cvd` TRUNCADO com mtime fresco classificava
 *    `active` por existência+mtime → `isAvailable() === true` (o falso
 *    positivo). 
 *  - POST: a prova de carga corre o clamscan real sobre a base truncada,
 *    falha honestamente → `isAvailable() === false`, `degraded`.
 */

const ok = process.env.CYBERSAFE_CLAMSCAN_PATH ? test : test.skip;

function fakeDataDir(databaseName = "main.cvd", content = "not a cvd: bytes falsos") {
  const dir = path.join(os.tmpdir(), `cs-probe-trunc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  // .cvd truncado/pretendido com mtime FRESCO — a classificação por
  // existência+mtime dizia `ready`+fresh.
  writeFileSync(path.join(dir, databaseName), content);
  return dir;
}

ok("real | .cvd TRUNCADO com mtime fresco → NUNCA active (prova de carga falha)", async (t) => {
  const dir = fakeDataDir("main.cvd");
  const bridge = new ClamavBridge({ datadir: dir, probeTimeoutMs: 30_000 });
  try {
    const started = Date.now();
    const available = await bridge.isAvailable();
    const wallMs = Date.now() - started;
    assert.equal(available, false, "base truncada NUNCA publica active");
    assert.equal(bridge.health.status, "degraded");
    assert.match(bridge.health.detail, /carga/);
    console.log(`[real-truncated] exit degraded, wallMs=${wallMs}`);
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

ok("real | base REAL autorizada → active com prova (custo medido)", async (t) => {
  const realBase = process.env.CYBERSAFE_CLAMAV_REAL_BASE;
  if (!realBase) {
    t.skip("CYBERSAFE_CLAMAV_REAL_BASE ausente — medição de custo só com base autorizada");
    return;
  }
  const bridge = new ClamavBridge({ datadir: realBase, probeTimeoutMs: 30_000 });
  try {
    const started = Date.now();
    const available = await bridge.isAvailable();
    const wallMs = Date.now() - started;
    assert.equal(available, true, "base real carregada → active comprovado");
    assert.equal(bridge.health.status, "active");
    console.log(`[real-base] active, totalWallMs=${wallMs} (prova de carga real incluída)`);
  } finally {
    await bridge.dispose();
  }
});