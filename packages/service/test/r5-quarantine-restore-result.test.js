import { test } from "node:test";
import assert from "node:assert/strict";
import { ProtectionEngineService } from "../dist/engine.js";

function fixture(result) {
  // Exercise the real methods without constructing or starting OS adapters.
  const engine = Object.create(ProtectionEngineService.prototype);
  const calls = { trusted: [], events: [], history: [], restored: [] };
  engine.quarantine = {
    list: () => [{ id: "entry", sha256: "test-hash" }],
    restore: async (...args) => { calls.restored.push(args); return result; },
  };
  engine.allowHash = async (hash) => { calls.trusted.push(hash); };
  engine.eventBus = { publish: (...args) => calls.events.push(args) };
  engine.logHistory = async (record) => { calls.history.push(record); };
  return { engine, calls };
}

test("recusa de restauro preserva erro sem confiar hash nem emitir restored", async () => {
  const { engine, calls } = fixture({ success: false, error: "destino ocupado" });
  const result = await engine.restoreQuarantine("entry", true);
  assert.deepEqual(result, { success: false, error: "destino ocupado" });
  assert.deepEqual(calls.trusted, []);
  assert.deepEqual(calls.events, []);
  assert.deepEqual(calls.restored, [["entry", "desktop-ui"]]);
});

test("restauro confirmado devolve boolean, confia por pedido e emite um restored", async () => {
  const { engine, calls } = fixture({ success: true });
  assert.deepEqual(await engine.restoreQuarantine("entry", true), { success: true });
  assert.deepEqual(calls.trusted, ["test-hash"]);
  assert.equal(calls.events.length, 1);
  assert.equal(calls.events[0][0], "quarantine.restored");
  assert.deepEqual(calls.events[0][3], { id: "entry" });
});

test("restauro confirmado não confia hash sem pedido explícito", async () => {
  const { engine, calls } = fixture({ success: true });
  assert.deepEqual(await engine.restoreQuarantine("entry"), { success: true });
  assert.deepEqual(calls.trusted, []);
  assert.equal(calls.events.length, 1);
});

test("threat.action restore preserva a recusa sem registar sucesso", async () => {
  const { engine, calls } = fixture({ success: false, error: "destino ocupado" });
  assert.deepEqual(await engine.dispatch("threat.action", { id: "entry", action: "restore" }), {
    success: false, error: "destino ocupado",
  });
  assert.deepEqual(calls.history, []);
  assert.deepEqual(calls.trusted, []);
  assert.deepEqual(calls.events, []);
});

test("threat.action restore regista apenas restauro confirmado", async () => {
  const { engine, calls } = fixture({ success: true });
  assert.deepEqual(await engine.dispatch("threat.action", { id: "entry", action: "restore" }), { success: true });
  assert.equal(calls.history.length, 1);
  assert.equal(calls.history[0].type, "threat.restored");
});
