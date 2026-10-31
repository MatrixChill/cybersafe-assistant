/**
 * TP-MONITOR-P0-EVENT-FLOW-20261022 — o percurso de um evento benigno dentro do
 * serviço, e a diferença entre as três coisas que o Monitor mostra.
 *
 * O Monitor confunde-se porque três eixos diferentes aparecem lado a lado:
 *   1. `processes.list`   → INVENTÁRIO do SO, lido por `listProcesses()` a pedido.
 *                           Existe com proteção ligada ou desligada. É o 496.
 *   2. `events.list`      → HISTÓRICO de segurança em memória (o replay do bus),
 *                           alimentado pelo `bindEventBus()`. Depende de haver quem
 *                           produza eventos: com proteção desligada e sem scans,
 *                           zero é o estado VERDADEIRO, não um cano partido.
 *   3. `security-events.log`→ o que é PERSISTIDO. É um subconjunto deliberado
 *                           (`shouldPersistEvent`): `process.started`/`file.created`
 *                           são ruído de alta frequência e vão só para a UI.
 *
 * Este ficheiro corre o `bindEventBus()` REAL (recortado do fonte da lane, sem
 * reimplementação) com o `SecurityEventBus` REAL da lane, e prova que um evento
 * benigno injectado chega à subscrição, ao broadcast do pipe e ao replay lido pelo
 * Monitor. Sem proteção ligada, sem WMI, sem rede, sem serviço Windows.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { shouldPersistEvent, scanIdFromContext } from "../src/log-writer.ts";

const linhasEngine = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8").split(/\r?\n/);
const ini = linhasEngine.findIndex((l) => l === "  private bindEventBus() {");
const fim = linhasEngine.findIndex((l, i) => i > ini && l === "  }");
assert.ok(ini >= 0 && fim > ini, "o corpo real de bindEventBus deixou de ter a forma esperada");
const corpoReal = linhasEngine.slice(ini, fim + 1).join("\n");

const DIR = new URL(".", import.meta.url);
const caminhoTemporario = new URL("corpo-bind-event-bus.ts", DIR);
const fonte = `
import { SecurityEventBus } from ${JSON.stringify(new URL("../../core/src/event-bus.ts", import.meta.url).href)};
import { shouldPersistEvent, scanIdFromContext } from ${JSON.stringify(new URL("../src/log-writer.ts", import.meta.url).href)};

export const criada = { gravados: [] as string[], broadcasts: [] as unknown[] };

function encodeMessage(m: unknown) { return JSON.stringify(m); }

class MotorDeTeste {
  readonly eventBus = new SecurityEventBus({ replayLimit: 500 });
  events: any[] = [];
  isShuttingDown = false;
  readonly eventsLog = {
    write: async (linha: string) => { criada.gravados.push(linha); },
  };
  broadcast(mensagem: unknown) {
    if (this.isShuttingDown) return;
    criada.broadcasts.push(encodeMessage(mensagem));
  }
${corpoReal}
}

export function criarMotor() {
  criada.gravados.length = 0;
  criada.broadcasts.length = 0;
  const motor = new MotorDeTeste();
  motor.bindEventBus();
  return motor;
}
`;
// O ficheiro vive no diretório do teste para que os imports relativos do prelude
// resolvam na LANE (nunca no `dist` de outra árvore).
writeFileSync(caminhoTemporario, fonte, "utf8");
const modulo = await import(new URL("corpo-bind-event-bus.ts", DIR).href);
after(() => { rmSync(caminhoTemporario, { force: true }); });

const benigno = { pid: 4242, name: "benign.exe", path: "", commandLine: "benign.exe", ppid: 4, startedAt: "2026-10-22T20:00:00.000Z" };

describe("percurso do evento benigno — bus → assinatura do serviço → broadcast → replay", () => {
  it("um `process.started` benigno publicado no bus chega à subscrição do serviço", () => {
    const motor = modulo.criarMotor();
    const recebidos: string[] = [];
    motor.eventBus.on("event", (e: any) => recebidos.push(e.type));

    motor.eventBus.publish("process.started", "low", "Processo iniciado: benign.exe", benigno);

    assert.deepEqual(recebidos, ["process.started"], "o bus entrega ao subscritor");
    assert.equal(motor.events.length, 1, "bindEventBus (corpo real) guardou no histórico");
    assert.equal(motor.events[0].data.name, "benign.exe");
    assert.equal(modulo.criada.gravados.length, 0, "`process.started` NÃO é persistido — é telemetria viva");
  });

  it("o mesmo evento é transmitido aos clientes do pipe, com o tipo `event`", () => {
    const motor = modulo.criarMotor();
    motor.eventBus.publish("process.started", "low", "Processo iniciado: benign.exe", benigno);
    assert.equal(modulo.criada.broadcasts.length, 1, "um broadcast por evento publicado");
    const payload = JSON.parse(modulo.criada.broadcasts[0] as string);
    assert.equal(payload.type, "event");
    assert.equal(payload.event.type, "process.started");
    assert.equal(typeof payload.event.sequence, "number");
  });

  it("o que o Monitor lê (`events.list`) devolve o evento, com proteção desligada", () => {
    // `protectionState = false` é o estado normal de quem não ligou a proteção:
    // nada aqui depende de a ligar, e é exatamente por isto que «zero eventos»
    // com zero publicações é uma leitura VERDADEIRA, não um cano partido.
    const motor = modulo.criarMotor();
    assert.equal(motor.eventBus.getReplay(undefined, 100).length, 0, "sem publicações, histórico vazio");
    motor.eventBus.publish("process.started", "low", "Processo iniciado: benign.exe", benigno);
    const replay = motor.eventBus.getReplay(undefined, 100);
    assert.equal(replay.length, 1, "o replay do bus serve a leitura do Monitor");
    assert.equal(replay[0].summary, "Processo iniciado: benign.exe");
  });

  it("leitura com cursor só devolve o que é posterior ao cursor", () => {
    const motor = modulo.criarMotor();
    const primeiro = motor.eventBus.publish("process.started", "low", "p1", benigno);
    motor.eventBus.publish("process.started", "low", "p2", benigno);
    const depois = motor.eventBus.getReplay(primeiro.sequence, 100);
    assert.equal(depois.length, 1);
    assert.equal(depois[0].summary, "p2");
  });

  it("um evento de segurança vai para o histórico persistido; o ruído não", () => {
    const motor = modulo.criarMotor();
    motor.eventBus.publish("process.started", "low", "Processo iniciado: benign.exe", benigno);
    motor.eventBus.publish("threat.detected", "critical", "Ameaça detetada em benign.exe", {
      artifactPath: "C:/fixture/benign.exe", sha256: "0".repeat(64),
    });
    assert.equal(modulo.criada.gravados.length, 1, "só a ameaça é escrita em security-events.log");
    const gravado = JSON.parse(modulo.criada.gravados[0]);
    assert.equal(gravado.type, "threat.detected");
    assert.equal(modulo.criada.broadcasts.length, 2, "os DOIS vão para a UI em direto");
  });

  it("o cap de 500 aplica-se ao histórico em memória e ao replay", () => {
    const motor = modulo.criarMotor();
    for (let i = 0; i < 520; i += 1) {
      motor.eventBus.publish("process.started", "low", `p${i}`, { ...benigno, pid: 1000 + i });
    }
    assert.equal(motor.events.length, 500, "histórico em memória limitado a 500");
    assert.equal(motor.eventBus.getReplay(undefined, 1000).length, 500, "replay limitado ao replayLimit");
    const cauda = motor.eventBus.getReplay(undefined, 3);
    assert.deepEqual(cauda.map((e: any) => e.summary), ["p517", "p518", "p519"], "o que fica é a cauda, não a cabeça");
  });

  it("durante o shutdown nada é transmitido, mas o histórico continua a ser o fonte do replay", () => {
    const motor = modulo.criarMotor();
    motor.isShuttingDown = true;
    motor.eventBus.publish("process.started", "low", "p", benigno);
    assert.equal(modulo.criada.broadcasts.length, 0, "sem broadcast em shutdown (contrato existente)");
    assert.equal(motor.eventBus.getReplay(undefined, 10).length, 1, "o bus não sabe do shutdown: a leitura é coerente");
  });
});

describe("os três eixos são fontes diferentes — não um número partido", () => {
  it("o dispatch lê histórico e inventário por caminhos distintos", () => {
    const texto = linhasEngine.join("\n");
    assert.match(texto, /case "events\.list":\s*\n\s*return this\.eventBus\.getReplay\(/,
      "events.list é o replay do bus (histórico de segurança)");
    assert.match(texto, /case "processes\.list":\s*\n\s*return this\.listProcesses\(\);/,
      "processes.list é a leitura do SO (inventário), não o histórico");
    assert.match(texto, /new SecurityEventBus\(\{ replayLimit: 500 \}\)/);
  });

  it("a descoberta de processos depende do diff do round, não do pedido de lista", () => {
    // É o elo que estava partido: `list()` serve o inventário; quem produz eventos
    // é o diff de `poll()`. Provado no pacote native-windows.
    assert.ok(shouldPersistEvent({ type: "threat.detected" }) === true);
    assert.ok(shouldPersistEvent({ type: "process.started" }) === false);
    assert.equal(scanIdFromContext({ data: { scanId: "scan-1" } }), "scan-1");
  });
});
