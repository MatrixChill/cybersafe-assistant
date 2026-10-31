import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MalwareAnalyzer, SignatureDatabase, TrustEngine, YaraEngine } from "@cybersafe/core";
import { ProtectionEngineService } from "../dist/engine.js";
import { NativeEngineBridge } from "../dist/native-engine-bridge.js";

test("generic analysis plus native heuristics and one VT hit cannot auto-quarantine", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-evidence-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "runtime.exe");
  await fs.writeFile(target, "MZ benign runtime powershell.exe");
  const yara = new YaraEngine(path.join(dir, "fallback.yar"));
  const analyzer = new MalwareAnalyzer({ yara, trust: new TrustEngine(), signatures: new SignatureDatabase() });
  const originalScan = NativeEngineBridge.scan;
  NativeEngineBridge.scan = async () => ({ ok: true, result: { score: 100, level: "malicious", reasons: ["very_high_entropy", "no_imports"] } });
  t.after(() => { NativeEngineBridge.scan = originalScan; });
  const events = [];
  let quarantines = 0;
  // Run the real service method without starting watchers, pipes, or persistent logs.
  const service = Object.assign(Object.create(ProtectionEngineService.prototype), {
    analyzer,
    exclusions: { exclusionReason: () => null },
    vt: { isEnabled: () => true, scanHash: async () => ({ positives: 1, detectionRatio: "1/70" }) },
    eventBus: { publish: (type, severity, message, data) => events.push({ type, severity, data }) },
    quarantine: { quarantine: async () => { quarantines++; return null; } },
    threats: [], blockedHashes: new Set(), blockedPaths: new Set(),
    logHistory: async () => {}, actionsLog: { write: async () => {} },
  });
  const result = await service.scanArtifact(target, "system-scanner");
  assert.equal(quarantines, 0);
  assert.ok(result.riskScore <= 90);
  assert.notEqual(result.overallSeverity, "critical");
  assert.notEqual(result.results[0].verdict, "malicious");
  assert.equal(service.blockedHashes.size, 0);
  const event = events.find(e => e.type === "artifact.analyzed");
  assert.equal(event.data.riskScore, result.riskScore);
  assert.equal(event.data.severity, result.overallSeverity);
  assert.notEqual(event.data.recommendedAction, "quarantined");
  assert.equal(event.data.factors.reduce((sum, f) => sum + f.weight, 0), result.riskScore);

  // A real, explicitly classified strong rule must still cross the service gate.
  const strongRules = path.join(dir, "strong.yar");
  await fs.writeFile(target, "MZ CS-STRONG-SERVICE-PROBE-42");
  await fs.writeFile(strongRules, 'rule strong_probe { meta: cybersafe_evidence = "strong" strings: $a = "CS-STRONG-SERVICE-PROBE-42" condition: $a }');
  await yara.load(strongRules);
  const strong = await service.scanArtifact(target, "system-scanner", { skipVirusTotal: true });
  assert.equal(strong.overallSeverity, "critical");
  assert.equal(strong.results[0].verdict, "malicious");
  assert.equal(quarantines, 0, "a deteção forte não substitui autorização explícita para mover ficheiros");
  assert.equal(events.some(e=>e.type==="quarantine.added"),false);
});
