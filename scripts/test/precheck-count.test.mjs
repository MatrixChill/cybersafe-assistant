/**
 * A linha textual do `--check` tem de contar TODOS os gates que bloqueiam.
 * Antes, a seed e o YARA ficavam fora da soma: uma candidata sem seed podia
 * imprimir "0 problema(s)" com `ok:false`. Estes casos fixam a contagem.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contarProblemasPreCheck } from "../package-windows.mjs";

const verde = () => ({
  checks: [{ exists: true }, { exists: true }],
  bundle: { ok: true, problems: [] },
  yara: { ok: true, problems: [] },
  freeze: { ok: true, problems: [] },
  seed: { ok: true, dir: "seed", problems: [] },
  licensing: { estado: "prova-fecha" },
});

test("tudo verde conta zero", () => {
  assert.equal(contarProblemasPreCheck(verde()), 0);
});

test("candidata sem seed conta um bloqueio, nunca zero", () => {
  const r = verde();
  r.seed = { ok: false, dir: null, problems: ["CLAMAV_SEED_REQUIRED"] };
  assert.equal(contarProblemasPreCheck(r), 1);
});

test("gate que falha sem lista de problemas conta na mesma um", () => {
  const r = verde();
  r.freeze = { ok: false, problems: [] };
  assert.equal(contarProblemasPreCheck(r), 1);
});

test("problemas da seed e do YARA somam individualmente", () => {
  const r = verde();
  r.seed = { ok: false, dir: "seed", problems: ["a", "b", "c"] };
  r.yara = { ok: false, problems: ["d"] };
  assert.equal(contarProblemasPreCheck(r), 4);
});

test("inputs em falta contam cada um e nao escondem outros gates", () => {
  const r = verde();
  r.checks = [{ exists: false }, { exists: false }];
  r.freeze = { ok: false, problems: [{ kind: "manifest-missing" }] };
  assert.equal(contarProblemasPreCheck(r), 3);
});
