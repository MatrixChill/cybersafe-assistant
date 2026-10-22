/** Application updater only; excludes engine/signature databases. No renderer-supplied URLs or paths. */
export type AppUpdateStatus =
  | "unconfigured" | "unsupported" | "idle" | "checking" | "up-to-date"
  | "available" | "downloading" | "verifying" | "downloaded" | "deferred"
  | "installing" | "error";
export type AppUpdateErrorCode =
  | "offline" | "timeout" | "invalid-manifest" | "untrusted-metadata"
  | "integrity" | "publisher" | "downgrade" | "interrupted" | "cancelled"
  | "busy" | "unsupported" | "unconfigured" | "installation" | "internal";
export interface AppVersionInfo {
  version: string;
  build?: string;
  commit?: string;
}
export interface AppUpdateRelease {
  version: string;
  publishedAt: string;
  /** Plain text only. Never render upstream HTML. */
  notes: string;
  sizeBytes?: number;
}
export interface AppUpdateSnapshot {
  status: AppUpdateStatus;
  channel: "stable";
  installed: AppVersionInfo;
  latest?: AppUpdateRelease;
  /** Real bytes only. Missing total means indeterminate progress. */
  progress?: { downloadedBytes: number; totalBytes?: number };
  checkedAt?: string;
  error?: { code: AppUpdateErrorCode; message: string };
  /** Main sets true only after integrity/authenticity/publisher/policy checks. */
  canInstall: boolean;
  requiresElevation?: boolean;
  automaticCheckEnabled: boolean;
}
export type AppUpdateResult =
  | { ok: true; snapshot: AppUpdateSnapshot }
  | { ok: false; error: AppUpdateErrorCode; snapshot: AppUpdateSnapshot };
export interface AppUpdateBridge {
  getSnapshot(): Promise<AppUpdateSnapshot>;
  check(): Promise<AppUpdateResult>;
  download(): Promise<AppUpdateResult>;
  cancel(): Promise<AppUpdateResult>;
  defer(): Promise<AppUpdateResult>;
  /** UI confirms first; main revalidates artifact/version and rejects active/unknown scans. */
  install(request: { confirmed: true; expectedVersion: string }): Promise<AppUpdateResult>;
  setAutomaticCheck(enabled: boolean): Promise<AppUpdateResult>;
  onState(listener: (snapshot: AppUpdateSnapshot) => void): () => void;
}
