import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClamavBridge, applyClamavLoadProof, clamavSlotStats } from "../dist/clamav.js";

/**
 * P0 — OSCILACAO DO CLAMAV POR CONTENCAO DA FILA.
 *
 * A prova de carga usa a vaga global em prioridade `background`. Quando um scan
 * longo ocupa a unica vaga, a espera terminava em 30 s e o resultado era
 * aplicado como FALHA DE CARGA: ACTIVE -> DEGRADED -> ACTIVE a cada probe
 * forcado (freshclam), sem nenhuma evidencia contra a base.
 *
 * Contrato fixado aqui:
 *  - `deferred` por ocupacao NAO e falha; preserva o `active` ja comprovado e
 *    marca `busy`, para a UI distinguir ocupacao de degradacao;
 *  - sem confirmacao anterior, `deferred` nunca publica `active`;
 *  - terminado o scan, a prova adiada e revalidada sem esperar o freshclam.
 */

const SUMMARY = [
  "----------- SCAN SUMMARY -----------",
  "Known viruses: 3628193",
  "Engine version: 1.5.4",
  "Scanned files: 1",
  "Infected files: 0",
  "Total errors: 0",
].join("\n");

const chosen = { dir: "D:/db", source: "explicit", state: "ready", signatureFiles: ["main.cvd"], newestMtimeMs: 1 };
const deferred = { stdout: null, stderr: null, exitCode: null, deferred: true, error: "sem vaga dentro de 50 ms" };

function cleanOutcome(targets) {
  const files = targets.length;
  return {
    code: 0,
    stdout: targets.map((t) => `${t}: OK`).join("\n") + "\n" + SUMMARY.replace("Scanned files: 1", `Scanned files: ${files}`),
    stderr: "",
  };
}

test("deferred preserva active comprovado e marca busy (nao degrada)", () => {
  const previous = { status: "active", detail: "prova anterior", coverage: "normal" };
  const before = { available: true, health: previous };
  const r = applyClamavLoadProof(before, chosen, deferred, previous);
  assert.equal(r.available, true);
  assert.equal(r.health.status, "active");
  assert.equal(r.health.busy, true);
  assert.equal(r.health.coverage, "normal");
  assert.match(r.health.detail, /ocupado|adiada/i);
  assert.match(r.health.detail, /ultima carga comprovada|última carga comprovada/i);
});

test("deferred sem confirmacao anterior nunca publica active", () => {
  const previous = { status: "unavailable", detail: "sem prova" };
  const before = { available: true, health: { status: "active", detail: "classificacao inicial" } };
  const r = applyClamavLoadProof(before, chosen, deferred, previous);
  assert.equal(r.available, false);
  assert.equal(r.health.status, "unavailable");
  assert.equal(r.health.busy, true);
  assert.match(r.health.detail, /ainda sem carga comprovada/i);
});

async function waitFor(fn, label, budgetMs = 3000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout: ${label}`);
}

test("prova adiada durante scan nao oscila e revalida no fim", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-busy-probe-"));
  const defs = path.join(tmp, "definitions", "clamav");
  await fs.mkdir(defs, { recursive: true });
  await fs.writeFile(path.join(defs, "main.cvd"), "x");
  await fs.writeFile(path.join(defs, "daily.cld"), "x");
  const target = path.join(tmp, "alvo.txt");
  await fs.writeFile(target, "benigno\n");

  let batchRelease = null;
  let probes = 0;
  const spawn = (_file, args) => {
    const isProbe = (args ?? []).some((a) => String(a).includes("cybersafe-clamav-load-probe-"));
    let resolveOutcome;
    const outcome = new Promise((r) => { resolveOutcome = r; });
    if (isProbe) {
      probes += 1;
      queueMicrotask(() => resolveOutcome({ code: 0, stdout: cleanOutcome(["fixture"]).stdout, stderr: "" }));
    } else {
      batchRelease = () => resolveOutcome(cleanOutcome((args ?? []).filter((a) => !String(a).startsWith("-"))));
    }
    return { pid: 7000 + probes + Math.floor(Math.random() * 1000), killTree: () => {}, outcome };
  };

  const bridge = new ClamavBridge({
    definitionsDir: path.join(tmp, "definitions"),
    spawn,
    probeTimeoutMs: 5_000,
    probeSlotWaitMs: 50,
    scanTimeoutMs: 5_000,
  });
  try {
    assert.equal(await bridge.isAvailable(), true, "probe inicial prova carga");
    assert.equal(bridge.health.status, "active");

    const scan = bridge.scanFiles([target]);
    await waitFor(() => clamavSlotStats().active === 1, "scan ocupa a vaga");

    assert.equal(await bridge.isAvailable(true), true, "ocupacao preserva disponibilidade");
    assert.equal(bridge.health.status, "active", "ocupacao nao degrada o motor");
    assert.equal(bridge.health.busy, true, "ocupacao e visivel como busy");
    assert.match(bridge.health.detail, /adiada/i);

    assert.ok(batchRelease, "batch devia estar em curso");
    batchRelease();
    const result = await scan;
    assert.equal(result.status.status, "active");
    assert.equal(bridge.health.status, "active");
    assert.notEqual(bridge.health.busy, true, "batch positivo limpa o busy");
  } finally {
    await bridge.dispose();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
