import trust from './release-trust.json';
import { createUnconfiguredUpdater, BLOCKED_PUBLISHER } from './bridge.ts';
import { createUpdater, BLOCKED_INSTALLER } from './updater.ts';
import { resolveUpdaterConfig } from './config.ts';
import { createEd25519ManifestVerifier, fingerprintFromPublicKey } from './crypto.ts';
import { createNodeCacheFileSystem } from './node-cache-fs.ts';
import { createNodeHttpsOpener, createHttpsFeedFetcher, createHttpsArtifactDownloader } from './node-transport.ts';
import { createGitHubReleaseOpener, isGitHubReleaseUrl } from './github-transport.ts';
import { HttpsFeedSource } from './sources.ts';

/** Build-pinned public trust, never renderer/env-controlled. No installer execution. */
export function createProductionUpdater(opts: {runtimeSupported: boolean; installedVersion: string; cacheDir: string}) {
  const unavailable = () => createUnconfiguredUpdater(opts);
  if (!trust.enabled || !isGitHubReleaseUrl(trust.feedManifestUrl)) return unavailable();
  try {
    if (fingerprintFromPublicKey(trust.publicKeyPem) !== trust.pinnedKeyFingerprint) return unavailable();
  } catch { return unavailable(); }
  const config = resolveUpdaterConfig({
    channel: 'stable', feedManifestUrl: trust.feedManifestUrl,
    originAllowlist: ['github.com'], pinnedKeyFingerprint: trust.pinnedKeyFingerprint,
    expectedPublisherName: trust.publisherLabel, cacheDir: opts.cacheDir,
    timeoutMs: 120000, maxDownloadBytes: 1024 * 1024 * 1024,
    automaticCheckEnabled: false,
  });
  if (!config.ok) return unavailable();
  const transport = createGitHubReleaseOpener(createNodeHttpsOpener());
  return createUpdater({
    config, runtimeSupported: opts.runtimeSupported, installed: {version: opts.installedVersion},
    manualDownloadOnly: true,
    source: new HttpsFeedSource(config.config, createHttpsFeedFetcher(config.config, transport)),
    downloader: createHttpsArtifactDownloader(config.config, transport),
    signatureVerifier: createEd25519ManifestVerifier({publicKey: trust.publicKeyPem, pinnedFingerprint: trust.pinnedKeyFingerprint}),
    publisherVerifier: BLOCKED_PUBLISHER, installer: BLOCKED_INSTALLER,
    cacheFs: createNodeCacheFileSystem(opts.cacheDir), scanProbe: async () => 'unknown',
  });
}
