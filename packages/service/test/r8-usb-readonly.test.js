/**
 * R8 — SCAN USB ESTRITAMENTE READ-ONLY (service/engine).
 *
 * Contrato (R8-USB-CONTRACT-CODEX-2026-10-12.md):
 *  - `engine.scanArtifact` coloca ficheiros em quarentena para
 *    critical/quarantined. USB tem de ser READ-ONLY: detetar e alertar,
 *    NUNCA colocar em quarentena, nunca escrever/mover nada no dispositivo.
 *  - `skipVirusTotal=true` para USB (forcado no motor, nao so' no chamador).
 *  - Nunca afirmar quarentena quando apenas se detetou.
 *  - Comportamento NAO-USB preservado.
 *
 * Prova, com uma deteccao critica REAL (regra YARA forte, como o teste
 * detection-quality), que:
 *   - o dispositivo fica byte a byte igual (snapshot antes/depois);
 *   - `quarantine.quarantine` nunca e' chamado e `quarantine.added` nunca sai;
 *   - a deteccao continua a ser publicada (nao se esconde o que se viu);
 *   - fora de USB tudo continua como antes.
 *
 * Uso: node --test packages/service/test/r8-usb-readonly.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { MalwareAnalyzer, SignatureDatabase, TrustEngine, YaraEngine } from "@cybersafe/core";
import { ProtectionEngineService } from "../dist/engine.js";
import { NativeEngineBridge } from "../dist/native-engine-bridge.js";
import { ScanManager } from "../dist/scan-manager.js";
import { RealtimeFileQueue } from "../dist/realtime-file-queue.js";

const MARCADOR = "MZ CS-STRONG-USB-PROBE-42";

/** Snapshot do "dispositivo": caminho relativo + tamanho + mtime + sha256. */
async function snapshot(dir, base = dir) {
  const itens = [];
  for (const entrada of await fs.readdir(dir, { withFileTypes: true })) {
    const alvo = path.join(dir, entrada.name);
    if (entrada.isDirectory()) {
      itens.push(...(await snapshot(alvo, base)));
      continue;
    }
    const conteudo = await fs.readFile(alvo);
    const info = await fs.stat(alvo);
    itens.push({
      rel: path.relative(base, alvo).replace(/\\/g, "/"),
      tamanho: info.size,
      mtimeMs: info.mtimeMs,
      sha256: createHash("sha256").update(conteudo).digest("hex"),
    });
  }
  return itens.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function waitForTerminal(manager, id, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = manager.getScan(id);
    if (state && ["completed", "failed", "cancelled"].includes(state.status)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("scan mode did not reach a terminal state");
}

/**
 * "Dispositivo" (pasta USB simulada) + motor real com colaboradores falsos.
 * A quarentena falsa APAGA o ficheiro, como a real: e' isso que torna
 * visivel uma quarentena que nao devia ter acontecido.
 */
async function dispositivo(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-usb-device-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scanRoot = path.join(dir, "target");
  await fs.mkdir(scanRoot);
  const alvo = path.join(scanRoot, "pen.exe");
  await fs.writeFile(alvo, MARCADOR);

  const yara = new YaraEngine(path.join(dir, "fallback.yar"));
  const fortes = path.join(dir, "forte.yar");
  await fs.writeFile(fortes, `rule usb_probe { meta: cybersafe_evidence = "strong" strings: $a = "${MARCADOR}" condition: $a }`);
  await yara.load(fortes);

  const signatures = new SignatureDatabase();
  const analyzer = new MalwareAnalyzer({ yara, trust: new TrustEngine(), signatures });
  const eventos = [];
  const chamadas = { quarentenas: 0, vt: 0, native: [] };

  const originalScan = NativeEngineBridge.scan;
  NativeEngineBridge.scan = async (ficheiro) => {
    chamadas.native.push(ficheiro);
    return { ok: false, result: null };
  };
  t.after(() => {
    NativeEngineBridge.scan = originalScan;
  });

  const service = Object.assign(Object.create(ProtectionEngineService.prototype), {
    analyzer,
    exclusions: { exclusionReason: () => null },
    vt: {
      isEnabled: () => true,
      scanHash: async () => {
        chamadas.vt += 1;
        return { positives: 3, detectionRatio: "3/70" };
      },
    },
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

test("BITE: scan USB read-only com deteccao critica real — zero quarentena e dispositivo intacto", async (t) => {
  const { dir, alvo, service, eventos, chamadas } = await dispositivo(t);
  const antes = await snapshot(dir);

  const resultado = await service.scanArtifact(alvo, "system-scanner", { readOnly: true });

  // A deteccao e' REAL e continua a ser publicada: nao se esconde o que se viu.
  assert.equal(resultado.overallSeverity, "critical");
  assert.equal(resultado.results[0].verdict, "malicious");
  assert.ok(eventos.some((evento) => evento.type === "threat.detected"), "deteccao tem de ser publicada");

  // ... mas nada de quarentena, nem de o afirmar.
  assert.equal(chamadas.quarentenas, 0, "quarentena nunca pode ser chamada num scan USB");
  assert.equal(eventos.some((evento) => evento.type === "quarantine.added"), false, "nao se pode afirmar quarentena");
  // O item de resposta NAO expoe `recommendedAction`; o AnalysisResult real
  // viaja no evento `artifact.analyzed`. A recomendacao tem de refletir o que o
  // motor fez: "quarantined" sem quarentena executada e' exatamente o que esta
  // asserta apanha.
  const artefacto = eventos.find((evento) => evento.type === "artifact.analyzed");
  assert.ok(artefacto, "artifact.analyzed tem de transportar o AnalysisResult");
  assert.notEqual(artefacto.data.recommendedAction, "quarantined", "a recomendacao tem de refletir o que o motor fez");

  // O dispositivo fica byte a byte igual (conteudo, tamanho e mtime).
  assert.deepEqual(await snapshot(dir), antes, "o dispositivo nao pode mudar");
  assert.equal(await fs.readFile(alvo, "utf8"), MARCADOR, "o ficheiro analisado continua no dispositivo");
});

test("observacao de ficheiro encaminha marcador benigno pelo YARA nativo em tempo real", async (t) => {
  const { alvo, service, eventos } = await dispositivo(t);

  await service.handleFileObservation(alvo);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !eventos.some((event) => event.type === "threat.detected")) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.ok(
    eventos.some((event) => event.type === "threat.detected"),
    "a observação elegível tem de chegar ao caminho de análise YARA",
  );
  assert.ok(
    service.threats.some((threat) => threat.rulesTriggered.includes("yara_match")),
    "o resultado real do YARA tem de ficar registado no serviço",
  );
});

for (const type of ["quick", "full", "custom"]) {
  test(`YARA nativo com regra benigna de teste chega ao motor no modo ${type}`, async (t) => {
    const { scanRoot, service, eventos } = await dispositivo(t);
    const manager = new ScanManager(service);
    manager.resolvePathsForScan = async () => [scanRoot];

    const id = await manager.startScan(type, type === "custom" ? scanRoot : undefined);
    assert.ok(id);
    const state = await waitForTerminal(manager, id);

    assert.equal(state.status, "completed");
    assert.equal(state.filesAnalyzed, 1);
    assert.equal(state.threatsFound, 1, "a regra YARA de teste deve atravessar o caminho do scan");
    assert.ok(
      eventos.some((event) => event.type === "threat.detected"),
      "o motor de serviço deve publicar a deteção YARA",
    );
  });
}

test("scan personalizado deteta subpastas e respeita uma exclusão descendente", async (t) => {
  const { scanRoot, alvo, service, eventos } = await dispositivo(t);
  const nestedTarget = path.join(scanRoot, "one", "two", "pen.exe");
  const excludedTarget = path.join(scanRoot, "excluded", "deep", "skip.exe");
  await fs.mkdir(path.dirname(nestedTarget), { recursive: true });
  await fs.rename(alvo, nestedTarget);
  await fs.mkdir(path.dirname(excludedTarget), { recursive: true });
  await fs.writeFile(excludedTarget, MARCADOR);
  service.isExcluded = (filePath) => filePath === excludedTarget;
  const manager = new ScanManager(service);
  manager.resolvePathsForScan = async () => [scanRoot];

  const id = await manager.startScan("custom", scanRoot);
  assert.ok(id);
  const state = await waitForTerminal(manager, id);

  assert.equal(state.status, "completed");
  assert.equal(state.filesAnalyzed, 1);
  assert.equal(state.filesExcluded, 1);
  assert.equal(state.threatsFound, 1);
  assert.ok(
    service.threats.some((threat) => threat.filePath === nestedTarget && threat.rulesTriggered.includes("yara_match")),
    "a deteção do ficheiro descendente tem de preservar o caminho e a regra",
  );
  assert.ok(
    !service.threats.some((threat) => threat.filePath === excludedTarget),
    "um ficheiro descendente excluído não pode chegar aos motores",
  );
  assert.ok(eventos.some((event) => event.type === "threat.detected"));
});

test("resultado Hash DB, ClamAV e YARA fica agregado numa única deteção do ficheiro", async (t) => {
  const { alvo, service, eventos, signatures } = await dispositivo(t);
  const sha256 = createHash("sha256").update(await fs.readFile(alvo)).digest("hex");
  signatures.add({
    sha256,
    family: "Controlled-Test",
    severity: "critical",
    source: "test-fixture",
  });

  const result = await service.scanArtifact(alvo, "system-scanner", {
    skipVirusTotal: true,
    clamavOutcome: {
      file: alvo,
      verdict: "detected",
      signature: "Test.Clam.Signature",
    },
  });

  assert.equal(result.results.length, 1);
  assert.ok(result.results[0].rulesTriggered.includes("known_bad_hash"));
  assert.ok(result.results[0].rulesTriggered.includes("known_malware"));
  assert.ok(result.results[0].rulesTriggered.includes("yara_match"));
  assert.equal(service.threats.length, 1, "os dois motores pertencem ao mesmo registo da análise");
  const detections = eventos.filter((event) => event.type === "threat.detected");
  assert.equal(detections.length, 1, "uma análise não deve emitir uma ameaça por motor");
  assert.ok(detections[0].data.rulesTriggered.includes("known_bad_hash"));
  assert.ok(detections[0].data.rulesTriggered.includes("known_malware"));
  assert.ok(detections[0].data.rulesTriggered.includes("yara_match"));
});

test("read-only forca skipVirusTotal: nenhuma consulta a rede sobre o dispositivo", async (t) => {
  const { alvo, service, chamadas } = await dispositivo(t);
  const semReadOnly = await dispositivo(t);

  await service.scanArtifact(alvo, "system-scanner", { readOnly: true });
  assert.equal(chamadas.vt, 0, "read-only nao pode provocar consultas de rede");

  await semReadOnly.service.scanArtifact(semReadOnly.alvo, "system-scanner", {});
  assert.equal(semReadOnly.chamadas.vt, 1, "sem read-only o enriquecimento VT mantem-se (nao e' para mudar o comportamento normal)");
});

test("nao-USB: deteção por omissão avisa e preserva ficheiro até autorização", async (t) => {
  const { dir, alvo, service, eventos, chamadas } = await dispositivo(t);

  const resultado = await service.scanArtifact(alvo, "system-scanner", { skipVirusTotal: true });

  assert.equal(resultado.overallSeverity, "critical");
  assert.equal(chamadas.quarentenas, 0, "a política por omissão não autoriza movimentação");
  assert.equal(eventos.some((evento) => evento.type === "quarantine.added"),false);
  assert.equal(await fs.readFile(alvo, "utf8"), MARCADOR, "ficheiro preservado até decisão manual");
  void dir;
});

test("read-only num ficheiro sem deteccao: nada muda e nada e' afirmado", async (t) => {
  const { dir, alvo, service, eventos, chamadas } = await dispositivo(t);
  await fs.writeFile(alvo, "texto benigno, sem regra nenhuma");
  const antes = await snapshot(dir);

  const resultado = await service.scanArtifact(alvo, "system-scanner", { readOnly: true });

  assert.notEqual(resultado.overallSeverity, "critical");
  assert.equal(chamadas.quarentenas, 0);
  assert.equal(eventos.some((evento) => evento.type === "quarantine.added"), false);
  assert.deepEqual(await snapshot(dir), antes);
});
