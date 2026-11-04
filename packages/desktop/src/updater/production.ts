import {release} from 'node:os';
import {createWindowsInstaller} from './windows-installer.js';
import {createWindowsPublisherVerifier} from './windows-publisher.js';
import type {InstallGateContext, ScanState} from './types.js';
import stableTrust from './release-trust.json';
import previewTrust from './preview-trust.json';
import { createUnconfiguredUpdater, BLOCKED_PUBLISHER } from './bridge.ts';
import { createUpdater, BLOCKED_INSTALLER } from './updater.ts';
import { resolveUpdaterConfig } from './config.ts';
import { createEd25519ManifestVerifier, fingerprintFromPublicKey } from './crypto.ts';
import { createNodeCacheFileSystem } from './node-cache-fs.ts';
import { createNodeHttpsOpener, createHttpsFeedFetcher, createHttpsArtifactDownloader } from './node-transport.ts';
import { createGitHubReleaseOpener, isGitHubReleaseUrl } from './github-transport.ts';
import { HttpsFeedSource } from './sources.ts';

interface InstallationRuntime {
  stagingRoot:string; journalFile:string; launcherPath:string;
  requestShutdown:()=>Promise<void>;
  confirmConsent:(context:InstallGateContext)=>Promise<boolean>;
  scanProbe:()=>Promise<ScanState>;
}
/** Build-pinned trust; assisted installation remains a separately disabled gate. */
export function createProductionUpdater(opts: {previewOptIn?: boolean; runtimeSupported: boolean; installation?: InstallationRuntime; automaticCheckEnabled?: boolean; installedVersion: string; cacheDir: string; installedBuild?: string; installedCommit?: string}) {
  const unavailable = () => createUnconfiguredUpdater(opts);
  const preview = opts.previewOptIn === true && /^\d+\.\d+\.\d+-rc\.[1-9]\d*$/.test(opts.installedVersion);
  const trust = preview ? previewTrust : stableTrust;
  if ((!preview && !stableTrust.enabled) || !isGitHubReleaseUrl(trust.feedManifestUrl)) return unavailable();
  try {
    if (fingerprintFromPublicKey(trust.publicKeyPem) !== trust.pinnedKeyFingerprint) return unavailable();
  } catch { return unavailable(); }
  const config = resolveUpdaterConfig({
    channel: preview ? 'preview' : 'stable', feedManifestUrl: trust.feedManifestUrl,
    originAllowlist: ['github.com'], pinnedKeyFingerprint: trust.pinnedKeyFingerprint,
    expectedPublisherName: trust.publisherLabel, cacheDir: opts.cacheDir,
    timeoutMs: 120000, maxDownloadBytes: 1024 * 1024 * 1024,
    automaticCheckEnabled: !preview && opts.automaticCheckEnabled === true, minCheckIntervalMs: 30_000,
  });
  if (!config.ok) return unavailable();
  const transport = createGitHubReleaseOpener(createNodeHttpsOpener());
  const assisted=!preview&&stableTrust.assistedInstallationEnabled===true&&opts.runtimeSupported&&opts.installation!==undefined;
  const signatureVerifier=createEd25519ManifestVerifier({publicKey:trust.publicKeyPem,pinnedFingerprint:trust.pinnedKeyFingerprint});
  const publisherVerifier=assisted?createWindowsPublisherVerifier():BLOCKED_PUBLISHER;
  const installer=assisted&&opts.installation?createWindowsInstaller({
    ...opts.installation,signatureVerifier,publisherVerifier,expectedPublisher:trust.publisherLabel,authorizeExecution:()=>assisted,
  }):BLOCKED_INSTALLER;
  return createUpdater({
    config, runtimeSupported: opts.runtimeSupported, installed: {version: opts.installedVersion, build: opts.installedBuild, commit: opts.installedCommit},
    manualDownloadOnly: !assisted,
    previewWindowsBuild: preview ? Number(release().split(".")[2]) : undefined,
    source: new HttpsFeedSource(config.config, createHttpsFeedFetcher(config.config, transport)),
    downloader: createHttpsArtifactDownloader(config.config, transport),
    signatureVerifier,
    publisherVerifier, installer,
    cacheFs: createNodeCacheFileSystem(opts.cacheDir), scanProbe: opts.installation?.scanProbe ?? (async () => 'unknown'),
  });
}
