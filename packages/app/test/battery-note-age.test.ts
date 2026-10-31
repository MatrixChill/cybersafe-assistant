/**
 * A nota de origem da bateria tem de mostrar a idade **sem depender de um
 * consumidor novo**: as chamadas existentes (`batteryDisplay(battery, origin)`)
 * passam só 2 argumentos, por isso o helper deriva `updatedAt` do próprio
 * snapshot (contrato C2) quando não lhe é dado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { batteryDisplay } from "../src/lib/batteryDisplay";
import type { HardwareSnapshot } from "@cybersafe/shared-types";

function battery(withAge: boolean) {
  const b = {
    status: "present" as const,
    percent: 50,
    isCharging: false,
    timeRemaining: null,
  };
  if (withAge) {
    (b as unknown as Record<string, unknown>).updatedAt = new Date(Date.now() - 90_000).toISOString();
  }
  return b as unknown as HardwareSnapshot["battery"];
}

test("com 2 argumentos, a nota usa a idade do próprio snapshot (CACHED)", () => {
  const d = batteryDisplay(battery(true), "CACHED");
  assert.ok(d.snapshotNote, "CACHED tem nota");
  assert.match(d.snapshotNote!, /guardada/i, "a nota diz que é uma leitura guardada");
  assert.match(d.snapshotNote!, /90 s|há 1 min|há 2 min/, "a nota traz a idade da leitura");
  assert.doesNotMatch(d.snapshotNote!, /comeu|ainda não/, "a nota obsoleta foi removida");
});

test("sem updatedAt no snapshot, a nota não inventa idade", () => {
  const d = batteryDisplay(battery(false), "CACHED");
  assert.ok(d.snapshotNote, "CACHED tem nota");
  assert.doesNotMatch(d.snapshotNote!, /h[áa] \d/, "sem timestamp não há idade inventada");
});

test("LIVE tem nota própria e UNAVAILABLE não tem nota", () => {
  assert.ok(batteryDisplay(battery(true), "LIVE").snapshotNote, "LIVE tem nota");
  assert.equal(batteryDisplay(battery(true), "UNAVAILABLE").snapshotNote, null, "UNAVAILABLE sem nota");
});

test("LIVE com sensor error/unavailable nao afirma 'ao vivo' nem 'atual'", () => {
  for (const status of ["error", "unavailable"] as const) {
    const b = {
      status,
      percent: null,
      isCharging: false,
      timeRemaining: null,
      updatedAt: new Date(Date.now() - 90_000).toISOString(),
    } as unknown as HardwareSnapshot["battery"];
    const d = batteryDisplay(b, "LIVE");
    assert.ok(d.snapshotNote, "LIVE tem nota");
    assert.doesNotMatch(d.snapshotNote!, /ao vivo|atual/i, "a origem global nao prova leitura atual do sensor");
    assert.match(d.snapshotNote!, /Dados do servi/, "a copy diz 'dados do servico'");
  }
});

test("LIVE sem timestamp: hora da ultima leitura indisponivel, sem inventar idade", () => {
  const d = batteryDisplay(battery(false), "LIVE");
  assert.ok(d.snapshotNote, "LIVE tem nota");
  assert.match(d.snapshotNote!, /indispon/i, "sem timestamp nao ha hora");
  assert.doesNotMatch(d.snapshotNote!, /h[áa] \d/, "sem timestamp nao ha idade");
  assert.doesNotMatch(d.snapshotNote!, /ao vivo|atual/i, "a copy nao afirma atualidade");
});

test("CACHED tem nota distinta de LIVE", () => {
  const live = batteryDisplay(battery(true), "LIVE");
  const cached = batteryDisplay(battery(true), "CACHED");
  assert.notEqual(live.snapshotNote, cached.snapshotNote, "CACHED e LIVE nao podem ter a mesma nota");
  assert.match(cached.snapshotNote!, /guardada/i, "CACHED diz que e leitura guardada");
});