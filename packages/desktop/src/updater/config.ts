/**
 * Resolução de configuração do updater — fail-closed (TP-UPDATE-01).
 *
 * Sem origem confiável (allowlist), sem URL de feed HTTPS dentro dessa allowlist,
 * sem chave ed25519 PINADA (fingerprint), sem nome de editor esperado e sem
 * diretório de cache dedicado, o updater NÃO fica "pronto": fica `unconfigured`.
 * É isto que impede o produto de fingir atualização automática quando não existe
 * feed nem certificado (medido no audit: `electron-updater` ausente, sem `publish`,
 * sem Authenticode no build).
 */
import type { UpdateChannel } from "./types.ts";

import type { UpdaterConfig } from "./types.ts";

export interface UnconfiguredReason {
  reason:
    | "missing-origin-allowlist"
    | "missing-feed-url"
    | "feed-origin-not-allowed"
    | "missing-pinned-key"
    | "missing-publisher"
    | "missing-cache-dir"
    | "bad-limits";
  detail: string;
}

export type ConfigResolution =
  | { ok: true; config: UpdaterConfig }
  | { ok: false; unconfigured: UnconfiguredReason };

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    return u.host.toLowerCase();
  } catch {
    return null;
  }
}

/** `url` é https e a sua origem está EXATAMENTE na allowlist (sem prefixos). */
export function isUrlAllowed(url: string, allowlist: string[]): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  return allowlist.map((o) => o.toLowerCase()).includes(origin);
}

interface RawConfigInput {
  channel?: unknown;
  feedManifestUrl?: unknown;
  originAllowlist?: unknown;
  pinnedKeyFingerprint?: unknown;
  expectedPublisherName?: unknown;
  cacheDir?: unknown;
  timeoutMs?: unknown;
  maxDownloadBytes?: unknown;
  automaticCheckEnabled?: unknown;
  minCheckIntervalMs?: unknown;
}

function fail(
  reason: UnconfiguredReason["reason"],
  detail: string,
): ConfigResolution {
  return { ok: false, unconfigured: { reason, detail } };
}

export function resolveUpdaterConfig(input: RawConfigInput): ConfigResolution {
  // Canal fixo: qualquer outra coisa é "unconfigured" (não adivinhamos).
  if (input.channel !== undefined && input.channel !== "stable") {
    return fail("bad-limits", `canal não suportado: ${String(input.channel)}`);
  }

  const allowlist = Array.isArray(input.originAllowlist)
    ? input.originAllowlist.filter((o): o is string => typeof o === "string" && o.length > 0)
    : [];
  if (allowlist.length === 0) {
    return fail("missing-origin-allowlist", "nenhuma origem HTTPS confiável configurada");
  }

  const feedManifestUrl =
    typeof input.feedManifestUrl === "string" ? input.feedManifestUrl : "";
  if (feedManifestUrl.length === 0) {
    return fail("missing-feed-url", "feed de updates ausente");
  }
  if (!isUrlAllowed(feedManifestUrl, allowlist)) {
    return fail("feed-origin-not-allowed", `origem do feed fora da allowlist: ${feedManifestUrl}`);
  }

  const pinnedKeyFingerprint =
    typeof input.pinnedKeyFingerprint === "string" ? input.pinnedKeyFingerprint.trim() : "";
  if (pinnedKeyFingerprint.length === 0) {
    return fail("missing-pinned-key", "chave ed25519 pinada ausente");
  }

  const expectedPublisherName =
    typeof input.expectedPublisherName === "string" ? input.expectedPublisherName.trim() : "";
  if (expectedPublisherName.length === 0) {
    return fail("missing-publisher", "nome de editor esperado ausente");
  }

  const cacheDir = typeof input.cacheDir === "string" ? input.cacheDir : "";
  if (cacheDir.length === 0) {
    return fail("missing-cache-dir", "diretório de cache dedicado ausente");
  }

  const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : 0;
  const maxDownloadBytes =
    typeof input.maxDownloadBytes === "number" ? input.maxDownloadBytes : 0;
  if (timeoutMs <= 0 || !Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes <= 0) {
    return fail("bad-limits", "timeout/max-bytes inválidos");
  }

  // Limite de pedidos: só aplica quando explicitamente configurado (a produção
  // define 30s em `production.ts`). Presente → tem de ser intervalo são.
  let minCheckIntervalMs;
  if (input.minCheckIntervalMs !== undefined) {
    const v = input.minCheckIntervalMs;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1_000 || v > 3_600_000) {
      return fail("bad-limits", "minCheckIntervalMs inválido (1s..1h, inteiro)");
    }
    minCheckIntervalMs = v;
  }

  return {
    ok: true,
    config: {
      channel: "stable",
      feedManifestUrl,
      originAllowlist: allowlist,
      pinnedKeyFingerprint,
      expectedPublisherName,
      cacheDir,
      timeoutMs,
      maxDownloadBytes,
      automaticCheckEnabled: input.automaticCheckEnabled === true,
      minCheckIntervalMs,
    },
  };
}
