/** Dependências injetadas do `Updater`. Ficheiro à parte para evitar ciclo
 *  `types.ts ↔ config.ts`: só aqui o domínio encontra a `ConfigResolution`. */
import type { ConfigResolution } from "./config.ts";
import type {
  ArtifactDownloader,
  CacheFileSystem,
  Clock,
  Installer,
  Logger,
  ManifestSignatureVerifier,
  PublisherVerifier,
  ScanState,
  UpdateSource,
  VersionInfo,
} from "./types.ts";

export interface UpdaterDeps {
  config: ConfigResolution;
  /** `app.isPackaged && !portable` (e win32 para publisher NSIS); senão `unsupported`. */
  runtimeSupported: boolean;
  installed: VersionInfo;
  source: UpdateSource;
  downloader: ArtifactDownloader;
  signatureVerifier: ManifestSignatureVerifier;
  publisherVerifier: PublisherVerifier;
  installer: Installer;
  cacheFs: CacheFileSystem;
  /** Estado da ANÁLISE (idle/running/unknown), lido do serviço no instalar. */
  scanProbe: () => Promise<ScanState>;
  clock?: Clock;
  logger?: Logger;
}
