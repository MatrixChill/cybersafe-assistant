import { appendDesktopLog } from './desktop-log.js';

const EVENTS = new Set(['electron-start','electron-ready','service-attempt','service-result','api-attempt','api-entry','api-secret','api-child-spawn','api-child-error','api-child-exit','api-child-stderr','api-ready','api-unavailable','api-result','api-skipped','api-failed','boot-failure']);
const CLASSIFICATIONS = new Set(['UNKNOWN','NATIVE_ABI_MISMATCH','MODULE_NOT_FOUND','PERMISSION_DENIED','EADDRINUSE','SERVICE_IDENTITY_OR_HANDSHAKE','API_SECRET_UNAVAILABLE','ISOLATION_REFUSED','TIMEOUT','SQLITE','EPERM_EACCES','SPAWN_ERROR']);
const REASONS = new Set(['entry-missing','secret-unavailable','spawn-failed','health-timeout','child-exit','health-check-failed','owner-tracking-failed','child-exit','health-check-failed','owner-tracking-failed']);
const ERROR_CODES = new Set(['ENOENT','ENOTDIR','EPERM','EACCES','ENOSPC','EBUSY','EIO','EADDRINUSE','ECONNREFUSED','ETIMEDOUT','ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_DLOPEN_FAILED']);
const STATUSES = new Set(['pending','connected','started','failed','skipped','ready','unavailable','error']);

/** Only a fixed technical classification is persisted; never the source text. */
export function classifyStartupError(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message} ${(error as NodeJS.ErrnoException).code ?? ''}` : String(error ?? '');
  if (/NODE_MODULE_VERSION|different Node.js version/i.test(text)) return 'NATIVE_ABI_MISMATCH';
  if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:package|module)/i.test(text)) return 'MODULE_NOT_FOUND';
  const sqlite = text.match(/\bSQLITE_[A-Z_]{1,24}\b/); if (sqlite) return sqlite[0];
  if (/EADDRINUSE/i.test(text)) return 'EADDRINUSE';
  if (/EACCES|EPERM/i.test(text)) return 'PERMISSION_DENIED';
  if (/handshake|autentica|outro servi[çc]o|credencial.*pipe/i.test(text)) return 'SERVICE_IDENTITY_OR_HANDSHAKE';
  if (/JWT_SECRET|segredo/i.test(text)) return 'API_SECRET_UNAVAILABLE';
  if (/ISOLAMENTO RECUSADO/i.test(text)) return 'ISOLATION_REFUSED';
  if (/timeout|expirou|n[ãa]o respondeu|n[ãa]o ficou/i.test(text)) return 'TIMEOUT';
  return 'UNKNOWN';
}

/** Reuses the existing bounded/rotating desktop writer. No stdout redirection. */
export function createStartupDiagnostic(
  file: string,
  enabled = true,
  writer: typeof appendDesktopLog = appendDesktopLog,
): (event: string, details?: Record<string, unknown>) => void {
  return (event, details = {}) => {
    if (!enabled || !EVENTS.has(event)) return;
    try {
      const safe: Record<string, unknown> = {};
      for (const key of ['pid','parentPid','bytes','elapsedMs']) {
        const value=details[key]; if (typeof value==='number' && Number.isSafeInteger(value) && value>=0) safe[key]=value;
      }
      if (details.exitCode===null || (typeof details.exitCode==='number' && Number.isSafeInteger(details.exitCode))) safe.exitCode=details.exitCode;
      if (typeof details.port==='number' && Number.isInteger(details.port) && details.port>0 && details.port<=65535) {
        safe.port=details.port; safe.endpoint=`http://127.0.0.1:${details.port}`;
      }
      for (const key of ['packaged','found','available','healthy']) if (typeof details[key]==='boolean') safe[key]=details[key];
      if (typeof details.status==='string' && STATUSES.has(details.status)) safe.status=details.status;
      if (typeof details.version==='string' && /^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]{1,40})?$/.test(details.version)) safe.version=details.version;
      if (typeof details.signal==='string' && /^SIG(?:TERM|KILL|INT|ABRT|SEGV|BREAK)$/.test(details.signal)) safe.signal=details.signal;
      if (typeof details.reason==='string' && REASONS.has(details.reason)) safe.reason=details.reason;
      if (typeof details.code==='string' && (ERROR_CODES.has(details.code)||/^SQLITE_[A-Z_]{1,24}$/.test(details.code))) safe.code=details.code;
      const code=details.classification ?? details.code;
      if (typeof code==='string' && (CLASSIFICATIONS.has(code)||/^SQLITE_[A-Z_]{1,24}$/.test(code))) safe.classification=code;
      writer(file,event,safe);
    } catch { /* Diagnostics never alter startup or ownership decisions. */ }
  };
}
