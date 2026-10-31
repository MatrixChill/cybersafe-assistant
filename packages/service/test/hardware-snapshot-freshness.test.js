import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ProtectionEngineService } from "../dist/engine.js";

/**
 * P0 — O SNAPSHOT DE HARDWARE NÃO PODE FICAR PRESO NA PRIMEIRA FOTOGRAFIA.
 *
 * ── Bug MEDIDO pelo humano (2026-10-10), pela interface real do serviço ────
 * Sonda pela named pipe (`output/manual-retest/probe-storage-consistency.mjs`):
 *
 *   HARDWARE[0] disk.readStatus = unavailable  ("Ainda sem leitura do armazenamento desde o arranque.")
 *   HARDWARE[1] disk.readStatus = unavailable  (3 s depois...)
 *   HARDWARE[2] disk.readStatus = unavailable  (6 s depois...)
 *   WINDOWS_HEALTH_DISKS        = C: 89% · 106,4 GB livres
 *
 * A causa: `case "hardware.snapshot"` devolvia
 * `this.hardware.getLastSnapshot() || await this.hardware.getSnapshot(...)`.
 * O primeiro snapshot é construído ANTES de a leitura do armazenamento (tick
 * médio, fire-and-forget) e da GPU (tick lento) chegarem, e o curto-circuito
 * fazia dele a resposta ETERNA: com a proteção desligada — e o poller de 10 s
 * só vive dentro de `startProtection()` — nada voltava a chamar `getSnapshot()`.
 * Dashboard e PC Center mostravam "—" enquanto a Saúde do Windows, que tem
 * cache com TTL próprio, mostrava o C: medido.
 *
 * O contrato que estes testes prendem:
 *   1. um snapshot ANTIGO é reconstruído (a leitura chega ao consumidor);
 *   2. uma cache RECENTE continua a ser reutilizada (o renderer a 2 s e a tray
 *      não multiplicam o trabalho);
 *   3. um timestamp inválido não transforma a cache em permanente.
 *
 * Não se chama `init()`: estes testes correm contra o handler real, sem
 * watcher/ETW nem handles de sistema (mesma razão de shutdown.test.js).
 */

const TEST_BASE_DIR = mkdtempSync(path.join(os.tmpdir(), "cybersafe-hardware-snapshot-"));

let engine = null;

function freshEngine() {
  engine = new ProtectionEngineService(TEST_BASE_DIR);
  return engine;
}

afterEach(async () => {
  if (engine) {
    await engine.dispose().catch(() => {});
    engine = null;
  }
});

/** Snapshot mínimo suficiente para o handler: só `timestamp` e `disk` são lidos. */
const snapshot = (timestamp, disk) => ({ timestamp, disk });

const diskState = (readStatus, reason, usagePercent = null) => ({
  readStatus,
  reason,
  lastGoodAt: null,
  volumes: [],
  primary: null,
  usagePercent,
  usedGb: null,
  totalGb: null,
  fsType: "unknown",
});

const readHardware = (e) =>
  e.handleRequest({ id: "t", type: "request", method: "hardware.snapshot", payload: undefined });

/** Snapshot de hardware mínimo mas completo, suficiente para o PC State. */
const hardwareSnapshot = (timestamp, disk) => ({
  cpu: { usage: 5, model: "CPU", cores: 4, speed: 3, temperature: null },
  ram: { usagePercent: 40, usedGb: 8, totalGb: 16 },
  disk,
  network: { rxSec: 0, txSec: 0, interfaceName: "x" },
  battery: { hasBattery: false, percent: 0, isCharging: false, timeRemaining: null },
  gpu: null,
  system: { uptime: 1, platform: "win32", osVersion: "x", hostname: "x" },
  topProcessesByCpu: [],
  topProcessesByRam: [],
  stressScore: 0,
  alerts: [],
  timestamp,
});

describe("hardware.snapshot — a leitura de armazenamento não fica presa na cache", () => {
  it("um snapshot antigo é reconstruído: o disco medido chega ao consumidor", async () => {
    const e = freshEngine();

    // A fotografia ANTIGA é exactamente a que o utilizador viu no ecrã.
    e.hardware.lastSnapshot = snapshot(
      new Date(Date.now() - 5 * 60_000).toISOString(),
      diskState("unavailable", "Ainda sem leitura do armazenamento desde o arranque."),
    );

    let calls = 0;
    const fresh = snapshot(
      new Date().toISOString(),
      { ...diskState("ok", null, 88.8), volumes: [{ mount: "C:" }], primary: { mount: "C:" } },
    );
    e.hardware.getSnapshot = async () => {
      calls += 1;
      return fresh;
    };

    const response = await readHardware(e);

    assert.equal(response.ok, true);
    assert.equal(calls, 1, "o snapshot antigo tinha de ser reconstruído, não servido");
    assert.equal(response.result.disk.readStatus, "ok");
    assert.equal(response.result.disk.usagePercent, 88.8, "o valor medido tem de chegar ao ecrã");
    assert.equal(response.result, fresh, "a resposta é a leitura nova, não a fotografia antiga");
  });

  it("um snapshot recente é reutilizado: chamadas quase simultâneas não repetem trabalho", async () => {
    const e = freshEngine();

    const recent = snapshot(new Date().toISOString(), diskState("ok", null, 88.8));
    e.hardware.lastSnapshot = recent;

    let calls = 0;
    e.hardware.getSnapshot = async () => {
      calls += 1;
      return snapshot(new Date().toISOString(), diskState("unavailable", "nunca devia correr"));
    };

    const response = await readHardware(e);

    assert.equal(calls, 0, "dentro da janela de reutilização não se reconstrói");
    assert.equal(response.result, recent, "a cache recente é devolvida tal como está");
  });

  it("o PC State lê o MESMO snapshot fresco, não uma fotografia antiga", async () => {
    const e = freshEngine();

    e.hardware.lastSnapshot = hardwareSnapshot(
      new Date(Date.now() - 5 * 60_000).toISOString(),
      diskState("unavailable", "Ainda sem leitura do armazenamento desde o arranque."),
    );

    let calls = 0;
    e.hardware.getSnapshot = async () => {
      calls += 1;
      return hardwareSnapshot(new Date().toISOString(), diskState("ok", null, 88.8));
    };

    const response = await e.handleRequest({ id: "t", type: "request", method: "pcstate.get", payload: undefined });

    assert.equal(response.ok, true, `pcstate.get falhou: ${response.error}`);
    assert.equal(calls, 1, "o PC State serviu o snapshot antigo em vez de reconstruir");
  });

  it("um timestamp inválido não torna a cache permanente", async () => {
    const e = freshEngine();

    // Snapshot sem timestamp legível: não é prova de frescura nenhuma.
    e.hardware.lastSnapshot = snapshot("não é uma data", diskState("unavailable", "estado inicial"));

    let calls = 0;
    e.hardware.getSnapshot = async () => {
      calls += 1;
      return snapshot(new Date().toISOString(), diskState("ok", null, 88.8));
    };

    const response = await readHardware(e);

    assert.equal(calls, 1, "sem timestamp válido, a leitura é feita de novo");
    assert.equal(response.result.disk.readStatus, "ok");
  });
});
