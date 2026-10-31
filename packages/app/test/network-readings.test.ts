import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HardwareSnapshot } from "@cybersafe/shared-types";
import { networkReadingDisplay, networkTelemetrySample } from "../src/lib/networkReadings";
import PCCenterPage from "../src/pages/PCCenterPage";

/**
 * TP-PAP-NETWORK-TRUTH — helper + SSR do consumidor real (PC Center).
 * Uma falha/ausência de leitura não pode aparecer como "0 B/s" nem "unknown".
 */

const base = { rxSec: 14_200, txSec: 3_000, interfaceName: "Ethernet", readStatus: "available" as const, updatedAt: "2026-10-18T12:00:00.000Z" };

describe("networkReadingDisplay", () => {
  it("available mostra valores e interface reais", () => {
    const d = networkReadingDisplay(base);
    assert.equal(d.state, "available");
    assert.equal(d.rxSec, 14_200);
    assert.equal(d.txSec, 3_000);
    assert.equal(d.interfaceName, "Ethernet");
    assert.equal(d.label, "");
  });

  it("0 B/s REAL é apresentável (rede ociosa medida)", () => {
    const d = networkReadingDisplay({ ...base, rxSec: 0, txSec: 0 });
    assert.equal(d.state, "available");
    assert.equal(d.rxSec, 0);
    assert.equal(d.txSec, 0);
  });

  it("pending diz 'A medir…', não 0 B/s", () => {
    const d = networkReadingDisplay({ ...base, rxSec: 0, txSec: 0, interfaceName: "", readStatus: "pending", updatedAt: undefined });
    assert.equal(d.state, "pending");
    assert.equal(d.rxSec, null);
    assert.equal(d.txSec, null);
    assert.equal(d.label, "A medir…");
  });

  it("stale mantém valores com rótulo de última leitura", () => {
    const d = networkReadingDisplay({ ...base, readStatus: "stale" });
    assert.equal(d.state, "stale");
    assert.equal(d.rxSec, 14_200);
    assert.equal(d.label, "Última leitura");
    assert.ok(d.hint);
  });

  it("unavailable não mostra número nenhum (nunca '0 B/s')", () => {
    const d = networkReadingDisplay({ ...base, rxSec: 0, txSec: 0, readStatus: "unavailable", updatedAt: undefined });
    assert.equal(d.state, "unavailable");
    assert.equal(d.rxSec, null);
    assert.equal(d.txSec, null);
    assert.equal(d.label, "Sem leitura");
  });

  it("valores malformados são indisponíveis, não 0", () => {
    for (const bad of [{ ...base, rxSec: Number.NaN }, { ...base, txSec: -5 }, { ...base, rxSec: Infinity }]) {
      const d = networkReadingDisplay(bad);
      assert.equal(d.state, "unavailable");
      assert.equal(d.rxSec, null);
      assert.equal(d.txSec, null);
    }
  });

  it("legacy sem readStatus: interface válida = available (compatibilidade)", () => {
    const d = networkReadingDisplay({ rxSec: 1024, txSec: 512, interfaceName: "Ethernet" });
    assert.equal(d.state, "available");
    assert.equal(d.rxSec, 1024);
    assert.equal(d.txSec, 512);
  });

  it("legacy sem readStatus e sem interface é unavailable, não 'unknown'/0", () => {
    for (const iface of ["", "unknown"]) {
      const d = networkReadingDisplay({ rxSec: 0, txSec: 0, interfaceName: iface });
      assert.equal(d.state, "unavailable");
      assert.equal(d.rxSec, null);
      assert.equal(d.interfaceName, null);
    }
  });
});

describe("networkTelemetrySample", () => {
  it("só entrega leituras atuais (pending/stale/unavailable → null)", () => {
    assert.deepEqual(networkTelemetrySample(base), { rxSec: 14_200, txSec: 3_000 });
    assert.deepEqual(networkTelemetrySample({ ...base, rxSec: 0, txSec: 0 }), { rxSec: 0, txSec: 0 });
    assert.equal(networkTelemetrySample({ ...base, readStatus: "stale" }), null);
    assert.equal(networkTelemetrySample({ ...base, readStatus: "unavailable" }), null);
    assert.equal(networkTelemetrySample({ ...base, readStatus: "pending" }), null);
    assert.equal(networkTelemetrySample(null), null);
  });
});

function fixture(network: HardwareSnapshot["network"]): HardwareSnapshot {
  return {
    cpu: { usage: 7, model: "AMD Ryzen 5 5600", cores: 6, speed: 3.5, temperature: null, temperatureStatus: "unavailable" },
    ram: { usagePercent: 51, usedGb: 15.8, totalGb: 30.9 },
    disk: {
      readStatus: "ok", reason: null, lastGoodAt: "2026-10-10T13:00:00.000Z",
      volumes: [{ mount: "C:", usedGb: 425, totalGb: 476.9, usagePercent: 89.1 }],
      primary: { mount: "C:", usedGb: 425, totalGb: 476.9, usagePercent: 89.1 },
      usagePercent: 89.1, usedGb: 425, totalGb: 476.9, fsType: "NTFS",
    },
    network,
    battery: { hasBattery: false, percent: 0, isCharging: false, timeRemaining: null },
    gpu: { usagePercent: null, vramTotalMb: 6128, vramUsedMb: null, temperature: null, model: "AMD Radeon RX 5600 XT", temperatureStatus: "unavailable" },
    system: { uptime: 3600, platform: "win32", osVersion: "10.0.26300", hostname: "PC" },
    topProcessesByCpu: [], topProcessesByRam: [],
    stressScore: 0,
    stressContributions: { cpu: 0, ram: 0, temperature: 0, gpu: 0 },
    alerts: [], timestamp: "2026-10-10T13:00:00.000Z",
  } as unknown as HardwareSnapshot;
}

const render = (network: HardwareSnapshot["network"]) =>
  renderToStaticMarkup(createElement(PCCenterPage, { hardware: fixture(network) }));

describe("PC Center — rede na UI real (SSR)", () => {
  it("pending mostra 'A medir…' e nunca '0 B/s'/'unknown'", () => {
    const html = render({ rxSec: 0, txSec: 0, interfaceName: "", readStatus: "pending" });
    assert.match(html, /A medir/);
    assert.ok(!html.includes("0 B/s"), "0 B/s afirmado sem leitura");
    assert.ok(!html.includes("unknown"), "nome de interface inventado");
  });

  it("unavailable mostra 'Sem leitura' e traços, nunca 0", () => {
    const html = render({ rxSec: 0, txSec: 0, interfaceName: "", readStatus: "unavailable" });
    assert.match(html, /Sem leitura/);
    assert.ok(!html.includes("0 B/s"));
    assert.ok(!html.includes("unknown"));
  });

  it("stale mostra os últimos valores com rótulo de última leitura", () => {
    const html = render({ rxSec: 14_200, txSec: 3_000, interfaceName: "Ethernet", readStatus: "stale" });
    assert.match(html, /Última leitura/);
    assert.match(html, /13\.9 KB\/s/);
  });

  it("available mostra valores reais (compatibilidade com fixture antiga)", () => {
    const html = render({ rxSec: 1024, txSec: 512, interfaceName: "Ethernet" });
    assert.match(html, /1\.0 KB\/s/);
    assert.ok(!html.includes("A medir"));
    assert.ok(!html.includes("Sem leitura"));
  });
});
