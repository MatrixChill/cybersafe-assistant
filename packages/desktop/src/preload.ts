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

// Conserva a entrega do tray enquanto a navegação monta a página do Scanner.
let lastScanDelivery: { state?: unknown; error?: string } | null = null;
const scanDeliveryListeners = new Set<(delivery: { state?: unknown; error?: string }) => void>();
ipcRenderer.on("app:scan-session", (_event: unknown, delivery: { state?: unknown; error?: string }) => {
  lastScanDelivery = delivery;
  for (const callback of scanDeliveryListeners) callback(delivery);
});

// A base da API local vem do processo principal: em dev é a porta isolada do
// perfil (4100+), empacotado é o valor de produção já conhecido pelo componente.
// Sem isto o renderer teria um URL fixo, e um dev apontaria para a API da
// instalação do utilizador.
if (process.env.CYBERSAFE_API_BASE) {
  contextBridge.exposeInMainWorld("__CYBERSAFE_API_BASE__", process.env.CYBERSAFE_API_BASE);
}

contextBridge.exposeInMainWorld("electronAPI", {
  /** Marca o encerramento na bridge (o renderer já parou os pollers). */
  beginShutdown: () => {
    shuttingDown = true;
  },
  authSession: {
    read: () => invoke("auth-session:read"),
    write: (token: string, remember: boolean) => shuttingDown
      ? Promise.reject(new Error("A aplicação está a encerrar."))
      : invoke("auth-session:write", token, remember),
    // Logout must still invalidate persistence while the shell is closing.
    clear: () => ipcRenderer.invoke("auth-session:clear"),
  },
  getProtectionState: () => invoke("service:get-protection-state"),
  // Escrita de proteção (Painel): reutiliza o caminho já usado pela tray.
  setProtection: (enabled: boolean) => invoke("service:set-protection", enabled),
  pauseProtection: (minutes: number) => invoke("service:pause-protection", minutes),
  getServiceConnectionState: () => invoke("service:get-connection-state"),
  onServiceConnectionState: (callback: (state: { connected: boolean }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: { connected: boolean }) => {
      if (!shuttingDown) callback(state);
    };
    ipcRenderer.on("service:connection-state", listener);
    return () => ipcRenderer.removeListener("service:connection-state", listener);
  },
  getSecurityEvents: (payload?: { limit?: number; cursor?: number }) => invoke("service:get-events", payload),
  getThreatEvents: () => invoke("service:get-threats"),
  getProcesses: () => invoke("service:get-processes"),
  getConnections: () => invoke("service:get-connections"),
  getQuarantineFiles: () => invoke("service:get-quarantine"),
  clearThreatEvents: () => invoke("service:clear-events"),
  scanFile: (filePath: string) => invoke("service:scan-artifact", filePath),
  scanFullSystem: () => invoke("service:scan-full-system"),
  prepareProcessTermination: (selection: {pid:number;startedAt:string}) => {
    if (!selection || !Number.isInteger(selection.pid) || typeof selection.startedAt!=="string") return Promise.reject(new Error("Seleção inválida"));
    return invoke("service:prepare-process-termination", {pid:selection.pid,startedAt:selection.startedAt});
  },
  confirmProcessTermination: (ticket:string) => {
    if(typeof ticket!=="string" || ticket.length!==36) return Promise.reject(new Error("Confirmação inválida"));
    return invoke("service:confirm-process-termination",ticket);
  },
  cancelProcessTermination: (ticket:string) => {
    if(typeof ticket!=="string" || ticket.length!==36) return Promise.reject(new Error("Confirmação inválida"));
    return invoke("service:cancel-process-termination",ticket);
  },
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
  getDefinitionsStatus: () => invoke("service:get-definitions-status"),
  // Opt-in de retoma ao arrancar: passagem sem lógica própria. A preferência é
  // lida e escrita pelo serviço, que é quem confirma o que está em disco.
  getProtectionIntent: () => invoke("service:get-protection-intent"),
  setProtectionIntent: (enabled: boolean) => invoke("service:set-protection-intent", enabled),
  // `origin` é DIAGNÓSTICO apenas: identifica o caller no log sem mudar o
  // pedido enviado ao serviço. Ver `[ScanStartTrace]` em main.ts.
  startScan: (type: string, targetPath?: string, origin?: string) =>
    invoke("service:start-scan", type, targetPath, origin),
  // Snapshot do scan ativo (ressincronização após remount/navegação de página).
  getActiveScan: () => invoke("service:get-active-scan"),
  // Proteção USB (R8): leitura do estado e opt-in. A ponte só transporta
  // `{ enabled: boolean }` — nenhum caminho de dispositivo atravessa daqui.
  getUsbProtection: () => invoke("service:get-usb-protection"),
  configureUsbProtection: (payload: { enabled: boolean }) =>
    invoke("service:configure-usb-protection", payload),
  // Análise MANUAL de um dispositivo USB (R8): a ponte só transporta a
  // IDENTIDADE do dispositivo e um `requestId` do gesto — nenhum caminho/raiz
  // atravessa daqui (o serviço resolve as raízes por enumeração fresca).
  usbScan: (payload: { deviceId: string; requestId: string; consent: true }) =>
    invoke("service:usb-scan", payload),
  usbCancel: (payload: { deviceId: string; scanId: string }) =>
    invoke("service:usb-cancel", payload),
  getLastScan: (id?: string) => invoke("service:get-last-scan", id),
  getScanHistory: (payload?: { limit?: number; cursor?: string }) =>
    invoke("service:get-scan-history", payload),
  onScanSession: (callback: (delivery: { state?: unknown; error?: string }) => void) => {
    scanDeliveryListeners.add(callback);
    const cached = lastScanDelivery;
    if (cached) queueMicrotask(() => { if (scanDeliveryListeners.has(callback)) callback(cached); });
    return () => { scanDeliveryListeners.delete(callback); };
  },
  cancelScan: (id: string) => invoke("service:cancel-scan", id),
  // Identidade confirmada: o digest esperado da deteção clicada acompanha o
  // pedido; o backend recusa byte-swap no mesmo caminho (RECOVERY-SECURITY).
  threatAction: (id: string, action: string, expectedSha256?: string) => invoke("service:threat-action", id, action, expectedSha256),
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
  // O modal está APRESENTADO: o main para de reenviar e revela a janela já
  // pintada (sem janela branca). Sem este ack, um pedido falhado deixava o
  // clique em "Sair" sem efeito até ao timeout.
  ackExitConfirm: () => invoke("app:exit-confirm-ack"),
  // Barra de janela (Windows): o renderer envia as cores do tema ativo para os
  // botões nativos (minimizar/maximizar/fechar) não ficarem fora do design.
  setTitleBarOverlay: (payload: { color: string; symbolColor: string; height?: number }) =>
    invoke("app:set-titlebar-overlay", payload),
  // Updater da aplicação — superfície restrita (AppUpdateBridge). Sem URLs/caminhos
  // vindos do renderer; `install` exige confirmation+expectedVersion; `onState`
  // devolve unsubscribe. Hoje o main responde UNCONFIGURED.
  appUpdate: {
    getSnapshot: () => invoke("app:update-get-snapshot"),
    check: () => invoke("app:update-check"),
    download: () => invoke("app:update-download"),
    revealDownload: () => invoke("app:update-reveal"),
    cancel: () => invoke("app:update-cancel"),
    defer: () => invoke("app:update-defer"),
    install: (request: { confirmed: true; expectedVersion: string }) => invoke("app:update-install", request),
    setAutomaticCheck: (enabled: boolean) => invoke("app:update-set-automatic", enabled),
    onState: (callback: (snapshot: unknown) => void) => {
      const listener = (_event: unknown, snapshot: unknown) => callback(snapshot);
      ipcRenderer.on("app:update-state", listener);
      return () => ipcRenderer.removeListener("app:update-state", listener);
    },
  },
  // Navegação pedida pela tray: o menu abre a janela E leva o renderer à página
  // certa. Sem isto, os itens do menu eram botões que abriam a app no sitio
  // errado — ou pior, nada.
  onNavigateRequest: (callback: (page: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, page: unknown) =>
      callback(typeof page === "string" ? page : String(page ?? ""));
    ipcRenderer.on("app:navigate", listener);
    return () => ipcRenderer.removeListener("app:navigate", listener);
  },
  getAutoStart: () => invoke("app:get-auto-start"),
  setAutoStart: (config: { enabled: boolean; startMinimized: boolean }) =>
    invoke("app:set-auto-start", config),
  getNotificationsEnabled: () => invoke("app:get-notifications-enabled"),
  setNotificationsEnabled: (enabled: boolean) =>
    invoke("app:set-notifications-enabled", enabled),
  openReportWindow: (html: string) => invoke("app:open-report-window", html),
  aiCredentials: {
    getStatus: () => invoke("ai-credentials:get-status"),
    save: (key: string, provider: string) => {
      if (typeof key !== "string" || key.length < 16 || key.length > 512 || /[\r\n\x00]/.test(key) || !["groq", "openai"].includes(provider))
        return Promise.reject(new Error("Configuração de IA inválida."));
      return invoke("ai-credentials:save", key, provider);
    },
    clear: () => invoke("ai-credentials:clear"),
  },
  exportReportPdf: (html: string, suggestedName: string) =>
    invoke("app:export-pdf", html, suggestedName),
});
