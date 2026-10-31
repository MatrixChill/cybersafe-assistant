// ── Normalização PC Center: aquisição crua → campos publicáveis ──────────────
// Camada entre a aquisição (kernel32/SI) e a apresentação. Pura e sem side
// effects de propósito: é aqui que se pode provar, sem hardware, que um dado
// ausente fica `unavailable` e não 0, e que uma derivação fica marcada como
// derivação. Cada função devolve o par (valor, estado) que o snapshot publica.

import type {
  CpuCoreReading,
  DiskActivityReading,
  CpuFrequencyReading,
  MemoryCommitReading,
  PagefileReading,
  PowerReading,
  RamLayoutReading,
  RamModuleReading,
  ReadingStatus,
} from "@cybersafe/shared-types";
import type { KernelMemoryStatus, KernelPowerStatus } from "./win-kernel.js";
import type { PdhVolumeSample } from "./win-pdh.js";

const percent = (raw: unknown): number | null => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 100) return null;
  return Math.round(raw * 10) / 10;
};

/**
 * MHz plausíveis para um processador de desktop/servidor. O intervalo não é
 * arbitrário: abaixo de 100 MHz um core moderno não arranca, e acima de 15 GHz
 * não existe hardware comercial. Um valor fora disto é um erro de fonte — e
 * erro de fonte não se publica como frequência.
 *
 * Também aceita GHz (é o que o `Win32_Processor` do systeminformation devolve
 * em `speedMax`: 4,7 para um 4700 MHz): 0 < valor < 1000 é lido como GHz.
 */
const megahertz = (raw: unknown): number | null => {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  const MHz = raw < 1000 ? raw * 1000 : raw;
  if (MHz < 100 || MHz > 15000) return null;
  return Math.round(MHz);
};

/**
 * Utilização por processador lógico a partir do `cpus[]` do systeminformation.
 * Estrutura desconhecida → `null` (sem leitura), nunca uma lista de zeros:
 * 24 núcleos a 0 % inventados são exatamente o género de mentira que o objetivo
 * proíbe. O `index` é o índice do array, que é o que o Gestor de Tarefas usa.
 */
export function perCoreReading(cpus: unknown): CpuCoreReading[] | null {
  if (!Array.isArray(cpus) || cpus.length === 0) return null;
  const lidos: CpuCoreReading[] = cpus.map((entry, index) => {
    const bruto = (entry as { load?: unknown } | null | undefined)?.load;
    const value = percent(bruto);
    return {
      index,
      percent: value,
      status: value === null ? "unavailable" : "available",
    };
  });
  // Um array em que NENHUM núcleo tem leitura não é uma medição: é a ausência
  // dela a fingir de tabela preenchida.
  return lidos.some((c) => c.percent !== null) ? lidos : null;
}

/**
 * Frequência atual vs. referência.
 *
 * A verdade incómoda medida nesta máquina: `os.cpus()[0].speed` e o
 * `speedMax` do WMI ambos deram 4700 MHz / 4,7 GHz para um 7900X cujo boost vai
 * aos 5,6 GHz. Ou seja, o número "atual" que o OS expõe por aqui é o NOMINAL,
 * não uma contagem do relógio de agora. Por isso `measuredAsCurrent` é `false`
 * quando os dois coincidem — e a UI tem de poder dizer "referência; o OS não
 * expõe o relógio instantâneo nesta configuração" em vez de apresentar um
 * número quieto como se fosse medição contínua.
 */
export function frequencyReading(input: {
  osSpeedMHz: unknown;
  referenceMHz: unknown;
  reason?: string;
}): CpuFrequencyReading {
  const current = megahertz(input.osSpeedMHz);
  const reference = megahertz(input.referenceMHz);
  if (current === null && reference === null) {
    return {
      currentMHz: null,
      referenceMHz: null,
      measuredAsCurrent: false,
      status: "unavailable",
      source: "os.cpus().speed + Win32_Processor",
      ...(input.reason ? { reason: input.reason } : {}),
    };
  }
  const igual = current !== null && reference !== null && current === reference;
  return {
    currentMHz: current,
    referenceMHz: reference,
    // Só afirmamos "medido agora" quando o OS distingue os dois números.
    measuredAsCurrent: !igual,
    status: "available",
    source: "os.cpus().speed + Win32_Processor.MaxClockSpeed",
  };
}

/** Limite/uso de compromisso medidos em kernel32. */
export function commitReading(
  memory: KernelMemoryStatus | null,
  reason?: string,
): MemoryCommitReading {
  if (!memory) {
    return {
      usedBytes: null, limitBytes: null, availableBytes: null,
      status: "unavailable", source: "kernel32!GlobalMemoryStatusEx",
      ...(reason ? { reason } : {}),
    };
  }
  return {
    usedBytes: memory.commitLimitBytes - memory.commitAvailBytes,
    limitBytes: memory.commitLimitBytes,
    availableBytes: memory.commitAvailBytes,
    status: "available",
    source: "kernel32!GlobalMemoryStatusEx",
    updatedAt: memory.acquiredAt,
  };
}

/**
 * Ficheiro de paginação. O TOTAL é derivado (limite de compromisso − RAM
 * física): o kernel não devolve o tamanho do `pagefile.sys`, e chamar-lhe
 * "medido" seria mentira. O `usedBytes` vem do WMI (systeminformation) quando
 * existe; sem ele, `null` — nunca 0 % de página usada.
 */
export function pagefileReading(input: {
  memory: KernelMemoryStatus | null;
  swapTotalBytes?: number | null;
  swapUsedBytes?: number | null;
  updatedAt?: string;
}): PagefileReading {
  const derivado = input.memory
    ? input.memory.commitLimitBytes - input.memory.totalPhysBytes
    : null;
  const total = derivado ?? (typeof input.swapTotalBytes === "number" ? input.swapTotalBytes : null);
  const usado = typeof input.swapUsedBytes === "number" && input.swapUsedBytes >= 0 ? input.swapUsedBytes : null;
  return {
    totalBytes: total,
    usedBytes: usado,
    totalIsDerived: derivado !== null,
    status: total === null ? "unavailable" : "available",
    source: "kernel32!GlobalMemoryStatusEx (derivado) + Win32_OperatingSystem (usado)",
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  };
}

/** Energia/adaptador a partir do kernel32; sem leitura → indisponível com motivo. */
export function powerReading(power: KernelPowerStatus | null, reason?: string): PowerReading {
  if (!power) {
    return {
      acLine: "unknown",
      // Sem leitura NÃO se pode afirmar que não há bateria.
      hasBattery: null,
      isCharging: null,
      batteryPercent: null,
      remainingMinutes: null,
      batteryLow: false,
      status: "unavailable",
      source: "kernel32!GetSystemPowerStatus",
      ...(reason ? { reason } : {}),
    };
  }
  return {
    acLine: power.acLine,
    hasBattery: power.hasBattery,
    isCharging: power.isCharging,
    batteryPercent: power.batteryPercent,
    remainingMinutes: power.remainingMinutes,
    batteryLow: power.batteryLow,
    // Sem bateria comprovada não é falha nenhuma: é "não se aplica".
    status: power.hasBattery ? "available" : "not-applicable",
    source: "kernel32!GetSystemPowerStatus",
    updatedAt: power.acquiredAt,
  };
}

/**
 * Módulos de RAM. `slotsOccupied` conta módulos COM capacidade reportada — um
 * slot com entrada vazia no WMI não é um módulo. Nada aqui fala de saúde:
 * módulos presentes não provõem memória boa.
 */
export function ramLayoutReading(modules: unknown): RamLayoutReading {
  const invalido: RamLayoutReading = {
    modules: [], slotsOccupied: 0, slotsTotal: null,
    status: "unsupported", source: "Win32_PhysicalMemory",
  };
  if (!Array.isArray(modules)) return invalido;
  const norm: RamModuleReading[] = modules.map((entry) => {
    const m = (entry ?? {}) as Record<string, unknown>;
    const capacity = typeof m.size === "number" && m.size > 0 ? m.size : null;
    const clock = typeof m.clockSpeed === "number" && m.clockSpeed > 0 ? m.clockSpeed : null;
    return {
      bank: typeof m.bank === "string" && m.bank.trim() ? m.bank.trim() : null,
      capacityBytes: capacity,
      type: typeof m.type === "string" && m.type.trim() ? m.type.trim() : null,
      speedMHz: clock,
      manufacturer: typeof m.manufacturer === "string" && m.manufacturer.trim() ? m.manufacturer.trim() : null,
      partNumber: typeof m.partNum === "string" && m.partNum.trim() ? m.partNum.trim() : null,
    };
  });
  const ocupados = norm.filter((m) => m.capacityBytes !== null).length;
  if (ocupados === 0) return { ...invalido, modules: norm };
  return {
    modules: norm,
    slotsOccupied: ocupados,
    // O total de slots não é reportado por esta fonte: assumir 2 ou 4 seria
    // inventar uma característica da placa-mãe.
    slotsTotal: null,
    status: "available",
    source: "Win32_PhysicalMemory",
  };
}

/**
 * Taxa medida → número publicável. `0` é uma medição legítima (o disco
 * estava calmo naquele intervalo) e por isso só se rejeita o que não é finito
 * ou é negativo: um contador a devolver negativo é erro de fonte, e erro de
 * fonte publica-se como `null`, nunca como valor absolvido.
 */
const rate = (raw: number | null): number | null =>
  raw !== null && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;

/**
 * Amostras PDH por volume → leituras publicáveis de atividade.
 *
 * Porque existe uma função de normalização para algo que a aquisição já devolve
 * quase pronto: é aqui que se prova, sem Windows e sem PDH, que uma amostra
 * `measured: false` não se transforma em 0 B/s. É exatamente o caso do primeiro
 * poll de uma query recém-aberta, em que ainda não existe intervalo entre dois
 * `PdhCollectQueryData` e portanto não há taxa nenhuma.
 *
 * `_Total` não é um volume: fica com `mount: null`, para a apresentação o poder
 * usar como agregado sem o mostrar como se fosse "C:".
 */
export function diskActivityReadings(
  samples: PdhVolumeSample[] | null,
  at: () => Date = () => new Date(),
): DiskActivityReading[] {
  if (!Array.isArray(samples)) return [];
  return samples.map((sample) => {
    const agregado = sample.instance === "_Total";
    const letra = /^[A-Za-z]:$/.test(sample.instance);
    const medido = (amostra: PdhVolumeSample["readBytesPerSec"]): number | null =>
      rate(amostra.measured ? amostra.value : null);
    const lidos = medido(sample.readBytesPerSec);
    const escritos = medido(sample.writeBytesPerSec);
    const operacoesLeitura = medido(sample.readsPerSec);
    const operacoesEscrita = medido(sample.writesPerSec);
    const haMedicao =
      lidos !== null || escritos !== null || operacoesLeitura !== null || operacoesEscrita !== null;
    return {
      mount: agregado || !letra ? null : sample.instance,
      // A instância LogicalDisk não identifica o dispositivo físico: `device` a
      // null é honesto; adivinhar a que disco físico o volume pertence seria
      // uma atribuição sem fonte.
      device: null,
      readBytesPerSec: lidos,
      writeBytesPerSec: escritos,
      readsPerSec: operacoesLeitura,
      writesPerSec: operacoesEscrita,
      idlePercent: haMedicao ? percent(sample.idlePercent.measured ? sample.idlePercent.value : null) : null,
      status: haMedicao ? "available" : "unavailable",
      source: `PDH LogicalDisk(${sample.instance})`,
      updatedAt: haMedicao ? at().toISOString() : undefined,
    };
  });
}
