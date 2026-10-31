import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CLAMAV_LOAD_PROBE_FIXTURE,
  applyClamavLoadProof,
  clamavLoadConfirmed,
  parseClamavKnownViruses,
  parseClamavScanSummary,
  probeClamavLoad,
} from "../dist/clamav.js";

/**
 * PROVA POSITIVA DE CARGA (TP-PAP-ENGINES-RECOVERY-AND-PACKAGING-20261027, rev 2).
 *
 * Um .cvd truncado que EXISTE com mtime recente não é base; o `active` da
 * sonda deixa de poder vir de existência+mtime. A única fonte de `active` é
 * uma operação benigna e controlada em que o clamscan CONFIRMA ter carregado
 * a base (`Known viruses: N`, N>0, fixture efectivamente analisada, zero
 * infecções, exit 0, sem erros de carga no stderr). A confirmação é
 * ESTRUTURAL: contagens válidas com exit 2, timeout, stderr danificado,
 * resumo partido ou relato contraditório NUNCA confirmam.
 */

function resumo(parts = {}) {
  const p = {
    knownViruses: 1,
    scannedFiles: 1,
    infectedFiles: 0,
    header: true,
    stderr: "",
    exitCode: 0,
    error: undefined,
    ...parts,
  };
  const h = p.header ? "----------- SCAN SUMMARY -----------\n" : "Known viruses fora do resumo??\n";
  const body =
    p.header || p.includeBody
      ? `Known viruses: ${p.knownViruses}\nEngine version: 1.5.4\nScanned directories: 0\nScanned files: ${p.scannedFiles}\nInfected files: ${p.infectedFiles}\n`
      : "";
  return {
    stdout: h + (p.header ? body : ""),
    stderr: p.stderr,
    exitCode: p.exitCode,
    ...(p.error !== undefined ? { error: p.error } : {}),
  };
}

test("rev2 | parseClamavKnownViruses extrai a linha `Known viruses`", () => {
  assert.equal(parseClamavKnownViruses(""), null);
  assert.equal(parseClamavKnownViruses("Known viruses: 1"), 1);
  assert.equal(parseClamavKnownViruses("Known viruses: 3628193\nScanned files: 1"), 3628193);
  assert.equal(parseClamavKnownViruses("nothing here"), null);
  assert.equal(parseClamavKnownViruses("ClamAV 1.5.4/28157/..."), null); // --version NÃO dá carga
});

test("rev2 | parseClamavScanSummary exige as três linhas do resumo", () => {
  const completo = resumo({ knownViruses: 3628193 });
  const s1 = parseClamavScanSummary(completo.stdout);
  assert.deepEqual(s1, { knownViruses: 3628193, scannedFiles: 1, infectedFiles: 0 });
  assert.equal(parseClamavScanSummary(""), null);
  assert.equal(parseClamavScanSummary("Known viruses: 42\nScanned files: 1"), null); // sem Infected
  assert.equal(parseClamavScanSummary("Known viruses: 42"), null);
  assert.equal(parseClamavScanSummary("--version"), null);
});

test("rev2 | clamavLoadConfirmed STRUTURAL: só evidência coerente confirma", () => {
  // Corrida normal real → confirma.
  assert.equal(clamavLoadConfirmed(resumo()), true);
  assert.equal(clamavLoadConfirmed(resumo({ knownViruses: 3628193, scannedFiles: 1 })), true);

  // ── O caso da revisão Codex (HOLD) ── contagens válidas + exit 2 + stderr
  // danificado + error timeout = NUNCA confirma (4 violações independentes).
  const casoCodex = {
    stdout: "Known viruses: 42\nScanned files: 1\n",
    stderr: "ERROR: damaged db",
    exitCode: 2,
    error: "timeout",
  };
  assert.equal(clamavLoadConfirmed(casoCodex), false);

  // Saída parcial sem cabeçalho nem resumo → falha.
  assert.equal(clamavLoadConfirmed({ stdout: "Known viruses: 42\nScanned files: 1\n", stderr: "", exitCode: 0 }), false);
  // Exit ≠ 0 com resumo válido → falha.
  assert.equal(clamavLoadConfirmed(resumo({ exitCode: 2 })), false);
  // `error` (timeout/spawn) presente com resumo válido → falha.
  assert.equal(clamavLoadConfirmed(resumo({ error: "timeout" })), false);
  // stderr de carga falhada com resumo válido → falha.
  assert.equal(clamavLoadConfirmed(resumo({ stderr: "LibClamAV Error: cli_cvdparse: Not a CVD file" })), false);
  assert.equal(clamavLoadConfirmed(resumo({ stderr: "ERROR: Broken or not a CVD file" })), false);
  // Zero assinaturas carregadas → não é carga.
  assert.equal(clamavLoadConfirmed(resumo({ knownViruses: 0 })), false);
  // Fixture NÃO analisada → não é prova.
  assert.equal(clamavLoadConfirmed(resumo({ scannedFiles: 0 })), false);
  // Infecções ≠ 0 (relato contraditório para uma fixture benigna) → falha.
  assert.equal(clamavLoadConfirmed(resumo({ infectedFiles: 1 })), false);
  // `--version` só → nunca.
  assert.equal(clamavLoadConfirmed({ stdout: "ClamAV 1.5.4\n", stderr: "", exitCode: 0 }), false);
  // Sem stdout → nunca.
  assert.equal(clamavLoadConfirmed({ stdout: null, stderr: null, exitCode: null }), false);
  // Avisos WARNING não anulam (aviso benigno ≠ erro de carga).
  assert.equal(
    clamavLoadConfirmed(resumo({ stderr: "WARNING: /tmp/foo.txt: Can't access file\n" })),
    true,
  );
});

test("rev2 | applyClamavLoadProof mantém active só com prova coerente", () => {
  const active = { available: true, health: { status: "active", detail: "x" } };
  const chosen = { dir: "D://db", source: "explicit", state: "ready", signatureFiles: ["main.cvd"], newestMtimeMs: 1 };

  // Prova coerente → active mantém-se.
  assert.deepEqual(applyClamavLoadProof(active, chosen, resumo()), active);

  // O CASO DA REVISÃO CODEX: contagens válidas + exit 2 + stderr + timeout
  // → degraded, NUNCA active.
  const casoCodex = {
    stdout: "Known viruses: 42\nScanned files: 1\n",
    stderr: "ERROR: damaged db",
    exitCode: 2,
    error: "timeout",
  };
  const r0 = applyClamavLoadProof(active, chosen, casoCodex);
  assert.equal(r0.available, false);
  assert.equal(r0.health.status, "degraded");
  assert.match(r0.health.detail, /carga/);

  // .cvd TRUNCADO real: stderr de parse + exit 2 → nunca active.
  const truncado = {
    stdout: "",
    stderr: "LibClamAV Error: cli_cvdparse: Not a CVD file\nERROR: Broken or not a CVD file",
    exitCode: 2,
  };
  const r1 = applyClamavLoadProof(active, chosen, truncado);
  assert.equal(r1.available, false);
  assert.equal(r1.health.status, "degraded");

  // Falha de spawn/timeout → nunca active.
  const spawnFalhou = { stdout: null, stderr: null, exitCode: null, error: "spawn ENOENT" };
  const r2 = applyClamavLoadProof(active, chosen, spawnFalhou);
  assert.equal(r2.available, false);
  assert.equal(r2.health.status, "degraded");

  // Estados já degradados/ausentes não são tocados.
  for (const estado of [
    { available: false, health: { status: "unavailable", detail: "binário" } },
    { available: false, health: { status: "degraded", detail: "sem base" } },
    { available: false, health: { status: "degraded", detail: "expirada" } },
  ]) {
    assert.deepEqual(applyClamavLoadProof(estado, chosen, resumo()), estado);
  }
  assert.deepEqual(applyClamavLoadProof(active, null, resumo()), active);
});

test("rev2 | probeClamavLoad (runner puro): fixture benigna, args, limpeza", async () => {
  const calls = [];
  const vistoDuranteARun = { text: null };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-load-proof-"));
  const proof = await probeClamavLoad("clamscan.exe", dir, async (file, args) => {
    calls.push({ file, args });
    vistoDuranteARun.text = await fs.readFile(args[2], "utf8");
    return {
      stdout:
        "----------- SCAN SUMMARY -----------\nKnown viruses: 1\nScanned files: 1\nInfected files: 0\n",
      stderr: "",
      code: 0,
    };
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "clamscan.exe");
  assert.deepEqual(calls[0].args.slice(0, 2), ["--database", dir]);
  const fixture = calls[0].args[2];
  assert.ok(fixture.endsWith(".txt"));
  assert.equal(vistoDuranteARun.text, CLAMAV_LOAD_PROBE_FIXTURE);
  assert.equal(clamavLoadConfirmed(proof), true);
  await assert.rejects(fs.access(fixture)); // removida no finally
  await fs.rm(dir, { recursive: true, force: true });
});

test("rev2 | probeClamavLoad falha fechada: spawn que rejeita devolve error, nunca lança", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-load-proof-fail-"));
  const proof = await probeClamavLoad("clamscan.exe", dir, async () => {
    throw new Error("spawn ENOENT: clamscan.exe");
  });
  assert.match(proof.error ?? "", /ENOENT/);
  assert.equal(proof.stdout, null);
  assert.equal(clamavLoadConfirmed(proof), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test("rev2 | invariante do caso real: .cvd truncado nunca tem linha `Known viruses`", () => {
  const saidaReal = [
    "LibClamAV Error: cli_cvdparse: Not a CVD file",
    "LibClamAV Error: cli_loaddbdir: error parsing header of .../main.cvd",
    "LibClamAV Error: Can't load .../main.cvd: Broken or not a CVD file",
    "ERROR: Broken or not a CVD file",
  ].join("\n");
  assert.equal(parseClamavKnownViruses(saidaReal), null);
  assert.equal(parseClamavScanSummary(saidaReal), null);
  assert.equal(clamavLoadConfirmed({ stdout: "", stderr: saidaReal, exitCode: 2 }), false);
});