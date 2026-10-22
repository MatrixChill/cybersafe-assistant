import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HardwareSnapshot } from "@cybersafe/shared-types";
import { batteryDisplay, pcCenterDataOrigin, snapshotAgeText } from "../src/lib/batteryDisplay";

(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { default: PCCenterPage } = await import("../src/pages/PCCenterPage");

const DISK = {
  readStatus: "ok",
  reason: null,
  lastGoodAt: "2026-10-10T13:00:00.000Z",
  volumes: [],
  primary: null,
  usagePercent: null,
  usedGb: null,
  totalGb: null,
  fsType: "NTFS",
} as unknown as HardwareSnapshot["disk"];

function snapshot(battery: HardwareSnapshot["battery"]): HardwareSnapshot {
  return {
    cpu: { usage: 7, model: "AMD Ryzen 5 5600", cores: 6, speed: 3.5, temperature: null, temperatureStatus: "unavailable" },
    ram: { usagePercent: 51, usedGb: 15.8, totalGb: 30.9 },
    disk: DISK,
    network: { rxSec: 1024, txSec: 512, interfaceName: "Ethernet" },
    battery,
    gpu: { usagePercent: null, vramTotalMb: 6128, vramUsedMb: null, temperature: null, model: "AMD Radeon RX 5600 XT", temperatureStatus: "unavailable" },
    system: { uptime: 3600, platform: "win32", osVersion: "10.0.26300", hostname: "PC" },
    topProcessesByCpu: [],
    topProcessesByRam: [],
    stressScore: 0,
    stressContributions: { cpu: 0, ram: 0, temperature: 0, gpu: 0 },
    alerts: [],
    timestamp: "2026-10-10T13:00:00.000Z",
  } as unknown as HardwareSnapshot;
}

const PRESENT = { hasBattery: true, percent: 78, isCharging: false, timeRemaining: 125 };
const NO_READ = { hasBattery: false, percent: 0, isCharging: false, timeRemaining: null };

const renderSimple = (battery: HardwareSnapshot["battery"], dataOrigin?: "LIVE" | "CACHED" | "UNAVAILABLE") =>
  renderToStaticMarkup(createElement(PCCenterPage, { hardware: snapshot(battery), dataOrigin }));

describe("helper batteryDisplay — contrato real, sem fabricar", () => {
  test("percentagem finita e válida vira estado presente", () => {
    const d = batteryDisplay(PRESENT, "LIVE");
    assert.equal(d.label, "Bateria");
    assert.equal(d.percentText, "78%");
    assert.equal(d.timeText, "~2h 5m restantes");
  });

  test("hasBattery=false NÃO vira 0% nem afirma 'sem bateria' como facto", () => {
    const d = batteryDisplay(NO_READ, "LIVE");
    assert.equal(d.label, "Sem bateria ou sem leitura");
    assert.equal(d.percentText, null);
  });

  test("percent=0 com hasBattery=true NÃO é apresentado como 0% medido", () => {
    const d = batteryDisplay({ ...PRESENT, percent: 0 }, "LIVE");
    assert.equal(d.percentText, null);
    assert.equal(d.label, "Percentagem indisponível");
  });

  test("LIVE e CACHED não afirmam que o ciclo periódico está por começar nem parado", () => {
    for (const origin of ["LIVE", "CACHED"] as const) {
      const note = batteryDisplay(PRESENT, origin).snapshotNote ?? "";
      assert.ok(note.length > 0, `${origin} sem nota`);
      assert.doesNotMatch(note, /ciclo|comeu|ainda não|parad/i, `${origin}: nota afirma ciclo inativo`);
    }
    assert.equal(batteryDisplay(PRESENT, "UNAVAILABLE").snapshotNote, null);
  });

  test("a idade da nota vem do updatedAt real; sem updatedAt não inventa hora", () => {
    const now = Date.parse("2026-10-19T12:00:00.000Z");
    const cached = batteryDisplay(PRESENT, "CACHED", "2026-10-19T11:58:00.000Z", now).snapshotNote ?? "";
    assert.match(cached, /medida há 2 min/);
    const live = batteryDisplay(PRESENT, "LIVE", "2026-10-19T11:59:50.000Z", now).snapshotNote ?? "";
    assert.match(live, /Dados do serviço; última leitura há 10 s\./);
    const semHora = batteryDisplay(PRESENT, "CACHED", null, now).snapshotNote ?? "";
    assert.match(semHora, /hora da medição não está disponível/);
    const futuro = batteryDisplay(PRESENT, "CACHED", "2026-10-19T13:00:00.000Z", now).snapshotNote ?? "";
    assert.doesNotMatch(futuro, /medida/, "timestamp futuro não é idade");
  });

  test("percentagem NaN/fora de 0..100 não aparece", () => {
    assert.equal(batteryDisplay({ ...PRESENT, percent: Number.NaN }, "LIVE").percentText, null);
    assert.equal(batteryDisplay({ ...PRESENT, percent: 140 }, "LIVE").percentText, null);
  });

  test("autonomia só existe a descarregar e com valor positivo finito", () => {
    assert.equal(batteryDisplay({ ...PRESENT, isCharging: true }, "LIVE").timeText, null);
    assert.equal(batteryDisplay({ ...PRESENT, timeRemaining: 0 }, "LIVE").timeText, null);
  });

  test("CACHED e UNAVAILABLE são marcados explicitamente", () => {
    assert.equal(batteryDisplay(PRESENT, "CACHED").origin, "CACHED");
    assert.equal(batteryDisplay(PRESENT, "UNAVAILABLE").label, "Indisponível");
  });
});

// CONTRATO_ESTAVEL_BATTERY (OpenCode): battery.status decide; status ainda não está em shared.
const withStatus = (status: string, extra: Record<string, unknown> = {}) =>
  ({ hasBattery: false, percent: 0, isCharging: false, timeRemaining: null, status, ...extra }) as unknown as HardwareSnapshot["battery"];

describe("contrato battery.status (CONTRATO_ESTAVEL_BATTERY)", () => {
  test("present com percent 0 é leitura REAL: mostra 0%", () => {
    const d = batteryDisplay(withStatus("present", { hasBattery: true, percent: 0 }), "LIVE");
    assert.equal(d.percentText, "0%");
    assert.equal(d.label, "Bateria");
  });

  test("absent é a única ausência mostrada como 'Sem bateria'", () => {
    const d = batteryDisplay(withStatus("absent"), "LIVE");
    assert.equal(d.label, "Sem bateria");
    assert.equal(d.percentText, null);
  });

  test("unavailable e error NUNCA aparecem como 'sem bateria'", () => {
    for (const s of ["unavailable", "error"]) {
      const d = batteryDisplay(withStatus(s), "LIVE");
      assert.doesNotMatch(d.label, /sem bateria/i, s);
      assert.doesNotMatch(d.hint ?? "", /sem bateria/i, s);
      assert.equal(d.percentText, null, s);
    }
    assert.equal(batteryDisplay(withStatus("unavailable"), "LIVE").label, "Bateria indisponível");
    assert.equal(batteryDisplay(withStatus("error"), "LIVE").label, "Erro ao ler a bateria");
  });

  test("timeRemaining null (ou 0) a descarregar é '—', nunca '0 min'", () => {
    assert.equal(batteryDisplay(withStatus("present", { hasBattery: true, percent: 50, timeRemaining: null }), "LIVE").timeText, "—");
    assert.equal(batteryDisplay(withStatus("present", { hasBattery: true, percent: 50, timeRemaining: 0 }), "LIVE").timeText, "—");
  });

  test("present com updatedAt válido mostra a idade da última leitura boa", () => {
    const at = new Date(Date.now() - 120_000).toISOString();
    const html = renderSimple(withStatus("present", { hasBattery: true, percent: 42, updatedAt: at }) as HardwareSnapshot["battery"], "LIVE");
    assert.match(html, /Lida há 2 min/);
  });

  test("present sem updatedAt não inventa idade", () => {
    const html = renderSimple(withStatus("present", { hasBattery: true, percent: 42 }) as HardwareSnapshot["battery"], "LIVE");
    assert.doesNotMatch(html, /Lida há/);
  });

  test("snapshot antigo sem status segue o caminho legado", () => {
    const legacy = { hasBattery: false, percent: 0, isCharging: false, timeRemaining: null } as HardwareSnapshot["battery"];
    assert.equal(batteryDisplay(legacy, "LIVE").label, "Sem bateria ou sem leitura");
  });
});

describe("antiguidade do snapshot guardado", () => {
  const NOW = Date.parse("2026-10-19T12:00:00.000Z");
  test("timestamp válido dá idade", () => {
    assert.equal(snapshotAgeText("2026-10-19T11:59:30.000Z", NOW), "há 30 s");
    assert.equal(snapshotAgeText("2026-10-19T11:30:00.000Z", NOW), "há 30 min");
    assert.equal(snapshotAgeText("2026-10-19T09:00:00.000Z", NOW), "há 3 h");
  });
  test("timestamp inválido ou futuro NÃO inventa idade", () => {
    assert.equal(snapshotAgeText("lixo", NOW), null);
    assert.equal(snapshotAgeText(undefined, NOW), null);
    assert.equal(snapshotAgeText("2026-10-20T00:00:00.000Z", NOW), null);
  });
});

describe("origem real do PC Center (sem DEMO inferido)", () => {
  test("serviço ligado com snapshot = LIVE", () => {
    assert.equal(pcCenterDataOrigin({ hasSnapshot: true, serviceConnected: true }), "LIVE");
    assert.equal(pcCenterDataOrigin({ hasSnapshot: true, serviceConnected: null }), "LIVE");
  });

  test("ligação caída com última leitura real = CACHED", () => {
    assert.equal(pcCenterDataOrigin({ hasSnapshot: true, serviceConnected: false }), "CACHED");
  });

  test("sem snapshot = UNAVAILABLE, nunca DEMO", () => {
    assert.equal(pcCenterDataOrigin({ hasSnapshot: false, serviceConnected: false }), "UNAVAILABLE");
    assert.equal(pcCenterDataOrigin({ hasSnapshot: false, serviceConnected: null }), "UNAVAILABLE");
  });
});

describe("PC Center — bateria na visão Simples (SSR)", () => {
  test("presente: mostra percentagem, estado e autonomia", () => {
    const html = renderSimple(PRESENT, "LIVE");
    assert.match(html, /data-testid="simple-battery"/);
    assert.match(html, />78%</);
    assert.match(html, /A descarregar/);
    assert.match(html, /2h 5m restantes/);
    assert.match(html, /Dados do serviço/);
    assert.doesNotMatch(html, /ciclo periódico ainda não comeu/);
  });

  test("sem leitura de bateria: texto explícito e nunca 0%", () => {
    const html = renderSimple(NO_READ, "LIVE");
    assert.match(html, /data-testid="simple-battery"/);
    assert.match(html, /Sem bateria ou sem leitura/);
    const block = html.slice(html.indexOf('data-testid="simple-battery"'));
    assert.doesNotMatch(block.slice(0, 600), />0%</);
  });

  test("cache: a última leitura fica marcada como tal", () => {
    const html = renderSimple(PRESENT, "CACHED");
    assert.match(html, />78%</);
    assert.match(html, /Última leitura/);
  });

  test("cache: aviso do snapshot inteiro com antiguidade, não só na bateria", () => {
    const html = renderSimple(PRESENT, "CACHED");
    assert.match(html, /Última leitura guardada · há /);
    assert.match(html, /não são atuais/);
  });

  test("LIVE não mostra o aviso de cache", () => {
    assert.doesNotMatch(renderSimple(PRESENT, "LIVE"), /não são atuais/);
  });

  test("UNAVAILABLE: sem percentagem e com indicação de indisponível", () => {
    const html = renderSimple(PRESENT, "UNAVAILABLE");
    assert.match(html, /Indisponível/);
    assert.doesNotMatch(html, />78%</);
  });

  test("sem saúde no contrato: nenhum rótulo de saúde da bateria é mostrado", () => {
    const html = renderSimple(PRESENT, "LIVE");
    assert.doesNotMatch(html, /Saúde da bateria/i);
  });
});
