// Cartão de bateria da visão Simples do PC Center.
//
// Contrato (CONTRATO_ESTAVEL_BATTERY, OpenCode):
// - `battery.status?`: present | absent | unavailable | error. Opcional: snapshots
//   antigos não o trazem e seguem o caminho legado abaixo.
//   · present     → leitura boa; percent 0 é REAL.
//   · absent      → ausência comprovada; é o único caso em que «Sem bateria» é verdade.
//   · unavailable → sem leitura atual (>60 s).
//   · error       → o provider falhou sem leitura boa.
//   error e unavailable NUNCA se mostram como «sem bateria».
// - `timeRemaining` null (ou 0) → «—», nunca «0 min».
// - `updatedAt?` (ISO, 3.º argumento de batteryDisplay) só serve para a idade da nota; `source?` não é usado.
// - Legado (sem status): `hasBattery`/`percent` não decidem sozinhos. hasBattery:false
//   é «Sem bateria ou sem leitura»; percent 0 com hasBattery:true não é medição.
//
// `status`, `updatedAt` e `source` estão em `shared-types` (C2, OpenCode).

import type { HardwareSnapshot } from "@cybersafe/shared-types";
import { resolveSurfaceDataOrigin, type SurfaceDataOrigin } from "./dashboardUsage";

type Battery = HardwareSnapshot["battery"];

/** Origem usada pelo PC Center. DEMO nunca chega aqui (fontes DEMO só no harness). */
export type BatteryOrigin = Exclude<SurfaceDataOrigin, "DEMO">;

export interface BatteryDisplay {
  origin: BatteryOrigin;
  /** Marca explícita quando a leitura é a última guardada (CACHED). */
  originText: string | null;
  /** Nota honesta da origem: LIVE/CACHED são leituras do serviço; a idade só existe com timestamp válido. */
  snapshotNote: string | null;
  /** Título curto do estado. */
  label: string;
  /** Explicação discreta. */
  hint: string | null;
  /** Percentagem só quando finita e entre 0 e 100 (0 só é válido com status present). */
  percent: number | null;
  percentText: string | null;
  chargingText: string | null;
  /** Autonomia a descarregar; «—» quando o valor não existe ou é zero. */
  timeText: string | null;
  /**
   * Saúde da bateria, em texto. `null` = sem leitura de saúde a apresentar.
   * «Não aplicável» para um PC sem bateria; «Indisponível» quando o firmware
   * não expõe capacidades — nunca 0% de saúde.
   */
  healthText: string | null;
  /** Capacidades medidas (máxima de original); só com valores reais. */
  capacityText: string | null;
  /** Ciclos de carga; `null` quando o firmware não os reporta. */
  cyclesText: string | null;
  /** Motivo da indisponibilidade da saúde (porquê, não só "indisponível"). */
  healthHint: string | null;
}

const NO_READ_LABEL = "Sem bateria ou sem leitura";
const NO_READ_HINT =
  "O sistema não reportou bateria nesta leitura. Não distingue um PC sem bateria de uma falha de leitura.";
/**
 * Nota honesta da origem. Não afirma que o ciclo periódico está por começar nem parado:
 * LIVE e CACHED já têm leitura do serviço. A idade só existe com `updatedAt` válido.
 */
function originNote(origin: BatteryOrigin, updatedAt: string | null | undefined, nowMs: number): string | null {
  if (origin === "UNAVAILABLE") return null;
  const age = snapshotAgeText(updatedAt, nowMs);
  if (origin === "LIVE") return age ? `Dados do serviço; última leitura ${age}.` : "Dados do serviço; hora da última leitura indisponível.";
  return age ? `Última leitura guardada, medida ${age}.` : "Última leitura guardada; a hora da medição não está disponível.";
}

/**
 * Origem real do PC Center: LIVE com serviço ligado, CACHED quando a ligação
 * caiu e a última leitura real ainda é mostrada, UNAVAILABLE sem snapshot.
 * DEMO nunca é inferido (só harness, explícito); a regra é a de
 * `resolveSurfaceDataOrigin`, sem `isDemo`.
 */
export function pcCenterDataOrigin(opts: {
  hasSnapshot: boolean;
  serviceConnected: boolean | null | undefined;
}): BatteryOrigin {
  const origin = resolveSurfaceDataOrigin(opts);
  return origin === "DEMO" ? "UNAVAILABLE" : origin;
}

/**
 * Antiguidade de um snapshot guardado (CACHED). Só existe com um `timestamp` ISO
 * válido e não futuro; sem isso devolve null (nunca inventa idade).
 */
export function snapshotAgeText(timestamp: string | null | undefined, nowMs: number): string | null {
  const t = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(t) || t > nowMs + 5_000) return null;
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  return `há ${Math.floor(s / 3600)} h`;
}

function formatTimeRemaining(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `~${h}h ${m}m restantes`;
}

function validPercentOf(p: unknown, allowZero: boolean): number | null {
  if (typeof p !== "number" || !Number.isFinite(p)) return null;
  if (p < 0 || p > 100) return null;
  if (p === 0 && !allowZero) return null;
  return Math.round(p);
}

/** Wh com uma casa decimal e vírgula PT; sem decimal quando é inteiro. */
function formatWh(value: number): string {
  const text = value.toFixed(1);
  return text.endsWith(".0") ? text.slice(0, -2).replace(".", ",") : text.replace(".", ",");
}

const finitePositive = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

/**
 * Saúde da bateria (FASE 1). Campos opcionais: snapshots antigos não os têm e
 * caem no fim (`null`), sem inventar saúde. «Não aplicável» só com ausência
 * comprovada; «Indisponível» com o motivo real.
 */
function healthDisplayOf(b: Battery): {
  healthText: string | null;
  capacityText: string | null;
  cyclesText: string | null;
  healthHint: string | null;
} {
  const status = b.healthStatus;
  const healthPercent =
    typeof b.healthPercent === "number" && Number.isFinite(b.healthPercent)
      ? Math.min(100, Math.max(0, Math.round(b.healthPercent)))
      : null;
  const wearPercent =
    typeof b.wearPercent === "number" && Number.isFinite(b.wearPercent)
      ? Math.min(100, Math.max(0, Math.round(b.wearPercent)))
      : null;
  const design = finitePositive(b.designCapacityWh);
  const max = finitePositive(b.maxCapacityWh);
  const cycles =
    typeof b.cycleCount === "number" && Number.isInteger(b.cycleCount) && b.cycleCount > 0
      ? b.cycleCount
      : null;

  const capacityText = design !== null && max !== null ? `${formatWh(max)} Wh de ${formatWh(design)} Wh` : null;
  const cyclesText = cycles !== null ? `${cycles} ciclos de carga` : null;
  const detail =
    typeof b.healthDetail === "string" && b.healthDetail.trim() ? b.healthDetail.trim() : null;

  if (status === "absent") {
    return {
      healthText: "Não aplicável",
      capacityText: null,
      cyclesText: null,
      healthHint: "Este computador não tem bateria.",
    };
  }

  if (status === "invalid" || status === "unsupported") {
    return {
      healthText: "Indisponível",
      capacityText,
      cyclesText,
      healthHint:
        detail ?? "O sistema não reportou capacidade suficiente para calcular a saúde da bateria.",
    };
  }

  if (healthPercent === null) {
    // Sem `healthStatus` (snapshot antigo) e sem valor: não há saúde a mostrar.
    return { healthText: null, capacityText, cyclesText, healthHint: null };
  }

  return {
    healthText: `${healthPercent}% de saúde`,
    capacityText,
    cyclesText,
    healthHint: wearPercent === null ? null : wearPercent > 0 ? `Desgaste de ${wearPercent}%.` : "Sem desgaste medido.",
  };
}

export function batteryDisplay(
  battery: Battery | null | undefined,
  origin: BatteryOrigin,
  updatedAt?: string | null,
  nowMs: number = Date.now(),
): BatteryDisplay {
  const originText = origin === "CACHED" ? "Última leitura" : null;
  // 1 linha de fallback: sem consumidor novo, a idade sai do proprio snapshot (C2).
  const snapshotNote = originNote(origin, updatedAt ?? battery?.updatedAt, nowMs);
  const base = {
    origin,
    originText,
    snapshotNote,
    percent: null,
    percentText: null,
    chargingText: null,
    timeText: null,
    healthText: null,
    capacityText: null,
    cyclesText: null,
    healthHint: null,
  };

  if (origin === "UNAVAILABLE" || !battery) {
    return { ...base, label: "Indisponível", hint: "A leitura da bateria não está disponível." };
  }

  const b = battery;

  // Contrato novo: o status decide. Nunca «sem bateria» para error/unavailable.
  if (b.status === "absent") {
    return {
      ...base,
      label: "Sem bateria",
      hint: "Ausência comprovada pelo sistema.",
      healthText: "Não aplicável",
      healthHint: "Este computador não tem bateria.",
    };
  }
  if (b.status === "unavailable") {
    return { ...base, label: "Bateria indisponível", hint: "Sem leitura atual da bateria (mais de 60 s)." };
  }
  if (b.status === "error") {
    return { ...base, label: "Erro ao ler a bateria", hint: "O provider de bateria falhou sem leitura válida." };
  }
  if (b.status === "present") {
    const percent = validPercentOf(b.percent, true);
    const t = b.timeRemaining;
    const timeOk = !b.isCharging && typeof t === "number" && Number.isFinite(t) && t > 0;
    return {
      origin,
      originText,
      snapshotNote,
      label: percent === null ? "Percentagem indisponível" : "Bateria",
      hint: percent === null ? "A bateria existe, mas a percentagem não foi lida." : null,
      percent,
      percentText: percent === null ? null : `${percent}%`,
      chargingText: b.isCharging ? "A carregar" : "A descarregar",
      timeText: b.isCharging ? null : timeOk ? formatTimeRemaining(t as number) : "—",
      ...healthDisplayOf(b),
    };
  }

  // Legado (sem status): hasBattery/percent não decidem sozinhos.
  if (b.hasBattery !== true) {
    return { ...base, label: NO_READ_LABEL, hint: NO_READ_HINT };
  }

  // 0 não é tratado como medição no legado: é o valor que o produtor usa em falha.
  const percent = validPercentOf(b.percent, false);
  const t = b.timeRemaining;
  const showTime = !b.isCharging && typeof t === "number" && Number.isFinite(t) && t > 0;

  return {
    origin,
    originText,
    snapshotNote,
    label: percent === null ? "Percentagem indisponível" : "Bateria",
    hint: percent === null ? "A bateria existe, mas a percentagem não foi lida." : null,
    percent,
    percentText: percent === null ? null : `${percent}%`,
    chargingText: b.isCharging ? "A carregar" : "A descarregar",
    timeText: showTime ? formatTimeRemaining(t as number) : null,
    // Legado: sem `healthStatus` não há saúde a afirmar; o helper devolve null
    // em vez de inventar um valor a partir de campos ausentes.
    ...healthDisplayOf(b),
  };
}
