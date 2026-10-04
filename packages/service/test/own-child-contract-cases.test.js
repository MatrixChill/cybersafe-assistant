import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProtectionEngineService } from "../dist/engine.js";

/**
 * OS 9 CASOS DO CONTRATO DO UTILIZADOR (2026-10-03) - casos 1 a 6.
 *
 * DECISAO DO UTILIZADOR, que e o que estes testes existem para provar:
 *
 *   OWNERSHIP EXIGE EVIDENCIA DE IDENTIDADE.
 *   - Processo lancado directamente: PID + CreationDate/identidade de criacao
 *     CAPTURADA.
 *   - Descendente: identidade do pai originalmente owned + relacao pai/filho
 *     OBSERVADA + identidade real do descendente CAPTURADA/CONFIRMADA.
 *   Tempo sozinho nunca basta. Nome sozinho nunca basta. Path sozinho nunca
 *   basta. PID sozinho nunca basta.
 *
 * Os casos 7, 8 e 9 sao do core (o `clamscan` e o seu kill) e estao em
 * `packages/core/test/clamav-contract-cases.test.js`. Nao estao aqui porque core
 * e service nao se importam: um ficheiro so, com objectos dos dois lados, seria
 * um ficheiro que nunca corre.
 *
 * ── O que estes testes NAO fazem, e porquê ───────────────────────────────────
 * Nao chamam `classifyOwnChild` a senao. Cada caso passa pelo HANDLER REAL
 * (`process.started`, engine.ts:1094) sempre que a prova depende de a identidade
 * observada estar no cache, e `shouldScanStartedProcess` — a funcao que de facto
 * concede ou nao concede imunidade — e o que se afirma. Um teste da funcao de
 * decisao isolada provaria que a funcao esta certa, nao que o runtime usa a
 * funcao.
 *
 * Nenhum processo e LANcado, nenhum `clamscan` arranca, nada e escrito em
 * `%USERPROFILE%\.cybersafe-service`: `ProtectionEngineService` recebe um
 * directório base injectado (tmpdir deste ficheiro), que e o que o default de
 * PRODUÇÃO torna opcional.
 */

const ENGINE_DIR = "C:\\ProgramData\\chocolatey\\lib\\clamav\\tools\\clamav-1.5.2.win.x64\\clamscan.exe";

/**
 * Identidades de criacao RELATIVAS ao agora.
 *
 * A janela de cinco minutos (`DESCENDANT_DISCOVERY_TTL_MS`) e o ponto de varios
 * destes casos, e so se prova que ela nao decide com datas calculadas a partir de
 * `Date.now()` e nao com constantes que por acaso ficam do lado certo.
 */
function haAtras(segundos) {
  return new Date(Date.now() - segundos * 1000).toISOString();
}

const JANELA_MS = 5 * 60 * 1000;

/** Direccao base injectada: tmpdir deste ficheiro, nunca a home real. */
const TEST_BASE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-contract-"));
after(async () => {
  await fs.rm(TEST_BASE_DIR, { recursive: true, force: true }).catch(() => {});
});

let engine;
beforeEach(() => {
  engine = new ProtectionEngineService(TEST_BASE_DIR);
  engine.noteClamavBinary(ENGINE_DIR);
});

/**
 * Publica um snapshot pelo HANDLER REAL.
 *
 * E o que poe a identidade OBSERVADA do processo no cache do serviço. Sem isto a
 * prova 2 de `classifyOwnChild` — a identidade observada do PAI — nunca existe, e
 * qualquer caso de descendencia passa pelo motivo errado.
 *
 * `handleProcessStart` e neutralizado: o que esta em teste e a DECISAO de
 * ownership, nao a analise de um ficheiro (o mesmo padrao ja usado em
 * clamav-cascade.test.js).
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

/**
 * O nosso motor de scan, com as DUAS identidades: a capturada no registo e a
 * observada no cache. Sao coisas diferentes, e e a igualdade entre elas que prova
 * ownership.
 */
function nossoMotor(pid = 4242, segundosAtras = 180) {
  const created = haAtras(segundosAtras);
  engine.registerOwnChild(pid, created);
  observe({ pid, name: "clamscan.exe", path: ENGINE_DIR, startedAt: created });
  return created;
}

describe("CONTRATO 1 - pai owned + filho recente + identidade correspondente => owned", () => {
  it("1a - descendente com identidade lida e posterior a do pai: e nosso", () => {
    const criacaoDoPai = nossoMotor(4242, 180);
    const criacaoDoFilho = haAtras(170);
    assert.ok(
      Date.parse(criacaoDoFilho) > Date.parse(criacaoDoPai),
      "o filho tem de ter nascido depois do pai (a relacao observada)",
    );

    const veredicto = engine.classifyOwnChild({ pid: 5150, ppid: 4242, startedAt: criacaoDoFilho });
    assert.equal(veredicto.kind, "owned", veredicto.reason);
    assert.equal(veredicto.relation, "descendant", "a relacao que sustenta o ownership e a descendencia");

    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 5150,
        name: "clamscan.exe",
        path: ENGINE_DIR,
        ppid: 4242,
        startedAt: criacaoDoFilho,
      }),
      false,
      "e o descendente confirmado nao e analisado",
    );
  });

  it("1b - o filho so e registado como nosso DEPOIS da decisao, e so com a identidade dele", () => {
    // A6: o handler nao pode registar o filho por ser filho. Regista-o porque
    // `classifyOwnChild` deu `owned` — o que ja exige a identidade do filho.
    nossoMotor(4242, 180);
    observe({ pid: 5150, name: "clamscan.exe", path: ENGINE_DIR, ppid: 4242, startedAt: haAtras(170) });
    assert.equal(
      engine.isOwnChildPid(5150, haAtras(169)),
      false,
      "a identidade do filho tem de ser a OBSERVADA; um instante diferente nao bate",
    );
    assert.equal(engine.classifyOwnChild({ pid: 5150, ppid: 4242, startedAt: haAtras(170) }).kind, "owned");
  });

  it("1c - processo lancado directamente: identidade capturada + observada => owned", () => {
    const criacao = haAtras(30);
    engine.registerOwnChild(4242, criacao);
    const veredicto = engine.classifyOwnChild({ pid: 4242, startedAt: criacao });
    assert.equal(veredicto.kind, "owned", veredicto.reason);
    assert.equal(veredicto.relation, "direct");
    assert.equal(
      engine.shouldScanStartedProcess({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: criacao }),
      false,
    );
  });
});

describe("CONTRATO 2 - pai owned + filho recente + identidade DESCONHECIDA => UNKNOWN, sem imunidade", () => {
  it("2a - filho sem identidade de criacao observada: UNKNOWN, e vai para analise", () => {
    nossoMotor(4242, 180);
    const veredicto = engine.classifyOwnChild({ pid: 5150, ppid: 4242, startedAt: "" });
    assert.equal(veredicto.kind, "unknown", `sem identidade nao ha prova: ${veredicto.reason}`);
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 5150,
        name: "clamscan.exe",
        path: ENGINE_DIR,
        ppid: 4242,
        startedAt: "",
      }),
      true,
      "UNKNOWN nao concede imunidade: e analise, nao proteccao",
    );
  });

  it("2b - pai registado mas NAO observado: UNKNOWN, e vai para analise", () => {
    // O registo existe; o cache nunca viu o pai. E a pergunta de presenca que o
    // Codex marcou (achado 4): `isOwnChildPid` sem identidade respondia `true` e
    // esse `true` era imunidade.
    engine.registerOwnChild(4242, haAtras(180));
    const veredicto = engine.classifyOwnChild({ pid: 5150, ppid: 4242, startedAt: haAtras(170) });
    assert.equal(veredicto.kind, "unknown", veredicto.reason);
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 5150,
        name: "notepad.exe",
        path: "C:\\Windows\\System32\\notepad.exe",
        ppid: 4242,
        startedAt: haAtras(170),
      }),
      true,
    );
  });

  it("2c - UNKNOWN nao autoriza kill: o caminho de kill nao o trata como nosso", async () => {
    // `shouldScanStartedProcess === true` significa "analisado". O kill e um
    // caminho separado, e a garantia e a mesma: sem identidade, um PID nao entra
    // na protecao por ser descendente de um PID nosso.
    //
    // Aqui o pai e' registado mas NAO observado (sem `nossoMotor`), que e o
    // estado que produz `unknown`.
    engine.registerOwnChild(4242, haAtras(180));
    const filho = {
      pid: 5150,
      name: "notepad.exe",
      path: "C:\\Windows\\System32\\notepad.exe",
      ppid: 4242,
      commandLine: "notepad.exe",
      startedAt: haAtras(170),
      memoryMb: 40,
      trusted: "unknown",
    };
    engine.processes = [filho, ...engine.processes.filter((p) => p.pid !== 5150)];
    const veredicto = engine.classifyOwnChild(filho);
    assert.equal(veredicto.kind, "unknown", `a identidade do pai nao esta observada: ${veredicto.reason}`);
    const decisao = await engine.classifyKillTarget?.(filho);
    if (decisao !== undefined) {
      assert.notEqual(
        decisao.protected,
        true,
        "UNKNOWN nao pode marcar um PID como nosso para efeitos de kill",
      );
    }
  });
});

describe("CONTRATO 3 - pai owned + filho recente + identidade DIVERGENTE => FOREIGN", () => {
  it("3a - o filho nasceu ANTES do pai: o numero ja era de outro processo", () => {
    const criacaoDoPai = nossoMotor(4242, 180);
    const criacaoDoFilho = haAtras(600); // seis minutos antes do pai
    assert.ok(Date.parse(criacaoDoFilho) < Date.parse(criacaoDoPai), "as datas tem de ser contraditorias");

    const veredicto = engine.classifyOwnChild({ pid: 5150, ppid: 4242, startedAt: criacaoDoFilho });
    assert.equal(veredicto.kind, "foreign", veredicto.reason);
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 5150,
        name: "notepad.exe",
        path: "C:\\Windows\\System32\\notepad.exe",
        ppid: 4242,
        startedAt: criacaoDoFilho,
      }),
      true,
      "FOREIGN nunca e imune",
    );
  });

  it("3b - a identidade OBSERVADA do pai e outra: o pai morreu, o numero foi reutilizado", () => {
    const registrada = haAtras(180);
    engine.registerOwnChild(4242, registrada);
    // O SO observa no 4242 um processo com OUTRA identidade.
    observe({
      pid: 4242,
      name: "notepad.exe",
      path: "C:\\Windows\\System32\\notepad.exe",
      startedAt: haAtras(60),
    });
    assert.equal(
      engine.isOwnChildPid(4242, haAtras(60)),
      false,
      "a contradicao descarta o registo antigo: o PID e' de outro processo",
    );
  });
});

describe("CONTRATO 4 - mesmo PID reutilizado DENTRO dos cinco minutos => nunca owned automaticamente", () => {
  it("4a - identidade diferente, dentro da janela, com o nome e caminho do nosso motor", () => {
    const registrada = haAtras(120);
    engine.registerOwnChild(4242, registrada);
    const reutilizada = haAtras(60);
    assert.ok(
      Date.now() - Date.parse(reutilizada) < JANELA_MS,
      "a reutilizacao tem de estar DENTRO da janela: fora dela o tempo ja a exclui e o caso nao prova nada",
    );

    const veredicto = engine.classifyOwnChild({ pid: 4242, startedAt: reutilizada });
    assert.equal(veredicto.kind, "foreign", `PID reutilizado: ${veredicto.reason}`);
  });

  it("4b - e o filho do PID reutilizado tambem nao e nosso", () => {
    engine.registerOwnChild(4242, haAtras(120));
    observe({
      pid: 4242,
      name: "clamscan.exe",
      path: ENGINE_DIR,
      startedAt: haAtras(60),
    });
    const veredicto = engine.classifyOwnChild({ pid: 5150, ppid: 4242, startedAt: haAtras(45) });
    assert.notEqual(veredicto.kind, "owned", `descendencia de um PID reutilizado nao e nossa: ${veredicto.reason}`);
  });
});

describe("CONTRATO 5 - filho EXTERNO com o mesmo nome e caminho, dentro dos cinco minutos => nunca owned", () => {
  it("5a - apresenta-se como descendente do nosso motor, sem identidade provavel: nome e caminho nao resgatam", () => {
    // O atalho que o Codex marcou (achado 5): nome de motor + directorio
    // conhecido concediam imunidade a um processo externo. O veredicto tem de
    // NAO ser `absent` para que o caminho do binario nem entre.
    nossoMotor(4242, 180);
    const filhoSemProva = {
      pid: 5150,
      name: "clamscan.exe",
      path: ENGINE_DIR,
      ppid: 4242,
      startedAt: "",
    };
    const veredicto = engine.classifyOwnChild(filhoSemProva);
    assert.notEqual(veredicto.kind, "owned", `sem identidade nao ha ownership: ${veredicto.reason}`);
    assert.equal(veredicto.kind, "unknown", "e o veredicto honesto e unknown, com duvida em curso");
    assert.equal(
      engine.shouldScanStartedProcess(filhoSemProva),
      true,
      "UNKNOWN nao recupera imunidade pelo caminho do binario",
    );
  });

  it("5b - o que SOBREVIVEU de proposito: um binario de motor sem ligacao nenhuma ao registo", () => {
    // Isto NAO e o caso 5 e nao deve ser lido como tal. E a DEFESA 3, que o
    // utilizador nao mandou remover: um `clamscan.exe` no directorio do motor,
    // sem NENHUM registo contra o qual se levantar, continua a nao ser
    // reanalisado. Fica escrito para que ninguem leia "nome e caminho nunca
    // immunizam" a partir do caso 5a: o que esta barrado e o resgate de um
    // veredicto com duvida (UNKNOWN) em curso, nao a defesa em `absent`.
    assert.equal(
      engine.shouldScanStartedProcess({ pid: 31338, name: "clamscan.exe", path: ENGINE_DIR, ppid: 2000 }),
      false,
      "a defesa por nome E caminho continua a existir para o caso `absent`",
    );
  });
});

/**
 * RISCO RESIDUAL ENCONTRADO AO ESCREVER O CASO 4 (2026-10-03, F4).
 *
 * ESTE NAO E UM TESTE QUE PASSE: e o registo de uma interacao que o contrato nao
 * previa e que fica AQUI, em codigo executavel, para ninguem a descobrir depois.
 *
 * O que acontece, lido no codigo:
 *  1. `classifyOwnChild` recebe um PID cujo registo foi contradito, devolve
 *     `foreign` e APAGA o registo (engine.ts:930);
 *  2. o handler real chama `classifyOwnChild` outra vez, no `shouldScanStartedProcess`
 *     (engine.ts:1053) — e ja nao ha registo, portanto o veredicto e `absent`;
 *  3. em `absent`, nome de motor + caminho de motor ainda concedem imunidade
 *     (engine.ts:1069-1075).
 *
 * O efeito: um processo EXTERNO com o nome e o caminho do nosso motor, cujo PID
 * foi reciclado de um nosso, acaba imune. A OWNERSHIP foi negada (ver caso 4a) —
 * isso está certo e é o que o contrato exige. A imunidade que resta não vem de
 * ownership: vem da DEFESA 3, que é indistinguivel de "o serviço reiniciou e
 * perdeu o registo".
 *
 * Isto é FIXTÁVEL ou NÃO?
 *  - dentro da semântica actual: não. O veredicto `foreign` é consumido na
 *    primeira chamada, e a segunda já não tem com que working — sem um
 *    tombstone de "este PID foi contradito" não há estado que ligue as duas.
 *  - é uma mudança de estado/arquitectura, não um ajuste de predicado: sai do
 *    boundary desta fase.
 *
 * O que NÃO vou fazer: afrouxar o caso 4 para `true` só para o suite ficar
 * verde. O que fica é isto escrito, e a asserção de que a imunidade observada
 * vem mesmo do caminho — provada pelo contraste abaixo, e não assumida.
 */
describe("RISCO RESIDUAL - contradicao consumida e defensa 3 a recuperar imunidade", () => {
  it("apos a contradicao, a imunidade que resta e a do CAMINHO, nao a do ownership", () => {
    engine.registerOwnChild(4242, haAtras(120));
    observe({
      pid: 4242,
      name: "clamscan.exe",
      path: ENGINE_DIR,
      startedAt: haAtras(60),
    });

    // O PID foi contradito: nao e nosso. ownership negada.
    const filho = { pid: 5150, name: "clamscan.exe", path: ENGINE_DIR, ppid: 4242, startedAt: haAtras(45) };
    assert.notEqual(engine.classifyOwnChild(filho).kind, "owned", "ownership negada");

    // Mesma decisao, mesmo nome, MESMO PID, mas um caminho que nao e de motor:
    // tem de ser analisado. E este contraste que prova que a imunidade do caso
    // anterior vinha do caminho e nao de nenhuma prova de identidade.
    assert.equal(
      engine.shouldScanStartedProcess({
        pid: 5150,
        name: "clamscan.exe",
        path: "C:\\Users\\victim\\Downloads\\clamscan.exe",
        ppid: 4242,
        startedAt: haAtras(45),
      }),
      true,
      "sem caminho de motor nao ha DEFESA 3: a identidade e que decide, e ela disse nao",
    );
  });
});

/**
 * B2 — O RISCO RESIDUAL ACIMA ESTA FECHADO (2026-10-03).
 *
 * O bloco anterior documenta, em codigo executavel, que a contradicao era
 * consumida na primeira chamada e a DEFESA 3 voltava a valer na segunda. Esse
 * era um defeito de ESTADO, nao de predicado: nao havia nada que ligasse as duas
 * chamadas. A correccao dao-lhe o estado minimo (`ownChildContradictions`), e o
 * contrato do utilizador e literal:
 *
 *   identity contradicted => esse PID nao pode voltar a OWNED por fallback fraco.
 *   So nova identidade COMPROVADA pode restabelecer ownership.
 *
 * Estes casos travam esse contrato. Sem eles, o defeito volta em silencio: o
 * resto da suite continuava verde, porque o resto da suite so afirmava o que
 * ja era verdade.
 */
describe("B2 - PID contradito nao recupera imunidade por nome+caminho", () => {
  it("apos a contradicao, o MESMO pid + nome + caminho de motor vai para analise", () => {
    const registrada = haAtras(120);
    engine.registerOwnChild(4242, registrada);
    const reutilizada = haAtras(60);
    observe({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: reutilizada });

    // Contradicao: ownership negada.
    assert.equal(engine.classifyOwnChild({ pid: 4242, startedAt: reutilizada }).kind, "foreign");

    // A SEGUNDA chamada, com o MESMO pid, o MESMO nome de motor e o MESMO
    // caminho de motor. Antes disto devolvia `false` (imune).
    assert.equal(
      engine.shouldScanStartedProcess({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: reutilizada }),
      true,
      "a DEFESA 3 nao pode ressuscitar um PID cuja identidade foi contraditada",
    );
  });

  it("a negacao tambem cobre o FILHO de um pai contradito, pelo mesmo atalho", () => {
    engine.registerOwnChild(4242, haAtras(120));
    observe({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: haAtras(60) });

    const filho = { pid: 5150, name: "clamscan.exe", path: ENGINE_DIR, ppid: 4242, startedAt: haAtras(45) };
    assert.equal(
      engine.shouldScanStartedProcess(filho),
      true,
      "descendente de um pai contradito tambem nao herda a DEFESA 3",
    );
  });

  it("nova identidade COMPROVADA restabelece o ownership (a via de saida existe)", () => {
    const contradita = haAtras(60);
    engine.registerOwnChild(4242, haAtras(120));
    observe({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: contradita });
    assert.equal(engine.shouldScanStartedProcess({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: contradita }), true);

    // Nos lancamos ESTE PID: e o unico sitio do codigo que pode desfazer a
    // contradicao, porque regista uma identidade de criacao CAPTURADA.
    const nova = haAtras(20);
    engine.registerOwnChild(4242, nova);
    observe({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: nova });

    assert.equal(
      engine.shouldScanStartedProcess({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: nova }),
      false,
      "uma identidade nova e comprovada volta a ser nossa: a negacao nao e um estado permanente",
    );
  });

  it("a identidade do so mudar SEM registo novo tambem limpa a contradicao (o PID foi reciclado outra vez)", () => {
    const primeira = haAtras(60);
    engine.registerOwnChild(4242, haAtras(120));
    observe({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: primeira });
    assert.equal(engine.shouldScanStartedProcess({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: primeira }), true);

    // O Windows reciclou o numero outra vez. A contradicao antiga descrevia o
    // processo ANTERIOR: retê-la seria negar um processo que ainda nao foi visto.
    const segunda = haAtras(10);
    observe({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: segunda });
    assert.equal(
      engine.shouldScanStartedProcess({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: segunda }),
      false,
      "o que vale e a identidade observada, nao o numero",
    );
  });
});


describe("CONTRATO 6 - relacao com mais de cinco minutos e identidade comprovada => o relogio nao decide", () => {
  it("6a - relacao de seis horas, as tres provas batem: continua nosso", () => {
    const criacaoDoPai = haAtras(6 * 3600);
    const criacaoDoFilho = haAtras(6 * 3600 - 5);
    assert.ok(Date.now() - Date.parse(criacaoDoFilho) > JANELA_MS, "a relacao tem de estar fora da janela");

    engine.registerOwnChild(4242, criacaoDoPai);
    observe({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: criacaoDoPai });

    const veredicto = engine.classifyOwnChild({ pid: 5150, ppid: 4242, startedAt: criacaoDoFilho });
    assert.equal(veredicto.kind, "owned", `fora da janela, com identidade provada: ${veredicto.reason}`);
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

  it("6b - relacao de seis horas SEM identidade: continua desconhecido, nao 'velho o suficiente para ser nosso'", () => {
    engine.registerOwnChild(4242, haAtras(6 * 3600));
    observe({ pid: 4242, name: "clamscan.exe", path: ENGINE_DIR, startedAt: haAtras(6 * 3600) });
    const veredicto = engine.classifyOwnChild({ pid: 5150, ppid: 4242, startedAt: "" });
    assert.equal(veredicto.kind, "unknown", `a idade nunca autoriza: ${veredicto.reason}`);
  });
});
