/**
 * MEDICAO DO BURST DE ARRANQUE (cold start) do ProcessMonitor.
 *
 * Propósito: medir e provar a CAUSA do spam "PROCESSO INICIADO / opera.exe"
 * visto no Monitor de Rede, e verificar que o fix a elimina.
 *
 * MÉTRICAS POR CAMADA
 * -------------------
 * RAW_MONITOR_EVENTS  — eventos "process.started" emitidos pelo ProcessMonitor
 *                       (a fonte: diff sobre CIM; ETW é stub → RAW_ETW = 0)
 * UNIQUE_PIDS         — PIDs distintos nos eventos RAW
 * DUPLICATE_PID_EVENTS— eventos com PID repetido no mesmo burst (mesmo PID >1x)
 * BUS_EVENTS          — publishs que chegariam ao SecurityEventBus
 *                       (= RAW_MONITOR_EVENTS que passariam o gate shouldScan,
 *                        simulado aqui sem lançar um engine completo)
 * UI_EVENTS           — BUS_EVENTS depois do cap getReplay(limit=100)
 *
 * CAUSA CANDIDATA 1 (burst de arranque)
 * previous começa vazio → primeiro poll anuncia TODOS os processos vivos
 * como "nascidos agora". Com opera.exe a ter dezenas de helpers, isso são
 * dezenas de events que passam o gate (opera.exe não está em SAFE_PROCESSES).
 *
 * CAUSA CANDIDATA 2 (PIDs distintos legítimos do Opera)
 * Cada helper do Opera tem PID diferente — não é deduplicação por nome que
 * vai resolver isto. O fix certo é semear previous no primeiro poll.
 *
 * O teste corre nos dois modos (antes e depois do fix) através de um flag
 * injectado no seam do ProcessMonitor.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProcessMonitor } from "../dist/index.js";

// SAFE_PROCESSES conhecidos do engine (simulamos o gate sem importar service)
const SAFE_PROCESSES = new Set([
  "powershell.exe", "pwsh.exe", "cmd.exe", "conhost.exe", "explorer.exe",
  "svchost.exe", "csrss.exe", "lsass.exe", "services.exe", "smss.exe",
  "wininit.exe", "winlogon.exe", "dwm.exe", "taskhostw.exe", "sihost.exe",
  "fontdrvhost.exe", "runtimebroker.exe", "searchhost.exe",
  "startmenuexperiencehost.exe", "textinputhost.exe", "ctfmon.exe",
  "dllhost.exe", "msiexec.exe", "audiodg.exe", "spoolsv.exe",
  "searchindexer.exe", "securityhealthservice.exe",
  "msedge.exe", "chrome.exe", "firefox.exe",
  "code.exe", "node.exe", "tsx.exe", "electron.exe", "vite.exe",
  "npm.cmd", "npx.cmd", "git.exe", "wt.exe", "windowsterminal.exe",
  "systemsettings.exe", "taskmgr.exe", "devenv.exe", "msbuild.exe",
]);

function isSafe(name) {
  return SAFE_PROCESSES.has(name.toLowerCase());
}

/** Cria um mapa de processos como o seam do poll usa. */
function world(entries) {
  return new Map(
    entries.map(([pid, name]) => [
      pid,
      {
        pid,
        name,
        commandLine: name,
        user: undefined,
        cpu: 0,
        memoryMb: 0,
        path: "",
        ppid: 0,
        startedAt: new Date().toISOString(),
      },
    ]),
  );
}

/**
 * Simula um arranque frio com N processos de opera.exe (PIDs distintos)
 * mais alguns processos seguros de background.
 *
 * Devolve as métricas por camada.
 */
async function measureColdStart(operaHelperCount) {
  // Processos presentes NO ARRANQUE (já existiam antes do monitor)
  const operaHelpers = Array.from({ length: operaHelperCount }, (_, i) => [
    10000 + i,
    "opera.exe",
  ]);
  const safeBackground = [
    [100, "svchost.exe"],
    [200, "explorer.exe"],
    [300, "conhost.exe"],
    [400, "dwm.exe"],
    [500, "runtimebroker.exe"],
    [600, "searchhost.exe"],
  ];
  const allBootProcesses = [...safeBackground, ...operaHelpers];

  const monitor = new ProcessMonitor(async () => world(allBootProcesses));

  const rawEvents = [];
  monitor.on("process.started", (p) => rawEvents.push({ pid: p.pid, name: p.name }));

  // Simula o start() do ProcessMonitor: chama poll() com previous vazio
  await monitor.poll();

  const RAW_MONITOR_EVENTS = rawEvents.length;
  const UNIQUE_PIDS = new Set(rawEvents.map((e) => e.pid)).size;
  const pidCounts = new Map();
  for (const e of rawEvents) {
    pidCounts.set(e.pid, (pidCounts.get(e.pid) ?? 0) + 1);
  }
  const DUPLICATE_PID_EVENTS = rawEvents.filter((e) => pidCounts.get(e.pid) > 1).length;

  // Gate simulado: apenas processos que NÃO são safe chegam ao BUS
  const busEvents = rawEvents.filter((e) => !isSafe(e.name));
  const BUS_EVENTS = busEvents.length;

  // UI cap: getReplay(limit=100)
  const UI_EVENTS = Math.min(BUS_EVENTS, 100);

  return {
    RAW_MONITOR_EVENTS,
    UNIQUE_PIDS,
    DUPLICATE_PID_EVENTS,
    BUS_EVENTS,
    UI_EVENTS,
    safeFiltered: RAW_MONITOR_EVENTS - BUS_EVENTS,
  };
}

/**
 * Simula um arranque APÓS o fix: primeiro poll semeia previous sem emitir,
 * apenas o segundo poll (com novos processos) emite events.
 *
 * Modelo esperado: RAW_MONITOR_EVENTS = 0 para processos que já existiam,
 * só processos que NASCEM depois do arranque geram eventos.
 */
async function measureColdStartPostFix(operaHelperCount) {
  const operaHelpers = Array.from({ length: operaHelperCount }, (_, i) => [
    10000 + i,
    "opera.exe",
  ]);
  const safeBackground = [
    [100, "svchost.exe"],
    [200, "explorer.exe"],
    [300, "conhost.exe"],
  ];
  const allBootProcesses = [...safeBackground, ...operaHelpers];

  // Após o fix, o primeiro poll semeia previous SEM emitir
  const monitor = new ProcessMonitor(async () => world(allBootProcesses));
  const rawEvents = [];
  monitor.on("process.started", (p) => rawEvents.push({ pid: p.pid, name: p.name }));

  // POST-FIX: primeiro poll = seed only, sem emissão
  // (Testamos o comportamento do fix: poll() com seedOnly=true)
  await monitor.seedOnly();   // método a adicionar pelo fix

  // Segundo poll: sem mudanças → silêncio
  await monitor.poll();

  const RAW_AFTER_SEED = rawEvents.length;

  // Agora um processo NOVO nasce
  const newPid = 99999;
  const newName = "opera.exe";
  const withNew = new Map([
    ...world(allBootProcesses).entries(),
    [newPid, { pid: newPid, name: newName, commandLine: newName, user: undefined, cpu: 0, memoryMb: 0, path: "", ppid: 0, startedAt: new Date().toISOString() }],
  ]);
  monitor.snapshot = async () => withNew;
  await monitor.poll();

  const newEvents = rawEvents.filter((e) => e.pid === newPid);

  return {
    RAW_AFTER_SEED,        // deve ser 0 (sem burst de arranque)
    NEW_PROCESS_DETECTED: newEvents.length, // deve ser 1 (detecta processos realmente novos)
  };
}

describe("MEDICAO DO BURST — arranque frio do ProcessMonitor", () => {
  it("BASELINE (sem fix): mede as metricas do burst com 30 helpers do opera.exe", async () => {
    const metrics = await measureColdStart(30);

    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║  BURST BASELINE — 30 helpers opera.exe (cold start)     ║");
    console.log("╠══════════════════════════════════════════════════════════╣");
    console.log(`║  RAW_MONITOR_EVENTS  = ${String(metrics.RAW_MONITOR_EVENTS).padStart(4)}  (todos os PIDs novos vistos)  ║`);
    console.log(`║  UNIQUE_PIDS         = ${String(metrics.UNIQUE_PIDS).padStart(4)}  (PIDs distintos)              ║`);
    console.log(`║  DUPLICATE_PID_EVENTS= ${String(metrics.DUPLICATE_PID_EVENTS).padStart(4)}  (mesmo PID >1x)               ║`);
    console.log(`║  BUS_EVENTS          = ${String(metrics.BUS_EVENTS).padStart(4)}  (passaram o gate shouldScan)  ║`);
    console.log(`║  UI_EVENTS           = ${String(metrics.UI_EVENTS).padStart(4)}  (cap getReplay limit=100)     ║`);
    console.log(`║  safe_filtered       = ${String(metrics.safeFiltered).padStart(4)}  (descartados como seguros)    ║`);
    console.log("╠══════════════════════════════════════════════════════════╣");
    console.log("║  ROOT CAUSE: previous vazio → todos os PIDs existentes  ║");
    console.log("║  no boot aparecem como 'started'. Opera.exe não está    ║");
    console.log("║  em SAFE_PROCESSES → passa o gate → chega ao BUS/UI.    ║");
    console.log("╚══════════════════════════════════════════════════════════╝\n");

    // PROVAS DA CAUSA
    // 1. Todos os 30 opera + 6 safe foram anunciados no primeiro poll
    assert.equal(
      metrics.RAW_MONITOR_EVENTS,
      36,   // 30 opera + 6 safe
      "primeiro poll com previous vazio anuncia TODOS os processos existentes",
    );
    // 2. PIDs únicos (sem duplicados reais — cada PID só sai 1x por poll)
    assert.equal(metrics.UNIQUE_PIDS, metrics.RAW_MONITOR_EVENTS, "cada PID sai exactamente 1x por poll");
    assert.equal(metrics.DUPLICATE_PID_EVENTS, 0, "nao ha mesmo PID publicado >1x no mesmo poll");
    // 3. Opera passa o gate (30 eventos chegam ao bus)
    assert.equal(metrics.BUS_EVENTS, 30, "opera.exe nao e safe → 30 eventos chegam ao bus");
    // 4. UI cap limita a 100 (aqui 30 < 100, todos chegam)
    assert.equal(metrics.UI_EVENTS, 30, "30 < cap de 100 → todos chegam ao renderer");
    // 5. Causa confirmada: nao e duplicacao por PID, e burst de arranque
    assert.equal(metrics.DUPLICATE_PID_EVENTS, 0, "causa NAO e duplicacao de PID: cada PID e distinto");
  });

  it("BASELINE: 80 helpers do opera.exe ultrapassam o cap UI de 100 apenas se safe_bg tambem passa", async () => {
    const metrics = await measureColdStart(80);

    console.log(`\nBASELINE 80 helpers: RAW=${metrics.RAW_MONITOR_EVENTS} BUS=${metrics.BUS_EVENTS} UI=${metrics.UI_EVENTS}`);

    assert.equal(metrics.RAW_MONITOR_EVENTS, 86); // 80 + 6 safe
    assert.equal(metrics.BUS_EVENTS, 80, "80 opera → 80 bus events");
    assert.equal(metrics.UI_EVENTS, 80, "80 < 100 → todos chegam");
    assert.equal(metrics.DUPLICATE_PID_EVENTS, 0, "sem duplicados de PID");
  });

  it("BASELINE: 110 helpers excedem o cap UI de 100 (renderer trunca)", async () => {
    const metrics = await measureColdStart(110);

    console.log(`\nBASELINE 110 helpers: RAW=${metrics.RAW_MONITOR_EVENTS} BUS=${metrics.BUS_EVENTS} UI=${metrics.UI_EVENTS}`);

    assert.equal(metrics.BUS_EVENTS, 110, "110 opera → 110 bus events (bus nao tem cap aqui)");
    assert.equal(metrics.UI_EVENTS, 100, "cap UI de 100 trunca: renderer ve apenas 100 dos 110");
  });

  it("BASELINE: segundo poll sem mudancas e silencioso (nao re-emite)", async () => {
    const operaHelpers = Array.from({ length: 30 }, (_, i) => [10000 + i, "opera.exe"]);
    const monitor = new ProcessMonitor(async () => world(operaHelpers));
    const started = [];
    monitor.on("process.started", (p) => started.push(p.pid));

    await monitor.poll(); // primeiro: 30 eventos (burst de arranque)
    const afterFirst = started.length;
    await monitor.poll(); // segundo: silencio (previous == current)
    const afterSecond = started.length;

    assert.equal(afterFirst, 30, "primeiro poll: 30 eventos");
    assert.equal(afterSecond, 30, "segundo poll sem mudancas: silencio total");
    console.log(`\nSEGUNDO POLL SEM MUDANCAS: RAW=${afterFirst - afterSecond} (silencio confirmado)`);
  });
});

describe("MEDICAO POS-FIX — arranque frio com seedOnly", () => {
  it("POST-FIX: primeiro poll semeia previous SEM emitir (burst = 0)", async () => {
    // Verifica que o metodo seedOnly() existe (adicionado pelo fix)
    const monitor = new ProcessMonitor(async () => world([[10000, "opera.exe"], [10001, "opera.exe"]]));
    assert.equal(
      typeof monitor.seedOnly,
      "function",
      "ProcessMonitor.seedOnly() deve existir apos o fix",
    );
  });

  it("POST-FIX: seedOnly() + poll() = 0 RAW_EVENTS para processos do boot", async () => {
    const metrics = await measureColdStartPostFix(30);

    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║  BURST POS-FIX — 30 helpers opera.exe                  ║");
    console.log("╠══════════════════════════════════════════════════════════╣");
    console.log(`║  RAW_AFTER_SEED      = ${String(metrics.RAW_AFTER_SEED).padStart(4)}  (deve ser 0)                  ║`);
    console.log(`║  NEW_PROCESS_DETECTED= ${String(metrics.NEW_PROCESS_DETECTED).padStart(4)}  (deve ser 1)                  ║`);
    console.log("╚══════════════════════════════════════════════════════════╝\n");

    assert.equal(metrics.RAW_AFTER_SEED, 0, "seedOnly nao emite: burst de arranque = 0");
    assert.equal(metrics.NEW_PROCESS_DETECTED, 1, "processos que nascem DEPOIS do arranque continuam a ser detetados");
  });
});


describe("CONTRATO start() — cold start vs restart", () => {
  it("1. cold start: previous vazio => seedOnly, zero process.started emitidos", async () => {
    // Confirma o fix original: arranque frio não faz burst.
    const boot = Array.from({ length: 10 }, (_, i) => [1000 + i, "opera.exe"]);
    const monitor = new ProcessMonitor(async () => world(boot));
    const started = [];
    monitor.on("process.started", (p) => started.push(p.pid));

    // previous está vazio antes de start() — caso de cold start
    assert.equal(monitor.previous.size, 0, "pré-condição: previous vazio");
    await monitor.start();
    await monitor.stop();

    assert.equal(started.length, 0, "cold start não emite nenhum process.started");
    assert.equal(monitor.previous.size, 10, "previous fica semeado com os 10 processos");
  });

  it("2. restart: previous preenchido → stop → novos processos → start => só os novos são anunciados", async () => {
    // Simula OFF→ON: a proteção esteve desligada e entretanto nasceram processos novos.
    const initial = Array.from({ length: 5 }, (_, i) => [2000 + i, "base.exe"]);
    let snapshot = world(initial);
    const monitor = new ProcessMonitor(async () => snapshot);
    const started = [];
    monitor.on("process.started", (p) => started.push(p.pid));

    // Cold start semeia previous sem emitir
    await monitor.start();
    await monitor.stop();
    assert.equal(started.length, 0, "cold start silencioso");
    assert.equal(monitor.previous.size, 5, "previous tem os 5 processos base");

    // Enquanto a proteção esteve desligada, nasceram 3 processos novos
    const withNew = new Map([
      ...world(initial).entries(),
      ...world([[3000, "novo1.exe"], [3001, "novo2.exe"], [3002, "novo3.exe"]]).entries(),
    ]);
    snapshot = withNew;

    // Restart: previous não está vazio → poll() normal
    assert.ok(monitor.previous.size > 0, "pré-condição: previous não vazio antes do restart");
    await monitor.start();
    await monitor.stop();

    assert.equal(started.length, 3, "restart anuncia exactamente os 3 processos que nasceram enquanto estava off");
    const announcedPids = new Set(started);
    assert.ok(announcedPids.has(3000), "novo1.exe anunciado");
    assert.ok(announcedPids.has(3001), "novo2.exe anunciado");
    assert.ok(announcedPids.has(3002), "novo3.exe anunciado");
    // Os 5 processos base NÃO são re-anunciados
    for (const pid of [2000, 2001, 2002, 2003, 2004]) {
      assert.ok(!announcedPids.has(pid), `base pid ${pid} não deve ser re-anunciado`);
    }
  });

  it("3. regressão: restart sem mudanças => 0 process.started (sem re-emissão total)", async () => {
    // Garante que um restart com o mesmo conjunto de processos é silencioso.
    const procs = Array.from({ length: 8 }, (_, i) => [4000 + i, "steady.exe"]);
    const monitor = new ProcessMonitor(async () => world(procs));
    const started = [];
    monitor.on("process.started", (p) => started.push(p.pid));

    await monitor.start();  // cold start: semeia, 0 eventos
    await monitor.stop();
    assert.equal(started.length, 0, "cold start silencioso");

    await monitor.start();  // restart sem mudanças: poll(), mas diff vazio
    await monitor.stop();
    assert.equal(started.length, 0, "restart sem mudanças não re-emite nada");
  });
});