import type { HardwareSnapshot, TemperatureStatus } from "@cybersafe/shared-types";

/**
 * Uso de RAM honesto (TP-3H-RAM-INTEGRATION-CANDIDATE).
 *
 * O contrato v2 torna `ram.usagePercent`/`usedGb`/`totalGb` anuláveis e acrescenta
 * `usageStatus`/`usageUpdatedAt`/`usageLastGoodPercent`. Este helper centraliza a
 * decisão de apresentação, como o `cpuUsageDisplay` faz para a CPU.
 *
 * - `available`   → leitura atual (0 % é uma medição válida);
 * - `stale`       → última leitura boa retida (CACHED), a poll mais recente falhou;
 * - `unavailable` → sem leitura atual nem recente;
 * - `unconfirmed` → snapshot SEM `usageStatus` (legado): estado não confirmado,
 *                    portanto o número NÃO é apresentado como medição.
 *
 * Regras que este helper garante (revisto pelo root):
 * - `usedGb` e `freeText` só existem com leitura ATUAL (`available`): um
 *   `usedGb` herdado de um snapshot antigo não vira "GB em uso" nem "Disponível";
 * - `totalGb` (capacidade) é independente do estado: continua conhecido mesmo
 *   sem leitura, e `null` significa desconhecido — nunca 0 GB;
 * - "Disponível" nunca é negativo (used > total ⇒ "—").
 */
export type RamUsageState = "available" | "stale" | "unavailable" | "unconfirmed";

export interface RamUsageDisplay {
  state: RamUsageState;
  /** Percentagem da leitura ATUAL; `null` quando não há leitura atual. 0 é válido. */
  value: number | null;
  /** Última leitura boa (CACHED); `null` se nunca houve leitura boa. */
  cachedValue: number | null;
  /** Texto pronto a apresentar (nunca inventa "0%"). */
  text: string;
  /** Explicação curta para `title`/hint. */
  hint: string | null;
  /** Instante ISO da última leitura boa, quando o snapshot o traz. */
  updatedAt: string | null;
  /** GB em uso na leitura ATUAL; `null` quando não há leitura atual. */
  usedGb: number | null;
  /** Capacidade total (GB); `null` = desconhecida (nunca 0). */
  totalGb: number | null;
  usedText: string;
  totalText: string;
  freeText: string;
}

type RamInput =
  | Pick<
      HardwareSnapshot["ram"],
      | "usagePercent"
      | "usedGb"
      | "totalGb"
      | "usageStatus"
      | "usageUpdatedAt"
      | "usageLastGoodPercent"
    >
  | null
  | undefined;

function percent(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 0 || v > 100) return null;
  return Math.round(v);
}

function gigabytes(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 0) return null;
  return v;
}

/** PT-PT: vírgula decimal, como o `decimalPt` da app. */
function decimals(v: number): string {
  return v.toFixed(1).replace(".", ",");
}

export function ramUsageDisplay(ram: RamInput): RamUsageDisplay {
  const status: TemperatureStatus | undefined = ram?.usageStatus;
  const current = percent(ram?.usagePercent);
  const lastGood = percent(ram?.usageLastGoodPercent);
  const rawUsedGb = gigabytes(ram?.usedGb);
  const totalGb = gigabytes(ram?.totalGb);
  const updatedAt = ram?.usageUpdatedAt ?? null;

  // A capacidade é da máquina, não da leitura: sobrevive a uma leitura falhada.
  const totalText = totalGb === null ? "total desconhecido" : `${decimals(totalGb)} GB`;

  if (status === "available") {
    const freeText =
      totalGb === null || rawUsedGb === null || totalGb - rawUsedGb < 0
        ? "—"
        : `${decimals(totalGb - rawUsedGb)} GB`;
    return {
      state: "available",
      value: current,
      cachedValue: lastGood,
      text: current === null ? "Sem leitura" : `${current}%`,
      hint: current === null ? "Sem leitura de RAM" : null,
      updatedAt,
      usedGb: rawUsedGb,
      totalGb,
      usedText: rawUsedGb === null ? "usados desconhecidos" : `${decimals(rawUsedGb)} GB em uso`,
      totalText,
      freeText,
    };
  }

  if (status === "stale") {
    return {
      state: "stale",
      value: null,
      cachedValue: lastGood,
      text: lastGood === null ? "Sem leitura" : `${lastGood}% (última leitura)`,
      hint: "Última leitura conhecida; a leitura mais recente falhou",
      updatedAt,
      usedGb: null,
      totalGb,
      usedText: "usados desconhecidos",
      totalText,
      freeText: "—",
    };
  }

  if (status === "unavailable") {
    return {
      state: "unavailable",
      value: null,
      cachedValue: lastGood,
      text: "Sem leitura",
      hint: "Sem leitura de RAM",
      updatedAt,
      usedGb: null,
      totalGb,
      usedText: "usados desconhecidos",
      totalText,
      freeText: "—",
    };
  }

  // Sem `usageStatus`: snapshot legado — NÃO CONFIRMADO. O número pode existir,
  // mas não é apresentado como medição (política explícita, decisão do root).
  return {
    state: "unconfirmed",
    value: null,
    cachedValue: lastGood,
    text: "Não confirmado",
    hint: "Snapshot sem estado de leitura confirmado",
    updatedAt,
    usedGb: null,
    totalGb,
    usedText: "usados desconhecidos",
    totalText,
    freeText: "—",
  };
}
