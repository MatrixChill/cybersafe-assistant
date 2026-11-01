/**
 * TP-A5-D2-20261020 — observabilidade do cancelamento (estágios distintos, nenhum a alegar gravação).
 *
 * Medido no A5 (20/10, 22:45): o `scan.start` deixou 5 linhas de registo com requestId
 * e scanId; o `scan.cancel` não deixou NENHUMA. Sem registo, «a UI mostrou cancelado»,
 * «o manager recebeu o pedido» e «o terminal foi emitido e gravado» são a mesma frase,
 * e uma regressão que cancelasse tarde demais não seria distinguível de um cancelamento
 * que nunca chegou ao serviço.
 *
 * Este teste usa o serviço REAL (`ProtectionEngineService` + `ScanManager`), o gate de
 * fixture REAL montado por cima, e um scan de verdade sobre uma pasta sintética em TEMP.
 * Nada é simulado à frente do handler.
 *
 * Contratos que este ficheiro protege:
 *  - estágios distinguíveis: recebido no handler → processado no manager (com o desfecho) →
 *    terminal EMITIDO → cadeia do histórico PROCESSADA. O ACK do handler não prova o
 *    terminal; «emitido» não prova «gravado»; e «processado» NÃO prova «persistido» —
 *    `ScanHistory.record` absorve a falha do append e resolve de qualquer forma, por isso a
 *    gravação é provada à parte, pela consulta do histórico;
 *  - o ACK de `scan.cancel` diz se uma NOVA cancelação foi aceite: `true` só com
 *    `desfecho=cancelado`; `false` para id desconhecido, sem id, ou já terminal
 *    (`engine.ts:5010 return { success: desfecho === "cancelado" }`). É o contrato
 *    UI-D1, que o renderer foi construído para consumir
 *    (`app/src/pages/FileScannerPage.tsx:945-948`, `app/src/lib/scanSession.ts:590-595`):
 *    uma recusa deixa o botão activo em vez de prometer «cancelamento pedido».
 *    A asserção antiga — «a resposta NÃO muda em qualquer desfecho» — estava
 *    aposentada e é retiradas daqui; o que estes casos provam são os ESTÁGIOS.
 *  - só fala em DEV verificado (isolamento + gate de fixture montado, provado pelo registo
 *    privado do módulo de instalação e não pelo texto da função); fora disso, zero linhas
 *    novas — produção e modo desligado não ganham ruído;
 *  - whitelist: estágio, scanId validado como UUID, desfecho, estado terminal e timestamp.
 *    Nunca nomes, caminhos, utilizador, payload, tokens ou erros brutos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProtectionEngineService } from "../dist/engine.js";
import { installDevFixtureGate, FIXTURE_SCAN_FLAG, FIXTURE_ROOT_ENV } from "../dist/dev-fixture-gate.js";
import { linhaDeCancelamento, cancelamentoObservavel } from "../dist/scan-manager.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINHA = /^\[ScanCancel\] stage=(recebido|processado|terminal_emitido|terminal_historico_processado) scanId=([0-9a-f-]{36}|invalido)( desfecho=(cancelado|desconhecido|ja_terminal))?( status=cancelled)? ts=\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

/** Capta console.log sem tocar no motor. Devolve só as linhas do cancelamento. */
function capturar() {
  const original = console.log;
  const linhas = [];
  console.log = (...args) => {
    const s = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    linhas.push(s);
    if (s.includes("[ScanCancel]") && !LINHA.test(s.trim())) original(`[LINHA_FORA_DA_WHITELIST] ${s}`);
  };
  return {
    linhas,
    cancelamento: () => linhas.filter((l) => l.includes("[ScanCancel]")).map((l) => l.trim()),
    restaurar: () => { console.log = original; },
  };
}

async function servoDeVerdade(t, { dev = true } = {}) {
  const base = await fsp.mkdtemp(path.join(realFs.realpathSync(os.tmpdir()), "cs-d2-base-"));
  const fixture = await fsp.mkdtemp(path.join(realFs.realpathSync(os.tmpdir()), "cs-d2-fix-"));
  for (let i = 0; i < 60; i++) await fsp.writeFile(path.join(fixture, `ficheiro-${i}.bin`), Buffer.alloc(64 * 1024, i % 251));

  const guardado = {};
  const chaves = ["NODE_ENV", "CYBERSAFE_DEV_ISOLATION", FIXTURE_SCAN_FLAG, FIXTURE_ROOT_ENV, "CYBERSAFE_DEV_ROOT", "CYBERSAFE_DEV_SERVICE_DIR", "CYBERSAFE_DEV_USER_DATA_DIR", "CYBERSAFE_DEV_PIPE_NAME"];
  for (const k of chaves) { guardado[k] = process.env[k]; process.env[k] = ""; delete process.env[k]; }
  if (dev) {
    process.env.NODE_ENV = "development";
    process.env.CYBERSAFE_DEV_ISOLATION = "1";
    process.env[FIXTURE_SCAN_FLAG] = "1";
    process.env[FIXTURE_ROOT_ENV] = fixture;
    process.env.CYBERSAFE_DEV_ROOT = base;
    process.env.CYBERSAFE_DEV_SERVICE_DIR = path.join(base, "service");
    process.env.CYBERSAFE_DEV_USER_DATA_DIR = path.join(base, "user-data");
    const BARRA = String.fromCharCode(92);
    process.env.CYBERSAFE_DEV_PIPE_NAME = BARRA + BARRA + "." + BARRA + "pipe" + BARRA + "cybersafe-dev-run-d2-teste";
  }

  const svc = new ProtectionEngineService(base);
  // Mesma ordem do bootstrap corrigido (index.ts): gate, init, pedidos. Assim o piso deste
  // teste é o serviço como ele realmente arranca, não uma sequência que já não existe.
  if (dev) installDevFixtureGate(svc, process.env, () => {});
  await svc.init();

  t.after(async () => {
    try { await svc.dispose?.(); } catch {}
    for (const k of chaves) { if (guardado[k] === undefined) delete process.env[k]; else process.env[k] = guardado[k]; }
    await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(fixture, { recursive: true, force: true }).catch(() => {});
  });
  return { svc, fixture };
}

async function iniciarScan(t) {
  const { svc, fixture } = await servoDeVerdade(t);
  const alvo = path.join(fixture, "sub");
  await fsp.mkdir(alvo, { recursive: true });
  for (let i = 0; i < 40; i++) await fsp.writeFile(path.join(alvo, `g-${i}.bin`), Buffer.alloc(64 * 1024, i % 251));
  const r = await svc.handleRequest({ id: "p1", method: "scan.start", payload: { type: "custom", targetPath: fixture } });
  assert.equal(r.ok, true, `scan.start tinha de ser aceite pelo gate: ${JSON.stringify(r.error || r.result)}`);
  const id = typeof r.result === "string" ? r.result : r.result?.id ?? r.result?.scanId;
  assert.ok(UUID.test(String(id)), `scanId tinha de ser UUID, veio: ${JSON.stringify(r.result)}`);
  return { svc, id: String(id) };
}

const cancelar = async (svc, id, reqId = "c1") =>
  svc.handleRequest({ id: reqId, method: "scan.cancel", payload: id === undefined ? {} : { id } });

test("estagios distinguiveis num cancelamento real, por ordem", async (t) => {
  const { svc, id } = await iniciarScan(t);
  const cap = capturar();
  try {
    const resp = await cancelar(svc, id);
    assert.deepEqual(resp, { id: "c1", type: "response", ok: true, result: { success: true } }, "o contrato de resposta não pode mudar");
    for (let i = 0; i < 400 && !cap.cancelamento().some((l) => l.includes("stage=terminal_historico_processado")); i++) await new Promise((r) => setTimeout(r, 25));
    const estagios = cap.cancelamento().map((l) => (l.match(/stage=([a-z_]+)/) || [])[1]);
    assert.ok(estagios.includes("recebido"), `falta recebido: ${JSON.stringify(cap.cancelamento())}`);
    assert.ok(estagios.includes("processado"), "falta processado");
    assert.ok(estagios.includes("terminal_emitido"), "falta terminal_emitido");
    assert.ok(estagios.includes("terminal_historico_processado"), "falta terminal_historico_processado");
    assert.ok(estagios.indexOf("recebido") < estagios.indexOf("processado"), "o handler tem de registar antes do manager");
    assert.ok(estagios.indexOf("processado") < estagios.indexOf("terminal_emitido"), "o processado antecede o terminal");
    assert.ok(cap.cancelamento().every((l) => LINHA.test(l)), `linhas fora da whitelist: ${JSON.stringify(cap.cancelamento().filter((l) => !LINHA.test(l)))}`);
    assert.ok(cap.cancelamento().some((l) => l.includes(`scanId=${id}`) && l.includes("desfecho=cancelado")));
  } finally { cap.restaurar(); }
});

test("o ACK sozinho não prova o terminal: sem scan em curso o desfecho é desconhecido e não há terminal", async (t) => {
  const { svc } = await servoDeVerdade(t);
  const cap = capturar();
  try {
    const resp = await cancelar(svc, "00000000-0000-4000-8000-000000000000");
    // Sem scan em curso nao existe nova cancelacao para aceitar: o ACK e' false,
    // e e' isso que a UI usa para nao anunciar um cancelamento inexistente.
    assert.deepEqual(resp.result, { success: false }, "id desconhecido nao pode ser reportado como cancelacao aceite");
    const linhas = cap.cancelamento();
    assert.ok(linhas.some((l) => l.includes("stage=processado") && l.includes("desfecho=desconhecido")), `esperava desfecho=desconhecido: ${JSON.stringify(linhas)}`);
    assert.ok(!linhas.some((l) => l.startsWith("[ScanCancel] stage=terminal") || l.includes("stage=terminal_")), `desconhecido não pode sintetizar terminal: ${JSON.stringify(linhas)}`);
  } finally { cap.restaurar(); }
});

test("duplo pedido: o segundo é `ja_terminal` e não republica terminal", async (t) => {
  const { svc, id } = await iniciarScan(t);
  const cap = capturar();
  try {
    await cancelar(svc, id, "c1");
    for (let i = 0; i < 400 && !cap.cancelamento().some((l) => l.includes("stage=terminal_historico_processado")); i++) await new Promise((r) => setTimeout(r, 25));
    const antes = cap.cancelamento().filter((l) => l.includes("stage=terminal_")).length;
    assert.ok(antes >= 1, "o primeiro cancelamento tinha de ter chegado ao terminal");
    await cancelar(svc, id, "c2");
    await new Promise((r) => setTimeout(r, 150));
    const linhas = cap.cancelamento();
    assert.ok(linhas.some((l) => l.includes("desfecho=ja_terminal")), `esperava ja_terminal no segundo pedido: ${JSON.stringify(linhas)}`);
    assert.equal(linhas.filter((l) => l.includes("stage=terminal_")).length, antes, "o segundo pedido não pode emitir outro terminal");
  } finally { cap.restaurar(); }
});

test("scanId que não é UUID nunca é ecoado: vai como `invalido`", async (t) => {
  const { svc } = await servoDeVerdade(t);
  const cap = capturar();
  const segredo = "C:\\Users\\algue\\Documents\\segredo.txt";
  try {
    await cancelar(svc, segredo);
    const linhas = cap.cancelamento();
    assert.ok(linhas.length >= 1, "tem de haver registo do pedido");
    assert.ok(linhas.every((l) => l.includes("scanId=invalido")), "id nao-UUID tinha de sair como invalido: " + JSON.stringify(linhas));
    assert.ok(!linhas.some((l) => l.includes(segredo) || l.includes("Users")), "nunca ecoar o valor recebido");
  } finally { cap.restaurar(); }
});

test("payload sem id também é honesto: recebido com scanId=invalido, desfecho desconhecido", async (t) => {
  const { svc } = await servoDeVerdade(t);
  const cap = capturar();
  try {
    const resp = await cancelar(svc, undefined);
    // Sem `id` nao ha nada a cancelar; o ACK nao finge que houve accao (UI-D1).
    assert.deepEqual(resp.result, { success: false }, "pedido sem id nao pode dizer que cancelou");
    const linhas = cap.cancelamento();
    assert.ok(linhas.some((l) => l.includes("stage=recebido") && l.includes("scanId=invalido")), JSON.stringify(linhas));
    assert.ok(linhas.some((l) => l.includes("desfecho=desconhecido")), JSON.stringify(linhas));
  } finally { cap.restaurar(); }
});

test("fora de DEV verificado: zero linhas novas, comportamento idêntico", async (t) => {
  const { svc, id } = await iniciarScanComPortaDesligada(t);
  const cap = capturar();
  try {
    const resp = await cancelar(svc, id);
    assert.deepEqual(resp.result, { success: true }, "a resposta não muda com o registo desligado");
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(cap.cancelamento(), [], `modo desligado não pode registar: ${JSON.stringify(cap.cancelamento())}`);
    const estado = svc.scanManager.getScan(id);
    assert.equal(estado?.status, "cancelled", "cancelar continua a funcionar sem registo novo");
  } finally { cap.restaurar(); }
});

/** Mesmo servo, mas com o gate de fixture NÃO montado: é essa a condição que autoriza o log. */
async function iniciarScanComPortaDesligada(t) {
  const { svc, fixture } = await servoDeVerdade(t, { dev: false });
  const r = await svc.handleRequest({ id: "p1", method: "scan.start", payload: { type: "custom", targetPath: fixture } });
  assert.equal(r.ok, true, "fora da sessão de fixture o scan normal tem de continuar a funcionar");
  const id = typeof r.result === "string" ? r.result : r.result?.id ?? r.result?.scanId;
  assert.ok(UUID.test(String(id)), JSON.stringify(r.result));
  return { svc, id: String(id) };
}

test("isolamento declarado mas gate nao montado nao autoriza registo novo", async (t) => {
  // `servoDeVerdade` nao inicia scan nenhum e nao devolve `id`: usar esse piso
  // deixava este caso a cancelar o nada, e o `cancelamento() === []` seria
  // verdadeiro por vacuidade. Aqui ha um scan a correr, entao o silencio do
  // registo e' o que esta realmente em teste.
  const { svc, id } = await iniciarScan(t);
  // O gate e montado por cima da INSTANCIA (propriedade propria). Apagar essa propriedade e
  // exatamente o estado de quem declara isolamento sem o gate: o readOnly deixa de estar
  // efetivamente forcado, e o registo do cancelamento tem de calar.
  assert.ok(Object.prototype.hasOwnProperty.call(svc.scanManager, "startScan"), "o gate tinha de deixar a sua marca neste piso");
  delete svc.scanManager.startScan;
  const cap = capturar();
  try {
    const resp = await cancelar(svc, id);
    assert.deepEqual(resp.result, { success: true }, "a resposta nao muda quando o registo se cala");
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(cap.cancelamento(), [], "gate nao montado nao pode autorizar registo" + JSON.stringify(cap.cancelamento()));
  } finally { cap.restaurar(); }
});

test("sem a sessao de fixture montada, o isolamento sozinho nao autoriza registo", async (t) => {
  const { svc, id } = await iniciarScan(t);
  process.env[FIXTURE_SCAN_FLAG] = "";
  const cap = capturar();
  try {
    const resp = await cancelar(svc, id);
    assert.deepEqual(resp.result, { success: true }, "o cancelamento de um scan em curso tem de ser aceite mesmo sem registo");
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(cap.cancelamento(), [], "isolamento sem sessao de fixture nao pode autorizar registo" + JSON.stringify(cap.cancelamento()));
  } finally { cap.restaurar(); }
});

test("pipe de outra instancia nao e isolamento deste run", async (t) => {
  const { svc, id } = await iniciarScan(t);
  const BARRA = String.fromCharCode(92);
  process.env.CYBERSAFE_DEV_PIPE_NAME = BARRA + BARRA + "." + BARRA + "pipe" + BARRA + "cybersafe-service";
  const cap = capturar();
  try {
    const resp = await cancelar(svc, id);
    assert.deepEqual(resp.result, { success: true }, "pipe alheio nao pode impedir o cancelamento");
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(cap.cancelamento(), [], "pipe partilhado nao pode autorizar registo" + JSON.stringify(cap.cancelamento()));
  } finally { cap.restaurar(); }
});

test("um scan que conclui nao escreve nenhum estagio de cancelamento", async (t) => {
  const { svc, fixture } = await servoDeVerdade(t);
  const cap = capturar();
  try {
    const r = await svc.handleRequest({ id: "p1", method: "scan.start", payload: { type: "custom", targetPath: fixture } });
    assert.equal(r.ok, true);
    const id = typeof r.result === "string" ? r.result : r.result?.id ?? r.result?.scanId;
    for (let i = 0; i < 1600; i++) {
      const e = svc.scanManager.getScan(String(id));
      if (e && ["completed", "failed", "cancelled"].includes(e.status)) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    const estado = svc.scanManager.getScan(String(id));
    assert.ok(estado && ["completed", "failed"].includes(estado.status), "o scan tinha de terminar sozinho para este caso fazer sentido, ficou: " + String(estado && estado.status));
    assert.deepEqual(cap.cancelamento(), [], "terminal de um scan concluido nao e cancelamento" + JSON.stringify(cap.cancelamento()));
  } finally { cap.restaurar(); }
});


// ————— cada condição de autorização é necessária, não redundante —————
test("sozinho sem NODE_ENV=development nao autoriza registo (o resto esta todo valido)", async (t2) => {
  const { svc, id } = await servoDeVerdade(t2);
  delete process.env.NODE_ENV;
  const cap = capturar();
  try {
    await cancelar(svc, id);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(cap.cancelamento(), [], "NODE_ENV em falta nao pode autorizar registo" + JSON.stringify(cap.cancelamento()));
  } finally { cap.restaurar(); }
});

test("raiz de fixture ilegivel nao autoriza, mesmo com isolamento e gate validos", async (t2) => {
  const { svc, id } = await servoDeVerdade(t2);
  process.env[FIXTURE_ROOT_ENV] = [os.homedir(), "Downloads"].join(path.sep);
  const cap = capturar();
  try {
    await cancelar(svc, id);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(cap.cancelamento(), [], "root de fixture ilegitimo nao pode autorizar registo" + JSON.stringify(cap.cancelamento()));
  } finally { cap.restaurar(); }
});

test("a whitelist do registo nao ecoa estados que nao sejam cancelled", () => {
  const BARRA = String.fromCharCode(92);
  const envOk = {
    NODE_ENV: "development",
    CYBERSAFE_DEV_ISOLATION: "1",
    [FIXTURE_SCAN_FLAG]: "1",
    CYBERSAFE_DEV_PIPE_NAME: BARRA + BARRA + "." + BARRA + "pipe" + BARRA + "cybersafe-dev-run-whitelist",
  };
  // fixtureRootFromEnv e a unica verificacao que precisa de disco: o env explicito abaixo
  // traz um root real criado neste teste, para que so a whitelist esteja em estudo.
  const tmpReal = realFs.realpathSync(os.tmpdir());
  const raiz = realFs.mkdtempSync(tmpReal + path.sep + "cs-d2-wl-");
  try {
    const env = { ...envOk, [FIXTURE_ROOT_ENV]: raiz };
    // O piso autorizado e uma instalacao REAL do gate — a identidade do wrapper registado e
    // que autoriza, nao o texto da funcao. Um wrapper escrito a mão fica no negativo abaixo.
    class SM { async startScan() { return "scan"; } }
    const scanManager = new SM();
    installDevFixtureGate({ handleRequest: async () => ({ ok: true }), scanManager, quarantinePolicy: "warn" }, env, () => {});
    assert.equal(cancelamentoObservavel(scanManager, env), true, "o piso da whitelist tem de estar autorizado");
    const visto = [];
    const originalLog = console.log;
    console.log = (s) => { visto.push(String(s)); };
    try {
      linhaDeCancelamento(scanManager, "terminal_emitido", "00000000-0000-4000-8000-000000000000", { status: "completed" }, env);
      linhaDeCancelamento(scanManager, "terminal_emitido", "00000000-0000-4000-8000-000000000000", { status: "cancelled" }, env);
      linhaDeCancelamento(scanManager, "estagio_inventado", "00000000-0000-4000-8000-000000000000", {}, env);
      linhaDeCancelamento(scanManager, "terminal_persistido", "00000000-0000-4000-8000-000000000000", { status: "cancelled" }, env);
    } finally { console.log = originalLog; }
    assert.equal(visto.length, 2, "estagio conhecido fala, estado fora da lista, nome inventado e estagio que alega gravacao nao: " + JSON.stringify(visto));
    assert.ok(visto.every((l) => LINHA.test(l.trim())), "linha fora da forma whitelistada: " + JSON.stringify(visto));
    assert.ok(!visto[0].includes("status="), "um estado que nao e o terminal de cancelamento nao pode ser ecoado: " + visto[0]);
    assert.ok(visto[1].includes("status=cancelled"), "o estado permitido tem de aparecer: " + visto[1]);
    assert.ok(!visto.some((l) => l.includes("completed")), "nunca ecoar um valor de estado fora da lista");
    assert.ok(!visto.some((l) => l.includes("estagio_inventado")), "um estagio fora da enum nao pode ganhar voz");
    assert.ok(!visto.some((l) => l.includes("persistido")), "nenhuma linha pode alegar gravacao: " + JSON.stringify(visto));
  } finally { realFs.rmSync(raiz, { recursive: true, force: true }); }
});

test("wrapper artesanal com readOnly no texto nao autoriza registo (identidade, nao palavra)", () => {
  const BARRA = String.fromCharCode(92);
  const tmpReal = realFs.realpathSync(os.tmpdir());
  const raiz = realFs.mkdtempSync(tmpReal + path.sep + "cs-d2-fake-");
  try {
    const env = {
      NODE_ENV: "development",
      CYBERSAFE_DEV_ISOLATION: "1",
      [FIXTURE_SCAN_FLAG]: "1",
      [FIXTURE_ROOT_ENV]: raiz,
      CYBERSAFE_DEV_PIPE_NAME: BARRA + BARRA + "." + BARRA + "pipe" + BARRA + "cybersafe-dev-run-fake",
    };
    class SM { async startScan() { return "scan"; } }
    const sm = new SM();
    const original = sm.startScan.bind(sm);
    sm.startScan = (type, target, options) => original(type, target, { ...(options || {}), readOnly: true });
    assert.ok(String(sm.startScan).includes("readOnly"), "o piso tem de conter a palavra que a prova antiga media");
    const visto = [];
    const originalLog = console.log;
    console.log = (s) => { visto.push(String(s)); };
    try {
      assert.equal(cancelamentoObservavel(sm, env), false, "so o modulo de instalacao registra o gate");
      linhaDeCancelamento(sm, "recebido", "00000000-0000-4000-8000-000000000000", {}, env);
    } finally { console.log = originalLog; }
    assert.deepEqual(visto, [], "registo nao autorizado nao pode escrever uma linha: " + JSON.stringify(visto));
  } finally { realFs.rmSync(raiz, { recursive: true, force: true }); }
});

// ————— D2 (review): «processado» nao é «persistido» —————

test("nenhum estagio do registo alega persistencia, e nao ha ramo de falha inalcançavel", () => {
  const fonte = realFs.readFileSync(new URL("../dist/scan-manager.js", import.meta.url), "utf8");
  assert.ok(
    fonte.includes("terminal_historico_processado"),
    "o estagio tem de dizer que a cadeia do historico processou a tentativa, nao que gravou",
  );
  assert.ok(!fonte.includes("terminal_persistido"), "«persistido» e uma alegacao que o record absorvido nao autoriza");
  assert.ok(!fonte.includes("terminal_registro_falhou"), "o ramo de falha e inalcançavel: nao pode existir como prova");
});

test("historico com o append a falhar nao produz nenhuma alegacao de gravacao (servico real)", async (t) => {
  const { svc, fixture } = await servoDeVerdade(t);
  // O ScanHistory real absorve a falha e resolve (scan-history.ts: tenta, apanha, resolve).
  // Tornar essa falha efetiva sem alterar o contrato: apontar o caminho para um diretório
  // inexistente. O `record` continua a resolver — e é exatamente isso que o estagio nao pode
  // ler como «gravado».
  const historico = svc.scanManager["history"];
  assert.ok(historico && typeof historico.record === "function", "o manager real tem de ter historico para este caso fazer sentido");
  const caminhoReal = historico.filePath;
  historico.filePath = path.join(realFs.realpathSync(os.tmpdir()), `cs-d2-nao-existe-${Date.now()}`, "scans.jsonl");

  const start = await svc.handleRequest({ id: "p1", method: "scan.start", payload: { type: "custom", targetPath: fixture } });
  assert.equal(start.ok, true, JSON.stringify(start.error));
  const id = typeof start.result === "string" ? start.result : start.result?.id ?? start.result?.scanId;

  const cap = capturar();
  try {
    const cancel = await cancelar(svc, id);
    assert.deepEqual(cancel.result, { success: true }, "o contrato de resposta nao muda");
    for (let i = 0; i < 400 && !cap.cancelamento().some((l) => l.includes("stage=terminal_historico_processado")); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const linhas = cap.cancelamento();
    assert.ok(linhas.some((l) => l.includes("stage=terminal_historico_processado")), "a cadeia processou e deve ser dita como o que e: " + JSON.stringify(linhas));
    assert.ok(!linhas.some((l) => /persistido|gravado|registro_falhou/.test(l)), "nenhuma linha pode alegar gravacao: " + JSON.stringify(linhas));
    assert.ok(linhas.every((l) => LINHA.test(l)), "forma whitelistada: " + JSON.stringify(linhas.filter((l) => !LINHA.test(l))));
    assert.equal(svc.scanManager.getScan(String(id))?.status, "cancelled", "o estado terminal em memoria nao depende do registo");
  } finally {
    cap.restaurar();
    historico.filePath = caminhoReal;
  }
});
