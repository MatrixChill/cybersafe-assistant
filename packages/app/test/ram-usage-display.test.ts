/**
 * TP-3H-RAM-INTEGRATION-CANDIDATE — política de apresentação da RAM.
 *
 * Contrato v2: `ram.usagePercent`/`usedGb`/`totalGb` são anuláveis e vêm com
 * `usageStatus`/`usageUpdatedAt`/`usageLastGoodPercent`. Este teste fixa a
 * política do helper único (`ramUsageDisplay`) usado pela UI, pela telemetria
 * e pelo assistente — sem GameN0 inventado e sem confundir ausente com falha.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ramUsageDisplay } from "../src/lib/ramUsageDisplay";
import type { HardwareSnapshot } from "@cybersafe/shared-types";

const base: HardwareSnapshot["ram"] = {
  usagePercent: 42,
  usedGb: 12,
  totalGb: 30,
  usageStatus: "available",
  usageUpdatedAt: "2026-10-20T10:00:00.000Z",
};

test("available: o valor atual é apresentado (0 % é uma medição válida)", () => {
  const d = ramUsageDisplay({ ...base, usagePercent: 0 });
  assert.equal(d.state, "available");
  assert.equal(d.value, 0);
  assert.equal(d.text, "0%");
});

test("stale: retém a última leitura boa como CACHED e não expõe valor atual", () => {
  const d = ramUsageDisplay({
    ...base,
    usagePercent: null,
    usedGb: null,
    usageStatus: "stale",
    usageLastGoodPercent: 42,
  });
  assert.equal(d.state, "stale");
  assert.equal(d.value, null, "stale não é carga atual");
  assert.equal(d.cachedValue, 42);
  assert.match(d.text, /última leitura/);
});

test("unavailable: sem leitura, sem número", () => {
  const d = ramUsageDisplay({ ...base, usagePercent: null, usedGb: null, usageStatus: "unavailable" });
  assert.equal(d.state, "unavailable");
  assert.equal(d.value, null);
  assert.equal(d.text, "Sem leitura");
});

test("sem usageStatus (legado): estado NÃO CONFIRMADO, o número não é medição", () => {
  const legacy: HardwareSnapshot["ram"] = { usagePercent: 42, usedGb: 12, totalGb: 30 };
  const d = ramUsageDisplay(legacy);
  assert.equal(d.state, "unconfirmed");
  assert.equal(d.value, null);
  assert.equal(d.text, "Não confirmado");
});

test("totalGb null: capacidade desconhecida, nunca 0 GB", () => {
  const d = ramUsageDisplay({ ...base, totalGb: null });
  assert.equal(d.totalGb, null);
  assert.match(d.totalText, /desconhecido/);
  assert.doesNotMatch(d.totalText, /0\.0/);
});

test("usedGb null: usados desconhecidos", () => {
  const d = ramUsageDisplay({ ...base, usedGb: null });
  assert.equal(d.usedGb, null);
  assert.match(d.usedText, /desconhecidos/);
});

test("a última capacidade conhecida é retida quando a leitura falha", () => {
  const d = ramUsageDisplay({ ...base, usagePercent: null, usedGb: null, usageStatus: "stale" });
  assert.equal(d.totalGb, 30, "a capacidade é da máquina, não da leitura");
  assert.match(d.totalText, /30,0 GB/);
});

test("usedGb contraditório (legado/stale/unavailable): nunca vira 'em uso' nem 'disponível'", () => {
  const legacy = ramUsageDisplay({ usagePercent: 42, usedGb: 12, totalGb: 30 });
  assert.equal(legacy.state, "unconfirmed");
  assert.equal(legacy.usedGb, null, "sem leitura atual não há 'em uso'");
  assert.match(legacy.usedText, /desconhecidos/);
  assert.equal(legacy.freeText, "—", "sem leitura não há 'disponível'");

  const stale = ramUsageDisplay({ usagePercent: null, usedGb: 12, totalGb: 30, usageStatus: "stale", usageLastGoodPercent: 42 });
  assert.equal(stale.usedGb, null);
  assert.match(stale.usedText, /desconhecidos/);
  assert.equal(stale.freeText, "—");

  const unavailable = ramUsageDisplay({ usagePercent: null, usedGb: 12, totalGb: 30, usageStatus: "unavailable" });
  assert.equal(unavailable.usedGb, null);
  assert.equal(unavailable.freeText, "—");
});

test("a capacidade continua independente: 'disponível' só com leitura atual e nunca negativo", () => {
  const ok = ramUsageDisplay({ ...base, usagePercent: 40, usedGb: 12, totalGb: 30 });
  assert.equal(ok.freeText, "18,0 GB");
  const invertido = ramUsageDisplay({ ...base, usagePercent: 40, usedGb: 40, totalGb: 30 });
  assert.equal(invertido.freeText, "—", "nunca disponível negativo");
});