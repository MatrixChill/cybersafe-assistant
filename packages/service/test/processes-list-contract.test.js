import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { ProtectionEngineService } from "../dist/engine.js";

/**
 * Testes ativos extraídos de process-kill.test.js em 2026-11-01.
 * Cobrem listagem/cache/processMonitor e não dependem do kill legado.
 */
const TEST_BASE_DIR = mkdtempSync(path.join(os.tmpdir(), "cybersafe-processes-list-"));

after(async () => {
  await fs.rm(TEST_BASE_DIR, { recursive: true, force: true }).catch(() => {});
});

function processEntry(overrides) {
  return {
    pid: 0,
    ppid: 0,
    name: "sample.exe",
    path: "",
    commandLine: "",
    cpu: 0,
    memoryMb: 0,
    startedAt: new Date().toISOString(),
    trusted: "unknown",
    ...overrides,
  };
}

const listaDeProcessos = async (engine) => (await engine.listProcesses()).processes;

describe("processMonitor — process.exited natural não duplica o kill reconciliado", () => {
  it("publica só quando o PID ainda estava no cache", () => {
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    const events = [];
    engine.eventBus.on("process.exited", () => events.push("exited"));

    const entry = processEntry({ pid: 55555, name: "sample.exe" });
    engine.processes = [entry];

    engine.handleNaturalProcessExit(entry);
    assert.equal(events.length, 1);
    assert.equal(engine.processes.some((p) => p.pid === 55555), false);

    // Segunda deteção do mesmo PID já fora do cache: nada novo é publicado.
    engine.handleNaturalProcessExit(entry);
    assert.equal(events.length, 1);
  });

  it("lista já filtrada por um kill reconciliado não gera evento duplicado", () => {
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    const events = [];
    engine.eventBus.on("process.exited", () => events.push("exited"));

    const entry = processEntry({ pid: 66666, name: "ghost.exe" });
    // Simula o que o kill reconciliado faz: PID já removido do cache.
    engine.processes = [];
    engine.handleNaturalProcessExit(entry);

    assert.equal(events.length, 0);
  });
});

describe("processes.list — verdade do SO reconciliada a pedido (P0)", () => {
  it("com >200 processos reais, o PID mais alto continua acessível (o cap de 200 matava-o)", async () => {
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    const osTruth = [];
    for (let i = 0; i < 331; i++) osTruth.push(processEntry({ pid: 4000 + i, name: `app-${i}.exe` }));
    let enumerations = 0;
    engine.processMonitor.list = async () => {
      enumerations += 1;
      return osTruth;
    };
    // Estado do bug: cache truncado a 200 e sem qualquer caminho de volta ao SO.
    engine.processes = osTruth.slice(0, 200);

    const list = await listaDeProcessos(engine);
    assert.equal(list.length, 331, "a lista devolve a verdade do SO, não o cache capado");
    assert.ok(list.some((p) => p.pid === 4000 + 330), "o processo de PID mais alto continua visível");
    assert.equal(engine.processes.length, 331, "o cache fica reconciliado com a verdade");
    assert.equal(enumerations, 1);
  });

  it("refresh repetido dentro da janela de frescura não re-enumerada (a UI refresca a cada evento)", async () => {
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    const truth = [processEntry({ pid: 11, name: "a.exe" })];
    let calls = 0;
    engine.processMonitor.list = async () => {
      calls += 1;
      return truth;
    };
    await engine.listProcesses();
    await engine.listProcesses();
    await engine.listProcesses();
    assert.equal(calls, 1, "dentro do TTL serve o cache recém-reconciliado");
  });

  /**
   * Este teste existe por causa de uma decisão de produto: o poll do RENDERER
   * desceu de 10 s para 2 s (o produtor passou a 2 s, e ler 5 vezes atrasado
   * era o furo que deixava o utilizador ver ~5 s). Antes de mudar esse numero,
   * é preciso provar que ele NAO cria enumeracoes do SO novas — caso contrario
   * teriamos multiplicado o preco sem ganho.
   *
   * O que este teste mede (e o que a medição corrigiu): o numero de
   * enumerações numa janela NÃO é determinado pelo poll do renderer, mas
   * pelo TTL do cache (20 s). Por isso 60 s dão ~3-4 enumerações em QUALQUER
   * cadência de pedido. A prova que interessa é comparativa: 2 s e 10 s dão o
   * MESMO numero. Se o poll mandasse, 2 s daria 5x mais.
   */
  const countEnumerationsOver = async (pollMs, windowMs) => {
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    const truth = [processEntry({ pid: 11, name: "a.exe" })];
    let enumerations = 0;
    engine.processMonitor.list = async () => {
      enumerations += 1;
      return truth;
    };

    // Simula a janela com o relogio do TTL andado a mao. Nao ha espera real.
    const inicio = Date.now();
    const relogioReal = Date.now;
    try {
      for (let t = 0; t <= windowMs; t += pollMs) {
        Date.now = () => inicio + t;
        await engine.listProcesses();
      }
    } finally {
      Date.now = relogioReal;
    }
    return enumerations;
  };

  it("baixar o poll do renderer de 10 s para 2 s NÃO aumenta o número de enumerações", async () => {
    const janela = 60_000;
    const antes = await countEnumerationsOver(10_000, janela);
    const depois = await countEnumerationsOver(2_000, janela);

    assert.equal(
      depois,
      antes,
      `poll a 2 s deu ${depois} enumerações e a 10 s deu ${antes}: o poll do renderer não manda no SO`,
    );
    assert.ok(antes <= 4, `${antes} enumerações em 60 s é o TTL de 20 s a expire, não o poll`);
  });

  it("o número de enumerações em 60 s é o TTL a expirar, não a frequência do pedido", async () => {
    // 60 s / TTL de 20 s = 3 expiracoes (mais a inicial). Se fosse o poll a
    // mandar, o poll de 2 s dariam 30 enumerações.
    const enums2s = await countEnumerationsOver(2_000, 60_000);
    assert.ok(
      enums2s <= 4,
      `${enums2s} enumerações em 60 s: se o poll mandasse seriam 30. O TTL é que manda.`,
    );
  });

  it("cada pedido marca o observador (o sinal que liga a cadência adaptativa do serviço)", async () => {
    // Sem este sinal, o serviço volta à cadência lenta de 10 s passados 15 s
    // de inatividade e a descoberta volta a ficar lenta. Cada `processes.list`
    // é o pedido de "há alguém a olhar".
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    engine.processMonitor.list = async () => [processEntry({ pid: 11, name: "a.exe" })];
    let marked = 0;
    engine.processMonitor.noteObserver = () => {
      marked += 1;
    };

    for (let i = 0; i < 5; i++) await engine.listProcesses();
    assert.equal(marked, 5, "cada pedido de lista assinala observador, mesmo quando responde de cache");
  });

  it("enumeração falhou → serve o cache de eventos e DISSO-o: nunca lista vazia silenciosa", async () => {
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    engine.processes = [processEntry({ pid: 777, name: "mantido.exe" })];
    engine.processMonitor.list = async () => {
      throw new Error("PowerShell caiu");
    };
    const { processes: list, truth } = await engine.listProcesses();
    assert.equal(list.length, 1);
    assert.equal(list[0].pid, 777);
    // P1-PROCESS-TRUTH: as linhas sobrevivem, mas a palavra do Windows não foi
    // obtida. Sem este par, «servir o cache» era indistinguível de «o SO disse
    // isto agora».
    assert.equal(truth.state, "failed", "a resposta diz que a enumeração falhou");
    assert.equal(truth.servedFrom, "cache", "e que as linhas não são uma foto nova");
    assert.equal(truth.enumeratedAt, null, "não houve foto, portanto não se afirma idade");
    assert.match(truth.attempt.error.message, /PowerShell caiu/, "o motivo chega à interface");
  });

  it("process.started já não empurra processos para fora do cache (cap de 200 removido)", () => {
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    engine.bindWatchers();
    engine.processes = [];
    for (let i = 0; i < 210; i++) {
      // "node.exe" está na SAFE_PROCESSES: exercita só a manutenção do cache.
      engine.processMonitor.emit("process.started", processEntry({ pid: 30000 + i, name: "node.exe" }));
    }
    assert.equal(engine.processes.length, 210);
    assert.ok(engine.processes.some((p) => p.pid === 30000), "o primeiro continua presente");
  });
});
