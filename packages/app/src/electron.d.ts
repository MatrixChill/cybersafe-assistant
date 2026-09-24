import type {
  AnalysisResult,
  ConnectionSnapshot,
  PcState,
  ProtectionState,
  ProcessKillResult,
  ProcessSnapshot,
  QuarantineEntry,
  SecurityEvent,
  ThreatEvent,
  FileScanResponse,
  ScanState,
} from "@cybersafe/shared-types";

export interface ElectronAPI {
  getProtectionState: () => Promise<ProtectionState>;
  getSecurityEvents: (payload?: { limit?: number; cursor?: number }) => Promise<SecurityEvent[]>;
  getThreatEvents: () => Promise<ThreatEvent[]>;
  getProcesses: () => Promise<ProcessSnapshot[]>;
  getConnections: () => Promise<ConnectionSnapshot[]>;
  getQuarantineFiles: () => Promise<QuarantineEntry[]>;
  clearThreatEvents: () => Promise<{ success: boolean }>;
  scanFile: (filePath: string) => Promise<FileScanResponse | null>;
  killProcessTree: (pid: number) => Promise<ProcessKillResult>;
  analyzeProcess: (pid: number) => Promise<import("@cybersafe/shared-types").ProcessAnalysisResult | null>;
  getHardwareSnapshot: () => Promise<import("@cybersafe/shared-types").HardwareSnapshot>;
  getWindowsHealth: () => Promise<import("@cybersafe/shared-types").WindowsHealthSnapshot>;
  getPCState: () => Promise<PcState>;
  restoreQuarantine: (id: string, trustAfterRestore?: boolean) => Promise<{ success: boolean }>;
  deleteQuarantine: (id: string) => Promise<{ success: boolean }>;
  allowHash: (sha256: string) => Promise<{ success: boolean }>;
  allowPublisher: (publisher: string) => Promise<{ success: boolean }>;
  runRestrictedAnalysis: (filePath: string) => Promise<AnalysisResult | null>;
  updateDefinitions: () => Promise<{ success: boolean; updatedAt: string }>;
  startScan: (type: string, targetPath?: string) => Promise<{ id: string; success: boolean; error?: string }>;
  cancelScan: (id: string) => Promise<{ success: boolean }>;
  /**
   * Snapshot do scan em curso (null se nenhum). Usado para ressincronizar a UI
   * quando a página do Scanner é montada de novo ou perdeu eventos.
   */
  getActiveScan: () => Promise<ScanState | null>;
  /** Caminho real de um File largado (Electron 32+ removeu `File.path`). */
  getPathForFile: (file: File) => string;
  threatAction: (id: string, action: string) => Promise<{ success: boolean }>;
  openFileDialog: () => Promise<string | null>;
  openFolderDialog: () => Promise<string | null>;
  onSecurityEvent: (callback: (event: SecurityEvent) => void) => () => void;
  onScanProgress: (callback: (scanState: ScanState) => void) => () => void;
  /** Marca o encerramento na bridge: nenhum pedido de dados novo sai daqui. */
  beginShutdown: () => void;
  /** O main pede o modal de saída (open=true) ou manda fechá-lo (open=false). */
  onExitConfirmRequest: (callback: (open: boolean) => void) => () => void;
  /** Resposta ao pedido: false (Cancelar) nunca encerra a proteção. */
  respondExitConfirm: (confirmed: boolean) => Promise<{ received: boolean }>;
  getAutoStart: () => Promise<{ enabled: boolean; startMinimized: boolean } | null>;
  setAutoStart: (config: { enabled: boolean; startMinimized: boolean }) => Promise<{ success: boolean }>;
  getNotificationsEnabled: () => Promise<{ enabled: boolean }>;
  setNotificationsEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>;
  openReportWindow: (html: string) => Promise<{ success: boolean }>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
