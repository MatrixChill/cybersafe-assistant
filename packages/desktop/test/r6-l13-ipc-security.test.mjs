import { registerAiCredentialsIpc } from "../src/ai-credentials-ipc.ts";
import { registerProcessTerminationIpc } from "../src/process-termination-ipc.ts";
import { registerAuthSessionIpc } from "../src/auth-session-ipc.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { trustedIpcHandler, guardedServiceRequest, reportWindowPreferences } from "../src/ipc-guard.ts";

// Execute actual registration/preload code with dependency doubles only.
// Never import main.ts, start Electron, access the service or change Windows.
const mainSource = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const preloadSource = fs.readFileSync(new URL("../src/preload.ts", import.meta.url), "utf8");
const mainAst = ts.createSourceFile("main.ts", mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const registerNode = mainAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "registerIpc");
assert.ok(registerNode, "actual registerIpc must exist");
const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture(packaged = false) {
  const handlers = new Map();
  const effects = [];
  const directory = path.resolve("r6-l13-synthetic-install", "dist");
  const expected = packaged ? pathToFileURL(path.join(directory, "index.html")).href : "http://localhost:5173/";
  const frame = { url: expected };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const sandbox = {
    ipcRegistered: false, isQuitting: false,
    ipcMain: { handle(channel, handler) { assert.ok(!handlers.has(channel)); handlers.set(channel, handler); } },
    mainWindow: { webContents: contents },
    app: { isPackaged: packaged, setLoginItemSettings(config) { effects.push(["settings", config]); } },
    process: { platform: "win32", execPath: "r6-l13-fixture.exe" },
    path, pathToFileURL, __dirname: directory,
    trustedIpcHandler, guardedServiceRequest, reportWindowPreferences, registerAuthSessionIpc,
    registerAiCredentialsIpc, registerProcessTerminationIpc,
    currentAiStore: () => { throw new Error("credential access outside fixture scope"); },
    authStore: { read() { effects.push(["auth-read"]); return null; }, write() { effects.push(["auth-write"]); }, clear() { effects.push(["auth-clear"]); } },
    client: { isConnected: true, request(topic, payload) { effects.push([topic, payload]); return Promise.resolve({success:true}); } },
    preferences: { notificationsEnabled: true },
    savePreferences() { effects.push(["savePreferences"]); },
  };
  vm.createContext(sandbox);
  vm.runInContext(compile(registerNode.getText(mainAst)) + "\nregisterIpc(undefined, undefined, (handle) => registerAuthSessionIpc(handle, () => authStore));", sandbox, {timeout:1000});
  return { handlers, effects, frame, contents, expected, sandbox, event: {sender:contents, senderFrame:frame} };
}

function bridge(f, event = f.event) {
  const listeners = new Map();
  let api;
  const exposed = [];
  const sandbox = {
    require(name) {
      assert.equal(name, "electron", "preload may only load its explicit Electron dependency");
      return {
        contextBridge: { exposeInMainWorld(name, value) { exposed.push(name); api = value; } },
        ipcRenderer: {
          invoke(channel, ...args) {
            const handler = f.handlers.get(channel);
            assert.ok(handler, `unknown IPC channel: ${channel}`);
            return Promise.resolve().then(() => handler(event, ...structuredClone(args)));
          },
          on(channel, listener) { listeners.set(channel, listener); },
          removeListener(channel, listener) { assert.equal(listeners.get(channel), listener); listeners.delete(channel); },
        },
        webUtils: { getPathForFile(file) { assert.equal(file.fixtureFile, true); return "fixture-only-path"; } },
      };
    },
    process: { env: {} }, console,
  };
  vm.runInNewContext(compile(preloadSource), sandbox, {timeout:1000});
  assert.deepEqual(exposed, ["electronAPI"]);
  return { api, listeners };
}

const maliciousUrls = [
  "https://attacker.invalid/", "http://localhost:5173.attacker.invalid/",
  "http://localhost:5173@attacker.invalid/", "http://127.0.0.1:5173/",
  "http://localhost:5173/?source=attacker", "http://localhost:5173/other",
  "https://localhost:5173/", "data:text/html,<script>fixture</script>",
  "blob:http://localhost:5173/fixture", "about:blank", "javascript:void(0)",
  "devtools://devtools/bundled/inspector.html", "", "not-a-url",
];
for (const packaged of [false, true]) {
  test(`${packaged ? "packaged" : "DEV"}: every actual handler rejects remote documents before effects`, () => {
    const f = fixture(packaged);
    // 36 canais revistos originalmente + service:get-last-scan (R7-L1/L2)
    // + service:get-scan-history e app:export-pdf (R7-L3)
    // + service:get-usb-protection e service:configure-usb-protection (R8 USB)
    // + app:set-titlebar-overlay (barra de janela, 14/10).
    // + service:usb-scan e service:usb-cancel (manual consentido, 15/10).
    // + 7 canais de actualização da app: app:update-check, app:update-get-snapshot,
    //   app:update-download, app:update-install, app:update-defer, app:update-cancel,
    //   app:update-set-automatic (launcher de update, reconciliado a 19/10 — ledger
    //   verificado contra `registerIpc()` real, não contra memória).
    // + service:get-protection-intent e service:set-protection-intent (intenção de
    //   proteção persistida no serviço, 19/10).
    // Qualquer mudança de superfície passa por esta auditoria.
    // + service:get-definitions-status (estado das definicoes de seguranca por fonte,
    //   leitura sem efeito; revisado a 2026-11-01 junto com o contrato `definitions.status`).
    // Six additional guarded channels: three AI credentials and three protected termination.
    assert.equal(f.handlers.size, 64, "audit covers every currently registered channel; review any surface change");
    assert.ok(f.handlers.has("app:update-reveal")); // folder reveal: same trusted document guard
    assert.ok(f.handlers.has("service:usb-scan"));
    assert.ok(f.handlers.has("service:usb-cancel"));
    // + auth-session read/write/clear: same sender/document guard, no new registrar.
    for (const name of ["auth-session:read", "auth-session:write", "auth-session:clear"]) assert.ok(f.handlers.has(name));
    for (const url of [...maliciousUrls, pathToFileURL(path.resolve("r6-l13-synthetic-install", "report.html")).href]) {
      f.frame.url = url;
      for (const [channel, handler] of f.handlers) {
        assert.throws(() => handler(f.event, "fixture-argument"), error => {
          assert.equal(error.message, "Emissor IPC não autorizado", channel);
          return true;
        });
      }
    }
    assert.equal(f.effects.length, 0);
  });
  test(`${packaged ? "packaged" : "DEV"}: other window/subframe/missing frame/destroyed sender rejected`, () => {
    const f = fixture(packaged);
    const events = [
      {sender:{...f.contents}, senderFrame:f.frame},
      {sender:f.contents, senderFrame:{url:f.expected}},
      {sender:f.contents, senderFrame:null},
      {sender:f.contents, senderFrame:undefined},
    ];
    for (const handler of f.handlers.values()) {
      for (const event of events) assert.throws(() => handler(event), /Emissor IPC não autorizado/);
    }
    f.contents.isDestroyed = () => true;
    for (const handler of f.handlers.values()) assert.throws(() => handler(f.event), /Emissor IPC não autorizado/);
    assert.equal(f.effects.length, 0);
  });
  test(`${packaged ? "packaged" : "DEV"}: valid main document with SPA fragment forwards sensitive calls`, async () => {
    const f = fixture(packaged);
    f.frame.url += "#/settings";
    const {api} = bridge(f);
    await api.killProcessTree(424242);
    await api.restoreQuarantine("fixture-quarantine-id", false);
    await api.allowHash("a".repeat(64));
    assert.deepEqual(f.effects.map(([topic]) => topic), ["process.killTree", "quarantine.restore", "trust.allowHash"]);
  });
}

test("actual preload has no arbitrary invoke/send/require/IPC-event escape", () => {
  const {api, listeners} = bridge(fixture());
  for (const key of ["invoke", "send", "sendSync", "ipcRenderer", "require", "executeJavaScript", "on"]) {
    assert.ok(!Object.hasOwn(api, key), `raw capability exposed: ${key}`);
  }
  let received;
  const unsubscribe = api.onSecurityEvent((...args) => { received = args; });
  const privilegedEvent = {sender:{fixturePrivileged:true}};
  const payload = {type:"fixture-security-event"};
  listeners.get("service:event")(privilegedEvent, payload);
  assert.equal(received.length, 1);
  assert.equal(received[0], payload);
  unsubscribe();
  // O único listener que resta é o cache de entrega do tray
  // (app:scan-session, registado a nível de módulo pelo R7-L1/L2):
  // nenhum outro listener de eventos IPC escapa à bridge.
  assert.deepEqual([...listeners.keys()], ["app:scan-session"]);
});

test("remote main-frame document cannot use sensitive methods exposed by the actual preload", async () => {
  const f = fixture();
  f.frame.url = "https://attacker.invalid/";
  const {api} = bridge(f);
  for (const call of [
    () => api.killProcessTree(424242), () => api.restoreQuarantine("fixture-id", true),
    () => api.allowHash("a".repeat(64)), () => api.setAutoStart({enabled:true,startMinimized:true}),
    () => api.openReportWindow("<p>fixture</p>"), () => api.openFileDialog(),
  ]) await assert.rejects(call(), /Emissor IPC não autorizado/);
  assert.equal(f.effects.length, 0);
});

test("prototype keys in IPC arguments do not pollute prototypes at tested desktop boundary", async () => {
  const f = fixture();
  const {api} = bridge(f);
  const payload = JSON.parse('{"limit":5,"__proto__":{"r6l13Polluted":true},"constructor":{"prototype":{"r6l13Polluted":true}},"enabled":true,"startMinimized":false}');
  assert.equal(Object.prototype.r6l13Polluted, undefined);
  await api.getSecurityEvents(payload);
  await api.setAutoStart(payload);
  assert.equal(Object.prototype.r6l13Polluted, undefined);
  assert.equal(vm.runInContext("Object.prototype.r6l13Polluted", f.sandbox), undefined);
  assert.equal(f.effects[0][0], "events.list");
  assert.ok(Object.hasOwn(f.effects[0][1], "__proto__"), "arguments are forwarded, not claimed to be sanitized");
  const settings = f.effects[1][1];
  assert.deepEqual(Object.keys(settings).sort(), ["args", "openAtLogin", "path"]);
  assert.equal(settings.r6l13Polluted, undefined);
});

test("actual main source has one guarded registration path, no unguarded IPC listeners", () => {
  const registrations = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(mainAst) === "ipcMain") {
      registrations.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(mainAst);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].expression.name.text, "handle");
  assert.ok(ts.isCallExpression(registrations[0].arguments[1]));
  assert.equal(registrations[0].arguments[1].expression.getText(mainAst), "trustedIpcHandler");
});

test("report window has no privileged preload; missing main window fails closed", () => {
  const options = reportWindowPreferences();
  assert.equal(options.preload, undefined);
  assert.equal(options.nodeIntegration, false);
  assert.equal(options.contextIsolation, true);
  assert.equal(options.sandbox, true);
  let effects = 0;
  const handler = trustedIpcHandler(() => null, () => "http://localhost:5173/", () => effects++);
  assert.throws(() => handler({sender:{},senderFrame:{url:"http://localhost:5173/"}}), /Emissor IPC não autorizado/);
  assert.equal(effects, 0);
});
test("preload surface is explicitly limited to the 57 reviewed capabilities", () => {
  const {api} = bridge(fixture());
  // 52 revistas originalmente + getProtectionIntent/setProtectionIntent (intenção de
  // proteção, 19/10) + appUpdate (objecto de actualização da app, 19/10). O sub-objecto
  // é auditado à parte abaixo: contar `appUpdate` como capacidade e não verificar as
  // suas 8 chaves seria um ledger mais fraco do que antes.
  const expected = "aiCredentials,prepareProcessTermination,confirmProcessTermination,cancelProcessTermination,beginShutdown,getProtectionState,setProtection,pauseProtection,getServiceConnectionState,onServiceConnectionState,getSecurityEvents,getThreatEvents,getProcesses,getConnections,getQuarantineFiles,clearThreatEvents,scanFile,scanFullSystem,killProcessTree,analyzeProcess,getHardwareSnapshot,getWindowsHealth,getPCState,restoreQuarantine,deleteQuarantine,allowHash,allowPublisher,runRestrictedAnalysis,updateDefinitions,getDefinitionsStatus,startScan,getActiveScan,getLastScan,getScanHistory,cancelScan,threatAction,openFileDialog,getPathForFile,openFolderDialog,onSecurityEvent,onScanProgress,onScanSession,onExitConfirmRequest,respondExitConfirm,ackExitConfirm,onNavigateRequest,getAutoStart,setAutoStart,getNotificationsEnabled,setNotificationsEnabled,setTitleBarOverlay,openReportWindow,exportReportPdf,getUsbProtection,configureUsbProtection,usbScan,usbCancel,getProtectionIntent,setProtectionIntent,appUpdate,authSession".split(",");
  assert.deepEqual(Object.keys(api).sort(), expected.sort());
  for (const [nome, method] of Object.entries(api)) {
    if (nome === "appUpdate" || nome === "authSession" || nome === "aiCredentials") continue;
    assert.equal(typeof method, "function", `${nome} tem de continuar a ser uma função`);
  }
  assert.deepEqual(Object.keys(api.appUpdate).sort(),
    "cancel,check,defer,download,getSnapshot,install,onState,revealDownload,setAutomaticCheck".split(",").sort());
  for (const method of Object.values(api.appUpdate)) assert.equal(typeof method, "function");
  assert.deepEqual(Object.keys(api.authSession).sort(), ["clear", "read", "write"]);
  for (const method of Object.values(api.authSession)) assert.equal(typeof method, "function");
  assert.deepEqual(Object.keys(api.aiCredentials).sort(), ["clear", "getStatus", "save"]);
  for (const method of Object.values(api.aiCredentials)) assert.equal(typeof method, "function");
});