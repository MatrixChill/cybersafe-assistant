const { contextBridge, ipcRenderer, webUtils } = require("electron");

// ── Guarda de shutdown na própria bridge ────────────────────────────────
// Depois de o utilizador confirmar "Sair", nenhum pedido de dados novo sai
// daqui: devolve um cancelamento controlado (null) em vez de chegar ao main
// já com o ServiceClient desligado ("Service client disconnected" repetido).
// A resposta da confirmação é a única exceção — sem ela o main não saberia
// que o utilizador disse "sim".
let shuttingDown = false;
const SHUTDOWN_ALLOWED_CHANNELS = new Set(["app:exit-confirm-response"]);

function invoke(channel: string, ...args: any[]) {
  if (shuttingDown && !SHUTDOWN_ALLOWED_CHANNELS.has(channel)) {
    return Promise.resolve(null);
  }
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld("electronAPI", {
  /** Marca o encerramento na bridge (o renderer já parou os pollers). */
  beginShutdown: () => {
    shuttingDown = true;
  },
  getProtectionState: () => invoke("service:get-protection-state"),
  getSecurityEvents: (payload?: { limit?: number; cursor?: number }) => invoke("service:get-events", payload),
  getThreatEvents: () => invoke("service:get-threats"),
  getProcesses: () => invoke("service:get-processes"),
  getConnections: () => invoke("service:get-connections"),
  getQuarantineFiles: () => invoke("service:get-quarantine"),
  clearThreatEvents: () => invoke("service:clear-events"),
  scanFile: (filePath: string) => invoke("service:scan-artifact", filePath),
  scanFullSystem: () => invoke("service:scan-full-system"),
  killProcessTree: (pid: number) => invoke("service:kill-process-tree", pid),
  analyzeProcess: (pid: number) => invoke("service:analyze-process", pid),
  getHardwareSnapshot: () => invoke("service:get-hardware"),
  getWindowsHealth: () => invoke("service:get-windows-health"),
  getPCState: () => invoke("service:get-pcstate"),
  restoreQuarantine: (id: string, trustAfterRestore?: boolean) =>
    invoke("service:restore-quarantine", id, trustAfterRestore),
  deleteQuarantine: (id: string) => invoke("service:delete-quarantine", id),
  allowHash: (sha256: string) => invoke("service:allow-hash", sha256),
  allowPublisher: (publisher: string) => invoke("service:allow-publisher", publisher),
  runRestrictedAnalysis: (filePath: string) => invoke("service:run-restricted-analysis", filePath),
  updateDefinitions: () => invoke("service:update-definitions"),
  startScan: (type: string, targetPath?: string) => invoke("service:start-scan", type, targetPath),
  // Snapshot do scan ativo (ressincronização após remount/navegação de página).
  getActiveScan: () => invoke("service:get-active-scan"),
  cancelScan: (id: string) => invoke("service:cancel-scan", id),
  threatAction: (id: string, action: string) => invoke("service:threat-action", id, action),
  openFileDialog: () => invoke("dialog:open-file"),
  // Electron 32+ removeu `File.path`; o caminho real só existe no preload.
  getPathForFile: (file: any) => webUtils.getPathForFile(file),
  openFolderDialog: () => invoke("dialog:open-folder"),
  onSecurityEvent: (callback: (event: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: any) => {
      // Durante o encerramento o renderer já não reage a eventos do serviço.
      if (shuttingDown) return;
      callback(value);
    };
    ipcRenderer.on("service:event", listener);
    return () => ipcRenderer.removeListener("service:event", listener);
  },
  onScanProgress: (callback: (scanState: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: any) => {
      // Filter for scan.progress events only
      const isScanProgress = value?.type === "scan.progress" && value?.data;
      if (process.env.CYBERSAFE_DEBUG_SCAN === "1") {
        console.log(`[ScanPreload] event type=${value?.type} isScanProgress=${isScanProgress} at=${new Date().toISOString()}`, value?.data ? { id: value.data.id, status: value.data.status, progress: value.data.progress } : null);
      }
      if (isScanProgress && !shuttingDown) {
        callback(value.data);
      }
    };
    ipcRenderer.on("service:event", listener);
    return () => ipcRenderer.removeListener("service:event", listener);
  },
  // Confirmação de saída: o main pede o modal CyberSafe e o renderer responde.
  onExitConfirmRequest: (callback: (open: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, open: boolean) => callback(Boolean(open));
    ipcRenderer.on("app:exit-confirm", listener);
    return () => ipcRenderer.removeListener("app:exit-confirm", listener);
  },
  respondExitConfirm: (confirmed: boolean) =>
    invoke("app:exit-confirm-response", Boolean(confirmed)),
  getAutoStart: () => invoke("app:get-auto-start"),
  setAutoStart: (config: { enabled: boolean; startMinimized: boolean }) =>
    invoke("app:set-auto-start", config),
  getNotificationsEnabled: () => invoke("app:get-notifications-enabled"),
  setNotificationsEnabled: (enabled: boolean) =>
    invoke("app:set-notifications-enabled", enabled),
  openReportWindow: (html: string) => invoke("app:open-report-window", html),
});
