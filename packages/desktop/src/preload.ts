const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getProtectionState: () => ipcRenderer.invoke("service:get-protection-state"),
  getSecurityEvents: (payload?: { limit?: number; cursor?: number }) => ipcRenderer.invoke("service:get-events", payload),
  getThreatEvents: () => ipcRenderer.invoke("service:get-threats"),
  getProcesses: () => ipcRenderer.invoke("service:get-processes"),
  getConnections: () => ipcRenderer.invoke("service:get-connections"),
  getQuarantineFiles: () => ipcRenderer.invoke("service:get-quarantine"),
  clearThreatEvents: () => ipcRenderer.invoke("service:clear-events"),
  scanFile: (filePath: string) => ipcRenderer.invoke("service:scan-artifact", filePath),
  killProcessTree: (pid: number) => ipcRenderer.invoke("service:kill-process-tree", pid),
  analyzeProcess: (pid: number) => ipcRenderer.invoke("service:analyze-process", pid),
  getHardwareSnapshot: () => ipcRenderer.invoke("service:get-hardware"),
  restoreQuarantine: (id: string, trustAfterRestore?: boolean) =>
    ipcRenderer.invoke("service:restore-quarantine", id, trustAfterRestore),
  deleteQuarantine: (id: string) => ipcRenderer.invoke("service:delete-quarantine", id),
  allowHash: (sha256: string) => ipcRenderer.invoke("service:allow-hash", sha256),
  allowPublisher: (publisher: string) => ipcRenderer.invoke("service:allow-publisher", publisher),
  runRestrictedAnalysis: (filePath: string) => ipcRenderer.invoke("service:run-restricted-analysis", filePath),
  updateDefinitions: () => ipcRenderer.invoke("service:update-definitions"),
  openFileDialog: () => ipcRenderer.invoke("dialog:open-file"),
  onSecurityEvent: (callback: (event: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: any) => callback(value);
    ipcRenderer.on("service:event", listener);
    return () => ipcRenderer.removeListener("service:event", listener);
  },
});
