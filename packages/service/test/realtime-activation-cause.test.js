import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProtectionEngineService } from "../dist/engine.js";

/**
 * P0 GUI-TEST-18/19 (15/10) — a causa de uma ativacao falhada deixou de ser
 * engolida: `startProtection()` devolve `failures` com motivo SANITIZADO
 * (caminhos pessoais reduzidos a C:\Users\<utilizador>).
 * OPCAO A do titular: o filtro WFP — o `start()` dele cria uma regra de
 * firewall, operacao privilegiada — NAO E INICIADO no arranque. A protecao de
 * ficheiros/processos sobe e o resultado traz `degraded` com o motivo; falhar
 * um OBRIGATORIO (watcher/processMonitor/etwConsumer/amsiProvider) continua
 * fatal, com teardown de todos.
 * Fixture espelha protection-background-off.test.js (mesmos seams comprovados).
 */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-realtime-cause-"));
  const e = new ProtectionEngineService(dir);
  for (const part of ["watcher", "processMonitor", "etwConsumer", "wfpFilter", "amsiProvider"]) {
    e[part].start = async () => {};
    e[part].stop = async () => {};
  }
  e.updater.startScheduler = () => {};
  e.processMonitor.list = async () => [];
  e.hardware.getSnapshot = async () => ({});
  e.refreshConnections = async () => {};
  t.after(async () => {
    await e.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { e, dir };
}

test("watcher falha: ok:false + failures com motivo sanitizado", async (t) => {
  const { e } = await fixture(t);
  e.watcher.start = async () => {
    throw new Error("spawn falhou em C:\\Users\\caioc\\AppData\\x: acesso negado");
  };
  const res = await e.startProtection();
  assert.equal(res.ok, false);
  assert.equal(res.protectionEnabled, false);
  assert.ok(Array.isArray(res.failures) && res.failures.length === 1, JSON.stringify(res.failures));
  assert.equal(res.failures[0].label, "watcher");
  assert.ok(!res.failures[0].reason.includes("caioc"), "o caminho pessoal nao pode vazar para a UI");
  assert.ok(res.failures[0].reason.includes("C:\\Users\\<utilizador>"), res.failures[0].reason);
});

test("WFP nao e iniciado pelo botao: protecao ATIVA com degradacao declarada", async (t) => {
  const { e } = await fixture(t);
  // OPCAO A (titular, 15/10): em vez de "tentar e falhar", o arranque NEM TOCA
  // no WFP — start() corre New-NetFirewallRule e stop() removeria a regra. Um
  // clique de protecao nao pode alterar o Windows; a rede fica em degradacao
  // explicita e o provisionamento privilegiado e uma decisao separada.
  const chamadas = [];
  e.wfpFilter.start = async () => { chamadas.push("start"); };
  e.wfpFilter.stop = async () => { chamadas.push("stop"); };
  const res = await e.startProtection();
  assert.deepEqual(chamadas, [], "nenhuma operacao de firewall implicita num clique");
  assert.equal(res.ok, true);
  assert.equal(res.protectionEnabled, true);
  assert.equal(e.protectionState, true, "ficheiros e processos ficam PROTEGIDOS apesar da rede degradada");
  assert.ok(Array.isArray(res.degraded) && res.degraded.length === 1, JSON.stringify(res.degraded));
  assert.equal(res.degraded[0].label, "wfpFilter");
  assert.match(res.degraded[0].reason, /nada foi alterado no Windows/i);
});

test("multiplos subsistemas fatais: todos aparecem em failures", async (t) => {
  const { e } = await fixture(t);
  e.processMonitor.start = async () => {
    throw new Error("CIM indisponivel");
  };
  e.etwConsumer.start = async () => {
    throw new Error("ETW indisponivel");
  };
  const res = await e.startProtection();
  assert.equal(res.ok, false);
  assert.deepEqual(res.failures.map((f) => f.label).sort(), ["etwConsumer", "processMonitor"]);
});
