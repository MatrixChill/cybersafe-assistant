import type {
  AnalysisResult,
  AppUpdateBridge,
  ConnectionSnapshot,
  DefinitionsUpdateResult,
  DefinitionsStatus,
  PcState,
  ProtectionIntentState,
  ProtectionOptInResult,
  ProtectionState,
  ProtectionToggleConfirmation,
  ProcessKillResult,
  ProcessTerminationPreparation,
  ProcessTerminationResult,
  ProcessSnapshot,
  QuarantineEntry,
  QuarantinePolicyState,
  QuarantinePolicyResult,
  QuarantinePolicyUpdate,
  ScanHistoryPage,
  SecurityEvent,
  ThreatEvent,
  FileScanResponse,
  ScanState,
  UsbProtectionSnapshot,
  UsbScanRequest,
  UsbScanResult,
  UsbCancelRequest,
  UsbCancelResult,
} from "@cybersafe/shared-types";

export interface ElectronAPI {
  getServiceConnectionState: () => Promise<{ connected: boolean }>;
  onServiceConnectionState: (callback: (state: { connected: boolean }) => void) => () => void;
  authSession: { read: () => Promise<string | null>; write: (token: string, remember: boolean) => Promise<void>; clear: () => Promise<void> };
  getProtectionState: () => Promise<ProtectionState>;
  /**
   * Ativa/desliga a proteção. `protectionEnabled: null` NÃO é "desligado": é
   * "o serviço não confirmou" — a UI tem de o mostrar como não confirmado.
   */
  setProtection: (enabled: boolean) => Promise<ProtectionToggleConfirmation | null>;
  /** Pausa a proteção por N minutos; devolve a confirmação do motor. */
  pauseProtection: (minutes: number) => Promise<boolean | null>;
  /**
   * R8-USB: snapshot do observador de unidades USB (`usb.getState`). Coalescido
   * e bounded — consulta-se quando o painel precisa, nunca por cada progresso.
   */
  getUsbProtection: () => Promise<UsbProtectionSnapshot>;
  /**
   * Opt-in da análise automática de unidades USB (`usb.configure`). Devolve o
   * snapshot JÁ configurado: é dele que a UI lê o estado, nunca do pedido.
   */
  configureUsbProtection: (config: { enabled: boolean }) => Promise<UsbProtectionSnapshot>;
  /**
   * R8-USB: análise MANUAL de um dispositivo já detetado (`usb.scan`). O
   * renderer envia a IDENTIDADE do dispositivo + um `requestId` do gesto
   * autorizado — nunca um caminho/raiz (o serviço resolve-os por enumeração
   * fresca). `consent` tem de ser o literal `true`; sem ele o serviço recusa
   * com `{ ok:false, error }` em vez de aceitar por omissão. Funciona com a
   * proteção automática DESLIGADA e não a liga.
   */
  usbScan: (payload: UsbScanRequest) => Promise<UsbScanResult>;
  /**
   * R8-USB: cancela APENAS a análise USB com esses DOIS ids (`usb.cancel`).
   * Uma análise manual do utilizador ou uma sessão nova nunca é tocada.
   */
  usbCancel: (payload: UsbCancelRequest) => Promise<UsbCancelResult>;
  getSecurityEvents: (payload?: { limit?: number; cursor?: number }) => Promise<SecurityEvent[]>;
  getThreatEvents: () => Promise<ThreatEvent[]>;
  /**
   * P1-PROCESS-TRUTH: a lista vem com a verdade da enumeração. O array nu só
   * existiu enquanto o serviço não conseguia dizer que tinha falhado.
   */
  getProcesses: () => Promise<import("@cybersafe/shared-types").ProcessListResult>;
  getConnections: () => Promise<ConnectionSnapshot[]>;
  getQuarantineFiles: () => Promise<QuarantineEntry[]>;
  /** Política efetiva lida do serviço; nunca inferida do renderer. */
  getQuarantinePolicy: () => Promise<QuarantinePolicyState>;
  /** `consent:true` é obrigatório para ativar `automatic-high-confidence`. */
  setQuarantinePolicy: (payload: QuarantinePolicyUpdate) => Promise<QuarantinePolicyResult>;
  getExclusions: () => Promise<import("@cybersafe/shared-types").ExclusionConfig | null>;
  updateExclusions: (config: { rules: import("@cybersafe/shared-types").ExclusionRule[] }) => Promise<{ success: boolean; error?: string } | null>;
  clearThreatEvents: () => Promise<{ success: boolean }>;
  scanFile: (filePath: string) => Promise<FileScanResponse | null>;
  prepareProcessTermination: (selection: {pid:number;startedAt:string}) => Promise<ProcessTerminationPreparation>;
  confirmProcessTermination: (ticket:string) => Promise<ProcessTerminationResult>;
  cancelProcessTermination: (ticket:string) => Promise<{cancelled:boolean}>;
  killProcessTree: (pid: number) => Promise<ProcessKillResult>;
  analyzeProcess: (pid: number) => Promise<import("@cybersafe/shared-types").ProcessAnalysisResult | null>;
  getHardwareSnapshot: () => Promise<import("@cybersafe/shared-types").HardwareSnapshot>;
  getWindowsHealth: () => Promise<import("@cybersafe/shared-types").WindowsHealthSnapshot>;
  getPCState: () => Promise<PcState>;
  restoreQuarantine: (id: string, trustAfterRestore?: boolean) => Promise<{ success: boolean; error?: string }>;
  deleteQuarantine: (id: string) => Promise<{ success: boolean; error?: string }>;
  allowHash: (sha256: string) => Promise<{ success: boolean }>;
  allowPublisher: (publisher: string) => Promise<{ success: boolean }>;
  runRestrictedAnalysis: (filePath: string) => Promise<AnalysisResult | null>;
  updateDefinitions: () => Promise<DefinitionsUpdateResult>;
  getDefinitionsStatus: () => Promise<DefinitionsStatus | null>;
  /** Preferencia de retoma ao arrancar. Le o que o servico confirma em disco. */
  getProtectionIntent: () => Promise<ProtectionIntentState>;
  /** Unica forma de escrever a preferencia. `guardado:false` = nao foi guardada. */
  setProtectionIntent: (enabled: boolean) => Promise<ProtectionOptInResult>;
  startScan: (
    type: string,
    targetPath?: string,
    /** Diagnóstico: identifica o caller no log `[ScanStartTrace]`. Não altera o pedido. */
    origin?: string,
  ) => Promise<{ id: string; success: boolean; error?: string }>;
  cancelScan: (id: string) => Promise<{ success: boolean }>;
  /**
   * Snapshot do scan em curso (null se nenhum). Usado para ressincronizar a UI
   * quando a página do Scanner é montada de novo ou perdeu eventos.
   */
  getActiveScan: () => Promise<ScanState | null>;
  getLastScan: (id?: string) => Promise<ScanState | null>;
  /** Histórico persistente de análises (paginado, mais recente primeiro). */
  getScanHistory: (payload?: { limit?: number; cursor?: string }) => Promise<ScanHistoryPage>;
  onScanSession: (callback: (delivery: { state?: unknown; error?: string }) => void) => () => void;
  /** Caminho real de um File largado (Electron 32+ removeu `File.path`). */
  getPathForFile: (file: File) => string;
  threatAction: (id: string, action: string, expectedSha256?: string) => Promise<{ success: boolean; error?: string }>;
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
  /** O modal ficou apresentado (para o main parar os reenvios e revelar a janela). */
  ackExitConfirm: () => Promise<{ received: boolean }>;
  /**
   * Cores da barra de janela (Window Controls Overlay no Windows) sincronizadas
   * com o tema ativo. O main valida-as; `{ ok: false }` significa "ignorado".
   */
  setTitleBarOverlay: (payload: { color: string; symbolColor: string; height?: number }) => Promise<{ ok: boolean }>;
  /** Updater de aplicação. Hoje o main responde UNCONFIGURED; UI nunca inventa dados. */
  appUpdate: AppUpdateBridge;
  /** Navegação pedida pela tray. A assinatura devolve a função de unsubscribe. */
  onNavigateRequest: (callback: (page: string) => void) => () => void;
  getAutoStart: () => Promise<{ enabled: boolean; startMinimized: boolean } | null>;
  setAutoStart: (config: { enabled: boolean; startMinimized: boolean }) => Promise<{ success: boolean }>;
  getNotificationsEnabled: () => Promise<{ enabled: boolean }>;
  setNotificationsEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>;
  openReportWindow: (html: string) => Promise<{ success: boolean }>;
  /** Guarda o relatório como PDF real (diálogo de escolha + renderização A4). */
  aiCredentials: {
    getStatus: () => Promise<{ hasKey: boolean; provider: string; state: string }>;
    save: (key: string, provider: string) => Promise<{ ok: boolean; applied?: boolean; hasKey?: boolean; provider?: string; state?: string; error?: string }>;
    clear: () => Promise<{ ok: boolean; applied?: boolean; hasKey?: boolean; provider?: string; state?: string; error?: string }>;
  };
  exportReportPdf: (html: string, suggestedName: string) => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
