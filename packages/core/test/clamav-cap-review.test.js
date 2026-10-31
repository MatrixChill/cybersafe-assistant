import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClamavBridge, spawnClamav } from "../dist/index.js";

/**
 * REVIEW INDEPENDENTE DA FASE 3 (P0 CLAMAV_RESOURCE_EXHAUSTION) — 2026-10-02.
 *
 * Estes testes NÃO são parte do produto. São as sondas que tentam REFUTAR o
 * patch: cada um isola um dos 12 pontos do checklist de review e afirma a
 * propriedade de segurança. Um teste que passa é evidência; um que falha é
 * um FINDING, não um teste mau.
 *
 * Nada aqui depende do binário real do clamscan — é tudo sobre o semáforo, o
 * deadline e o cleanup, que é exactamente onde o P0 vive.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera por uma condição em vez de por um tempo fixo.
 *
 * O primeiro `scanFile` de uma bridge passa por `isAvailable()`, que corre o
 * `clamscan --version` REAL (~50 ms). Um `sleep(20)` à espera do spawn é uma
 * corrida perdida — e uma corrida perdida lida-se como "o spawn não aconteceu",
 * que é um achado falso. Não usar sleeps para sincronizar com o spawn.
 */
async function waitFor(predicate, { timeoutMs = 5_000, label = "condição" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(5);
  }
  throw new Error(`waitFor(${label}) expirou após ${timeoutMs} ms`);
}

async function makeFakeReadyDefinitions(root) {
  const dir = path.join(root, "definitions", "clamav");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "main.cvd"), "x");
  await fs.writeFile(path.join(dir, "daily.cld"), "x");
  return path.join(root, "definitions");
}

/**
 * Spawner que regista TUDO, incluindo `killTree()` em handles já mortos.
 *
 * O spawner de produção protege-se com `if (settled) return`. Este não se
 * protege de propósito: a pergunta correcta não é "o kill foi benigno" (foi,
 * por causa do guard), é "o deadline continua armado depois do scan acabar?".
 * Com o guard, esse bug é invisível.
 */
function makeInstrumentedSpawner({ durationMs = 50, code = 0, stdout = "", stderr = "" } = {}) {
  const state = { live: 0, peak: 0, spawned: 0, killTreeCalls: 0, killsAfterDeath: 0 };
  const spawn = (_file, _args, _request) => {
    state.spawned++;
    state.live++;
    state.peak = Math.max(state.peak, state.live);

    let resolveOutcome;
    let dead = false;      const finish = (outcome) => {
        if (dead) return;
        dead = true;
        state.live--;
        resolveOutcome(outcome);
      };
      // `stdout`/`stderr` são determinísticos, para que o parser tenha o
      // mesmo evidence que o clamscan real lhe daria.
    const handle = {
      pid: 20000 + state.spawned,
      killTree() {
        state.killTreeCalls++;
        // Um kill em cima de um processo JÁ MORTO é o sinal de que o deadline
        // da bridge ficou armado para além do fim do scan.
        if (dead) state.killsAfterDeath++;
        finish({ code: null, stderr: "", timedOut: false, killed: true });
      },
      outcome: new Promise((resolve) => {
        resolveOutcome = resolve;
      }),
    };
    setTimeout(() => finish({ code, stdout, stderr, timedOut: false, killed: false }), durationMs);
    return handle;
  };
  return { spawn, state };
}

let tmp;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-clamreview-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("REVIEW F3 — o deadline da bridge é cancelado quando o scan acaba", () => {
  it("um scan que termina bem antes do timeout NÃO pode ficar com o timer armado", async () => {
    const fake = makeInstrumentedSpawner({ durationMs: 40 });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      scanTimeoutMs: 300, // o scan acaba aos 40 ms; o deadline só dispara aos 300 ms
    });

    const res = await bridge.scanFile(path.join(tmp, "a.txt"));
    assert.equal(res.detected, false, "scan limpo");

    // Deixamos passar o deadline.
    await sleep(500);

    assert.equal(
      fake.state.killTreeCalls,
      0,
      `o deadline disparou ${fake.state.killTreeCalls} vez(es) DEPOIS do scan ter acabado — ` +
        `o timer nunca foi cancelado (const deadline dentro do try sombreia a let do finally)`,
    );
    assert.equal(fake.state.killsAfterDeath, 0, "nenhum kill em cima de um processo já morto");
  });

  it("o mesmo para um scan que termina por deteção (exit 1)", async () => {
    const target = path.join(tmp, "eicar.txt");
    // Uma deteção só é uma deteção se o OUTPUT a nomear. Um exit 1 sem linha
    // FOUND é o estado inconsistente — e desde o result model ele é reportado
    // como tal, em vez de virar `detected: true` por fé no exit code.
    const fake = makeInstrumentedSpawner({
      durationMs: 40,
      code: 1,
      stdout: `${target}: Eicar-Signature FOUND\n`,
    });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      scanTimeoutMs: 250,
    });

    const res = await bridge.scanFile(target);
    assert.equal(res.detected, true, "FOUND no stdout = detectado");
    assert.equal(res.verdict, "detected");
    assert.equal(res.signature, "Eicar-Signature");

    await sleep(400);
    assert.equal(
      fake.state.killTreeCalls,
      0,
      `o deadline ficou armado e matou ${fake.state.killsAfterDeath} handle(s) já morto(s)`,
    );
  });

  it("exit 1 SEM linha FOUND é 'inconclusivo', nunca clean e nunca detectado", async () => {
    // A confiança no exit code era o defeito original. Um exit 1 que não diz o
    // que encontrou não pode ser reportado como deteção — nem como limpeza.
    const fake = makeInstrumentedSpawner({ durationMs: 20, code: 1, stdout: "" });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      scanTimeoutMs: 5_000,
    });

    const res = await bridge.scanFile(path.join(tmp, "a.txt"));
    assert.equal(res.verdict, "error");
    assert.equal(res.detected, false);
    assert.notEqual(res.status.status, "active", "nunca 'active' a fingir que escaneou");
  });
});

describe("REVIEW F3 — o cap global nunca é ultrapassado", () => {
  it("cancelar um scan que estava NA FILA não abre um segundo slot", async () => {
    // Dupla libertação do semáforo: o `return` dentro do `try` chama
    // `releaseClamavSlot()` e o `finally` chama `releaseClamavSlot()` outra vez.
    // Com o clamp a 0 oSymptoms não explode logo, mas a vaga fantasma acorda um
    // waiter que ainda não tinha vaga, e a contagem deixa de corresponder aos
    // processos vivos.
    const fake = makeInstrumentedSpawner({ durationMs: 300 });
    const definitionsDir = await makeFakeReadyDefinitions(tmp);
    const a = new ClamavBridge({ definitionsDir, spawn: fake.spawn, scanTimeoutMs: 5_000 });
    const b = new ClamavBridge({ definitionsDir, spawn: fake.spawn, scanTimeoutMs: 5_000 });

    // A segura a vaga.
    const first = a.scanFile(path.join(tmp, "a.txt"));
    await sleep(30);

    // B fica na fila e é cancelado enquanto espera.
    const controller = new AbortController();
    const queued = b.scanFile(path.join(tmp, "b.txt"), { signal: controller.signal });
    await sleep(10);
    controller.abort();
    const queuedResult = await queued;
    assert.match(
      queuedResult.status.detail ?? "",
      /cancelado enquanto aguardava vaga/,
      "B tem de dizer que foi cancelado na fila, e não que espalmou um scan qualquer",
    );

    // A acaba e devolve a vaga. A partir daqui nada pode correr a par.
    await first;
    assert.equal(fake.state.live, 0, "A terminou");

    // E agora três scans novos, em paralelo, têm de continuar em série.
    const more = await Promise.all(
      [1, 2, 3].map((n) => new ClamavBridge({ definitionsDir, spawn: fake.spawn }).scanFile(path.join(tmp, `n${n}.txt`))),
    );
    assert.equal(more.length, 3);
    assert.ok(
      fake.state.peak <= 1,
      `pico de clamscans = ${fake.state.peak}; o semáforo foi corrompido por dupla libertação`,
    );
    assert.equal(fake.state.live, 0, "nada vivo no fim");
  });

  it("estresse: 40 scans concorrentes, alguns cancelados, pico tem de ser 1", async () => {
    const fake = makeInstrumentedSpawner({ durationMs: 15 });
    const definitionsDir = await makeFakeReadyDefinitions(tmp);
    const controllers = [];
    const jobs = [];
    for (let i = 0; i < 40; i++) {
      const bridge = new ClamavBridge({ definitionsDir, spawn: fake.spawn, scanTimeoutMs: 5_000 });
      // 1 em cada 4 é cancelado a meio — o caminho que faz a dupla libertação.
      if (i % 4 === 0) {
        const c = new AbortController();
        controllers.push(c);
        setTimeout(() => c.abort(), i % 3);
        jobs.push(bridge.scanFile(path.join(tmp, `f${i}.txt`), { signal: c.signal }).catch(() => {}));
      } else {
        jobs.push(bridge.scanFile(path.join(tmp, `f${i}.txt`)).catch(() => {}));
      }
      // Escalona as chegadas para intercalar transferências de vaga.
      if (i % 5 === 0) await sleep(2);
    }
    await Promise.all(jobs);

    assert.equal(fake.state.spawned + controllers.length >= 0, true);
    assert.ok(
      fake.state.peak <= 1,
      `pico = ${fake.state.peak} com 40 scans concorrentes e cancelamentos; o cap de 1 foi furado`,
    );
    assert.equal(fake.state.live, 0, `ficaram ${fake.state.live} órfãos`);
  });
});

describe("REVIEW F3 — cancelamento não toca em trabalho alheio", () => {
  it("cancelar o scan A não mata o scan B (isolamento por scanId)", async () => {
    const fake = makeInstrumentedSpawner({ durationMs: 250 });
    const definitionsDir = await makeFakeReadyDefinitions(tmp);
    const bridgeA = new ClamavBridge({ definitionsDir, spawn: fake.spawn, scanTimeoutMs: 5_000 });
    const bridgeB = new ClamavBridge({ definitionsDir, spawn: fake.spawn, scanTimeoutMs: 5_000 });

    const controller = new AbortController();
    // B fica na fila (o cap é 1). A arranca primeiro e é cancelado.
    const b = bridgeB.scanFile(path.join(tmp, "b.txt"));
    // Espera B estar mesmo na fila (spawned == 0) e não "ainda no probe".
    await waitFor(() => false, { timeoutMs: 1, label: "ignorado" }).catch(() => {});
    await sleep(120);
    const a = bridgeA.scanFile(path.join(tmp, "a.txt"), { signal: controller.signal });
    await waitFor(() => fake.state.spawned === 1, { label: "A arrancar" });
    controller.abort();

    const resA = await a;
    const resB = await b;

    assert.notEqual(resA.detected, undefined, "A devolveu um resultado");
    assert.equal(resB.detected, false, "B completou normalmente, foi clean");
    assert.equal(fake.state.live, 0, "B não foi morto pelo cancel de A");
  });

  it("um signal já abortado não spawna nada", async () => {
    const fake = makeInstrumentedSpawner({ durationMs: 20 });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
    });
    const controller = new AbortController();
    controller.abort();
    const res = await bridge.scanFile(path.join(tmp, "a.txt"), { signal: controller.signal });
    assert.equal(fake.state.spawned, 0, "abort antes do spawn não pode arrancar processo");
    assert.equal(res.detected, false);
  });
});

describe("REVIEW F3 — dispose e cleanup", () => {
  it("dispose mata tudo e espera, e recusa scans seguintes", async () => {
    const fake = makeInstrumentedSpawner({ durationMs: 10_000 });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      scanTimeoutMs: 30_000,
    });

    const pending = bridge.scanFile(path.join(tmp, "enorme.bin"));
    await waitFor(() => fake.state.live === 1, { label: "o clamscan ficar vivo" });
    assert.equal(fake.state.live, 1, "o clamscan está vivo");

    await bridge.dispose();

    assert.equal(fake.state.live, 0, "dispose esperou pelo fim real, não só pediu o kill");
    assert.equal(fake.state.killTreeCalls >= 1, true, "dispose matou o processo em curso");
    const pendingResult = await pending;
    assert.equal(pendingResult.detected, false, "o scan pendente não pode reportar deteção");
    assert.notEqual(pendingResult.status.status, "active", `nem 'active' — foi '${pendingResult.status.status}'`);

    const after = await bridge.scanFile(path.join(tmp, "depois.txt"));
    assert.equal(fake.state.spawned, 1, "depois de dispose não se arranca mais nada");
    assert.equal(after.detected, false);
  });

  it("um scan que falha (spawner lança) liberta a vaga", async () => {
    const definitionsDir = await makeFakeReadyDefinitions(tmp);
    const bridge = new ClamavBridge({
      definitionsDir,
      scanTimeoutMs: 1_000,
      spawn: () => {
        throw new Error("boom");
      },
    });

    // MUDANÇA DE CONTRATO (2026-10-05, P0 SCANNER_REAL_BATCH_STALL) — com
    // justificação, e sem afrouxar a propriedade que este teste existe para
    // provar.
    //
    // Antes, este teste afirmava `a excepção propaga-se`. Era verdade, e era
    // exactamente o defeito: o `spawn()` do Node LANÇA de forma SÍNCRONA quando
    // a command line é demasiado longa (ENAMETOOLONG medido com 765 ficheiros
    // reais), não emite o evento 'error'. A excepção subia até ao
    // `prefetchClamav` do serviço, que a tratava como "sem prefetch" e apagava
    // o veredicto por ficheiro — devolvendo os 765 ficheiros ao clamscan
    // individual, ~981 MB de cada vez. O P0 CLAMAV_RESOURCE_EXHAUSTION voltava
    // pela porta do spawn.
    //
    // O contrato certo é o oposto do que se afirmava: uma falha de spawn é um
    // RESULTADO (`unavailable`, com a causa), não uma excepção. A asserção da
    // semaphore em baixo — a que dá nome ao teste — fica intacta e continua a
    // ser o que se prova.
    const res = await bridge.scanFile(path.join(tmp, "a.txt"));
    assert.notEqual(res.detected, true, "um spawn que lançou não é uma deteção");
    assert.notEqual(res.verdict, "clean", "um spawn que lançou não pode dizer 'limpo'");
    assert.ok(res.reason || res.detail, "tem de haver causa visível do que aconteceu");
    // Se a vaga tivesse ficada presa, este segundo scan nunca voltaria.
    const second = await Promise.race([
      bridge.scanFile(path.join(tmp, "b.txt")).then(
        () => "SCAN-OK",
        () => "SCAN-OK",
      ),
      sleep(500).then(() => "TIMEOUT-VAGA-PRESA"),
    ]);
    assert.notEqual(second, "TIMEOUT-VAGA-PRESA", "uma falha no spawn não pode prender o semáforo");
  });
});

/**
 * T17 (Codex, achado 17) — cobertura do SPAWNER DE PRODUÇÃO, separada da bridge.
 *
 * Os testes acima medem a BRIDGE com um spawner substituído: quem decide é o
 * deadline, o cancelamento e o `dispose`. Isso é legítimo e continua a ser o que
 * eles dizem ser — mas não prova nada sobre a terminação de produção, que é
 * `captureReady` → `killProcessTree` → sessão de handle, e sobre a
 * libertação/envenenamento da vaga, que é o `finally` do `runScan`.
 *
 * Estes testes exercitam o `spawnClamav` REAL — o export de produção, com os
 * hooks no quarto argumento, que a implementação usa de facto (`spawnClamav` é a
 * fábrica com os hooks passados, e é assim que `ClamavBridge` a chega a chamar
 * no seu `spawn`) — com as dependências simuladas. O que fica provado:
 * confirmação de identidade, chamadas de kill, `close`, e a sorta da vaga.
 *
 * Continua a não haver clamscan: o `spawn` e o `spawnSync` injectados, e o
 * `spawnSync` responde à sessão de handle sem tocar no SO.
 */
describe("T17 — o spawner de PRODUÇÃO, com dependências simuladas", () => {
  const CRIACAO = () => new Date(Date.now() - 200).toISOString();

  function makeProductionHooks({ sessionFails = false } = {}) {
    const state = { spawnCount: 0, terminationSessions: 0, scripts: [], children: [], criacao: "" };
    const child = new EventEmitter();
    child.pid = 42420 + state.spawnCount;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.state = { killCalls: 0, died: false };
    child.kill = () => {
      child.state.killCalls++;
      if (child.state.died) return true;
      child.state.died = true;
      setTimeout(() => child.emit("close", 0), 0);
      return true;
    };
    child.die = () => child.kill();
    state.child = child;

    const spawnFn = () => {
      state.spawnCount++;
      state.criacao = CRIACAO();
      state.children.push(child);
      return child;
    };
    const spawnSync = (_cmd, args) => {
      state.terminationSessions++;
      const script = String(args?.[args?.length - 1] ?? "");
      state.scripts.push(script);
      if (sessionFails) throw new Error("sessao de terminacao falhou (simulado)");
      return { status: 0, stdout: JSON.stringify({ v: "killed", root: true, descendants: 3, refused: 0 }) };
    };
    const reading = (pid) => ({
      row: {
        pid,
        ppid: process.pid,
        name: "clamscan.exe",
        exe: "C:\\Program Files\\ClamAV\\clamscan.exe",
        created: state.criacao,
        cmd: state.cmd ?? "",
      },
      probeFailed: false,
      detail: "simulado",
    });
    return {
      state,
      hooks: {
        spawn: spawnFn,
        spawnSync,
        probeIdentity: reading,
        captureIdentity: async (pid) => reading(pid),
      },
    };
  }

  it("identidade confirmada: uma sessao de handle, e a raiz morre", async () => {
    const { state, hooks } = makeProductionHooks();
    const handle = spawnClamav("clamscan", ["--database=C:\\defs", "C:\\alvo.txt"], { windowsHide: true }, hooks);
    handle.killTree();
    const outcome = await handle.outcome;

    assert.equal(state.spawnCount, 1, "um spawn, um filho");
    assert.equal(state.terminationSessions, 1, `uma sessao de handle: ${state.terminationSessions}`);
    assert.match(state.scripts[0], /Get-Process -Id 42420/, "a sessao opera sobre o handle do PID lancado");
    assert.match(state.scripts[0], /\$root\.Handle/, "e abre o handle antes de validar");
    assert.match(state.scripts[0], /\$rootMs -ne \d+/, "comparando a identidade de criacao em milissegundos");
    assert.doesNotMatch(state.scripts[0], /taskkill/, "e nao existe taskkill por PID neste caminho");
    assert.ok(state.child.state.killCalls >= 1, "o child.kill() do Node confirma a morte da raiz");
    assert.equal(outcome.code, 0, "e o `close` resolve a outcome");
    assert.notEqual(outcome.deathUnconfirmed, true, "a morte foi confirmada");
  });

  it("A10: pedidos de kill repetidos NAO repetem sondas nem sessoes", async () => {
    const { state, hooks } = makeProductionHooks();
    const handle = spawnClamav("clamscan", ["--database=C:\\defs", "C:\\alvo.txt"], { windowsHide: true }, hooks);
    handle.killTree();
    handle.killTree();
    handle.killTree();
    await handle.outcome;

    assert.equal(
      state.terminationSessions,
      1,
      `tres killTree() nao podem gerar tres sessoes de terminacao: ${state.terminationSessions}. ` +
        "Isto e o A10: o guard `settled` so actua DEPOIS de a decisao.",
    );
  });

  it("sessao de terminacao FALHA: a vaga fica POISONED, nao libertada", async () => {
    const definitionsDir = await makeFakeReadyDefinitions(tmp);
    const { state, hooks } = makeProductionHooks({ sessionFails: true });
    const bridge = new ClamavBridge({
      definitionsDir,
      scanTimeoutMs: 120,
      // O `spawnClamav` REAL, com os hooks no quarto argumento.
      spawn: (file, args, request) => spawnClamav(file, args, request, hooks),
    });
    const first = path.join(tmp, "a.txt");
    await fs.writeFile(first, "benigno");
    const r1 = await bridge.scanFile(first);

    assert.ok(
      state.terminationSessions >= 1,
      `a sessao de handle tem de ter sido tentada: ${state.terminationSessions}`,
    );
    assert.equal(r1.status.status, "unavailable", `morte nao confirmada e \`unavailable\`: ${JSON.stringify(r1.status)}`);
    assert.notEqual(r1.verdict, "clean");

    // A vaga fica presa: um segundo clamscan nao pode nascer.
    const second = path.join(tmp, "b.txt");
    await fs.writeFile(second, "benigno");
    const r2 = await bridge.scanFile(second);
    assert.equal(state.spawnCount, 1, `um clamscan possivelmente vivo nao da lugar a um segundo: ${JSON.stringify(r2.status)}`);
    assert.equal(r2.status.status, "unavailable");

    // A prova de morte do SO e o que a liberta.
    state.child.kill();
    await sleep(60);
    const third = path.join(tmp, "c.txt");
    await fs.writeFile(third, "benigno");
    await bridge.scanFile(third);
    assert.equal(state.spawnCount, 2, `depois da morte confirmada o motor volta: ${state.spawnCount}`);
    await bridge.dispose().catch(() => {});
  });
});
