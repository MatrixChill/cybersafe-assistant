import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { NativeEngineBridge } from "../dist/native-engine-bridge.js";
import { ProtectionEngineService } from "../dist/engine.js";

/**
 * RC22 — MOTOR NATIVO: presença não é prova de utilização.
 *
 * O contrato antigo fazia `checkAvailability()` a partir de `fs.existsSync` e
 * escrevia `active` a cada leitura — uma falha medida (timeout, exit != 0,
 * output ilegível) era apagada pela leitura seguinte, sem invocação nova.
 *
 * Aqui prova-se, com o binário REAL (`scan-engine.exe`):
 *  - presença ⇒ `degraded`, não `active`;
 *  - uma invocação bem-sucedida ⇒ `active` (e é a única coisa que o faz);
 *  - uma falha (timeout/cancelamento) fica registada como `degraded`;
 *  - cancelamento não devolve resultado nem deixa processo pendente.
 *
 * Sem malware: a fixture é um .txt benigno gerado no tmp.
 */

const createHash256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const bridge = NativeEngineBridge;
const availability = bridge.checkAvailability();
const HAVE_BINARY = availability.status !== "unavailable";

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc22-native-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf8");
  return { dir, file };
}

describe("RC22 motor nativo — registo de filhos e pipeline", () => {
  it("binário presente não é `active` antes de uma invocação real", () => {
    if (!HAVE_BINARY) return; // host sem binário: nada a afirmar
    assert.equal(availability.status, "degraded");
    assert.match(availability.detail ?? "", /invoca/i);
  });

  it("binário ausente é `unavailable` (não um falso degradado)", () => {
    if (HAVE_BINARY) return;
    assert.equal(availability.status, "unavailable");
  });

  it("cancelamento antes do arranque: sem resultado, sem processo", { timeout: 30_000 }, async () => {
    if (!HAVE_BINARY) return;
    const { dir, file } = tmpFile("alvo.txt", "CyberSafe RC22 benigno\n");
    const controller = new AbortController();
    controller.abort();
    try {
      const outcome = await bridge.scan(file, { signal: controller.signal });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.cancelled, true);
      assert.equal(outcome.failure, "cancelled");
      assert.equal(outcome.result, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prazo vencido mata o filho e degrada o estado (sem reset silencioso)", { timeout: 60_000 }, async () => {
    if (!HAVE_BINARY) return;
    const { dir, file } = tmpFile("lento.txt", "CyberSafe RC22 benigno\n");
    try {
      const outcome = await bridge.scan(file, { timeoutMs: 1 });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.failure, "timeout");
      assert.equal(bridge.health.status, "degraded", "uma falha medida não pode voltar a `active` sem invocação nova");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o registo de filhos só cai quando o `close` confirma a morte", { timeout: 60_000 }, async () => {
    if (!HAVE_BINARY) return;
    const { dir, file } = tmpFile("registo.txt", "CyberSafe RC22 benigno\n");
    try {
      const outcome = await bridge.scan(file, { timeoutMs: 1 });
      assert.equal(outcome.failure, "timeout");
      // O kill foi aceite: o `close` chega e o registo tem de esvaziar-se por si,
      // não por a promessa ter resolvido.
      const limite = Date.now() + 5_000;
      while (bridge.pendingChildren > 0 && Date.now() < limite) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(bridge.pendingChildren, 0, "processo registado depois do close");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pipeline `scanArtifact`: motor nativo real, resultado e evento `artifact.analyzed`", { timeout: 90_000 }, async () => {
    if (!HAVE_BINARY) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc22-pipe-"));
    const ficheiro = path.join(dir, "benigno.txt");
    fs.writeFileSync(ficheiro, "CyberSafe RC22 fixture benigna\n", "utf8");
    const e = new ProtectionEngineService(dir);
    for (const part of ["watcher", "processMonitor", "etwConsumer", "wfpFilter", "amsiProvider"]) {
      e[part].start = async () => {};
      e[part].stop = async () => {};
    }
    e.updater.startScheduler = () => undefined;
    e.processMonitor.list = async () => [];
    e.hardware.getSnapshot = async () => ({});
    e.refreshConnections = async () => {};
    const publishOriginal = e.eventBus.publish.bind(e.eventBus);
    const eventos = [];
    e.eventBus.publish = (...args) => { eventos.push(args[0]); return publishOriginal(...args); };
    // O analisador é a costura: o que se prova aqui é o CAMINHO do motor nativo
    // dentro do serviço, não a análise YARA/ClamAV (essa já tem provas próprias).
    e.analyzer.analyze = async (p) => ({
      fileName: path.basename(p), size: 10, severity: "low", confidence: 1,
      rulesTriggered: [], factors: [], riskScore: 0, recommendedAction: "none",
      sha256: "a".repeat(64), verdict: "clean",
    });

    const scanOriginal = NativeEngineBridge.scan;
    let capturado = null;
    NativeEngineBridge.scan = async (p, o) => { const r = await scanOriginal.call(NativeEngineBridge, p, o); capturado = r; return r; };
    try {
      const res = await e.scanArtifact(ficheiro, "service", { skipVirusTotal: true });
      assert.equal(res.results.length, 1);
      assert.equal(res.results[0].fileName, "benigno.txt");
      assert.ok(capturado, "o serviço tem de invocar o motor nativo");
      assert.equal(capturado.ok, true, capturado.error);
      assert.equal(capturado.result.sha256, createHash256(ficheiro));
      assert.equal(bridge.health.status, "active");
      assert.ok(eventos.includes("artifact.analyzed"), `eventos: ${JSON.stringify(eventos)}`);
      assert.equal(bridge.pendingChildren, 0);
    } finally {
      NativeEngineBridge.scan = scanOriginal;
      await e.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probe real de uma fixture benigna: `active` e resultado íntegro", { timeout: 90_000 }, async () => {
    if (!HAVE_BINARY) return;
    const health = await bridge.probe();
    assert.equal(health.status, "active");

    const { dir, file } = tmpFile("benigno.txt", "CyberSafe RC22 fixture benigna\n");
    try {
      const outcome = await bridge.scan(file, { timeoutMs: 30_000 });
      assert.equal(outcome.ok, true, outcome.error);
      assert.ok(outcome.result);
      assert.match(outcome.result.sha256, /^[0-9a-f]{64}$/);
      assert.equal(outcome.result.file_size, fs.statSync(file).size);
      assert.equal(outcome.result.score, 0);
      assert.equal(bridge.health.status, "active");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
