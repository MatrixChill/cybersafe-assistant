import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineHealth, HardwareSnapshot } from "@cybersafe/shared-types";
import { batteryDisplay, BATTERY_ESTIMATE_UNAVAILABLE } from "../src/lib/batteryDisplay";
import {
  cpuTemperatureProvenance,
  diskActivitySource,
  diskActivityUnavailableLinux,
  diskNoReadReason,
  temperatureUnavailableHint,
} from "../src/lib/platformSources";
import { dashboardLimitationSummary, engineCards, friendlyEngineReason, STATE_LABEL } from "../src/v2/dashboard/model";
import { deriveProtectionLevel } from "../src/lib/protectionHealth";
import { visualCoreMode } from "../src/lib/visualCore";

/**
 * UX Linux (14/11): bateria sem estimativas absurdas, motores com estados
 * curtos e honestos, sem vestígios de Windows em Linux, e Windows inalterado.
 */

type Battery = HardwareSnapshot["battery"];
const present = (over: Partial<Battery>): Battery =>
  ({ hasBattery: true, percent: 80, isCharging: false, timeRemaining: null, status: "present", ...over }) as Battery;

test("bateria: 216 h (taxa ~0) → «Estimativa indisponível», percentagem e estado separados", () => {
  const d = batteryDisplay(present({ timeRemaining: 216 * 60, source: "linux:sysfs-power_supply" }), "LIVE");
  assert.equal(d.timeText, BATTERY_ESTIMATE_UNAVAILABLE);
  assert.equal(d.percentText, "80%");
  assert.equal(d.chargingText, "A descarregar");
  assert.equal(d.sourceText, "Origem: kernel Linux (/sys/class/power_supply)");
});

test("bateria: taxa zero/ausente/incoerente → «Estimativa indisponível»; plausível → tempo", () => {
  for (const t of [null, 0, -5, Number.NaN, 2000]) {
    assert.equal(batteryDisplay(present({ timeRemaining: t as number | null }), "LIVE").timeText, BATTERY_ESTIMATE_UNAVAILABLE);
  }
  assert.equal(batteryDisplay(present({ percent: 5, timeRemaining: 300 }), "LIVE").timeText, BATTERY_ESTIMATE_UNAVAILABLE);
  assert.equal(batteryDisplay(present({ timeRemaining: 125 }), "LIVE").timeText, "~2h 5m restantes");
  assert.equal(batteryDisplay(present({ isCharging: true, timeRemaining: 125 }), "LIVE").timeText, null);
});

test("bateria: sem bateria real → «Sem bateria», sem métricas", () => {
  const d = batteryDisplay({ hasBattery: false, percent: 0, isCharging: false, timeRemaining: null, status: "absent" } as Battery, "LIVE");
  assert.equal(d.label, "Sem bateria");
  assert.equal(d.percentText, null);
  assert.equal(d.timeText, null);
  assert.equal(d.chargingText, null);
});

test("bateria Windows: a origem histórica não ganha linha nova", () => {
  assert.equal(batteryDisplay(present({ source: "systeminformation", timeRemaining: 125 }), "LIVE").sourceText, null);
});

test("fontes de leitura: Linux nomeia fontes Linux; Windows mantém o texto exato", () => {
  assert.equal(cpuTemperatureProvenance("linux", false), "Sensores do kernel Linux (hwmon / lm-sensors)");
  assert.equal(cpuTemperatureProvenance("Windows", false), "Leitura do Windows");
  assert.equal(cpuTemperatureProvenance("linux", true), "Última leitura guardada");
  assert.doesNotMatch(temperatureUnavailableHint("linux", "W"), /Windows/);
  assert.equal(temperatureUnavailableHint("Windows", "W"), "W");
  assert.doesNotMatch(diskNoReadReason("linux"), /Windows/);
  assert.equal(diskNoReadReason("Windows"), "O Windows não devolveu uma leitura do armazenamento.");
  assert.equal(diskActivitySource("linux", "PDH"), null);
  assert.equal(diskActivitySource("Windows", "PDH"), "PDH");
  assert.match(diskActivityUnavailableLinux("linux") ?? "", /Linux/);
  assert.equal(diskActivityUnavailableLinux("Windows"), null);
});

test("PC Center não escreve «Leitura do Windows» de forma fixa", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "src", "pages", "PCCenterPage.tsx"), "utf8");
  assert.doesNotMatch(src, /"Leitura do Windows"/);
  assert.doesNotMatch(src, /"O Windows não devolveu uma leitura do armazenamento\."/);
});

const linuxEngine = {
  serviceRunning: true,
  osLayerHealthy: true,
  anyEngineDegraded: true,
  monitoredPaths: [],
  degradedReasons: [
    "ClamAV: unavailable — clamscan not found or failed: spawn clamscan ENOENT",
    "YARA: unavailable — YARA clássico indisponível neste sistema (procurado em CYBERSAFE_YARA_BIN_DIR, resources/yara e vendor/yara (procura em yara e yarac); em POSIX os binários de Windows não são aceites).",
  ],
  yara: { status: "unavailable", reason: "not-installed", detail: "YARA clássico indisponível neste sistema" },
  hashDb: { status: "active" },
  clamav: { status: "unavailable", detail: "clamscan not found or failed: spawn clamscan ENOENT" },
  nativeEngine: { status: "active" },
} as unknown as EngineHealth;

test("Dashboard: razões técnicas dos motores viram frases curtas (sem ENOENT nem caminhos)", () => {
  const summary = dashboardLimitationSummary(linuxEngine) ?? "";
  assert.equal(summary, "ClamAV não instalado · YARA não instalado");
  assert.doesNotMatch(summary, /ENOENT|spawn|vendor|CYBERSAFE_/);
  // Razões que a normalização não reconhece ficam como o serviço as disse.
  assert.equal(friendlyEngineReason("Filtro WFP: unavailable — filtro inativo", linuxEngine), "Filtro WFP: unavailable — filtro inativo");
});

test("cartões de motor: «Não instalado» e nunca «Erro crítico» por falta de motor", () => {
  const cards = engineCards(linuxEngine, true);
  assert.equal(cards.find((c) => c.key === "clamav")?.label, "Não instalado");
  assert.equal(cards.find((c) => c.key === "yara")?.label, "Não instalado");
  assert.doesNotMatch(cards.find((c) => c.key === "clamav")?.friendly?.texto ?? "", /ENOENT/);
  assert.notEqual(deriveProtectionLevel("degraded", linuxEngine), "critical");
});

test("cartões de motor Windows ativos mantêm o rótulo histórico", () => {
  const ok = { ...linuxEngine, yara: { status: "active" }, clamav: { status: "active" } } as unknown as EngineHealth;
  const cards = engineCards(ok, true);
  assert.equal(cards.find((c) => c.key === "clamav")?.label, STATE_LABEL.ACTIVE);
  assert.equal(cards.find((c) => c.key === "clamav")?.state, "ACTIVE");
});

test("Visual Core: WebGL só com GPU e sem reduced-motion; reduced-motion para o movimento", () => {
  assert.deepEqual(visualCoreMode({ gpu: true, systemReduced: false, failed: false, animate: true }), { renderer: "webgl", motion: true });
  assert.deepEqual(visualCoreMode({ gpu: true, systemReduced: true, failed: false, animate: true }), { renderer: "css", motion: false });
  assert.deepEqual(visualCoreMode({ gpu: false, systemReduced: false, failed: false, animate: true }), { renderer: "css", motion: true });
  assert.deepEqual(visualCoreMode({ gpu: true, systemReduced: false, failed: true, animate: false }), { renderer: "css", motion: false });
  assert.equal(visualCoreMode({ gpu: true, systemReduced: false, failed: false, animate: true, renderer: "css" }).renderer, "css");
  assert.equal(visualCoreMode({ gpu: true, systemReduced: false, failed: false, animate: true, productAnimate: false }).motion, false);
});
