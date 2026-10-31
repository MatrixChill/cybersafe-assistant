import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createUnconfiguredUpdater,
  failureResult,
  failureSnapshot,
  toAppUpdateSnapshot,
  toWireResult,
  validateAutomaticInput,
  validateInstallRequest,
} from "../src/updater/bridge.ts";

/**
 * TP-UPDATE-INTEGRATE — ponte mínima. Testa o que o main chama: validação EM
 * RUNTIME dos payloads (não confiar no tipo TS), o estado honesto UNCONFIGURED /
 * UNSUPPORTED sem invocar adaptadores, e a tradução domínio→contrato. Nada corre
 * rede/fs/instalador.
 */

describe("bridge — validação de payload do IPC em RUNTIME", () => {
  it("install: só aceita {confirmed:true, expectedVersion:string não vazio}", () => {
    for (const bad of [null, undefined, "x", 42, [], {}, { confirmed: false, expectedVersion: "1.0.0" }, { confirmed: true }, { confirmed: true, expectedVersion: "" }, { confirmed: true, expectedVersion: 42 }, { confirmed: "true", expectedVersion: "1.0.0" }]) {
      const r = validateInstallRequest(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      if (!r.ok) assert.equal(r.error, "installation");
    }
    const good = validateInstallRequest({ confirmed: true, expectedVersion: "1.2.3" });
    assert.equal(good.ok, true);
    if (good.ok) assert.deepEqual(good.value, { confirmed: true, expectedVersion: "1.2.3" });
  });

  it("setAutomaticCheck: só boolean; qualquer outra coisa é erro", () => {
    assert.deepEqual(validateAutomaticInput(true), { ok: true, value: true });
    assert.deepEqual(validateAutomaticInput(false), { ok: true, value: false });
    for (const bad of [undefined, null, "true", 1, 0, {}, []]) {
      assert.equal(validateAutomaticInput(bad).ok, false, String(bad));
    }
  });
});

describe("bridge — updater UNCONFIGURED sem tocar em adaptadores", () => {
  function installedSnapshot() {
    return { phase: "idle", channel: "stable", installed: { version: "0.1.0" }, canInstall: false, automaticCheckEnabled: false };
  }

  it("runtime suportado mas sem config ⇒ unconfigured; check NÃO lança nem usa source", async () => {
    const u = createUnconfiguredUpdater({ runtimeSupported: true, installedVersion: "0.1.0" });
    assert.equal(u.snapshotCopy().phase, "unconfigured");
    const r = await u.check(); // se invocasse BLOCKED_SOURCE, rebentava; gate trava antes
    assert.equal(r.ok, false);
    assert.equal(r.error, "unconfigured");
  });

  it("dev/portable ⇒ unsupported honesto", async () => {
    const u = createUnconfiguredUpdater({ runtimeSupported: false, installedVersion: "0.1.0" });
    assert.equal(u.snapshotCopy().phase, "unsupported");
    const r = await u.check();
    assert.equal(r.error, "unsupported");
    const i = await u.install({ confirmed: true, expectedVersion: "0.2.0" });
    assert.equal(i.error, "unsupported"); // gate antes de qualquer instalador
  });

  it("get-snapshot sem updater ⇒ snapshot unconfigured (nunca crash)", () => {
    const s = failureSnapshot("unconfigured", "0.1.0", "updater não inicializado");
    assert.equal(s.status, "unconfigured");
    assert.equal(s.canInstall, false);
    assert.equal(s.channel, "stable");
    assert.equal(s.installed.version, "0.1.0");
  });

  it("failureResult de payload inválido ⇒ error installation, nunca 'ok'", () => {
    const r = failureResult("installation", "0.1.0", "pedido inválido");
    assert.equal(r.ok, false);
    assert.equal(r.error, "installation");
    assert.equal(r.snapshot.status, "error");
  });
});

describe("bridge — tradução domínio → contrato", () => {
  it("mapeia fase→status (upToDate→up-to-date) e preserva campos", () => {
    const snap = toAppUpdateSnapshot({
      phase: "upToDate",
      channel: "stable",
      installed: { version: "0.1.0" },
      latest: undefined,
      canInstall: false,
      automaticCheckEnabled: false,
    });
    assert.equal(snap.status, "up-to-date");
    const avail = toAppUpdateSnapshot({
      phase: "available",
      channel: "stable",
      installed: { version: "0.1.0" },
      latest: { version: "0.2.0", publishedAt: "2026-10-17T00:00:00Z", notes: "x", sizeBytes: 10 },
      canInstall: false,
      automaticCheckEnabled: false,
    });
    assert.equal(avail.status, "available");
    assert.equal(avail.latest?.version, "0.2.0");
  });

  it("toWireResult propaga ok/falha para o shape do contrato", () => {
    const dom = { phase: "error", channel: "stable", installed: { version: "0.1.0" }, canInstall: false, automaticCheckEnabled: false, error: { code: "downgrade", message: "x" } };
    const wire = toWireResult({ ok: false, error: "downgrade", snapshot: dom });
    assert.equal(wire.ok, false);
    assert.equal(wire.error, "downgrade");
    assert.equal(wire.snapshot.status, "error");
  });
});
