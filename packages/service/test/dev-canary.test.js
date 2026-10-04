/**
 * Teste E2E do canário dev-only — pipeline completo de deteção:
 *
 *   ScanManager real → analyzer REAL do core (scan → detection)
 *     → threat.detected (mesmo contrato do engine.ts)
 *     → threatsFound no payload completed
 *
 * Confirma que em dev/test o canário benigno é detetado de ponta a ponta e
 * que o contador threatsFound nunca diverge dos eventos threat.detected; em
 * NODE_ENV=production o MESMO ficheiro fica limpo (0 deteções, 0 eventos).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  MalwareAnalyzer,
  SignatureDatabase,
  TrustEngine,
  YaraEngine,
  ClamavBridge,
} from "@cybersafe/core";
import { DEV_CANARY_CONTENT, installDevCanary } from "./fixtures/dev-canary.js";
import { ScanManager } from "../dist/scan-manager.js";

// Regista o conteudo do canario no core. Em runtime empacotado nada regista
// o conteudo e o detector por conteudo fica inerte.
installDevCanary();

const tempDirs = [];

async function makeTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cybersafe-canary-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function waitFor(predicate, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function withNodeEnv(value, fn) {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

/** Analyzer real do core (as mesmas dependências que o serviço injeta). */
function createRealAnalyzer(yaraRulesPath, clamav) {
  const signatures = new SignatureDatabase();
  return new MalwareAnalyzer({
    signatures,
    trust: new TrustEngine(),
    yara: new YaraEngine(yaraRulesPath),
    clamav,
  });
}

/**
 * Adapter com o MESMO contrato de ameaça do ProtectionEngineService.scanArtifact:
 * threat.detected quando severity !== "low"; highRiskCount quando score > monitorMax.
 */
function createEngineAdapter(analyzer, threatEvents, clamav) {
  // FASE 4: o adapter tem de implementar o contrato NOVO do motor, senao o
  // ScanManager salta o batch e cada ficheiro corre o seu proprio clamscan
  // (2 ficheiros x ~6,2 s > o limite de 10 s do `waitFor`). Nao e o timeout
  // que esta mal: e o duplo a nao saber falar a lingua do motor real.
  const prefetchKey = (file) => file.replace(/\//g, "\\").toLowerCase();
  let prefetch = null;

  return {
    prefetchClamav: async (filePaths) => {
      if (filePaths.length === 0) return { spawned: false };
      try {
        // UM clamscan para todos os ficheiros, exactamente como o motor real.
        const batch = await clamav.scanFiles(filePaths);
        prefetch = new Map(batch.files.map((f) => [prefetchKey(f.file), f]));
        return {
          spawned: true,
          error: batch.status.status === "degraded" ? batch.status.detail : undefined,
        };
      } catch (err) {
        // Sem batch, `scanArtifact` volta ao caminho de um ficheiro de cada vez.
        prefetch = null;
        return { spawned: false, error: (err && err.message) || String(err) };
      }
    },
    clearClamavPrefetch: () => {
      prefetch = null;
    },
    scanArtifact: async (filePath, source) => {
      const clamavOutcome = prefetch ? prefetch.get(prefetchKey(filePath)) : undefined;
      const analysis = await analyzer.analyze(filePath, undefined, undefined, { clamavOutcome });
      if (analysis.severity !== "low") {
        threatEvents.push({
          type: "threat.detected",
          severity: analysis.severity,
          source,
          filePath,
          rulesTriggered: analysis.rulesTriggered,
          riskScore: analysis.riskScore,
        });
      }
      return {
        results: [{
          fileName: analysis.fileName,
          size: analysis.size,
          severity: analysis.severity,
          confidence: analysis.confidence,
          rulesTriggered: analysis.rulesTriggered,
          riskScore: analysis.riskScore,
          verdict: analysis.verdict,
          sha256: analysis.sha256,
        }],
        totalFiles: 1,
        highRiskCount: analysis.riskScore > 70 ? 1 : 0,
        overallSeverity: analysis.severity,
        rulesTriggered: analysis.rulesTriggered,
        riskScore: analysis.riskScore,
      };
    },
    emitScanProgress: () => {},
  };
}

async function scanDir(mgr, dir) {
  const id = await mgr.startScan("custom", dir);
  assert.ok(id, "startScan deve devolver um id");
  const finalState = await waitFor(() => {
    const state = mgr.getScan(id);
    return state && (state.status === "completed" || state.status === "failed") ? state : null;
  });
  assert.equal(finalState.status, "completed", `scan devia completar (erro: ${finalState.error})`);
  return finalState;
}

describe("Canário dev-only — pipeline E2E scan → detection → threat event → threatsFound", () => {
  it("DEV/test: canário benigno gera deteção coerente de ponta a ponta", async () => {
    const dir = await makeTempDir("e2e-dev");
    await fs.writeFile(path.join(dir, "cybersafe-e2e-canary.txt"), DEV_CANARY_CONTENT, "utf8");
    await fs.writeFile(path.join(dir, "notas.txt"), "ficheiro benigno comum", "utf8");

    const result = await withNodeEnv("test", async () => {
      const threatEvents = [];
      const clamav = new ClamavBridge();
      const analyzer = createRealAnalyzer(path.join(dir, "analyzer.yar"), clamav);
      const mgr = new ScanManager(createEngineAdapter(analyzer, threatEvents, clamav));
      const finalState = await scanDir(mgr, dir);
      return { finalState, threatEvents };
    });

    const { finalState, threatEvents } = result;
    // Deteção: o canário passa pelo pipeline REAL e é detetado (medium, não crítico).
    assert.equal(threatEvents.length, 1, "exatamente um threat.detected (o canário)");
    assert.equal(threatEvents[0].severity, "medium", "deteção de teste fica em medium");
    assert.ok(
      threatEvents[0].rulesTriggered.includes("dev_canary_signature"),
      "o evento identifica a regra do canário",
    );
    assert.ok(
      threatEvents[0].filePath.endsWith("cybersafe-e2e-canary.txt"),
      "o evento aponta ao ficheiro-canário",
    );

    // Contadores: ambos os ficheiros analisados, nenhum falhado.
    assert.equal(finalState.filesAnalyzed, 2);
    assert.equal(finalState.filesFailed, 0);
    assert.equal(finalState.progress, 100);

    // Coerência: threat.detected e o resultado final não divergem.
    assert.equal(finalState.threatsFound, 1, "threatsFound conta o canário");
    assert.equal(
      finalState.threatsFound,
      threatEvents.length,
      "threatsFound tem de igualar o número de eventos threat.detected",
    );
  });

  it("production: o MESMO ficheiro-canário fica limpo (0 deteções, 0 divergências)", async () => {
    const dir = await makeTempDir("e2e-prod");
    await fs.writeFile(path.join(dir, "cybersafe-e2e-canary.txt"), DEV_CANARY_CONTENT, "utf8");
    await fs.writeFile(path.join(dir, "notas.txt"), "ficheiro benigno comum", "utf8");

    const result = await withNodeEnv("production", async () => {
      const threatEvents = [];
      const clamav = new ClamavBridge();
      const analyzer = createRealAnalyzer(path.join(dir, "analyzer.yar"), clamav);
      const mgr = new ScanManager(createEngineAdapter(analyzer, threatEvents, clamav));
      const finalState = await scanDir(mgr, dir);
      return { finalState, threatEvents };
    });

    const { finalState, threatEvents } = result;
    assert.equal(threatEvents.length, 0, "nenhum threat.detected em produção");
    assert.equal(finalState.threatsFound, 0, "threatsFound fica a 0 em produção");
    assert.equal(finalState.filesAnalyzed, 2, "os ficheiros continuam a ser analisados");
    assert.equal(finalState.filesFailed, 0);
    assert.equal(
      finalState.threatsFound,
      threatEvents.length,
      "contadores coerentes também quando não há deteções",
    );
  });
});
