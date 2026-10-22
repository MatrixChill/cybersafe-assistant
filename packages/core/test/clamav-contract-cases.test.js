import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClamavBridge, createSpawnClamav, classifyProcessIdentity, expectedIdentityFor } from "../dist/index.js";

/**
 * OS 9 CASOS DO CONTRATO DO UTILIZADOR (2026-10-03) - casos 7, 8 e 9.
 *
 * DECISAO DO UTILIZADOR: se a identidade do processo nao PODE SER CONFIRMADA, o
 * CyberSafe nao mata esse PID. PID sozinho nunca chega; nome nunca; caminho
 * nunca; janela temporal nunca. E o preco de nao matar tem de ser HONESTO: o
 * motor fica `poisoned`, o scan seguinte e recusado com `unavailable`, e nada se
 * anuncia como `disposed`.
 *
 * Os casos 1 a 6 sao do servico (ownership de PIDs proprios e imunidade) e estao
 * em `packages/service/test/own-child-contract-cases.test.js`. Nao estao aqui
 * porque core e service nao se importam — um ficheiro so, com objectos dos dois
 * lados, seria um ficheiro que nunca corre.
 *
 * ── Nenhum clamscan e LANCADO ────────────────────────────────────────────────
 * O filho e simulado e o `spawnSync` injectado LANCA em qualquer comando, com uma
 * excecao: o `buildInstanceTerminationScript` e o `spawnSync` que executa a
 * sessao de handle, que e Production e que este ficheiro tem de medir de facto
 * (ver caso 7b). Esse `powershell` injectado NAO toca no SO: devolve uma
 * resposta sintetica.
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

/** A linha que o CIM devolveria para o NOSSO clamscan. */
function oursRow(pid, created) {
  return {
    pid,
    ppid: process.pid,
    name: "clamscan.exe",
    exe: "C:\\Program Files\\ClamAV\\clamscan.exe",
    created,
    cmd: SCAN_ARGS.join(" "),
  };
}

/**
 * `spawnSync` que responde como a sessao de handle de PRODUCAO responderia,
 * sem tocar no SO.
 *
 * O script e o que `buildInstanceTerminationScript` gera: `Get-Process`, `$p.Handle`,
 * `StartTime`, `Kill()`. E o que este ficheiro tem de medIR, porque o caminho
 * `ours` nao chama `taskkill` — chama uma sessao de handle, e a garantia de que
 * essa sessao foi construida para validar e terminar na MESMA instancia esta no
 * script, nao no chamador.
 */
function makeTerminationSync({ created, descendants = 0, refused = 0, root = true }) {
  const state = { sessions: 0, scripts: [] };
  const sync = (cmd, args, opts) => {
    state.sessions++;
    const script = String(args?.[args.length - 1] ?? "");
    state.scripts.push(script);
    if (!/powershell/i.test(String(cmd))) {
      throw new Error(`so a sessao de handle e esperada neste harness: ${cmd}`);
    }
    if (!/Get-Process -Id/.test(script)) {
      throw new Error("o script de terminacao tem de operar sobre um handle, nao sobre um numero");
    }
    if (new RegExp(`\\$rootMs -ne ${Date.parse(created)}`).test(script) === false) {
      throw new Error("o script tem de comparar a identidade de criacao em milissegundos");
    }
    return {
      status: 0,
      stdout: JSON.stringify({ v: "killed", root, descendants, refused }),
    };
  };
  return { sync, state };
}

async function makeDefinitions() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cs-contract-core-"));
  const dir = path.join(root, "definitions", "clamav");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "main.cvd"), "x");
  await fs.writeFile(path.join(dir, "daily.cld"), "x");
  return { root, definitionsDir: path.join(root, "definitions") };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("CONTRATO 7 - UNKNOWN nunca mata", () => {
  it("7a - o veredicto puro: sem identidade capturada, `ours` e INALCANCAVEL", () => {
    // Nao ha via de chegar a `ours` sem `capturedCreated`: e a identidade real
    // do filho original, lida do SO no spawn. Tudo o resto — nome, caminho,
    // comando, PPID — e contradicao, nunca autorizacao.
    const expected = expectedIdentityFor("clamscan", SCAN_ARGS, Date.now() - 5_000);
    const row = oursRow(4242, new Date(Date.now() - 50).toISOString());
    assert.equal(expected.capturedCreated, undefined, "expectedIdentityFor nao inventa identidade");
    assert.equal(
      classifyProcessIdentity({ pid: 4242, row, expected, selfPid: process.pid }).verdict,
      "unavailable",
      "nome, caminho, comando e PPID iguais aos do scan NAO bastam",
    );
  });

  it("7b - com identidade CAPTURADA e confirmada: a terminacao corre sobre o handle", async () => {
    // O outro lado: UNKNOWN nao mata, `ours` mata — e mata pela MESMA referencia
    // que foi validada. O `spawnSync` injectado RECUSA um script que nao abra um
    // handle e RECUSA um script que compare a identidade como texto; logo, se a
    // sessao corre, a construcao esta correcta e nao e uma coincidence de
    // nomes.
    // `-3000`, e nao `-5000`: a tolerancia do relogio e de 5 s e rejeita (nao
    // aceita) uma criacao mais antiga do que o spawn menos essa margem, portanto
    // um filho de "exatamente 5 s atras" e lido como anterior ao spawn. Isto e
    // diagnostico a rejeitar, que e o que a margem foi escrita para fazer.
    const criacao = new Date(Date.now() - 3_000).toISOString();
    const capturado = { row: oursRow(4242, criacao), probeFailed: false, detail: "captura" };
    const lido = { row: oursRow(4242, criacao), probeFailed: false, detail: "leitura" };
    const { sync, state } = makeTerminationSync({ created: criacao, descendants: 2 });
    const child = makeFakeChild(4242);
    const spawn = createSpawnClamav({
      spawn: () => child,
      spawnSync: sync,
      captureIdentity: async () => capturado,
      probeIdentity: () => lido,
    });
    const handle = spawn("clamscan", SCAN_ARGS, { timeoutMs: 100, windowsHide: true });
    handle.killTree();
    await handle.outcome;

    assert.equal(state.sessions, 1, "a sessao de handle tem de correr uma vez");
    assert.equal(child.state.kills, 1, "e o child.kill() do Node confirma a morte da raiz");
    assert.equal(child.state.died, true);
    assert.equal(
      child.state.kills <= 1,
      true,
      "a raiz nao pode ser morta duas vezes por duas sondas diferentes",
    );
  });

  it("7c - UNKNOWN: o filho fica VIVO e nenhuma sessao de terminacao corre", async () => {
    const lido = { row: null, probeFailed: true, detail: "CIM indisponivel" };
    let sessions = 0;
    const child = makeFakeChild(4242);
    const spawn = createSpawnClamav({
      spawn: () => child,
      // Qualquer comando que nao seja esperado e' um erro: se a terminacao
      // corresse, este teste rebenta em vez de passar em silencio.
      spawnSync: () => {
        sessions++;
        throw new Error("7c: a terminacao NAO pode correr com identidade UNKNOWN");
      },
      captureIdentity: async () => ({ row: null, probeFailed: true, detail: "captura falhou" }),
      probeIdentity: () => lido,
    });
    const handle = spawn("clamscan", SCAN_ARGS, { timeoutMs: 100, windowsHide: true });
    handle.killTree();
    await handle.outcome;

    assert.equal(sessions, 0, "nenhuma sessao de terminacao pode correr");
    assert.equal(child.state.kills, 0, "nem o child.kill() do Node");
    assert.equal(child.state.died, false, "o processo fica vivo: e o preco honesto do contrato");
  });
});

describe("CONTRATO 8 - UNKNOWN durante o cleanup => poisoned / unavailable", () => {
  it("8a - o PRIMEIRO resultado diz unavailable (nunca `degraded` a afirmar terminacao)", async () => {
    const { root, definitionsDir } = await makeDefinitions();
    const children = [];
    let spawnCount = 0;
    const spawnFn = () => {
      const child = makeFakeChild(31000 + spawnCount);
      children.push(child);
      spawnCount++;
      return child;
    };
    const bridge = new ClamavBridge({
      definitionsDir,
      spawn: createSpawnClamav({
        spawn: spawnFn,
        spawnSync: () => ({ status: 0 }),
        captureIdentity: async () => ({ row: null, probeFailed: true, detail: "CIM indisponivel" }),
        probeIdentity: () => ({ row: null, probeFailed: true, detail: "CIM indisponivel" }),
      }),
      scanTimeoutMs: 80,
    });

    try {
      const alvo = path.join(root, "a.txt");
      await fs.writeFile(alvo, "benigno");
      // `scanFiles` e nao `scanFile`: A18 diz que o estado do motor e corrigido e
      // o RESULTADO POR FICHEIRO e preservado, e so o batch expoe os dois.
      const primeiro = await bridge.scanFiles([alvo]);

      assert.equal(
        primeiro.status.status,
        "unavailable",
        `morte nao confirmada nao pode dizer \`degraded\`: ${JSON.stringify(primeiro.status)}`,
      );
      assert.match(
        String(primeiro.status.detail ?? ""),
        /termina[cç][aã]o n[aã]o foi confirmada/i,
        `a mensagem tem de dizer o que aconteceu: ${String(primeiro.status.detail)}`,
      );
      assert.equal(primeiro.detected, false, "um scan que nao terminou nao pode ter detectado alguma coisa");
      assert.equal(primeiro.errorCount, 1, "o resultado de erro da analise e PRESERVADO");
      assert.equal(
        primeiro.files[0].verdict,
        "error",
        `so o estado do motor e corrigido: ${JSON.stringify(primeiro.files[0])}`,
      );
      assert.notEqual(primeiro.files[0].verdict, "clean", "e o ficheiro nunca e declarado limpo");
    } finally {
      for (const c of children) c.die(0);
      await bridge.dispose().catch(() => {});
      await sleep(30);
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("8b - e a vaga fica POISONED: o scan seguinte e recusado", async () => {
    const { root, definitionsDir } = await makeDefinitions();
    const children = [];
    let spawnCount = 0;
    const spawnFn = () => {
      const child = makeFakeChild(32000 + spawnCount);
      children.push(child);
      spawnCount++;
      return child;
    };
    const bridge = new ClamavBridge({
      definitionsDir,
      spawn: createSpawnClamav({
        spawn: spawnFn,
        spawnSync: () => ({ status: 0 }),
        captureIdentity: async () => ({ row: null, probeFailed: true, detail: "CIM indisponivel" }),
        probeIdentity: () => ({ row: null, probeFailed: true, detail: "CIM indisponivel" }),
      }),
      scanTimeoutMs: 80,
    });

    try {
      const a = path.join(root, "a.txt");
      await fs.writeFile(a, "benigno");
      await bridge.scanFile(a);

      const b = path.join(root, "b.txt");
      await fs.writeFile(b, "benigno");
      const segundo = await bridge.scanFile(b);
      assert.equal(
        spawnCount,
        1,
        `um clamscan possivelmente vivo nao pode dar lugar a um segundo: ${JSON.stringify(segundo.status)}`,
      );
      assert.equal(segundo.status.status, "unavailable");
      assert.match(
        String(segundo.status.detail ?? ""),
        /n[aã]o confirmou a morte/i,
        "a mensagem tem de explicar que ha um processo possivelmente vivo - e o que impede de dizer 'disposed'",
      );
    } finally {
      // A prova de morte do SO e o que liberta a vaga envenenada.
      for (const c of children) c.die(0);
      await bridge.dispose().catch(() => {});
      await sleep(30);
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("CONTRATO 9 - poisoned impede um segundo clamscan", () => {
  it("9a - nem o spawn de analise, nem o probe `clamscan --version` de uma bridge nova", async () => {
    // O caso 9 e literal: se ha um clamscan possivelmente nosso vivo, NAO NASCEM
    // clamscans novos. Isto inclui o probe de disponibilidade, que antes corria
    // ANTES do semaforo e lancava `clamscan --version` a serio.
    const { root, definitionsDir } = await makeDefinitions();
    const children = [];
    let spawnCount = 0;
    const spawnFn = () => {
      const child = makeFakeChild(33000 + spawnCount);
      children.push(child);
      spawnCount++;
      return child;
    };
    const envenenado = new ClamavBridge({
      definitionsDir,
      spawn: createSpawnClamav({
        spawn: spawnFn,
        spawnSync: () => ({ status: 0 }),
        captureIdentity: async () => ({ row: null, probeFailed: true, detail: "CIM indisponivel" }),
        probeIdentity: () => ({ row: null, probeFailed: true, detail: "CIM indisponivel" }),
      }),
      scanTimeoutMs: 80,
    });

    let spawnsDaBridgeNova = 0;
    const nova = new ClamavBridge({
      definitionsDir,
      spawn: createSpawnClamav({
        spawn: () => {
          spawnsDaBridgeNova++;
          return makeFakeChild(34000 + spawnsDaBridgeNova);
        },
        spawnSync: () => {
          throw new Error("9a: uma bridge nova nao pode sondar o binario com um semaforo envenenado");
        },
        captureIdentity: async () => ({ row: null, probeFailed: true, detail: "CIM indisponivel" }),
        probeIdentity: () => ({ row: null, probeFailed: true, detail: "CIM indisponivel" }),
      }),
      scanTimeoutMs: 80,
    });

    try {
      const a = path.join(root, "a.txt");
      await fs.writeFile(a, "benigno");
      await envenenado.scanFile(a);
      assert.equal(spawnCount, 1, "o primeiro scan correu a serio");

      const b = path.join(root, "b.txt");
      await fs.writeFile(b, "benigno");
      const recusado = await nova.scanFile(b);

      assert.equal(
        spawnsDaBridgeNova,
        0,
        `uma bridge NOVA nao pode arrancar clamscan com o semaforo envenenado: ${JSON.stringify(recusado.status)}`,
      );
      assert.equal(recusado.status.status, "unavailable");
      assert.notEqual(recusado.verdict, "clean", "e nunca 'limpo'");
    } finally {
      for (const c of children) c.die(0);
      await nova.dispose().catch(() => {});
      await envenenado.dispose().catch(() => {});
      await sleep(30);
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
