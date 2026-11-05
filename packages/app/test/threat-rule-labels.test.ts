import test from "node:test";
import assert from "node:assert/strict";

import { threatRuleDetail, threatRuleLabel } from "../src/lib/threatRuleLabels";

test("os quatro identificadores reportados pelo utilizador têm descrição PT", () => {
  assert.equal(threatRuleLabel("yara_match"), "Correspondência de regra YARA");
  assert.equal(threatRuleLabel("known_bad_hash"), "Hash conhecido como malicioso");
  assert.equal(threatRuleLabel("archive_with_exe"), "Ficheiro comprimido que contém um executável");
  assert.equal(threatRuleLabel("suspicious_location"), "Localização suspeita");
});

test("o detalhe mantém o identificador técnico para diagnóstico", () => {
  assert.equal(threatRuleDetail("yara_match"), "Correspondência de regra YARA (yara_match)");
});

test("uma regra nova não mostra underscores crus", () => {
  assert.equal(threatRuleLabel("future_rule_name"), "Future rule name");
  assert.equal(threatRuleLabel(""), "Regra desconhecida");
});
