/**
 * Updater — tipos de DOMÍNIO e portas de adaptador (TP-UPDATE-01).
 *
 * O domínio interno do updater é voluntariamente SEPARADO do contrato de
 * `@cybersafe/shared-types` (`AppUpdateSnapshot`). O contrato partilhado é o
 * DTO da ponte main↔renderer; aqui é a máquina de estados. A tradução
 * domínio→contrato acontece no PATCH de integração (main.ts), e só aí se
 * importam os tipos partilhados — assim nenhum tipo é duplicado.
 *
 * Nada neste ficheiro executa I/O: são apenas portas. As implementações reais
 * (rede, crypto, fs, Authenticode) são injetadas. Um updater sem origem/certificado
 * configurada fica `unconfigured` e NUNCA finge estar pronto.
 */

/** Único canal suportado hoje (o contrato fixa "stable"). */
export type UpdateChannel = "stable";

/** Fases da máquina. `phase` interno ≠ `status` do contrato (mapeado no patch). */
export type UpdatePhase =
  | "unconfigured"
  | "unsupported"
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "verifying"
  | "downloaded"
  | "deferred"
  | "installing"
  | "error";

export type UpdateErrorCode =
  | "offline"
  | "timeout"
  | "invalid-manifest"
  | "untrusted-metadata"
  | "integrity"
  | "publisher"
  | "downgrade"
  | "interrupted"
  | "cancelled"
  | "busy"
  | "unsupported"
  | "unconfigured"
  | "installation"
  | "rate-limited"
  | "internal";

export interface VersionInfo {
  version: string;
  build?: string;
  commit?: string;
}

export interface ReleaseInfo {
  version: string;
  publishedAt: string;
  /** Texto simples. Nunca HTML de upstream. */
  notes: string;
  sizeBytes?: number;
  /** Identidade do build, declarada e assinada no manifesto (opcional). */
  buildId?: string;
  /** Commit de origem do artefacto, hex minúsculo (opcional). */
  sourceCommit?: string;
}

/** Bytes reais. `totalBytes` ausente = progresso indeterminado (não é 0). */
export interface ProgressInfo {
  downloadedBytes: number;
  totalBytes?: number;
}

export interface UpdateSnapshot {
  phase: UpdatePhase;
  channel: UpdateChannel;
  installed: VersionInfo;
  latest?: ReleaseInfo;
  progress?: ProgressInfo;
  checkedAt?: string;
  error?: { code: UpdateErrorCode; message: string };
  /** true só depois de integridade + autenticidade + editor + política. */
  canInstall: boolean;
  manualDownloadOnly?: boolean;
  requiresElevation?: boolean;
  automaticCheckEnabled: boolean;
}

export type UpdaterResult =
  | { ok: true; snapshot: UpdateSnapshot }
  | { ok: false; error: UpdateErrorCode; snapshot: UpdateSnapshot };

/** Configuração RESOLVIDA e validada (o `config.ts` recusa incompleta). */
export interface UpdaterConfig {
  channel: UpdateChannel;
  feedManifestUrl: string;
  /** Origens HTTPS exatas permitidas (hostname[:porta]), sem wildcard. */
  originAllowlist: string[];
  pinnedKeyFingerprint: string;
  expectedPublisherName: string;
  cacheDir: string;
  timeoutMs: number;
  maxDownloadBytes: number;
  /** POR OMISSÃO false: nada de auto-update silencioso. */
  automaticCheckEnabled: boolean;
  /**
   * Intervalo mínimo entre `check()` bem-sucedidos OU atirados ao feed
   * (limite de pedidos). `undefined`/ausente = sem limite (fakes de teste);
   * `resolveUpdaterConfig` e a produção preenchem sempre 30_000.
   */
  minCheckIntervalMs?: number;
}

/**
 * Manifesto tal como a fonte o entrega (ainda NÃO validado). O validador em
 * `manifest.ts` exige que `channel === "stable"`, `version` semver, `file.url`
 * HTTPS dentro da allowlist, `sha256` hex de 64, `sizeBytes` inteiro positivo,
 * `publishedAt` ISO, e `signature` ed25519 com `signedByFingerprint`.
 */
export interface RawReleaseManifest {
  schema?: unknown;
  channel?: unknown;
  version?: unknown;
  publishedAt?: unknown;
  notes?: unknown;
  file?: {
    url?: unknown;
    sha256?: unknown;
    sizeBytes?: unknown;
  };
  signature?: {
    algorithm?: unknown;
    /** base64 da assinatura ed25519 sobre o corpo canónico do manifesto. */
    value?: unknown;
    /** Fingerprint da chave que assinou; tem de coincidir com a chave pinada. */
    signedByFingerprint?: unknown;
  };
  publisher?: { name?: unknown };
  requiresElevation?: unknown;
  buildId?: unknown;
  sourceCommit?: unknown;
  compatibility?: unknown;
}

/** Manifesto validado: campos garantidos pelo `manifest.ts`. */
export interface ValidatedManifest {
  schema: string;
  channel: UpdateChannel;
  version: string;
  publishedAt: string;
  notes: string;
  file: { url: string; sha256: string; sizeBytes: number };
  signature: { algorithm: "ed25519"; value: string; signedByFingerprint: string };
  publisher: { name: string };
  requiresElevation: boolean;
  /** `null` = não declarado. Presentes entram nos bytes canónicos da assinatura. */
  buildId: string | null;
  sourceCommit: string | null;
  compatibility: { minWindowsBuild: number | null; fromVersion: string | null } | null;
}

/* ── Portas injetáveis ─────────────────────────────────────────────────────── */

export type SourceOutcome =
  | { kind: "latest"; manifest: RawReleaseManifest }
  | { kind: "none" };

/** Erro de rede de fonte, tipado para não confundir offline com timeout. */
export class SourceError extends Error {
  readonly code: UpdateErrorCode;
  constructor(code: UpdateErrorCode, message: string) {
    super(message);
    this.name = "SourceError";
    this.code = code;
  }
}

/** Onde o updater vai perguntar "há novidade?". */
export interface UpdateSource {
  /** `signal` propaga cancelamento/timeout. Deve lançar `SourceError`. */
  fetchLatest(signal: AbortSignal): Promise<SourceOutcome>;
}

export interface DownloadedArtifact {
  /** Camno dentro da cache validada; nunca um caminho dado pelo renderer. */
  path: string;
  /** Bytes efetivamente escritos (medidos), para validar contra o manifesto. */
  bytes: number;
}

/** Transferir o artefacto. Deve respeitar `signal`, o cap de bytes e HTTPS. */
export interface ArtifactDownloader {
  download(
    url: string,
    destination: string,
    signal: AbortSignal,
    onProgress: (downloadedBytes: number, totalBytes?: number) => void,
  ): Promise<DownloadedArtifact>;
}

export interface SignatureVerifyResult {
  ok: boolean;
  /** Porquê (sem material sensível): "invalid" | "fingerprint-mismatch" | ... */
  reason?: string;
}

/** Verificar a assinatura ed25519 do manifesto contra a chave PINADA. */
export interface ManifestSignatureVerifier {
  verify(
    canonicalBytes: string,
    signatureBase64: string,
    signedByFingerprint: string,
  ): Promise<SignatureVerifyResult>;
}

export interface PublisherVerifyResult {
  ok: boolean;
  publisher?: string;
  reason?: string;
}

/** Verificar o editor do INSTALADOR (Authenticode em Windows). Obrigatório antes de instalar. */
export interface PublisherVerifier {
  verify(artifactPath: string, expectedPublisher: string): Promise<PublisherVerifyResult>;
}

/**
 * Estado da análise no momento de instalar. NÃO confundir com "proteção ligada":
 * `protectionEnabled` prova que o motor está ON, não que está IDLE. Instalar só
 * com análise `idle` confirmada; `running` (análise em curso) e `unknown` bloqueiam.
 */
export type ScanState = "idle" | "running" | "unknown";

export interface InstallGateContext {
  artifactPath: string;
  manifest: ValidatedManifest;
  expectedVersion: string;
  /** O utilizador confirmou no UI. */
  confirmed: true;
  /** Estado lido da proteção; só "active" permite instalar (off/unknown → bloqueado). */
  scanState: ScanState;
}

/** Adaptador de instalação. Em produção é injetado pelo main; NUNCA é autoinvocado. */
export interface Installer {
  install(context: InstallGateContext): Promise<{ ok: boolean; message?: string }>;
}

/** Camada de fs da cache (injetável para testar sem tocar no disco). */
export interface CacheFileSystem {
  ensureDir(dir: string): Promise<void>;
  /** `null` se não existir; nunca segue symlink. */
  statFile(path: string): Promise<{ size: number } | null>;
  writeAtomic(destPath: string, tmpSuffix: string, data: Uint8Array): Promise<void>;
  /** Lê os bytes de um caminho já validado pela política de cache (para o hash). */
  readFile(path: string): Promise<Uint8Array | null>;
  removePath(path: string): Promise<void>;
}

export interface Clock {
  now(): number;
  iso(): string;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};
