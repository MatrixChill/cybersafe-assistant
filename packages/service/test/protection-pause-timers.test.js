import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ProtectionEngineService } from "../dist/engine.js";

/**
 * P0 — PAUSA/DESLIGAR NÃO INVENTA SUCESSO, E OS TIMERS NÃO SOBEM VIVOS.
 *
 * Estes testes prendem o contrato que a tray depende para truthful: o que o
 * motor devolve tem de ser o que aconteceu, e uma pausa agendada tem de
 * morrer quando o utilizador manda parar.
 *
 * ── Bug 1 (MEDIDO antes da correcção) ─────────────────────────────────────
 * `stopProtection()` tinha um atalho "já está tudo parado" que ignorava o
 * timer de retomada. Num motor que já estava parado, `pauseProtection(15min)`
 * agendava a retomada e o `stopProtection()` seguinte devolvia pelo atalho
 * SEM cancelar o timer — a proteção voltava sozinha ao fim dos 15 minutos
 * depois de o utilizador a ter desligado. Probe: "timer after stop = VIVO".
 *
 * ── Bug 2 (regra de produto) ──────────────────────────────────────────────
 * `pauseProtection()` tem de recusar fabricar uma pausa quando a paragem
 * falha. Mesmo que a paragem devolva `protectionEnabled: true`, o prazo
 * tem de ser `null`: um prazo inventado aparece na tray como "pausada até
 * daqui a 15 min" quando nada foi agendado.
 *
 * Não se chama `init()`: o teste corre contra o motor sem watcher/ETW, sem
 * handles de sistema. É a mesma razão de shutdown.test.js — um init() pesado
 * a competir com testes que têm deadline é o que os fazia falhar 2 em 2.
 */

const TEST_BASE_DIR = mkdtempSync(path.join(os.tmpdir(), "cybersafe-pause-timers-"));
const MIN = 60_000;

let engine = null;

function freshEngine() {
  engine = new ProtectionEngineService(TEST_BASE_DIR);
  return engine;
}

/** O timer é `private` no TS mas é uma propriedade normal em runtime. */
function timerAlive(e) {
  return e.protectionResumeTimer !== null && e.protectionResumeTimer !== undefined;
}

afterEach(async () => {
  if (engine) {
    await engine.dispose().catch(() => {});
    engine = null;
  }
});

describe("pausa — o prazo devolvido é o prazo agendado", () => {
  it("pausar 15 min agenda a retomada e devolve um prazo real no futuro", async () => {
    const e = freshEngine();
    const antes = Date.now();
    const r = await e.pauseProtection(15 * MIN);

    assert.equal(r.ok, true);
    // Pausar NUNCA devolve proteção ligada: o motor está parado durante a pausa.
    assert.equal(r.protectionEnabled, false, "a pausa não pode dizer que a proteção está ligada");
    assert.ok(r.pausedUntil, "pausa com duração tem de devolver o prazo");
    const t = new Date(r.pausedUntil).getTime();
    assert.ok(t > antes, "o prazo tem de estar no futuro");
    assert.ok(t <= antes + 15 * MIN + 5000, `prazo a mais: ${t - antes}ms`);
    assert.equal(timerAlive(e), true, "a retomada tinha de ficar agendada");
  });

  it("pausa sem duração = ativação manual: sem prazo e sem timer", async () => {
    const e = freshEngine();
    const r = await e.pauseProtection();

    assert.equal(r.ok, true);
    assert.equal(r.pausedUntil, null, "sem duração não há prazo a prometer");
    assert.equal(timerAlive(e), false, "sem duração não há o que agendar");
  });

  it("a duração zero ou negativa não agenda nada", async () => {
    const e = freshEngine();
    for (const duracao of [0, -5 * MIN]) {
      const r = await e.pauseProtection(duracao);
      assert.equal(r.pausedUntil, null, `duração ${duracao} inventou um prazo`);
      assert.equal(timerAlive(e), false, `duração ${duracao} agendou um timer`);
    }
  });
});

describe("desligar/reativar/desmontar — o timer de retomada morre sempre", () => {
  it("desligar cancela a retomada agendada (a proteção não ressuscita)", async () => {
    const e = freshEngine();
    await e.pauseProtection(15 * MIN);
    assert.equal(timerAlive(e), true, "pré-condição: havia uma retomada agendada");

    await e.stopProtection();

    assert.equal(timerAlive(e), false, "o timer sobreviveu ao 'desligar' — voltaria sozinho");
  });

  it("dispose cancela a retomada agendada (nada reanima durante o teardown)", async () => {
    const e = freshEngine();
    await e.pauseProtection(15 * MIN);
    assert.equal(timerAlive(e), true, "pré-condição: havia uma retomada agendada");

    await e.dispose();
    engine = null;

    assert.equal(timerAlive(e), false, "o timer sobreviveu ao dispose");
    assert.equal(e.protectionPausedUntil, null, "o prazo ficou años depois do dispose");
  });

  it("reativar cancela a retomada agendada e limpa o prazo", async () => {
    const e = freshEngine();
    await e.pauseProtection(15 * MIN);
    // `resumeProtection()` chama `startProtection()`, que num motor sem `init()`
    // arranca watcher/ETW/WFP de verdade: MEDIDO 7.9 s. Este teste é sobre o
    // contrato do TIMER, não sobre arrancar motores, e o resto da suite tem
    // deadlines. Por isso o arranque é isolado — a asserção do timer fica intacta.
    e.startProtection = async () => ({ ok: true, protectionEnabled: true });

    const r = await e.resumeProtection();

    assert.equal(timerAlive(e), false, "reativar deixou a retomada agendada");
    assert.equal(r.pausedUntil, null, "reativar devolveu um prazo que já não existe");
  });

  it("pausar duas vezes não deixa o timer antigo vivo", async () => {
    const e = freshEngine();
    await e.pauseProtection(15 * MIN);
    const primeiro = e.protectionResumeTimer;
    await e.pauseProtection(60 * MIN);

    assert.notEqual(e.protectionResumeTimer, primeiro, "o timer anterior não foi substituído");
    assert.equal(timerAlive(e), true, "a segunda pausa tem de ficar agendada");
  });
});

describe("erro ao alterar a proteção não fabrica sucesso", () => {
  it("se a paragem falha, não há pausa nenhuma — mesmo que ela diga 'ligada'", async () => {
    const e = freshEngine();
    // Falha simulada do backend. Reposta com `protectionEnabled: true` de
    // propósito: é o pior caso — se o código só confiasse no ProtectionState,
    // diria ao utilizador "pausada até daqui a 15 min" sem ter agendado nada.
    e.stopProtection = async () => ({ ok: false, protectionEnabled: true });

    const r = await e.pauseProtection(15 * MIN);

    assert.equal(r.ok, false, "a pausa não pode dar ok quando a paragem falhou");
    assert.equal(r.pausedUntil, null, "pausa falhada inventou um prazo para a tray mostrar");
    assert.equal(timerAlive(e), false, "pausa falhada agendou um timer na mesma");
  });

  it("desligar twice é idempotente e não deixa timer", async () => {
    const e = freshEngine();
    await e.pauseProtection(15 * MIN);
    await e.stopProtection();
    await e.stopProtection();

    assert.equal(timerAlive(e), false, "o segundo stop ressuscitou o timer");
  });
});
/**
 * P0 REALTIME_TRAY — "ATIVAR PROTEÇÃO AGORA" TEM DE MATAR A PAUSA.
 *
 * O bug MEDIDO pelo humano, passo a passo:
 *
 *   1. proteção ativa;
 *   2. "Pausar 15 minutos";
 *   3. o watcher para;
 *   4. "Ativar proteção agora" (o botão da tray, que chama `monitor.start`);
 *   5. o watcher volta a correr;
 *   6. ...e a tray CONTINUA a apresentar a proteção como desativada ou em pausa.
 *
 * A causa: `startProtection()` arrancava os cinco motores e punha
 * `protectionState = true`, mas `protectionPausedUntil` ficava com o prazo
 * antigo e o `protectionResumeTimer` continuava VIVO. `getProtectionState()`
 * publica os dois factos, e a tray decide por eles (tray-menu.ts lê
 * `protectionPausedUntil`). Ou seja: o serviço tinha a proteção a correr e
 * anunciava uma pausa que já ninguém pediu — e o timer antigo podia depois
 * disparar sobre um estado que já não era dele.
 *
 * ── A ARMADILHA ───────────────────────────────────────────────────────────
 * O teste que existia antes (`reativar cancela a retomada agendada e limpa o
 * prazo`) substitui `e.startProtection` por um stub e chama `resumeProtection()`
 * — mede só o caminho `monitor.resume`, e NÃO o botão que o humano usou. Com o
 * stub, o código de `startProtection` nunca corre, logo teria passado com o bug
 * presente. Aqui o `startProtection()` é o REAL: só os cinco motores de sistema
 * são substituídos por versões inertes (um arranque real custa ~7,9 s).
 */

/** Motores de sistema inertes; `startProtection()` continua a ser o de produção. */
function stubEngines(e) {
  for (const name of ["watcher", "processMonitor", "etwConsumer", "wfpFilter", "amsiProvider"]) {
    const engine = e[name];
    if (!engine) continue;
    engine.start = async () => {};
    engine.stop = async () => {};
  }
  if (e.processMonitor) e.processMonitor.list = async () => [];
  if (e.hardware) e.hardware.getSnapshot = async () => ({});
  e.refreshConnections = async () => {};
  if (e.updater) {
    e.updater.startScheduler = () => {};
    e.updater.stopScheduler = () => {};
  }
  return e;
}

describe("ativacao manual (monitor.start) mata a pausa agendada", () => {
  for (const [rotulo, duracao] of [["15 minutos", 15 * MIN], ["1 hora", 60 * MIN]]) {
    it(`pausa de ${rotulo} + ativar agora: timer morto, prazo limpo, protecao ligada`, async () => {
      const e = stubEngines(freshEngine());
      await e.pauseProtection(duracao);
      assert.equal(timerAlive(e), true, "pré-condição: a pausa tinha de deixar uma retomada agendada");
      assert.ok(e.protectionPausedUntil, "pré-condição: havia um prazo publicado");

      // É exactamente isto que `monitor.start` (e o botão da tray) corre.
      const r = await e.startProtection();

      assert.equal(r.ok, true);
      assert.equal(r.protectionEnabled, true, "o motor arrancou, logo a proteção está ligada");
      assert.equal(e.protectionState, true);
      assert.equal(timerAlive(e), false, "o timer antigo sobreviveu à ativação manual");
      assert.equal(
        e.protectionPausedUntil,
        null,
        "o prazo antigo ficou publicado: a tray continuaria a dizer 'em pausa' com o watcher a correr",
      );

      // O contrato que a tray consome, pela porta de produção.
      const estado = await e.dispatch("protection.getState", undefined);
      assert.equal(estado.protectionEnabled, true, "protection.getState tem de dizer que está ligada");
      assert.equal(
        estado.protectionPausedUntil,
        null,
        "protection.getState não pode publicar uma pausa que já não existe",
      );
    });
  }

  it("o timer antigo não pode disparar depois da ativação manual (pausa curta real)", async () => {
    const e = stubEngines(freshEngine());
    await e.pauseProtection(60);
    assert.equal(timerAlive(e), true, "pré-condição: o timer tem de estar vivo para ser cancelado");

    await e.startProtection();
    assert.equal(timerAlive(e), false);

    // Espera mais do que a pausa original. Se o timer antigo tivesse ficado
    // vivo, dispararia aqui e reescrevia o estado da proteção.
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(e.protectionState, true, "o timer antigo mexeu no estado da proteção");
    assert.equal(e.protectionPausedUntil, null, "o timer antigo republicou um prazo");
  });

  it("reativação manual é idempotente e não inventa uma pausa", async () => {
    const e = stubEngines(freshEngine());
    await e.pauseProtection(15 * MIN);

    const primeiro = await e.startProtection();
    const segundo = await e.startProtection();

    assert.equal(primeiro.ok, true);
    assert.equal(segundo.ok, true);
    assert.equal(segundo.protectionEnabled, true);
    assert.equal(timerAlive(e), false);
    assert.equal(e.protectionPausedUntil, null);
  });

  it("uma ativação que falha não declara proteção ativa nem mantém a pausa", async () => {
    const e = stubEngines(freshEngine());
    await e.pauseProtection(15 * MIN);
    assert.equal(timerAlive(e), true, "pré-condição: havia uma pausa agendada");

    // Um dos cinco motores recusa arrancar.
    e.watcher.start = async () => {
      throw new Error("watcher indisponível");
    };

    const r = await e.startProtection();

    assert.equal(r.ok, false, "uma falha de arranque não pode devolver ok");
    assert.equal(r.protectionEnabled, false, "não pode declarar proteção ativa sem os motores");
    assert.equal(e.protectionState, false);
    assert.equal(timerAlive(e), false, "a pausa tem de morrer na mesma: o scan parou, não ficou agendado");
    assert.equal(e.protectionPausedUntil, null, "um prazo publicado a seguir a uma falha seria uma mentira");
  });

  it("pausa até ativação manual (sem duração) também morre na ativação manual", async () => {
    const e = stubEngines(freshEngine());
    await e.pauseProtection();
    assert.equal(timerAlive(e), false);
    assert.equal(e.protectionPausedUntil, null);

    const r = await e.startProtection();

    assert.equal(r.ok, true);
    assert.equal(e.protectionState, true);
    assert.equal(e.protectionPausedUntil, null);
    assert.equal(timerAlive(e), false);
  });
});

describe("arranque parcial (P1-1/P1-2) — sem orfaos e sem eventos perdidos", () => {
  const SUBSISTEMAS = ["watcher", "processMonitor", "etwConsumer", "wfpFilter", "amsiProvider"];

  it("um arranque falhado desmonta TODOS os subsistemas (nao deixa orfaos)", async () => {
    const e = stubEngines(freshEngine());
    const parados = [];
    for (const nome of SUBSISTEMAS) {
      e[nome].stop = async () => { parados.push(nome); };
    }
    const iniciados = [];
    for (const nome of SUBSISTEMAS) {
      e[nome].start = async () => { iniciados.push(nome); };
    }
    // OPCAO A (15/10): o gatilho fatal e um OBRIGATORIO. O WFP nem sequer e
    // iniciado no arranque da protecao, portanto ja nao pode ser ele a falhar.
    e.watcher.start = async () => {
      iniciados.push("watcher");
      throw new Error("watcher indisponivel");
    };

    const r = await e.startProtection();

    assert.equal(r.ok, false);
    assert.equal(r.protectionEnabled, false);
    assert.equal(e.protectionState, false);
    assert.deepEqual(r.failures?.map((f) => f.label), ["watcher"], "a causa tem de chegar ao chamador");
    assert.equal(
      iniciados.includes("wfpFilter"),
      false,
      "monitor.start NUNCA pode chamar wfpFilter.start: o start() dele corre New-NetFirewallRule",
    );
    assert.deepEqual(
      parados.slice().sort(),
      SUBSISTEMAS.slice().sort(),
      "arranque parcial falhado tem de desmontar todos os subsistemas que subiram",
    );
  });

  it("ativa com OBRIGATORIOS OK: ficheiros/processos ativos, rede degradada, zero operacoes de firewall", async () => {
    const e = stubEngines(freshEngine());
    const iniciados = [];
    const firewall = [];
    for (const nome of SUBSISTEMAS) {
      e[nome].start = async () => { iniciados.push(nome); };
    }
    e.wfpFilter.start = async () => { firewall.push("start"); };
    e.wfpFilter.stop = async () => { firewall.push("stop"); };

    const r = await e.startProtection();

    assert.equal(r.ok, true);
    assert.equal(r.protectionEnabled, true);
    assert.equal(e.protectionState, true, "os obrigatorios subiram: a protecao de ficheiros e processos esta ativa");
    assert.deepEqual(
      iniciados.slice().sort(),
      ["amsiProvider", "etwConsumer", "processMonitor", "watcher"],
      "os quatro obrigatorios sobem; o WFP fica de fora por decisao do titular",
    );
    assert.deepEqual(firewall, [], "um clique na protecao nao cria nem remove regras do Windows");
    assert.deepEqual(r.degraded?.map((d) => d.label), ["wfpFilter"], "a degradacao de rede tem de ser dita, nao omitida");
    assert.match(r.degraded?.[0].reason ?? "", /firewall/, "o motivo aponta para o provisionamento privilegiado");
  });

  it("parar a protecao continua a desmontar tudo, incluindo o WFP que nao subiu", async () => {
    const e = stubEngines(freshEngine());
    const parados = [];
    for (const nome of SUBSISTEMAS) {
      e[nome].stop = async () => { parados.push(nome); };
    }

    const start = await e.startProtection();
    assert.equal(start.ok, true);
    const stop = await e.stopProtection();

    assert.equal(stop.ok, true, "parar uma protecao com rede degradada e um sucesso limpo");
    assert.equal(e.protectionState, false);
    assert.deepEqual(
      parados.slice().sort(),
      SUBSISTEMAS.slice().sort(),
      "o teardown nao pode esquecer-se do WFP so porque ele nao foi iniciado por nos",
    );
  });

  it("processo nascido na transicao chega a ANALISE depois de a protecao ligar (P1-1)", async () => {
    const e = stubEngines(freshEngine());
    const base = e.processMonitor.listenerCount("process.started");
    // Espiao no ponto de entrada da analise real (handleProcessStart -> scanArtifact):
    // nao basta o listener ser chamado, tem de haver encaminhamento para analise.
    const analisados = [];
    e.scanArtifact = async (p, source, opts) => {
      analisados.push({ path: p, source, origin: opts?.origin, protectionState: e.protectionState });
      return { results: [] };
    };
    e.processMonitor.start = async () => {
      e.processMonitor.emit("process.started", {
        pid: 4242, name: "benigno-teste.exe", path: "C:/temp/benigno-teste.exe",
        commandLine: "benigno-teste.exe", ppid: 1,
      });
    };

    const r = await e.startProtection();
    await new Promise((res) => setTimeout(res, 10)); // deixa a analise fire-and-forget aterrar

    assert.equal(r.ok, true);
    assert.equal(analisados.length, 1, "o processo nascido na transicao tem de ser analisado exatamente uma vez");
    assert.equal(analisados[0].path, "C:/temp/benigno-teste.exe");
    assert.equal(analisados[0].source, "service");
    assert.equal(analisados[0].origin, "process_monitor");
    assert.equal(analisados[0].protectionState, true, "a analise so pode correr depois de a protecao confirmar");
    assert.equal(
      e.processMonitor.listenerCount("process.started"),
      base,
      "o listener temporario da transicao tem de ser removido tambem no caminho de sucesso (sem leaks)",
    );
  });

  it("arranque falhado descarta os eventos da transicao e nao deixa listeners pendurados (P1-1)", async () => {
    const e = stubEngines(freshEngine());
    const base = e.processMonitor.listenerCount("process.started");
    const vistos = [];
    e.handleProcessStart = async (p) => { vistos.push({ pid: p.pid, estado: e.protectionState }); };
    e.processMonitor.start = async () => {
      e.processMonitor.emit("process.started", {
        pid: 999, name: "x.exe", path: "C:/temp/x.exe", ppid: 1,
      });
    };
    e.watcher.start = async () => { throw new Error("watcher indisponivel"); };

    const r = await e.startProtection();

    assert.equal(r.ok, false);
    assert.equal(
      vistos.some((v) => v.estado === true),
      false,
      "um arranque falhado nao pode analisar como se a protecao estivesse ligada",
    );
    assert.equal(
      e.processMonitor.listenerCount("process.started"),
      base,
      "o listener temporario da transicao tem de ser removido (sem leaks)",
    );
  });
});
