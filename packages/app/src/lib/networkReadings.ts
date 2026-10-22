import type { HardwareSnapshot } from "@cybersafe/shared-types";

/**
 * Leitura de rede honesta (TP-PAP-NETWORK-TRUTH).
 *
 * O core publica `readStatus`/`updatedAt`; snapshots antigos não têm estes
 * campos. Regra de compatibilidade documentada: sem `readStatus`, um
 * `interfaceName` válido significa `available` (comportamento anterior); vazio
 * ou "unknown" significa `unavailable` — nunca 0 B/s inventado.
 *
 * - `pending`     → primeira leitura ainda não terminou → "A medir…";
 * - `available`   → valores atuais; 0 B/s REAL continua a ser 0 B/s;
 * - `stale`       → última leitura boa, a mais recente falhou → rotulado;
 * - `unavailable` → sem leitura → "Sem leitura", nunca 0 B/s.
 */

export type NetworkReadingState = "pending" | "available" | "stale" | "unavailable";

type NetworkInput =
  | Pick<HardwareSnapshot["network"], "rxSec" | "txSec" | "interfaceName" | "readStatus" | "updatedAt">
  | null
  | undefined;

export interface NetworkReadingDisplay {
  state: NetworkReadingState;
  /** Valores a apresentar; `null` quando não há leitura atual/recente. 0 é válido. */
  rxSec: number | null;
  txSec: number | null;
  /** Nome real da interface, ou `null` quando desconhecido. */
  interfaceName: string | null;
  /** Etiqueta honesta do estado ("A medir…", "Última leitura", "Sem leitura", ""). */
  label: string;
  hint: string | null;
  updatedAt: string | null;
}

function validRate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function validIface(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed === "unknown" || trimmed === "a receber agora") return null;
  return trimmed;
}

export function networkReadingDisplay(network: NetworkInput): NetworkReadingDisplay {
  const rx = validRate(network?.rxSec);
  const tx = validRate(network?.txSec);
  const interfaceName = validIface(network?.interfaceName);
  const updatedAt = network?.updatedAt ?? null;

  const declared = network?.readStatus;
  const state: NetworkReadingState = declared
    ? declared
    : interfaceName !== null && rx !== null && tx !== null
      ? "available"
      : "unavailable";

  if (state === "pending") {
    return {
      state,
      rxSec: null,
      txSec: null,
      interfaceName,
      label: "A medir…",
      hint: "A primeira leitura de tráfego ainda não terminou.",
      updatedAt,
    };
  }

  if (state === "unavailable" || rx === null || tx === null) {
    return {
      state: "unavailable",
      rxSec: null,
      txSec: null,
      interfaceName,
      label: "Sem leitura",
      hint: updatedAt
        ? "A leitura de tráfego expirou; o último valor já não é atual."
        : "Ainda sem leitura de tráfego de rede.",
      updatedAt,
    };
  }

  if (state === "stale") {
    return {
      state,
      rxSec: rx,
      txSec: tx,
      interfaceName,
      label: "Última leitura",
      hint: "A leitura mais recente falhou; estes são os últimos valores válidos.",
      updatedAt,
    };
  }

  return { state: "available", rxSec: rx, txSec: tx, interfaceName, label: "", hint: null, updatedAt };
}

/**
 * Amostra para telemetria: só uma leitura ATUAL entra no gráfico. `pending`,
 * `stale` e `unavailable` devolvem `null` — nunca um 0 inventado.
 */
export function networkTelemetrySample(
  network: NetworkInput,
): { rxSec: number; txSec: number } | null {
  const display = networkReadingDisplay(network);
  if (display.state !== "available" || display.rxSec === null || display.txSec === null) {
    return null;
  }
  return { rxSec: display.rxSec, txSec: display.txSec };
}
