import { useEffect, useState } from "react";

/**
 * Estado de temperatura apresentado na UI.
 *
 * O CyberSafe NÃO carrega drivers de ring0 (o WinRing0 foi removido) e nunca
 * inventa 0 °C: enquanto não existir uma leitura segura, mostra-se
 * "A recolher dados..." e, passado um prazo razoável, "Temperatura
 * indisponível". A partir do momento em que há valor real, esse valor manda.
 *
 * Este módulo é a única fonte da copy de temperatura, por isso o Dashboard e o
 * PC Center dizem exatamente a mesma coisa.
 */

export const TEMPERATURE_WAITING_TEXT = "A recolher dados...";
export const TEMPERATURE_UNAVAILABLE_TEXT = "Temperatura indisponível";
export const TEMPERATURE_UNAVAILABLE_HINT =
  "O Windows não disponibilizou um sensor compatível de forma segura.";
/** As temperaturas são recolhidas a cada ~10s: 15s sem valor = sem provider. */
export const TEMPERATURE_WAITING_TIMEOUT_MS = 15_000;

export type TemperatureState = "waiting" | "available" | "unavailable";

export interface TemperatureDisplay {
  state: TemperatureState;
  /** Valor em °C quando disponível, senão null. Nunca 0 artificial. */
  value: number | null;
  /** Texto pronto a mostrar: "62°C" | "A recolher dados..." | "Temperatura indisponível". */
  text: string;
  /** Explicação curta para tooltip quando indisponível. */
  hint: string | null;
}

/** Só aceita leituras plausíveis: finitas e > 0 (0 °C nunca é fallback). */
export function isValidTemperature(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function temperatureDisplay(
  value: number | null | undefined,
  options: { timedOut?: boolean } = {},
): TemperatureDisplay {
  if (isValidTemperature(value)) {
    return { state: "available", value, text: `${value}°C`, hint: null };
  }
  if (options.timedOut) {
    return {
      state: "unavailable",
      value: null,
      text: TEMPERATURE_UNAVAILABLE_TEXT,
      hint: TEMPERATURE_UNAVAILABLE_HINT,
    };
  }
  return { state: "waiting", value: null, text: TEMPERATURE_WAITING_TEXT, hint: null };
}

/**
 * Igual a `temperatureDisplay`, mas com o prazo gerido pelo hook: passado
 * `timeoutMs` sem valor seguro, o estado passa a "unavailable" e nunca fica
 * eternamente em "A recolher dados...".
 */
export function useTemperatureDisplay(
  value: number | null | undefined,
  timeoutMs: number = TEMPERATURE_WAITING_TIMEOUT_MS,
): TemperatureDisplay {
  const hasValue = isValidTemperature(value);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    // Já há leitura: o prazo não se aplica (e o timer pendente é cancelado).
    if (hasValue) return;
    const timer = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [hasValue, timeoutMs]);

  // Um valor real manda sempre: nunca mostramos "indisponível" com leitura.
  return temperatureDisplay(value, { timedOut: timedOut && !hasValue });
}
