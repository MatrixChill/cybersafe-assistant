/**
 * TASK F — BATCH_RESULT_INTEGRITY.
 *
 * O batch do ClamAV trocou "um spawn por ficheiro" por "um spawn para o scan
 * todo". A ganancia foi real (33,2 s -> 7,6 s em 5 ficheiros; 138,6 s -> 7,5 s
 * em 20). O risco que a troca introduz é o OPPOSTO do que ela resolve: com N
 * ficheiros num clamscan so, um erro de atribuicao deixa de ser um erro
 * local e passa a ser um veredicto sobre o ficheiro errado.
 *
 * Estes testes fixam os nove cenarios que o utilizador especificou. A aceitacao
 * de todos e a mesma, e e uma so:
 *
 *   - cada resultado pertence AO PATH CERTO;
 *   - um ERROR nao torna o batch inteiro CLEAN;
 *   - uma deteccao nao desaparece porque outro ficheiro errou;
 *   - sem orfaos;
 *   - peak <= 1.
 *
 * Todos usam `spawn` INJECTADO (um handle falso que nunca arranca um clamscan),
 * por isso sao rapidos, nao pesam ~1 GB e nao tocam no disco real. Os cenarios
 * que precisam de comportamento REAl (recursos, argv,条约) vivem em
 * `clamav-batch.test.js`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { ClamavBridge, parseClamavOutput } from "../dist/index.js";
import { isLoadProof, makeLoadProofHandle } from "./fixtures/clamav-load-proof.js";

// ─────────────────────────────────────────────────────────────────────────────
// Spawner falso
// ─────────────────────────────────────────────────────────────────────────────

const SUMMARY = (infected, errors, scanned) => `
----------- SCAN SUMMARY -----------
Known viruses: 3628114
Engine version: 1.5.2
Scanned directories: 0
Scanned files: ${scanned}
Infected files: ${infected}
Total errors: ${errors}
Data scanned: 132 B
`.trimStart();

/**
 * Um handle que se comporta como o spawner real mas com o output fornecido.
 * `killTree` marca `killed` e resolve `outcome` com code null — que e o que o
 * bridge trata como timeout/abort.
 */
function fakeSpawn(stdout, stderr, code, opts = {}) {
  const calls = { count: 0, killed: 0, live: 0, peak: 0 };
  const spawn = (_file, _args, request) => {
    // PROVA DE CARGA (`scanId: "load-proof"`): responde com evidência coerente
    // para que `active` seja alcançável, mas NÃO entra em `count`/`live`/`peak`
    // — este ficheiro afirma "UM spawn por batch e pico 1", e contar a prova
    // faria a asserção medir a prova em vez do batch.
    if (isLoadProof(request)) return makeLoadProofHandle();
    calls.count++;
    calls.live++;
    calls.peak = Math.max(calls.peak, calls.live);
    let resolveOutcome;
    let dead = false;
    const finish = (outcome) => {
      if (dead) return;
      dead = true;
      calls.live--;
      resolveOutcome(outcome);
    };
    const handle = {
      pid: 10000 + calls.count,
      killTree: () => {
        calls.killed++;
        finish({ code: null, stdout: "", stderr: "", timedOut: false, killed: true });
      },
      outcome: new Promise((r) => {
        resolveOutcome = r;
      }),
    };
    if (!opts.hang) {
      queueMicrotask(() =>
        finish({ code, stdout, stderr, timedOut: false, killed: false }),
      );
    }
    return handle;
  };
  return { spawn, calls };
}

const tempDirs = [];
async function tmpDir() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-integrity-"));
  tempDirs.push(d);
  return d;
}

/** Cria N ficheiros vazios e devolve os paths ABSOLUTOS por ordem. */
async function makeFiles(dir, n, name = (i) => `f${i}.txt`) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = path.join(dir, name(i));
    await fs.writeFile(p, "conteudo benigno de teste", "utf8");
    out.push(p);
  }
  return out;
}

/**
 * Espera ate o spawner ter sido chamado. O `ClamavBridge` corre um probe real
 * (`clamscan --version`) antes do primeiro scan, e esse probe demora ~150 ms:
 * um `setTimeout(20)` abortaria ou desligaria ANTES de haver processo, e o
 * teste mediria a sonda e não o codigo.
 */
async function waitForSpawn(calls, timeoutMs = 5_000) {
  const started = Date.now();
  while (calls.count === 0) {
    if (Date.now() - started > timeoutMs) throw new Error("o spawn nunca aconteceu");
    await new Promise((r) => setTimeout(r, 10));
  }
}

process.on("exit", () => {
  for (const d of tempDirs) {
    try {
      require("node:fs").rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/**
 * Bridge com base de assinaturas FALSA mas "pronta", para o teste depender do
 * spawner e nunca do estado real do disco do utilizador. `clamdscan` nao e
 * executado: o `spawn` injetado responde.
 */
async function bridgeWith(spawn, extra = {}) {
  const dir = await tmpDir();
  const defs = path.join(dir, "definitions", "clamav");
  await fs.mkdir(defs, { recursive: true });
  await fs.writeFile(path.join(defs, "main.cvd"), "x");
  await fs.writeFile(path.join(defs, "daily.cld"), "x");
  return new ClamavBridge({
    definitionsDir: path.join(dir, "definitions"),
    spawn,
    scanTimeoutMs: 1_000,
    ...extra,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("TASK F — A) 5 ficheiros benignos", () => {
  it("cinco benignos => cinco clean, um spawn, peak 1", async () => {
    const dir = await tmpDir();
    const files = await makeFiles(dir, 5);
    const { spawn, calls } = fakeSpawn(SUMMARY(0, 0, 5), "", 0);
    const bridge = await bridgeWith(spawn);

    const batch = await bridge.scanFiles(files);
    await bridge.dispose();

    assert.equal(batch.files.length, 5, "um resultado por ficheiro pedido");
    assert.equal(batch.files.filter((f) => f.verdict === "clean").length, 5);
    assert.equal(batch.errorCount, 0);
    assert.equal(batch.detected, false);
    assert.equal(calls.count, 1, "UM spawn para o batch");
    assert.equal(calls.peak, 1);
  });

  it("cada resultado pertence ao path que pedimos, pela ordem que pedimos", async () => {
    const dir = await tmpDir();
    const files = await makeFiles(dir, 5);
    const { spawn } = fakeSpawn(SUMMARY(0, 0, 5), "", 0);
    const bridge = await bridgeWith(spawn);

    const batch = await bridge.scanFiles(files);
    await bridge.dispose();

    assert.deepEqual(
      batch.files.map((f) => f.file),
      files,
      "a ordem e o path de cada resultado tem de ser o que pedimos",
    );
  });
});

describe("TASK F — B) 20 ficheiros benignos", () => {
  it("vinte benignos => vinte clean, um spawn, peak 1", async () => {
    const dir = await tmpDir();
    const files = await makeFiles(dir, 20);
    const { spawn, calls } = fakeSpawn(SUMMARY(0, 0, 20), "", 0);
    const bridge = await bridgeWith(spawn);

    const batch = await bridge.scanFiles(files);
    await bridge.dispose();

    assert.equal(batch.files.length, 20);
    assert.equal(batch.files.filter((f) => f.verdict === "clean").length, 20);
    assert.equal(calls.count, 1, "vinte ficheiros, UM spawn");
    assert.equal(calls.peak, 1);
  });
});

describe("TASK F — C) deteção numa posição intermédia", () => {
  it("uma deteção no meio de 10 só marca o ficheiro certo", async () => {
    const dir = await tmpDir();
    const files = await makeFiles(dir, 10);
    const alvo = files[4]; // meio, nem primeiro nem ultimo
    const stdout = `${alvo}: Eicar-Test-Signature FOUND\n${SUMMARY(1, 0, 10)}`;
    const { spawn } = fakeSpawn(stdout, "", 1);
    const bridge = await bridgeWith(spawn);

    const batch = await bridge.scanFiles(files);
    await bridge.dispose();

    const detectado = batch.files.filter((f) => f.verdict === "detected");
    assert.equal(detectado.length, 1, "exactamente um ficheiro detectado");
    assert.equal(detectado[0].file, alvo, "e o ficheiro do MEIO, nao o primeiro nem o ultimo");
    assert.equal(detectado[0].signature, "Eicar-Test-Signature");
    assert.equal(batch.files.filter((f) => f.verdict === "clean").length, 9);
    assert.equal(batch.detected, true);
  });

  it("uma deteção no meio NAO marca os vizinhos", async () => {
    const dir = await tmpDir();
    const files = await makeFiles(dir, 10);
    const alvo = files[7];
    const stdout = `${alvo}: Win.Test.EICAR_HDB-1 FOUND\n${SUMMARY(1, 0, 10)}`;
    const { spawn } = fakeSpawn(stdout, "", 1);
    const bridge = await bridgeWith(spawn);

    const batch = await bridge.scanFiles(files);
    await bridge.dispose();

    for (const f of batch.files) {
      if (f.file === alvo) assert.equal(f.verdict, "detected");
      else assert.equal(f.verdict, "clean", `${f.file} nao pode ser clean se foi o alvo`);
    }
  });
});

describe("TASK F — D) erro num ficheiro", () => {
  it("um ERROR num ficheiro NAO torna o batch inteiro CLEAN nem ERROR", async () => {
    const dir = await tmpDir();
    const files = await makeFiles(dir, 5);
    const mau = files[2];
    const stdout = SUMMARY(0, 1, 4); // 4 varridos, 1 erro
    const stderr = `WARNING: Can't open file ${mau}: 225\n`;
    const { spawn } = fakeSpawn(stdout, stderr, 2);
    const bridge = await bridgeWith(spawn);

    const batch = await bridge.scanFiles(files);
    await bridge.dispose();

    const doErro = batch.files.find((f) => f.file === mau);
    assert.equal(doErro.verdict, "error", "o ficheiro ilegivel e error");
    assert.equal(
      batch.files.filter((f) => f.verdict === "clean").length,
      4,
      "os outros quatro continuam clean — o erro nao alarga",
    );
    assert.equal(batch.errorCount, 1);
  });

  it("a deteção SOBREVIVE ao erro de outro ficheiro (deteção + erro juntos)", async () => {
    const dir = await tmpDir();
    const files = await makeFiles(dir, 6);
    const infectado = files[1];
    const ilegivel = files[4];
    const stdout = `${infectado}: Eicar-Sig FOUND\n${SUMMARY(1, 1, 5)}\n`;
    const stderr = `WARNING: Can't open file ${ilegivel}: Permission denied\n`;
    const { spawn } = fakeSpawn(stdout, stderr, 2);
    const bridge = await bridgeWith(spawn);

    const batch = await bridge.scanFiles(files);
    await bridge.dispose();

    assert.equal(
      batch.files.find((f) => f.file === infectado).verdict,
      "detected",
      "a deteccao tem de sobreviver ao erro de um vizinho",
    );
    assert.equal(batch.files.find((f) => f.file === ilegivel).verdict, "error");
    assert.equal(batch.detected, true);
  });

  it("um ficheiro removido durante o scan e ERROR com 'removido', nunca clean", async () => {
    const dir = await tmpDir();
    const files = await makeFiles(dir, 3);
    const removido = files[1];
    await fs.rm(removido); // desaparece entre o pedido e o clamscan
    const stdout = SUMMARY(0, 1, 2);
    const stderr = `WARNING: Can't open file ${removido}: 225\n`;
    const { spawn } = fakeSpawn(stdout, stderr, 2);
    const bridge = await bridgeWith(spawn);

    const batch = await bridge.scanFiles(files);
    await bridge.dispose();

    const f = batch.files.find((x) => x.file === removido);
    assert.equal(f.verdict, "error");
    assert.equal(f.removedDuringScan, true, "o facto e 'deixou de existir', sem atribuir a ninguem");
    assert.doesNotMatch(
      f.detail ?? "",
      /defender/i,
      "sem evidencia, nao se menciona o Defender",
    );
  });
});

describe("TASK F — E) path com espaços", () => {
  it("um path com espaços é clean e pertence ao path certo", async () => {
    const dir = await tmpDir();
    const nome = "ficheiro com muitos espacos no nome.txt";
    const p = path.join(dir, nome);
    await fs.writeFile(p, "benigno", "utf8");
    const { spawn } = fakeSpawn(SUMMARY(0, 0, 1), "", 0);
    const bridge = await bridgeWith(spawn);

    const batch = await bridge.scanFiles([p]);
    await bridge.dispose();

    assert.equal(batch.files[0].file, p);
    assert.equal(batch.files[0].verdict, "clean");
  });

  it("um path com espaços DETECTADO é atribuido ao path certo", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "relatório anual com espaços.txt");
    await fs.writeFile(p, "x", "utf8");
    const stdout = `${p}: Eicar-Sig FOUND\n${SUMMARY(1, 0, 1)}`;
    const { spawn } = fakeSpawn(stdout, "", 1);
    const bridge = await bridgeWith(spawn);

    const batch = await bridge.scanFiles([p]);
    await bridge.dispose();

    assert.equal(batch.files[0].verdict, "detected");
    assert.equal(batch.files[0].file, p, "o path completo, com espacos, e devolvido intacto");
  });

  it("um path com espaços ERRO é atribuido ao path certo", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "não pôde abrir isto.txt");
    const stdout = SUMMARY(0, 1, 0);
    const stderr = `WARNING: Can't open file ${p}: 225\n`;
    const { spawn } = fakeSpawn(stdout, stderr, 2);
    const bridge = await bridgeWith(spawn);

    const batch = await bridge.scanFiles([p]);
    await bridge.dispose();

    assert.equal(batch.files[0].verdict, "error");
    assert.equal(batch.files[0].file, p);
  });
});

describe("TASK F — F) path unicode", () => {
  it("caminhos unicode (CJK, cirilico, acentos, emoji) fazem parse sem deteccao", async () => {
    const dir = await tmpDir();
    const paths = [
      path.join(dir, "文書.txt"),
      path.join(dir, "файл.txt"),
      path.join(dir, "acentuação-çã.txt"),
      path.join(dir, "emoji-🔒.txt"),
    ];
    for (const p of paths) await fs.writeFile(p, "benigno", "utf8");
    const { spawn } = fakeSpawn(SUMMARY(0, 0, 4), "", 0);
    const bridge = await bridgeWith(spawn);

    const batch = await bridge.scanFiles(paths);
    await bridge.dispose();

    assert.deepEqual(batch.files.map((f) => f.file), paths);
    assert.equal(batch.files.filter((f) => f.verdict === "clean").length, 4);
  });

  it("uma deteção num path unicode é atribuída ao path certo", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "契約-重要-🔒.txt");
    await fs.writeFile(p, "x", "utf8");
    const stdout = `${p}: Eicar-Sig FOUND\n${SUMMARY(1, 0, 1)}`;
    const { spawn } = fakeSpawn(stdout, "", 1);
    const bridge = await bridgeWith(spawn);

    const batch = await bridge.scanFiles([p]);
    await bridge.dispose();

    assert.equal(batch.files[0].verdict, "detected");
    assert.equal(batch.files[0].file, p);
  });

  it("o parser não parte o path no ':' do Windows (C:\\\\)", async () => {
    // Regressão do separador: uma regex preguiçosa partia `C:\` e atribuía a
    // deteção ao ficheiro errado — pior do que não atribuir.
    const out = parseClamavOutput({
      files: ["C:\\Users\\test\\ficheiro.txt"],
      stdout: "C:\\Users\\test\\ficheiro.txt: Eicar-Sig FOUND\n",
      stderr: "",
      code: 1,
      fileExists: () => true,
    });
    assert.equal(out.files[0].verdict, "detected");
    assert.equal(out.files[0].file, "C:\\Users\\test\\ficheiro.txt");
  });
});

describe("TASK F — G) cancelamento", () => {
  it("cancelar durante o batch mata a arvore e NAO devolve clean", async () => {
    const dir = await tmpDir();
    const files = await makeFiles(dir, 5);
    const { spawn, calls } = fakeSpawn("", "", null, { hang: true });
    const bridge = await bridgeWith(spawn);

    const controller = new AbortController();
    const promise = bridge.scanFiles(files, { signal: controller.signal });
    await waitForSpawn(calls);
    controller.abort();

    const batch = await promise;
    await bridge.dispose();

    assert.equal(calls.killed, 1, "a arvore foi morta uma vez");
    assert.equal(batch.files.every((f) => f.verdict === "error"), true,
      "um batch cancelado NAO devolve clean — nada foi avaliado");
    assert.equal(calls.peak, 1, "peak 1, mesmo com o cancelamento");
  });

  it("cancelar um batch NAO afeta o batch seguinte", async () => {
    const dir = await tmpDir();
    const files = await makeFiles(dir, 5);
    // O primeiro clamscan fica pendurado; o segundo responde limpo.
    let call = 0;
    const state = { count: 0 };
    const spawn = () => {
      call++;
      state.count++;
      let resolveOutcome;
      const outcome = new Promise((r) => {
        resolveOutcome = r;
      });
      if (call === 1) {
        return {
          pid: 20001,
          killTree: () => resolveOutcome({ code: null, stdout: "", stderr: "", killed: true }),
          outcome,
        };
      }
      queueMicrotask(() =>
        resolveOutcome({ code: 0, stdout: SUMMARY(0, 0, 5), stderr: "", timedOut: false, killed: false }),
      );
      return { pid: 20002, killTree: () => {}, outcome };
    };
    const bridge = await bridgeWith(spawn);

    const c1 = new AbortController();
    const primeiro = bridge.scanFiles(files, { signal: c1.signal });
    await waitForSpawn(state);
    c1.abort();
    const batch1 = await primeiro;
    assert.equal(batch1.files.every((f) => f.verdict === "error"), true);

    // O segundo batch tem de correr normally, apesar do cancelamento do primeiro.
    const batch2 = await bridge.scanFiles(files);
    await bridge.dispose();

    assert.equal(batch2.files.filter((f) => f.verdict === "clean").length, 5,
      "o cancelamento de A nao contaminou B");
  });
});

describe("TASK F — H) timeout", () => {
  it("timeout mata a arvore e nenhum ficheiro sai clean", async () => {
    const dir = await tmpDir();
    const files = await makeFiles(dir, 5);
    const { spawn, calls } = fakeSpawn("", "", null, { hang: true });
    const bridge = new ClamavBridge({
      spawn,
      databaseDir: os.homedir(),
      probe: async () => true,
      scanTimeoutMs: 120, // orcamento por ficheiro -> 600 ms para 5
    });

    const batch = await bridge.scanFiles(files);
    await bridge.dispose();

    assert.ok(calls.killed >= 1, "o deadline matou a arvore");
    assert.equal(batch.files.every((f) => f.verdict === "error"), true,
      "um batch que expirou NAO pode devolver clean");
  });

  it("o orcamento de timeout cresce com N (nao e um tecto fixo)", async () => {
    const dir = await tmpDir();
    const files = await makeFiles(dir, 20);
    let receivedTimeout = 0;
    const spawn = (_f, _a, request) => {
      receivedTimeout = request.timeoutMs;
      let resolveOutcome;
      const outcome = new Promise((r) => {
        resolveOutcome = r;
      });
      queueMicrotask(() =>
        resolveOutcome({ code: 0, stdout: SUMMARY(0, 0, 20), stderr: "", timedOut: false, killed: false }),
      );
      return { pid: 30001, killTree: () => {}, outcome };
    };
    const bridge = new ClamavBridge({
      spawn,
      databaseDir: os.homedir(),
      probe: async () => true,
      scanTimeoutMs: 5_000,
    });
    await bridge.scanFiles(files);
    await bridge.dispose();

    assert.equal(receivedTimeout, 100_000, "20 x 5 s = 100 s, nao 5 s");
  });
});

describe("TASK F — I) shutdown", () => {
  it("dispose() mata os clamscan vivos e espera pelo fim real", async () => {
    const dir = await tmpDir();
    const files = await makeFiles(dir, 5);
    const { spawn, calls } = fakeSpawn("", "", null, { hang: true });
    const bridge = await bridgeWith(spawn);

    const promise = bridge.scanFiles(files);
    await waitForSpawn(calls);
    await bridge.dispose();
    const batch = await promise;

    assert.ok(calls.killed >= 1, "dispose matou a arvore");
    assert.equal(batch.files.every((f) => f.verdict === "error"), true);
  });

  it("depois de dispose(), um novo pedido NAO arranca processo", async () => {
    const dir = await tmpDir();
    const files = await makeFiles(dir, 5);
    const { spawn, calls } = fakeSpawn(SUMMARY(0, 0, 5), "", 0);
    const bridge = await bridgeWith(spawn);
    await bridge.dispose();

    const batch = await bridge.scanFiles(files);

    assert.equal(calls.count, 0, "um bridge descartado nao ressuscita o motor");
    assert.equal(batch.files.every((f) => f.verdict === "error"), true);
    assert.equal(batch.status.status, "unavailable");
  });
});
