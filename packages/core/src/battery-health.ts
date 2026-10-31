/**
 * ── BATERIA: capacidades → saúde publicável ─────────────────────────────────
 *
 * Porque existe este módulo: o snapshot só publicava `percent`/`isCharging`.
 * A saúde da bateria (capacidade original vs máxima actual, desgaste, ciclos)
 * existia no provider (`systeminformation.battery()` devolve `designedCapacity`,
 * `maxCapacity`, `cycleCount`, `capacityUnit`) e era DESCARTADA. O utilizador
 * não conseguia saber se a bateria estava gasta.
 *
 * A regra é a mesma do resto do hardware: só se publica o que foi medido.
 *   1. Uma bateria presente mas com capacidades a 0 não tem saúde calculável —
 *      é "indisponível", com motivo, nunca 0% de saúde;
 *   2. Uma capacidade em mAh não é convertível sem tensão — não inventamos
 *      uma tensão para fabricar Wh;
 *   3. `maxCapacity` acima de `designedCapacity` é arredondamento de firmware
 *      até 10%; acima disso é leitura implausível e não produz saúde;
 *   4. `cycleCount` 0 é indistinguível de "não reportado" no provider do
 *      Windows, por isso só se publica quando é > 0.
 *
 * Tudo aqui é puro e determinístico: os testes correm sem WMI e sem Windows.
 */

/** Estado da leitura de saúde. Distinto do estado da leitura de carga. */
export type BatteryHealthStatus = "available" | "invalid" | "unsupported" | "absent";

export interface BatteryHealthInput {
  /** O provider confirmou que existe bateria nesta leitura. */
  hasBattery: boolean;
  /** Capacidade de desenho, na unidade declarada em `capacityUnit`. */
  designedCapacity?: unknown;
  /** Capacidade máxima actual, na unidade declarada em `capacityUnit`. */
  maxCapacity?: unknown;
  /** "mWh" é convertível para Wh; "mAh" não é (falta a tensão). */
  capacityUnit?: unknown;
  /** Ciclos de carga reportados pelo firmware. */
  cycleCount?: unknown;
}

export interface BatteryHealth {
  status: BatteryHealthStatus;
  /** Motivo legível quando `status !== "available"`. */
  detail: string | null;
  /** Capacidade original em Wh. `null` sem medição utilizável. */
  designWh: number | null;
  /** Capacidade máxima actual em Wh. `null` sem medição utilizável. */
  maxWh: number | null;
  /** Saúde percentual (0–100). Só existe com ambas as capacidades válidas. */
  healthPercent: number | null;
  /** Desgaste percentual (0–100) = 100 − saúde. */
  wearPercent: number | null;
  /** Ciclos de carga. `null` quando o firmware não os reporta. */
  cycleCount: number | null;
}

/** Limites de plausibilidade para capacidades em mWh (1 Wh – 500 Wh). */
const MIN_CAPACITY_MWH = 1_000;
const MAX_CAPACITY_MWH = 500_000;

/** Tolerância de arredondamento de firmware antes de considerar implausível. */
const MAX_CAPACITY_RATIO = 1.1;

/** Acima disto o contador de ciclos é uma leitura corrompida, não um facto. */
const MAX_PLAUSIBLE_CYCLES = 100_000;

const toFinite = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const empty = (status: BatteryHealthStatus, detail: string | null): BatteryHealth => ({
  status,
  detail,
  designWh: null,
  maxWh: null,
  healthPercent: null,
  wearPercent: null,
  cycleCount: null,
});

const round1 = (value: number) => Math.round(value * 10) / 10;
const clampPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value)));

/**
 * Converte uma leitura crua do provider em saúde publicável.
 *
 * Nunca lança: uma entrada inválida produz um estado com motivo, porque um
 * throw aqui apagaria a leitura de carga que é independente desta.
 */
export function describeBatteryHealth(input: BatteryHealthInput): BatteryHealth {
  if (!input || input.hasBattery !== true) {
    return empty("absent", "Sem bateria: a saúde não é aplicável neste computador.");
  }

  const unit = typeof input.capacityUnit === "string" ? input.capacityUnit.trim() : "";
  const design = toFinite(input.designedCapacity);
  const max = toFinite(input.maxCapacity);
  const cyclesRaw = toFinite(input.cycleCount);

  const cycles =
    cyclesRaw !== null &&
    Number.isInteger(cyclesRaw) &&
    cyclesRaw > 0 &&
    cyclesRaw <= MAX_PLAUSIBLE_CYCLES
      ? cyclesRaw
      : null;

  // Sem capacidades medidas não há saúde. `unsupported` distingue "o Windows
  // não expõe isto" de "expôs um valor impossível" — a explicação difere.
  const hasCapacities =
    design !== null && max !== null && design > 0 && max > 0;
  if (!hasCapacities) {
    return {
      ...empty(
        "unsupported",
        "O firmware desta bateria não reporta as capacidades (original e máxima), por isso a saúde não pode ser calculada.",
      ),
      cycleCount: cycles,
    };
  }

  if (unit !== "mWh") {
    // mAh exigiria a tensão nominal; sem ela a conversão seria inventada.
    return {
      ...empty(
        "unsupported",
        unit === "mAh"
          ? "A capacidade é reportada em mAh e a tensão nominal não está disponível; converter para Wh seria inventar um valor."
          : "A capacidade é reportada sem unidade reconhecida, por isso não é convertível para Wh.",
      ),
      cycleCount: cycles,
    };
  }

  if (design < MIN_CAPACITY_MWH || design > MAX_CAPACITY_MWH || max > MAX_CAPACITY_MWH) {
    return {
      ...empty(
        "invalid",
        `A capacidade reportada está fora de qualquer valor plausível (${Math.round(design)} mWh / ${Math.round(max)} mWh).`,
      ),
      cycleCount: cycles,
    };
  }

  if (max > design * MAX_CAPACITY_RATIO) {
    return {
      ...empty(
        "invalid",
        `A capacidade máxima (${Math.round(max)} mWh) é superior à original (${Math.round(design)} mWh) além da tolerância de firmware; a leitura não é utilizável.`,
      ),
      cycleCount: cycles,
    };
  }

  const healthPercent = clampPercent((max / design) * 100);
  return {
    status: "available",
    detail: null,
    designWh: round1(design / 1000),
    maxWh: round1(max / 1000),
    healthPercent,
    wearPercent: clampPercent(100 - healthPercent),
    cycleCount: cycles,
  };
}
