import { exec } from "child_process";
import { promisify } from "util";
import * as si from "systeminformation";
import type { TemperatureProvider, TemperatureReading } from "./temperature-provider.js";
import { isDedicatedGpu } from "./gpu-selection.js";

const execAsync = promisify(exec);

// ── SEGURANÇA: por que não existe leitura de CPU em modo kernel ──
// A cadeia anterior tinha dois providers assentes em LibreHardwareMonitor:
//   1. `TempHelper` — sidecar C# (packages/temperature-server) com
//      LibreHardwareMonitorLib 0.9.4;
//   2. `LibreHardwareMonitor` — carregamento dinâmico de uma
//      LibreHardwareMonitorLib.dll instalada localmente.
// A LibreHardwareMonitorLib ≤ 0.9.5-pre453 embute o driver WinRing0
// (`WinRing0.gz` / `WinRing0x64.gz`) e extrai-o em runtime como
// `<nome-do-executável>.sys` — no nosso caso `cybersafe-temp-helper.sys`.
// O WinRing0 é classificado pela Microsoft como driver vulnerável
// (VulnerableDriver:WinNT/Winring0, CVE-2020-14979) e está na blocklist.
// Um produto de segurança NÃO pode distribuir/carregar esse driver, e não se
// resolve o assunto com exclusões no Defender nem com renomeações.
// Ambos os providers foram REMOVIDOS. A temperatura passa a vir apenas de APIs
// em user-mode (WMI/CIM e APIs de fornecedor expostas pelo systeminformation).
// Se nenhum sensor seguro existir, o campo fica `null` → UI mostra
// "Indisponível". Nunca inventamos nem reutilizamos um valor antigo como atual.

// ── Reading vazio (sentinela para "unavailable") ──
function emptyReading(source: string): TemperatureReading {
  return {
    cpuPackageC: null, cpuCoreMaxC: null, gpuCoreC: null, gpuHotspotC: null, gpuMemoryJunctionC: null,
    gpuCoreSensor: null, gpuHotspotSensor: null,
    nvme: [], motherboard: [], fans: [], source, timestamp: new Date().toISOString(),
  };
}

/**
 * Aceita apenas valores fisicamente plausíveis para um sensor térmico.
 * Um valor fora deste intervalo é tratado como "sem leitura" — nunca é
 * arredondado nem publicado.
 */
function sanitizeTemperature(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value <= 0 || value > 150) return null;
  return Math.round(value);
}

// ── 1. systeminformation (user-mode: WMI/CIM + APIs de fornecedor de GPU) ──
export class SystemInformationProvider implements TemperatureProvider {
  name = "systeminformation";

  async isAvailable(): Promise<boolean> {
    try {
      const [cpuTemp, graphics] = await Promise.all([
        si.cpuTemperature().catch(() => null),
        si.graphics().catch(() => null),
      ]);
      // Este provider é a ÚNICA fonte segura de temperatura de GPU, por isso
      // está "disponível" quando consegue ler CPU *ou* GPU. Um CPU sem sensor
      // seguro (habitual em desktop) não pode desativar a leitura da GPU.
      const cpuOk = (cpuTemp?.main ?? 0) > 0 || (cpuTemp?.cores ?? []).some((c) => (c ?? 0) > 0);
      const gpuOk = (graphics?.controllers ?? []).some(
        (g) => (g.temperatureGpu ?? 0) > 0,
      );
      return cpuOk || gpuOk;
    } catch { return false; }
  }

  async read(): Promise<TemperatureReading> {
    const reading = emptyReading(this.name);
    try {
      const [cpuTemp, gpuTemp] = await Promise.all([
        si.cpuTemperature().catch(() => null),
        si.graphics().catch(() => null),
      ]);
      const cpuPackage = sanitizeTemperature(cpuTemp?.main);
      if (cpuPackage !== null) reading.cpuPackageC = cpuPackage;
      if (cpuTemp?.cores?.length) {
        const valid = cpuTemp.cores
          .map((c) => sanitizeTemperature(c))
          .filter((c): c is number => c !== null);
        if (valid.length) reading.cpuCoreMaxC = Math.max(...valid);
      }
      // Escolhe a GPU DEDICADA (nunca a primeira com temperatura: seria a integrada).
      const gpuControllers = (gpuTemp?.controllers ?? []).filter(
        (g) => sanitizeTemperature(g.temperatureGpu) !== null,
      );
      const chosen = gpuControllers.find((g) => isDedicatedGpu(g.model)) ?? gpuControllers[0];
      const gpuCore = sanitizeTemperature(chosen?.temperatureGpu);
      if (gpuCore !== null) {
        // O systeminformation expõe apenas UMA temperatura por controlador
        // (a principal da GPU) — registamos a proveniência do modelo.
        reading.gpuCoreC = gpuCore;
        reading.gpuCoreSensor = "GPU Core (systeminformation)";
      }
    } catch { /* provider indisponível */ }
    return reading;
  }
}

// ── 2. ACPI WMI (user-mode, sem driver) ──
export class AcpiProvider implements TemperatureProvider {
  name = "ACPI";
  private readonly exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>;

  constructor(execImpl?: (cmd: string) => Promise<{ stdout: string; stderr: string }>) {
    this.exec = execImpl ?? defaultExecAsync;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await this.exec(
        'powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $t = (Get-CimInstance MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object -First 1).CurrentTemperature; if ($t -gt 0) { Write-Output \'ok\' }"',
      );
      return stdout.trim() === "ok";
    } catch { return false; }
  }

  async read(): Promise<TemperatureReading> {
    const reading = emptyReading(this.name);
    try {
      const { stdout } = await this.exec(
        'powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $t = (Get-CimInstance MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object -First 1).CurrentTemperature; if ($t -gt 0) { Write-Output ([math]::Round($t/10 - 273.15)) }"',
      );
      const temp = sanitizeTemperature(parseInt(stdout.trim(), 10));
      // MSAcpi_ThermalZoneTemperature reporta a ZONA TÉRMICA do motherboard,
      // NÃO a CPU Package. Não há prova de que seja a Package — atribuí-la a
      // cpuPackageC seria uma alegação não provada. Registamos como
      // motherboard thermal zone com identificação genérica, deixando
      // cpuPackageC null por honestidade.
      if (temp !== null && temp > -20) {
        reading.motherboard.push({
          name: "ACPI Thermal Zone",
          tempC: temp,
        });
      }
    } catch { /* unavailable */ }
    return reading;
  }
}

/** Wrapper padrão: promisify(exec) com timeout. Teste injeta override via constructor. */
const defaultExecAsync = async (cmd: string): Promise<{ stdout: string; stderr: string }> => {
  const { stdout, stderr } = await execAsync(cmd, { windowsHide: true, timeout: 3000 });
  return { stdout, stderr };
};

/**
 * No-op de compatibilidade: o sidecar de temperatura foi removido (ver nota de
 * segurança no topo do ficheiro). Nenhum processo, driver ou named pipe é
 * iniciado. Chamar isto duas vezes, ou durante o shutdown, é inofensivo.
 */
export function disposeTempHelper(): void {
  // Intencionalmente vazio: não existe nada para encerrar.
}

// ── 3. Composite: lê as fontes seguras e junta campo a campo ──
let lastReading: TemperatureReading | null = null;
let lastReadAt = 0;
const CACHE_TTL_MS = 4000;

export async function readTemperature(): Promise<TemperatureReading> {
  const now = Date.now();
  if (lastReading && (now - lastReadAt) < CACHE_TTL_MS) return lastReading;

  const providers: TemperatureProvider[] = [
    new SystemInformationProvider(),
    new AcpiProvider(),
  ];

  // Merge por campo (primeiro provider, por ordem de prioridade, que leia um
  // valor REAL ganha). Assim a GPU continua a ser lida pelo systeminformation
  // mesmo quando o CPU não tem sensor seguro — e vice-versa.
  const merged = emptyReading("unavailable");
  const contributors: string[] = [];

  for (const provider of providers) {
    try {
      if (!(await provider.isAvailable())) continue;
      const reading = await provider.read();
      let contributed = false;
      if (merged.cpuPackageC === null && reading.cpuPackageC !== null) { merged.cpuPackageC = reading.cpuPackageC; contributed = true; }
      if (merged.cpuCoreMaxC === null && reading.cpuCoreMaxC !== null) { merged.cpuCoreMaxC = reading.cpuCoreMaxC; contributed = true; }
      if (merged.gpuCoreC === null && reading.gpuCoreC !== null) {
        merged.gpuCoreC = reading.gpuCoreC;
        merged.gpuCoreSensor = reading.gpuCoreSensor ?? null;
        contributed = true;
      }
      if (merged.gpuHotspotC === null && reading.gpuHotspotC !== null) {
        merged.gpuHotspotC = reading.gpuHotspotC;
        merged.gpuHotspotSensor = reading.gpuHotspotSensor ?? null;
        contributed = true;
      }
      if (merged.gpuMemoryJunctionC === null && reading.gpuMemoryJunctionC !== null) { merged.gpuMemoryJunctionC = reading.gpuMemoryJunctionC; contributed = true; }
      if (merged.nvme.length === 0 && reading.nvme.length > 0) { merged.nvme = reading.nvme; contributed = true; }
      if (merged.motherboard.length === 0 && reading.motherboard.length > 0) { merged.motherboard = reading.motherboard; contributed = true; }
      if (merged.fans.length === 0 && reading.fans.length > 0) { merged.fans = reading.fans; contributed = true; }
      if (contributed) contributors.push(provider.name);
    } catch { /* próximo provider */ }
  }

  merged.source = contributors.length > 0 ? contributors.join("+") : "unavailable";
  lastReading = merged;
  lastReadAt = now;
  return merged;
}
