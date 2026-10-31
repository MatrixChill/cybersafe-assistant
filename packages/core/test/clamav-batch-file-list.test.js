import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClamavBridge } from "../dist/index.js";

/**
 * P0 SCANNER_REAL_BATCH_STALL — o batch de ClamAV nunca arranca num scan grande.
 *
 * MEDIDO (2026-10-05), pela ponte REAL, com 765 ficheiros benignos:
 *
 *   argv estimado .......... 65 166 caracteres
 *   tecto do Windows ....... 32 767 caracteres (CreateProcess)
 *   spawn ................... ENAMETOOLONG
 *   clamscan vivos depois .. 1 (o de antes; zero órfãos criados)
 *
 * Consequência, que é pior do que o scan não avançar: `spawn()` LANÇA de forma
 * SÍNCRONA, o `child.on("error")` nunca chega a correr, e a excepção sai de
 * `runScanHoldingLease`. O `prefetchClamav` do serviço apanha-a e FAZ
 * `clamavPrefetches.delete(owner)` — perde o veredicto por ficheiro e cada um
 * dos 765 ficheiros volta ao clamscan individual. É exactamente o P0
 * CLAMAV_RESOURCE_EXHAUSTION que a FASE 4 existia para fechar: 765 invocações
 * × ~6,2 s e ~981 MB, uma de cada vez.
 *
 * Estes testes não correm o clamscan real: o spawner é injectado. O que se
 * prova é o contrato, não a máquina.
 */

const WINDOWS_COMMAND_LINE_LIMIT = 32767;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeFakeReadyDefinitions(root) {
  const dir = path.join(root, "definitions", "clamav");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "main.cvd"), "x");
  await fs.writeFile(path.join(dir, "daily.cld"), "x");
  return path.join(root, "definitions");
}

/**
 * Spawner que regista o argv e emite stdout EM FATIAS, como o clamscan real
 * (uma linha por ficheiro, enquanto corre). As fatias existem para que
 * `onProgress` tenha de ser chamado ANTES de o scan acabar.
 */
function makeRecordingSpawner({ stdoutFor } = {}) {
  const state = { calls: [], live: 0, peak: 0 };
  const spawn = (_file, args, request) => {
    state.calls.push({ args, request });
    state.live++;
    state.peak = Math.max(state.peak, state.live);
    let resolveOutcome;
    let dead = false;
    const finish = (outcome) => {
      if (dead) return;
      dead = true;
      state.live--;
      resolveOutcome(outcome);
    };
    const handle = {
      pid: 30000 + state.calls.length,
      killTree() {
        finish({ code: null, stderr: "", timedOut: false, killed: true });
      },
      outcome: new Promise((resolve) => {
        resolveOutcome = resolve;
      }),
    };
    handle.stdout = new EventEmitter();
    handle.stderr = new EventEmitter();
    handle.__emit = (chunk) => handle.stdout.emit("data", Buffer.from(chunk, "utf8"));

    const files = stdoutFor ? stdoutFor(args) : [];
    const corte = Math.ceil(files.length / 3);
    let i = 0;
    const tick = () => {
      if (dead) return;
      const fim = Math.min(files.length, i + corte);
      if (i < fim) {
        for (; i < fim; i++) handle.__emit(files[i] + "\n");
        setTimeout(tick, 5);
        return;
      }
      finish({ code: 0, stdout: files.join("\n") + "\n", stderr: "", timedOut: false, killed: false });
    };
    setTimeout(tick, 5);
    return handle;
  };
  return { spawn, state };
}

let tmp;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-batchfilelist-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/** N caminhos com o comprimento típico de um path real do utilizador. */
function makePaths(n) {
  const base = "C:\\Users\\caioc\\Documents\\Projectos\\cyber";
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(path.join(base, "modulo" + (i % 12), "src", "ficheiro_" + String(i).padStart(4, "0") + ".ts"));
  }
  return out;
}

describe("P0 SCANNER_REAL_BATCH_STALL — o argv não pode levar os caminhos", () => {
  it("800 caminhos NÃO podem ser passados como argumentos (ENAMETOOLONG)", async () => {
    const ficheiros = makePaths(800);
    const fake = makeRecordingSpawner({ stdoutFor: () => ficheiros.map((p) => `${p}: OK`) });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      scanTimeoutMs: 30_000,
    });

    await bridge.scanFiles(ficheiros);

    assert.equal(fake.state.calls.length, 1, "tem de haver UMA invocação (o cap MAX_CLAMSCAN=1)");
    const argv = fake.state.calls[0].args;
    const argvLen = argv.reduce((n, a) => n + a.length + 3, 0);
    assert.ok(
      argvLen < WINDOWS_COMMAND_LINE_LIMIT,
      `argv com ${argvLen} chars passa do tecto do Windows (${WINDOWS_COMMAND_LINE_LIMIT}) — ` +
        "é isto que fazia o spawn falhar com ENAMETOOLONG",
    );
  });

  it("os caminhos vão num ficheiro de lista com TODOS os caminhos", async () => {
    const ficheiros = makePaths(800);
    const fake = makeRecordingSpawner({ stdoutFor: () => ficheiros.map((p) => `${p}: OK`) });

    let lista = null;
    let conteudoDuranteOScan = null;
    const spySpawn = (file, args, request) => {
      // Ler AGORA: no fim do scan a lista já foi apagada (e tem de estar).
      const flag = args.find((a) => a.startsWith("--file-list="));
      lista = flag ? flag.slice("--file-list=".length) : null;
      if (lista) {
        conteudoDuranteOScan = readFileSync(lista, "utf-8");
      }
      return fake.spawn(file, args, request);
    };

    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: spySpawn,
      scanTimeoutMs: 30_000,
    });

    await bridge.scanFiles(ficheiros);

    assert.ok(lista, "o batch tem de usar --file-list para não estourar a command line");
    assert.equal(
      conteudoDuranteOScan.split(/\r?\n/).filter(Boolean).length,
      ficheiros.length,
      "o ficheiro de lista tem de trazer TODOS os caminhos",
    );
  });

  it("o ficheiro de lista é removido no fim do scan", async () => {
    const ficheiros = makePaths(800);
    const fake = makeRecordingSpawner({ stdoutFor: () => ficheiros.map((p) => `${p}: OK`) });
    let lista = null;
    const spySpawn = (file, args, request) => {
      const flag = args.find((a) => a.startsWith("--file-list="));
      if (flag) lista = flag.slice("--file-list=".length);
      return fake.spawn(file, args, request);
    };
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: spySpawn,
      scanTimeoutMs: 30_000,
    });

    await bridge.scanFiles(ficheiros);

    assert.ok(lista, "esperava-se um ficheiro de lista");
    const existe = await fs
      .access(lista)
      .then(() => true)
      .catch(() => false);
    assert.equal(existe, false, "o ficheiro de lista ficou em disco: lista os ficheiros do utilizador");
  });

  it("um batch pequeno continua a poder usar argv (não mudou o caminho de N pequeno)", async () => {
    const alvo = path.join(tmp, "a.txt");
    await fs.writeFile(alvo, "benigno", "utf-8");
    const fake = makeRecordingSpawner({ stdoutFor: () => [`${alvo}: OK`] });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      scanTimeoutMs: 30_000,
    });

    const r = await bridge.scanFile(alvo);

    assert.equal(r.detected, false);
    assert.equal(fake.state.calls.length, 1);
    assert.ok(
      fake.state.calls[0].args.includes(alvo),
      "um scan de um ficheiro continua a passar o caminho no argv",
    );
  });
});

describe("P0 SCANNER_REAL_BATCH_STALL — um spawn que LANÇA não pode derrubar o scan", () => {
  it("spawn que lança devolve `unavailable`, não uma excepção", async () => {
    // Reproduz o ENAMETOOLONG: o `spawn()` do Node lança de forma SÍNCRONA,
    // antes de existir qualquer filho a quem `child.on("error")` possa ligar.
    const spawnQueLanca = () => {
      const err = new Error("spawn ENAMETOOLONG");
      err.code = "ENAMETOOLONG";
      throw err;
    };
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: spawnQueLanca,
      scanTimeoutMs: 5_000,
    });

    const alvo = path.join(tmp, "a.txt");
    await fs.writeFile(alvo, "benigno", "utf-8");

    // O contrato: resolver com a VERDADE, nunca lançar. Um `throw` aqui
    // propaga até ao `prefetchClamav`, que apaga o prefetch e devolve todos os
    // ficheiros ao clamscan individual — a cascata que o cap existe para
    // impedir.
    const r = await bridge.scanFile(alvo);

    assert.equal(r.detected, false, "um spawn falhado não é uma deteção");
    assert.notEqual(r.verdict, "clean", "um spawn que falhou não pode dizer 'limpo'");
    assert.ok(r.reason || r.detail, "tem de haver uma causa visível do que aconteceu");
  });

  it("um spawn que lança NÃO deixa a vaga presa (o scan seguinte volta a poder)", async () => {
    let chamadas = 0;
    const spawnQueLanca = () => {
      chamadas++;
      if (chamadas === 1) throw new Error("spawn ENAMETOOLONG");
      // Segunda tentativa: um handle que ACABA. Um handle que nunca resolve
      // faria este teste expirar em vez de dizer o que diz.
      return {
        pid: 31000,
        killTree() {},
        outcome: Promise.resolve({ code: 0, stdout: `${alvo}: OK\n----------- SCAN SUMMARY ----------\nKnown viruses: 1\nEngine version: 1.5.2\nScanned directories: 0\nScanned files: 1\nInfected files: 0\nTotal errors: 0\nData scanned: 0.00MiB\nTime: 0.01s\n`, stderr: "", timedOut: false, killed: false }),
      };
    };
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: spawnQueLanca,
      scanTimeoutMs: 5_000,
    });
    const alvo = path.join(tmp, "a.txt");
    await fs.writeFile(alvo, "benigno", "utf-8");

    await bridge.scanFile(alvo);
    const segunda = await bridge.scanFile(alvo);

    assert.equal(segunda.detected, false, "o scan seguinte tem de conseguir correr");
    assert.notEqual(segunda.verdict, "error", "a vaga ficou envenenada por um spawn que nunca nasceu");
  });
});
