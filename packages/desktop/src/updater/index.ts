/**
 * Updater (TP-UPDATE-01) — superfície pública do módulo.
 *
 * O main/preload NÃO importam daqui os tipos da ponte: a tradução domínio→
 * `@cybersafe/shared-types` (`AppUpdateSnapshot`) é feita no `main.ts` via PATCH
 * de integração. Este índice só expõe a máquina + as portas para a wiring.
 */
export * from "./types.ts";
export {
  isValidSemVer,
  parseSemVer,
  isCoreVersion,
  compareSemVer,
  isUpgrade,
  isDowngrade,
} from "./semver.ts";
export { validateManifest, canonicalManifestBytes } from "./manifest.ts";
export { resolveUpdaterConfig, isUrlAllowed } from "./config.ts";
export { artifactCachePath, artifactFinalPath, CacheStore } from "./cache.ts";
export { sha256Hex, fingerprintFromPublicKey, createEd25519ManifestVerifier } from "./crypto.ts";
export { HttpsFeedSource, LocalFixtureSource } from "./sources.ts";
export {
  TransportError,
  createNodeHttpsOpener,
  createHttpsFeedFetcher,
  createHttpsArtifactDownloader,
  nodeFileSink,
} from "./node-transport.ts";
export type {
  HttpStreamOpener,
  OpenedHttpResponse,
  FeedFetcherOptions,
  ArtifactSink,
  ArtifactSinkFactory,
  ArtifactDownloaderOptions,
} from "./node-transport.ts";
export { CacheFsError, createNodeCacheFileSystem } from "./node-cache-fs.ts";
export type { NodeCacheFsOptions } from "./node-cache-fs.ts";
export { createUpdater, Updater, BLOCKED_INSTALLER } from "./updater.ts";
export type { UpdaterDeps } from "./deps.ts";
