import { test } from "node:test";
import assert from "node:assert/strict";
import { ProtectionEngineService } from "../dist/engine.js";

// v0.2.4 — uma prova recusada por vaga envenenada não pode gastar uma das 6
// tentativas de recuperação: antes, um ciclo destes esgotava-as e o ClamAV
// ficava degradado para sempre mesmo depois de a vaga voltar.
function motor(detail) {
  const e = Object.create(ProtectionEngineService.prototype);
  Object.assign(e, {
    clamav: { health: { status: "degraded", detail }, isAvailable: async () => false },
    lastClamavHealthStatus: "degraded", isShuttingDown: false, startupStateValue: "ready",
    clamavRecoveryTimer: null, clamavRecoveryAttempts: 0, clamavBackoffMs: 0, clamavNextProbeAt: 0,
    actionsLog: { write: async () => {} }, eventBus: { publish: () => {} },
  });
  return e;
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test("recusa por vaga envenenada não conta como tentativa", async () => {
  const e = motor("Base presente em clamav, mas um clamscan anterior ainda não terminou (o Windows não confirmou o fim).");
  e.observeAndRecoverClamav(); await tick(); await tick();
  assert.equal(e.clamavRecoveryAttempts, 0);
  assert.ok(e.clamavBackoffMs > 0, "o recuo continua a crescer");
});

test("falha real continua a contar (teto de 6 mantém-se)", async () => {
  const e = motor("Base presente em clamav mas a prova de carga falhou (exit 2).");
  e.observeAndRecoverClamav(); await tick(); await tick();
  assert.equal(e.clamavRecoveryAttempts, 1);
});
