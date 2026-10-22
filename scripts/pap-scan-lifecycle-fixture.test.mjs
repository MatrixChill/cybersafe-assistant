/**
 * TP-RESUME-SCAN-DRIVER — regressao deterministica do ciclo scanner no limite IPC.
 *
 * Porque existe: a cobertura existente e forte em tres camadas — regras puras
 * (`packages/app/test/scan-session.test.ts`), runtime do serviço
 * (`packages/service/test/scan-*.test.js`) e a ponte real preload/main para
 * `getLast` + adoção por tray (`packages/service/test/r7-l1-l2-ipc.test.js`).
 * Ficava por cobrir o caminho de CANCELAMENTO e das FALHAS atraves da ponte
 * real: `cancelScan` (topico `scan.cancel`), `getActiveScan`
 * (`scan.getActive`) e a entrega `app:scan-session` com `filesInconclusive` /
 * `error`. Uma regressao que engolisse estas rejeicoes faria a UI dizer
 * "cancelamento pedido" sem o motor ter recebido nada — o oposto da promessa.
 *
 * Como: usa a implementação REAL (transpilada em memoria: `ipc-guard.ts`,
 * `preload.ts`, `registerIpc` extraido do `main.ts` por AST) com o transporte
 * stubado. Sem Electron, sem serviço, sem scan real, sem rede, sem ficheiros.
 * Nenhum produto e alterado.
 *
 * Correr da raiz do repo:
 *   node --test scripts/pap-scan-lifecycle-fixture.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const REPO_ROOT = new URL("..", import.meta.url);
const read = (name) => fs.readFile(new URL(`packages/desktop/src/${name}`, REPO_ROOT), "utf8");
const compile = (source, module = ts.ModuleKind.CommonJS) =>
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module } }).outputText;
const load = async (name) =>
  import(
    `data:text/javascript;base64,${Buffer.from(compile(await read(name), ts.ModuleKind.ES2022)).toString("base64")}`
  );

const { trustedIpcHandler, guardedServiceRequest, reportWindowPreferences } = await load("ipc-guard.ts");
const mainSource = await read("main.ts");
const mainAst = ts.createSourceFile("main.ts", mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const extractFunction = (name) =>
  mainAst.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(mainAst);
const preloadSource = await read("preload.ts");

/**
 * Ponte real (preload + registerIpc) com transporte stubado.
 * `client.request` e injetavel por teste — e a unica fronteira stubada.
 */
function fixture({ request } = {}) {
  const handlers = new Map();
  const effects = [];
  const listeners = new Map();
  const frame = { url: "http://localhost:5173/" };
  const sent = [];
  const contents = { mainFrame: frame, isDestroyed: () => false, send: (...args) => sent.push(args) };
  const client = {
    request: async (topic, payload) => {
      effects.push([topic, payload]);
      if (request) return request(topic, payload);
      return { success: true };
    },
  };
  const sandbox = {
    ipcRegistered: false,
    isQuitting: false,
    console,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    mainWindow: { webContents: contents },
    app: { isPackaged: false },
    process: { platform: "win32" },
    path,
    pathToFileURL,
    __dirname: "fixture-only",
    trustedIpcHandler,
    guardedServiceRequest,
    reportWindowPreferences,
    client,
  };
  vm.runInNewContext(`${compile(extractFunction("registerIpc"))}\nregisterIpc();`, sandbox);

  const event = { sender: contents, senderFrame: frame };
  let api;
  vm.runInNewContext(compile(preloadSource), {
    queueMicrotask,
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      webUtils: {},
      ipcRenderer: {
        invoke: (name, ...args) => Promise.resolve().then(() => handlers.get(name)(event, ...args)),
        on: (name, callback) => listeners.set(name, callback),
        removeListener: (name) => listeners.delete(name),
      },
    }),
  });
  return { api, effects, listeners, sent };
}

test("cancelar atravessa a ponte real: topico scan.cancel com o id, resposta passada tal como veio", async () => {
  const f = fixture({ request: (topic) => (topic === "scan.cancel" ? { success: true } : null) });
  const result = await f.api.cancelScan("fixture-id");
  assert.deepEqual(result, { success: true });
  assert.deepEqual(JSON.parse(JSON.stringify(f.effects)), [["scan.cancel", { id: "fixture-id" }]]);
  assert.ok(!f.effects.some(([topic]) => topic === "scan.start"), "cancelar nunca inicia um scan");
});

test("falha do servico ao cancelar chega ao renderer como rejeicao real (nunca sucesso fingido)", async () => {
  const f = fixture({
    request: (topic) => {
      if (topic === "scan.cancel") throw new Error("Servico indisponivel (fixture)");
      return null;
    },
  });
  await assert.rejects(f.api.cancelScan("fixture-id"), /Servico indisponivel \(fixture\)/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.effects)), [["scan.cancel", { id: "fixture-id" }]]);
  assert.equal(f.sent.length, 0, "nenhum evento de sessao e inventado numa falha de cancelamento");
});

test("falha de ressincronizacao (scan.getActive) propaga — a pagina pode dizer a verdade, nao um 'sem dados' falso", async () => {
  const f = fixture({
    request: (topic) => {
      if (topic === "scan.getActive") throw new Error("Ligacao ao servico perdida (fixture)");
      return null;
    },
  });
  await assert.rejects(f.api.getActiveScan(), /Ligacao ao servico perdida \(fixture\)/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.effects)), [["scan.getActive", null]]);
});

test("entrega app:scan-session preserva os factos: inconclusivos e erro chegam intactos ao subscritor", async () => {
  const f = fixture({ request: () => null });
  const received = [];
  const unsubscribe = f.api.onScanSession((delivery) => received.push(delivery));
  await new Promise((resolve) => queueMicrotask(resolve));

  const terminal = {
    state: {
      id: "fixture-id",
      status: "completed",
      analysisState: "inconclusive",
      filesInconclusive: 3,
      filesScanned: 120,
      threatsFound: 1,
    },
  };
  f.listeners.get("app:scan-session")({ sender: "fora-do-main" }, terminal);
  const failure = { error: "Falha do motor (fixture)" };
  f.listeners.get("app:scan-session")({ sender: "fora-do-main" }, failure);

  assert.equal(received.length, 2);
  assert.deepEqual(received[0], terminal, "os contadores inconclusivos chegam sem perda");
  assert.deepEqual(received[1], failure, "a entrega de erro chega sem reinterpretacao");
  unsubscribe();
});
