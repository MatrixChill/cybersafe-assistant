/**
 * R8 — IPC DA PROTECAO USB (desktop: main + preload).
 *
 * Contrato (R8-USB-CONTRACT-CODEX-2026-10-12.md):
 *  - `usb.getState` (undefined) e `usb.configure` ({enabled:boolean}) com
 *    validacao ESTRITA.
 *  - "Nenhum root/caminho vindo do renderer aceito para auto-scan": o unico
 *    payload aceite tem exactamente uma chave booleana.
 *  - Guard sender/origin e autenticacao do named-pipe mantidos: um emissor
 *    remoto e' negado SEM efeitos.
 *
 * Executa o `registerIpc()` REAL de main.ts e o preload REAL num sandbox vm
 * com dublês (o mesmo metodo do r6-l13): nada de Electron, nada de serviço,
 * nada de Windows.
 *
 * Uso: node --test packages/desktop/test/r8-usb-ipc.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { trustedIpcHandler, guardedServiceRequest, reportWindowPreferences } from "../src/ipc-guard.ts";

const mainSource = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const preloadSource = fs.readFileSync(new URL("../src/preload.ts", import.meta.url), "utf8");
const mainAst = ts.createSourceFile("main.ts", mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const registerNode = mainAst.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "registerIpc",
);
assert.ok(registerNode, "registerIpc tem de existir em main.ts");

const compile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;

const CANAL_ESTADO = "service:get-usb-protection";
const CANAL_CONFIG = "service:configure-usb-protection";
const CANAL_SCAN = "service:usb-scan";
const CANAL_CANCEL = "service:usb-cancel";

/**
 * Os payloads atravessam o sandbox vm, logo trazem outro `Object.prototype`:
 * comparam-se por estrutura serializada, nao por deepStrictEqual (que exige
 * prototipos iguais e falharia por um motivo que nada tem a ver com o canal).
 */
const efeitos = (f) => JSON.stringify(f.effects);

function fixture() {
  const handlers = new Map();
  const effects = [];
  const directory = path.resolve("r8-usb-synthetic-install", "dist");
  const expected = "http://localhost:5173/";
  const frame = { url: expected };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const sandbox = {
    ipcRegistered: false,
    isQuitting: false,
    ipcMain: {
      handle(channel, handler) {
        assert.ok(!handlers.has(channel), `canal registado duas vezes: ${channel}`);
        handlers.set(channel, handler);
      },
    },
    mainWindow: { webContents: contents },
    app: { isPackaged: false, setLoginItemSettings() {} },
    process: { platform: "win32", execPath: "r8-usb-fixture.exe" },
    path,
    pathToFileURL,
    __dirname: directory,
    trustedIpcHandler,
    guardedServiceRequest,
    reportWindowPreferences,
    client: {
      isConnected: true,
      request(topic, payload) {
        effects.push([topic, payload]);
        return Promise.resolve({ success: true });
      },
    },
    preferences: { notificationsEnabled: true },
    savePreferences() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(`${compile(registerNode.getText(mainAst))}\nregisterIpc();`, sandbox, { timeout: 1000 });
  return { handlers, effects, frame, contents, event: { sender: contents, senderFrame: frame } };
}

function bridge(f, event = f.event) {
  let api;
  const sandbox = {
    require(name) {
      assert.equal(name, "electron", "o preload só pode carregar a dependência Electron explícita");
      return {
        contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
        ipcRenderer: {
          invoke(channel, ...args) {
            const handler = f.handlers.get(channel);
            assert.ok(handler, `canal IPC sem handler: ${channel}`);
            return Promise.resolve().then(() => handler(event, ...structuredClone(args)));
          },
          on() {},
          removeListener() {},
        },
        webUtils: { getPathForFile: () => null },
      };
    },
    process: { env: {} },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(compile(preloadSource), sandbox, { timeout: 1000 });
  return api;
}

test("as duas pontas existem: canais registados no main e métodos expostos no preload", () => {
  const f = fixture();
  assert.ok(f.handlers.has(CANAL_ESTADO), "service:get-usb-protection tem de estar registado");
  assert.ok(f.handlers.has(CANAL_CONFIG), "service:configure-usb-protection tem de estar registado");
  assert.ok(f.handlers.has(CANAL_SCAN), "service:usb-scan tem de estar registado");
  assert.ok(f.handlers.has(CANAL_CANCEL), "service:usb-cancel tem de estar registado");
  const api = bridge(f);
  assert.equal(typeof api.getUsbProtection, "function");
  assert.equal(typeof api.configureUsbProtection, "function");
  assert.equal(typeof api.usbScan, "function");
  assert.equal(typeof api.usbCancel, "function");
});

test("leitura: getUsbProtection() pede usb.getState sem payload", async () => {
  const f = fixture();
  const api = bridge(f);
  await api.getUsbProtection();
  assert.equal(efeitos(f), JSON.stringify([["usb.getState", undefined]]));
});

test("opt-in: configureUsbProtection({enabled:true}) envia SÓ {enabled:true}", async () => {
  const f = fixture();
  const api = bridge(f);
  await api.configureUsbProtection({ enabled: true });
  assert.equal(efeitos(f), JSON.stringify([["usb.configure", { enabled: true }]]));
});

test("BITE: payload inválido é recusado sem NENHUM pedido ao serviço", async () => {
  const invalidos = [
    "sim",
    "true",
    1,
    null,
    undefined,
    [],
    [{ enabled: true }],
    {},
    { enabled: "true" },
    { enabled: 1 },
    { enabled: true, rootPath: "E:\\" },
    { enabled: true, targetPath: "E:\\" },
    { enabled: false, extra: 1 },
  ];
  for (const payload of invalidos) {
    const f = fixture();
    const api = bridge(f);
    await assert.rejects(
      () => api.configureUsbProtection(payload),
      /Pedido USB inválido/,
      `payload ${JSON.stringify(payload)} devia ser recusado`,
    );
    assert.equal(efeitos(f), "[]", `payload ${JSON.stringify(payload)} não pode chegar ao serviço`);
  }
});

test("a ponte não expõe nenhuma superfície que aceite uma raiz do renderer", () => {
  const api = bridge(fixture());
  const suspeitos = Object.keys(api).filter((chave) => /usb/i.test(chave));
  assert.deepEqual(
    suspeitos.sort(),
    ["configureUsbProtection", "getUsbProtection", "usbCancel", "usbScan"],
    "exactamente as quatro entradas USB do contrato — nenhuma aceita caminho",
  );
});

// ── Análise MANUAL (`usb.scan` / `usb.cancel`), contrato ratificado ───────────

test("scan manual: usbScan({deviceId,requestId,consent:true}) chega como usb.scan com SÓ esses campos", async () => {
  const f = fixture();
  const api = bridge(f);
  await api.usbScan({ deviceId: "usb-serial-1", requestId: "gesto-1", consent: true });
  assert.equal(
    efeitos(f),
    JSON.stringify([["usb.scan", { deviceId: "usb-serial-1", requestId: "gesto-1", consent: true }]]),
  );
});

test("cancelamento: usbCancel({deviceId,scanId}) chega como usb.cancel com SÓ esses campos", async () => {
  const f = fixture();
  const api = bridge(f);
  await api.usbCancel({ deviceId: "usb-serial-1", scanId: "scan-7" });
  assert.equal(efeitos(f), JSON.stringify([["usb.cancel", { deviceId: "usb-serial-1", scanId: "scan-7" }]]));
});

test("BITE scan: um camino/raiz extra NUNCA atravessa a ponte", async () => {
  const f = fixture();
  const api = bridge(f);
  await api.usbScan({ deviceId: "usb-serial-1", requestId: "gesto-1", consent: true, rootPath: "E:\\" });
  const [, payload] = JSON.parse(efeitos(f))[0];
  assert.deepEqual(Object.keys(payload).sort(), ["consent", "deviceId", "requestId"], "nenhum caminho atravessa");
  assert.equal(payload.rootPath, undefined);
});

test("BITE cancel: um camino/raiz extra NUNCA atravessa a ponte", async () => {
  const f = fixture();
  const api = bridge(f);
  await api.usbCancel({ deviceId: "usb-serial-1", scanId: "scan-7", rootPath: "E:\\" });
  const [, payload] = JSON.parse(efeitos(f))[0];
  assert.deepEqual(Object.keys(payload).sort(), ["deviceId", "scanId"], "nenhum caminho atravessa");
});

test("scan manual: payload inválido devolve recusa explícita sem pedido ao serviço", async () => {
  const casos = ["sim", 1, null, undefined, [], { deviceId: "usb-1" }, { consent: false, deviceId: "usb-1", requestId: "g" }, { consent: true, deviceId: "", requestId: "g" }];
  for (const payload of casos) {
    const f = fixture();
    const result = await bridge(f).usbScan(payload);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
    assert.equal(efeitos(f), "[]");
  }
});

test("cancelamento inválido não atravessa o IPC nem cancela outra sessão", async () => {
  for (const payload of [null, {}, [], { deviceId: "usb-1" }, { deviceId: "usb-1", scanId: 7 }, { deviceId: "", scanId: "scan-1" }]) {
    const f = fixture();
    const result = await bridge(f).usbCancel(payload);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
    assert.equal(efeitos(f), "[]");
  }
});

test("emissor remoto é negado nos dois canais, sem efeitos", () => {
  const f = fixture();
  f.frame.url = "https://attacker.invalid/";
  for (const canal of [CANAL_ESTADO, CANAL_CONFIG, CANAL_SCAN, CANAL_CANCEL]) {
    assert.throws(
      () => f.handlers.get(canal)(f.event, { enabled: true }),
      /Emissor IPC não autorizado/,
    );
  }
  assert.equal(efeitos(f), "[]");
});
