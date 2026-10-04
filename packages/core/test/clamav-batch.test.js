import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { ClamavBridge } from "../dist/index.js";

/**
 * FASE 4 (P0 CLAMAV_RESOURCE_EXHAUSTION) — batch: N ficheiros, 1 invocação.
 *
 * O que a FASE 3 mediu e porquê este trabalho existe:
 *
 *   carregar a base de assinaturas   ~6,2 s   (95% do custo de 1 ficheiro)
 *   RAM por clamscan                 ~981 MB  (main.cvd + daily.cvd + bytecode.cvd)
 *
 * O clamscan paga esse preço POR PROCESSO. Um spawn por ficheiro pagava-o N
 * vezes: 20 ficheiros ≈ 2 minutos. Numa invocacao paga-se uma vez, e o
 * resultado continua a ser POR FICHEIRO — que é o que permite atribuir uma
 * detecção ao ficheiro certo.
 *
 * Nada aqui confia em "~6,2 s" herdado de medições anteriores: os números de
 * wall time são medidos nesta execução e impressos.
 */

const CLAMSCAN_AVAILABLE = (() => {
  try {
    const r = spawnSync("clamscan", ["--version"], { timeout: 5000, windowsHide: true, encoding: "utf-8" });
    return r.status === 0 && String(r.stdout ?? "").includes("ClamAV");
  } catch {
    return false;
  }
})();

const DB_LOADING_MIN_KB = 200_000;

function liveClamavDbLoaders(exclude = []) {
  if (process.platform !== "win32") return [];
  try {
    const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq clamscan.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf-8",
      windowsHide: true,
    });
    return String(r.stdout ?? "")
      .split(/\r?\n/)
      .filter((line) => line.includes("clamscan.exe"))
      .map((line) => {
        const parts = line.split(",").map((part) => part.replace(/"/g, "").trim());
        return { pid: Number(parts[1]), memoryKb: Number(String(parts[4] ?? "").replace(/[^0-9]/g, "")) };
      })
      .filter((row) => Number.isFinite(row.pid) && row.pid > 0 && row.memoryKb >= DB_LOADING_MIN_KB)
      .filter((row) => !exclude.includes(row.pid));
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spawner falso: conta invocações e concorrência. Serve para o Isolamento. */
function makeCountingSpawner({ stdout = "", code = 0, durationMs = 50 } = {}) {
  const state = { spawned: 0, live: 0, peak: 0, argsSeen: [] };
  const spawn = (_file, args, _request) => {
    state.spawned++;
    state.live++;
    state.peak = Math.max(state.peak, state.live);
    state.argsSeen.push(args);
    let resolveOutcome;
    let dead = false;
    const finish = (outcome) => {
      if (dead) return;
      dead = true;
      state.live--;
      resolveOutcome(outcome);
    };
    const handle = {
      pid: 30000 + state.spawned,
      killTree() {
        finish({ code: null, stdout: "", stderr: "", timedOut: false, killed: true });
      },
      outcome: new Promise((r) => {
        resolveOutcome = r;
      }),
    };
    setTimeout(() => finish({ code, stdout, stderr: "", timedOut: false, killed: false }), durationMs);
    return handle;
  };
  return { spawn, state };
}

async function makeFakeReadyDefinitions(root) {
  const dir = path.join(root, "definitions", "clamav");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "main.cvd"), "x");
  await fs.writeFile(path.join(dir, "daily.cld"), "x");
  return path.join(root, "definitions");
}

let tmp;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-batch-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("FASE 4 — quantas invocações, e com que argumentos", () => {
  it("20 ficheiros ⇒ 1 spawn, e os 20 vão nos argumentos", async () => {
    const fake = makeCountingSpawner();
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      scanTimeoutMs: 1_000,
    });

    const files = Array.from({ length: 20 }, (_, i) => path.join(tmp, `f${i}.txt`));
    const batch = await bridge.scanFiles(files);

    assert.equal(fake.state.spawned, 1, `20 ficheiros deram ${fake.state.spawned} spawn(s)`);
    const args = fake.state.argsSeen[0];
    const paths = args.filter((a) => !a.startsWith("--"));
    assert.equal(paths.length, 20, "os 20 caminhos vão num único argv");
    assert.equal(batch.files.length, 20, "e há um resultado por ficheiro");
    assert.equal(batch.errorCount, 0);
  });

  it("1 ficheiro também é um batch de 1 (mesmo código, N = 1)", async () => {
    const fake = makeCountingSpawner();
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
    });
    await bridge.scanFiles([path.join(tmp, "a.txt")]);
    assert.equal(fake.state.spawned, 1);
  });

  it("a ordem dos resultados é a ordem dos ficheiros pedidos", async () => {
    const fake = makeCountingSpawner();
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
    });
    const files = ["z.txt", "a.txt", "m.txt"].map((f) => path.join(tmp, f));
    const batch = await bridge.scanFiles(files);
    assert.deepEqual(batch.files.map((f) => f.file), files);
  });

  it("o deadline do batch escala com N (um tecto fixo mataria um batch legítimo)", async () => {
    const fake = makeCountingSpawner({ durationMs: 10_000 });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      scanTimeoutMs: 5_000,
    });
    const files = Array.from({ length: 20 }, (_, i) => path.join(tmp, `f${i}.txt`));
    const started = Date.now();
    const res = await bridge.scanFiles(files);
    // 20 x 5 s = 100 s de orçamento. Se o tecto fosse 5 s, isto seria "timeout".
    assert.notEqual(res.files[0].reason, "timeout", "20 ficheiros não podem expirar por causa do tecto de 1");
    assert.ok(Date.now() - started < 30_000);
  });
});

describe("FASE 4 — uma deteção no meio do batch é atribuída ao ficheiro certo", () => {
  it("o resultado de cada ficheiro vem da sua própria linha FOUND", async () => {
    const target = path.join(tmp, "c.txt");
    const files = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"].map((f) => path.join(tmp, f));
    const fake = makeCountingSpawner({
      code: 1,
      stdout:
        `${files[0]}: OK\n${files[1]}: OK\n` +
        `${target}: Eicar-Test-Signature FOUND\n` +
        `${files[3]}: OK\n${files[4]}: OK\n` +
        "Infected files: 1\n",
    });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
    });

    const batch = await bridge.scanFiles(files);

    assert.equal(batch.detected, true);
    assert.equal(fake.state.spawned, 1, "um batch, mesmo com uma deteção no meio");
    const byName = Object.fromEntries(batch.files.map((f) => [path.basename(f.file), f]));
    assert.equal(byName["c.txt"].verdict, "detected", "a deteção é do ficheiro certo");
    assert.equal(byName["c.txt"].signature, "Eicar-Test-Signature");
    for (const clean of ["a.txt", "b.txt", "d.txt", "e.txt"]) {
      assert.equal(byName[clean].verdict, "clean", `${clean} é clean, e não 'infectado porque o batch tinha 1`);
    }
  });
});

describe("FASE 4 — cancelamento, timeout e falha continuam a matar o processo", () => {
  it("cancelar um batch mata o clamscan e não deixa órfãos", async () => {
    const fake = makeCountingSpawner({ durationMs: 60_000 });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      scanTimeoutMs: 60_000,
    });
    const controller = new AbortController();
    const files = Array.from({ length: 5 }, (_, i) => path.join(tmp, `f${i}.txt`));
    const pending = bridge.scanFiles(files, { signal: controller.signal });
    await sleep(30);
    controller.abort();
    const batch = await pending;

    assert.equal(fake.state.live, 0, "nada vivo depois do cancel");
    assert.equal(batch.detected, false);
    for (const f of batch.files) {
      assert.notEqual(f.verdict, "clean", `cancelado não é clean (${f.file})`);
    }
  });

  it("timeout de um batch mata e não devolve clean", async () => {
    const fake = makeCountingSpawner({ durationMs: 60_000 });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      scanTimeoutMs: 200,
    });
    const files = Array.from({ length: 3 }, (_, i) => path.join(tmp, `f${i}.txt`));
    const batch = await bridge.scanFiles(files);
    assert.equal(fake.state.live, 0, "sem órfãos");
    for (const f of batch.files) assert.equal(f.verdict, "error");
  });

  it("dispose com um batch a correr mata tudo e espera", async () => {
    const fake = makeCountingSpawner({ durationMs: 60_000 });
    const bridge = new ClamavBridge({
      definitionsDir: await makeFakeReadyDefinitions(tmp),
      spawn: fake.spawn,
      scanTimeoutMs: 60_000,
    });
    const pending = bridge.scanFiles([path.join(tmp, "a.txt"), path.join(tmp, "b.txt")]);
    await sleep(30);
    await bridge.dispose();
    assert.equal(fake.state.live, 0);
    await pending;
  });
});

describe("FASE 4 — medição real com o clamscan do sistema", { skip: !CLAMSCAN_AVAILABLE }, () => {
  async function makeFiles(n) {
    const files = [];
    for (let i = 0; i < n; i++) {
      const f = path.join(tmp, `doc${i}.txt`);
      await fs.writeFile(f, `ficheiro benigno numero ${i}\n`.repeat(20), "utf-8");
      files.push(f);
    }
    return files;
  }

  async function measure(n) {
    const files = await makeFiles(n);
    const bridge = new ClamavBridge({ scanTimeoutMs: 120_000 });
    if (!(await bridge.isAvailable())) return null;

    // MEDIR O QUE É NOSSO, NAO O QUE ESTÁ NO SO.
    //
    // A primeira versão desta medição contava clamscans no tasklist e dava
    // pico=3 com órfãos, porque o `node --test` corre ficheiros de teste EM
    // PARALELO e o `clamav-resource-cap.test.js` tinha os seus clamscans a
    // correr ao mesmo tempo. A medição estava a medir o vizinho. A pergunta
    // que importa é "quantos os NOSSOS", e a resposta está em
    // `bridge.liveChildPids()` — o mesmo mecanismo que o resto do ficheiro de
    // recursos já usa, e pelo mesmo motivo.
    const ourPids = new Set();
    let peak = 0;
    const sampler = setInterval(() => {
      const live = bridge.liveChildPids();
      for (const pid of live) ourPids.add(pid);
      peak = Math.max(peak, live.length);
    }, 100);

    const started = Date.now();
    const batch = await bridge.scanFiles(files);
    const wall = (Date.now() - started) / 1000;
    for (const pid of bridge.liveChildPids()) ourPids.add(pid);
    clearInterval(sampler);

    await sleep(800);
    // Órfão = um PID que NÓS lançámos e que ainda está vivo no SO.
    const alive = new Set(liveClamavDbLoaders().map((r) => r.pid));
    const leftover = [...ourPids].filter((pid) => alive.has(pid));

    return { wall, peak, batch, leftover, n, spawnCount: ourPids.size };
  }

  it("5 ficheiros: mede spawn, pico, wall e órfãos", async () => {
    const m = await measure(5);
    if (!m) return;
    console.log(
      `    [real] BATCH 5:  spawns=${m.spawnCount}  wall=${m.wall.toFixed(1)}s  pico_clamscan=${m.peak}  ` +
        `veredictos=${m.batch.files.filter((f) => f.verdict === "clean").length}clean/` +
        `${m.batch.files.filter((f) => f.verdict === "error").length}error  ` +
        `orfãos=${m.leftover.length ? m.leftover.join(",") : "nenhum"}`,
    );
    assert.equal(m.batch.files.length, 5, "um resultado por ficheiro");
    assert.equal(m.spawnCount, 1, `5 ficheiros deram ${m.spawnCount} spawn(s) nosso(s)`);
    assert.ok(m.peak <= 1, `pico de clamscans nossos = ${m.peak}; tem de ser <= 1`);
    assert.equal(m.leftover.length, 0, "nenhum clamscan nosso sobrevive ao batch");
  });

  it("20 ficheiros: o wall time tem de ser MUITO menor que 20x o de 5", async () => {
    const m5 = await measure(5);
    if (!m5) return;
    const m20 = await measure(20);
    if (!m20) return;

    console.log(
      `    [real] BATCH 20: spawns=${m20.spawnCount}  wall=${m20.wall.toFixed(1)}s  pico_clamscan=${m20.peak}  ` +
        `orfãos=${m20.leftover.length ? m20.leftover.join(",") : "nenhum"}`,
    );
    console.log(
      `    [real] COMPARACAO: 5 ficheiros=${m5.wall.toFixed(1)}s  20 ficheiros=${m20.wall.toFixed(1)}s  ` +
        `spawns ${m5.spawnCount} e ${m20.spawnCount}  razao=${(m20.wall / m5.wall).toFixed(2)}x ` +
        `(por-ficheiro daria ~4x o tempo para 4x os ficheiros, e 4x os spawns)`,
    );

    assert.equal(m20.batch.files.length, 20);
    assert.equal(m20.spawnCount, 1, `20 ficheiros deram ${m20.spawnCount} spawn(s) nosso(s)`);
    assert.ok(m20.peak <= 1, `pico = ${m20.peak}`);
    assert.equal(m20.leftover.length, 0, "nenhum órfão nosso");
    // A prova de que o batch fez trabalho: 4x os ficheiros não podem custar 4x
    // o tempo, porque o custo dominante é o carregamento da base e esse é
    // pago uma vez. Tolerância generosa porque o disco e o Defender variam.
    assert.ok(
      m20.wall < m5.wall * 3.2,
      `20 ficheiros(${m20.wall.toFixed(1)}s) deviam ser muito mais baratos que 4x os de 5(${m5.wall.toFixed(1)}s)`,
    );
  });

  it("o per-file continua a funcionar: 1 ficheiro, 1 spawn, mesmo clamscan", async () => {
    const files = await makeFiles(1);
    const bridge = new ClamavBridge({ scanTimeoutMs: 120_000 });
    if (!(await bridge.isAvailable())) return;
    const res = await bridge.scanFile(files[0]);
    assert.equal(res.verdict, "clean", `um benigno tem de ser clean (detail=${res.detail})`);
  });
});
