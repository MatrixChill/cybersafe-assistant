/**
 * Ponte do updater para o main (TP-UPDATE-INTEGRATE).
 *
 * Mantém o `main.ts` fino: aqui vive a construção do updater UNCONFIGURED com
 * adaptadores EXPLICITAMENTE BLOQUEADOS, a tradução domínio→contrato e a
 * VALIDAÇÃO EM RUNTIME dos payloads (o `unknown` que chega do IPC NÃO é confiável
 * — os tipos TS não validam nada em runtime).
 *
 * Regras:
 *  - Sem feed/chave/editor (nenhum existe hoje): `resolveUpdaterConfig({})` ⇒
 *    `unconfigured`. Os adaptadores bloqueados nunca são exercitados nesse estado;
 *    se o forem, lançam (o `Updater` converte isso em Result fail-closed).
 *  - `createEd25519ManifestVerifier({publicKey:""})` nega sempre (chave ilegível).
 *  - A âncora de confiança de produção (feed/ chave pública / editor) NÃO vem de
 *    `process.env` nem de settings do utilizador — teria de vir de config assinada
 *    de build, num delta próprio revisto. Aqui não existe, por isso unconfigured.
 */
import path from "node:path";
import { createEd25519ManifestVerifier } from "./crypto.ts";
import { resolveUpdaterConfig } from "./config.ts";
import { createUpdater, BLOCKED_INSTALLER } from "./updater.ts";
import type {
  ArtifactDownloader,
  CacheFileSystem,
  PublisherVerifier,
  ScanState,
  UpdateSnapshot,
  UpdateSource,
  UpdaterResult,
} from "./types.ts";
import type { Updater } from "./updater.ts";
import type { AppUpdateErrorCode, AppUpdateResult, AppUpdateSnapshot } from "@cybersafe/shared-types";

export { BLOCKED_INSTALLER } from "./updater.ts";

const UNREACHABLE = "adaptador de updater não configurado (updater unconfigured)";

export const BLOCKED_SOURCE: UpdateSource = {
  fetchLatest: async () => { throw new Error(UNREACHABLE); },
};

export const BLOCKED_DOWNLOADER: ArtifactDownloader = {
  download: async () => { throw new Error(UNREACHABLE); },
};

export const BLOCKED_PUBLISHER: PublisherVerifier = {
  verify: async () => { throw new Error(UNREACHABLE); },
};

export const BLOCKED_CACHEFS: CacheFileSystem = {
  ensureDir: async () => { throw new Error(UNREACHABLE); },
  statFile: async () => { throw new Error(UNREACHABLE); },
  readFile: async () => { throw new Error(UNREACHABLE); },
  writeAtomic: async () => { throw new Error(UNREACHABLE); },
  removePath: async () => { throw new Error(UNREACHABLE); },
};

/** Updater honesto: UNCONFIGURED (ou unsupported em dev/portable), sem tocar em rede/fs/instalador. */
export function createUnconfiguredUpdater(opts: {
  runtimeSupported: boolean;
  installedVersion: string;
  cacheDir?: string;
}): Updater {
  return createUpdater({
    config: resolveUpdaterConfig({}), // fail-closed: sem âncoras ⇒ unconfigured
    runtimeSupported: opts.runtimeSupported,
    installed: { version: opts.installedVersion },
    source: BLOCKED_SOURCE,
    downloader: BLOCKED_DOWNLOADER,
    signatureVerifier: createEd25519ManifestVerifier({ publicKey: "", pinnedFingerprint: "" }),
    publisherVerifier: BLOCKED_PUBLISHER,
    installer: BLOCKED_INSTALLER,
    cacheFs: BLOCKED_CACHEFS,
    scanProbe: async (): Promise<ScanState> => "unknown",
  });
}

/** Caminho de cache dedicado (main chama com `app.getPath("userData")`). */
export function updaterCacheDir(userDataDir: string): string {
  return path.join(userDataDir, "updater-cache");
}

/* ── Tradução domínio → contrato (única fonte dos tipos partilhados) ────────── */

const STATUS: Record<UpdateSnapshot["phase"], AppUpdateSnapshot["status"]> = {
  unconfigured: "unconfigured",
  unsupported: "unsupported",
  idle: "idle",
  checking: "checking",
  upToDate: "up-to-date",
  available: "available",
  downloading: "downloading",
  verifying: "verifying",
  downloaded: "downloaded",
  deferred: "deferred",
  installing: "installing",
  error: "error",
};

export function toAppUpdateSnapshot(s: UpdateSnapshot): AppUpdateSnapshot {
  return {
    status: STATUS[s.phase],
    channel: "stable",
    installed: s.installed,
    latest: s.latest,
    progress: s.progress,
    checkedAt: s.checkedAt,
    error: s.error,
    canInstall: s.canInstall,
    requiresElevation: s.requiresElevation,
    automaticCheckEnabled: s.automaticCheckEnabled,
  };
}

export function toWireResult(r: UpdaterResult): AppUpdateResult {
  return r.ok
    ? { ok: true, snapshot: toAppUpdateSnapshot(r.snapshot) }
    : { ok: false, error: r.error, snapshot: toAppUpdateSnapshot(r.snapshot) };
}

/* ── Validação em RUNTIME do que chega do IPC (nunca confiar no tipo TS) ─────── */

export interface InstallRequest {
  confirmed: true;
  expectedVersion: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: "installation" | "internal" };

export function validateInstallRequest(raw: unknown): Validated<InstallRequest> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "installation" };
  }
  const r = raw as Record<string, unknown>;
  if (r.confirmed !== true) return { ok: false, error: "installation" };
  if (typeof r.expectedVersion !== "string" || r.expectedVersion.length === 0) {
    return { ok: false, error: "installation" };
  }
  return { ok: true, value: { confirmed: true, expectedVersion: r.expectedVersion } };
}

/** `enabled` tem de ser boolean verdadeiro/falso; qualquer outra coisa é erro. */
export function validateAutomaticInput(raw: unknown): Validated<boolean> {
  if (typeof raw === "boolean") return { ok: true, value: raw };
  return { ok: false, error: "internal" };
}

/**
 * Result/ snapshot de falha construído no lado do main, para os casos em que o
 * updater ainda não foi inicializado ou o payload é inválido em RUNTIME — sem
 * nunca rebentar (sem `appUpdater!`) nem fingir um estado que não aconteceu.
 */
export function failureSnapshot(code: AppUpdateErrorCode, installedVersion: string, message: string): AppUpdateSnapshot {
  return {
    status: code === "unconfigured" ? "unconfigured" : code === "unsupported" ? "unsupported" : "error",
    channel: "stable",
    installed: { version: installedVersion },
    canInstall: false,
    automaticCheckEnabled: false,
    error: { code, message },
  };
}

export function failureResult(code: AppUpdateErrorCode, installedVersion: string, message: string): AppUpdateResult {
  return { ok: false, error: code, snapshot: failureSnapshot(code, installedVersion, message) };
}
