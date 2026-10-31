/**
 * REVIEW-BLOCKER (20/10) — o gate de fixture tem de ser provado por IDENTIDADE, não por texto.
 *
 * O achado, em uma frase: `String(startScan).includes("readOnly")` prova que uma função
 * CONTÉM a palavra — qualquer wrapper escrito à mão (ou trocado por outro processo) satisfaz
 * isso sem nunca ter montado o gate real. A prova passa a ser o registo PRIVADO que o próprio
 * módulo de instalação preenche: só a função que `installDevFixtureGate` instalou, para a raiz
 * que ela validou, conta como gate montado.
 *
 * Segundo achado corrigido aqui: `index.ts` chamava `service.init()` ANTES de
 * `installDevFixtureGate(service)`. O resolutor do corpus de teste corre dentro de `init()`,
 * pelo que a prova do gate nunca podia ser satisfeita — a ordem correcta é gate, init, pipe.
 *
 * Terceiro achado: o `then` do `ScanHistory.record` não autoriza «persistido» — o `record`
 * absorve a falha do append (scan-history.ts:202) e resolve mesmo quando nada foi escrito.
 * O estágio passa a `terminal_historico_processado` e a persistência é provada à parte, pela
 * query do histórico.
 *
 * Nada aqui precisa de Electron nem de GUI.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  installDevFixtureGate,
  gateDeFixtureMontadoPara,
  FIXTURE_SCAN_FLAG,
  FIXTURE_ROOT_ENV,
  GATE_CODE,
} from "../dist/dev-fixture-gate.js";

const BARRA = String.fromCharCode(92);
const PIPE_DE_RUN = BARRA + BARRA + "." + BARRA + "pipe" + BARRA + "cybersafe-dev-run-f1-teste";

/** Raiz de DEV + raiz de fixture REAIS em TEMP (nunca perfil pessoal). */
function piso(t) {
  const tmp = realFs.realpathSync(os.tmpdir());
  const base = realFs.mkdtempSync(path.join(tmp, "cs-f1-base-"));
  const fixture = realFs.mkdtempSync(path.join(tmp, "cs-f1-fix-"));
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

/** Instalação REAL do gate sobre um serviço mínimo. Devolve o ScanManager registado. */
function instalar(p, env = p.env) {
  const scanManager = new SM();
  const service = { handleRequest: async () => ({ ok: true }), scanManager, quarantinePolicy: "warn" };
  const montado = installDevFixtureGate(service, env, () => {});
  return { scanManager, service, montado };
}

// ————— 1) a função de verificação existe e aceita a instalação real —————

test("instalacao real do gate e reconhecida pelo verificador, sem alegar caminhos", (t) => {
  const p = piso(t);
  const { scanManager } = instalar(p);
  const prova = gateDeFixtureMontadoPara(scanManager, p.env);
  assert.equal(prova.montado, true, `gate real montado tem de ser reconhecido: ${JSON.stringify(prova)}`);
  assert.equal(typeof prova.motivo, "string");
  assert.ok(prova.motivo.length > 0, "tem de dizer em que se fundamenta");
  assert.ok(
    !prova.motivo.includes(p.fixture) && !prova.motivo.includes(p.base) && !prova.motivo.includes(os.homedir()),
    `o motivo nao pode ecoar caminhos: ${prova.motivo}`,
  );
});

// ————— 2) ausência de instalação nunca é gate montado —————

test("scanManager sem qualquer instalacao nao e gate montado", (t) => {
  const p = piso(t);
  const prova = gateDeFixtureMontadoPara(new SM(), p.env);
  assert.equal(prova.montado, false, JSON.stringify(prova));
});

test("wrapper artesanal que contem readOnly no texto NAO e prova do gate (o achado da revisao)", (t) => {
  const p = piso(t);
  const sm = new SM();
  const original = sm.startScan.bind(sm);
  // Idêntico ao gesto do gate, mas instalado por outra pessoa: o texto da função diz
  // «readOnly», e era exatamente isto que a prova antiga aceitava.
  sm.startScan = (type, target, options) => original(type, target, { ...(options || {}), readOnly: true });
  assert.ok(String(sm.startScan).includes("readOnly"), "o piso tem de conter a palavra que a prova antiga media");
  assert.equal(gateDeFixtureMontadoPara(sm, p.env).montado, false, "texto nao e identidade: so o modulo de instalacao registra");
});

test("wrapper trocado pelo de outra instancia e recusado", (t) => {
  const p = piso(t);
  const a = instalar(p);
  const b = instalar(p);
  assert.equal(gateDeFixtureMontadoPara(a.scanManager, p.env).montado, true);
  a.scanManager.startScan = b.scanManager.startScan;
  assert.equal(
    gateDeFixtureMontadoPara(a.scanManager, p.env).montado,
    false,
    "o wrapper registado noutro ScanManager nao prova gate neste",
  );
});

test("apagar a propriedade startScan (desmontar) remove a prova", (t) => {
  const p = piso(t);
  const { scanManager } = instalar(p);
  assert.equal(gateDeFixtureMontadoPara(scanManager, p.env).montado, true);
  delete scanManager.startScan;
  assert.equal(gateDeFixtureMontadoPara(scanManager, p.env).montado, false, "sem marca nao ha gate");
});

test("a raiz do ambiente tambem tem de ser a do registo", (t) => {
  const p = piso(t);
  const { scanManager } = instalar(p);
  const outra = realFs.mkdtempSync(path.join(realFs.realpathSync(os.tmpdir()), "cs-f1-outra-"));
  t.after(() => { try { realFs.rmSync(outra, { recursive: true, force: true }); } catch {} });
  assert.equal(
    gateDeFixtureMontadoPara(scanManager, { ...p.env, [FIXTURE_ROOT_ENV]: outra }).montado,
    false,
    "gate montado para uma raiz nao autoriza outra raiz",
  );
});

test("fixture invalida no ambiente nunca autoriza, mesmo com instalacao previa", (t) => {
  const p = piso(t);
  const { scanManager } = instalar(p);
  const mau = { ...p.env, [FIXTURE_ROOT_ENV]: path.join(os.homedir(), "Downloads") };
  assert.equal(gateDeFixtureMontadoPara(scanManager, mau).montado, false, "root ilegitimo nao pode provar gate");
});

test("verificador tolera alvo ausente ou primitivo sem lançar", () => {
  for (const alvo of [undefined, null, "scanManager", 7, () => 0]) {
    assert.equal(gateDeFixtureMontadoPara(alvo, {}).montado, false, `alvo ${typeof alvo} nao pode provar gate`);
  }
});

// ————— 3) a instalação real continua a ser a única porta do readOnly —————

test("o gate registado e mesmo gate que forcemente injeta readOnly", async (t) => {
  const p = piso(t);
  const recebidas = [];
  const scanManager = { startScan: async (type, target, options) => { recebidas.push(options); return "scan"; } };
  const service = { handleRequest: async () => ({ ok: true }), scanManager, quarantinePolicy: "warn" };
  installDevFixtureGate(service, p.env, () => {});
  assert.equal(gateDeFixtureMontadoPara(scanManager, p.env).montado, true);
  await scanManager.startScan("custom", p.fixture, { readOnly: false });
  assert.deepEqual(recebidas[0], { readOnly: true, }, "identidade do wrapper tem de implicar o readOnly forcado");
});

test("config invalida continua a matar a instalacao (falha => zero sessao)", (t) => {
  const p = piso(t);
  assert.throws(
    () => instalar(p, { ...p.env, [FIXTURE_ROOT_ENV]: path.join(os.homedir(), "Downloads") }),
    (e) => { assert.match(String(e.message), new RegExp(GATE_CODE)); return true; },
    "root pessoal fora do TEMP nao monta gate nenhum",
  );
});

// ————— 4) ORDEM DO BOOTSTRAP (index.ts) —————

test("bootstrap real: o gate e montado ANTES de init() e antes do pipe", () => {
  const fonte = realFs.readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
  const iGate = fonte.indexOf("installDevFixtureGate(service");
  const iInit = fonte.indexOf("await service.init()");
  const iPipe = fonte.indexOf("service.startPipeServer()");
  assert.ok(iGate >= 0, "o bootstrap tem de montar o gate");
  assert.ok(iInit >= 0, "o bootstrap tem de chamar init()");
  assert.ok(iPipe >= 0, "o bootstrap tem de arrancar o pipe");
  assert.ok(iGate < iInit, "gate depois do init() e o bug: o resolutor do corpus corre dentro de init()");
  assert.ok(iGate < iPipe, "nenhum pedido pode chegar sem o gate montado");
});

test("ordem correta aceita o corpus de teste com o servico REAL em init()", async (t) => {
  // É exatamente a sequência de `index.ts` corrigido: construir, montar o gate, init().
  // Com a ordem antiga esta asserção falhava com `dev_test_yara:gate_nao_montado`.
  const { resolverCorpusYara, DEV_TEST_YARA_ENV } = await import("../dist/dev-test-yara.js");
  const { ProtectionEngineService } = await import("../dist/engine.js");
  const tmp = realFs.realpathSync(os.tmpdir());
  const base = realFs.mkdtempSync(path.join(tmp, "cs-f1-svc-"));
  const fixture = realFs.mkdtempSync(path.join(tmp, "cs-f1-svcfix-"));
  const guardado = {};
  const chaves = [
    "NODE_ENV", "CYBERSAFE_DEV_ISOLATION", FIXTURE_SCAN_FLAG, FIXTURE_ROOT_ENV,
    "CYBERSAFE_DEV_ROOT", "CYBERSAFE_DEV_SERVICE_DIR", "CYBERSAFE_DEV_USER_DATA_DIR",
    "CYBERSAFE_DEV_PIPE_NAME", "CYBERSAFE_DB_PATH", DEV_TEST_YARA_ENV,
  ];
  for (const k of chaves) { guardado[k] = process.env[k]; delete process.env[k]; }
  try {
    realFs.mkdirSync(path.join(base, "service"), { recursive: true });
    realFs.mkdirSync(path.join(base, "user-data"), { recursive: true });
    realFs.mkdirSync(path.join(base, "yara"), { recursive: true });
    realFs.mkdirSync(fixture, { recursive: true });
    const corpus = path.join(base, "yara", "dev-canary.yar");
    const { DEV_TEST_YARA_CANONICO } = await import("../dist/dev-test-yara.js");
    realFs.writeFileSync(corpus, DEV_TEST_YARA_CANONICO);
    process.env.NODE_ENV = "development";
    process.env.CYBERSAFE_DEV_ISOLATION = "1";
    process.env[FIXTURE_SCAN_FLAG] = "1";
    process.env[FIXTURE_ROOT_ENV] = fixture;
    process.env.CYBERSAFE_DEV_ROOT = base;
    process.env.CYBERSAFE_DEV_SERVICE_DIR = path.join(base, "service");
    process.env.CYBERSAFE_DEV_USER_DATA_DIR = path.join(base, "user-data");
    process.env.CYBERSAFE_DEV_PIPE_NAME = PIPE_DE_RUN;
    process.env.CYBERSAFE_DB_PATH = path.join(base, "service", "cybersafe.sqlite");
    process.env[DEV_TEST_YARA_ENV] = corpus;

    const svc = new ProtectionEngineService(base);
    assert.equal(installDevFixtureGate(svc, process.env, () => {}), true, "o gate tem de se montar no servico real");
    await svc.init();

    const decisao = await resolverCorpusYara({
      env: process.env,
      definitionsDir: path.join(base, "definitions"),
      scanManager: svc.scanManager,
    });
    assert.equal(decisao.origem, "dev-test", `com a ordem corrigida o corpus de teste e aceite: ${decisao.motivo}`);
    assert.equal(decisao.path, corpus);
  } finally {
    try { await svc?.dispose?.(); } catch {}
    for (const k of chaves) { if (guardado[k] === undefined) delete process.env[k]; else process.env[k] = guardado[k]; }
    for (const p of [base, fixture]) { try { realFs.rmSync(p, { recursive: true, force: true }); } catch {} }
  }
});

// ————— 5) o verificador é o único portão do A4 (corpus de teste) —————

test("o A4 recusa sem gate real e aceita com a instalacao registada", async (t) => {
  const p = piso(t);
  const { resolverCorpusYara, DEV_TEST_YARA_ENV, RECUSA, DEV_TEST_YARA_CANONICO } = await import("../dist/dev-test-yara.js");
  const corpus = path.join(p.base, "dev-canary.yar");
  realFs.writeFileSync(corpus, DEV_TEST_YARA_CANONICO);
  const env = { ...p.env, [DEV_TEST_YARA_ENV]: corpus };
  const base = { env, definitionsDir: path.join(p.base, "definitions") };

  const sm = new SM();
  const original = sm.startScan.bind(sm);
  sm.startScan = (type, target, options) => original(type, target, { ...(options || {}), readOnly: true });
  await assert.rejects(
    () => resolverCorpusYara({ ...base, scanManager: sm }),
    (e) => { assert.ok(String(e.message).includes(`dev_test_yara:${RECUSA.GATE}`), e.message); return true; },
    "wrapper artesanal nao abre o corpus de teste",
  );
  await assert.rejects(
    () => resolverCorpusYara({ ...base, scanManager: new SM() }),
    (e) => { assert.ok(String(e.message).includes(`dev_test_yara:${RECUSA.GATE}`), e.message); return true; },
    "sem gate nao ha corpus de teste",
  );
  const decisao = await resolverCorpusYara({ ...base, scanManager: instalar(p).scanManager });
  assert.equal(decisao.origem, "dev-test", decisao.motivo);
});

// ————— 6) D2 —————
// O lado do registo do cancelamento (`cancelamentoObservavel` a rejeitar o wrapper
// artesanal e a aceitar a instalação real) vive em `scan-cancel-observability.test.js`,
// que é o lote D2: é esse lote que muda o `scan-manager.ts`. Aqui, no lote A4, o que se
// prova é o verificador e a ordem do bootstrap.
