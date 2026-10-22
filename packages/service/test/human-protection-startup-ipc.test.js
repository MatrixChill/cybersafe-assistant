import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOptInPayload } from "../src/protection-intent.ts";

/**
 * O payload chega do renderer via named pipe. Nada aqui instancia o motor:
 * e a validacao estrita, isolada, que decide se ha escrita de preferencia.
 */
test("apenas {enabled:true} e {enabled:false} sao aceites", () => {
  assert.deepEqual(parseOptInPayload({ enabled: true }), { ok: true, enabled: true });
  assert.deepEqual(parseOptInPayload({ enabled: false }), { ok: true, enabled: false });
});

test("ausencia de payload e recusada, nunca tratada como opt-in", () => {
  for (const payload of [undefined, null, {}, "true", 1, true]) {
    const resultado = parseOptInPayload(payload);
    assert.equal(resultado.ok, false, `${JSON.stringify(payload)} nao pode ativar o opt-in`);
  }
});

test("campos extra ou de outro tipo sao recusados", () => {
  assert.equal(parseOptInPayload({ enabled: "true" }).ok, false);
  assert.equal(parseOptInPayload({ enabled: 1 }).ok, false);
  assert.equal(parseOptInPayload({ enabled: null }).ok, false);
  assert.equal(parseOptInPayload({ enabled: true, desired: "enabled" }).ok, false,
    "um payload com mais nada nao pode reescrever o registo");
  assert.equal(parseOptInPayload({ on: true }).ok, false);
});

test("recusa diz por que recusou, com motivo estavel", () => {
  assert.equal(parseOptInPayload({ enabled: "sim" }).motivo, "enabled_nao_booleano");
  assert.equal(parseOptInPayload(undefined).motivo, "payload_ausente");
  assert.equal(parseOptInPayload({ enabled: true, extra: 1 }).motivo, "chaves_inesperadas");
});
