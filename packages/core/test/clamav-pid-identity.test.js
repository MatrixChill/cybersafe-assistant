import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ClamavBridge,
  classifyProcessIdentity,
  createSpawnClamav,
  createWindowsIdentityProbe,
  expectedIdentityFor,
  parseTasklistImageName,
} from "../dist/index.js";
import { isLoadProof, makeLoadProofHandle } from "./fixtures/clamav-load-proof.js";

/**
 * P1-2 — `killProcessTree()` mata por PID, e PID nao e identidade.
 *
 * ── O mecanismo, lido no codigo ──────────────────────────────────────────────
 * `packages/core/src/clamav.ts` `killProcessTree()` faz
 * `sync("taskkill", ["/PID", String(child.pid), "/T", "/F"])`. O `child.pid` foi
 * lido uma unica vez, no spawn. Entre o spawn e o `killTree()` (deadline,
 * abort, dispose) o clamscan pode ter MORRIDO sem que o `close` tenha chegado
 * ao loop — o `close` espera pelo fecho dos pipes, e um neto que herde o stdout
 * segura-o. Nesse intervalo o Windows pode reciclar o PID. O `taskkill /T`
 * deixa de ser "matar o clamscan" e passa a ser "matar a arvore de um processo
 * do utilizador".
 *
 * PID sozinho nao e identidade: e por isso que este teste existe.
 *
 * ── Porque este teste NAO corre processos reais ──────────────────────────────
 * O bug precisa de um clamscan que morre E de um PID reciclado, o que nao se
 * fabrica de forma confiavel. O filho do `child_process` e SIMULADO
 * (`createSpawnClamav`) e e o `spawnClamav` REAL — o `killTree`, o
 * `killProcessTree`, o veredicto e o `close` sao os de producao. A sonda
 * injecta a LINHA que o CIM devolveria, nunca o veredicto: classificar e
 * sempre logica de producao. Nenhum clamscan e lancado.
 *
 * O unico teste que toca no SO e o do probe CIM real, no fim do ficheiro: le a
 * linha `Win32_Process` do processo que o proprio teste lanca (nenhum processo
 * do utilizador, nenhum kill).
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCAN_ARGS = ["--database=C:\\defs", "C:\\scan\\alvo.exe"];

/** Filho simulado. `exitCode` definido = o Node ja viu o processo sair. */
function makeFakeChild({ pid, exited = false }) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = exited ? 0 : null;
  child.signalCode = null;
  const state = { killCalls: 0, died: false };
  child.state = state;
  child.kill = () => {
    state.killCalls++;
    child.die(0);
    return true;
  };
  child.die = (code) => {
    if (state.died) return;
    state.died = true;
    setTimeout(() => child.emit("close", code), 0);
  };
  return child;
}

/** A linha que o CIM devolveria para o NOSSO clamscan. */
function oursRow(pid = 4242, created = new Date(Date.now() - 50).toISOString()) {
  return {
    pid,
    ppid: process.pid,
    name: "clamscan.exe",
    exe: "C:\\Program Files\\ClamAV\\clamscan.exe",
    created,
    cmd: '"C:\\Program Files\\ClamAV\\clamscan.exe" --database=C:\\defs C:\\scan\\alvo.exe',
  };
}

/**
 * A identidade de criacao REAL do filho, como a captura do spawn a le do SO.
 *
 * Sem este campo o veredicto e `unavailable` POR DESENHO — e e por isso que os
 * testes deste ficheiro o montam explicitamente: um `ours` obtido sem ele seria o
 * defeito, nao a correccao.
 */
function esperadoComCaptura(created = new Date(Date.now() - 50).toISOString(), spawnedAtMs = Date.now() - 3_000) {
  const expected = expectedIdentityFor("clamscan", SCAN_ARGS, spawnedAtMs);
  expected.capturedCreated = created;
  return expected;
}

/** A linha que o CIM devolveria para um PID RECICLADO por um processo do usuario. */
function strangerRow(pid = 4242) {
  return {
    pid,
    ppid: process.pid + 1,
    name: "notepad.exe",
    exe: "C:\\Windows\\System32\\notepad.exe",
    created: new Date(Date.now() - 120_000).toISOString(),
    cmd: '"C:\\Windows\\System32\\notepad.exe" C:\\Users\\caioc\\Documentos\\notas.txt',
  };
}

/**
 * `spawn`/`spawnSync`/`probeIdentity` simulados.
 *
 * `makeHooks` passou a distinguir CAPTURA de DECISAO. Sem `captureIdentity`, o
 * `createSpawnClamav` usa a propria sonda para capturar, e essa leitura entrava na
 * contagem — um teste que asserta "a identidade foi lida 0 vezes" passava a ver 1
 * e falhava sem razao, e um teste que asserta ">= 1" nao via a resolucao.
 *
 * `terminationSessions` conta as sessoes de handle (o `taskkill` nao existe
 * neste caminho) e `child` fica exposto para se poder afirmar que o filho
 * morreu MESMO, e nao apenas que um comando foi escrito.
 */
function makeHooks({ pid = 4242, exited = false, row = oursRow(4242), probeFailed = false, identityConfirmed = false } = {}) {
  const child = makeFakeChild({ pid, exited });
  const state = { terminationSessions: 0, probeCalls: 0, captureCalls: 0, scripts: [], child };
  const spawnFn = () => child;
  const spawnSync = (cmd, args) => {
    state.terminationSessions++;
    state.scripts.push({ cmd: String(cmd), script: String(args?.[args.length - 1] ?? "") });
    if (String(cmd).toLowerCase().includes("taskkill")) {
      throw new Error("taskkill nao existe neste caminho: a terminacao e por handle");
    }
    return {
      status: 0,
      stdout: JSON.stringify({ v: "killed", root: true, descendants: 0, refused: 0 }),
    };
  };
  const probeIdentity = (asked) => {
    state.probeCalls++;
    return { row, probeFailed, detail: "simulado" };
  };
  const capture = { row: identityConfirmed ? row : null, probeFailed: identityConfirmed ? false : true, detail: "captura" };
  const hooks = {
    spawn: spawnFn,
    spawnSync,
    probeIdentity,
    captureIdentity: async () => {
      state.captureCalls++;
      return capture;
    },
  };
  return { hooks, state, child };
}

function launchHandle(hooks) {
  const spawnClamav = createSpawnClamav(hooks);
  return spawnClamav("clamscan", SCAN_ARGS, { timeoutMs: 10_000, windowsHide: true });
}

/**
 * `killTree()` e assincrono: a decisao de matar depende de ler a identidade, e
 * essa leitura pode falhar e ser repetida. Um teste que verificasse logo a seguir
 * ao `killTree()` estaria a ver o estado ANTES da decisao.
 *
 * A espera e pela CONTAGEM de sessoes de terminacao, com um tecto: e o unico
 * sinal de que a decisao chegou, e nao ha sleep que prove uma coisa nem outra.
 */
async function killAndSettle(hooks, { waitFor = null, timeoutMs = 2_000 } = {}) {
  const handle = launchHandle(hooks);
  handle.killTree();
  const state = hooks.__state;
  const deadline = Date.now() + timeoutMs;
  // A espera e por um SINAL DA DECISAO (uma sessao de terminacao, um numero de
  // leituras), com tecto. Um `sleep` fixo mediria o sleep; e nao ha
  // `killTreeAsync` no handle, portanto o microtask sozinho chega para o caso
  // "a decisao ja está tomada".
  while (waitFor && Date.now() < deadline) {
    if (waitFor(state)) break;
    await sleep(10);
  }
  await new Promise((r) => setImmediate(r));
  return handle;
}

describe("P1-2 - o taskkill nunca pode atingir um PID que nao e nosso", () => {
  it("um PID cujo ocupante nao e o nosso filho nao pode levar taskkill", async () => {
    const { hooks, state } = makeHooks({ row: strangerRow(4242) });
    hooks.__state = state;
    await killAndSettle(hooks);

    assert.equal(
      state.terminationSessions,
      0,
      `a terminacao foi lancada contra um PID cujo ocupante nao e o nosso filho: ` +
        `${JSON.stringify(state.scripts)}. Com /T isso mata a arvore de um ` +
        `processo do UTILIZADOR.`,
    );
    assert.ok(state.probeCalls >= 1, "a identidade do PID tem de ser lida antes de matar");
  });

  it("um PID que o Windows nao devolve (ninguem o ocupa) nao leva taskkill", async () => {
    const { hooks, state } = makeHooks({ row: null });
    hooks.__state = state;
    await killAndSettle(hooks);
    assert.equal(state.terminationSessions, 0, "o PID nao esta em uso: matar nao tinha quem matar");
  });

  it("identidade confirmada: o caminho NORMAL continua a matar a nossa arvore", async () => {
    // Este teste afirmava `taskkill /PID 4242 /T /F`. Esse caminho nao existe:
    // `taskkill` por PID foi REMOVIDO e a terminacao passou a correr numa sessao
    // de HANDLE, que valida e termina na mesma instancia. O que se afirma agora e
    // o que a correccao tem de garantir: a sessao corre, corre UMA vez, e a raiz
    // morre de facto.
    const { hooks, state, child } = makeHooks({ identityConfirmed: true });
    hooks.__state = state;
    await killAndSettle(hooks, { waitFor: (s) => s.terminationSessions >= 1 });

    assert.equal(state.terminationSessions, 1, `a sessao de handle tem de correr uma vez: ${state.terminationSessions}`);
    assert.match(
      state.scripts[0].cmd,
      /powershell/i,
      "a terminacao e uma sessao de handle, nao um taskkill por numero",
    );
    assert.match(state.scripts[0].script, /Get-Process -Id 4242/, "sobre o PID que lancamos");
    assert.match(
      state.scripts[0].script,
      /\$root\.Handle/,
      "e tem de abrir o handle: sem ele o PID pode ser reciclado entre a leitura e o kill",
    );
    assert.ok(child.state.died, "o nosso filho tem de morrer: o patch nao pode poupar-nos a limpeza");
    assert.ok(child.state.killCalls >= 1, "e o child.kill() do Node confirma a morte da raiz");
  });

  it("sonda indisponivel (sem CIM e sem tasklist): NAO mata, porque UNKNOWN nao e sucesso", async () => {
    // DECISAO DO UTILIZADOR (2026-10-03): sem identidade confirmada, o
    // CyberSafe nao mata. Um processo externo do utilizador e pior do que um
    // processo pesado sem confirmacao — o clamscan orfao e tratado como
    // `poisoned` e o scan seguinte responde `unavailable`, que e honesto.
    // Matar as cegas nao e.
    const { hooks, state } = makeHooks({ row: null, probeFailed: true });
    hooks.__state = state;
    await killAndSettle(hooks, { waitFor: (s) => s.probeCalls >= 3 });

    assert.equal(
      state.terminationSessions,
      0,
      "UNKNOWN nao autoriza kill: a leitura falhou e nao ha prova de que o PID seja nosso",
    );
    assert.ok(
      state.probeCalls > 1,
      `a leitura tem de ser REPETIDA antes de desistir (tentativas=${state.probeCalls})`,
    );
  });

  it("processo JA observado como morto: nao ha arvore para matar", async () => {
    const { hooks, state, child } = makeHooks({ exited: true, row: strangerRow(4242) });
    hooks.__state = state;
    await killAndSettle(hooks);
    assert.equal(
      state.terminationSessions,
      0,
      "o Node ja viu este processo sair: o `close` so esta atrasado, e um /T sobre um " +
        "PID livre e o que atinge o processo seguinte",
    );
    // A CAPTURA do spawn ainda corre (e uma leitura independente do SO), mas a
    // RESOLUCAO nao pergunta a ninguem: o processo ja nao existe.
    assert.equal(state.captureCalls, 1, "a captura do spawn corre uma vez");
    assert.equal(state.probeCalls, 0, "um PID que ja nao esta em uso nao se pergunta a ninguem");
    assert.equal(child.state.killCalls, 0, "e nada e morto as cegas");
  });

  it("a raiz so morre quando a identidade e NOSSA", async () => {
    // Com a decisao nova, matar o handle pelo PID seria matar as cegas. O
    // caminho `ours` continua a matar — e a limpeza que o produto precisa — mas
    // so depois de a identidade CAPTURADA bater com a identidade OBSERVADA.
    const nosso = makeHooks({ identityConfirmed: true });
    nosso.hooks.__state = nosso.state;
    await killAndSettle(nosso.hooks, { waitFor: (s) => s.terminationSessions >= 1 });
    assert.ok(nosso.child.state.died, "o nosso filho tem de morrer");

    const alheio = makeHooks({ row: strangerRow(4242) });
    alheio.hooks.__state = alheio.state;
    await killAndSettle(alheio.hooks);
    assert.ok(
      !alheio.child.state.died,
      "um handle cujo PID foi ocupado por outrem nao pode ser morto por PID",
    );
    assert.equal(alheio.state.terminationSessions, 0);
  });
});

describe("classifyProcessIdentity - a regra e pura, testavel sem processo nenhum", () => {
  const expected = esperadoComCaptura();
  const classify = (row, extra = {}) =>
    classifyProcessIdentity({ pid: 4242, row, expected, selfPid: process.pid, ...extra });

  it("o nosso proprio filho, com a identidade CAPTURADA, e 'ours'", () => {
    const out = classify(oursRow(4242, expected.capturedCreated));
    assert.equal(out.verdict, "ours", out.reason);
  });

  it("T14a - sem a identidade capturada, o MESMO filho e 'unavailable', nunca 'ours'", () => {
    // O teste antigo afirmava `ours` com a criacao, o caminho e o comando em
    // falta, e com a identidade capturada ausente: cristalizava a violacao que
    // o Codex marcou (achado 1). `ours` exige prova positiva da instancia
    // original; nome, caminho e comando sao candidatos a validar, nunca
    // autorizacao.
    const semCaptura = expectedIdentityFor("clamscan", SCAN_ARGS, Date.now() - 3_000);
    assert.equal(semCaptura.capturedCreated, undefined, "expectedIdentityFor nao inventa identidade");
    const out = classifyProcessIdentity({
      pid: 4242,
      row: oursRow(4242),
      expected: semCaptura,
      selfPid: process.pid,
    });
    assert.equal(
      out.verdict,
      "unavailable",
      `nome, caminho, comando e PPID iguais aos do scan nao bastam: ${out.reason}`,
    );
  });

  it("T14b - so com PID e nome (o que o `tasklist` da), e 'unavailable' tambem", () => {
    // O fallback do `tasklist` produz exactamente esta linha:
    // `{ ppid: 0, created: "", cmd: null, exe: null }`. Antes passava todos os
    // testes de contradicao e caia em `ours` — e `ours` autorizava o
    // `taskkill /T /F` sobre a arvore de um processo do utilizador.
    const fallback = { pid: 4242, ppid: 0, name: "clamscan.exe", exe: null, created: "", cmd: null };
    const out = classify(fallback);
    assert.equal(out.verdict, "unavailable", `o fallback do tasklist nunca prova instancia: ${out.reason}`);
  });

  it("T14c - e com a identidade capturada, a linha reduzida do tasklist continua a nao bastar", () => {
    // Mesmo com captura, `created: ""` nao e comparável: `unavailable`, nao
    // `ours`. Um nome igual ao nosso nao sobrevive a um campo de identidade
    // ilegivel.
    const fallback = { pid: 4242, ppid: 0, name: "clamscan.exe", exe: null, created: "", cmd: null };
    const out = classifyProcessIdentity({
      pid: 4242,
      row: fallback,
      expected,
      selfPid: process.pid,
    });
    assert.equal(out.verdict, "unavailable", out.reason);
  });

  it("uma linha sem row e 'free', nao 'ours'", () => {
    assert.equal(classify(null).verdict, "free");
  });

  it("sonda que nao leu nada e 'unavailable', nao 'ours'", () => {
    assert.equal(classify(null, { probeFailed: true }).verdict, "unavailable");
  });

  it("um PID ocupado por outro programa e 'foreign'", () => {
    const out = classify(strangerRow());
    assert.equal(out.verdict, "foreign", out.reason);
  });

  it("criado ANTES de termos lancado o processo = outro processo", () => {
    const row = { ...oursRow(), created: new Date(expected.spawnedAtMs - 60_000).toISOString() };
    const out = classify(row);
    assert.equal(out.verdict, "foreign", out.reason);
  });

  it("criado no FUTURO e leitura nao confiavel: nunca 'ours'", () => {
    const row = { ...oursRow(), created: new Date(Date.now() + 60_000).toISOString() };
    const out = classify(row);
    assert.equal(out.verdict, "foreign", out.reason);
  });

  it("outro executavel no mesmo PID = outro processo", () => {
    const out = classify({ ...oursRow(), name: "notepad.exe", exe: "C:\\Windows\\notepad.exe" });
    assert.equal(out.verdict, "foreign", out.reason);
  });

  it("criado por outro processo = outro processo", () => {
    const out = classify({ ...oursRow(), ppid: process.pid + 1 });
    assert.equal(out.verdict, "foreign", out.reason);
  });

  it("outro clamscan, mesmo nome, OUTRA linha de comando = outro scan, nao o nosso", () => {
    const out = classify({ ...oursRow(), cmd: '"clamscan.exe" --database=C:\\defs C:\\scan\\outro.exe' });
    assert.equal(out.verdict, "foreign", out.reason);
  });

  it("campo ilegivel nao vira prova de culpa (meia verdade)", () => {
    // Metade 1: `exe`/`cmd` ilegiveis sao FALTA DE INFORMACAO. Nao acusam
    // (`foreign`) e, com a criacao a bater com a captura, nao sao a unica prova:
    // o veredicto e `ours`. O teste antigo afirmava `ours` com `created: ""`
    // TAMBEM em falta, e essa era a parte errada — sem identidade de criacao nao
    // ha nada a comparar.
    const comCmd = classify({ ...oursRow(4242, expected.capturedCreated), exe: null, cmd: null });
    assert.equal(comCmd.verdict, "ours", `um campo ilegivel nao acusa: ${comCmd.reason}`);

    // Metade 2: sem `created` legivel nao ha identidade para comparar. E nao e
    // `foreign` (nao ha contradicao provada), e `unavailable` — que nao mata.
    const semCriacao = classify({ ...oursRow(4242, expected.capturedCreated), created: "" });
    assert.equal(
      semCriacao.verdict,
      "unavailable",
      `sem CreationDate nao ha identidade, e identidade e a unica autorizacao: ${semCriacao.reason}`,
    );
  });

  it("a linha devolvida tem de ser sobre o PID que pedimos", () => {
    const out = classify({ ...oursRow(), pid: 999 });
    assert.equal(out.verdict, "foreign", out.reason);
  });

  it("sem nome de executavel nao ha o que confirmar", () => {
    const out = classify({ ...oursRow(), name: "" });
    assert.equal(out.verdict, "unavailable", out.reason);
  });

  it("uma CreationDate ILEGIVEL e 'unavailable': nao ha identidade para comparar", () => {
    const out = classify({ ...oursRow(), created: "" });
    assert.equal(out.verdict, "unavailable", out.reason);
  });

  it("o MESMO PID com outra criacao e 'foreign': o numero foi reciclado", () => {
    const row = oursRow(4242, new Date(Date.parse(expected.capturedCreated) + 30_000).toISOString());
    const out = classify(row);
    assert.equal(out.verdict, "foreign", out.reason);
  });
});

describe("expectedIdentityFor — a identidade observada no momento do spawn", () => {
  it("o executavel e o primeiro caminho (o que o clamscan recebe a serio)", () => {
    const expected = expectedIdentityFor("clamscan", ["--database=C:\\defs", "C:\\scan\\a.exe", "C:\\scan\\b.exe"], 1234);
    assert.equal(expected.exeStem, "clamscan");
    assert.equal(expected.cmdMarker, "C:\\scan\\a.exe");
    assert.equal(expected.spawnedAtMs, 1234);
  });

  it("sem caminho nenhum nao inventa marcador", () => {
    assert.equal(expectedIdentityFor("clamscan", ["--version"], 1234).cmdMarker, undefined);
  });

  it("o nome do executavel e comparado sem extensao", () => {
    assert.equal(expectedIdentityFor("C:\\ClamAV\\clamdscan.exe", [], 1).exeStem, "clamdscan");
  });
});

describe("parseTasklistImageName — o fallback sem PowerShell", () => {
  const csv = [
    '"clamscan.exe","4242","Console","1","98 000 K"',
    '"notepad.exe","7777","Console","1","25 000 K"',
  ].join("\r\n");

  it("devolve o nome do PID pedido", () => {
    assert.equal(parseTasklistImageName(csv, 7777), "notepad.exe");
  });

  it("um PID que nao esta na lista nao devolve nome (pid livre)", () => {
    assert.equal(parseTasklistImageName(csv, 999999), null);
  });

  it("sobe a uma linha isolada sem cabecalho", () => {
    assert.equal(parseTasklistImageName('"clamscan.exe","4242","Console","1","98 000 K"', 4242), "clamscan.exe");
  });
});

describe("integracao — a bridge com um PID ocupado por outrem", () => {
  it("o PID alheio fica vivo, a vaga NAO volta, e o scan seguinte e recusado", async () => {
    // DECISÃO DO UTILIZADOR (2026-10-03): não matar um PID cuja identidade não
    // se confirmou implica que esse processo pode continuar a segurar ~1 GB.
    // A consequência honesta é o motor ficar `poisoned` e o scan seguinte ser
    // recusado — em vez de lançarmos um segundo clamscan por cima do primeiro.
    // Este é o teste que impede a reintrodução do P0 original.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cs-pidid-"));
    const definitionsDir = path.join(root, "definitions");
    await fs.mkdir(path.join(definitionsDir, "clamav"), { recursive: true });
    await fs.writeFile(path.join(definitionsDir, "clamav", "main.cvd"), "x");
    await fs.writeFile(path.join(definitionsDir, "clamav", "daily.cld"), "x");

    const state = { terminationSessions: 0, spawnCount: 0, children: [] };
    const spawnFn = () => {
      const child = makeFakeChild({ pid: 50000 + state.spawnCount });
      // um clamscan a serio nao responde instantaneamente
      setTimeout(() => child.die(0), 5000);
      state.children.push(child);
      state.spawnCount++;
      return child;
    };
    const spawnSync = () => {
      state.terminationSessions++;
      return { status: 0 };
    };
    const probeIdentity = (pid) => ({ row: strangerRow(pid), probeFailed: false, detail: "simulado" });
    const clamavSpawn = createSpawnClamav({
      spawn: spawnFn,
      spawnSync,
      probeIdentity,
      captureIdentity: async () => ({ row: null, probeFailed: true, detail: "CIM indisponivel" }),
    });
    const bridge = new ClamavBridge({
      definitionsDir,
      // A prova de carga passa pelo MESMO seam. Este caso afirma "um clamscan
      // cuja morte não foi confirmada não pode dar lugar a um segundo" e conta
      // spawns/filhos: a prova tem de responder fora desta simulação (sem
      // filho, sem sessão de terminação) ou o `spawnCount === 1` mediria a
      // prova, não o scan.
      spawn: (file, args, request) =>
        isLoadProof(request) ? makeLoadProofHandle() : clamavSpawn(file, args, request),
      scanTimeoutMs: 120,
    });

    try {
      const first = await bridge.scanFile(path.join(root, "a.txt"));
      assert.equal(
        state.terminationSessions,
        0,
        `o timeout do scan deu terminacao contra um PID que nao era nosso: ${state.terminationSessions}`,
      );
      assert.notEqual(first.verdict, "clean", "um scan morto por timeout nao pode declarar limpo");

      const second = await bridge.scanFile(path.join(root, "b.txt"));
      assert.equal(
        state.spawnCount,
        1,
        `um clamscan cujo PID não foi confirmada como nosso NÃO pode dar lugar a um segundo: ` +
          `${JSON.stringify(second.status)}`,
      );
      assert.equal(second.status.status, "unavailable", "e o segundo scan tem de dizer unavailable");
      assert.match(
        String(second.status.detail ?? ""),
        /não confirmou a morte/i,
        "a mensagem tem de explicar que há um processo possivelmente vivo — é o que impede de 'disposed'",
      );
      assert.notEqual(second.verdict, "clean", "e nunca 'limpo'");
    } finally {
      for (const c of state.children) c.die(0);
      await bridge.dispose().catch(() => {});
      await sleep(20);
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe(
  "probe CIM real — le a identidade de um processo que o teste proprio lanca",
  { skip: process.platform !== "win32" ? "so Windows" : false },
  () => {
    it("reconhece o proprio filho, recusa uma criacao diferente, e um PID livre", async () => {
      const probe = createWindowsIdentityProbe();
      const spawnedAtMs = Date.now();
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });

      try {
        const reading = probe(child.pid);
        assert.equal(reading.probeFailed, false, `sonda falhou: ${reading.detail}`);
        assert.ok(reading.row, `sem linha para o PID ${child.pid}: ${reading.detail}`);
        assert.equal(reading.row.pid, child.pid);
        assert.equal(reading.row.ppid, process.pid, "o filho foi criado por nos");
        assert.equal(reading.row.name.toLowerCase(), path.basename(process.execPath).toLowerCase());
        assert.ok(
          Date.parse(reading.row.created) >= spawnedAtMs - 5_000,
          `CreationDate ${reading.row.created} anterior ao spawn`,
        );

        // A2 contra o SO REAL: a identidade capturada e a MESMA leitura, e a
        // classificacao tem de dar `ours` com ela. Este teste afirmava `ours`
        // SEM captura, o que era o defeito e nao a prova.
        const expected = expectedIdentityFor(
          process.execPath,
          ["-e", "setTimeout(() => {}, 1500)"],
          spawnedAtMs,
        );
        assert.equal(expected.capturedCreated, undefined, "o seam nao inventa identidade");
        const semCaptura = classifyProcessIdentity({
          pid: child.pid,
          row: reading.row,
          expected,
          selfPid: process.pid,
        });
        assert.equal(
          semCaptura.verdict,
          "unavailable",
          `sem a identidade capturada, mesmo com o filho REAL a serio, nao ha prova: ${semCaptura.reason}`,
        );

        expected.capturedCreated = reading.row.created;
        const comCaptura = classifyProcessIdentity({
          pid: child.pid,
          row: reading.row,
          expected,
          selfPid: process.pid,
        });
        assert.equal(comCaptura.verdict, "ours", comCaptura.reason);

        // E o outro lado, com o mesmo processo e o mesmo nome: outra criacao
        // significa outro ocupante do numero.
        const outraCriacao = new Date(Date.parse(reading.row.created) + 1_000).toISOString();
        const reciclado = classifyProcessIdentity({
          pid: child.pid,
          row: { ...reading.row, created: outraCriacao },
          expected,
          selfPid: process.pid,
        });
        assert.equal(
          reciclado.verdict,
          "foreign",
          `o MESMO PID, o MESMO nome e outra criacao: ${reciclado.reason}`,
        );

        // A leitura nao e estavel por truque de texto: `Date.parse` das duas
        // formas de escrever o mesmo instante tem de dar o mesmo milissegundo, ou
        // a sessao de handle rejeitaria a nossa propria instancia.
        assert.equal(
          Date.parse(reading.row.created),
          Date.parse(new Date(Date.parse(reading.row.created)).toISOString()),
          "a identidade do CIM e comparável em milissegundos, nao como texto",
        );
      } finally {
        await new Promise((resolve) => child.on("close", resolve));
      }

      const livre = probe(999999);
      assert.equal(livre.row, null, `um PID inexistente nao devolve linha: ${JSON.stringify(livre)}`);
      assert.equal(livre.probeFailed, false);
    });
  },
);