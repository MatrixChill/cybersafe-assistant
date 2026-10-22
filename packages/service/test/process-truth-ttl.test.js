/**
 * Fonte de verdade, monitorizacao e janela de frescura tem de estar alinhadas.
 *
 * O defeito medido: o `ProcessMonitor` re-enumerava o SO de 10 s em 10 s, mas a
 * janela de frescura do `processes.list` era de 2 s. Com a app ligada, TODO
 * pedido de lista era uma cache miss (medido: 3 pedidos em 60 s, 0 hits, 3
 * misses), ou seja ~6 enumeracoes CIM por minuto a mais, a correr ao lado do
 * poll que ja tinha enumerado — e a enumeracao deixou de custar 0,3 s para
 * custar 8-25 s. Era essa a tempestade que o utilizador sentia como "unsos
 * segundos" ate um processo aparecer na lista.
 *
 * Estes testes fixam o contrato, nao o numero solto: se a janela voltar a ser
 * menor que a cadencia do monitor, ou a cadencia descer para um custo que nao
 * medimos, caem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProtectionEngineService } from "../dist/engine.js";
import { PROCESS_POLL_INTERVAL_MS } from "@cybersafe/native-windows";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * P0 ISOLAMENTO DE RUNTIME: raiz de dados INJETADA num tmpdir deste ficheiro.
 * Sem isto, qualquer `killProcess` num teste faria appendFile em
 * `%USERPROFILE%\.cybersafe-service\logs\actions.log` — o home real do
 * utilizador. `new ProtectionEngineService(TEST_BASE_DIR)` sem argumentos continua a
 * significar "home real" (default de PRODUÇÃO); em teste passa-se o tmpdir.
 * Ver test/p0-runtime-isolation.test.js.
 */
const TEST_BASE_DIR = mkdtempSync(path.join(os.tmpdir(), "cybersafe-p0-process-truth-ttl-"));


function entry(overrides) {
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

/** Engine com a fonte de verdade do SO controlada (nenhum PowerShell em teste). */
function engineWithTruth(truth) {
  const engine = new ProtectionEngineService(TEST_BASE_DIR);
  const calls = { enumerations: 0 };
  engine.processMonitor.list = async () => {
    calls.enumerations += 1;
    return truth;
  };
  return { engine, calls };
}

describe("janela de frescura alinhada com a cadencia de descoberta", () => {
  it("a janela e maior ou igual a cadencia do monitor (senao cada pedido re-enumerava)", () => {
    const ttl = ProtectionEngineService.PROCESS_TRUTH_TTL_MS;
    assert.ok(
      ttl >= PROCESS_POLL_INTERVAL_MS,
      `TTL de ${ttl} ms < cadencia de ${PROCESS_POLL_INTERVAL_MS} ms: todo pedido de lista re-enumerava o SO`,
    );
  });

  it("a cadencia escolhida nao rebenta o custo (a enumerable por minuto esta no codigo)", () => {
    // Medido: uma enumeracao CIM completa custa 266-297 ms de CPU (dos quais
    // ~188 ms sao o arranque do powershell.exe). 12 por minuto = ~3,6 s de CPU
    // por minuto. Acima de 30 por minuto deixava de ser defensavel.
    const perMinute = 60_000 / PROCESS_POLL_INTERVAL_MS;
    assert.ok(
      perMinute <= 30,
      `${perMinute} enumeracoes por minuto nao foi medido como aceitavel`,
    );
    assert.ok(
      PROCESS_POLL_INTERVAL_MS >= 2_000,
      `cadencia de ${PROCESS_POLL_INTERVAL_MS} ms: mais de 30 enumeracoes por minuto`,
    );
  });
});

describe("processes.list — cache hit e cache miss", () => {
  it("cache hit: pedidos seguidos dentro da janela nao tocam no SO", async () => {
    const { engine, calls } = engineWithTruth([entry({ pid: 11, name: "a.exe" })]);
    await engine.listProcesses();
    await engine.listProcesses();
    await engine.listProcesses();
    assert.equal(calls.enumerations, 1, "tres pedidos, uma enumeracao");
  });

  it("cache miss: passado o TTL a verdade volta a ser pedida ao SO", async () => {
    const { engine, calls } = engineWithTruth([entry({ pid: 11, name: "a.exe" })]);
    await engine.listProcesses();
    assert.equal(calls.enumerations, 1);
    // Envelhece o cache para alem da janela, sem esperar por ela.
    engine.processesEnumeratedAt = Date.now() - ProtectionEngineService.PROCESS_TRUTH_TTL_MS - 1;
    const list = await engine.listProcesses();
    assert.equal(calls.enumerations, 2, "cache velho tem de reconciliar a pedido");
    assert.equal(list.length, 1, "e devolve a verdade, nao o cache velho");
  });

  it("a cadencia do monitor torna o cache utilizavel pelo renderizador (a rajada de eventos)", async () => {
    // O caminho real do utilizador: o monitor descobre, publica o evento, a UI
    // pede a lista. Esse pedido tem de ser um HIT: e o proprio evento que
    // acabou de meter o processo no cache.
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    let enumerations = 0;
    engine.processMonitor.list = async () => {
      enumerations += 1;
      return [entry({ pid: 100, name: "base.exe" })];
    };
    engine.bindWatchers();
    await engine.listProcesses();
    assert.equal(enumerations, 1);

    engine.processMonitor.emit("process.started", entry({ pid: 200, name: "node.exe" }));
    const list = await engine.listProcesses();
    assert.equal(enumerations, 1, "o evento ja.trouxe a verdade: o pedido nao pode re-enumerar");
    assert.ok(
      list.some((p) => p.pid === 200),
      "e o processo novo tem de estar na lista sem esperar pelo SO",
    );
  });

  it("um processo que NASCE durante a enumeracao nao se perde (a foto e anterior ao nascimento)", async () => {
    // A corrida que a invalidez de frescura tentava tapar, sem a tapar bem: um
    // `process.started` que chega a meio da enumeracao e uma foto do SO que
    // ainda nao o viu. Overwrite simples apagava um processo VIVO da lista.
    const engine = new ProtectionEngineService(TEST_BASE_DIR);
    let calls = 0;
    engine.processMonitor.list = async () => {
      calls += 1;
      if (calls === 1) {
        // O monitor ja Publicou o nascimento, e a foto que a seguir se devolve
        // foi tirada ANTES dele: e a corrida, pela ordem em que acontece.
        engine.processMonitor.emit("process.started", entry({ pid: 500, name: "node.exe" }));
        return [entry({ pid: 100, name: "base.exe" })];
      }
      return [entry({ pid: 100, name: "base.exe" }), entry({ pid: 500, name: "node.exe" })];
    };
    engine.bindWatchers();
    const list = await engine.listProcesses();
    assert.ok(
      list.some((p) => p.pid === 500),
      "o processo que nasceu durante a enumeracao nao pode desaparecer da lista",
    );
    // E o pedido seguinte e um HIT: a corrida nao invalidou a frescura para
    // sempre (foi isso que custava 6 enumeracoes por minuto a mais).
    const before = calls;
    const segunda = await engine.listProcesses();
    assert.equal(calls, before, "a reconciliacao pôs a frescura, não uma re-enumeração");
    assert.ok(segunda.some((p) => p.pid === 500));
  });

  it("um PID morto confirmado nunca volta — nem pelo cache, nem por uma enumeracao", async () => {    const vivo = entry({ pid: 300, name: "vivo.exe" });
    const morto = entry({ pid: 400, name: "morreu.exe" });
    const { engine, calls } = engineWithTruth([vivo, morto]);
    engine.bindWatchers();

    // Saida natural: o SO ja nao o tem.
    engine.processMonitor.emit("process.exited", morto);
    const depois = await engine.listProcesses();
    assert.equal(
      depois.some((p) => p.pid === 400),
      false,
      "o morto nao pode estar na lista so porque o cache ainda o tinha",
    );
    assert.ok(depois.some((p) => p.pid === 300), "o vivo continua");

    // E mesmo que o SO (ou um evento atrasado) o traga de volta, o tombstone barra.
    const truth = [vivo, morto];
    engine.processMonitor.list = async () => truth;
    engine.processesEnumeratedAt = 0;
    const reconciliado = await engine.listProcesses();
    assert.equal(
      reconciliado.some((p) => p.pid === 400),
      false,
      "um PID morto confirmado nao pode voltar por uma enumeracao do SO",
    );
    assert.ok(calls.enumerations >= 1);
  });
});
