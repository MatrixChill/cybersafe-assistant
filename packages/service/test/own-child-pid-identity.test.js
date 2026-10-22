import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProtectionEngineService } from "../dist/engine.js";

/**
 * P1-6 (Codex) — OWNERSHIP DE PIDS ANTIGOS.
 *
 * O registo de "filhos próprios" é a defesa que dá imunidade de análise E de
 * auto-kill. Hoje é `Map<pid, Date.now()>`: o PID sozinho prova ownership, para
 * sempre, e `releaseOwnChild()` não é chamado por lado nenhum. Um PID
 * reutilizado DENTRO da mesma sessão herda a imunidade — um processo externo
 * fica invisível para o scanner e, pior, pode ser morto por `runAutoKill` como
 * se fosse nosso.
 *
 * O que o Codex verificou (e que não se redescobre):
 *  - não há persistência em disco, o Map é por instância ⇒ limpar no arranque
 *    não resolve; o problema é reutilização dentro da mesma sessão;
 *  - PPID sozinho também não pode conceder imunidade;
 *  - `path` vazio, ou um prefixo de directório, não provam ownership.
 *
 * Identidade = PID + identidade de CRIAÇÃO (`ProcessSnapshot.startedAt`, que o
 * ProcessMonitor já preenche com a CreationDate do Windows).
 */

const ENGINE_DIR = "C:\\ProgramData\\chocolatey\\lib\\clamav\\tools\\clamav-1.5.2.win.x64\\clamscan.exe";
const CREACAO_NOSSA = "2026-10-02T10:00:00.0000000+00:00";
const CREACAO_REUTILIZADA = "2026-10-02T11:22:33.0000000+00:00";

/**
 * Identidades de criação RELATIVAS ao agora, para os casos em que a janela de
 * cinco minutos é o ponto.
 *
 * T16: o teste antigo ("FILHOS do PID reutilizado") passava porque as datas
 * distavam 1 h 22 min — ou seja, porque EXCEDIAM a janela, e não porque se
 * tivesse confirmado outra identidade do pai. Duas identities a 90 s uma da
 * outra estão, ambas, dentro dos cinco minutos: só a identidade pode separá-las.
 */
function haAtras(segundos) {
  return new Date(Date.now() - segundos * 1000).toISOString();
}

const JANELA_MS = 5 * 60 * 1000;

const TEST_BASE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-ownchild-"));
after(async () => {
  await fs.rm(TEST_BASE_DIR, { recursive: true, force: true }).catch(() => {});
});

let engine;
beforeEach(() => {
  engine = new ProtectionEngineService(TEST_BASE_DIR);
  engine.noteClamavBinary(ENGINE_DIR);
});

/**
 * Publica um snapshot pelo HANDLER REAL (`process.started`), para que a
 * identidade OBSERVADA do processo entre no cache do serviço.
 *
 * É a via honesta de a obter: `classifyOwnChild` exige a identidade observada do
 * PAI, e um pai só a tem se o cache a viu. Emitir o evento é o que a põe lá —
 * sem isto, qualquer teste de descendência passa pelo motivo errado.
 *
 * `handleProcessStart` é neutralizado porque o que está em teste é a decisão de
 * ownership, não a análise do ficheiro.
 */
function observe(snapshot) {
  engine.handleProcessStart = () => {};
  engine.bindWatchers();
  engine.processMonitor.emit("process.started", {
    memoryMb: 0,
    trusted: "unknown",
    commandLine: "",
    path: "",
    ppid: 0,
    ...snapshot,
  });
}

describe("P1-6 — o PID reutilizado nunca herda a imunidade", () => {
  it("mesmo PID, outra criação: o processo novo É analisado", () => {
    // Lançámos o PID 4242 (identidade de criação A). O processo morreu e o
    // Windows deu o MESMO número a um programa externo (identidade B).
    engine.registerOwnChild(4242, CREACAO_NOSSA);

    const externo = {
      pid: 4242,
      name: "notepad.exe",
      path: "C:\\Windows\\System32\\notepad.exe",
      startedAt: CREACAO_REUTILIZADA,
    };
    assert.equal(
      engine.shouldScanStartedProcess(externo),
      true,
      "um PID reutilizado com OUTRA identidade de criação não pode ser imune por herança",
    );
  });

  it("T16 - os FILHOS do PID reutilizado sao analisados, DENTRO dos cinco minutos", () => {
    // O teste antigo usava `CREACAO_NOSSA` (10:00) e `CREACAO_REUTILIZADA`
    // (11:22): 1 h 22 min de distanca, muito ACIMA da janela de cinco minutos.
    // Passava porque o relógio excluia o caso, nao porque se tivesse provado que
    // o pai e outro processo. Aqui as duas identities distam 90 s: as duas estao
    // DENTRO da janela, e o tempo nao pode decidir nada.
    const criacaoRegistrada = haAtras(180);
    const criacaoDoOutro = haAtras(90);
    assert.ok(
      Math.abs(Date.parse(criacaoDoOutro) - Date.parse(criacaoRegistrada)) < JANELA_MS,
      "as duas identities tem de estar dentro da janela: senao o teste volta a passar pelo relogio",
    );

    // Lancamos o PID 4242 com a identidade A. O SO mantem esse numero, mas quem
    // o ocupa agora nasceu com a identidade B.
    engine.registerOwnChild(4242, criacaoRegistrada);
    observe({
      pid: 4242,
      name: "notepad.exe",
      path: "C:\\Windows\\System32\\notepad.exe",
      startedAt: criacaoDoOutro,
    });

    // O que o registo diz do 4242 e' a identidade A; o que o SO observa no 4242 e'
    // a identidade B. Sao a mesma instancia? Nao — e o handler real aplica isso
    // sozinho: a contradicao DESCARTA o registo antigo (engine.ts:930).
    assert.equal(
      engine.isOwnChildPid(4242, criacaoDoOutro),
      false,
      "o PID 4242 pertence a outro processo e nao pode continuar nosso",
    );
    assert.equal(
      engine.classifyOwnChild({ pid: 4242, startedAt: criacaoRegistrada }).kind,
      "absent",
      "a identidade antiga tambem ja nao concede nada: o registo foi descartado pela contradicao",
    );

    // Um `notepad.exe` cujo pai e o 4242 RECICLADO, observado, dentro da janela.
    const filhoDoReutilizado = {
      pid: 5150,
      name: "notepad.exe",
      path: "C:\\Windows\\System32\\notepad.exe",
      ppid: 4242,
      startedAt: haAtras(60),
    };
    assert.equal(
      engine.shouldScanStartedProcess(filhoDoReutilizado),
      true,
      "descendencia de um PID reutilizado nao herda imunidade, dentro ou fora da janela",
    );
  });

  it("T16b - e uma relacao com mais de cinco minutos, com identidade provada, continua nossa", () => {
    // O outro lado do mesmo caso: a idade da relacao NAO decide. Uma relacao com
    // mais de cinco minutos continua `owned` se as tres provas baterem.
    const criacaoDoPai = haAtras(60 * 60 * 6); // seis horas: muito fora da janela
    const criacaoDoFilho = haAtras(60 * 60 * 6 - 5); // cinco segundos depois do pai
    // A idade da RELACAO e' ha quanto tempo o descendente nasceu, nao a diferenca
    // entre as duas identidades de criacao.
    assert.ok(
      Date.now() - Date.parse(criacaoDoFilho) > JANELA_MS,
      "a relacao tem de estar mesmo fora dos cinco minutos",
    );

    engine.registerOwnChild(4242, criacaoDoPai);
    observe({
      pid: 4242,
      name: "clamscan.exe",
      path: ENGINE_DIR,
      startedAt: criacaoDoPai,
    });

    const veredicto = engine.classifyOwnChild({
      pid: 5150,
      ppid: 4242,
      startedAt: criacaoDoFilho,
    });
    assert.equal(
      veredicto.kind,
      "owned",
      `uma relacao antiga com identidade provada e nossa: ${veredicto.reason}`,
    );
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 5150,
        name: "clamscan.exe",
        path: ENGINE_DIR,
        ppid: 4242,
        startedAt: criacaoDoFilho,
      }),
      false,
    );
  });

  it("T16c - e UNKNOWN (pai registado mas nao observado) nao concede imunidade", () => {
    // Sem identidade OBSERVADA do pai, o veredicto honesto e `unknown` — e
    // `unknown` nao concede imunidade: o processo vai para analise.
    const criacaoRegistrada = haAtras(30);
    engine.registerOwnChild(4242, criacaoRegistrada);
    // Sem `observe()`: o registo existe, o cache nao viu o pai.

    const veredicto = engine.classifyOwnChild({ pid: 5150, ppid: 4242, startedAt: haAtras(20) });
    assert.equal(veredicto.kind, "unknown", `sem observacao do pai nao ha prova: ${veredicto.reason}`);
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 5150,
        name: "notepad.exe",
        path: "C:\\Windows\\System32\\notepad.exe",
        ppid: 4242,
        startedAt: haAtras(20),
      }),
      true,
      "UNKNOWN nao concede imunidade: a falta de prova e analise, nao proteccao",
    );
  });

  it("a MESMA criação continua imune (não estragamos o caminho bom)", () => {
    engine.registerOwnChild(4242, CREACAO_NOSSA);
    const nosso = {
      pid: 4242,
      name: "clamscan.exe",
      path: ENGINE_DIR,
      startedAt: CREACAO_NOSSA,
    };
    assert.equal(engine.shouldScanStartedProcess(nosso), false, "o nosso próprio motor continua imune");
  });

  it("a reconciliação apanha a reutilização SEM evento de saída", () => {
    // O caminho critico: NÃO houve `process.exited` (o poll pode ter falhado, ou
    // o processo morreu entre dois polls). A identidade de criação é o que
    // denuncia a reutilização, e a reconciliação dos snapshots é quem a aplica.
    engine.registerOwnChild(7001, CREACAO_NOSSA);
    assert.equal(engine.isOwnChildPid(7001, CREACAO_NOSSA), true);

    // Snapshot do SO: o 7001 existe, mas nasceu agora.
    const descartados = engine.reconcileOwnChildren([{ pid: 7001, startedAt: CREACAO_REUTILIZADA }]);

    assert.equal(descartados, 1, "o registo antigo tem de ser descartado");
    assert.equal(engine.isOwnChildPid(7001, CREACAO_REUTILIZADA), false, "o PID e' de outro processo: a imunidade antiga morre");
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 7001,
        name: "notepad.exe",
        path: "C:\\Windows\\System32\\notepad.exe",
        startedAt: CREACAO_REUTILIZADA,
      }),
      true,
    );
  });

  it("reconciliação sem evento de saída: um PID ausente NÃO é prova de morte", () => {
    engine.registerOwnChild(7002, CREACAO_NOSSA);
    // O snapshot não traz o 7002 (o poll é uma foto, pode não o apanhar).
    engine.reconcileOwnChildren([{ pid: 9999, startedAt: CREACAO_NOSSA }]);
    assert.equal(
      engine.isOwnChildPid(7002, CREACAO_NOSSA),
      true,
      "ausência na foto não é saída confirmada: o registo fica (e é removido na saída confirmada)",
    );
  });

  it("a saída CONFIRMADA liberta o registo", () => {
    engine.registerOwnChild(7003, CREACAO_NOSSA);
    // `process.exited` só é publicado quando o Windows já matou o processo.
    engine.handleNaturalProcessExit({
      pid: 7003,
      name: "clamscan.exe",
      path: ENGINE_DIR,
      commandLine: "",
      startedAt: CREACAO_NOSSA,
    });
    assert.equal(engine.ownChildCount(), 0, "a saída confirmada tem de largar o PID");
    assert.equal(engine.isOwnChildPid(7003), false);
  });

  it("`path` vazio não prova ownership", () => {
    assert.equal(
      engine.shouldScanStartedProcess({ pid: 9001, name: "clamscan.exe", path: "" }),
      true,
      "um clamscan.exe sem caminho não pode ser poupado só pelo nome",
    );
    assert.equal(
      engine.shouldScanStartedProcess({ pid: 9002, name: "clamscan.exe" }),
      true,
      "nem um clamscan.exe de que ninguém sabe o caminho",
    );
  });

  it("um prefixo de directório não é um directório de motor", () => {
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 9003,
        name: "clamscan.exe",
        path: "C:\\Program Files\\ClamAV-tools\\clamscan.exe",
      }),
      true,
      "'C:\\Program Files\\ClamAV-tools' NÃO está dentro de 'C:\\Program Files\\ClamAV'",
    );
  });

  it("o caminho dentro do directório do motor continua a comprovar", () => {
    assert.equal(
      engine.shouldScanStartedProcess({ pid: 9004, name: "clamscan.exe", path: ENGINE_DIR }),
      false,
      "o clamscan verdadeiro, no directório do motor, continua imune",
    );
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 9005,
        name: "clamscan.exe",
        path: "C:\\Program Files\\ClamAV\\freshclam.exe",
      }),
      false,
    );
  });

  it("a janela continua limitada (não pode ser um leak)", () => {
    for (let i = 0; i < 5000; i++) engine.registerOwnChild(100000 + i, CREACAO_NOSSA);
    assert.ok(engine.ownChildCount() <= 1024, `a janela tem de ser limitada, ficou com ${engine.ownChildCount()}`);
  });

  it("NENHUM processo externo é morto por causa disto", async () => {
    // O anti-kill também passa pela identidade. Um PID reutilizado tem de estar
    // no caminho de decisão como "analisado", nunca como "nosso".
    engine.registerOwnChild(4242, CREACAO_NOSSA);
    engine.reconcileOwnChildren([{ pid: 4242, startedAt: CREACAO_REUTILIZADA }]);

    const externo = {
      pid: 4242,
      name: "notepad.exe",
      path: "C:\\Windows\\System32\\notepad.exe",
      commandLine: "notepad.exe",
      startedAt: CREACAO_REUTILIZADA,
      memoryMb: 40,
      trusted: "unknown",
    };
    assert.equal(engine.shouldScanStartedProcess(externo), true, "tem de ir para análise");
    const decisao = await engine.classifyKillTarget?.(externo);
    if (decisao !== undefined) {
      assert.notEqual(decisao.protected, true, "o anti-kill não pode protecting um PID reutilizado");
    }
  });
});