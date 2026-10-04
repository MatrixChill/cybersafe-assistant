/**
 * P1 - os DOIS auto-kills nao passavam pelo guard do kill manual.
 *
 * Em `handleProcessStart` havia dois caminhos que chamavam `terminateProcessTree`
 * sem qualquer verificacao:
 *   - por PATH   (blockedPaths)
 *   - por HASH   (blockedHashes)
 *
 * O kill MANUAL, em `killProcess`, chama
 * `classifyKillTarget(processInfo, this.killProtectionContext())` e aborta com
 * `status: "protected"` ANTES de qualquer taskkill. Os dois auto-kills nao.
 *
 * Isto e um kill `/F /T` sem verificacao, disparado por conjuntos populados
 * por deteccoes de scan. Se um falso-positivo cair num binario de sistema ou
 * num componente do proprio CyberSafe, o servico mata-o a forca e a arvore
 * toda, sem perguntar nada. E o proprio codigo ja tinha decidido NAO fazer
 * auto-kill para `taskkill.exe`/`sc.exe` com "cybersafe" na command line --
 * removeram o auto-kill desse padrao e esqueceram-se destes dois.
 *
 * O que estes testes provam, e o espirito do acceptance 6: um spy conta as
 * chamadas a `terminateProcessTree`. Sem seam, NENHUM destes testes existia --
 * a funcao era importada e chamada directamente, e nao ha como observar se foi
 * chamada. O seam e o que torna a garantia verificavel.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProtectionEngineService } from "../dist/engine.js";
import { classifyKillTarget } from "@cybersafe/core";
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
const TEST_BASE_DIR = mkdtempSync(path.join(os.tmpdir(), "cybersafe-p0-auto-kill-guard-"));


function processEntry(overrides) {
  return {
    pid: 4000,
    ppid: 1000,
    name: "alvo.exe",
    path: "C:\\Temp\\alvo.exe",
    commandLine: "C:\\Temp\\alvo.exe",
    cpu: 0,
    memoryMb: 0,
    startedAt: new Date().toISOString(),
    trusted: "unknown",
    ...overrides,
  };
}

/**
 * Motor com o seam do auto-kill injetado e sem qualquer efeito no SO: o spy
 * conta as chamadas em vez de matar seja o que for.
 */
function engineWithSpy(events) {
  const engine = new ProtectionEngineService(TEST_BASE_DIR);
  const calls = [];
  engine.runAutoKill = async (pid) => {
    calls.push(pid);
    return true;
  };
  engine.eventBus.publish = (type, severity, summary) => {
    events.push({ type, severity, summary });
    return undefined;
  };
  return { engine, calls };
}

/**
 * Um caminho que o guard canonico recusa por ser interno. Nao se escreve
 * "C:\CyberSafe" a mao: o prefixo interno real depende de onde o servico corre
 * (e o `killProtectionContext()` sabe). Usar o contexto e o que garante que o
 * teste pereia as DUAS vias em vez de testar uma string inventada.
 */
function caminhoInternoReal(engine) {
  const prefix = engine.killProtectionContext().internalPathPrefixes[0];
  assert.ok(prefix, "o contexto canonico tem de conhecer o prefixo interno");
  return `${prefix}\\alvo.exe`;
}

describe("auto-kill por PATH - passa pelo guard do kill manual", () => {
  it("T1: alvo PROTEGIDO por path -> terminateProcessTree NAO chamado, e o evento diz que nao foi terminado", async () => {
    const events = [];
    const { engine, calls } = engineWithSpy(events);
    // O PID e do utilizador (nao e protegido por PID), para que a UNICA razao da
    // recusa seja o caminho interno.
    const caminho = caminhoInternoReal(engine);
    engine.blockedPaths.add(caminho.toLowerCase());

    const alvo = processEntry({ pid: 4242, path: caminho });
    assert.ok(
      classifyKillTarget(alvo, engine.killProtectionContext()),
      "pre-condicao: o guard canonico recusa este alvo",
    );

    await engine.handleProcessStart(alvo);

    assert.equal(calls.length, 0, `terminateProcessTree foi chamado ${calls.length}x num alvo protegido`);
    assert.equal(events.length, 1, "um unico evento, de atencao");
    const ev = events[0];
    assert.notEqual(ev.type, "process.killed", "nao foi morto, nao pode dizer 'killed'");
    assert.notEqual(ev.type, "process.blocked", "nao foi parado, nao pode fingir que foi bloqueado");
    assert.equal(ev.severity, "medium", "e atencao, nao critical");
    assert.match(ev.summary, /n[aã]o foi/, `o texto tem de dizer que nao foi terminado: ${ev.summary}`);
    assert.match(ev.summary, /protegid/i, `e porquê: ${ev.summary}`);
  });

  it("T3: alvo normal com blockedPath REAL -> terminateProcessTree chamado EXACTAMENTE 1 vez, com o PID certo", async () => {
    const events = [];
    const { engine, calls } = engineWithSpy(events);
    engine.blockedPaths.add("c:\\temp\\alvo.exe");

    await engine.handleProcessStart(processEntry({ pid: 5151 }));

    assert.equal(calls.length, 1, "o auto-kill continua funcional: uma unica chamada");
    assert.deepEqual(calls, [5151], "com o PID do alvo");
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "process.blocked", "o kill normal publica o que ja publicava");
  });
});

describe("auto-kill por HASH - passa pelo guard do kill manual", () => {
  it("T2: alvo PROTEGIDO -> terminateProcessTree NAO chamado", async () => {
    const events = [];
    const { engine, calls } = engineWithSpy(events);
    const sha = "a".repeat(64);
    engine.blockedHashes.add(sha);
    // O stub tem de devolver o mesmo sha para o caminho por hash chegar ao kill.
    engine.scanArtifact = async () => ({ results: [{ sha256: sha, severity: "critical" }], overallSeverity: "critical" });

    const caminho = caminhoInternoReal(engine);
    const alvo = processEntry({ pid: 6161, path: caminho });
    assert.ok(
      classifyKillTarget(alvo, engine.killProtectionContext()),
      "pre-condicao: o guard canonico recusa este alvo",
    );

    await engine.handleProcessStart(alvo);

    assert.equal(calls.length, 0, `terminateProcessTree foi chamado ${calls.length}x num alvo protegido`);
    assert.equal(events.length, 1);
    assert.equal(events[0].severity, "medium", "e atencao, nao critical");
    assert.match(events[0].summary, /n[aã]o foi/, "o texto diz que nao foi terminado");
  });

  it("T4: alvo normal com blockedHash REAL -> chamado EXACTAMENTE 1 vez, com o PID certo", async () => {
    const events = [];
    const { engine, calls } = engineWithSpy(events);
    const sha = "b".repeat(64);
    engine.blockedHashes.add(sha);
    engine.scanArtifact = async () => ({ results: [{ sha256: sha, severity: "critical" }], overallSeverity: "critical" });

    await engine.handleProcessStart(processEntry({ pid: 7171 }));

    assert.equal(calls.length, 1, "o auto-kill por hash continua funcional");
    assert.deepEqual(calls, [7171]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "process.killed", "o kill normal por hash publica o que ja publicava");
  });
});

describe("o guard e o MESMO do manual (nenhuma lista de protegidos duplicada)", () => {
  it("T5: o que o kill manual recusa, o auto-kill tambem recusa -- casos varios", async () => {
    // Em vez de reescrever os casos, pereia as DUAS vias: dado um contexto e um
    // alvo, o guard canonico recusa E o auto-kill nao mata.
    const interno = caminhoInternoReal(engineWithSpy([]).engine);
    const casos = [
      { nome: "o proprio servico (pid)", alvo: processEntry({ pid: process.pid, path: "C:\\Temp\\alvo.exe" }) },
      { nome: "PID de sistema (<= 100)", alvo: processEntry({ pid: 4, path: "C:\\Temp\\alvo.exe" }) },
      { nome: "caminho interno do CyberSafe", alvo: processEntry({ pid: 9001, path: interno }) },
      { nome: "ancestral do servico", alvo: processEntry({ pid: 9002, ppid: process.pid, path: "C:\\Temp\\alvo.exe" }) },
    ];

    for (const { nome, alvo } of casos) {
      const events = [];
      const { engine, calls } = engineWithSpy(events);
      assert.ok(
        classifyKillTarget(alvo, engine.killProtectionContext()),
        `pre-condicao (${nome}): o guard canonico recusa`,
      );
      engine.blockedPaths.add(alvo.path.toLowerCase());

      await engine.handleProcessStart(alvo);

      assert.equal(calls.length, 0, `${nome}: terminateProcessTree foi chamado ${calls.length}x`);
      assert.equal(events.length, 1, `${nome}: um evento de atencao`);
      assert.notEqual(events[0].type, "process.killed", `${nome}: nao pode dizer 'killed'`);
    }
  });

  it("T5b: o guard do auto-kill usa o MESMO contexto do manual (self protection inclusa)", async () => {
    // Se o auto-kill usasse um contexto proprio, este PID nao seria reconhecido
    // e o teste T5 acima nao provaria nada sobre a lista partilhada.
    const { engine } = engineWithSpy([]);
    const ctx = engine.killProtectionContext();
    assert.equal(ctx.selfPid, process.pid, "o contexto canonico conhece o PID do proprio servico");
    assert.ok(
      Array.isArray(ctx.internalPathPrefixes) && ctx.internalPathPrefixes.length > 0,
      "e conhece os prefixos de caminho interno",
    );
  });
});

describe("T6 - no maximo um kill por ronda, e zero em alvo protegido", () => {
  it("path E hash a pedir no mesmo alvo -> no maximo UMA chamada por ronda", async () => {
    const events = [];
    const { engine, calls } = engineWithSpy(events);
    const sha = "c".repeat(64);
    engine.blockedPaths.add("c:\\temp\\alvo.exe");
    engine.blockedHashes.add(sha);
    engine.scanArtifact = async () => ({ results: [{ sha256: sha, severity: "critical" }], overallSeverity: "critical" });

    // O caminho por path faz `return`, logo nunca chega ao por hash: uma ronda,
    // uma chamada. Repete-se 3 rondas so para mostrar que o spy ve sempre o
    // MESMO PID e nunca dois numa ronda.
    //
    // NOTA HONESTA: este patch NAO deduplica entre rondas. Se o processo
    // continuar vivo e a deteccao repetir-se, cada ronda volta a pedir o kill.
    // O que esta garantido e o `return`, nunca dois /F /T na mesma ronda.
    for (let ronda = 0; ronda < 3; ronda++) {
      const antes = calls.length;
      await engine.handleProcessStart(processEntry({ pid: 8181 }));
      assert.equal(calls.length - antes, 1, `ronda ${ronda}: exactamente uma chamada`);
    }
    assert.ok(calls.every((pid) => pid === 8181), `so o PID do alvo: ${JSON.stringify(calls)}`);
  });

  it("alvo protegido nunca chega a taskkill, mesmo com os dois conjuntos a pedir", async () => {
    const events = [];
    const { engine, calls } = engineWithSpy(events);
    const sha = "d".repeat(64);
    engine.blockedHashes.add(sha);
    engine.scanArtifact = async () => ({ results: [{ sha256: sha, severity: "critical" }], overallSeverity: "critical" });
    const caminho = caminhoInternoReal(engine);
    engine.blockedPaths.add(caminho.toLowerCase());

    await engine.handleProcessStart(processEntry({ pid: 9191, path: caminho }));

    assert.equal(calls.length, 0, "zero kills, mesmo com path E hash a pedir");
  });
});
