import type { HardwareSnapshot, TemperatureStatus } from "@cybersafe/shared-types";

/**
 * Uso de CPU honesto (TP-PAP-CPU-USAGE-TRUTH).
 *
 * O contrato mantém `cpu.usage: number` (compatibilidade source), mas passa a
 * trazer `usageStatus`/`usageUpdatedAt`. Uma leitura falhada nunca pode ser
 * apresentada como "0%": este helper centraliza a decisão — em vez de seis
 * guardas divergentes espalhadas pela UI e pelo assistente.
 *
 * - `available`  → valor atual (0 É válido: CPU ociosa é uma medição real);
 * - `stale`      → último valor bom, mas a poll mais recente falhou (mostrar
 *                  como "última leitura", não como "agora");
 * - `unavailable`→ sem leitura atual nem recente: não mostrar número nenhum.
 *
 * Snapshots antigos (sem `usageStatus`, ex. candidata anterior) são tratados
 * como `available` se o número for válido — o comportamento anterior mantém-se.
 */

export type CpuUsageState = "available" | "stale" | "unavailable";

export interface CpuUsageDisplay {
  state: CpuUsageState;
  /** Valor a apresentar; `null` quando não há leitura atual/recente. 0 é válido. */
  value: number | null;
  /** Texto pronto a apresentar (nunca inventa "0%"). */
  text: string;
  /** Explicação curta para `title`/hint. */
  hint: string | null;
  /** Instante ISO da última leitura boa, quando o snapshot o traz. */
  updatedAt: string | null;
}

type CpuUsageInput =
  | Pick<HardwareSnapshot["cpu"], "usage" | "usageStatus" | "usageUpdatedAt">
  | null
  | undefined;

function measuredUsage(cpu: CpuUsageInput): number | null {
  const usage = cpu?.usage;
  if (typeof usage !== "number" || !Number.isFinite(usage)) return null;
  if (usage < 0 || usage > 100) return null;
  return Math.round(usage);
}

export function cpuUsageDisplay(cpu: CpuUsageInput): CpuUsageDisplay {
  const value = measuredUsage(cpu);
  const status: TemperatureStatus | undefined = cpu?.usageStatus;
  const updatedAt = cpu?.usageUpdatedAt ?? null;

  if (value === null) {
    return {
      state: "unavailable",
      value: null,
      text: "Sem leitura",
      hint: "A utilização de CPU não foi medida nesta leitura.",
      updatedAt,
    };
  }

  if (status === "unavailable" || status === "error") {
    return {
      state: "unavailable",
      value: null,
      text: "Sem leitura",
      hint: updatedAt
        ? "A leitura de utilização de CPU expirou; o último valor medido já não é atual."
        : "Ainda sem leitura de utilização de CPU.",
      updatedAt,
    };
  }

  if (status === "stale") {
    return {
      state: "stale",
      value,
      text: `${value}% (última leitura)`,
      hint: "A medição mais recente falhou; este é o último valor válido.",
      updatedAt,
    };
  }

  return { state: "available", value, text: `${value}%`, hint: null, updatedAt };
}

/**
 * Valor para narrativa/telemetria (assistente, contexto da IA, amostras).
 * Só uma medição ATUAL entra: um valor `stale`/`unavailable` vira `null`, para
 * não ser lido como "agora" nem injetar telemetria inventada.
 */
export function cpuUsageForNarrative(cpu: CpuUsageInput): number | null {
  const display = cpuUsageDisplay(cpu);
  return display.state === "available" ? display.value : null;
}
