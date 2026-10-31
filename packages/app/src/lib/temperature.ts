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

// ── Relógio de temperatura da SESSÃO (por canal) ──────────────────────────
//
// Porque não é um timer dentro do componente: o prazo anterior vivia no estado
// do componente, logo cada MONTAGEM recomeçava os 15 s. Ir ao Dashboard e voltar
// ao PC Center (o `key={page}` do App remonta a página), ou qualquer outra
// remontagem, fazia a secção voltar a "A recolher dados..." — indefinidamente,
// do ponto de vista do utilizador, porque a espera nunca era observada até ao
// fim. Ancorar o relógio em `waitingSince` torna a transição MONÓTONA: uma
// montagem que acontece depois do prazo vê logo "Indisponível", e nenhuma
// remontagem reabre a espera. O relógio é limpo assim que há leitura real
// (se o sensor voltar a desaparecer, ganha uma nova janela honesta).
const waitingSince = new Map<string, number>();

/**
 * Regista, para um canal (ex.: "cpu", "gpu"), se há leitura. Sem leitura, fixa
 * o início da espera UMA vez por sessão — chamadas seguintes não o reiniciam.
 */
export function noteTemperaturePending(
  channel: string,
  hasReading: boolean,
  now: number = Date.now(),
): void {
  if (hasReading) {
    waitingSince.delete(channel);
    return;
  }
  if (!waitingSince.has(channel)) waitingSince.set(channel, now);
}

/** Início da espera deste canal, ou null se já houve leitura / nunca esperou. */
export function temperatureWaitingSince(channel: string): number | null {
  const since = waitingSince.get(channel);
  return since === undefined ? null : since;
}

/** O prazo deste canal esgotou-se? (Sempre falso depois de uma leitura real.) */
export function temperatureHasTimedOut(
  channel: string,
  now: number = Date.now(),
  timeoutMs: number = TEMPERATURE_WAITING_TIMEOUT_MS,
): boolean {
  const since = waitingSince.get(channel);
  return since !== undefined && now - since >= timeoutMs;
}

/** Esquece os canais observados. Usado pelos testes. */
export function resetTemperatureSessionClock(): void {
  waitingSince.clear();
}

export interface TemperatureDisplayOptions {
  /** Canal lógico ("cpu", "gpu"). Cada canal tem o seu próprio prazo. */
  channel?: string;
  timeoutMs?: number;
}

/**
 * Igual a `temperatureDisplay`, mas com o prazo ancorado à SESSÃO (ver acima):
 * passado `timeoutMs` sem valor seguro, o estado passa a "unavailable" e nunca
 * fica eternamente em "A recolher dados...", mesmo que a secção seja remontada.
 */
export function useTemperatureDisplay(
  value: number | null | undefined,
  { channel = "default", timeoutMs = TEMPERATURE_WAITING_TIMEOUT_MS }: TemperatureDisplayOptions = {},
): TemperatureDisplay {
  const hasValue = isValidTemperature(value);
  // O estado local é só o RELÓGIO (o instante da última verificação). O prazo em
  // si vem do relógio da sessão, lido no render — por isso uma remontagem já
  // nasce com a resposta certa em vez de recomeçar a espera.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Efeito sobre um relógio externo à React: fixa/limpa a âncora do canal.
    noteTemperaturePending(channel, hasValue);
    if (hasValue) return;
    if (temperatureHasTimedOut(channel, Date.now(), timeoutMs)) return;
    // Só o tempo RESTANTE da espera da sessão: uma remontagem não concede 15 s novos.
    const since = temperatureWaitingSince(channel) ?? Date.now();
    const remaining = Math.max(1, since + timeoutMs - Date.now());
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [hasValue, channel, timeoutMs]);

  // Um valor real manda sempre: nunca mostramos "indisponível" com leitura.
  return temperatureDisplay(value, {
    timedOut: !hasValue && temperatureHasTimedOut(channel, now, timeoutMs),
  });
}
