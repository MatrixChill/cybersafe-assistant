import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ClamavBridge,
  createSpawnClamav,
  classifyProcessIdentity,
  createWindowsIdentityProbe,
  expectedIdentityFor,
} from "../dist/index.js";

/**
 * CONTRATO DE PRODUTO DO P1-2, decidido pelo utilizador em 2026-10-03.
 *
 *   Se a identidade do processo NÃO PODE SER CONFIRMADA, o CyberSafe NÃO mata
 *   esse PID. Fail-safe aqui significa: melhor deixar um processo pesado sem
 *   confirmação do que matar um processo externo do utilizador.
 *
 *   PID sozinho: nunca suficiente.  Nome: nunca.  Path: nunca.  Janela
 *   temporal: nunca.
 *
 * E o preço de não matar tem de ser HONESTO: o motor fica `poisoned`, o scan
 * seguinte é recusado com `unavailable`, e nada se anuncia como `disposed`.
 *
 * Estes testes não lançam clamscan nenhum — o filho é simulado e o `taskkill`
 * é um registo, porque o caminho que interessa é precisamente o que NÃO se
 * pode fabricar com um binário a sério.
 */

const SCAN_ARGS = ["--database=definitions", "--no-summary", "-r", "C:\\scan"];

function makeFakeChild(pid, { died = false } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.state = { died, kills: 0 };
  child.kill = () => {
    child.state.kills++;
    if (!child.state.died) child.die(0);
    return true;
  };
  child.die = (code) => {
    if (child.state.died) return;
    child.state.died = true;
    child.emit("close", code);
  };
  return child;
}

function oursRow(pid) {
  return {
    pid,
    ppid: process.pid,
    name: "clamscan.exe",
    exe: "C:\\Program Files\\ClamAV\\clamscan.exe",
    cmd: SCAN_ARGS.join(" "),
    created: new Date(Date.now() - 50).toISOString(),
  };
}

function strangerRow(pid) {
  return {
    pid,
    ppid: 999999,
    name: "notepad.exe",
    exe: "C:\\Windows\\System32\\notepad.exe",
    cmd: "notepad.exe",
    created: new Date(Date.now() - 50).toISOString(),
  };
}

/**
 * T13 (Codex) - ESTE ERA O TESTE MAIS PERIGOSO DO PACOTE, E ESTAVA ERRADO.
 *
 * O `makeRig` original criava um filho simulado e NAO o injectava: passava
 * `{ spawnSync, probeIdentity }` a `createSpawnClamav`, que faz
 * `hooks.spawn ?? spawn`. Sem `hooks.spawn`, o `spawn` REAL e o do
 * `node:child_process` - portanto este teste LANCAVA `clamscan.exe` a serio, com
 * a base de assinaturas a carregar, e media sondas instantaneas num processo que
 * nao era o simulado. Passava, e nao provava nada.
 *
 * O que este harness ve agora:
 *  - `spawn` injectado, e `spawnCount` como prova de que nenhum processo real
 *    nasceu (se algum nascer, esta assercao falha);
 *  - `spawnSync` injectado que LANCA em qualquer comando: se o caminho de
 *    terminacao correr, o teste rebenta em vez de matar seja o que for. Uma
 *    excecao e mais forte que um contador - nao ha como ler "0 chamadas" e
 *    confundir com "chamou e eu nao vi";
 *  - `probeTimestamps` e `probeBudgets`, para tentativas, ESPACAMENTO e orcamento.
 */
function makeRig({ readings, busyMs = 0, pid = 4242, capture = null } = {}) {
  const state = {
    spawnCount: 0,
    probeCalls: 0,
    probeTimestamps: [],
    probeBudgets: [],
    captureCalls: 0,
    child: null,
  };
  let i = 0;
  const probeIdentity = (_pid, budgetMs) => {
    const reading = readings[Math.min(i, readings.length - 1)];
    i++;
    state.probeCalls++;
    state.probeTimestamps.push(Date.now());
    state.probeBudgets.push(budgetMs);
    if (busyMs > 0) {
      // Consome tempo REAL de proposito: um orcamento so se prova contra uma
      // sonda que demora, e este e o lugar onde o `spawnSync` do CIM gasta o
      // seu. Um `await sleep` mediria o event loop, nao a sonda.
      const end = Date.now() + busyMs;
      while (Date.now() < end) {
        /* ocupar a sonda */
      }
    }
    return reading;
  };
  const hooks = {
    spawn: () => {
      state.spawnCount++;
      state.child = makeFakeChild(pid);
      return state.child;
    },
    spawnSync: () => {
      throw new Error("T13: a terminacao NAO pode correr com a identidade UNKNOWN");
    },
    probeIdentity,
  };
  if (capture) {
    hooks.captureIdentity = async () => {
      state.captureCalls++;
      return capture;
    };
  }
  return { state, hooks };
}

/** Gaps entre tentativas de leitura, em ms. */
function gaps(timestamps) {
  return timestamps.slice(1).map((t, i) => t - timestamps[i]);
}

/**
 * Espera por uma contagem, em vez de por um tempo fixo.
 *
 * Um `sleep` seguido de uma medicao de duracao mede o sleep. Aqui o que se mede
 * e QUANDO A RESOLUCAO ACABOU, e isso so se sabe pela contagem de leituras.
 */
async function waitForCount(state, n, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (state.probeCalls < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function definitionsDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cs-p12-contract-"));
  const dir = path.join(root, "definitions", "clamav");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "main.cvd"), "x");
  await fs.writeFile(path.join(dir, "daily.cld"), "x");
  return { root, definitionsDir: path.join(root, "definitions") };
}

describe("P1-2 — contrato: sem identidade confirmada, nunca se mata", () => {
  it("T12a - campo ausente (nome vazio) conta como UNKNOWN, nao como 'ours'", async () => {
    const expected = expectedIdentityFor("clamscan", SCAN_ARGS, Date.now() - 50);
    // O `probeIdentity` real devolve `probeFailed` quando o CIM rebenta; mas a
    // classificacao tem de sobreviver tambem a uma linha ilegive.
    const semNome = oursRow(4242);
    semNome.name = "";
    const out = classifyProcessIdentity({ pid: 4242, row: semNome, expected, selfPid: process.pid });
    assert.equal(
      out.verdict,
      "unavailable",
      `sem nome nao ha o que confirmar: ${JSON.stringify(out)}`,
    );
  });

  it("T12b - uma sonda que LANCA de verdade e normalizada em UNKNOWN na fronteira real", async () => {
    // O teste antigo anunciava "probe que EXCEPTA" e nao lancava excecao
    // nenhuma: apagava o nome e chamava o classificador. Aqui a excepcao e REAL e
    // acontece na fronteira que a normaliza em producao: `spawnSync` a lanca
    // (e lanca tambem no `tasklist` de reserva), que e o que o PowerShell faz
    // quando nao ha shell utilizavel.
    const syncQueLanca = () => {
      throw new Error("PowerShell nao correu (simulado)");
    };
    const probe = createWindowsIdentityProbe(syncQueLanca);

    let lancou = false;
    try {
      const reading = probe(4242);
      lancou = true;
      assert.equal(
        reading.probeFailed,
        true,
        `a fronteira tem de converter a excecao em falha de leitura, nao em veredicto: ${JSON.stringify(reading)}`,
      );
      assert.equal(reading.row, null, "e nao pode inventar uma linha");
    } finally {
      assert.ok(lancou, "a sonda tem de ter CORRIDO: um try/catch que engole tudo tambem nao prova nada");
    }

    // E o veredicto que daí sai é UNKNOWN, que é o que impede o kill.
    const expected = expectedIdentityFor("clamscan", SCAN_ARGS, Date.now() - 50);
    const out = classifyProcessIdentity({
      pid: 4242,
      row: null,
      expected,
      selfPid: process.pid,
      probeFailed: true,
    });
    assert.equal(out.verdict, "unavailable", out.reason);
  });

  it("T12c - uma CAPTURA que lanca deixa a identidade por capturar, e por isso NAO mata", async () => {
    // A segunda fronteira: `captureReady` envolve a captura num try/catch e, se
    // ela rebentar, `capturedCreated` fica por preencher. E dai que o caminho
    // `ours` fica INACESSIVEL por desenho - que e o contrato, nao um acidente.
    const leitura = { row: null, probeFailed: true, detail: "CIM caiu" };
    const { state, hooks } = makeRig({ readings: [leitura] });
    hooks.captureIdentity = async () => {
      state.captureCalls++;
      throw new Error("captura rebentou (simulado)");
    };
    const spawn = createSpawnClamav(hooks);
    const handle = spawn("clamscan", SCAN_ARGS, { timeoutMs: 100, windowsHide: true });
    handle.killTree();
    await new Promise((r) => setTimeout(r, 700));

    assert.equal(state.captureCalls, 1, "a captura foi tentada");
    assert.equal(state.spawnCount, 1, "o filho é o simulado: nenhum processo real nasceu");
    assert.equal(
      state.child.state.kills,
      0,
      "sem identidade capturada nao se mata: nem a sessao de handle nem o child.kill() correm",
    );
    assert.equal(state.child.state.died, false, "e o filho continua vivo, que e o preco honesto do contrato");
  });

  it("PID livre (ninguem o ocupa) e 'free' - cleanup concluido, sem kill", async () => {
    const expected = expectedIdentityFor("clamscan", SCAN_ARGS, Date.now() - 50);
    const out = classifyProcessIdentity({ pid: 4242, row: null, expected, selfPid: process.pid });
    assert.equal(out.verdict, "free", JSON.stringify(out));
  });

  it("T13a - a leitura e REPETIDA, com ESPACAMENTO, e nunca toca na terminacao", async () => {
    const falha = { row: null, probeFailed: true, detail: "CIM caiu" };
    // A captura vem por um seam SEPARADO de propósito: `createSpawnClamav` sem
    // `captureIdentity` usa a própria sonda para capturar, e essa leitura
    // entrava na contagem e fazia o teste medir a captura em vez do retry.
    const { state, hooks } = makeRig({ readings: [falha], capture: falha });
    const spawn = createSpawnClamav(hooks);
    const handle = spawn("clamscan", SCAN_ARGS, { timeoutMs: 100, windowsHide: true });
    const t0 = Date.now();
    handle.killTree();
    await waitForCount(state, 3, 2_000);

    assert.equal(state.spawnCount, 1, `o spawn simulado tem de ser o unico processo: ${state.spawnCount}`);
    assert.equal(state.captureCalls, 1, "a captura do spawn e uma leitura a parte");
    assert.equal(state.probeCalls, 3, `1 leitura + 2 retries, nem desistir nem insistir: ${state.probeCalls}`);

    // O ESPAÇAMENTO. `void sleep(delay)` (o bug A8) produz gaps de ~0 ms; com
    // `await`, o primeiro atraso e de 120 ms e o segundo de 400 ms.
    const gapsMs = gaps(state.probeTimestamps);
    assert.ok(
      gapsMs[0] >= 100,
      `a primeira repeticao tem de esperar o atraso declarado (120 ms), esperou ${gapsMs[0]}ms - ` +
        "isto e `void sleep` sem esperar, o bug A8",
    );
    assert.ok(
      gapsMs[1] >= 350,
      `a segunda repeticao tem de esperar o atraso declarado (400 ms), esperou ${gapsMs[1]}ms`,
    );
    // A prova de que nada foi terminado e o `spawnSync` a LANCA: se a
    // terminacao tivesse corrido, este teste rebentava em vez de passar.
    assert.equal(state.child.state.kills, 0, "e nunca mata enquanto a identidade e UNKNOWN");
  });

  it("T13b - o ORCAMENTO da resolucao e explicito e cada tentativa fica com o que resta", async () => {
    // O orcamento exigido e `IDENTITY_RESOLUTION_BUDGET_MS` (2000 ms) para o
    // TOTAL das tentativas. Antes era o nome de uma constante e nada mais: 3
    // tentativas x (CIM 2,5 s + tasklist 2,5 s) ≈ 15 s sincronos, contra um
    // grace de 2 s. Aqui a sonda CONSOME 800 ms de cada vez, que e o que a faz
    // parar a meio do orcamento em vez de repetir ate ao fim.
    const falha = { row: null, probeFailed: true, detail: "CIM caiu" };
    const { state, hooks } = makeRig({ readings: [falha], busyMs: 800, capture: falha });
    const spawn = createSpawnClamav(hooks);
    const handle = spawn("clamscan", SCAN_ARGS, { timeoutMs: 100, windowsHide: true });
    const t0 = Date.now();
    handle.killTree();
    await waitForCount(state, 2, 3_000);
    // A duracao medida e a da RESOLUCAO (ate a ultima leitura), nao a da espera.
    const resolucaoMs = state.probeTimestamps[state.probeTimestamps.length - 1] - t0;

    assert.equal(
      state.probeCalls,
      2,
      `com 800 ms por leitura o orcamento de 2000 ms tem de acabar em 2 tentativas, ` +
        `nao em 3: ${state.probeCalls} leituras em ${resolucaoMs}ms`,
    );
    assert.ok(
      resolucaoMs < 2_000,
      `a resolucao de identidade nao pode passar do seu orcamento: ${resolucaoMs}ms`,
    );
    // Cada tentativa recebe o QUE SOBRA, e sobra cada vez menos: e isto que
    // impede a soma de ultrapassar o orcamento prometido.
    assert.ok(
      state.probeBudgets[1] < state.probeBudgets[0],
      `a segunda tentativa tem de receber o restante (${state.probeBudgets[0]} -> ${state.probeBudgets[1]})`,
    );
    assert.ok(state.probeBudgets[0] <= 2_000, `e nenhuma pode receber mais do que o orcamento: ${state.probeBudgets[0]}`);
    assert.equal(state.child.state.kills, 0, "orcamento esgotado e UNKNOWN: nunca se mata");
  });

  it("T13c - o orcamento e PARTILHADO pelas DUAS fontes da leitura (CIM e tasklist)", async () => {
    // A8 pedia o consumo do orcamento das DUAS fontes, nao de uma. A sonda de
    // producao mede o que resta a partir de AGORA e passa o mesmo restante ao
    // `tasklist` de reserva, para o fallback nao herdar um tecto novo. Um `sync`
    // que consome 60 ms e falha e a forma de ver isso: o timeout do `tasklist`
    // tem de ser MENOR do que o do PowerShell, e os dois somados nao podem
    // passar do orcamento recebido.
    const calls = [];
    const busy = (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        /* consumir, como o spawnSync real */
      }
    };
    const sync = (cmd, args, opts) => {
      calls.push({ cmd: String(cmd), timeout: Number(opts?.timeout) });
      busy(60);
      return { status: 1, stdout: "" }; // o CIM falha: cai para o tasklist
    };
    const probe = createWindowsIdentityProbe(sync);
    const reading = probe(4242, 2_000);

    assert.equal(reading.probeFailed, true, "as duas fontes falharam: e UNKNOWN, nao veredicto");
    assert.deepEqual(
      calls.map((c) => c.cmd),
      ["powershell", "tasklist"],
      "as DUAS fontes tem de ser tentadas, e a segunda com o que sobrou",
    );
    assert.ok(
      calls[1].timeout < calls[0].timeout,
      `o tasklist herdou um tecto novo: ${calls[0].timeout} -> ${calls[1].timeout}`,
    );
    assert.ok(
      calls[0].timeout <= 2_000 && calls[1].timeout <= 2_000,
      `nenhuma fonte pode passar o orcamento recebido: ${JSON.stringify(calls)}`,
    );
  });

  it("T13d - o tecto de uma leitura nao cresce com o pedido: nem com um orcamento enorme", async () => {
    // `probe(pid, budgetMs)` e limitado por `IDENTITY_PROBE_TIMEOUT_MS` (2,5 s).
    // Sem esse clamp, um pedido de orcamento grande transformava uma leitura
    // num PowerShell de 30 s, e o "bounded" do retry deixava de ser verdade.
    const calls = [];
    const sync = (cmd, _args, opts) => {
      calls.push({ cmd: String(cmd), timeout: Number(opts?.timeout) });
      return { status: 1, stdout: "" };
    };
    createWindowsIdentityProbe(sync)(4242, 60_000);

    assert.ok(
      calls[0].timeout <= 2_500,
      `a leitura nao pode herdar um tecto de 60 s: ${calls[0].timeout} ms`,
    );
  });

  it("UNKNOWN durante o scan deixa a bridge POISONED e recusa o scan seguinte", async () => {
    const { root, definitionsDir: defs } = await definitionsDir();
    let spawnCount = 0;
    const children = [];
    const spawnFn = () => {
      const child = makeFakeChild(31000 + spawnCount);
      children.push(child);
      spawnCount++;
      return child;
    };
    const spawnSync = () => ({ status: 0 });
    const probeIdentity = () => ({ row: null, probeFailed: true, detail: "CIM indisponível" });

    const bridge = new ClamavBridge({
      definitionsDir: defs,
      spawn: createSpawnClamav({ spawn: spawnFn, spawnSync, probeIdentity }),
      scanTimeoutMs: 80,
    });

    try {
      await fs.writeFile(path.join(root, "a.txt"), "benigno");
      await bridge.scanFile(path.join(root, "a.txt"));

      const second = await bridge.scanFile(path.join(root, "b.txt"));
      assert.equal(spawnCount, 1, `não pode arrancar um segundo clamscan: ${JSON.stringify(second.status)}`);
      assert.equal(second.status.status, "unavailable");
      assert.notEqual(second.verdict, "clean", "e nunca 'limpo'");
    } finally {
      for (const c of children) c.die(0);
      await bridge.dispose().catch(() => {});
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("depois de poisoned, o motor volta SÓ quando a morte é confirmada", async () => {
    const { root, definitionsDir: defs } = await definitionsDir();
    let spawnCount = 0;
    const children = [];
    const spawnFn = () => {
      const child = makeFakeChild(32000 + spawnCount);
      children.push(child);
      spawnCount++;
      return child;
    };
    const spawnSync = () => ({ status: 0 });
    let probeFails = true;
    const probeIdentity = (pid) =>
      probeFails
        ? { row: null, probeFailed: true, detail: "CIM indisponível" }
        : { row: oursRow(pid), probeFailed: false, detail: "ok" };

    const bridge = new ClamavBridge({
      definitionsDir: defs,
      spawn: createSpawnClamav({ spawn: spawnFn, spawnSync, probeIdentity }),
      scanTimeoutMs: 80,
    });

    try {
      await fs.writeFile(path.join(root, "a.txt"), "benigno");
      await bridge.scanFile(path.join(root, "a.txt"));
      await bridge.scanFile(path.join(root, "b.txt"));
      assert.equal(spawnCount, 1, "poisoned: nada de segundo clamscan");

      // O processo morre de facto e a leitura volta a responder.
      for (const c of children) c.die(0);
      probeFails = false;
      await new Promise((r) => setTimeout(r, 30));

      const third = await bridge.scanFile(path.join(root, "c.txt"));
      assert.equal(spawnCount, 2, `depois da morte confirmada o motor tem de voltar: ${JSON.stringify(third.status)}`);
    } finally {
      for (const c of children) c.die(0);
      await bridge.dispose().catch(() => {});
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("T11a - a MESMA identidade mantem o caminho owned (nao estragamos o caminho bom)", async () => {
    // Fixa a identidade de criacao REAL do filho que lancamos: e a captura do
    // spawn, lida do SO. Sem este campo, `ours` e inacessivel por desenho.
    const criacao = new Date(Date.now() - 500).toISOString();
    const expected = expectedIdentityFor("clamscan", SCAN_ARGS, Date.now() - 5_000);
    expected.capturedCreated = criacao;

    const row = oursRow(4242);
    row.created = criacao; // a MESMA instancia, lida outra vez mais tarde
    const out = classifyProcessIdentity({ pid: 4242, row, expected, selfPid: process.pid });
    assert.equal(out.verdict, "ours", out.reason);
  });

  it("T11b - o MESMO PID com OUTRA criacao e REJEITADO, mesmo com nome/caminho/comando iguais", async () => {
    // O teste antigo anunciava "um novo spawn NAO herda ownership" e esperava
    // `ours` NAS DUAS LEITURAS: nao estabelecia duas identidades distintas e
    // nao testava a rejeicao que anunciava. Aqui as duas identidades sao
    // REAIS e distintas, e tudo o resto - nome, executavel, PPID e linha de
    // comando - e IDENTICO, para que a unica coisa que possa separar as duas
    // linhas seja a CreationDate.
    const criacaoOriginal = new Date(Date.now() - 5_000).toISOString();
    const expected = expectedIdentityFor("clamscan", SCAN_ARGS, Date.now() - 50_000);
    expected.capturedCreated = criacaoOriginal;

    const original = oursRow(4242);
    original.created = criacaoOriginal;
    const reciclado = oursRow(4242);
    reciclado.created = new Date(Date.now() - 50).toISOString();

    // Mesmos nome, exe, ppid e cmd: so a criacao muda.
    assert.equal(reciclado.name, original.name);
    assert.equal(reciclado.exe, original.exe);
    assert.equal(reciclado.ppid, original.ppid);
    assert.equal(reciclado.cmd, original.cmd);

    assert.equal(
      classifyProcessIdentity({ pid: 4242, row: original, expected, selfPid: process.pid }).verdict,
      "ours",
      "a instancia original tem de continuar a ser reconhecida",
    );
    const out = classifyProcessIdentity({ pid: 4242, row: reciclado, expected, selfPid: process.pid });
    assert.equal(
      out.verdict,
      "foreign",
      `o PID foi reciclado: ${out.reason}`,
    );
  });

  it("T11c - e no caminho do kill: o PID reciclado NAO e terminado", async () => {
    // O veredicto puro acima e a lei; aqui vai a MESMA lei atraves do
    // `killTree`, porque e ai que o erro custava caro. A captura devolve a
    // identidade da instancia original; a leitura de decisao devolve a de um
    // processo que ocupou o numero a seguir. O `spawnSync` LANCA: se a
    // terminacao correr, este teste rebenta.
    const criacaoOriginal = new Date(Date.now() - 5_000).toISOString();
    const capturado = { row: oursRow(4242), probeFailed: false, detail: "captura" };
    capturado.row.created = criacaoOriginal;

    const reciclado = oursRow(4242);
    reciclado.created = new Date(Date.now() - 40).toISOString();

    const { state, hooks } = makeRig({
      readings: [{ row: reciclado, probeFailed: false, detail: "leitura" }],
      capture: capturado,
    });
    const spawn = createSpawnClamav(hooks);
    const handle = spawn("clamscan", SCAN_ARGS, { timeoutMs: 100, windowsHide: true });
    handle.killTree();
    await new Promise((r) => setTimeout(r, 700));

    assert.equal(state.captureCalls, 1, "a identidade original foi capturada no spawn");
    assert.ok(state.probeCalls >= 1, "a identidade atual foi lida antes de decidir");
    assert.equal(
      state.child.state.kills,
      0,
      "o PID foi reciclado: nem a sessao de handle nem o child.kill() podem tocar nele",
    );
    assert.equal(state.child.state.died, false);
  });
});

/**
 * B3 — UMA SONDA QUE LANCA É UMA SONDA QUE FALHOU.
 *
 * MEDIDO antes da correccao: com `probeIdentity` a atirar, a promise de
 * `killProcessTree` rejeitava e a rejeicão saia como `unhandledRejection`. O
 * `killTree()` ja tinha armado o grace, mas o `deathUnconfirmed` nunca era
 * posto pela decisão: o `finally` da bridge libertava a vaga sem prova de
 * morte, que é o P0 original.
 *
 * O contrato é o mesmo de sempre — UNKNOWN nunca mata — mas desta vez para o
 * MODO DE FALHA da sonda, e nao só para a resposta dela.
 */
describe("B3 - uma sonda que LANCA é UNKNOWN, nunca um kill e nunca um crash", () => {
  it("a sonda que rebenta não mata e não produz rejeição não tratada", async () => {
    let unhandled = null;
    const onUnhandled = (err) => { unhandled = err; };
    process.on("unhandledRejection", onUnhandled);
    try {
      let child = null;
      const hooks = {
        spawn: () => {
          child = makeFakeChild(4242);
          return child;
        },
        // LANÇA de propósito: se a decisão correr, isto rebenta.
        spawnSync: () => { throw new Error("B3: a terminacao NAO pode correr"); },
        captureIdentity: async () => ({ row: null, probeFailed: true, detail: "sem captura" }),
        probeIdentity: () => { throw new Error("B3: a sonda explodiu"); },
      };

      const handle = createSpawnClamav(hooks)("clamscan", SCAN_ARGS, { timeoutMs: 60_000, windowsHide: true });
      handle.killTree();
      await new Promise((r) => setTimeout(r, 800));

      assert.equal(unhandled, null, `a sonda que rebenta não pode gerar rejeição não tratada: ${unhandled?.message}`);
      assert.equal(child.state.kills, 0, "sem identidade não se toca no processo, seja qual for o modo de falha da sonda");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a sonda que rebenta deixa a vaga POISONED (o honesto: morte não confirmada)", async () => {
    const hooks = {
      spawn: () => makeFakeChild(5150),
      spawnSync: () => { throw new Error("B3: a terminacao NAO pode correr"); },
      captureIdentity: async () => ({ row: null, probeFailed: true, detail: "sem captura" }),
      probeIdentity: () => { throw new Error("B3: a sonda explodiu"); },
    };
    const handle = createSpawnClamav(hooks)("clamscan", SCAN_ARGS, { timeoutMs: 60_000, windowsHide: true });
    handle.killTree();
    const outcome = await handle.outcome;
    assert.equal(
      outcome.deathUnconfirmed,
      true,
      "ninguém confirmou a morte, logo a vaga tem de ficar presa — é isto que impede um segundo clamscan",
    );
  });
});
