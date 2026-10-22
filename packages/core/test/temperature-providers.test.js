import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import {
  readTemperature,
  disposeTempHelper,
  SystemInformationProvider,
  AcpiProvider,
} from "../dist/temperature.js";

/**
 * Regressão de segurança: o CyberSafe não pode voltar a publicar a temperatura
 * com o driver WinRing0 (VulnerableDriver:WinNT/Winring0, CVE-2020-14979).
 *
 * Origem do incidente: `packages/temperature-server` (sidecar C#) usava
 * LibreHardwareMonitorLib 0.9.4, que embute `WinRing0.gz`/`WinRing0x64.gz` e os
 * extrai em runtime para o disco com o nome do executável + ".sys" — no nosso
 * caso `cybersafe-temp-helper.sys`, bloqueado pelo Defender.
 */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DIST_TEMPERATURE = path.resolve(__dirname, "..", "dist", "temperature.js");

/** Construtores que só existem se um driver de ring0 voltar à cadeia. */
const FORBIDDEN_IN_BUNDLE = [
  "spawn(",
  "net.connect(",
  "Add-Type",
  "LHM_SEARCH_PATHS",
  "PWSH_LHM_PROBE",
  "TempHelperProvider",
  "LibreHardwareMonitorProvider",
  "findTempHelperExe",
  "helperRequest",
  "CYBERSAFE_TEMP_HELPER",
  "cybersafe-lhm-",
];

function listFilesRecursive(dir, options = {}) {
  const skip = new Set(options.skip ?? []);
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, options));
    else out.push(full);
  }
  return out;
}

describe("Cadeia de temperatura — remoção do driver WinRing0", () => {
  it("o bundle compilado não contém nenhum caminho para o helper/driver", () => {
    const source = fs.readFileSync(DIST_TEMPERATURE, "utf8");
    for (const forbidden of FORBIDDEN_IN_BUNDLE) {
      assert.ok(
        !source.includes(forbidden),
        `temperature.js não pode conter "${forbidden}" (caminho de driver/ring0 removido)`,
      );
    }
  });

  it("mantém o systeminformation como fonte segura de GPU (nunca a integrada)", () => {
    const source = fs.readFileSync(DIST_TEMPERATURE, "utf8");
    assert.ok(source.includes("systeminformation"), "systeminformation deve continuar na cadeia");
    assert.ok(
      source.includes("gpu-selection.js"),
      "a escolha da GPU dedicada tem de continuar a ser usada na leitura segura",
    );
  });

  it("o pacote temperature-server (dependência vulnerável) já não existe no repositório", () => {
    assert.equal(
      fs.existsSync(path.join(REPO_ROOT, "packages", "temperature-server")),
      false,
      "packages/temperature-server dependia de LibreHardwareMonitorLib (WinRing0)",
    );
  });

  it("nenhum ficheiro .sys é distribuído pelo repositório", () => {
    const files = listFilesRecursive(REPO_ROOT, { skip: ["node_modules", ".git", "release"] });
    const drivers = files.filter((f) => f.toLowerCase().endsWith(".sys"));
    assert.deepEqual(drivers, [], "nenhum driver kernel deve existir no repositório");
  });

  it("nenhum binário do repositório transporta o driver WinRing0", () => {
    const files = listFilesRecursive(REPO_ROOT, { skip: ["node_modules", ".git", "release"] });
    const binaries = files.filter((f) => /\.(dll|exe|sys|gz|node)$/i.test(f));
    const carriers = [];
    for (const file of binaries) {
      let buffer;
      try {
        buffer = fs.readFileSync(file);
      } catch {
        continue;
      }
      if (
        buffer.includes("WinRing0", 0, "latin1") ||
        buffer.includes("WinRing0", 0, "utf16le")
      ) {
        carriers.push(path.relative(REPO_ROOT, file));
      }
    }
    assert.deepEqual(carriers, [], "nenhum binário pode transportar/extrair WinRing0");
  });

  it("provider ausente → indisponível, nunca 0 °C, NaN ou valor antigo", { timeout: 60_000 }, async () => {
    // Mesmo que alguém volte a definir o apontador do antigo sidecar, ele é ignorado.
    process.env.CYBERSAFE_TEMP_HELPER = process.execPath;

    const reading = await readTemperature();

    assert.equal(typeof reading.source, "string");
    assert.ok(reading.source.length > 0);
    for (const forbidden of ["TempHelper", "LibreHardwareMonitor"]) {
      assert.ok(!reading.source.includes(forbidden), `fonte insegura publicada: ${reading.source}`);
    }
    for (const field of ["cpuPackageC", "cpuCoreMaxC", "gpuCoreC", "gpuHotspotC", "gpuMemoryJunctionC"]) {
      const value = reading[field];
      assert.ok(
        value === null || (Number.isFinite(value) && value > 0 && value <= 150),
        `${field} deve ser null ou um valor plausível (recebido ${String(value)})`,
      );
    }
    assert.ok(Array.isArray(reading.nvme) && Array.isArray(reading.motherboard) && Array.isArray(reading.fans));
    assert.ok(Number.isFinite(Date.parse(reading.timestamp)), "timestamp deve ser válido");

    delete process.env.CYBERSAFE_TEMP_HELPER;
  });

  it("a ausência do helper/.sys não quebra a leitura (cache estável)", { timeout: 60_000 }, async () => {
    await readTemperature();
    const cached = await readTemperature();
    const cachedAgain = await readTemperature();
    assert.equal(cachedAgain, cached, "chamadas consecutivas vêm da cache, sem novo spawn");
  });

  it("disposeTempHelper é um no-op idempotente", () => {
    assert.doesNotThrow(() => {
      disposeTempHelper();
      disposeTempHelper();
      disposeTempHelper();
    });
  });

  it("apenas providers user-mode continuam exportados", () => {
    assert.equal(typeof SystemInformationProvider, "function");
    assert.equal(typeof AcpiProvider, "function");
    assert.equal(new SystemInformationProvider().name, "systeminformation");
    assert.equal(new AcpiProvider().name, "ACPI");
  });

  it("os providers seguros respondem sem lançar (GPU incluída)", { timeout: 60_000 }, async () => {
    const si = new SystemInformationProvider();
    const acpi = new AcpiProvider();
    assert.equal(typeof (await si.isAvailable()), "boolean");
    assert.equal(typeof (await acpi.isAvailable()), "boolean");
    if (await si.isAvailable()) {
      const reading = await si.read();
      assert.ok(
        reading.gpuCoreC === null || (reading.gpuCoreC > 0 && reading.gpuCoreC <= 150),
        "GPU lida pelo systeminformation tem de ser plausível",
      );
    }
  });
});
