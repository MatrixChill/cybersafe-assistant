/**
 * Cadencia de descoberta e diff do ProcessMonitor.
 *
 * O numero que importa aqui e o preco: cada round e uma enumeracao CIM real
 * (medida: 338-364 ms de wall, 266-297 ms de CPU, dos quais ~204 ms sao o
 * arranque do powershell.exe). A cadencia escolhe quantas enumeracoes happens
 * por minuto, e por isso o teste de custo mora aqui e nao num comentario.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProcessMonitor,
  PROCESS_POLL_INTERVAL_MS,
  PROCESS_FAST_POLL_INTERVAL_MS,
  PROCESS_OBSERVER_IDLE_MS,
} from "../dist/index.js";

/** Mapa de processos para o seam do poll. */
function world(entries) {
  return new Map(
    entries.map(([pid, name]) => [
      pid,
      { pid, name, commandLine: name, user: undefined, cpu: 0, memoryMb: 0, path: "", ppid: 0 },
    ]),
  );
}

/**
 * Relogio injetado nos testes de janela de inatividade. Nao usa o relogio real:
 * um teste de inatividade nao pode esperar segundos, e o packet proibe
 * transformar um teste num poll de segundos.
 */
const relogio = { agora: 1_000_000 };

describe("cadencia do ProcessMonitor — o preco, medido", () => {
  it("a cadencia nao pode descer abaixo do que o custo medido permite", () => {
    // Uma enumeracao custa ~0,3 s de CPU. Abaixo de 2 s seriam mais de 30
    // enumeracoes por minuto (>9 s de CPU/min) sem ganho medido para o
    // utilizador: a dominante do tempo visivel e a enumeracao, nao a espera.
    assert.ok(
      PROCESS_POLL_INTERVAL_MS >= 2_000,
      `cadencia de ${PROCESS_POLL_INTERVAL_MS} ms rebenta o custo (>30 enumeracoes/min)`,
    );
    const perMinute = 60_000 / PROCESS_POLL_INTERVAL_MS;
    assert.ok(perMinute <= 30, `${perMinute.toFixed(1)} enumeracoes por minuto e demasiado`);
  });

  it("e nao pode voltar a ser tao lenta que o utilizador espere por ela", () => {
    // Medido: a espera por um processo novo e a FASE do poll (0-10 s) mais a
    // enumeracao que o_descobre (8-12 s sob carga nesta maquina). Baixar o
    // intervalo de 10 s para 5 s NAO alterou nada disto — medido em A/B, com a
    // mesma maquina e o mesmo metodo: 2 enumeracoes em 30 s nas duas
    // configuracoes, CPU dentro do ruido. A razao e o `pollInFlight`: com uma
    // enumeracao a demorar 8-12 s, um intervalo de 5 s e um de 10 s dao o
    // mesmo numero de rounds. O que manda e o custo da enumeracao, nao o gap.
    assert.ok(
      PROCESS_POLL_INTERVAL_MS >= 5_000,
      `cadencia de ${PROCESS_POLL_INTERVAL_MS} ms nao compra nada e so custa enumeracoes`,
    );
  });

  it("6 enumeracoes por minuto e o preco assumido (o numero esta escrito no codigo)", () => {
    // 6/min x ~0,3 s de CPU = ~1,8 s de CPU por minuto. Subir para 12/min
    // custaria o dobro por um ganho medido de zero.
    assert.equal(PROCESS_POLL_INTERVAL_MS, 10_000);
    assert.equal(60_000 / PROCESS_POLL_INTERVAL_MS, 6);
  });
});

describe("diff do poll — rajadas de eventos", () => {
  it("rajada de 300 processos que aparecem: 300 'started', zero 'exited'", async () => {
    const monitor = new ProcessMonitor(async () => world([]));
    const started = [];
    const exited = [];
    monitor.on("process.started", (p) => started.push(p.pid));
    monitor.on("process.exited", (p) => exited.push(p.pid));
    await monitor.poll(); // previous fica vazio

    const burst = Array.from({ length: 300 }, (_, i) => [5000 + i, `burst-${i}.exe`]);
    monitor.snapshot = async () => world(burst);
    await monitor.poll();

    assert.equal(started.length, 300, "300 processos novos = 300 eventos");
    assert.deepEqual(exited, [], "ninguem morreu");
  });

  it("rajada de 300 processos que saem: 300 'exited', zero 'started'", async () => {
    const initial = Array.from({ length: 300 }, (_, i) => [5000 + i, `burst-${i}.exe`]);
    const monitor = new ProcessMonitor(async () => world(initial));
    const started = [];
    const exited = [];
    monitor.on("process.started", (p) => started.push(p.pid));
    monitor.on("process.exited", (p) => exited.push(p.pid));
    await monitor.poll();
    // O primeiro round so serve para decorar o `previous` (anuncia tudo o que
    // ja existia). O que se mede aqui e o round seguinte.
    started.length = 0;
    exited.length = 0;

    monitor.snapshot = async () => world([]);
    await monitor.poll();

    assert.equal(exited.length, 300, "300 processos que saem = 300 eventos");
    assert.deepEqual(started, [], "ningem nasceu");
  });

  it("burst no MESMO round: cada PID anuncia-se uma vez, e o round seguinte cala-se", async () => {
    const monitor = new ProcessMonitor(async () => world([]));
    const started = [];
    monitor.on("process.started", (p) => started.push(p.pid));
    await monitor.poll();

    const burst = Array.from({ length: 180 }, (_, i) => [9000 + i, `novo-${i}.exe`]);
    let rounds = 0;
    monitor.snapshot = async () => {
      rounds += 1;
      return world(burst);
    };
    await monitor.poll();
    assert.equal(started.length, 180, "180 processos novos = 180 eventos");
    assert.equal(new Set(started).size, 180, "nenhum PID anunciado duas vezes");

    // Round seguinte sem mudanca: silencio. E o que impede 180 eventos a cada
    // 5 s so porque a lista volta a ser igual.
    await monitor.poll();
    assert.equal(started.length, 180, "round sem diff nao inventa eventos");
    assert.equal(rounds, 2);
  });

  it("processo novo e processo morto no mesmo round: os dois eventos saem", async () => {
    const monitor = new ProcessMonitor(async () => world([[100, "vivo.exe"], [200, "morre.exe"]]));
    const started = [];
    const exited = [];
    monitor.on("process.started", (p) => started.push(p.name));
    monitor.on("process.exited", (p) => exited.push(p.name));
    await monitor.poll();
    started.length = 0;
    exited.length = 0;

    monitor.snapshot = async () => world([[100, "vivo.exe"], [300, "nasceu.exe"]]);
    await monitor.poll();

    assert.deepEqual(started, ["nasceu.exe"]);
    assert.deepEqual(exited, ["morre.exe"]);
  });

  it("enumeracao falhou: nao se emite 'exited' para o SO inteiro", async () => {
    // O bug mais grave de um monitor de processos: tratar "nao consegui
    // perguntar" como "o SO esta vazio" apaga a lista toda.
    const monitor = new ProcessMonitor(async () => world([[1, "a.exe"], [2, "b.exe"]]));
    const exited = [];
    monitor.on("process.exited", (p) => exited.push(p.pid));
    await monitor.poll();

    monitor.snapshot = async () => {
      throw new Error("CIM indisponivel");
    };
    await monitor.poll();
    await monitor.poll();

    assert.deepEqual(exited, [], "nenhum exited inventado");
  });

  it("round em voo partilha a enumeração — e NÃO é deitado fora", async () => {
    // TP-MONITOR-P0: este teste costumava provar o defeito sem o saber. «Round
    // saltado» protegia o preço (uma enumeração do SO de cada vez) mas custava o
    // round inteiro: como a enumeração (2-4 s medida) é mais lenta que a cadência
    // rápida (2 s), cada tick apanhava uma enumeração em curso, `previous` nunca
    // era atualizado e o Monitor mostrava 496 processos com zero eventos.
    // O invariante de custo mantém-se; o que mudou é que o round junta-se à
    // enumeração em curso em vez de desistir dela.
    let calls = 0;
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const monitor = new ProcessMonitor(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return world([[1, "a.exe"]]);
    });
    const started = [];
    monitor.on("process.started", (p) => started.push(p.pid));
    // Não awaitidos: os três agora ESPERAM o mesmo round, por isso a gate tem de
    // ser aberta antes de os aguardar (é a mudança de semântica, não um artefacto).
    const first = monitor.poll();
    const segundo = monitor.poll();
    const terceiro = monitor.poll();
    assert.equal(calls, 1, "os rounds sobrepostos partilham UMA enumeração do SO");
    release();
    await Promise.all([first, segundo, terceiro]);
    assert.equal(calls, 1, "esperar o round não custou uma segunda enumeração");
    assert.deepEqual(started, [1], "o round partilhado anunciou o processo uma única vez");
    await monitor.poll();
    assert.equal(calls, 2, "depois de livre, volta a correr");
    assert.deepEqual(started, [1], "round sem diff não re-anuncia");
  });
});

/**
 * P0 de latencia: a espera por um processo novo nao e um bug de cache nem de
 * UI, e um relogio. O mecanismo de descoberta e um poll, nao um evento: o SO
 * pode nascer no proximo tick. Com o intervalo de 10 s, o utilizador espera
 * entre 0 e 10 s — a media sao os ~5 s que ele reportou.
 *
 * Baixar o intervalo a MTUDO e REFUTADO pela medicao: uma enumeracao custa
 * ~591 ms de mediana nesta maquina (medida pelo Maestro), logo 1,5 s de
 * intervalo seriam 39% de um nucleo. O caminho e CADENCE ADAPTATIVA: rapida
 * so enquanto alguem pede a lista, lenta quando ninguem olha.
 */
describe("cadencia adaptativa — rapida so enquanto ha observador", () => {
  it("o intervalo lento e o valor actual de hoje: 10 000 ms, sem retrocesso", () => {
    assert.equal(PROCESS_POLL_INTERVAL_MS, 10_000);
  });

  it("o intervalo rapido tem como contrato 2 000 ms e nunca menos", () => {
    // 591 ms por enumeracao: 2000 ms sao 29,6% de um nucleo enquanto se olha.
    // Abaixo disso o preco sobe depressa demais sem ganho medido.
    assert.equal(PROCESS_FAST_POLL_INTERVAL_MS, 2_000);
    assert.ok(PROCESS_FAST_POLL_INTERVAL_MS >= 2_000, "o piso de 2 000 ms nunca e furado");
    assert.ok(PROCESS_FAST_POLL_INTERVAL_MS < PROCESS_POLL_INTERVAL_MS, "a rapida tem de ser mais rapida");
  });

  it("o intervalo de inatividade e maior que a cadencia rapida (senao oscila)", () => {
    assert.ok(
      PROCESS_OBSERVER_IDLE_MS > PROCESS_FAST_POLL_INTERVAL_MS,
      `inatividade de ${PROCESS_OBSERVER_IDLE_MS} ms tem de ser maior que a cadencia rapida de ${PROCESS_FAST_POLL_INTERVAL_MS} ms`,
    );
    assert.ok(
      PROCESS_OBSERVER_IDLE_MS >= PROCESS_FAST_POLL_INTERVAL_MS * 2,
      "uma unica janela de inatividade nao pode chegar aCause a oscilar",
    );
  });

  it("sem observador o intervalo em vigor e o lento", () => {
    const monitor = new ProcessMonitor(async () => world([]));
    assert.equal(monitor.currentIntervalMs(), PROCESS_POLL_INTERVAL_MS);
  });

  it("com observador o intervalo em vigor passa a ser o rapido", () => {
    const monitor = new ProcessMonitor(async () => world([]));
    monitor.noteObserver();
    assert.equal(monitor.currentIntervalMs(), PROCESS_FAST_POLL_INTERVAL_MS);
  });

  it("varios pedidos de lista no mesmo instante nao mudam o intervalo duas vezes", () => {
    const monitor = new ProcessMonitor(async () => world([]));
    for (let i = 0; i < 50; i++) monitor.noteObserver();
    assert.equal(monitor.currentIntervalMs(), PROCESS_FAST_POLL_INTERVAL_MS);
    assert.equal(monitor.hasObserver(), true);
  });

  it("apos a inatividade volta ao lento", () => {
    const monitor = new ProcessMonitor(async () => world([]), { now: () => relogio.agora });
    monitor.noteObserver();
    assert.equal(monitor.currentIntervalMs(), PROCESS_FAST_POLL_INTERVAL_MS);

    relogio.agora += PROCESS_OBSERVER_IDLE_MS + 1;
    assert.equal(monitor.hasObserver(), false, "a janela de inatividade expirou");
    assert.equal(monitor.currentIntervalMs(), PROCESS_POLL_INTERVAL_MS);
  });

  it("o observador nao expira enquanto os pedidos continuam a chegar", () => {
    const monitor = new ProcessMonitor(async () => world([]), { now: () => relogio.agora });
    monitor.noteObserver();
    for (let i = 0; i < 10; i++) {
      relogio.agora += PROCESS_OBSERVER_IDLE_MS / 2;
      monitor.noteObserver();
      assert.equal(monitor.hasObserver(), true, `pedido ${i} devia re-armar a janela`);
      assert.equal(monitor.currentIntervalMs(), PROCESS_FAST_POLL_INTERVAL_MS);
    }
  });

  it("um round lento nunca salta mais que um ciclo ao mudar de estado", () => {
    // Contrato: mudar de intervalo reinicia o timer. Sem isso, um observador
    // aparecia a meio de um round lento e ficava ate 10 s sem ver nada.
    const monitor = new ProcessMonitor(async () => world([]), { now: () => relogio.agora });
    const primeiro = monitor.scheduleDelayMs();
    assert.equal(primeiro, PROCESS_POLL_INTERVAL_MS, "sem observador, o proximo round e o lento");

    monitor.noteObserver();
    assert.equal(
      monitor.scheduleDelayMs(),
      PROCESS_FAST_POLL_INTERVAL_MS,
      "com observador, o proximo round e o rapido — o lento nao se cumpre inteiro",
    );

    monitor.noteObserver();
    relogio.agora += PROCESS_OBSERVER_IDLE_MS + 1;
    assert.equal(monitor.scheduleDelayMs(), PROCESS_POLL_INTERVAL_MS, "depois de inativo, volta ao lento");
  });
});

/**
 * O buraco de concidencia do ponto 4 do packet: havia DOIS guards em objectos
 * diferentes a proteger a MESMA funcao cara. `pollInFlight` protege o timer;
 * `engine.processesEnumerating` protege `listProcesses()`. E o
 * `ProcessMonitor.list()` chamava `snapshotProcesses()` DIRECTAMENTE, sem
 * passar pelo primeiro guard — um tick do timer e um pedido da UI podiam
 * correr DUAS enumeracoes do SO em paralelo.
 *
 * Este teste falha com o codigo antigo porque `list()` nunca passa pelo seam
 * nem pelo guard: conta as chamadas ao snapshot.
 */
describe("single-flight partilhado — nunca duas enumeracoes do SO ao mesmo tempo", () => {
  it("list() usa o mesmo seam de snapshot (antes chamava snapshotProcesses directo)", async () => {
    let calls = 0;
    const monitor = new ProcessMonitor(async () => {
      calls += 1;
      return world([[1, "a.exe"]]);
    });
    await monitor.list();
    assert.equal(calls, 1, "list() tem de usar a funcao injetada, nao a enumeração real do SO");
  });

  it("dois pedidos de lista em simultaneo nao produzem duas enumeracoes", async () => {
    let calls = 0;
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const monitor = new ProcessMonitor(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return world([[1, "a.exe"]]);
    });

    const primeiro = monitor.list();
    const segundo = monitor.list();
    const terceiro = monitor.list();
    assert.equal(calls, 1, "tres pedidos em simultaneo = UMA enumeracao do SO");
    release();
    await Promise.all([primeiro, segundo, terceiro]);
  });

  it("um tick do poll e um pedido de lista ao mesmo tempo = UMA enumeracao", async () => {
    // Este e o bug exacto do packet: os dois guards diziam "estou ocupado" a si
    // proprios e nao se viam. O objectivo nao e que os DOIS avancem, e que nunca
    // existam DUAS enumeracoes do SO ao mesmo tempo. Com o poll a sair quando
    // ja ha enumeracao em curso (a cadencia degrada, a fila nao cresce) e o
    // list() a partilhar a promessa, o total e sempre 1.
    let calls = 0;
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const monitor = new ProcessMonitor(async () => {
      calls += 1;
      await gate;
      return world([[1, "a.exe"]]);
    });

    const tick = monitor.poll();
    const pedido = monitor.list();
    assert.equal(calls, 1, "o timer e a UI nao podem enumerar o SO em paralelo");
    release();
    await Promise.all([tick, pedido]);
    assert.equal(calls, 1, "nem depois de livre ha uma segunda enumeracao deste par");
  });

  it("depois de livre, uma enumeracao nova pode correr", async () => {
    let calls = 0;
    const monitor = new ProcessMonitor(async () => {
      calls += 1;
      return world([[1, "a.exe"]]);
    });
    await monitor.list();
    await monitor.list();
    assert.equal(calls, 2, "o single-flight nao pode colar nem travar o monitor para sempre");
  });
});

describe("ciclo de vida — stop() durante um poll em voo nao rearma (FIX P2)", () => {
  it("stop() a meio de uma enumeracao deixa o timer morto e nao faz enumeracao extra", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const monitor = new ProcessMonitor(
      async () => {
        calls++;
        await gate;
        return world([[1, "seed.exe"]]);
      },
      { now: () => relogio.agora },
    );

    // Restart (previous nao vazio): start() passa por poll() e fica preso na enumeracao.
    monitor.previous = world([[7, "antigo.exe"]]);
    const startPromise = monitor.start();
    await new Promise((r) => setImmediate(r));
    await monitor.stop();

    assert.equal(monitor.timer, null, "stop() tem de deixar o timer morto");

    release();
    await startPromise;
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(monitor.timer, null, "o finally do poll nao pode reagendar depois de stop()");
    assert.equal(calls, 1, "nenhuma enumeracao extra depois do stop()");
  });
});

describe("ciclo de vida — stop() -> start() com uma operacao anterior ainda pendente", () => {
  it("retoma a monitorizacao com UM unico timer, sem perder nem duplicar eventos", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const monitor = new ProcessMonitor(
      async () => {
        calls++;
        await gate;
        return world([[1, "novo.exe"]]);
      },
      { now: () => relogio.agora },
    );

    const anunciados = [];
    monitor.on("process.started", (p) => anunciados.push(p.pid));

    // Restart (previous nao vazio): este start() fica preso na enumeracao partilhada.
    monitor.previous = world([[7, "antigo.exe"]]);
    const primeiroStart = monitor.start();
    await new Promise((r) => setImmediate(r));

    await monitor.stop();
    assert.equal(monitor.timer, null, "stop() deixa o timer morto");

    // Conta os timers de poll vivos: so interessam os de intervalo de cadencia.
    const timersVivos = new Set();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => {
      const h = realSetTimeout(fn, ms, ...a);
      if (ms >= 1000) timersVivos.add(h);
      return h;
    };
    globalThis.clearTimeout = (h) => {
      timersVivos.delete(h);
      return realClearTimeout(h);
    };
    try {
      // start() imediato, ainda com a operacao anterior em voo.
      await monitor.start();
      assert.notEqual(monitor.timer, null, "a monitorizacao tem de estar retomada (timer vivo)");

      // A operacao antiga termina AGORA: o processo nascido no intervalo
      // tem de ser anunciado, uma unica vez.
      release();
      await primeiroStart;
      await new Promise((r) => setImmediate(r));

      assert.deepEqual(anunciados, [1], "o processo nascido no intervalo anuncia-se exactamente uma vez");
      assert.equal(calls, 1, "a enumeracao partilhada nao pode correr duas vezes");
      assert.equal(timersVivos.size, 1, "so pode ficar UM timer de poll vivo depois de stop() -> start()");
      assert.notEqual(monitor.timer, null, "o monitor continua agendado");
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      await monitor.stop();
    }
  });

  it("arranque frio partilhado: semeia sem rajada e fica com um timer", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const monitor = new ProcessMonitor(
      async () => {
        calls++;
        await gate;
        return world([[1, "ja-existia.exe"], [2, "tambem.exe"]]);
      },
      { now: () => relogio.agora },
    );

    const anunciados = [];
    monitor.on("process.started", (p) => anunciados.push(p.pid));

    // Uma enumeracao ja em voo vinda de outro caminho (ex.: list() da UI) —
    // exatamente o caso que o seedOnly() tem de saber partilhar.
    const listPromise = monitor.list();
    await new Promise((r) => setImmediate(r));

    await monitor.stop(); // protecao desligada: previous continua vazio
    // Arranque frio: o seedOnly partilha a enumeracao em voo (e espera por ela).
    const startPromise = monitor.start();

    release();
    await listPromise;
    await startPromise;
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(anunciados, [], "arranque frio nao pode anunciar o que ja existia (rajada)");
    assert.equal(calls, 1, "semeia com a enumeracao em voo, sem duplicar");
    assert.notEqual(monitor.timer, null, "depois de semear, o poll fica agendado");
    await monitor.stop();
  });
});
