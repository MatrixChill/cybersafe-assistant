import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSpawnClamav } from "../dist/index.js";

/**
 * v0.2.4 — notebook (i5-8350U): «o fim da prova não foi confirmado pelo
 * Windows», sem nenhum clamscan vivo minutos depois.
 *
 * O grace de 2 s começava no killTree(), mas a terminação só acontecia depois
 * de a identidade por CIM se resolver (até ~2 s + sondas síncronas). Num PC
 * lento o grace expirava ANTES da terminação: o desfecho saía «morte não
 * confirmada», a vaga era envenenada e o processo morria a seguir.
 */
function filho(pid) {
  const c = new EventEmitter();
  c.pid = pid; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.state = { kills: 0, died: false };
  c.kill = () => { c.state.kills++; setTimeout(() => c.die(1), 30); return true; };
  c.die = (code) => { if (c.state.died) return; c.state.died = true; c.exitCode = code; c.emit("exit", code, null); c.emit("close", code, null); };
  return c;
}
function rig({ probeMs }) {
  let child;
  const hooks = {
    spawn: () => (child = filho(4242)),
    spawnSync: () => { throw new Error("nunca terminar por PID sem identidade"); },
    // CIM lento e sem resposta útil: só o handle do filho próprio pode terminar.
    probeIdentity: () => { const fim = Date.now() + probeMs; while (Date.now() < fim) { /* sonda lenta */ } return { row: null, probeFailed: true, detail: "CIM lento" }; },
  };
  return { hooks, get child() { return child; } };
}

test("identidade CIM lenta: o grace conta depois da terminação e a morte fica confirmada", async () => {
  // ~1,1 s por consulta CIM (PowerShell síncrono num i5-8350U): a terminação
  // só acontece depois de o grace antigo de 2 s ter expirado.
  const r = rig({ probeMs: 1100 });
  const handle = createSpawnClamav(r.hooks)("C:/clamav/clamscan.exe", ["--database=x", "f"], { scanId: "v024" });
  const t0 = Date.now();
  handle.killTree();
  const outcome = await handle.outcome;
  assert.equal(r.child.state.kills, 1, "terminado pelo handle");
  assert.notEqual(outcome.deathUnconfirmed, true, `morte confirmada pelo close (${Date.now() - t0} ms)`);
});

test("filho que nunca fecha continua a dar morte não confirmada (teto absoluto)", async () => {
  const r = rig({ probeMs: 10 });
  const handle = createSpawnClamav(r.hooks)("C:/clamav/clamscan.exe", ["--database=x", "f"], { scanId: "v024b" });
  r.child.kill = () => { r.child.state.kills++; return true; }; // pedido aceite, close nunca chega
  handle.killTree();
  const outcome = await handle.outcome;
  assert.equal(outcome.deathUnconfirmed, true, "sem close não há morte confirmada");
  r.child.die(1);
});
