/**
 * TP-UNIFY-ENGINES — contratos de motor integrados na cópia local fiel.
 *
 * Estes testes são determinísticos e não usam binários reais:
 *  - o descriptor do cabeçalho fecha em sucesso e em falha de leitura;
 *  - uma exceção do ClamAV vira lacuna (nunca `safe`) e não apaga uma deteção
 *    YARA já obtida;
 *  - um sinal abortado não pode terminar como `safe`;
 *  - `Heuristics.Limits.Exceeded.*` é lacuna, não deteção nem `clean`.
 *
 * O fixture vive só em `os.tmpdir()`. Nenhum ficheiro pessoal, rede ou scan.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { ClamavBridge, MalwareAnalyzer, SignatureDatabase, TrustEngine, parseClamavOutput } from "../dist/index.js";

let dir;
let file;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-unify-engines-"));
  file = path.join(dir, "fixture-benigna.txt");
  await fs.writeFile(file, "conteudo benigno descartavel");
});

after(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const yaraClean = { scanFile: async () => [] };
const clamClean = { scanFile: async () => ({ detected: false, verdict: "clean" }) };

function analyzer(overrides = {}) {
  return new MalwareAnalyzer({
    signatures: new SignatureDatabase(),
    trust: new TrustEngine(),
    yara: yaraClean,
    ...overrides,
  });
}

/**
 * O produto abre o handle com `fs.open`; o patch do protótipo apanha esse
 * handle. O `close` embrulhado conta as chamadas do produto, mas o cleanup
 * usa o `close` original para não transformar um RED em verde.
 */
async function withReadPatch(readImpl, run) {
  const seed = await fs.open(file, "r");
  const proto = Object.getPrototypeOf(seed);
  await seed.close();

  const originalRead = proto.read;
  const state = { closeCalls: 0, handle: undefined, originalClose: undefined };

  proto.read = async function (...args) {
    state.handle = this;
    const boundClose = this.close.bind(this);
    state.originalClose = boundClose;
    this.close = async (...closeArgs) => {
      state.closeCalls++;
      return boundClose(...closeArgs);
    };
    return readImpl(this, args, originalRead);
  };

  try {
    return { value: await run(), state };
  } finally {
    proto.read = originalRead;
    if (state.handle && state.handle.fd >= 0 && state.originalClose) {
      await state.originalClose().catch(() => {});
    }
  }
}

describe("analysis.ts — descriptor do cabeçalho", () => {
  it("falha de leitura rejeita, mas fecha o handle exatamente uma vez", async () => {
    const { state } = await withReadPatch(
      async () => {
        throw new Error("EIO simulado na leitura do cabeçalho");
      },
      async () => {
        await assert.rejects(
          analyzer().analyze(file),
          /EIO simulado na leitura do cabeçalho/,
        );
      },
    );

    assert.equal(state.closeCalls, 1);
    assert.equal(state.handle.fd < 0, true, "o descriptor tem de ficar fechado");
  });

  it("leitura com sucesso fecha o handle exatamente uma vez", async () => {
    const { value, state } = await withReadPatch(
      async (handle, args, originalRead) => originalRead.apply(handle, args),
      () => analyzer().analyze(file),
    );

    assert.ok(value, "a análise tem de resolver");
    assert.equal(state.closeCalls, 1);
  });
});

describe("analysis.ts — falhas de motor", () => {
  it("exceção do ClamAV vira inconclusivo e nomeia a lacuna", async () => {
    const result = await analyzer({
      clamav: {
        scanFile: async () => {
          throw new Error("spawn ENOENT simulado");
        },
      },
    }).analyze(file);

    assert.equal(result.verdict, "inconclusive");
    assert.ok(result.rulesTriggered.includes("scan_inconclusive"));
    const factor = result.factors.find((f) => f.id === "clamav-inconclusive");
    assert.ok(factor, "a lacuna tem de aparecer nos fatores");
    assert.equal(
      factor.label,
      "O motor antivírus não conseguiu avaliar este ficheiro.",
    );
    assert.ok(result.confidence <= 0.3);
  });

  it("exceção do ClamAV não apaga uma deteção YARA forte", async () => {
    const result = await analyzer({
      yara: {
        scanFile: async () => [
          { ruleId: "Synthetic_Strong", label: "Synthetic_Strong", severity: "critical", evidence: "strong" },
        ],
      },
      clamav: {
        scanFile: async () => {
          throw new Error("spawn ENOENT simulado");
        },
      },
    }).analyze(file);

    assert.equal(result.verdict, "malicious");
    assert.ok(result.rulesTriggered.includes("yara_match"));
    assert.ok(result.rulesTriggered.includes("scan_inconclusive"));
  });

  it("um sinal abortado nunca termina como safe", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await analyzer({ clamav: clamClean }).analyze(
      file,
      undefined,
      undefined,
      { signal: controller.signal },
    );

    assert.notEqual(result.verdict, "safe");
    assert.equal(result.verdict, "inconclusive");
    assert.ok(result.factors.some((f) => f.id === "scan-cancelled"));
  });
});

describe("clamav.ts — limites internos", () => {
  it("Heuristics.Limits.Exceeded não é deteção nem clean", () => {
    const summary = [
      `${file}: Heuristics.Limits.Exceeded.MaxFileSize FOUND`,
      "",
      "----------- SCAN SUMMARY -----------",
      "Known viruses: 1",
      "Scanned directories: 0",
      "Scanned files: 0",
      "Infected files: 1",
      "Total errors: 0",
    ].join("\n");

    const outcome = parseClamavOutput({
      files: [file],
      stdout: summary,
      stderr: "",
      code: 1,
      fileExists: () => true,
    });

    const entry = outcome.files[0];
    assert.equal(entry.verdict, "error");
    assert.equal(entry.reason, "limits-exceeded");
    assert.notEqual(entry.verdict, "detected");
    assert.equal(outcome.detected, false);
  });

  it("um OK real continua clean", () => {
    const summary = [
      `${file}: OK`,
      "",
      "----------- SCAN SUMMARY -----------",
      "Known viruses: 1",
      "Scanned directories: 0",
      "Scanned files: 1",
      "Infected files: 0",
      "Total errors: 0",
    ].join("\n");

    const outcome = parseClamavOutput({
      files: [file],
      stdout: summary,
      stderr: "",
      code: 0,
      fileExists: () => true,
    });

    assert.equal(outcome.files[0].verdict, "clean");
  });
});

/**
 * TP-UNIFIED-SCAN-RUNTIME: o batch REAL tem de pedir ao clamscan para
 * sinalizar limites excedidos. Sem `--alert-exceeds-max=yes`, um ficheiro
 * acima dos limites internos sai `: OK` e seria publicado como limpo —
 * falso-limpo medido com ClamAV 1.5.4 real.
 */
function recordingSpawner(stdoutFor) {
  const calls = [];
  const spawn = (_file, args) => {
    calls.push(args);
    let resolveOutcome;
    let dead = false;
    const finish = (outcome) => { if (!dead) { dead = true; resolveOutcome(outcome); } };
    const handle = {
      pid: 41000 + calls.length,
      killTree() { finish({ code: null, stderr: "", timedOut: false, killed: true }); },
      outcome: new Promise((resolve) => { resolveOutcome = resolve; }),
    };
    handle.stdout = new EventEmitter();
    handle.stderr = new EventEmitter();
    setTimeout(() => {
      if (dead) return;
      const lines = stdoutFor(args);
      for (const line of lines) handle.stdout.emit("data", Buffer.from(line + "\n", "utf8"));
      finish({ code: 0, stdout: lines.join("\n") + "\n", stderr: "", timedOut: false, killed: false });
    }, 5);
    return handle;
  };
  return { spawn, calls };
}

describe("clamav.ts — limites sinalizados no argv do batch", () => {
  it("o argv inclui --alert-exceeds-max=yes e a base explicita", async () => {
    const defs = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-unify-defs-"));
    const defsClamav = path.join(defs, "clamav");
    await fs.mkdir(defsClamav, { recursive: true });
    await fs.writeFile(path.join(defsClamav, "main.cvd"), "x");
    await fs.writeFile(path.join(defsClamav, "daily.cld"), "x");
    try {
      const fake = recordingSpawner(() => [`${file}: OK`]);
      const bridge = new ClamavBridge({ definitionsDir: defs, spawn: fake.spawn, scanTimeoutMs: 30_000 });
      await bridge.scanFiles([file]);

      assert.equal(fake.calls.length, 1, "uma invocacao por batch");
      const args = fake.calls[0];
      assert.ok(args.includes("--alert-exceeds-max=yes"), "sem a flag o ficheiro >limite sai OK (falso-limpo)");
      assert.ok(args.some((a) => a.startsWith("--database=")), "com definitionsDir a base tem de ser explicita");
    } finally {
      await fs.rm(defs, { recursive: true, force: true }).catch(() => {});
    }
  });
});
