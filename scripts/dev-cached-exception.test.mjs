// TP-CACHED-DEV-EXCEPTION — regressão do contrato da exceção DEV opt-in.
// Prova o que foi decidido: sem flag nada muda; com flag, a única coisa tolerada é o
// filho `service` terminar DEPOIS da readiness completa. Antes da readiness é fatal,
// qualquer outro filho é fatal, e o cleanup acontece sempre.
// Corre sem Electron, sem aplicações e sem ports: só processos/transporte fingidos,
// com o MESMO contrato de deps que `realDeps()` usa (probeHttp => {status,contentType,body}).
// node scripts/dev-cached-exception.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { buildPlan, renderPlan, run } from "./dev-isolated-run.mjs";

// O binário do desktop é resolvido por `requireElectron`; aqui é o node do teste, por
// isso a criança é reconhecida pelo `--user-data-dir=` que só a etapa desktop leva.
const nome = (cmd = "", args = []) => {
  const s = [cmd, ...args].join(" ");
  if (/dev:service/.test(s)) return "service";
  if (/dev:api/.test(s)) return "api";
  if (/--user-data-dir=/.test(s)) return "desktop";
  if (/@cybersafe\/app|vite/.test(s)) return "app";
  return "outro";
};

function harness({ flag, antesDaReadiness = false, sair = "service" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-cached-test-"));
  const logs = [];
  const children = new Map();
  const fired = new Set();
  const fire = (n) => {
    const c = children.get(n);
    if (!c || fired.has(n)) return;
    fired.add(n);
    c.emit("exit", 3);
  };
  const deps = {
    log: (s) => logs.push(String(s)),
    execPath: process.execPath,
    pid: process.pid,
    platform: process.platform,
    tmpdir: () => os.tmpdir(),
    homedir: () => os.homedir(),
    mkdtempSync: (p) => fs.mkdtempSync(p),
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p, e) => fs.readFileSync(p, e),
    writeFileSync: (p, d) => fs.writeFileSync(p, d),
    mkdirSync: (p, o) => fs.mkdirSync(p, o),
    rmSync: (p, o) => fs.rmSync(p, o),
    readdirSync: (p) => fs.readdirSync(p),
    statSync: (p) => fs.statSync(p),
    lstatSync: (p) => fs.lstatSync(p),
    realpathSync: (p) => fs.realpathSync(p),
    isAlive: () => false,
    execFileSync: () => "",
    spawnSync: () => ({ status: 0, stdout: "" }),
    probeTcp: async () => false,
    probePipe: async () => true,
    requireElectron: () => process.execPath,
    // O kill confirma a morte: dispara o `exit` real que o cleanup exige como prova.
    killTree: (pid, child) => {
      if (child && typeof child.emit === "function" && !child.emited) { child.emited = true; child.emit("exit", 3); }
      return Promise.resolve({ ok: true, code: 0 });
    },
    probeHttp: async (url) => {
      // Antes da readiness completa o serviço morre AINDA na sonda de health, e a
      // partir daí deixa de responder: o Electron nunca pode ser lançado.
      if (antesDaReadiness && /\/health/.test(url)) { fire(sair); return { status: 500, contentType: "", body: "" }; }
      if (/\/health/.test(url)) return { status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", service: "cybersafe-api" }) };
      return { status: 200, contentType: "text/html", body: "<!doctype html>" };
    },
    sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms ?? 1, 5))); },
    readinessAttempts: 3,
    readinessDelayMs: 1,
    killTimeoutMs: 5,
    exitTimeoutMs: 5,
    installSignalHandlers: () => ({ promise: new Promise(() => {}), dispose: () => {} }),
    spawn: (cmd, args) => {
      const n = nome(cmd, args);
      const child = new EventEmitter();
      child.pid = 9000 + children.size;
      children.set(n, child);
      // Depois da readiness completa o runner lança o desktop: é só aí que a saída do
      // serviço é tolerada (com flag) — nunca antes.
      if (n === "desktop" && !antesDaReadiness) setImmediate(() => fire(sair));
      return child;
    },
  };
  const env = {
    CYBERSAFE_DEV_RUN_ROOT: root,
    CYBERSAFE_API_PORT: "4100",
    ...(flag ? { CYBERSAFE_DEV_KEEP_UI_ON_SERVICE_EXIT: "1" } : {}),
  };
  return { root, logs, deps, env, children, fire };
}

const semExcecao = (logs) => !logs.some((l) => l.includes("EXCEÇÃO DEV"));

test("plano: a exceção é inerte por defeito e só aparece com a flag explícita", () => {
  const deps = { execPath: process.execPath, platform: "win32", tmpdir: () => os.tmpdir(), existsSync: () => true, execFileSync: () => "", realpathSync: (p) => p };
  const sem = buildPlan({ env: { CYBERSAFE_API_PORT: "4100" }, dryRun: true, deps });
  assert.equal(sem.devServiceException, false, "sem flag a exceção tem de ser false");
  assert.ok(!/exceção DEV service: ON/.test(renderPlan(sem)));
  assert.ok(/exceção DEV service: OFF/.test(renderPlan(sem)), "o plano tem de dizer OFF");
  const com = buildPlan({ env: { CYBERSAFE_API_PORT: "4100", CYBERSAFE_DEV_KEEP_UI_ON_SERVICE_EXIT: "1" }, dryRun: true, deps });
  assert.equal(com.devServiceException, true);
  assert.ok(/exceção DEV service: ON/.test(renderPlan(com)), "com flag tem de ser visível no plano/log");
});

test("SEM flag: saída do service após readiness encerra tudo (comportamento preservado)", async () => {
  const h = harness({ flag: false, sair: "service" });
  const r = await run({ argv: ["--start"], env: h.env, deps: h.deps });
  assert.equal(r.ready, true, "run bloqueou antes do spawn: " + JSON.stringify(r.blocked) + " | " + h.logs.slice(-3).join(" / "));
  assert.equal(r.settle?.child, "service");
  assert.ok(semExcecao(h.logs), "sem flag a exceção não pode existir");
  assert.equal(r.cleanup?.status, "OK", "cleanup aguardado com prova de morte");
  fs.rmSync(h.root, { recursive: true, force: true });
});

test("COM flag: service após readiness mantém a interface e espera a saída seguinte", async () => {
  const h = harness({ flag: true, sair: "service" });
  // O service morre; o desktop tem de morrer a seguir para o run terminar.
  const t = setTimeout(() => h.fire("desktop"), 60);
  try {
    const r = await run({ argv: ["--start"], env: h.env, deps: h.deps });
    assert.ok(h.logs.some((l) => l.includes("EXCEÇÃO DEV")), "a exceção tem de ficar no log");
    assert.equal(r.settle?.child, "desktop", "com a exceção, o settle final é a saída seguinte (desktop), não o service");
    assert.ok(h.logs.some((l) => /settle após a exceção/.test(l)));
    assert.equal(r.cleanup?.status, "OK", "cleanup completo no fim");
  } finally { clearTimeout(t); fs.rmSync(h.root, { recursive: true, force: true }); }
});

test("COM flag: service ANTES da readiness continua fatal e não lança Electron", async () => {
  const h = harness({ flag: true, antesDaReadiness: true, sair: "service" });
  const r = await run({ argv: ["--start"], env: h.env, deps: h.deps });
  assert.equal(r.ready, false);
  assert.ok(["cancelled", "readiness"].includes(r.blocked), "readiness abortada/falhada: " + r.blocked);
  assert.equal(h.children.has("desktop"), false, "falha de arranque: o Electron nunca é lançado");
  assert.ok(semExcecao(h.logs), "antes da readiness não há exceção");
  fs.rmSync(h.root, { recursive: true, force: true });
});

test("COM flag: outro filho (api) a terminar faz cleanup completo, sem exceção", async () => {
  const h = harness({ flag: true, sair: "api" });
  const r = await run({ argv: ["--start"], env: h.env, deps: h.deps });
  assert.equal(r.settle?.child, "api");
  assert.ok(semExcecao(h.logs), "a exceção é só para o service");
  assert.equal(r.cleanup?.status, "OK");
  fs.rmSync(h.root, { recursive: true, force: true });
});

test("COM flag: SIGINT/sinal continua a fazer cleanup completo, sem órfãos", async () => {
  const h = harness({ flag: true, sair: "service" });
  let resolveSignal;
  h.deps.installSignalHandlers = () => ({ promise: new Promise((r) => { resolveSignal = r; }), dispose: () => {} });
  const t = setTimeout(() => resolveSignal("abort"), 40);
  try {
    const r = await run({ argv: ["--start"], env: h.env, deps: h.deps });
    assert.equal(r.settle?.child, undefined, "o sinal não é a exceção do service");
    assert.equal(r.cleanup?.status, "OK", "sinal → cleanup com prova de morte de todos os filhos");
    assert.equal(r.cleanup?.allDead, true);
  } finally { clearTimeout(t); fs.rmSync(h.root, { recursive: true, force: true }); }
});
