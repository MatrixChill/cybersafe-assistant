/**
 * GATE READONLY SAFETY — revisão do achado "quarantinePolicy não imposta".
 *
 * Contexto: o gate de fixture (dev-fixture-gate.ts) NÃO força a política de
 * quarentena — apenas a lê e regista ("observada"). Este ficheiro fixa as
 * regressões que tornam essa decisão verificável em vez de assumida:
 *
 *  1. Allowlist do gate: os métodos perigosos REAIS (threat.action — quarentena
 *     manual; process.killTree; protectionIntent.setOptIn; exclusions.update;
 *     trust.allowHash; quarantine.*) são recusados antes de tocar no serviço; o
 *     scanManager nunca é chamado numa recusa; e o readOnly é forçado mesmo
 *     quando o chamador passa readOnly:false.
 *  2. Política mais perigosa (automatic-high-confidence) + deteção crítica real
 *     (hash conhecido + YARA forte): SEM readOnly há quarentena (controlo — o
 *     ramo automático está vivo); COM readOnly:true não há quarentena nem
 *     afirmação dela (tratamento). É este segundo caso que o gate garante
 *     numa sessão de fixture, porque forca readOnly em TODOS os scans.
 *
 * Uso: node --test packages/service/test/gate-readonly-safety.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { MalwareAnalyzer, SignatureDatabase, TrustEngine, YaraEngine } from "@cybersafe/core";
import { ProtectionEngineService } from "../dist/engine.js";
import { NativeEngineBridge } from "../dist/native-engine-bridge.js";
import { RealtimeFileQueue } from "../dist/realtime-file-queue.js";
import {
  FIXTURE_ROOT_ENV,
  FIXTURE_SCAN_FLAG,
  GATE_CODE,
  installDevFixtureGate,
} from "../dist/dev-fixture-gate.js";

// ── 1. Allowlist do gate ─────────────────────────────────────────────────────

test("gate: métodos perigosos reais recusados, scanManager intocado, readOnly forçado", async (t) => {
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), "cs-gate-ro-"));
  t.after(() => fs.rm(raiz, { recursive: true, force: true }));
  const alvo = path.join(raiz, "a.txt");
  await fs.writeFile(alvo, "x");

  const chamadas = [];
  const svc = {
    quarantinePolicy: "automatic-high-confidence",
    scanManager: {
      startScan: async (type, targetPath, options) => {
        chamadas.push({ type, targetPath, options });
        return "scan-1";
      },
    },
    handleRequest: async (req) => {
      if (req.method === "scan.start") {
        await svc.scanManager.startScan(req.payload.type, req.payload.targetPath);
      }
      return { ok: true, result: null };
    },
  };
  const env = { [FIXTURE_SCAN_FLAG]: "1", [FIXTURE_ROOT_ENV]: raiz };
  installDevFixtureGate(svc, env, () => {});

  // scan.start custom dentro do root passa e o readOnly é forçado (sem opções).
  const r1 = await svc.handleRequest({ id: "1", method: "scan.start", payload: { type: "custom", targetPath: alvo } });
  assert.equal(r1.ok, true, "scan custom contido no root tem de passar");
  assert.deepEqual(chamadas[0].options, { readOnly: true }, "o gate tem de forçar readOnly:true");

  // Mesmo que o chamador tente readOnly:false, a sessão continua read-only.
  await svc.scanManager.startScan("custom", alvo, { readOnly: false });
  assert.deepEqual(chamadas[1].options, { readOnly: true }, "readOnly é forçado, não negociado");

  // quick nunca passa pelo gate.
  const r2 = await svc.handleRequest({ id: "2", method: "scan.start", payload: { type: "quick", targetPath: raiz } });
  assert.equal(r2.ok, false, "quick tem de ser recusado");

  // Métodos perigosos REAIS — incluindo quarentena manual via threat.action e
  // os restantes caminhos que a allowlist precisa de continuar a fechar.
  const antes = chamadas.length;
  for (const metodo of [
    "threat.action",
    "process.killTree",
    "protectionIntent.setOptIn",
    "exclusions.update",
    "trust.allowHash",
    "quarantine.list",
    "quarantine.delete",
    "quarantine.restore",
    "monitor.start",
    "definitions.update",
  ]) {
    const r = await svc.handleRequest({ id: "3", method: metodo, payload: { id: "qualquer" } });
    assert.equal(r.ok, false, `${metodo} tem de ser recusado`);
    assert.match(String(r.error), new RegExp(GATE_CODE), `${metodo} tem de devolver o código do gate`);
  }
  assert.equal(chamadas.length, antes, "uma recusa não pode chegar ao scanManager");

  // Leitura/cancelamento da sessão continuam a passar.
  for (const metodo of ["scan.getActive", "scan.getLast", "scan.history", "scan.cancel"]) {
    const r = await svc.handleRequest({ id: "4", method: metodo, payload: {} });
    assert.equal(r.ok, true, `${metodo} é da sessão de fixture`);
  }
});

// ── 2. Controlo + tratamento: readOnly trava a quarentena automática ─────────

const MARCADOR = "MZ CS-GATE-RO-PROBE-77";

async function dispositivo(t, politica) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-gate-engine-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scanRoot = path.join(dir, "target");
  await fs.mkdir(scanRoot);
  const alvo = path.join(scanRoot, "pen.exe");
  await fs.writeFile(alvo, MARCADOR);

  const yara = new YaraEngine(path.join(dir, "fallback.yar"));
  const fortes = path.join(dir, "forte.yar");
  await fs.writeFile(fortes, `rule gate_probe { meta: cybersafe_evidence = "strong" strings: $a = "${MARCADOR}" condition: $a }`);
  await yara.load(fortes);

  const signatures = new SignatureDatabase();
  const analyzer = new MalwareAnalyzer({ yara, trust: new TrustEngine(), signatures });
  const eventos = [];
  const chamadas = { quarentenas: 0 };

  const originalScan = NativeEngineBridge.scan;
  NativeEngineBridge.scan = async () => ({ ok: false, result: null });
  t.after(() => {
    NativeEngineBridge.scan = originalScan;
  });

  const service = Object.assign(Object.create(ProtectionEngineService.prototype), {
    analyzer,
    exclusions: { exclusionReason: () => null },
    vt: { isEnabled: () => true, scanHash: async () => null },
    eventBus: { publish: (type, severity, message, data) => eventos.push({ type, severity, data }) },
    quarantine: {
      quarantine: async () => {
        chamadas.quarentenas += 1;
        await fs.rm(alvo, { force: true });
        return { id: "falsa" };
      },
    },
    threats: [],
    blockedHashes: new Set(),
    blockedPaths: new Set(),
    clients: new Set(),
    scanAbortControllers: new Map(),
    scanAbortIntents: new Set(),
    backgroundAbort: new AbortController(),
    transientScanLogAt: new Map(),
    clamavPrefetches: new Map(),
    clamavPrefetchGeneration: 0,
    protectionState: true,
    isShuttingDown: false,
    protectionGeneration: 1,
    quarantinePolicy: politica,
    realtimeQueue: new RealtimeFileQueue(),
    fileObservationReads: 0,
    logHistory: async () => {},
    actionsLog: { write: async () => {} },
    isExcluded: () => false,
    prefetchClamav: async () => ({ spawned: false }),
    clearClamavPrefetch: () => {},
  });

  return { dir, scanRoot, alvo, service, eventos, chamadas, signatures };
}

test("com política automatic-high-confidence: sem readOnly há quarentena (controlo); com readOnly não há (tratamento)", async (t) => {
  // CONTROL — prova que o ramo automático está VIVO nesta configuração.
  const controlo = await dispositivo(t, "automatic-high-confidence");
  const shaC = createHash("sha256").update(await fs.readFile(controlo.alvo)).digest("hex");
  controlo.signatures.add({ sha256: shaC, family: "Controlled-Test", severity: "critical", source: "test-fixture" });

  const rC = await controlo.service.scanArtifact(controlo.alvo, "system-scanner", {
    skipVirusTotal: true,
    clamavOutcome: { file: controlo.alvo, verdict: "detected", signature: "Test.Clam.Signature" },
  });
  assert.equal(rC.overallSeverity, "critical", "o controlo precisa de uma deteção crítica");
  assert.ok(rC.results[0].rulesTriggered.includes("known_bad_hash"), "o controlo precisa do hash conhecido");
  assert.equal(controlo.chamadas.quarentenas, 1, "sem readOnly a quarentena automática tem de acontecer");
  assert.ok(
    controlo.eventos.some((evento) => evento.type === "quarantine.added"),
    "o controlo tem de publicar o evento de quarentena",
  );
  await assert.rejects(fs.readFile(controlo.alvo), "a quarentena do controlo remove o ficheiro (como a real)");

  // TRATAMENTO — os mesmos motores, com readOnly:true (o que o gate força).
  const trat = await dispositivo(t, "automatic-high-confidence");
  const shaT = createHash("sha256").update(await fs.readFile(trat.alvo)).digest("hex");
  trat.signatures.add({ sha256: shaT, family: "Controlled-Test", severity: "critical", source: "test-fixture" });

  const rT = await trat.service.scanArtifact(trat.alvo, "system-scanner", {
    readOnly: true,
    clamavOutcome: { file: trat.alvo, verdict: "detected", signature: "Test.Clam.Signature" },
  });
  assert.equal(rT.overallSeverity, "critical", "a deteção continua a ser publicada em read-only");
  assert.equal(trat.chamadas.quarentenas, 0, "readOnly tem de tornar o ramo automático inalcançável");
  assert.equal(
    trat.eventos.some((evento) => evento.type === "quarantine.added"),
    false,
    "não se pode afirmar uma quarentena que não aconteceu",
  );
  assert.equal(rT.results[0].verdict, "malicious", "a deteção continua a ser reportada");
  assert.equal(await fs.readFile(trat.alvo, "utf8"), MARCADOR, "o ficheiro analisado fica intacto");
});
