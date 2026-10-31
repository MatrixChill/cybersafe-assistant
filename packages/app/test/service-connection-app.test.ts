import * as progressiveReadReal from "../src/lib/progressiveRead";
import * as batteryDisplayReal from "../src/lib/batteryDisplay";
import * as cpuUsageReal from "../src/lib/cpuUsage";
import * as ramUsageReal from "../src/lib/ramUsageDisplay";
import * as networkReadingsReal from "../src/lib/networkReadings";
import * as toastCopyReal from "../src/lib/toastCopy";
import * as serviceSyncStatusReal from "../src/lib/serviceSyncStatus";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { deriveProtectionLevel } from "../src/lib/protectionHealth";
import * as processIntelligence from "../src/lib/processIntelligence";
import * as processMatrix from "../src/lib/processMatrix";
import { deriveLoadingState, BOOT_BODY_COPY, DEFAULT_STARTUP_TIMEOUT_MS } from "../src/lib/loadingStates";
import { BootScreen } from "../src/components/BootScreen";
import * as bootReadinessReal from "../src/lib/bootReadiness";
import * as processListStateReal from "../src/lib/processListState";
// O App lê a cadência da lista em `processActions`. Copiar os números aqui era
// ter uma segunda resposta sobre o ritmo — só a rota de eventos é que é forçada.
import * as processActionsReal from "../src/lib/processActions";
import { normalizeProcessListResult } from "@cybersafe/shared-types";

// Executa o componente real e os seus efeitos com hooks determinísticos, sem
// DOM/Electron. Só as fronteiras (IPC, relógio e componentes filhos) são stubs.
// Remover a subscrição, setProtection(null), a guarda de geração ou a guarda
// do poll no App deve fazer falhar este teste, mesmo que o helper passe.
function appHarness(transformSource: (source: string) => string = (source) => source) {
  const cells: any[] = [];
  let cursor = 0, dirty = true, tree: any;
  const effects: (() => void)[] = [];
  const timers = new Map<number, () => void>();
  const intervals = new Map<number, () => unknown>();
  let timerId = 0;
  const listeners = new Set<(state: { connected: boolean }) => void>();
  let securityListener: ((event: any) => void) | undefined;
  let navigateListener: ((page: string) => void) | undefined;
  // Sequência de respostas de processes.list. O valor por omissão é o mesmo
  // de antes desta injecção: uma foto ok com zero linhas.
  let processesAnswer: any = {
    processes: [],
    truth: { state: "ok", enumeratedAt: Date.now(), servedFrom: "snapshot", attempt: null, asOf: Date.now() },
  };
  let connected = true;
  let enabled = true;
  let holdProtection: Promise<any> | null = null;
  const calls: string[] = [];
  const protection = () => ({
    status: "safe", protectionEnabled: enabled, engine: { serviceRunning: true },
    stats: { riskScore: 0, totalEvents: 0, highSeverityEvents: 0, quarantinedCount: 0 },
  });
  // `recusados` reproduz o gate de fixture: o pipe está ligado, o método existe,
  // e mesmo assim a resposta chega como rejeição com o texto do gate
  // (dev-fixture-gate.ts → service-client.ts:296 → ipc-guard.ts:17-25 → renderer).
  //
  // A forma NÃO é a do serviço, é a que a ponte entrega. `electron@33.4.11`
  // (`dist/electron.exe`) faz `throw new Error(\`Error invoking remote method
  // '${channel}': ${error}\`) no renderer, pelo que o Error original chega
  // PRECEDIDO de `Error: ` e o marcador do gate nunca está no início. Sem este
  // envolvente, a fake valida um estado que o Electron nunca produz.
  const CANAL_DA_PONTE: Readonly<Record<string, { canal: string; metodo: string }>> = {
    protection: { canal: "service:get-protection-state", metodo: "protection.getState" },
    events: { canal: "service:get-events", metodo: "events.list" },
    threats: { canal: "service:get-threats", metodo: "threats.list" },
    processes: { canal: "service:get-processes", metodo: "processes.list" },
    connections: { canal: "service:get-connections", metodo: "connections.list" },
    quarantine: { canal: "service:get-quarantine", metodo: "quarantine.list" },
    pcstate: { canal: "service:get-pcstate", metodo: "pcstate.get" },
  };
  const recusados = new Set<string>();
  const falhasReais = new Set<string>();
  const request = (name: string, value: () => any) => () => {
    calls.push(name);
    if (recusados.has(name)) {
      const ponte = CANAL_DA_PONTE[name];
      const motivo = new Error(`realdev_fixture_gate: "${ponte?.metodo ?? name}" não faz parte da sessão de fixture`);
      // Nome sem canal conhecido mantém a forma direta (não se inventa envolvente).
      return Promise.reject(
        ponte ? new Error(`Error invoking remote method '${ponte.canal}': ${motivo}`) : motivo,
      );
    }
    if (falhasReais.has(name)) {
      const ponte = CANAL_DA_PONTE[name];
      const erro = new Error("pipe fechado pelo serviço");
      return Promise.reject(
        ponte ? new Error(`Error invoking remote method '${ponte.canal}': ${erro}`) : erro,
      );
    }
    return connected ? Promise.resolve(value()) : Promise.reject(new Error("disconnected"));
  };
  const api = {
    getServiceConnectionState: async () => ({ connected }),
    onServiceConnectionState: (listener: (state: { connected: boolean }) => void) => {
      listeners.add(listener); return () => listeners.delete(listener);
    },
    getProtectionState: request("protection", () => holdProtection ?? protection()),
    getSecurityEvents: request("events", () => []),
    getThreatEvents: request("threats", () => []),
    // O contrato de processes.list traz a verdade da enumeração: uma lista sem
    // `truth` não é uma resposta possível neste mundo.
    getProcesses: request("processes", () => processesAnswer),
    getConnections: request("connections", () => []),
    getQuarantineFiles: request("quarantine", () => []),
    getPCState: request("pcstate", () => ({ findings: [] })),
    getHardwareSnapshot: request("hardware", () => ({ cpu: { usage: 2 }, ram: { usagePercent: 3 }, disk: {} })),
    onSecurityEvent: (listener: (event: any) => void) => { securityListener = listener; return () => { securityListener = undefined; }; },
    onNavigateRequest: (listener: (page: string) => void) => {
      navigateListener = listener;
      return () => { navigateListener = undefined; };
    },
  };
  const same = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial: any) {
      const i = cursor++;
      if (!cells[i]) cells[i] = { value: typeof initial === "function" ? initial() : initial };
      return [cells[i].value, (value: any) => {
        const next = typeof value === "function" ? value(cells[i].value) : value;
        if (!Object.is(next, cells[i].value)) { cells[i].value = next; dirty = true; }
      }];
    },
    useRef(value: any) { const i = cursor++; return cells[i] ??= { current: value }; },
    useMemo(fn: () => any, deps: any[]) {
      const i = cursor++;
      if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { value: fn(), deps };
      return cells[i].value;
    },
    useCallback(fn: any, deps: any[]) { return hooks.useMemo(() => fn, deps); },
    useEffect(fn: () => any, deps: any[]) {
      const i = cursor++;
      if (!cells[i] || !same(cells[i].deps, deps)) {
        const previous = cells[i]; cells[i] = { deps };
        effects.push(() => { previous?.cleanup?.(); cells[i].cleanup = fn(); });
      }
    },
    Component: class {},
  };
  const modules: Record<string, any> = {
    react: hooks,
    "react/jsx-runtime": { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) },
    "./contexts/AuthContext": { useAuth: () => ({ user: {}, logout() {} }) },
    "./contexts/AppearanceContext": { useAppearance: () => ({ identity: "cybersafe-core" }) },
    "./v2/theme-menu": { ThemeMenu: () => null },
    "./lib/protectionHealth": { deriveProtectionLevel },
    // Modulos REAIS (funcoes puras) pelos NOMES EXACTOS que o App importa.
    "./lib/progressiveRead": progressiveReadReal,
    "./lib/batteryDisplay": batteryDisplayReal,
    "./lib/cpuUsage": cpuUsageReal,
    "./lib/ramUsageDisplay": ramUsageReal,
    "./lib/networkReadings": networkReadingsReal,
    "./lib/toastCopy": toastCopyReal,
    "./lib/serviceSyncStatus": serviceSyncStatusReal,
    "./lib/processIntelligence": processIntelligence,
    "./lib/processMatrix": processMatrix,
    "./lib/loadingStates": { deriveLoadingState, BOOT_BODY_COPY, DEFAULT_STARTUP_TIMEOUT_MS },
    // P1-PROCESS-TRUTH: o App passou a importar uma FUNÇÃO de shared-types
    // (`normalizeProcessListResult`). Sem mapeamento, o Proxy do harness devolvia
    // uma string e o crash não tinha nada a ver com o que este teste analisa.
    "@cybersafe/shared-types": { normalizeProcessListResult },
    // Arranque: módulos REAIS, com o mesmo nome de especificador que o App usa.
    // Sem estas entradas o `require` cai no Proxy genérico e o nó fica com a
    // STRING "BootScreen" — verde falso, sem componente nenhum a correr.
    "./components/BootScreen": { BootScreen },
      "./components/AppTitleBar": { setTitlebarPageLabel: () => {}, AppTitleBar: () => null },
    "./lib/bootReadiness": bootReadinessReal,
    // P1-PROCESS-TRUTH: o App chama `instanteDeLeituraValida`; sem o módulo real
    // aqui o Proxy devolvia uma STRING e o teste rebentava longe do que analisa.
    "./lib/processListState": processListStateReal,
    "./lib/matrixContext": { buildMatrixContext: () => "" },
    "./lib/featureControl": { canUserAccess: () => true, FEATURES: {} },
    "./lib/onboarding": { hasSeenOnboarding: () => true },
    "@/lib/utils": { cn: () => "" },
    "@/lib/shutdownState": { isAppShuttingDown: () => false, ipcUnlessShuttingDown: (fn: () => any) => fn(), onAppShutdown: () => () => {} },
    "@/lib/processActions": { ...processActionsReal, resolveEventRefresh: () => "snapshot" },
    "@/components/TelemetrySparkline": { addTelemetrySample() {} },
    "framer-motion": { motion: { div: "motion.div" }, AnimatePresence: "AnimatePresence" },
  };
  const exports: any = {};
  const source = transformSource(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8")).replace(/import\.meta\.env\.DEV/g, "false");
  const code = ts.transpileModule(source + "\nexport { AuthenticatedApp };", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    require: (name: string) => {
      // Guarda de falso verde: um módulo de arranque sem mapeamento real lança
      // aqui, em vez de ser substituído por uma string.
      if (/BootScreen|bootReadiness/.test(name) && !(name in modules)) {
        throw new Error(`módulo de arranque sem mapeamento real no harness: ${name}`);
      }
      return modules[name] ?? new Proxy({ __esModule: true, default: name }, { get: (target: any, key) => target[key] ?? String(key) });
    },
    window: { electronAPI: api, addEventListener() {}, removeEventListener() {} },
    document: { visibilityState: "visible" }, console,
    setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: () => unknown) => { intervals.set(++timerId, fn); return timerId; },
    clearInterval: (id: number) => intervals.delete(id),
  });
  async function flush() {
    for (let i = 0; i < 8; i++) {
      if (dirty) { dirty = false; cursor = 0; tree = exports.AuthenticatedApp(); }
      effects.splice(0).forEach((fn) => fn());
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  const find = (node: any, type: string): any => {
    if (!node || typeof node !== "object") return;
    if (node.type === type) return node.props;
    for (const child of [node.props?.children].flat(Infinity)) { const found = find(child, type); if (found) return found; }
  };
  return {
    calls, flush,
    recusa(...nomes: string[]) { nomes.forEach((nome) => recusados.add(nome)); },
    falhaReal(...nomes: string[]) { nomes.forEach((nome) => falhasReais.add(nome)); },
    // Recuperação comprovada só existe se o ciclo voltar a pedir e a resposta
    // chegar bem: levantar a falha e depois `poll()` é o único caminho da UI.
    recuperar(...nomes: string[]) { nomes.forEach((nome) => falhasReais.delete(nome)); },
    temTexto(re: RegExp) {
      let achado = false;
      (function walk(node: any) {
        if (!node || typeof node !== "object" || achado) return;
        for (const child of [node.props?.children].flat(Infinity)) {
          if (typeof child === "string" && re.test(child)) { achado = true; return; }
          walk(child);
        }
      })(tree);
      return achado;
    },
    temBannerSync() {
      let achado = false;
      (function walk(node: any) {
        if (!node || typeof node !== "object" || achado) return;
        for (const child of [node.props?.children].flat(Infinity)) {
          if (typeof child === "string" && /sincronizar/i.test(child)) { achado = true; return; }
          walk(child);
        }
      })(tree);
      return achado;
    },
    // `boot()` = o arranque terminou: timers disparados e UMA volta do poller
    // existente. O hardware chega por esse poller (2 s), não por um pedido novo:
    // a prontidão exige uma leitura real, e o harness não a inventa.
    async boot() {
      await flush();
      timers.forEach((fn) => fn());
      timers.clear();
      await flush();
      await Promise.all([...intervals.values()].map((fn) => fn()));
      await flush();
    },
    async connection(value: boolean) { connected = value; listeners.forEach((fn) => fn({ connected })); await flush(); },
    setEnabled(value: boolean) { enabled = value; },
    hold(value: Promise<any> | null) { holdProtection = value; },
    event() { securityListener?.({ type: "protection.changed", sequence: 1 }); },
    async poll() { await Promise.all([...intervals.values()].map((fn) => fn())); await flush(); },
    dashboard: () => find(tree, "./pages/DashboardPage"),
    // O próprio nó do banner (role="alert") é o que permite distinguir «uma faixa»
    // de «duas faixas», e ler o que a faixa AFIRMA em vez de contar palavras soltas.
    alertas() {
      const nos: any[] = [];
      (function walk(node: any) {
        if (!node || typeof node !== "object") return;
        if (node.props?.role === "alert") nos.push(node);
        for (const child of [node.props?.children].flat(Infinity)) walk(child);
      })(tree);
      return nos;
    },
    // P1-PROCESS-TRUTH: o estado de frescura que o App entrega ao Gestor de
    // Tarefas — a prop, não o hook interno, é o contrato observável.
    taskManager: () => find(tree, "./pages/TaskManagerPage"),
    responderProcessos(answer: any) { processesAnswer = answer; },
    async navegar(page: string) { navigateListener?.(page); await flush(); },
    sidebar: () => find(tree, "./v2/LabSidebar"),
    scanner: () => find(tree, "./pages/FileScannerPage"),
    dispose() { cells.forEach((cell) => cell?.cleanup?.()); },
  };
}

async function verifyConnectionLifecycle(app: ReturnType<typeof appHarness>) {
  try {
    await app.boot();
    assert.equal(app.dashboard().realtime.enabled, true);
    assert.equal(app.dashboard().dashboard.riskScore, 100);
    let resolveOld!: (value: any) => void;
    app.hold(new Promise((resolve) => { resolveOld = resolve; }));
    app.event();
    await app.flush();
    await app.connection(false);
    assert.equal(app.dashboard().realtime.disponivel, false);
    assert.equal(app.dashboard().dashboard.riskScore, null);
    assert.equal(app.sidebar().level, "critical");
    const count = app.calls.length;
    await app.poll();
    assert.equal(app.calls.length, count, "polls não chegam ao serviço indisponível");
    resolveOld({ status: "safe", protectionEnabled: true, engine: { serviceRunning: true }, stats: { riskScore: 0 } });
    await app.flush();
    assert.equal(app.dashboard().dashboard.riskScore, null, "resposta pré-queda nunca restaura ON");
    app.hold(null);
    app.setEnabled(false);
    await app.connection(true);
    assert.equal(app.dashboard().realtime.enabled, false, "reconexão mostra OFF real");
    assert.ok(app.calls.length > count, "recuperação pediu um snapshot novo");
  } finally { app.dispose(); }
}

test("App invalida ON na queda, rejeita snapshot antigo e suspende polls; recuperação relê OFF", async () => {
  await verifyConnectionLifecycle(appHarness());
});
test("Dashboard navigation clears any previous scan intent without starting a scan",async()=>{
 const app=appHarness();try{await app.boot();app.dashboard().onScan('full');await app.flush();assert.equal(app.scanner().pendingScan.type,'full');await app.navegar('dashboard');app.dashboard().onOpenScanner();await app.flush();assert.equal(app.scanner().pendingScan,null);assert.equal(app.calls.filter(x=>x==='scan.start').length,0);}finally{app.dispose();}
});

test("controlo negativo: reintroduzir proteção congelada faz a regressão falhar", async () => {
  // Mutação apenas em memória: nunca modifica o App em disco.
  await assert.rejects(() => verifyConnectionLifecycle(appHarness((source) => source.replaceAll("setProtection(null);", ""))), assert.AssertionError);
});

const SNAPSHOT = ["protection", "events", "threats", "processes", "connections", "quarantine", "pcstate"];

// O que segue fixa a distinção que o ciclo de sync não fazia: o gate de fixture
// recusa rotinas DE PROPÓSITO, com o pipe ligado; isso não é uma avaria de
// sincronização, e não pode apagar o que as outras leituras trouxeram.
test("recusas do gate de fixture não são apresentadas como falha de sincronização", async () => {
  const app = appHarness();
  try {
    app.recusa(...SNAPSHOT);
    await app.boot();
    assert.equal(app.temBannerSync(), false, "o serviço está ligado e recusou por política; a UI não pode dizer «não foi possível sincronizar»");
    for (const nome of SNAPSHOT) {
      assert.ok(app.calls.includes(nome), `a recusa de um método não pode suprimir o pedido dos outros (${nome})`);
    }
  } finally { app.dispose(); }
});

test("com uma rotina recusada e as restantes a responder, o snapshot aplicado é o que veio", async () => {
  const app = appHarness();
  try {
    app.recusa("protection");
    await app.boot();
    assert.equal(app.temBannerSync(), false, "uma recusa isolada não é falha de sincronização");
    assert.ok(
      SNAPSHOT.filter((nome) => nome !== "protection").every((nome) => app.calls.includes(nome)),
      "as leituras que o gate não recusa continuam a ser pedidas",
    );
  } finally { app.dispose(); }
});

test("controlo anti-mascaração: uma falha REAL continua a marcar a sincronização", async () => {
  const app = appHarness();
  try {
    app.falhaReal("processes");
    await app.boot();
    assert.equal(app.temBannerSync(), true, "um erro que não vem do gate não pode ser engolido pelas recusas");
  } finally { app.dispose(); }
});

test("controlo de mutação: sem a faixa, a falha real volta a existir só na consola", async () => {
  // Mutação só em memória. `falhaSyncVisivel` é o que liga o `error` do ciclo de
  // sync ao banner: neutralizá-lo tem de apagar a bandeira, porque o
  // `deriveLoadingState` fica em READY enquanto a proteção respondeu.
  await assert.rejects(async () => {
    const app = appHarness((source) => source.replace('error.trim() !== ""', "false"));
    try {
      app.falhaReal("processes");
      await app.boot();
      assert.equal(app.temBannerSync(), true, "a visibilidade depende de `falhaSyncVisivel`");
    } finally { app.dispose(); }
  }, assert.AssertionError);
});

test("controlo negativo: substituir a decisão do App por `false` engole a falha real", async () => {
  // Mutação só em memória. Se este teste deixar de falhar, a bandeira deixou de
  // depender de `resumo.deveMarcarFalhaSync` e o teste anterior passou a mentir.
  await assert.rejects(async () => {
    const app = appHarness((source) => source.replaceAll("resumo.deveMarcarFalhaSync", "false"));
    try {
      app.falhaReal("processes");
      await app.boot();
      assert.equal(app.temBannerSync(), true);
    } finally { app.dispose(); }
  }, assert.AssertionError);
});

// ── REFUSED: o estado explícito da recusa tem de sair do App, não só do helper ──
test("recusa pura: banner próprio, sem spinner, sem vermelho, sem botão que prometa o impossível", async () => {
  const app = appHarness();
  try {
    app.recusa(...SNAPSHOT);
    await app.boot();
    assert.equal(app.temTexto(/Rotinas fora do âmbito desta sessão/), true, "o App tem de renderizar o estado REFUSED");
    assert.equal(app.temTexto(/Não foi possível sincronizar/), false, "recusa não é avaria");
    assert.equal(app.temTexto(/Tentar novamente/), false, "repetir não levanta o gate; não se oferece botão vazio");
  } finally { app.dispose(); }
});

test("misto: com proteção confirmada, a recusa das outras rotinas não sobrepõe o estado lido", async () => {
  const app = appHarness();
  try {
    app.recusa("events", "threats", "processes", "connections", "quarantine", "pcstate");
    await app.boot();
    assert.equal(app.temTexto(/Rotinas fora do âmbito desta sessão/), false, "há leitura confirmada: o estado é o da leitura");
    assert.equal(app.temBannerSync(), false);
    assert.equal(app.dashboard().dashboard.riskScore, 100, "a proteção que respondeu é aplicada");
  } finally { app.dispose(); }
});

test("normal: sem recusas nem falhas, nenhum banner de estado é desenhado", async () => {
  const app = appHarness();
  try {
    await app.boot();
    assert.equal(app.temTexto(/Rotinas fora do âmbito desta sessão/), false);
    assert.equal(app.temBannerSync(), false);
  } finally { app.dispose(); }
});

test("controlo negativo: desligar o feed de recusas no App faz o estado REFUSED desaparecer", async () => {
  await assert.rejects(async () => {
    const app = appHarness((source) => source.replaceAll("setSyncRecusas(resumo.recusas)", "setSyncRecusas(0)"));
    try {
      app.recusa(...SNAPSHOT);
      await app.boot();
      assert.equal(app.temTexto(/Rotinas fora do âmbito desta sessão/), true);
    } finally { app.dispose(); }
  }, assert.AssertionError);
});


// ── Arranque: o harness tem de correr os módulos REAIS, não um Proxy ──
test("harness resolve o arranque real (componente + política), sem falso verde", () => {
  const fonte = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(fonte, /from "\.\/components\/BootScreen"/, "o App importa o componente extraído");
  assert.match(fonte, /from "\.\/lib\/bootReadiness"/, "o App importa a política pura");
  assert.equal(typeof BootScreen, "function", "o componente mapeado é o real");
  assert.equal(typeof bootReadinessReal.deriveBootReadiness, "function", "a política mapeada é a real");
});

test("controlo negativo: specifier de arranque sem mapeamento lança, não dá verde", () => {
  assert.throws(
    () => appHarness((source) => source.replace("from \"./components/BootScreen\"", "from \"./components/BootScreenExtraido\"")),
    /módulo de arranque sem mapeamento real/,
    "sem a guarda, o import cairia no Proxy e o teste ficaria verde sem componente",
  );
});
// ── P1-PROCESS-TRUTH BUG B: uma leitura sem frescura LIMPA a marca anterior ──
//
// A correção é uma linha em App.tsx (`setProcessesObservedAt` incondicional).
// Antes dela, `ok` → `unreported` conservava o instante da foto antiga, e
// `listaDesactualizada` dizia «nada antigo» sobre linhas cuja idade já ninguém
// afirmava. Este caso é o que faltava: corre o App real e lê a prop que chega
// à página.
const LEITURA_OK = {
  processes: [{ pid: 4242, name: "canario.exe" }, { pid: 4243, name: "canario2.exe" }],
  truth: {
    state: "ok",
    enumeratedAt: 1_700_000_000_000,
    servedFrom: "snapshot",
    attempt: { startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_001, ok: true },
    asOf: 1_700_000_000_002,
  },
};
const LEITURA_SEM_CONTRATO = {
  processes: [{ pid: 4242, name: "canario.exe" }, { pid: 4243, name: "canario2.exe" }],
  truth: {
    state: "unreported",
    enumeratedAt: null,
    servedFrom: "cache",
    attempt: null,
    asOf: 1_700_000_000_500,
  },
};

async function cicloOkSemContrato(app: ReturnType<typeof appHarness>) {
  try {
    app.responderProcessos(LEITURA_OK);
    await app.boot();
    await app.navegar("taskmanager");
    const primeira = app.taskManager();
    assert.ok(primeira, "o Gestor de Tarefas tem de estar montado");
    assert.equal(primeira.processesObservedAt, 1_700_000_000_000, "com foto ok a marca é a da foto");
    assert.equal(primeira.processTruth.state, "ok");

    // A leitura seguinte perde o contrato de frescura (serviço reiniciado ou
    // boot anterior): as linhas continuam, a idade deixa de ser afirmável.
    app.responderProcessos(LEITURA_SEM_CONTRATO);
    await primeira.onRefreshProcesses();
    await app.flush();

    const segunda = app.taskManager();
    assert.equal(segunda.processTruth.state, "unreported");
    assert.equal(segunda.processes.length, 2, "as linhas vistas não são apagadas por falta de frescura");
    assert.equal(
      segunda.processesObservedAt,
      null,
      "uma resposta sem instante válido tem de LIMPAR a marca anterior",
    );
    assert.equal(
      processListStateReal.listaDesactualizada({
        total: segunda.processes.length,
        servicoLigado: true,
        observadoEm: segunda.processesObservedAt,
      }),
      true,
      "com linhas em ecrã e sem instante afirmado, a lista tem de ser dita antiga",
    );
  } finally { app.dispose(); }
}

test("P1 BUG B: unreported depois de ok limpa processesObservedAt e marca a lista antiga", async () => {
  await cicloOkSemContrato(appHarness());
});

test("controlo negativo (BUG B): repor a guarda antiga conserva o timestamp e falha", async () => {
  // Mutação só em memória: a forma pré-correção tinha `if (observedAt !== null)`.
  await assert.rejects(
    () => cicloOkSemContrato(appHarness((source) => source.replace(
      "setProcessesObservedAt(observedAt);",
      "if (observedAt !== null) setProcessesObservedAt(observedAt);",
    ))),
    // Específico de propósito: tem de rebentar na limpeza da marca (a resposta
    // sem contrato conserva o instante antigo), não numa asserção anterior.
    (error: any) => error?.code === "ERR_ASSERTION" && /LIMPAR a marca anterior/.test(String(error.message)),
  );
});

// Requisitos que o Codex impôs à faixa do App (decisão de 2026-10-27): mostrar o
// erro real, não duplicar ERROR/UNAVAILABLE, desaparecer após recuperação
// comprovada e não afirmar que a proteção ou as outras leituras estão prontas.
// Lidos no nó `role="alert"`, não em palavras soltas da árvore.
function textosDe(node: any): string[] {
  if (typeof node === "string") return [node];
  if (!node || typeof node !== "object") return [];
  const out: string[] = [];
  for (const child of [node.props?.children].flat(Infinity)) out.push(...textosDe(child));
  return out;
}

/** Clica o primeiro botão dentro de um nó — o caminho do utilizador, não atalhos. */
function clicarBotao(node: any) {
  let botao: any;
  (function walk(n: any) {
    if (!n || typeof n !== "object" || botao) return;
    if (n.type === "button") botao = n;
    for (const child of [n.props?.children].flat(Infinity)) walk(child);
  })(node);
  assert.ok(botao, "a faixa de avaria tem de oferecer o botão de repetição");
  botao.props.onClick();
}

test("a faixa mostra o erro que o ciclo de sync registou, e só uma faixa", async () => {
  const app = appHarness();
  try {
    app.falhaReal("processes");
    await app.boot();
    const alertas = app.alertas();
    assert.equal(alertas.length, 1, `esperava exatamente 1 banner de avaria, vieram ${alertas.length}`);
    const texto = textosDe(alertas[0]).join(" ");
    // A frase é a que App.tsx escreve no estado `error` quando `deveMarcarFalhaSync`
    // se levanta — não uma copy genérica escolhida à mão na camada de exibição.
    assert.match(texto, /Falha ao sincronizar com o serviço\./);
    assert.match(texto, /Tentar novamente/, "a avaria admite repetição; esconder o pedido seria pior");
  } finally { app.dispose(); }
});

test("a faixa não duplica quando o loadingState já está em ERROR", async () => {
  const app = appHarness();
  try {
    // Proteção também falha → `deriveLoadingState` cai no ramo de erro e mostra a
    // sua própria faixa. A do `error` tem de se calar: duas faixas para um problema.
    app.falhaReal("processes", "protection");
    await app.boot();
    assert.equal(app.alertas().length, 1, "ERROR do contrato e faixa do sync não podem montar as duas");
  } finally { app.dispose(); }
});

test("a faixa não afirma prontidão da proteção nem das outras leituras", async () => {
  const app = appHarness();
  try {
    app.falhaReal("connections");
    await app.boot();
    const texto = textosDe(app.alertas()[0]).join(" ");
    assert.doesNotMatch(texto, /pronto|prontid|tudo (bem|ok|a funcionar)|sem problemas/i,
      "uma faixa de avaria não pode dizer que o resto está bem");
  } finally { app.dispose(); }
});

test("a faixa fecha com a repetição que ela própria oferece, quando esta responde bem", async () => {
  const app = appHarness();
  try {
    app.falhaReal("processes");
    await app.boot();
    assert.equal(app.alertas().length, 1, "a avaria tem de estar visível antes de se poder fechar");
    const antes = app.calls.length;
    app.recuperar("processes");
    // Não é `setError("")` à mão: é o botão «Tentar novamente» da faixa a chamar o
    // ciclo completo. A recuperação fica provada pela relê, não declarada.
    clicarBotao(app.alertas()[0]);
    await app.flush();
    await app.flush();
    assert.ok(app.calls.length > antes, "a repetição tinha de voltar a pedir as leituras ao serviço");
    assert.equal(app.alertas().length, 0, "ciclo completo respondido: a faixa tem de sair");
    assert.equal(app.temBannerSync(), false);
  } finally { app.dispose(); }
});

test("o poll de processes, sozinho, não pode dar a sincronização por recuperada", async () => {
  // `refreshProcesses` engole a falha de propósito (a lista anterior fica no
  // ecrã) e nunca escreve `error`: um poll bem sucedido prova um canal, não os
  // sete. Se algum dia o poll passar a limpar a faixa, este teste falha — e é
  // mesmo essa a afirmação que se quer ver rebentar.
  const app = appHarness();
  try {
    app.falhaReal("processes");
    await app.boot();
    const antes = app.calls.length;
    app.recuperar("processes");
    await app.poll();
    assert.ok(app.calls.length > antes, "o poll tinha de correr");
    assert.equal(app.alertas().length, 1, "prova de um canal não é prova do ciclo de sync");
  } finally { app.dispose(); }
});
test("Scanner receives the real current engine snapshot and loses it offline", async () => {
  const app = appHarness();
  try {
    await app.boot();
    await app.navegar("scanner");
    assert.equal(app.scanner().serviceConnected, true);
    assert.equal(app.scanner().engineHealth?.serviceRunning, true);
    await app.connection(false);
    assert.equal(app.scanner().serviceConnected, false);
    assert.equal(app.scanner().engineHealth, undefined);
  } finally { app.dispose(); }
});
