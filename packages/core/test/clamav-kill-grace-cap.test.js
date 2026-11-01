import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClamavBridge, createSpawnClamav } from "../dist/index.js";
import { isLoadProof, makeLoadProofHandle } from "./fixtures/clamav-load-proof.js";

/**
 * P0 (Codex F1) - o grace do `killTree` LIBERTA A VAGA sem prova de morte.
 *
 * ── O mecanismo, lido no código ───────────────────────────────────────────────
 * `spawnClamav.killTree()` arma `graceTimer = setTimeout(() => finish(null),
 * DEFAULT_KILL_GRACE_MS)`. O `finish(null)` resolve a `outcome` como se o
 * processo tivesse morrido. A bridge faz `await handle.outcome` e o `finally`
 * chama `releaseClamavSlot()`. Portanto: se a sessão de terminação falhar E o
 * `child.kill()` não conseguir matar o clamscan, a vaga é libertada com o
 * processo ainda VIVO — e o próximo scan arranca. São 2 clamscans × ~1 GB,
 * que é o P0 original (PC congelado) reintroduzido pelo mecanismo que o
 * supostamente corrigia.
 *
 * ──Porque este teste NÃO usa o binário real ─────────────────────────────────
 * O caminho que dispara o bug é o clamscan que não morre. Com o binário real
 * isso significaria um clamscan de ~1 GB que recusa o `TerminateProcess` —
 * impossível de fabricar. Por isso o filho do `child_process` é SIMULADO
 * (`createSpawnClamav`) e é o `spawnClamav` REAL que o executa: o grace, o
 * `finish`, o `close` e a contabilidade do cap são os de produção. Nenhum
 * clamscan é lançado.
 *
 * ── T15: o que estes testes FAZEM DE ERRADO (Codex, achado 15) ────────────────
 * O caso "normal" criava filhos que morriam sozinhos aos **5 ms**, muito antes
 * do timeout de **120 ms** que dispara o `killTree`: o `close` chegava sem que
 * houvesse kill nenhum, e o teste passava a dizer "matar e ver morrer" sem ter
 * matado. O caso `unkillable` injectava `spawnSync` SEM sonda, portanto a
 * identidade ficava por capturar, o veredicto era `unavailable` e os kills que
 * o teste diz simular nunca eram tentados — o caminho `unkillable` nunca chegou
 * a existir.
 *
 * Agora: a identidade é CAPTURADA e lida em todas as cenários, o filho normal
 * NÃO morre sozinho (morre porque o `killTree` o mata), e o `spawnSync`
 * responde à sessão de handle com uma falha explícita. É a diferença entre
 * "o teste passou" e "o caminho foi exercitado".
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A criação do filho é RELATIVA ao momento do spawn, não uma constante do
 * módulo. Com uma constante, o primeiro scan a correr segundos depois do
 * carregamento do ficheiro produz uma criação "anterior ao spawn" — e a
 * classificação rejeita (é para isso que a margem existe). Isto não é um teste
 * sobre tolerâncias: é o relógio a mentir.
 */
function criacaoDoFilhoRecem(nascidoHaMs = 200) {
  return new Date(Date.now() - nascidoHaMs).toISOString();
}

async function makeFakeReadyDefinitions(root) {
  const dir = path.join(root, "definitions", "clamav");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "main.cvd"), "x");
  await fs.writeFile(path.join(dir, "daily.cld"), "x");
  return path.join(root, "definitions");
}

/**
 * Filho simulado que NÃO morre sozinho.
 *
 * `unkillable` é o caso que o P0 precisa: o `kill()` devolve `false` (não
 * matou) e o `close` nunca chega sem o teste chamar `die()`, que é a prova de
 * morte que a produção receberia do SO.
 *
 * `autoDieMs` existe mas os cenários que o usam passam a nomeá-lo nos testes
 * que dependem dele; o caminho normal usa 0, que é o que faz o `killTree` ser
 * quem mata.
 */
function makeFakeChild({ pid, unkillable, autoDieMs = 0 }) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const state = { killCalls: 0, died: false };
  child.state = state;
  child.kill = () => {
    state.killCalls++;
    if (unkillable) return false; // não matou — é o caso do P0
    child.die(0);
    return true;
  };
  child.die = (code) => {
    if (state.died) return;
    state.died = true;
    setTimeout(() => child.emit("close", code), 0);
  };
  if (autoDieMs > 0) setTimeout(() => child.die(0), autoDieMs);
  return child;
}

/**
 * A linha que o CIM devolveria para o nosso clamscan.
 *
 * A linha de comando é montada a partir dos argumentos REALMENTE passados pelo
 * `spawnClamav`. Sem isto, `expected.cmdMarker` (o primeiro caminho que o
 * clamscan recebeu) não aparecia na linha e a captura era rejeitada por
 * contradição — que é o comportamento certo do código e a razão pela qual este
 * ficheiro, antes, só funcionava porque não havia captura nenhuma.
 */
function oursRow(pid, cmd, created) {
  return {
    pid,
    ppid: process.pid,
    name: "clamscan.exe",
    exe: "C:\\Program Files\\ClamAV\\clamscan.exe",
    created,
    cmd,
  };
}

/**
 * `spawn`/`spawnSync`/`probeIdentity`/`captureIdentity` simulados.
 *
 * `sessionFails` é o que faz o caso `unkillable` passar a ser o caso que o P0
 * precisa: a identidade está CONFIRMADA (a captura e a leitura dão a mesma
 * criação), a sessão de handle é chamada, e é ELA que falha. Antes, sem sonda,
 * o veredicto era `unavailable` e o kill nunca era tentado.
 */
function makeHooks({ specs, children, sessionFails = false }) {
  const state = { spawnCount: 0, terminationSessions: 0, children, scripts: [], spawnedWith: "", criacao: "" };
  const spawn = (file, args) => {
    const spec = specs[state.spawnCount] ?? {};
    const child = makeFakeChild({
      pid: 40000 + state.spawnCount,
      unkillable: spec.unkillable === true,
      autoDieMs: spec.autoDieMs ?? 0,
    });
    children.push(child);
    state.spawnCount++;
    state.spawnedWith = [file, ...(args ?? [])].join(" ");
    state.criacao = criacaoDoFilhoRecem();
    return child;
  };
  const spawnSync = (cmd, args) => {
    state.terminationSessions++;
    state.scripts.push(String(args?.[args?.length - 1] ?? ""));
    if (sessionFails) {
      throw new Error(`a sessao de terminacao falhou (simulado: ACCESS DENIED) para ${cmd}`);
    }
    return { status: 0, stdout: JSON.stringify({ v: "killed", root: true, descendants: 0, refused: 0 }) };
  };
  const reading = (pid) => ({ row: oursRow(pid, state.spawnedWith, state.criacao), probeFailed: false, detail: "simulado" });
  return {
    hooks: {
      spawn,
      spawnSync,
      probeIdentity: reading,
      captureIdentity: async (pid) => reading(pid),
    },
    state,
  };
}

let scenarioCounter = 0;
async function newScenario(specs = [], { sessionFails = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cs-killgrace-"));
  const definitionsDir = await makeFakeReadyDefinitions(root);
  const children = [];
  const { hooks, state } = makeHooks({ specs, children, sessionFails });
  // O spawner de produção, com o filho trocado.
  const clamavSpawn = createSpawnClamav(hooks);
  const bridge = new ClamavBridge({
    definitionsDir,
    // A prova de carga spawna por este seam com `scanId: "load-proof"`. Ela não
    // pode consumir `specs[state.spawnCount]` nem entrar em `children`: os
    // cenários-indexados por ordem de spawn e as asserções
    // `children[0].state.killCalls` / `spawnCount` são sobre o filho do SCAN.
    // A prova responde fora da simulação, com morte confirmada (nunca envenena
    // a vaga que estes testes medem).
    spawn: (file, args, request) =>
      isLoadProof(request) ? makeLoadProofHandle() : clamavSpawn(file, args, request),
    scanTimeoutMs: 120,
  });
  const file = (name) => path.join(root, name);
  scenarioCounter++;
  return { root, bridge, children, state, file, id: scenarioCounter };
}

async function cleanup({ root, bridge, children }) {
  // Confirmar a morte de todos os filhos: é o que liberta a vaga envenenada.
  for (const c of children) c.die(0);
  await bridge.dispose().catch(() => {});
  await sleep(20);
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

describe("P0 Codex F1 — o cap NUNCA é libertado sem prova de morte", () => {
  it("um clamscan que não morre NÃO pode abrir vaga para um segundo", async () => {
    const s = await newScenario([{ unkillable: true }, {}]);
    try {
      const [r1, r2] = await Promise.all([
        s.bridge.scanFile(s.file("a.txt")),
        s.bridge.scanFile(s.file("b.txt")),
      ]);

      assert.equal(
        s.state.spawnCount,
        1,
        `o cap libertou a vaga com o clamscan VIVO: ${s.state.spawnCount} clamscans lançados ` +
          `(${s.state.taskkillCalls} taskkill, ${s.children[0]?.state.killCalls} kill(s)). ` +
          `2 clamscans × ~1 GB é o P0 original.`,
      );

      // O primeiro scan pode ser "erro por timeout" — o que NÃO pode é o
      // segundo dizer que o ficheiro está limpo sem clamscan nenhum.
      assert.notEqual(r2.verdict, "clean", "o segundo scan declarou limpo sem clamscan: resultado FALSO");
      assert.equal(r2.status.status, "unavailable", `o segundo scan devia estar indisponível: ${JSON.stringify(r2.status)}`);

      // E o primeiro scan não pode fingir que matou o motor.
      assert.equal(r1.detected, false);
      assert.notEqual(r1.verdict, "clean", "o scan com timeout não pode declarar o ficheiro limpo");
    } finally {
      await cleanup(s);
    }
  });

  it("quando a morte é mesmo confirmada, a vaga volta e o motor volta a correr", async () => {
    const s = await newScenario([{ unkillable: true }, {}]);
    try {
      await Promise.all([s.bridge.scanFile(s.file("a.txt")), s.bridge.scanFile(s.file("b.txt"))]);
      assert.equal(s.state.spawnCount, 1, "a vaga não pode ter sido libertada sem prova de morte");

      // O SO confirma a morte: o `close` chega.
      s.children[0].die(0);
      await sleep(60);

      const r3 = await s.bridge.scanFile(s.file("c.txt"));
      assert.equal(s.state.spawnCount, 2, `depois da morte confirmada o motor tem de voltar: ${s.state.spawnCount}`);
      assert.equal(
        r3.status.status,
        "degraded",
        `o scan restaurado tem de correr e a dizer que foi interrompido no deadline: ${JSON.stringify(r3)}`,
      );
    } finally {
      await cleanup(s);
    }
  });

  it("o caminho normal NÃO fica envenenado: matar e ver morrer continua a libertar", async () => {
    // T15: o filho NAO morre sozinho. Com `autoDieMs` a 5 ms e o timeout a
    // 120 ms, o `close` chegava antes de haver kill e o teste provava que o
    // clamscan se matava sozinho — e ainda esperava `clean`, que era o que um
    // scan que NÃO foi interrompido devolve.
    //
    // A propriedade deste teste é a do TÍTULO: o cap não fica envenenado. O
    // resultado de cada scan é `degraded`/`error` porque o scan foi mesmo
    // interrompido no deadline — e afirmar `clean` aqui seria afirmar que o
    // clamscan terminou sozinho, que é exactamente o que deixou de acontecer.
    const s = await newScenario([{}, {}, {}]);
    try {
      for (const name of ["a.txt", "b.txt", "c.txt"]) {
        const r = await s.bridge.scanFile(s.file(name));
        assert.equal(
          r.status.status,
          "degraded",
          `um scan interrompido no deadline tem de dizer que foi interrompido: ${JSON.stringify(r.status)}`,
        );
        assert.notEqual(r.verdict, "clean", "e nunca 'limpo'");
      }
      assert.equal(s.state.spawnCount, 3, "cada scan tem de ter corrido: o cap não pode ficar preso");
      assert.equal(
        s.state.terminationSessions,
        3,
        `cada scan tem de ter terminado o seu clamscan: ${s.state.terminationSessions}`,
      );
      assert.ok(
        s.children.every((c) => c.state.killCalls >= 1),
        `todos os filhos tiveram de ser mortos pelo killTree, nao por expiracao: ` +
          `${JSON.stringify(s.children.map((c) => c.state.killCalls))}`,
      );
      assert.ok(s.children.every((c) => c.state.died), "e todos tiveram de morrer de facto");
      // E a prova de que a sessao de handle foi a que matou: o script tem de
      // operar sobre o handle, nao sobre um numero solto.
      assert.ok(
        s.state.scripts.every((script) => /Get-Process -Id \d+/.test(script)),
        "a terminacao tem de ser por handle",
      );
      // A propriedade do titulo, afirmada pelo semaforo e nao por um `clean`:
      // um quarto scan ainda arranca, porque as tres mortes foram confirmadas.
      const quarto = await s.bridge.scanFile(s.file("d.txt"));
      assert.equal(s.state.spawnCount, 4, `a vaga tem de ter voltado: ${JSON.stringify(quarto.status)}`);
    } finally {
      await cleanup(s);
    }
  });

  it("T15b - kill que FALHA, com a identidade JA confirmada: e a sessao que falha, nao a identidade", async () => {
    // Este é o caminho que o Codex mandou exercitar. Antes, `unkillable` injectava
    // `spawnSync` sem sonda: a identidade ficava por capturar, o veredicto era
    // `unavailable`, e os kills que o teste dizia simular nunca eram tentados —
    // o caminho nunca existiu.
    const s = await newScenario([{ unkillable: true }, {}], { sessionFails: true });
    try {
      const [r1, r2] = await Promise.all([
        s.bridge.scanFile(s.file("a.txt")),
        s.bridge.scanFile(s.file("b.txt")),
      ]);

      assert.ok(
        s.state.terminationSessions >= 1,
        `a sessao de handle tem de ter sido TENTADA com a identidade confirmada: ` +
          `${s.state.terminationSessions}. Sem esta linha, o teste passava sem nunca matar nada.`,
      );
      assert.ok(
        s.state.scripts.every((script) => /Get-Process -Id \d+/.test(script)),
        "e por handle, nao por numero solto",
      );
      assert.equal(
        s.children[0].state.killCalls,
        0,
        `quando a sessao verificada nao responde, o ` +
          `child.kill() do Node tambem nao corre: o veredicto e \`unknown\` e ` +
          `unknown nao toca em nada. Preco: ${s.children[0].state.killCalls} kill(s).`,
      );
      assert.equal(s.children[0].state.died, false, `o clamscan continua VIVO: ${JSON.stringify(s.children[0].state)}`);

      assert.equal(
        s.state.spawnCount,
        1,
        `o cap libertou a vaga com o clamscan VIVO: ${s.state.spawnCount} clamscans lançados. ` +
          `2 clamscans × ~1 GB é o P0 original.`,
      );
      assert.notEqual(r2.verdict, "clean", "o segundo scan declarou limpo sem clamscan: resultado FALSO");
      assert.equal(r2.status.status, "unavailable", `o segundo scan devia estar indisponível: ${JSON.stringify(r2.status)}`);
      assert.equal(r1.detected, false);
      assert.notEqual(r1.verdict, "clean", "o scan com timeout não pode declarar o ficheiro limpo");
    } finally {
      await cleanup(s);
    }
  });

  it("um clamscan vivo NÃO fica pendurado: dispose() não pode ficar preso", async () => {
    const s = await newScenario([{ unkillable: true }, {}]);
    try {
      await Promise.all([s.bridge.scanFile(s.file("a.txt")), s.bridge.scanFile(s.file("b.txt"))]);
      // O 1º filho nunca morreu. O dispose tem de resolver na mesma.
      const disposed = await Promise.race([
        s.bridge.dispose().then(() => "ok"),
        sleep(3_000).then(() => "preso"),
      ]);
      assert.equal(disposed, "ok", "dispose() ficou preso por um clamscan sem prova de morte");
    } finally {
      await cleanup(s);
    }
  });
});