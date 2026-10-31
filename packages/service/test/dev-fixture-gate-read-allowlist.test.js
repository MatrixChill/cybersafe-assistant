/**
 * TP-PAP-SCANNER 28/10 — delta allowlist de LEITURAS no gate de fixture.
 *
 * A sessão de fixture passou a aceitar também as leituras PURAS que a UI/Electron
 * precisa para telemetria e motores (protection.getState, hardware.snapshot,
 * events.list, threats.list, quarantine.list, processes.list, pcstate.get,
 * windows.healthSnapshot, connections.list, protectionIntent.get, usb.getState,
 * exclusions.get), mantendo FECHADO todo o resto.
 *
 * Regras do delta (reviewer Codex):
 *  - lista EXPLÍCITA e fechada no gate; NUNCA um alias de `INDEPENDENT_READ_METHODS`
 *    (esse set é exportado/mutável e métodos futuros da fila não devem ampliar
 *    automaticamente este perfil). Aqui validamos apenas que a lista do gate está
 *    contida em `INDEPENDENT_READ_METHODS` + scan.* — como verificação, não como
 *    autorização.
 *  - Nenhuma MUTAÇÃO é autorizada: monitor.*, quarantine.restore/delete,
 *    process.killTree, trust.*, exclusions.update, definitions.update, events.clear,
 *    usb.configure/scan/cancel, scan.fullSystem, scan.artifact, analysis.restricted,
 *    process.analyze, protectionIntent.setOptIn — todos recusados (negativos).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  installDevFixtureGate,
  gateDeFixtureMontadoPara,
  FIXTURE_SCAN_FLAG,
  FIXTURE_ROOT_ENV,
  GATE_CODE,
} from "../dist/dev-fixture-gate.js";
import { INDEPENDENT_READ_METHODS } from "../dist/rpc-request-queue.js";

const BARRA = String.fromCharCode(92);
const PIPE_DE_RUN = BARRA + BARRA + "." + BARRA + "pipe" + BARRA + "cybersafe-dev-run-leituras-teste";

function piso(t) {
  const tmp = realFs.realpathSync(os.tmpdir());
  const base = realFs.mkdtempSync(path.join(tmp, "cs-leit-base-"));
  const fixture = realFs.mkdtempSync(path.join(tmp, "cs-leit-fix-"));
  t.after(() => {
    for (const p of [base, fixture]) { try { realFs.rmSync(p, { recursive: true, force: true }); } catch {} }
  });
  const env = {
    NODE_ENV: "development",
    CYBERSAFE_DEV_ISOLATION: "1",
    [FIXTURE_SCAN_FLAG]: "1",
    [FIXTURE_ROOT_ENV]: fixture,
    CYBERSAFE_DEV_ROOT: base,
    CYBERSAFE_DEV_SERVICE_DIR: path.join(base, "service"),
    CYBERSAFE_DEV_USER_DATA_DIR: path.join(base, "user-data"),
    CYBERSAFE_DEV_PIPE_NAME: PIPE_DE_RUN,
  };
  return { base, fixture, env };
}

class SM {
  async startScan() { return "scan"; }
}

/**
 * Instala o gate sobre um serviço cujo `handleRequest` original REGISTA o método
 * recebido. Assim verificamos o que o gate deixa passar para o motor vs. o que
 * recusa antes — sem tocar em nenhum motor real.
 */
function instalarComRegisto(p, env = p.env) {
  const vistos = [];
  const scanManager = new SM();
  const service = {
    quarantinePolicy: "warn",
    scanManager,
    handleRequest: async (r) => { vistos.push(String(r?.method ?? "")); return { ok: true, result: "motor" }; },
  };
  const montado = installDevFixtureGate(service, env, () => {});
  return { scanManager, service, vistos, montado };
}

// ————— 1) leituras autorizadas: passam pelo gate e chegam ao motor —————

const LEITURAS_ESPERADAS = [
  "protection.getState",
  "protectionIntent.get",
  "events.list",
  "threats.list",
  "processes.list",
  "connections.list",
  "quarantine.list",
  "pcstate.get",
  "hardware.snapshot",
  "windows.healthSnapshot",
  "usb.getState",
  "exclusions.get",
];

test("leituras puras da UI passam pelo gate e chegam ao motor", async (t) => {
  const p = piso(t);
  const { service, vistos, montado } = instalarComRegisto(p);
  assert.equal(montado, true);
  assert.equal(gateDeFixtureMontadoPara(service.scanManager, p.env).montado, true);
  for (const metodo of LEITURAS_ESPERADAS) {
    vistos.length = 0;
    const resp = await service.handleRequest({ id: "1", method: metodo });
    assert.equal(resp.ok, true, `${metodo} devia ser autorizado: ${resp.error ?? ""}`);
    assert.deepEqual(vistos, [metodo], `${metodo} devia chegar ao motor`);
  }
});

test("a allowlist de leituras é EXPLÍCITA e fechada — método sintético no set da fila não amplia o gate", async (t) => {
  // O delta proíbe o alias: adicionar um método ao set exportado da fila NÃO pode
  // ampliar este perfil. Adicionamos um método sintético e provamos que o gate
  // continua a recusá-lo; removemos no finally.
  const SINTETICO = "events.synthetic_amplia_fila";
  INDEPENDENT_READ_METHODS.add(SINTETICO);
  t.after(() => { INDEPENDENT_READ_METHODS.delete(SINTETICO); });
  const p = piso(t);
  const { service, vistos } = instalarComRegisto(p);
  vistos.length = 0;
  const resp = await service.handleRequest({ id: "1", method: SINTETICO });
  assert.equal(resp.ok, false, `${SINTETICO} não pode ser autorizado por aparecer na fila`);
  assert.deepEqual(vistos, [], `${SINTETICO} não pode chegar ao motor`);
  INDEPENDENT_READ_METHODS.delete(SINTETICO);
  assert.equal(INDEPENDENT_READ_METHODS.has(SINTETICO), false, "set restaurado");
});

test("as leituras comuns existem na fila; as restantes confirmadas no dispatch (sem exigir tudo em INDEPENDENT)", async () => {
  // protectionIntent.get, usb.getState e exclusions.get são leituras confirmadas do
  // dispatch, mas entram como BARREIRAS na fila atual (não estão em
  // INDEPENDENT_READ_METHODS). Não alteramos a fila por este TP; só confirmamos que
  // as 9 leituras da fila estão na allowlist do gate.
  for (const metodo of [
    "protection.getState", "events.list", "threats.list", "processes.list",
    "connections.list", "quarantine.list", "pcstate.get", "hardware.snapshot",
    "windows.healthSnapshot",
  ]) {
    assert.ok(INDEPENDENT_READ_METHODS.has(metodo), `${metodo} devia estar em INDEPENDENT_READ_METHODS`);
    assert.ok(LEITURAS_ESPERADAS.includes(metodo), `${metodo} devia estar na allowlist do gate`);
  }
});

// ————— 2) negativos preservados: nenhuma MUTAÇÃO é autorizada —————

const MUTACOES_RECUSADAS = [
  "monitor.start",
  "monitor.stop",
  "monitor.pause",
  "monitor.resume",
  "quarantine.restore",
  "quarantine.delete",
  "process.killTree",
  "process.analyze",
  "trust.allowHash",
  "trust.allowPublisher",
  "exclusions.update",
  "definitions.update",
  "events.clear",
  "usb.configure",
  "usb.scan",
  "usb.cancel",
  "scan.fullSystem",
  "scan.artifact",
  "analysis.restricted",
  "protectionIntent.setOptIn",
];

test("nenhuma mutação passa pelo gate: todas recusadas antes do motor", async (t) => {
  const p = piso(t);
  const { service, vistos } = instalarComRegisto(p);
  for (const metodo of MUTACOES_RECUSADAS) {
    vistos.length = 0;
    const resp = await service.handleRequest({ id: "1", method: metodo, payload: {} });
    assert.equal(resp.ok, false, `${metodo} tinha de ser recusado`);
    assert.match(String(resp.error ?? ""), new RegExp(GATE_CODE), `${metodo} tinha de ecoar o código do gate`);
    assert.deepEqual(vistos, [], `${metodo} NUNCA pode chegar ao motor`);
  }
});

test("métodos desconhecidos/novos são recusados (nenhuma ampliação automática)", async (t) => {
  const p = piso(t);
  const { service, vistos } = instalarComRegisto(p);
  for (const metodo of ["events.subscribe", "protection.new", "scan.turbo", "exclusions.create", "usb.mount"]) {
    vistos.length = 0;
    const resp = await service.handleRequest({ id: "1", method: metodo });
    assert.equal(resp.ok, false, `${metodo} não existe na allowlist fechada`);
    assert.deepEqual(vistos, [], `${metodo} não pode chegar ao motor`);
  }
});

// ————— 3) scan.* continua a funcionar como antes —————

test("scan.start custom continua a ser o único caminho para análise, com readOnly forçado", async (t) => {
  const p = piso(t);
  const corpo = path.join(p.fixture, "corpus");
  realFs.mkdirSync(corpo, { recursive: true });
  realFs.writeFileSync(path.join(corpo, "a.txt"), "fixture de teste autorizada");
  const recebidas = [];
  const scanManager = { startScan: async (type, target, options) => { recebidas.push({ type, target, options }); return "scan"; } };
  const service = {
    quarantinePolicy: "warn",
    scanManager,
    handleRequest: async (r) => {
      if (r?.method === "scan.start") {
        const p = r.payload ?? {};
        await scanManager.startScan(p.type, p.targetPath, {});
      }
      return { ok: true, result: "motor" };
    },
  };
  installDevFixtureGate(service, p.env, () => {});
  const resp = await service.handleRequest({ id: "1", method: "scan.start", payload: { type: "custom", targetPath: corpo } });
  assert.equal(resp.ok, true, resp.error ?? "");
  assert.deepEqual(recebidas[0], { type: "custom", target: corpo, options: { readOnly: true } }, "readOnly tem de continuar forçado");
});

test("scan.start fora do root continua recusado", async (t) => {
  const p = piso(t);
  const { service } = instalarComRegisto(p);
  const fora = realFs.mkdtempSync(path.join(realFs.realpathSync(os.tmpdir()), "cs-leit-fora-"));
  t.after(() => { try { realFs.rmSync(fora, { recursive: true, force: true }); } catch {} });
  const resp = await service.handleRequest({ id: "1", method: "scan.start", payload: { type: "custom", targetPath: fora } });
  assert.equal(resp.ok, false);
  assert.match(String(resp.error ?? ""), new RegExp(GATE_CODE));
});
