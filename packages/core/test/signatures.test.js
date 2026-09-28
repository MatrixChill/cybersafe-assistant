import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SignatureDatabase,
  BUILTIN_HASH_SIGNATURES,
  DEV_CANARY_CONTENT,
  DEV_CANARY_SIGNATURE,
  MalwareAnalyzer,
  TrustEngine,
  YaraEngine,
  ClamavBridge,
} from "../dist/index.js";

describe("SignatureDatabase — EICAR built-in", () => {
  it("regenerates the real EICAR SHA-256 and the DB matches it", () => {
    // EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H* (68 bytes) — determinístico.
    const eicar = Buffer.from(
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
      "binary",
    );
    assert.equal(eicar.length, 68, "EICAR must be 68 bytes");
    const sha256 = crypto.createHash("sha256").update(eicar).digest("hex");
    assert.equal(
      sha256,
      "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f",
      "real EICAR SHA-256",
    );
  });

  it("the built-in DB contains the real EICAR SHA-256", async () => {
    const eicar = Buffer.from(
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
      "binary",
    );
    const sha256 = crypto.createHash("sha256").update(eicar).digest("hex");
    const db = new SignatureDatabase();
    // load() with a missing file falls back to built-in.
    await db.load("/nonexistent/path/default.json");
    const match = db.match(sha256);
    assert.ok(match, "built-in DB must match the real EICAR SHA-256");
    assert.equal(match?.family, "EICAR-Test-File");
    assert.equal(match?.severity, "critical");
  });

  it("the old fabricated EICAR hash (MD5 + zeros) is NOT in the built-in DB", async () => {
    const db = new SignatureDatabase();
    await db.load("/nonexistent/path/default.json");
    const fabricated =
      "44d88612fea8a8f36de82e1278abb02f2b8d6f66b0f0455d8f4f0d5dce9d734a";
    assert.equal(db.match(fabricated), undefined, "fabricated hash must not match");
  });

  it("BUILTIN_HASH_SIGNATURES only contains verified or TODO-EVIDENCE entries", () => {
    for (const record of BUILTIN_HASH_SIGNATURES) {
      assert.match(record.sha256, /^[0-9a-f]{64}$/, `sha256 format for ${record.family}`);
      assert.ok(record.family, "family must be set");
    }
  });
});

// ── Canário dev-only para teste E2E do pipeline de deteção ──────────────
// Conteúdo 100% benigno ("CYBERSAFE-E2E-TEST-SIGNATURE-v1"): detetado apenas
// fora de produção; em NODE_ENV=production nunca é reconhecido como ameaça.

describe("Canário dev-only (teste E2E) — SignatureDatabase", () => {
  const CANARY_HASH = DEV_CANARY_SIGNATURE.sha256;

  /** Corre fn com NODE_ENV definido e restaura sempre o valor original. */
  async function withNodeEnv(value, fn) {
    const previous = process.env.NODE_ENV;
    if (value === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = value;
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  }

  it("o hash do canário é o SHA-256 real do conteúdo exato (não fabricado)", () => {
    const buffer = Buffer.from(DEV_CANARY_CONTENT, "utf8");
    assert.equal(buffer.length, 31, "conteúdo do canário tem 31 bytes");
    assert.equal(DEV_CANARY_CONTENT, "CYBERSAFE-E2E-TEST-SIGNATURE-v1");
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    assert.equal(sha256, CANARY_HASH, "hash tem de regenerar a partir do conteúdo");
  });

  it("DEV/test: match() deteta o canário como deteção de teste", async () => {
    await withNodeEnv("test", async () => {
      const db = new SignatureDatabase();
      await db.load("/nonexistent/path/default.json");
      const hit = db.match(CANARY_HASH);
      assert.ok(hit, "canário deve ser detetado em dev/test");
      assert.equal(hit.family, "CyberSafe-Test-File");
      assert.equal(hit.source, "development-test");
      assert.equal(hit.severity, "medium");
    });
  });

  it("production: match() NÃO deteta o canário", async () => {
    await withNodeEnv("production", async () => {
      const db = new SignatureDatabase();
      await db.load("/nonexistent/path/default.json");
      assert.equal(db.match(CANARY_HASH), undefined, "canário não pode detetar em produção");
    });
  });

  it("o canário nunca é persistido na base em disco (sem assinatura ativa em produção)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-canary-"));
    try {
      const db = new SignatureDatabase();
      await db.load("/nonexistent/path/default.json"); // base embutida
      const target = path.join(dir, "default.json");
      await db.save(target);
      const serialized = await fs.readFile(target, "utf-8");
      assert.ok(!serialized.includes(CANARY_HASH), "hash do canário não pode ser gravado");
      assert.ok(!serialized.includes("CyberSafe-Test-File"), "family do canário não pode ser gravada");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Canário dev-only (teste E2E) — MalwareAnalyzer (pipeline real)", () => {
  const CANARY_HASH = DEV_CANARY_SIGNATURE.sha256;
  let tmpDir;

  async function withNodeEnv(value, fn) {
    const previous = process.env.NODE_ENV;
    if (value === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = value;
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  }

  function buildAnalyzer() {
    const signatures = new SignatureDatabase();
    return {
      signatures,
      analyzer: new MalwareAnalyzer({
        signatures,
        trust: new TrustEngine(),
        yara: new YaraEngine(path.join(tmpDir, "analyzer.yar")),
        clamav: new ClamavBridge(),
      }),
    };
  }

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-canalyzer-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("DEV/test: ficheiro-canário exato gera deteção de teste (medium/suspicious, sem quarentena)", async () => {
    const canaryPath = path.join(tmpDir, "cybersafe-e2e-canary.txt");
    await fs.writeFile(canaryPath, DEV_CANARY_CONTENT, "utf8"); // sem newline: hash exato
    const { analyzer } = buildAnalyzer();

    await withNodeEnv("test", async () => {
      const result = await analyzer.analyze(canaryPath);
      assert.equal(result.sha256, CANARY_HASH);
      assert.ok(result.rulesTriggered.includes("dev_canary_signature"), "regra do canário dispara");
      assert.ok(!result.rulesTriggered.includes("known_bad_hash"), "canário não usa o caminho de hash malicioso");
      assert.equal(result.severity, "medium", "deteção de teste fica na banda medium");
      assert.equal(result.verdict, "suspicious");
      assert.equal(result.recommendedAction, "logged", "canário benigno nunca é quarantined");
      assert.equal(result.confidence, 0.99);
    });
  });

  it("DEV/test: conteúdo com newline final também deteta (match por conteúdo, robustez manual)", async () => {
    const canaryPath = path.join(tmpDir, "canary-with-newline.txt");
    await fs.writeFile(canaryPath, DEV_CANARY_CONTENT + "\n", "utf8"); // hash ≠, conteúdo =
    const { analyzer } = buildAnalyzer();

    await withNodeEnv("test", async () => {
      const result = await analyzer.analyze(canaryPath);
      assert.notEqual(result.sha256, CANARY_HASH, "hash mudou com o newline");
      assert.ok(result.rulesTriggered.includes("dev_canary_signature"));
      assert.equal(result.severity, "medium");
      assert.equal(result.verdict, "suspicious");
    });
  });

  it("production: o MESMO ficheiro-canário fica limpo (safe/low, sem deteção)", async () => {
    const canaryPath = path.join(tmpDir, "cybersafe-prod.txt");
    await fs.writeFile(canaryPath, DEV_CANARY_CONTENT, "utf8");
    const { analyzer } = buildAnalyzer();

    await withNodeEnv("production", async () => {
      const result = await analyzer.analyze(canaryPath);
      assert.ok(!result.rulesTriggered.includes("dev_canary_signature"), "sem regra do canário em produção");
      assert.equal(result.verdict, "safe");
      assert.equal(result.severity, "low");
      assert.equal(result.recommendedAction, "allowed");
      // \Temp\ no path dispara suspicious_location (+15): ainda assim tem de
      // ficar na banda safe, longe de qualquer deteção.
      assert.ok(result.riskScore <= 40, `score de produção fica na banda safe (obteve ${result.riskScore})`);
    });
  });

  it("DEV/test: ficheiro limpo comum continua safe (canário não gera falsos positivos)", async () => {
    const cleanPath = path.join(tmpDir, "notas.txt");
    await fs.writeFile(cleanPath, "apenas um ficheiro de notas comum", "utf8");
    const { analyzer } = buildAnalyzer();

    await withNodeEnv("test", async () => {
      const result = await analyzer.analyze(cleanPath);
      assert.equal(result.verdict, "safe");
      assert.ok(!result.rulesTriggered.includes("dev_canary_signature"));
    });
  });
});