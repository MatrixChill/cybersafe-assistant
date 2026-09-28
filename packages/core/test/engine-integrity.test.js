import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ClamavBridge,
  classifyClamavHealth,
  MalwareAnalyzer,
  SignatureDatabase,
  TrustEngine,
  YaraEngine,
  effectiveRiskScore,
  engineIsDegraded,
  scoreToStatus,
} from "../dist/index.js";

const EICAR_BUFFER = Buffer.from(
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
  "utf8",
);
const EICAR_HASH = "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f";

const EICAR_RULE = `
rule eicar
{
  strings:
    $s1 = "X5O!P%@AP[4\\\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*" fullword ascii
  condition:
    all of them
}
`;

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-integrity-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("YARA engine integrity", () => {
  test("carrega um ficheiro de regras válido como ativo e deteta EICAR", async () => {
    const rulesPath = path.join(tmpDir, "valid.yar");
    await fs.writeFile(rulesPath, EICAR_RULE, "utf-8");
    const eicarPath = path.join(tmpDir, "eicar.bin");
    await fs.writeFile(eicarPath, EICAR_BUFFER, "utf-8");

    const engine = new YaraEngine(rulesPath);
    await engine.load(rulesPath);

    assert.equal(engine.health.status, "active");
    assert.equal(engine.isAvailable, true);
    assert.equal(engine.ruleCount, 1);

    const matches = await engine.scanFile(eicarPath);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].ruleId, "eicar");

    const bufferMatches = engine.match(EICAR_BUFFER);
    assert.equal(bufferMatches.length, 1);
    assert.equal(bufferMatches[0].ruleId, "eicar");
  });

  test("ficheiro corrompido (JSON) reporta degradado e usou fallback, nunca falha em silêncio", async () => {
    const badPath = path.join(tmpDir, "corrupt.json");
    await fs.writeFile(badPath, '[{"sha256":"404-not-found"}]', "utf-8");

    const engine = new YaraEngine(badPath);
    await engine.load(badPath);

    assert.equal(engine.health.status, "degraded");
    assert.equal(engine.isAvailable, true, "fallback mantém scanner funcional");

    const onDisk = await fs.readFile(badPath, "utf-8");
    assert.ok(onDisk.includes("Basic_Suspicious_Check"), "fallback deve ser escrito ao disco");

    const hit = engine.match(Buffer.from("nvoking powershell.exe"));
    assert.ok(hit.length >= 0);
    assert.equal(typeof engine.health.detail, "string");
    assert.match(engine.health.detail ?? "", /fallback/i);
  });

  test("conteúdo HTML corrupto também é tratado como degradado", async () => {
    const htmlPath = path.join(tmpDir, "html.yar");
    await fs.writeFile(htmlPath, "<!DOCTYPE html><html><body>404: Not Found</body></html>", "utf-8");

    const engine = new YaraEngine(htmlPath);
    await engine.load(htmlPath);

    assert.equal(engine.health.status, "degraded");
    assert.equal(engine.isAvailable, true);
  });

  test("ficheiro de regras inexistente recupera com built-in (degraded, não error)", async () => {
    const missingPath = path.join(tmpDir, "definitely-missing.yar");
    const engine = new YaraEngine(missingPath);
    await engine.load(missingPath);

    assert.equal(engine.health.status, "degraded");
    assert.equal(engine.isAvailable, true);
    const exists = await fs.access(missingPath).then(() => true, () => false);
    assert.equal(exists, true);
  });

  test("scan de conteúdo limpo não produz falsos positivos", async () => {
    const rulesPath = path.join(tmpDir, "eicar-only.yar");
    await fs.writeFile(rulesPath, EICAR_RULE, "utf-8");

    const cleanPath = path.join(tmpDir, "clean.txt");
    await fs.writeFile(cleanPath, "hello world, nothing suspicious here", "utf-8");

    const engine = new YaraEngine(rulesPath);
    await engine.load(rulesPath);
    const matches = await engine.scanFile(cleanPath);

    assert.equal(matches.length, 0);
  });
});

describe("Hash DB integrity", () => {
  test("base local encontra um hash de teste carregado de ficheiro", async () => {
    const dbPath = path.join(tmpDir, "hashes.json");
    await fs.writeFile(
      dbPath,
      JSON.stringify([
        { sha256: "abcdef", family: "TestFamily", severity: "high", source: "test" },
        { sha256: EICAR_HASH, family: "EICAR-Test-File", severity: "critical", source: "test" },
      ]),
      "utf-8",
    );

    const db = new SignatureDatabase();
    await db.load(dbPath);

    assert.equal(db.health.status, "active");
    assert.equal(db.size, 2);
    const hit = db.match(EICAR_HASH);
    assert.ok(hit);
    assert.equal(hit.family, "EICAR-Test-File");
  });

  test("feed remoto indisponível não quebra proteção local (built-in offline)", async () => {
    const db = new SignatureDatabase();
    await db.load(path.join(tmpDir, "no-such-feed", "default.json"));

    assert.equal(db.health.status, "degraded");
    assert.equal(db.size, 4, "base embutida deve estar disponível offline");
    const eicar = db.match(EICAR_HASH);
    assert.ok(eicar);
    assert.equal(eicar.family, "EICAR-Test-File");
  });

  test("ficheiro de hashes corrompido recorre à base embutida", async () => {
    const dbPath = path.join(tmpDir, "corrupt-hashes.json");
    await fs.writeFile(dbPath, "{not-json", "utf-8");

    const db = new SignatureDatabase();
    await db.load(dbPath);

    assert.equal(db.health.status, "degraded");
    assert.ok(db.match(EICAR_HASH));
  });

  test("ensureFile sementeia a base embutida e passa a ativa", async () => {
    const db = new SignatureDatabase();
    await db.load(path.join(tmpDir, "empty-ish.json"));
    const target = path.join(tmpDir, "seeded.json");
    await db.ensureFile(target);

    const exists = await fs.access(target).then(() => true, () => false);
    assert.equal(exists, true);
    assert.equal(db.health.status, "active");
  });
});

describe("ClamAV integrity", () => {
  test("ClamAV não-disponível ⇒ unavailable/degraded com diagnóstico, nunca ativo", async () => {
    const bridge = new ClamavBridge();
    const available = await bridge.isAvailable();

    if (available) {
      assert.equal(bridge.health.status, "active");
      assert.notEqual(bridge.health.detail, "Not checked", "o probe tem de correr de facto");
    } else {
      // unavailable = binário ausente; degraded = binário OK SEM base de
      // assinaturas (Workstream C: sem .cvd/.cld não há deteção real).
      assert.ok(
        ["unavailable", "degraded"].includes(bridge.health.status),
        `estado inesperado: ${bridge.health.status}`,
      );
      assert.notEqual(bridge.health.detail, "Not checked");
      const res = await bridge.scanFile(import.meta.filename);
      assert.equal(res.detected, false, "motor indisponível nunca simula proteção");
      assert.equal(res.status.status, bridge.health.status);
    }
  });

  test("classifyClamavHealth — binário sem definições NUNCA é active", () => {
    const versionOk = "ClamAV 1.5.2\n";
    assert.equal(classifyClamavHealth({ versionOutput: null, versionError: "not found", dbDir: null, dbFiles: null }).health.status, "unavailable");
    assert.equal(classifyClamavHealth({ versionOutput: "outra coisa", dbDir: null, dbFiles: null }).health.status, "unavailable");
    assert.equal(classifyClamavHealth({ versionOutput: versionOk, dbDir: null, dbFiles: null }).health.status, "degraded");
    assert.equal(classifyClamavHealth({ versionOutput: versionOk, dbDir: "C:\\db", dbFiles: null }).health.status, "degraded");
    const semBase = classifyClamavHealth({ versionOutput: versionOk, dbDir: "C:\\db", dbFiles: ["readme.txt"] });
    assert.equal(semBase.available, false);
    assert.match(semBase.health.detail, /sem base de assinaturas.*freshclam/i);
    const comBase = classifyClamavHealth({ versionOutput: versionOk, dbDir: "C:\\db", dbFiles: ["main.cvd", "daily.cld", "notas.txt"] });
    assert.equal(comBase.available, true);
    assert.equal(comBase.health.status, "active");
    assert.match(comBase.health.detail, /2 signature database file/);
  });
});

describe("Score e degradação segura", () => {
  const mk = (yara, hashDb, clamav, nativeEngine, firewall) => ({
    serviceRunning: true,
    osLayerHealthy: true,
    degradedReasons: [],
    monitoredPaths: [],
    yara,
    hashDb,
    clamav,
    nativeEngine,
    firewall,
  });

  test("sem motores ativos o piso de risco sobre para 75", () => {
    const engine = mk(
      { status: "unavailable" },
      { status: "unavailable" },
      { status: "unavailable" },
      { status: "unavailable" },
      { status: "active" },
    );
    assert.equal(effectiveRiskScore(0, engine), 75);
    assert.equal(engineIsDegraded(engine), true);
    assert.equal(scoreToStatus(effectiveRiskScore(0, engine), engineIsDegraded(engine)), "degraded");
  });

  test("poucos motores ativos ⇒ piso 45, status degradado", () => {
    const engine = mk(
      { status: "active" },
      { status: "active" },
      { status: "unavailable" },
      { status: "unavailable" },
      { status: "active" },
    );
    assert.equal(effectiveRiskScore(0, engine), 45);
    assert.equal(scoreToStatus(effectiveRiskScore(0, engine), engineIsDegraded(engine)), "degraded");
  });

  test("drift degradado com maioria ativa ⇒ piso 20", () => {
    const engine = mk(
      { status: "active" },
      { status: "active" },
      { status: "active" },
      { status: "degraded", detail: "native timeout" },
      { status: "active" },
    );
    assert.equal(effectiveRiskScore(0, engine), 20);
    assert.equal(engineIsDegraded(engine), true);
  });

  test("score real já alto é preservado quando proteção completa", () => {
    const engine = mk(
      { status: "active" },
      { status: "active" },
      { status: "active" },
      { status: "active" },
      { status: "active" },
    );
    assert.equal(effectiveRiskScore(92, engine), 92);
    assert.equal(engineIsDegraded(engine), false);
    assert.equal(scoreToStatus(92, false), "critical");
  });

  test("scoreToStatus nunca mostra safe quando degradado", () => {
    assert.equal(scoreToStatus(0, true), "degraded");
    assert.equal(scoreToStatus(20, false), "safe");
    assert.equal(scoreToStatus(50, false), "attention");
  });
});

describe("Sem regressões na análise", () => {
  test("ficheiro limpo produz veredicto seguro sem exceções", async () => {
    const cleanPath = path.join(tmpDir, "notes.txt");
    await fs.writeFile(cleanPath, "nothing to see here", "utf-8");

    const deps = {
      signatures: new SignatureDatabase(),
      trust: new TrustEngine(),
      yara: new YaraEngine(path.join(tmpDir, "analyzer.yar")),
      clamav: new ClamavBridge(),
    };
    const analyzer = new MalwareAnalyzer(deps);

    const result = await analyzer.analyze(cleanPath);
    assert.ok(result);
    assert.equal(result.verdict, "safe");
    assert.equal(typeof result.riskScore, "number");
  });
});