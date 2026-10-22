import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { buildPlan, renderPlan, run, cleanupAsync, apiHealthReady, rendererReady, waitForStack, normalizarOrcamentoProntidao, PRONTIDAO_ORCAMENTO_PADRAO_MS, PRONTIDAO_TECTO_MS, PRONTIDAO_PISO_MS } from "./dev-isolated-run.mjs";

/**
 * TP-REAL-BOOT-RUNNER — testes por seams (não arrancam apps). Uma regressão por
 * cada defeito das revisões 1–3. Filhos são EventEmitters reais; o teste controla
 * `exit`/`error`, o sinal e o resultado do taskkill, para provar a ORDEM do
 * cleanup e a readiness estrita.
 */
const EXEC = "C:\\nodejs\\node.exe";
const ELECTRON_BIN = "C:\\repo\\node_modules\\electron\\dist\\electron.exe";
const NPM_CLI = "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
const HEALTH_OK = { status: 200, contentType: "application/json", body: '{"status":"ok","service":"cybersafe-api"}' };
const RENDERER_OK = { status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html>" };

function makeChild(pid) { const e = new EventEmitter(); e.pid = pid; e.kill = () => {}; return e; }

function fakeDeps(over = {}) {
  const calls = { mkdtemp: 0, mkdir: [], spawn: [], children: [], spawnSync: [], rm: [], killTree: [], signalInstalled: 0, signalDisposed: 0 };
  let signalResolve;
  let disparado = null;
  const deps = {
    execPath: EXEC,
    mkdtempSync: () => { calls.mkdtemp++; return path.join("/tmp", "cybersafe-dev-run-FAKE"); },
    mkdirSync: (p) => calls.mkdir.push(p),
    existsSync: (p) => {
      if (p === ELECTRON_BIN) return over.electronMissing !== true;
      if (p === NPM_CLI) return over.npmMissing !== true;
      return true;
    },
    rmSync: (p) => calls.rm.push(p),
    requireElectron: () => { if (over.electronThrows) throw new Error("no electron"); return ELECTRON_BIN; },
    spawn: (cmd, args) => {
      if (over.spawnThrowsAfter != null && calls.spawn.length >= over.spawnThrowsAfter) throw new Error("spawn boom");
      const c = makeChild(9000 + calls.children.length); calls.spawn.push({ cmd, args }); calls.children.push(c);
      if (over.electronAutoExit && cmd === ELECTRON_BIN) setImmediate(() => c.emit("exit", 0));
      return c;
    },
    spawnSync: (cmd, args) => {
      calls.spawnSync.push({ cmd, args });
      if (String(args.join(" ")).includes("dev-isolated-preflight")) return { status: over.preflightStatus ?? 0, stdout: "" };
      return { status: over.buildStatus ?? 0, stdout: "" };
    },
    probeTcp: async (host, port) => (over.busyPorts ?? []).includes(`${host}:${port}`),
    probePipe: async () => over.pipeReady ?? true,
    probeHttp: async (url) => (url.includes("/health") ? (over.apiResp ?? HEALTH_OK) : (over.rendererResp ?? RENDERER_OK)),
    // killTree: por omissão confirma e faz o filho emitir 'exit' (morte real).
    killTree: async (pid, child) => {
      calls.killTree.push(pid);
      if (over.killTreeThrow) throw new Error("taskkill boom");
      if (over.killTreeFail) return { ok: false, code: 1 };
      if (over.killTreeNoExit) return { ok: true, code: 0 }; // mata mas filho não emite exit
      child?.emit("exit", 0);
      return { ok: true, code: 0 };
    },
    sleep: (ms) => new Promise((r) => setImmediate(r)),
    installSignalHandlers: () => {
      calls.signalInstalled++;
      const promise = new Promise((r) => { signalResolve = r; });
      // Espelha o `installSignalHandlers` real: o estado síncrono é escrito ANTES de
      // resolver, porque é isso que `waitForStack` consulta para não perder um sinal.
      // "auto" = sinal chegado DEPOIS da prontidão (o que os testes de ciclo de vida
      // querem); "auto_imediato" = já levantado quando a prontidão começa (review R1).
      const disparar = (name) => { disparado = { kind: "signal", name }; signalResolve?.(disparado); };
      if (over.signal === "auto") setImmediate(() => disparar("SIGINT"));
      if (over.signal === "auto_imediato") disparar("SIGINT");
      return { promise, dizerSinal: () => disparado, dispose: () => { calls.signalDisposed++; } };
    },
    tmpdir: () => "/tmp",
    homedir: () => "/home/test",
    pid: 4242,
    log: () => {},
    readinessAttempts: 3,
    readinessDelayMs: 0,
    exitTimeoutMs: 0,
    ...over.deps,
  };
  deps.__fire = (sig) => signalResolve?.({ kind: "signal", name: sig });
  return { deps, calls };
}

const BASE_ENV = { PATH: "/usr/bin", JWT_SECRET: "super-segredo-nao-imprimir" };
const OK = { preflightStatus: 0, buildStatus: 0 };

describe("dry-run e segredo", () => {
  it("dry-run não chama mkdtemp/spawn/spawnSync nem instala sinal", async () => {
    const { deps, calls } = fakeDeps(OK);
    const r = await run({ argv: [], env: BASE_ENV, deps });
    assert.equal(r.action, "dry-run");
    assert.equal(calls.mkdtemp, 0); assert.equal(calls.spawn.length, 0); assert.equal(calls.spawnSync.length, 0); assert.equal(calls.signalInstalled, 0);
  });
  it("renderPlan nunca imprime valor de segredo", async () => {
    const { deps } = fakeDeps(OK);
    const r = await run({ argv: [], env: BASE_ENV, deps });
    assert.equal(renderPlan(r.plan).includes("super-segredo-nao-imprimir"), false);
  });
});

describe("defeito 6 — API do dev só na porta do piso dev (4100), nunca a de produção", () => {
  it("porta != 4100 → BLOCK antes de criar/spawn", async () => {
    const { deps, calls } = fakeDeps(OK);
    const r = await run({ argv: ["--start"], env: { ...BASE_ENV, CYBERSAFE_API_PORT: "4000" }, deps });
    assert.equal(r.blocked, "port-unsupported"); assert.equal(calls.mkdtemp, 0); assert.equal(calls.spawn.length, 0);
  });
  it("4100 é aceite e é a porta que vai para o env dos filhos", async () => {
    const { deps, calls } = fakeDeps(OK);
    const r = await run({ argv: [], env: BASE_ENV, deps });
    assert.equal(r.plan.apiPort, 4100);
    assert.equal(r.blocked, undefined);
  });
});

describe("defeito 1 — binário Electron real", () => {
  it("electron não resolvido → BLOCK sem spawn", async () => {
    const { deps, calls } = fakeDeps({ ...OK, electronThrows: true });
    assert.equal((await run({ argv: ["--start"], env: BASE_ENV, deps })).blocked, "electron-unresolved");
    assert.equal(calls.spawn.length, 0);
  });
  it("plano usa o exe com --user-data-dir (não node index.js)", () => {
    const plan = buildPlan({ env: BASE_ENV, dryRun: true, deps: fakeDeps(OK).deps });
    const d = plan.steps.spawn.find((c) => c.name === "desktop");
    assert.equal(d.cmd, ELECTRON_BIN); assert.ok(d.args.includes(`--user-data-dir=${plan.userDataDir}`)); assert.equal(d.args.includes("index.js"), false);
  });
});

describe("defeito 2 — npm via npm-cli.js + execPath", () => {
  it("npm-cli ausente → BLOCK sem spawn", async () => {
    const { deps, calls } = fakeDeps({ ...OK, npmMissing: true });
    assert.equal((await run({ argv: ["--start"], env: BASE_ENV, deps })).blocked, "npm-cli-missing");
    assert.equal(calls.spawn.length, 0);
  });
  it("comandos npm usam execPath + npm-cli.js; app chama o workspace DIRETO com --strictPort", () => {
    const plan = buildPlan({ env: BASE_ENV, dryRun: true, deps: fakeDeps(OK).deps });
    for (const c of plan.steps.spawn.filter((x) => x.name !== "desktop")) { assert.equal(c.cmd, EXEC); assert.equal(c.args[0], NPM_CLI); }
    const app = plan.steps.spawn.find((c) => c.name === "app");
    // direto: run dev -w @cybersafe/app -- --strictPort (não o alias dev:app que engolia a flag)
    assert.deepEqual(app.args, [NPM_CLI, "run", "dev", "-w", "@cybersafe/app", "--", "--strictPort"]);
    assert.equal(app.args.includes("dev:app"), false, "não usar o wrapper dev:app");
  });
});

describe("defeito 3 — build desktop antes do spawn", () => {
  it("build falha → nenhum spawn", async () => {
    const { deps, calls } = fakeDeps({ ...OK, buildStatus: 1 });
    assert.equal((await run({ argv: ["--start"], env: BASE_ENV, deps })).blocked, "desktop-build");
    assert.equal(calls.spawn.length, 0);
  });
});

describe("defeito 5 — portas + readiness estrita antes do Electron", () => {
  it("renderer 5173 ocupado → BLOCK sem spawn, sem matar alheios", async () => {
    const { deps, calls } = fakeDeps({ ...OK, busyPorts: ["127.0.0.1:5173"] });
    const r = await run({ argv: ["--start"], env: BASE_ENV, deps });
    assert.match(String(r.blocked), /port-busy:.*5173/); assert.equal(calls.spawn.length, 0); assert.equal(calls.killTree.length, 0);
  });
  it("API /health 404 → readiness falha → Electron NÃO lançado", async () => {
    const { deps } = fakeDeps({ ...OK, apiResp: { status: 404, contentType: "text/plain", body: "not found" } });
    const r = await run({ argv: ["--start"], env: BASE_ENV, deps });
    assert.equal(r.blocked, "readiness"); assert.equal(r.spawned.some((s) => s.name === "desktop"), false);
  });
  it("API /health 401 → readiness falha (não é pronto)", async () => {
    const { deps } = fakeDeps({ ...OK, apiResp: { status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' } });
    assert.equal((await run({ argv: ["--start"], env: BASE_ENV, deps })).blocked, "readiness");
  });
  it("renderer 200 mas não-HTML → readiness falha", async () => {
    const { deps } = fakeDeps({ ...OK, rendererResp: { status: 200, contentType: "text/plain", body: "x" } });
    assert.equal((await run({ argv: ["--start"], env: BASE_ENV, deps })).blocked, "readiness");
  });
  it("caminho feliz: service/api/app → readiness → Electron (ordem)", async () => {
    const { deps, calls } = fakeDeps({ ...OK, signal: "auto" });
    const r = await run({ argv: ["--start"], env: BASE_ENV, deps });
    assert.equal(r.ready, true);
    assert.deepEqual(r.spawned.map((s) => s.name), ["service", "api", "app", "desktop"]);
    assert.equal(calls.spawn.length, 4);
  });
});

describe("defeito A — ciclo de vida real (sinal / saída do Electron / erro de spawn)", () => {
  it("SIGINT dispara settle → cleanup aguardado → handlers removidos", async () => {
    const { deps, calls } = fakeDeps({ ...OK, signal: "auto" });
    const r = await run({ argv: ["--start"], env: BASE_ENV, deps });
    assert.equal(r.settle?.kind, "signal");
    assert.equal(calls.signalInstalled, 1, "handlers instalados antes do spawn");
    assert.equal(calls.signalDisposed, 1, "handlers removidos após settle");
    assert.equal(r.cleanup.status, "OK");
  });
  it("saída do Electron (sem sinal) dispara settle", async () => {
    const { deps } = fakeDeps({ ...OK, signal: "never", electronAutoExit: true });
    const r = await run({ argv: ["--start"], env: BASE_ENV, deps });
    assert.equal(r.settle?.kind, "exit");
    assert.equal(r.ready, true);
  });
  it("spawn lança após 1 filho → cleanup do que criou, sem Electron", async () => {
    const { deps, calls } = fakeDeps({ ...OK, spawnThrowsAfter: 1 });
    const r = await run({ argv: ["--start"], env: BASE_ENV, deps });
    assert.equal(r.blocked, "spawn-error");
    assert.equal(r.spawned.length, 1);
    assert.equal(calls.killTree.length, 1, "limpa exatamente o filho criado");
    assert.equal(calls.signalDisposed, 1);
  });
});

describe("defeito C — cleanup comprovado (taskkill aguardado + exit real)", () => {
  it("taskkill falha → status FAIL, raiz NÃO apagada", async () => {
    const { deps, calls } = fakeDeps({ ...OK, signal: "auto", killTreeFail: true });
    const r = await run({ argv: ["--start", "--clean"], env: BASE_ENV, deps });
    assert.equal(r.cleanup.status, "FAIL");
    assert.equal(calls.rm.includes(r.plan.root), false, "não apaga raiz sem prova de morte");
  });
  it("taskkill lança → status FAIL, raiz mantida", async () => {
    const { deps, calls } = fakeDeps({ ...OK, signal: "auto", killTreeThrow: true });
    const r = await run({ argv: ["--start", "--clean"], env: BASE_ENV, deps });
    assert.equal(r.cleanup.status, "FAIL"); assert.equal(calls.rm.includes(r.plan.root), false);
  });
  it("taskkill ok mas filho sem 'exit' → não morto → raiz mantida", async () => {
    const { deps, calls } = fakeDeps({ ...OK, signal: "auto", killTreeNoExit: true });
    const r = await run({ argv: ["--start", "--clean"], env: BASE_ENV, deps });
    assert.equal(r.cleanup.status, "FAIL"); assert.equal(calls.rm.includes(r.plan.root), false);
  });
  it("todos mortos comprovados + --clean → raiz apagada", async () => {
    const { deps, calls } = fakeDeps({ ...OK, signal: "auto" });
    const r = await run({ argv: ["--start", "--clean"], env: BASE_ENV, deps });
    assert.equal(r.cleanup.status, "OK"); assert.ok(calls.rm.includes(r.plan.root));
  });
  it("filho com 'exit' real + taskkill 128 (já não existia) → morto (prova forte)", async () => {
    const { deps, calls } = fakeDeps({ ...OK, signal: "auto" });
    deps.killTree = async (pid, child) => { child?.emit("exit", 0); return { ok: false, code: 128 }; };
    const r = await run({ argv: ["--start", "--clean"], env: BASE_ENV, deps });
    assert.equal(r.cleanup.status, "OK", "exit real + 128 é morte confirmada");
    assert.ok(calls.rm.includes(r.plan.root), "com prova total e --clean, apaga a raiz");
  });
  it("sem 'exit' real (timeout) → NÃO morto mesmo com kill ok", async () => {
    const { deps, calls } = fakeDeps({ ...OK, signal: "auto", killTreeNoExit: true });
    const r = await run({ argv: ["--start", "--clean"], env: BASE_ENV, deps });
    assert.equal(r.cleanup.status, "FAIL"); assert.equal(calls.rm.includes(r.plan.root), false);
  });
});

describe("predicados de readiness (unidades)", () => {
  it("apiHealthReady exige 200 + {status:ok, service:cybersafe-api}; rejeita status:error", () => {
    assert.equal(apiHealthReady(HEALTH_OK), true);
    assert.equal(apiHealthReady({ status: 200, contentType: "application/json", body: '{"status":"error","service":"cybersafe-api"}' }), false, "status:error NÃO é pronto");
    assert.equal(apiHealthReady({ status: 200, contentType: "application/json", body: '{"status":"ok"}' }), false, "sem service:cybersafe-api não basta");
    assert.equal(apiHealthReady({ status: 200, contentType: "application/json", body: '{"status":"ok","service":"other"}' }), false);
    assert.equal(apiHealthReady({ status: 404, contentType: "application/json", body: '{"status":"ok","service":"cybersafe-api"}' }), false);
    assert.equal(apiHealthReady({ status: 200, contentType: "text/html", body: "<html>" }), false, "não-JSON rejeita");
    assert.equal(apiHealthReady(null), false);
  });
  it("rendererReady exige 200 + HTML", () => {
    assert.equal(rendererReady(RENDERER_OK), true);
    assert.equal(rendererReady({ status: 200, contentType: "application/json", body: "{}" }), false);
    assert.equal(rendererReady({ status: 302, contentType: "text/html", body: "" }), false);
  });
});

describe("defeito A (Revisão 3) — sinal cancela readiness; spawn do desktop protegido", () => {
  it("SIGINT durante readiness → Electron NÃO lançado (0 desktop), blocked cancelled", async () => {
    const { deps, calls } = fakeDeps({ ...OK, signal: "auto", apiResp: { status: 503, contentType: "application/json", body: '{"status":"error"}' } });
    const r = await run({ argv: ["--start"], env: BASE_ENV, deps });
    assert.equal(r.blocked, "cancelled");
    assert.equal(r.spawned.filter((s) => s.name === "desktop").length, 0, "nunca lançar Electron após SIGINT");
    assert.equal(r.spawned.length, 3, "só service/api/app");
    assert.equal(calls.signalDisposed, 1);
  });
  it("desktop spawn lança → finally limpa os 3 já criados, sem Electron", async () => {
    const { deps, calls } = fakeDeps({ ...OK, signal: "never", spawnThrowsAfter: 3 });
    const r = await run({ argv: ["--start"], env: BASE_ENV, deps });
    assert.equal(r.blocked, "spawn-error");
    assert.equal(r.spawned.length, 3);
    assert.equal(calls.killTree.length, 3, "cleanup dos 3 filhos próprios no finally");
    assert.equal(calls.signalDisposed, 1);
  });
  it("killTree nunca resolve → timeout finito → status FAIL, raiz mantida", async () => {
    const { deps, calls } = fakeDeps({ ...OK, signal: "auto", killTreeThrow: false });
    deps.killTree = () => new Promise(() => {}); // nunca resolve
    const r = await run({ argv: ["--start", "--clean"], env: BASE_ENV, deps });
    assert.equal(r.cleanup.status, "FAIL", "sem prova de morte não alega allDead");
    assert.equal(calls.rm.includes(r.plan.root), false, "não apaga raiz com taskkill pendente");
  });
});

describe("plano de isolamento (preservado)", () => {
  it("serviço/API-DB/userData separados; env coerente; personal intocado", () => {
    const plan = buildPlan({ env: BASE_ENV, dryRun: true, deps: fakeDeps(OK).deps });
    assert.ok(plan.serviceDir.startsWith(plan.root) && plan.apiDbPath.startsWith(plan.root) && plan.userDataDir.startsWith(plan.root));
    assert.equal(plan.isolationEnv.CYBERSAFE_DEV_PIPE_NAME, plan.pipeName);
    assert.equal(plan.isolationEnv.PATH, "/usr/bin"); assert.equal(plan.personalTouched, false);
  });
});

describe("--gui-cdp (opt-in, default OFF) — CDP só loopback dedicado", () => {
  it("default: sem porta CDP → desktop NÃO tem --remote-debugging", () => {
    const plan = buildPlan({ env: BASE_ENV, dryRun: true, deps: fakeDeps(OK).deps });
    const d = plan.steps.spawn.find((c) => c.name === "desktop");
    assert.equal(plan.debugPort, null);
    assert.equal(d.args.some((a) => a.includes("remote-debugging")), false);
  });
  it("com CYBERSAFE_DEV_DEBUG_PORT: desktop ganha port dedicado + address 127.0.0.1", () => {
    const plan = buildPlan({ env: { ...BASE_ENV, CYBERSAFE_DEV_DEBUG_PORT: "9333" }, dryRun: true, deps: fakeDeps(OK).deps });
    const d = plan.steps.spawn.find((c) => c.name === "desktop");
    assert.equal(plan.debugPort, 9333);
    assert.ok(d.args.includes("--remote-debugging-port=9333"));
    assert.ok(d.args.includes("--remote-debugging-address=127.0.0.1"));
  });
  it("--gui-cdp sem porta no env escolhe uma livre e plana CDP", async () => {
    const { deps, calls } = fakeDeps({ ...OK, signal: "auto" });
    deps.probeTcp = async (host, port) => port !== 9333; // 9333 livre
    const r = await run({ argv: ["--gui-cdp"], env: BASE_ENV, deps }); // dry-run
    assert.equal(r.plan.debugPort, 9333);
    assert.equal(r.action, "dry-run");
    assert.equal(calls.spawn.length, 0);
  });
});

describe("defeito 8 — a porta que a API escuta e a que o desktop injecta são a mesma", () => {
  // Medido em runtime (UI-session 261019180x): o renderer chamava 127.0.0.1:4100 e
  // recebia ERR_CONNECTION_REFUSED, enquanto a API isolada estava em 4000. Causa:
  // `desktop/src/dev-isolation.ts` lê `CYBERSAFE_DEV_PORT`; o runner só punha
  // `CYBERSAFE_API_PORT`. O desktop caía no DEV_API_PORT_FLOOR e a UI ficava muda.
  it("o filho desktop recebe CYBERSAFE_DEV_PORT igual a CYBERSAFE_API_PORT", () => {
    const plan = buildPlan({ env: BASE_ENV, dryRun: true, deps: fakeDeps(OK).deps });
    const desktop = plan.steps.spawn.find((s) => s.name === "desktop");
    const api = plan.steps.spawn.find((s) => s.name === "api");
    assert.ok(desktop && api, "o plano tem de ter desktop e api");
    assert.equal(desktop.env.CYBERSAFE_DEV_PORT, desktop.env.CYBERSAFE_API_PORT);
    assert.equal(api.env.CYBERSAFE_DEV_PORT, api.env.CYBERSAFE_API_PORT);
    assert.equal(desktop.env.CYBERSAFE_API_PORT, "4100");
  });
  it("o perfil dev do desktop resolve exactamente a porta que o runner dá à API", async () => {
    // É ESTA igualdade que a UI precisava: o renderer lê `__CYBERSAFE_API_BASE__`, e a
    // base é calculada pelo desktop a partir do env — se `escolherPorta` subir o pedido
    // ao piso (max(4100, pedido)), o runner tem de pedir uma porta >= do piso.
    const plan = buildPlan({ env: BASE_ENV, dryRun: true, deps: fakeDeps(OK).deps });
    const desktop = plan.steps.spawn.find((s) => s.name === "desktop");
    const { resolveDevProfile } = await import("../packages/desktop/src/dev-isolation.ts");
    const perfil = resolveDevProfile({ isPackaged: false, env: desktop.env });
    assert.equal(perfil.apiBase, `http://127.0.0.1:${desktop.env.CYBERSAFE_API_PORT}`);
    assert.equal(perfil.injectApiBaseInRenderer, true);
  });
  it("renderPlan mostra a porta que o desktop vai injectar no renderer", () => {
    const plan = buildPlan({ env: BASE_ENV, dryRun: true, deps: fakeDeps(OK).deps });
    const texto = renderPlan(plan);
    assert.match(texto, /API porta\s*: 4100/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-WIN-P0-RUNNER-READINESS — a prontidão é limitada por RELÓGIO, não por
// contagem. Nada aqui dorme de verdade: o tempo é virtual e avança quando o código
// espera ou sonda, por isso «20 s de arranque frio» e «120 s de orçamento» são
// testados em milissegundos reais e de forma determinística.
// ─────────────────────────────────────────────────────────────────────────────
const PLANO_RO = { apiPort: 4100, rendererPort: 5173, pipeName: "pipe-de-teste" };
const FILA = (nomes) => nomes.map((n) => ({ name: n, pid: 1000, exited: new Promise(() => {}), child: { kill: () => {} } }));
const SEM_SINAL = () => ({ promise: new Promise(() => { }), dizerSinal: () => null, dispose: () => { } });
// Sinal controlável: espelha o produto, onde `dizerSinal()` passa a ver o sinal NO
// instante em que ele é levantado, independentemente de promessas penduradas.
function sinalControlavel() {
  let disparar, resolve;
  const promise = new Promise((r) => { resolve = r; });
  let visto = null;
  disparar = (name) => { visto = { kind: "signal", name }; resolve(visto); };
  return { promise, dizerSinal: () => visto, disparar, dispose: () => { } };
}

function relogioVirtual(inicio = 1_000_000) {
  let t = inicio;
  let seq = 0;
  const fila = [];
  const agendar = () => setImmediate(() => {
    if (!fila.length) return;
    // DISPARA POR TEMPO VIRTUAL, não por ordem de criação: sem isto, um `sleep(40s)`
    // criado antes de um `sleep(20s)` vencia a corrida e a latência de uma sonda nunca
    // era interrompida pelo prazo — o modelo mentia sobre o comportamento real.
    fila.sort((a, b) => a.quando - b.quando || a.ordem - b.ordem);
    const e = fila.shift();
    t = Math.max(t, e.quando);
    e.res();
    if (fila.length) agendar();
  });
  const sleep = (ms) => {
    const entrada = { quando: t + Math.max(0, Number(ms) || 0), ordem: ++seq, res: null };
    const p = new Promise((r) => { entrada.res = r; });
    // `cancel()` espelha o `clearTimeout` do mundo real: um temporizador que passou a
    // não interessar não pode continuar a mover o relógio nem a manter o processo vivo.
    p.cancel = () => { const i = fila.indexOf(entrada); if (i >= 0) fila.splice(i, 1); };
    fila.push(entrada);
    agendar();
    return p;
  };
  return { estado: { get t() { return t; } }, now: () => t, sleep };
}

function depsProntidao(over = {}) {
  const relogio = relogioVirtual();
  // A latência de uma sonda É uma espera no mesmo relógio: só assim o prazo partilhado
  // a pode interromper, que é o comportamento que se quer provar.
  const sondar = async (url) => {
    if (url.includes("/health")) {
      if (over.penduradaApi) return new Promise(() => { });
      if (over.latenciaApi) await relogio.sleep(over.latenciaApi);
      return over.api === undefined ? HEALTH_OK : over.api;
    }
    if (over.latenciaRenderer) await relogio.sleep(over.latenciaRenderer);
    return over.renderer === undefined ? RENDERER_OK : over.renderer;
  };
  return {
    probeHttp: sondar,
    probePipe: async () => {
      if (over.penduradaPipe) return new Promise(() => { });
      return over.pipe === undefined ? true : over.pipe;
    },
    now: relogio.now,
    sleep: relogio.sleep,
    readinessDelayMs: over.intervalo ?? 500,
    readinessBudgetMs: over.orcamento,
    ...(over.tectoTentativas === undefined ? {} : { readinessAttempts: over.tectoTentativas }),
    __relogio: relogio,
  };
}

describe("prontidão por orçamento de relógio", () => {
  it("orçamento: default 120s, piso, tecto ABAIXO do --max do supervisor, inválido não rebenta", () => {
    assert.deepEqual(normalizarOrcamentoProntidao({}), { ms: PRONTIDAO_ORCAMENTO_PADRAO_MS, ajustado: false, motivo: "exacto" });
    assert.equal(PRONTIDAO_ORCAMENTO_PADRAO_MS, 120_000);
    assert.ok(PRONTIDAO_TECTO_MS < 420_000, "o tecto tem de caber abaixo do --max aprovado da vigia");
    assert.ok(PRONTIDAO_PISO_MS >= 1_000);
    assert.equal(normalizarOrcamentoProntidao({ readinessBudgetMs: 10 }).motivo, "abaixo_do_piso");
    assert.equal(normalizarOrcamentoProntidao({ readinessBudgetMs: 9_999_999 }).motivo, "acima_do_tecto");
    assert.equal(normalizarOrcamentoProntidao({ readinessBudgetMs: "abc" }).motivo, "invalido_usado_padrao");
    assert.equal(normalizarOrcamentoProntidao({ readinessBudgetMs: 0 }).motivo, "invalido_usado_padrao");
    assert.equal(normalizarOrcamentoProntidao({ readinessBudgetMs: Infinity }).motivo, "invalido_usado_padrao");
    assert.equal(normalizarOrcamentoProntidao({ readinessBudgetMs: -5 }).motivo, "invalido_usado_padrao");
  });

  it("saudável imediato: pronto à primeira tentativa, sem gastar orçamento", async () => {
    const r = await waitForStack(PLANO_RO, depsProntidao(), SEM_SINAL(), FILA(["service", "api", "app"]));
    assert.equal(r.ok, true);
    assert.equal(r.tentativas, 1);
    assert.equal(r.ultimo.api, "pronto");
    assert.equal(r.ultimo.renderer, "pronto");
    assert.equal(r.ultimo.pipe, "pronto");
    assert.ok(r.orcamento.decorridoMs < 1_000, "não pode consumir orçamento quando está tudo bem");
  });

  it("API fria 20s: fica pronta DENTRO do orçamento — o caso que a contagem matava", async () => {
    const r = await waitForStack(PLANO_RO, depsProntidao({ latenciaApi: 20_000 }), SEM_SINAL(), FILA(["service"]));
    assert.equal(r.ok, true);
    assert.ok(r.orcamento.decorridoMs >= 20_000 && r.orcamento.decorridoMs <= PRONTIDAO_ORCAMENTO_PADRAO_MS,
      `decorrido ${r.orcamento.decorridoMs} fora da janela esperada`);
  });

  it("API nunca pronta: reason orcamento_esgotado e o parede nunca excede o orçamento", async () => {
    const r = await waitForStack(PLANO_RO, depsProntidao({ api: null, orcamento: 60_000 }), SEM_SINAL(), FILA(["service"]));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "orcamento_esgotado");
    assert.equal(r.orcamento.ms, 60_000);
    assert.ok(r.orcamento.decorridoMs <= 60_000, `parede ${r.orcamento.decorridoMs} não pode passar do orçamento`);
    assert.ok(r.tentativas >= 2, "tem de ter tentado mais do que uma vez");
    assert.equal(r.ultimo.api, "sem_resposta");
  });

  it("o orçamento NÃO é redefinido por tentativa: sondas caras não estendem a corrida", async () => {
    // Cada tentativa tem uma sonda de 50 s de relógio com 120 s de orçamento: o que se
    // exige é FIM, não um número exacto de voltas. A contagem de tentativas depende do
    // temporizador abandonado pela sonda cortada (no mundo real um `setTimeout` desses
    // não move o relógio), por isso é a parede que é afirmada, não o número.
    const r = await waitForStack(PLANO_RO, depsProntidao({ api: null, latenciaApi: 50_000 }), SEM_SINAL(), FILA(["service"]));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "orcamento_esgotado");
    assert.ok(r.tentativas >= 2, "tem de tentar mais do que uma vez dentro do orçamento");
    assert.ok(r.orcamento.decorridoMs <= 120_000, `decorrido ${r.orcamento.decorridoMs} ultrapassa o orçamento declarado`);
  });

  it("health 401/403/404 e JSON errado nunca são prontidão, e nomeiam o estado", async () => {
    const casos = [
      [{ status: 401, contentType: "application/json", body: "{}" }, "recusado_401"],
      [{ status: 403, contentType: "application/json", body: "{}" }, "recusado_403"],
      [{ status: 404, contentType: "application/json", body: "{}" }, "rota_inexistente_404"],
      [{ status: 200, contentType: "application/json", body: "não é json" }, "estado_200"],
      [{ status: 200, contentType: "application/json", body: '{"status":"error","service":"cybersafe-api"}' }, "estado_200"],
      [{ status: 200, contentType: "application/json", body: '{"status":"ok","service":"outra-coisa"}' }, "estado_200"],
      [{ status: 503, contentType: "text/html", body: "<html>" }, "estado_503"],
    ];
    for (const [resposta, esperado] of casos) {
      const r = await waitForStack(PLANO_RO, depsProntidao({ api: resposta, orcamento: 5_000 }), SEM_SINAL(), FILA(["service"]));
      assert.equal(r.ok, false, `${esperado} não pode contar como pronto`);
      assert.equal(r.ultimo.api, esperado);
    }
  });

  it("renderer 200 não-HTML e pipe ausente: recusa nomeada por subsistema, não um timeout uniforme", async () => {
    const soHtml = await waitForStack(PLANO_RO, depsProntidao({ renderer: { status: 200, contentType: "application/json", body: "{}" }, orcamento: 3_000 }), SEM_SINAL(), FILA(["app"]));
    assert.equal(soHtml.ok, false);
    assert.equal(soHtml.ultimo.api, "pronto");
    assert.equal(soHtml.ultimo.pipe, "pronto");
    assert.equal(soHtml.ultimo.renderer, "estado_200");

    const semPipe = await waitForStack(PLANO_RO, depsProntidao({ pipe: false, orcamento: 3_000 }), SEM_SINAL(), FILA(["service"]));
    assert.equal(semPipe.ok, false);
    assert.equal(semPipe.ultimo.pipe, "ausente");
    assert.equal(semPipe.ultimo.api, "pronto");
  });

  it("sonda pendurada é FINITA: prazo_da_sonda e a corrida para dentro do orçamento", async () => {
    const r = await waitForStack(PLANO_RO, depsProntidao({ penduradaApi: true, orcamento: 10_000 }), SEM_SINAL(), FILA(["api"]));
    assert.equal(r.ok, false);
    assert.equal(r.ultimo.api, "prazo_da_sonda");
    assert.ok(r.orcamento.decorridoMs <= 10_000, "uma sonda pendurada não pode estender a corrida para além do orçamento");
  });

  it("crash de filho é distinguível de timeout e cancela sem Electron", async () => {
    const queCrasha = { name: "api", pid: 11, child: { kill: () => { } }, exited: Promise.resolve({ kind: "exit", code: 1, signal: null }) };
    const r = await waitForStack(PLANO_RO, depsProntidao({ api: null, orcamento: 60_000 }), SEM_SINAL(), [queCrasha]);
    assert.equal(r.ok, false);
    assert.equal(r.aborted, true);
    assert.equal(r.motivo, "filho_crashou");
    assert.equal(r.child, "api");
    assert.equal(r.code, 1);
    assert.notEqual(r.reason, "timeout", "um filho que morreu nunca é reportado como timeout");
    // Com a precedência corrigida, o aborta ganha às sondas da primeira volta: não há
    // estados por subsistema inventados depois de o filho ter morrido.
    assert.equal(r.ultimo, null, "um cancelamento antecipado não pode fingir sondas completadas");

    const limpo = { name: "app", pid: 12, child: { kill: () => { } }, exited: Promise.resolve({ kind: "exit", code: 0 }) };
    const r2 = await waitForStack(PLANO_RO, depsProntidao({ api: null, orcamento: 60_000 }), SEM_SINAL(), [limpo]);
    assert.equal(r2.motivo, "filho_saiu_limpo");

    const erro = { name: "service", pid: 13, child: { kill: () => { } }, exited: Promise.resolve({ kind: "error", code: null }) };
    const r3 = await waitForStack(PLANO_RO, depsProntidao({ api: null, orcamento: 60_000 }), SEM_SINAL(), [erro]);
    assert.equal(r3.motivo, "filho_crashou", "kind:error não é uma saída limpa");

    const porSinal = { promise: Promise.resolve({ kind: "signal", name: "SIGTERM" }), dispose: () => { } };
    const r4 = await waitForStack(PLANO_RO, depsProntidao({ api: null, orcamento: 60_000 }), porSinal, FILA(["service"]));
    assert.equal(r4.ok, false);
    assert.equal(r4.motivo, "sinal");
    assert.equal(r4.sinal, "SIGTERM");
  });

  it("sem sucesso artificial por sono: só dormitar não apronta nada", async () => {
    const r = await waitForStack(PLANO_RO, depsProntidao({ api: null, renderer: null, pipe: false, orcamento: 4_000, intervalo: 500 }), SEM_SINAL(), FILA(["service"]));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "orcamento_esgotado");
    assert.equal(r.ultimo.renderer, "sem_resposta");
    assert.equal(r.ultimo.pipe, "ausente");
  });

  it("readinessAttempts continua um tecto explícito de tentativas (compatibilidade honesta)", async () => {
    const r = await waitForStack(PLANO_RO, depsProntidao({ api: null, orcamento: 600_000, intervalo: 10, tectoTentativas: 2 }), SEM_SINAL(), FILA(["service"]));
    assert.equal(r.tentativas, 2);
    assert.equal(r.reason, "tentativas_esgotadas");
  });

  it("run(): orçamento esgotado bloqueia Electron e devolve a razão nomeada", async () => {    const { deps } = fakeDeps(OK);
    const r = await run({
      argv: ["--start"], env: BASE_ENV,
      deps: { ...deps, readinessAttempts: undefined, probeHttp: async (url) => (url.includes("/health") ? null : RENDERER_OK), now: () => Date.now(), readinessBudgetMs: 40, readinessDelayMs: 5 },
    });
    assert.equal(r.blocked, "readiness");
    assert.equal(r.blockedReason, "orcamento_esgotado");
    assert.equal(r.spawned.some((s) => s.name === "desktop"), false, "Electron não pode ser lançado");
    assert.equal(r.prontidao.estados.api, "sem_resposta");
    // 40 ms não é um orçamento admissível: sobe ao piso e isso é reportado, não calado.
    assert.equal(r.prontidao.orcamento.ms, PRONTIDAO_PISO_MS);
    assert.equal(r.prontidao.orcamento.motivo, "abaixo_do_piso");
    assert.equal(r.prontidao.orcamento.ajustado, true);
    assert.ok(r.prontidao.orcamento.decorridoMs >= PRONTIDAO_PISO_MS, "tem de ter esperado pelo orçamento que ele próprio declarou");
  });

  it("o log da recusa nomeia os subsistemas e não transcreve nada sensível", async () => {
    const linhas = [];
    const { deps } = fakeDeps(OK);
    await run({
      argv: ["--start"], env: BASE_ENV,
      deps: {
        ...deps,
        readinessAttempts: undefined,
        probeHttp: async (url) => (url.includes("/health") ? { status: 503, contentType: "text/html", body: "CORPO_QUE_NAO_PODE_APARECER" } : RENDERER_OK),
        now: () => Date.now(), readinessBudgetMs: 30, readinessDelayMs: 5, log: (s) => linhas.push(String(s)),
      },
    });
    const texto = linhas.join("\n");
    assert.match(texto, /readiness falhou \(orcamento_esgotado\)/);
    assert.match(texto, /api=estado_503/);
    assert.match(texto, /pipe=pronto/);
    assert.doesNotMatch(texto, /CORPO_QUE_NAO_PODE_APARECER/, "corpo de resposta nunca vai para o log");
    assert.doesNotMatch(texto, /super-segredo|JWT_SECRET=/, "ambiente nunca vai para o log");
  });
});

// Review R1 (Codex): o cancelamento tem de ganhar ao «pronto», não só ser consultado
// depois dele. Cada caso abaixo foi reproduzido VERDE contra o código antes da correcção.
describe("precedência do cancelamento sobre o sucesso", () => {
  // Ambos os caminhos: `dizerSinal` síncrono (o do produto) e a `promise` já resolvida
  // (o da corrida assíncrona). Se algum deles falhar, o Electron pode ser lançado depois
  // de o utilizador ter pedido para sair — foi exatamente o review R1.
  const SINAL_JA = () => ({
    promise: Promise.resolve({ kind: "signal", name: "SIGTERM" }),
    dizerSinal: () => ({ kind: "signal", name: "SIGTERM" }),
    dispose: () => { },
  });
  const filhoMorto = (nome, code) => ({
    name: nome, pid: 7, child: { kill: () => { } },
    exited: Promise.resolve({ kind: "exit", code, signal: null }),
    dizerSaida: () => ({ kind: "exit", code, signal: null }),
  });

  it("sinal já chegado + três sondas verdes: NUNCA ok, nunca Electron", async () => {
    const r = await waitForStack(PLANO_RO, depsProntidao(), SINAL_JA(), FILA(["service", "api", "app"]));
    assert.equal(r.ok, false, "um SIGTERM já recebido não pode ser esquecido por sondas verdes");
    assert.equal(r.aborted, true);
    assert.equal(r.motivo, "sinal");
    assert.equal(r.sinal, "SIGTERM");
  });

  it("filho já morto + três sondas verdes: abortado com nome e código, não sucesso", async () => {
    const crash = await waitForStack(PLANO_RO, depsProntidao(), SEM_SINAL(), [filhoMorto("api", 1), ...FILA(["service", "app"])]);
    assert.equal(crash.ok, false);
    assert.equal(crash.motivo, "filho_crashou");
    assert.equal(crash.child, "api");
    assert.equal(crash.code, 1);

    const limpo = await waitForStack(PLANO_RO, depsProntidao(), SEM_SINAL(), [filhoMorto("app", 0), ...FILA(["service", "api"])]);
    assert.equal(limpo.ok, false);
    assert.equal(limpo.motivo, "filho_saiu_limpo");
    assert.equal(limpo.child, "app");
  });

  it("sinal levantado ENQUANTO as sondas estão penduradas é visto sem as esperar", async () => {
    const deps = depsProntidao({ penduradaApi: true, penduradaPipe: true, orcamento: 120_000 });
    const sinal = sinalControlavel();
    const emCurso = waitForStack(PLANO_RO, deps, sinal, FILA(["service"]));
    await new Promise((r) => setImmediate(r));
    sinal.disparar("SIGINT");
    const r = await emCurso;
    assert.equal(r.ok, false, "o sinal tinha de encerrar a prontidão");
    assert.equal(r.aborted, true);
    assert.equal(r.motivo, "sinal");
    assert.equal(r.sinal, "SIGINT");
    assert.ok(r.ultimo === null || r.ultimo.api === "prazo_da_sonda", "nunca um api verde inventado");
    assert.ok(r.orcamento.decorridoMs < PRONTIDAO_ORCAMENTO_PADRAO_MS, "não pode ter esperado pelo orçamento todo");
  });

  it("run(): sinal já levantado, com tudo verde, não lança desktop", async () => {
    const { deps, calls } = fakeDeps({ ...OK, signal: "auto_imediato" });
    const r = await run({ argv: ["--start"], env: BASE_ENV, deps });
    assert.equal(r.blocked, "cancelled");
    assert.equal(r.ready, false);
    assert.equal(r.spawned.some((s) => s.name === "desktop"), false);
    assert.equal(r.spawned.some((s) => s.name === "api"), true, "os filhos já arrancados continuam a ser o alvo do cleanup");
    assert.ok(calls.signalDisposed > 0, "o handler de sinal tem de ser libertado");
  });
});
