import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HardwareHealthEngine } from "../dist/hardware.js";
import { initialDiskSnapshot } from "../dist/disk.js";

/**
 * TP-PAP-NETWORK-TRUTH — estado honesto do tráfego de rede.
 *
 * O seam `readNetworkStats` é sobreposto: nenhum CIM/rede real. O snapshot é
 * lido com o tick lento desligado para não disparar GPU/temperatura.
 *
 * RED reproduzido no dist PRÉ-fix (cópia controlada, GPU/temp neutralizados):
 * lista vazia e rejeição do provider → { rxSec: 0, txSec: 0, interfaceName:
 * "unknown" } sem estado, indistinguível de "0 B/s agora".
 */

class SeamEngine extends HardwareHealthEngine {
  constructor() {
    super();
    this.initialized = true;
    this.diskReadAttempted = true;
    this.diskSnapshot = initialDiskSnapshot();
    this.lastMediumTick = Date.now();
    this.lastSlowTick = Date.now();
    this.nextStats = null;
  }

  async readNetworkStats() {
    if (this.nextStats instanceof Error) throw this.nextStats;
    return this.nextStats;
  }
}

async function snap(e) {
  return e.getSnapshot([]);
}

const good = [{ iface: "Ethernet", rx_sec: 14_200, tx_sec: 3_000 }];

describe("Network reading truth", () => {
  it("primeira leitura ainda pendente: estado pending, nunca '0 B/s' afirmado", async () => {
    const e = new SeamEngine();
    const s = await snap(e);
    assert.equal(s.network.readStatus, "pending");
    assert.equal(s.network.interfaceName, "", "não inventa 'unknown'");
    assert.equal(s.network.rxSec, 0, "valor de inicialização; o estado diz que não é medição");
    assert.equal(s.network.updatedAt, undefined);
  });

  it("leitura válida publica valores, interface e estado available", async () => {
    const e = new SeamEngine();
    e.nextStats = good;
    await e.refreshNetwork();
    const s = await snap(e);
    assert.equal(s.network.readStatus, "available");
    assert.equal(s.network.rxSec, 14_200);
    assert.equal(s.network.txSec, 3_000);
    assert.equal(s.network.interfaceName, "Ethernet");
    assert.ok(s.network.updatedAt);
  });

  it("0 B/s REAL é válido (rede ociosa não é erro)", async () => {
    const e = new SeamEngine();
    e.nextStats = [{ iface: "Ethernet", rx_sec: 0, tx_sec: 0 }];
    await e.refreshNetwork();
    const s = await snap(e);
    assert.equal(s.network.readStatus, "available");
    assert.equal(s.network.rxSec, 0);
    assert.equal(s.network.txSec, 0);
  });

  it("falha após leitura boa mantém o último valor como stale (rotulado)", async () => {
    const e = new SeamEngine();
    e.nextStats = good;
    await e.refreshNetwork();

    e.nextStats = null;
    await e.refreshNetwork();
    const s = await snap(e);
    assert.equal(s.network.readStatus, "stale");
    assert.equal(s.network.rxSec, 14_200, "a falha não pode virar 0 B/s");
    assert.equal(s.network.interfaceName, "Ethernet");
  });

  it("rejeição do provider também é falha, não 0 B/s", async () => {
    const e = new SeamEngine();
    e.nextStats = good;
    await e.refreshNetwork();

    e.nextStats = new Error("provider indisponível");
    await e.refreshNetwork();
    const s = await snap(e);
    assert.equal(s.network.readStatus, "stale");
    assert.equal(s.network.rxSec, 14_200);
  });

  it("sem interface (lista vazia) é unavailable, não 0 B/s/'unknown'", async () => {
    const e = new SeamEngine();
    e.nextStats = [];
    await e.refreshNetwork();
    const s = await snap(e);
    assert.equal(s.network.readStatus, "unavailable");
    assert.equal(s.network.interfaceName, "");
    assert.equal(s.network.updatedAt, undefined);
  });

  it("contadores malformados não são aceites (nunca viram 0)", async () => {
    for (const bad of [
      [{ iface: "Ethernet", rx_sec: Number.NaN, tx_sec: 1 }],
      [{ iface: "Ethernet", rx_sec: -5, tx_sec: 1 }],
      [{ iface: "Ethernet", tx_sec: 1 }],
      [{ iface: "", rx_sec: 1, tx_sec: 1 }],
    ]) {
      const e = new SeamEngine();
      e.nextStats = good;
      await e.refreshNetwork();
      e.nextStats = bad;
      await e.refreshNetwork();
      const s = await snap(e);
      assert.equal(s.network.readStatus, "stale", `malformado ${JSON.stringify(bad)}`);
      assert.equal(s.network.rxSec, 14_200);
    }
  });

  it("passado o TTL (20 s) sem novo tick → unavailable no snapshot (idade recalculada)", async () => {
    const e = new SeamEngine();
    e.nextStats = good;
    await e.refreshNetwork();

    e.networkState.updatedAt = Date.now() - 25_000;
    e.lastSlowTick = Date.now();
    const s = await e.getSnapshot([]);
    assert.equal(s.network.readStatus, "unavailable");
    assert.equal(s.network.rxSec, 14_200, "o último número não é apagado, mas não é apresentável");
  });
});
