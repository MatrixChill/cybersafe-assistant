import test from "node:test";
import assert from "node:assert/strict";
import { clamavLoadProofFailureDetail, CLAMAV_LOAD_PROBE_TIMEOUT_MS, CLAMAV_LOAD_PROBE_MAX_TIMEOUT_MS } from "../dist/clamav.js";

// v0.2.3 — no notebook a prova falhava com «vaga envenenada» e a app mandava
// «corra freshclam», que não resolve essa causa. A mensagem segue a causa.
const DIR = "C:/defs/clamav";

test("vaga envenenada: diz que um clamscan anterior não terminou e NÃO manda atualizar", () => {
  const t = clamavLoadProofFailureDetail(DIR, { stdout: null, stderr: null, exitCode: null, error: "prova recusada: vaga envenenada" });
  assert.match(t, /clamscan anterior ainda não terminou/);
  assert.doesNotMatch(t, /freshclam/);
});

test("timeout: carga lenta, nova tentativa automática, sem freshclam", () => {
  const t = clamavLoadProofFailureDetail(DIR, { stdout: null, stderr: null, exitCode: null, error: "timeout (carga > 30000 ms)" });
  assert.match(t, /demorou mais do que o prazo/);
  assert.match(t, /nova tentativa automática/);
  assert.doesNotMatch(t, /freshclam/);
});

test("morte não confirmada: indisponível até à confirmação", () => {
  const t = clamavLoadProofFailureDetail(DIR, { stdout: null, stderr: null, exitCode: null, error: "morte não confirmada pelo SO (prova de carga)" });
  assert.match(t, /não foi confirmado pelo Windows/);
});

test("evidência incoerente: só aqui se sugere atualizar as definições", () => {
  const t = clamavLoadProofFailureDetail(DIR, { stdout: "x", stderr: "LibClamAV Error: cl_load(): Can't load", exitCode: 2 });
  assert.match(t, /freshclam/);
  assert.match(t, /não se publica active sem carga comprovada/);
});

test("prazo adaptativo tem teto explícito", () => {
  assert.equal(CLAMAV_LOAD_PROBE_TIMEOUT_MS, 30_000);
  assert.equal(CLAMAV_LOAD_PROBE_MAX_TIMEOUT_MS, 120_000);
});
