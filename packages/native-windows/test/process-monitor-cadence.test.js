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
import { ProcessMonitor, PROCESS_POLL_INTERVAL_MS } from "../dist/index.js";

/** Mapa de processos para o seam do poll. */
function world(entries) {
  return new Map(
    entries.map(([pid, name]) => [
      pid,
      { pid, name, commandLine: name, user: undefined, cpu: 0, memoryMb: 0, path: "", ppid: 0 },
    ]),
  );
}

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

  it("round em voo nao se acumula (a cadencia degrada, a fila nao cresce)", async () => {
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
    const first = monitor.poll();
    // Enquanto o primeiro round nao acaba, mais dois nao podem entrar.
    await monitor.poll();
    await monitor.poll();
    assert.equal(calls, 1, "os rounds sobrepostos sao saltados, nao enfileirados");
    release();
    await first;
    await monitor.poll();
    assert.equal(calls, 2, "depois de livre, volta a correr");
  });
});
