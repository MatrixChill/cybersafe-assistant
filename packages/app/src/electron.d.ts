import type {
  AnalysisResult,
  ConnectionSnapshot,
  ProtectionState,
  ProcessSnapshot,
  QuarantineEntry,
  SecurityEvent,
  ThreatEvent,
  FileScanResponse,
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
  killProcessTree: (pid: number) => Promise<{ success: boolean }>;
  analyzeProcess: (pid: number) => Promise<import("@cybersafe/shared-types").ProcessAnalysisResult | null>;
  getHardwareSnapshot: () => Promise<import("@cybersafe/shared-types").HardwareSnapshot>;
  restoreQuarantine: (id: string, trustAfterRestore?: boolean) => Promise<{ success: boolean }>;
  deleteQuarantine: (id: string) => Promise<{ success: boolean }>;
  allowHash: (sha256: string) => Promise<{ success: boolean }>;
  allowPublisher: (publisher: string) => Promise<{ success: boolean }>;
  runRestrictedAnalysis: (filePath: string) => Promise<AnalysisResult | null>;
  updateDefinitions: () => Promise<{ success: boolean; updatedAt: string }>;
  openFileDialog: () => Promise<string | null>;
  onSecurityEvent: (callback: (event: SecurityEvent) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
