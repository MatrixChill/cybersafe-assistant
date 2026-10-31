// ── Leitura de kernel32 (user-mode) para memória e energia ───────────────────
//
// PORQUÊ este ficheiro existir, quando o `systeminformation` já dá RAM e
// bateria: medido nesta máquina (26/10, evidence/SONDA-FONTES-20261026.txt),
// cada chamada do SI que interessa abre um processo PowerShell e custa
// 250–1420 ms (`si.mem` 1 shell/250 ms, `si.battery` 3 shells/307 ms). O
// `GlobalMemoryStatusEx` e o `GetSystemPowerStatus` do kernel32 dão os números
// de que o PC Center precisa com **zero subprocessos e sub-milissegundo**, e são
// a mesma fonte que o Gestor de Tarefas usa. Isto é o requisito §3 "preferir
// APIs nativas; PowerShell apenas quando necessário" aplicado a dois campos.
//
// O que o kernel32 prova e o SI não prova:
//   * limite de compromisso e compromisso em uso (o `swaptotal` do SI é o
//     além-físico, NÃO o limite — cruzado: 30,88 + 16 = 46,88 GB = limite do
//     kernel32, medido);
//   * se a máquina tem bateria (flag 0x80) e em que alimentação está, sem
//     inventar 0 % numa máquina de secretária.
//
// SEGURANÇA: `koffi` é `optionalDependency`. Se não estiver instalado, ou se o
// binding falhar, o resultado é `unavailable` com o motivo — o campo fica
// "Sensor indisponível" na UI, nunca 0. Estas duas funções não precisam do
// worker isolado que a ADL exige: lêem estruturas de 64/12 bytes providas por
// nós próprios e não chamam código de fornecedor de terceiros; correr no
// processo do serviço não pode rebentar o serviço.
//
// Honestidade de unidades: tudo o que sai daqui são BYTES e percentagens
// adimensionais, tal como o kernel os devolve. Conversões (GB, minutos) são
// feitas na camada de apresentação, para que a aquisição não decida como se
// mostra.

import { createRequire } from "node:module";
import process from "node:process";

export type KernelReading<T> =
  | { status: "ok"; value: T }
  | { status: "unavailable"; reason: string };

/** `MEMORYSTATUSEX` (winnt.h): 8×DWORD/2×… com alinhamento de 8 → 64 bytes. */
const MEMORYSTATUSEX_SIZE = 64;
const MEM_OFFSET = {
  dwLength: 0,
  dwMemoryLoad: 4,
  ullTotalPhys: 8,
  ullAvailPhys: 16,
  ullTotalPageFile: 24,
  ullAvailPageFile: 32,
  ullTotalVirtual: 40,
} as const;

/** `SYSTEM_POWER_STATUS` (powrprof.h): 4×BYTE followed by 2×BOOL (int32). */
const POWER_STATUS_SIZE = 12;
const POWER_OFFSET = {
  acLineStatus: 0,
  batteryFlag: 1,
  batteryLifePercent: 2,
  systemStatus: 3,
  batteryLifeTime: 4,
  batteryFullLifeTime: 8,
} as const;

/** Bit documented em GetSystemPowerStatus: "não há bateria no sistema". */
const BATTERY_FLAG_NONE = 0x80;
const BATTERY_FLAG_CHARGING = 0x08;
/** 255 = "sem informação"; -1 (0xFFFFFFFF) = "desconhecido" nos tempos de vida. */
const PERCENT_UNKNOWN = 255;
const TIME_UNKNOWN = -1;

export interface KernelMemoryStatus {
  totalPhysBytes: number;
  availPhysBytes: number;
  /** Limite de compromisso físico + página (Task Manager: "Disponível/Limite"). */
  commitLimitBytes: number;
  commitAvailBytes: number;
  /** Percentagem de memória física em uso, reportada pelo próprio kernel. */
  memoryLoadPercent: number;
  totalVirtualBytes: number;
  acquiredAt: string;
}

export interface KernelPowerStatus {
  /** `on` = adaptador ligado; `off` = a baterias; `unknown` = 255/ilegível. */
  acLine: "on" | "off" | "unknown";
  /** Só `false` quando o kernel afirma que não há bateria (flag 0x80). */
  hasBattery: boolean;
  /** `null` = o kernel não sabe (255). Nunca 0 %. */
  batteryPercent: number | null;
  /** Minutos restantes declarados pelo sistema; `null` quando desconhecido. */
  remainingMinutes: number | null;
  /** Só tem significado quando `hasBattery`. */
  isCharging: boolean | null;
  /** Estados de suspensão/ligação do POWRPROF, passados sem interpretação. */
  systemStatus: number;
  /** A bateria está sob o limiar crítico declarado pelo sistema. */
  batteryLow: boolean;
  acquiredAt: string;
}

interface Kernel32Bindings {
  GlobalMemoryStatusEx: (buffer: Buffer) => boolean;
  GetSystemPowerStatus: (buffer: Buffer) => boolean;
}

let bindings: KernelReading<Kernel32Bindings> | null = null;

function loadKernel32(): KernelReading<Kernel32Bindings> {
  if (bindings) return bindings;
  if (process.platform !== "win32") {
    bindings = { status: "unavailable", reason: "plataforma-nao-suportada" };
    return bindings;
  }
  try {
    const require = createRequire(import.meta.url);
    const koffi = require("koffi") as {
      load(name: string): { func(proto: string): (...args: unknown[]) => unknown };
    };
    const kernel32 = koffi.load("kernel32.dll");
    bindings = {
      status: "ok",
      value: {
        GlobalMemoryStatusEx: kernel32.func(
          "bool __stdcall GlobalMemoryStatusEx(void* buffer)",
        ) as (buffer: Buffer) => boolean,
        GetSystemPowerStatus: kernel32.func(
          "bool __stdcall GetSystemPowerStatus(void* status)",
        ) as (buffer: Buffer) => boolean,
      },
    };
  } catch (error) {
    // `koffi` ausente (instalação opcional) é um estado normal, não uma exceção
    // a propagar: a memória e a energia ficam simplesmente indisponíveis.
    bindings = {
      status: "unavailable",
      reason: `ffi-indisponivel:${error instanceof Error ? error.message.slice(0, 120) : "desconhecido"}`,
    };
  }
  return bindings;
}

const bytes = (buffer: Buffer, offset: number): number =>
  Number(buffer.readBigUInt64LE(offset));

/** Aceita apenas contagens de bytes fisicamente possíveis; nada é clampado. */
function plausibleBytes(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 2 ** 53;
}

/**
 * Costura de teste, no mesmo espírito do `execImpl` do `AcpiProvider`: permite
 * provar a validação (leituras imposíveis, API a devolver falso, buffer curto)
 * sem depender do hardware de quem corre a suite. Em produção é omitido.
 */
export interface KernelReaderOptions {
  bindings?: Kernel32Bindings;
  now?: () => Date;
}

export function readMemoryStatus(
  options: KernelReaderOptions = {},
): KernelReading<KernelMemoryStatus> {
  const bind = options.bindings
    ? { status: "ok", value: options.bindings } as const
    : loadKernel32();
  if (bind.status === "unavailable") return bind;
  const now = options.now ?? (() => new Date());
  const buffer = Buffer.alloc(MEMORYSTATUSEX_SIZE);
  // dwLength tem de ser preenchido ANTES da chamada, ou a API falha sempre.
  buffer.writeUInt32LE(MEMORYSTATUSEX_SIZE, MEM_OFFSET.dwLength);
  let ok = false;
  try {
    ok = bind.value.GlobalMemoryStatusEx(buffer) === true;
  } catch {
    return { status: "unavailable", reason: "GlobalMemoryStatusEx lançou" };
  }
  if (!ok) return { status: "unavailable", reason: "GlobalMemoryStatusEx devolveu falso" };
  if (buffer.readUInt32LE(MEM_OFFSET.dwLength) !== MEMORYSTATUSEX_SIZE) {
    return { status: "unavailable", reason: "dwLength não confirmado pela API" };
  }

  const totalPhysBytes = bytes(buffer, MEM_OFFSET.ullTotalPhys);
  const availPhysBytes = bytes(buffer, MEM_OFFSET.ullAvailPhys);
  const commitLimitBytes = bytes(buffer, MEM_OFFSET.ullTotalPageFile);
  const commitAvailBytes = bytes(buffer, MEM_OFFSET.ullAvailPageFile);
  const totalVirtualBytes = bytes(buffer, MEM_OFFSET.ullTotalVirtual);
  const memoryLoadPercent = buffer.readUInt32LE(MEM_OFFSET.dwMemoryLoad);

  const incoerente =
    !plausibleBytes(totalPhysBytes) ||
    !plausibleBytes(commitLimitBytes) ||
    // O limite de compromisso inclui a física: ser menor é impossível.
    commitLimitBytes < totalPhysBytes ||
    availPhysBytes > totalPhysBytes ||
    commitAvailBytes > commitLimitBytes ||
    memoryLoadPercent > 100;
  if (incoerente) {
    return { status: "unavailable", reason: "leitura do kernel incoerente" };
  }

  return {
    status: "ok",
    value: {
      totalPhysBytes,
      availPhysBytes,
      commitLimitBytes,
      commitAvailBytes,
      memoryLoadPercent,
      totalVirtualBytes,
      acquiredAt: now().toISOString(),
    },
  };
}

export function readPowerStatus(
  options: KernelReaderOptions = {},
): KernelReading<KernelPowerStatus> {
  const bind = options.bindings
    ? { status: "ok", value: options.bindings } as const
    : loadKernel32();
  if (bind.status === "unavailable") return bind;
  const now = options.now ?? (() => new Date());
  const buffer = Buffer.alloc(POWER_STATUS_SIZE);
  let ok = false;
  try {
    ok = bind.value.GetSystemPowerStatus(buffer) === true;
  } catch {
    return { status: "unavailable", reason: "GetSystemPowerStatus lançou" };
  }
  if (!ok) return { status: "unavailable", reason: "GetSystemPowerStatus devolveu falso" };

  const acLineRaw = buffer.readUInt8(POWER_OFFSET.acLineStatus);
  const flag = buffer.readUInt8(POWER_OFFSET.batteryFlag);
  const percentRaw = buffer.readUInt8(POWER_OFFSET.batteryLifePercent);
  const lifeTime = buffer.readInt32LE(POWER_OFFSET.batteryLifeTime);
  const acquiredAt = now().toISOString();

  return {
    status: "ok",
    value: {
      acLine: acLineRaw === 1 ? "on" : acLineRaw === 0 ? "off" : "unknown",
      hasBattery: (flag & BATTERY_FLAG_NONE) === 0,
      batteryPercent: percentRaw === PERCENT_UNKNOWN ? null : percentRaw,
      remainingMinutes: lifeTime === TIME_UNKNOWN ? null : lifeTime,
      isCharging: (flag & BATTERY_FLAG_NONE) === 0 ? (flag & BATTERY_FLAG_CHARGING) !== 0 : null,
      systemStatus: buffer.readUInt8(POWER_OFFSET.systemStatus),
      batteryLow: (flag & 0x01) !== 0,
      acquiredAt,
    },
  };
}

/** Motivo da indisponibilidade, para a UI poder explicar em vez de calar. */
export function kernelUnavailableReason(
  reading: KernelReading<unknown>,
): string | null {
  return reading.status === "unavailable" ? reading.reason : null;
}
