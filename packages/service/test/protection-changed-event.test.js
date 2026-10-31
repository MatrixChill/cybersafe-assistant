import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ProtectionEngineService } from "../dist/engine.js";

/**
 * P0 TRAY — O ESTADO CONFIRMADO DA PROTEÇÃO SAI POR EVENTO, NÃO POR POLL.
 *
 * A tray mostrava o resultado só quando o pedido RPC regressava (e, em pior
 * caso, quando o poll de 5 s seguinte corria). Este contrato garante que cada
 * MUDANÇA REAL de estado publica UM evento de baixa frequência com o facto
 * confirmado, para a tray e o renderer pintarem sem esperar.
 *
 * Regras prendidas aqui:
 *  - o payload é o estado CONFIRMADO (protectionEnabled/protectionPausedUntil),
 *    nunca o pedido do utilizador;
 *  - um evento por mudança, não um por poll;
 *  - a pausa publica o prazo REAL agendado.
 *
 * Não se chama init(): estes métodos não precisam de watcher/ETW. Onde é
 * preciso simular proteção a correr, escreve-se o campo (propriedade normal em
 * runtime), evitando arrancar motores nativos no teste.
 */

const TEST_BASE_DIR = mkdtempSync(path.join(os.tmpdir(), "cybersafe-prot-changed-"));
const MIN = 60_000;

let engine = null;
let captured = [];

function freshEngine() {
  engine = new ProtectionEngineService(TEST_BASE_DIR);
  captured = [];
  engine.eventBus.on("protection.changed", (event) => captured.push(event));
  return engine;
}

afterEach(async () => {
  if (engine) {
    await engine.dispose().catch(() => {});
    engine = null;
  }
});

describe("protection.changed — estado confirmado, baixa frequência", () => {
  it("stopProtection publica exactamente um evento com o estado desligado", async () => {
    const e = freshEngine();
    // Simula proteção a correr sem arrancar os motores nativos.
    e.protectionState = true;

    const r = await e.stopProtection();

    assert.equal(r.ok, true);
    assert.equal(r.protectionEnabled, false);
    assert.equal(captured.length, 1, "um evento, e só um, por mudança de estado");
    const ev = captured[0];
    assert.equal(ev.type, "protection.changed");
    assert.equal(ev.data.protectionEnabled, false);
    assert.equal(ev.data.protectionPausedUntil, null);
  });

  it("pauseProtection publica o prazo REAL agendado", async () => {
    const e = freshEngine();

    const r = await e.pauseProtection(15 * MIN);
    assert.ok(r.pausedUntil, "a pausa com duração tem de devolver o prazo");

    const ev = captured.at(-1);
    assert.equal(ev.type, "protection.changed");
    assert.equal(ev.data.protectionEnabled, false);
    assert.equal(ev.data.protectionPausedUntil, r.pausedUntil);
  });

  it("o payload reflecte o estado real, nunca um desejo", () => {
    const e = freshEngine();

    e.protectionState = true;
    e.protectionPausedUntil = null;
    e.publishProtectionChanged();
    assert.equal(captured.at(-1).data.protectionEnabled, true);
    assert.equal(captured.at(-1).data.protectionPausedUntil, null);
    assert.equal(captured.at(-1).severity, "low");

    e.protectionState = false;
    e.publishProtectionChanged();
    assert.equal(captured.at(-1).data.protectionEnabled, false);
    assert.equal(captured.at(-1).severity, "medium");
  });
});
