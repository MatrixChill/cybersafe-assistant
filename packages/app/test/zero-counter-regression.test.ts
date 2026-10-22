import test from "node:test";
import assert from "node:assert/strict";
import { normalizeScanState, mergeScanState, terminalResultLabels, showNoThreatsReassurance } from "../src/lib/scanSession";

const raw = (extra: Record<string, unknown>) => ({
  id: "synthetic-zero",
  type: "custom",
  status: "running",
  filesScanned: 0,
  filesAnalyzed: 0,
  filesFailed: 0,
  filesInconclusive: 0,
  threatsFound: 0,
  ...extra,
});

test("0 falhas e 0 inconclusivos com 3 analisados: o titulo e Concluida (green)", () => {
  const a = normalizeScanState(raw({}));
  const b = normalizeScanState(raw({ status: "completed", filesScanned: 3, filesAnalyzed: 3 }));
  assert.ok(a && b, "normalizacao");
  const z = mergeScanState(a, b!);
  assert.equal(z.filesFailed, 0, "o zero legitimo sobrevive a fusao");
  assert.equal(z.filesInconclusive, 0, "os inconclusivos zero sobrevivem");
  const labels = terminalResultLabels("completed", z);
  assert.equal(labels.tom, "green");
  assert.match(labels.titulo, /conclu/i);
  assert.ok(showNoThreatsReassurance("completed", z), "a tranquilizacao e concedida");
});

test("contadores desconhecidos: NAO ha tranquilizacao (nunca green por ausencia)", () => {
  const a = normalizeScanState({ id: "s-unknown", type: "custom", status: "completed", filesAnalyzed: 3, threatsFound: 0 });
  assert.ok(a, "normalizacao");
  const z = mergeScanState(null, a!);
  assert.equal(z.filesFailed, undefined, "sem leitura => undefined, nao 0 inventado");
  assert.equal(z.filesInconclusive, undefined);
  assert.equal(showNoThreatsReassurance("completed", z), false);
  const labels = terminalResultLabels("completed", z);
  assert.notEqual(labels.tom, "green");
});

test("falhas positivas: parcial, nunca green", () => {
  const a = normalizeScanState(raw({ status: "completed", filesScanned: 3, filesAnalyzed: 3, filesFailed: 1 }));
  assert.ok(a, "normalizacao");
  const z = mergeScanState(null, a!);
  assert.equal(z.filesFailed, 1);
  assert.equal(showNoThreatsReassurance("completed", z), false);
  assert.notEqual(terminalResultLabels("completed", z).tom, "green");
});

test("evento mais antigo nao baixa a contagem (monotonico)", () => {
  const atual = normalizeScanState(raw({ status: "completed", filesScanned: 3, filesAnalyzed: 3, filesFailed: 2 }));
  const velho = normalizeScanState(raw({ status: "running", filesScanned: 1, filesAnalyzed: 1, filesFailed: 0 }));
  assert.ok(atual && velho, "normalizacao");
  const z = mergeScanState(atual, velho!);
  assert.equal(z.filesFailed, 2, "a contagem nunca desce");
  assert.equal(showNoThreatsReassurance("completed", z), false);
});

test("ambos os eventos desconhecem falhas: a fusao nao inventa zero", () => {
  const a = normalizeScanState(raw({filesFailed: undefined}));
  const b = normalizeScanState(raw({status: "completed", filesScanned:3, filesAnalyzed:3, filesFailed: undefined}));
  assert.ok(a && b);
  const z = mergeScanState(a,b);
  assert.equal(z.filesFailed,undefined);
  assert.equal(showNoThreatsReassurance("completed",z),false);
});

test("zero conhecido sobrevive quando o evento seguinte omite o contador", () => {
  const a = normalizeScanState(raw({}));
  const b = normalizeScanState(raw({status: "completed", filesScanned:3, filesAnalyzed:3, filesFailed: undefined}));
  assert.ok(a && b);
  assert.equal(mergeScanState(a,b).filesFailed,0);
});

