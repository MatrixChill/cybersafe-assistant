import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClamavBridge, spawnClamav } from "../dist/index.js";

/**
 * P0 SCANNER_REAL_BATCH_STALL — PROGRESSO REAL durante o batch.
 *
 * Estes testes entram pelo seam CERTO: `spawnClamav` com um `spawn` de Node
 * injectado. Não usam `options.spawn` da bridge, porque esse seam substitui o
 * spawner INTEIRO e saltaria justamente o código que conta o progresso (a
 * leitura do stdout em `createSpawnClamav`). Um teste que passa por baixo do
 * código que quer provar não prova nada.
 *
 * O número de ficheiros analisados vem das LINHAS DO PRÓPRIO CLAMSCAN
 * (`<caminho>: OK`, `<caminho>: <assinatura> FOUND`), contadas à medida que o
 * stdout corre. Nunca de um temporizador. Um temporizador que anima 0/N para
 * 90% seria uma mentira que o utilizador acredita.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeFakeReadyDefinitions(root) {
  const dir = path.join(root, "definitions", "clamav");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "main.cvd"), "x");
  await fs.writeFile(path.join(dir, "daily.cld"), "x");
  return path.join(root, "definitions");
}

/**
 * Filho de Node falso: tem stdout/stderr e emite `close`, como um processo
 * verdadeiro. O stdout sai em TRÊS fatias, para haver progresso a meio do scan.
 */
function makeFakeChild({ stdoutLines, code = 0, finalLineWithoutNewline = false }) {
  const emitter = new EventEmitter();
  emitter.pid = 41000;
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.killed = false;
  emitter.connected = true;
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  emitter.kill = () => true;

  const corte = Math.ceil(stdoutLines.length / 3);
  let i = 0;
  const tick = () => {
    if (emitter.exitCode !== null) return;
    const fim = Math.min(stdoutLines.length, i + corte);
    if (i < fim) {
      for (; i < fim; i++) {
        const isFinalPartial = finalLineWithoutNewline && i === stdoutLines.length - 1;
        emitter.stdout.emit("data", Buffer.from(stdoutLines[i] + (isFinalPartial ? "" : "\n"), "utf8"));
      }
      setTimeout(tick, 5);
      return;
    }
    emitter.exitCode = code;
    emitter.emit("close", code);
  };
  setTimeout(tick, 5);
  return emitter;
}

/** Spawner de PRODUÇÃO com um único filho simulado. */
function bridgeWithFakeChild(options) {
  let child = null;
  const nodeSpawn = () => {
    child = makeFakeChild(options);
    return child;
  };
  const bridge = new ClamavBridge({
    definitionsDir: options.definitionsDir,
    // Passa pelo `createSpawnClamav` real: só aí é que o stdout é lido.
    spawn: (file, args, request) =>
      spawnClamav(file, args, request, {
        spawn: nodeSpawn,
        spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
        probeIdentity: () => ({ row: null, probeFailed: true, detail: "seam de teste" }),
        captureIdentity: () => Promise.resolve({ row: null, probeFailed: true, detail: "seam de teste" }),
      }),
    scanTimeoutMs: 30_000,
  });
  return { bridge, getChild: () => child };
}

function makePaths(n) {
  const base = "C:\\Users\\caioc\\Documents\\Projectos\\cyber";
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(path.join(base, "modulo" + (i % 12), "src", "ficheiro_" + String(i).padStart(4, "0") + ".ts"));
  }
  return out;
}

let tmp;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-batchprogress-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("P0 SCANNER_REAL_BATCH_STALL — progresso REAL durante o batch", () => {
  it("onProgress é chamado enquanto o clamscan corre, não só no fim", async () => {
    const ficheiros = makePaths(300);
    const defs = await makeFakeReadyDefinitions(tmp);
    const { bridge, getChild } = bridgeWithFakeChild({
      definitionsDir: defs,
      stdoutLines: ficheiros.map((p) => `${p}: OK`),
    });

    const vistos = [];
    const promessa = bridge.scanFiles(ficheiros, { onProgress: (n) => vistos.push(n) });

    // A ponte spends `isAvailable()` (um `clamscan --version`) ANTES de spawnar,
    // por isso "esperar um tempo fixo" mediria o probe e nao o scan. Primeiro
    // espera-se que o filho exista; so depois se conta.
    const limite = Date.now() + 5_000;
    while (!getChild() && Date.now() < limite) await sleep(5);
    assert.ok(getChild(), "o spawn nunca aconteceu");

    // Deixa a PRIMEIRA fatia sair, ainda antes das restantes. Se o progresso so
    // chega no fim, esta fila esta vazia aqui - e e o que a UI vivia.
    await sleep(12);
    const emVoo = vistos.length;
    const maiorEmVoo = emVoo > 0 ? vistos[emVoo - 1] : 0;

    await promessa;

    assert.ok(
      emVoo > 0,
      `o batch só devolveu progresso DEPOIS de acabar (vistos=${JSON.stringify(vistos.slice(-3))}) — ` +
        "a UI fica 0/N durante o scan inteiro",
    );
    assert.ok(
      maiorEmVoo < ficheiros.length,
      `o 'progresso em voo' já era o total (${maiorEmVoo}) — não prova progresso em voo`,
    );
    assert.equal(vistos[vistos.length - 1], ficheiros.length, "o último progresso tem de ser o total");
  });

  it("o progresso nunca anda para trás nem ultrapassa o total", async () => {
    const ficheiros = makePaths(120);
    const defs = await makeFakeReadyDefinitions(tmp);
    const { bridge } = bridgeWithFakeChild({
      definitionsDir: defs,
      stdoutLines: ficheiros.map((p) => `${p}: OK`),
    });

    const vistos = [];
    await bridge.scanFiles(ficheiros, { onProgress: (n) => vistos.push(n) });

    for (let i = 1; i < vistos.length; i++) {
      assert.ok(vistos[i] >= vistos[i - 1], `progresso a recuar: ${vistos[i - 1]} -> ${vistos[i]}`);
      assert.ok(vistos[i] <= ficheiros.length, `acima do total: ${vistos[i]} > ${ficheiros.length}`);
    }
  });

  it("as linhas do SCAN SUMMARY não são contadas como ficheiros analisados", async () => {
    const ficheiros = makePaths(4);
    const defs = await makeFakeReadyDefinitions(tmp);
    const { bridge } = bridgeWithFakeChild({
      definitionsDir: defs,
      stdoutLines: [
        ...ficheiros.map((p) => `${p}: OK`),
        "",
        "----------- SCAN SUMMARY -----------",
        "Known viruses: 8600000",
        "Engine version: 1.5.2",
        "Scanned directories: 12",
        "Scanned files: 4",
        "Infected files: 0",
        "Total errors: 0",
      ],
    });

    const vistos = [];
    await bridge.scanFiles(ficheiros, { onProgress: (n) => vistos.push(n) });

    assert.equal(vistos.length, 4, `contou ${vistos.length} linhas; o summary não é ficheiro nenhum`);
    assert.equal(vistos[vistos.length - 1], 4);
  });

  it("uma linha FOUND conta UMA vez, e não duas", async () => {
    const ficheiros = makePaths(2);
    const defs = await makeFakeReadyDefinitions(tmp);
    const { bridge } = bridgeWithFakeChild({
      definitionsDir: defs,
      stdoutLines: [`${ficheiros[0]}: OK`, `${ficheiros[1]}: Eicar-Test-Signature FOUND`],
      code: 1,
    });

    const vistos = [];
    await bridge.scanFiles(ficheiros, { onProgress: (n) => vistos.push(n) });

    assert.deepEqual(vistos, [1, 2], `progresso=${JSON.stringify(vistos)}; esperado [1,2]`);
  });

  it("publica o 765.º resultado quando a linha final não tem newline e close confirma o fim", async () => {
    const ficheiros = makePaths(765);
    const defs = await makeFakeReadyDefinitions(tmp);
    const { bridge, getChild } = bridgeWithFakeChild({
      definitionsDir: defs,
      stdoutLines: [
        ...ficheiros.slice(0, -1).map((p) => `${p}: OK`),
        `${ficheiros[ficheiros.length - 1]}: Eicar-Test-Signature FOUND`,
      ],
      code: 1,
      finalLineWithoutNewline: true,
    });

    const vistos = [];
    const resultado = await bridge.scanFiles(ficheiros, { onProgress: (n) => vistos.push(n) });

    assert.ok(getChild(), "o child ClamAV simulado foi criado");
    assert.deepEqual(vistos, Array.from({ length: 765 }, (_, i) => i + 1));
    assert.equal(vistos[764], 765, "o callback final é contagem 765, não índice 764");
    assert.equal(resultado.files.length, 765);
    assert.equal(resultado.files[764].file, ficheiros[764]);
    assert.equal(resultado.files[764].verdict, "detected");
    assert.equal(resultado.files[764].signature, "Eicar-Test-Signature");
  });

  it("sem onProgress, nada muda: o scan é o mesmo", async () => {
    const ficheiros = makePaths(20);
    const defs = await makeFakeReadyDefinitions(tmp);
    const { bridge } = bridgeWithFakeChild({
      definitionsDir: defs,
      stdoutLines: ficheiros.map((p) => `${p}: OK`),
    });

    const r = await bridge.scanFiles(ficheiros);

    assert.equal(r.detected, false);
    assert.equal(r.files.length, ficheiros.length);
    assert.ok(r.files.every((f) => f.verdict === "clean"), "todos limpos");
  });
});