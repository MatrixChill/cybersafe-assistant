import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, Tray, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { ServiceClient } from "./service-client.js";
import { buildTrayMenuTemplate, type TrayProtectionInfo } from "./tray-menu.js";
import { createExitConfirmation } from "./exit-confirmation.js";
import { guardedServiceRequest } from "./ipc-guard.js";
import { PIPE_NAME } from "@cybersafe/core";
import type { SecurityEvent } from "@cybersafe/shared-types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
const client = new ServiceClient();
const notificationHistory = new Map<string, number>();
const DEBOUNCE_TIME = 15000; // 15 segundos de silêncio para o mesmo arquivo

// ── Preferências locais (persistidas em userData/settings.json) ──
let preferences: { notificationsEnabled: boolean } = { notificationsEnabled: true };

function settingsFilePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadPreferences() {
  try {
    if (fs.existsSync(settingsFilePath())) {
      const raw = fs.readFileSync(settingsFilePath(), "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.notificationsEnabled === "boolean") {
        preferences.notificationsEnabled = parsed.notificationsEnabled;
      }
    }
  } catch {
    // Ficheiro inválido não deve impedir o arranque.
  }
}

function savePreferences() {
  try {
    fs.mkdirSync(path.dirname(settingsFilePath()), { recursive: true });
    fs.writeFileSync(settingsFilePath(), JSON.stringify(preferences, null, 2), "utf8");
  } catch {
    // Falha de escrita não é fatal.
  }
}

// Preferência de ícones: CS Shield (símbolo oficial compacto) > logo > padrão.
function assetsPath(...segments: string[]): string {
  return path.join(__dirname, "assets", ...segments);
}

function resolveTrayIconPath(): string {
  const candidates = [
    // Versão simplificada desenhada para tamanhos minúsculos (16/32)
    assetsPath("icons", "cybersafe-shield-cs-simple-32.png"),
    assetsPath("icons", "cybersafe-shield-cs-32.png"),
    assetsPath("icons", "cybersafe-shield-cs-16.png"),
    assetsPath("cybersafe-logo.png"),
    assetsPath("icon.png"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
}

function resolveWindowIconPath(): string {
  const candidates = [
    assetsPath("icon.ico"),
    assetsPath("icons", "cybersafe-shield-cs-256.png"),
    assetsPath("icons", "cybersafe-shield-cs-128.png"),
    assetsPath("cybersafe-logo.png"),
    assetsPath("icon.png"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1];
}

// Em dev, copia o branding da marca (na raiz do repo) para dist/assets se existir.
function syncBrandingAssets() {
  if (app.isPackaged) return;
  try {
    const repoRoot = path.resolve(app.getAppPath(), "..", "..");
    const brandingDir = path.join(repoRoot, "assets", "branding");
    if (!fs.existsSync(brandingDir)) return;
    fs.mkdirSync(assetsPath(), { recursive: true });

    const copyPngTree = (srcDir: string, dstDir: string) => {
      for (const root of fs.readdirSync(srcDir)) {
        const srcEntry = path.join(srcDir, root);
        const stat = fs.statSync(srcEntry);
        if (stat.isDirectory()) {
          copyPngTree(srcEntry, path.join(dstDir, root));
        } else if (path.extname(srcEntry).toLowerCase() === ".png") {
          fs.mkdirSync(dstDir, { recursive: true });
          fs.copyFileSync(srcEntry, path.join(dstDir, path.basename(srcEntry)));
        }
      }
    };

    // Sincroniza os assets otimizados (icons/ e matrix/) quando presentes.
    const optimizedDir = path.join(brandingDir, "optimized");
    if (fs.existsSync(optimizedDir)) {
      copyPngTree(optimizedDir, assetsPath());
    }
    for (const file of fs.readdirSync(brandingDir)) {
      if (!file.toLowerCase().endsWith(".png")) continue;
      fs.copyFileSync(path.join(brandingDir, file), assetsPath(file));
      console.log("[Electron] Logo da marca aplicado:", file);
    }
  } catch (error) {
    console.error("[Electron] Falha ao sincronizar branding:", error);
  }
}

// Detecta se foi lançado via auto-start (boot do Windows) para iniciar escondido na tray
const launchHidden = process.argv.includes("--hidden");

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    backgroundColor: "#090b12",
    icon: resolveWindowIconPath(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "index.html"));
  } else {
    const tryLoad = () => {
      mainWindow?.loadURL("http://localhost:5173").catch(() => {
        setTimeout(tryLoad, 1000);
      });
    };
    tryLoad();
  }

  mainWindow.once("ready-to-show", () => {
    // No auto-start (--hidden), a janela permanece oculta; o user abre pela tray.
    if (!launchHidden) {
      mainWindow?.show();
    }
    if (!app.isPackaged) {
      mainWindow?.webContents.openDevTools();
    }
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createSplashScreen() {
  splashWindow = new BrowserWindow({
    width: 450,
    height: 350,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const splashPath = path.join(__dirname, "assets", "splash.html");
  splashWindow.loadFile(splashPath);
}

import { spawn, type ChildProcess } from "node:child_process";

let isServiceRunning = false;
let serviceProcess: ChildProcess | null = null;
let statusInterval: ReturnType<typeof setInterval> | null = null;

/** Tenta abrir o named pipe do serviço. true = um serviço vivo está a servir. */
function probePipe(timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    const socket = net.createConnection(PIPE_NAME);
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });
}

/** Aguarda o pipe ficar acessível (readiness real) com timeout e pausas. */
async function waitForPipe(deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await probePipe(900)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return probePipe(900);
}

function startServiceProcess(): Promise<boolean> {
  if (!app.isPackaged) {
    console.log("[Electron] Modo dev: serviço assumido via concurrently");
    return Promise.resolve(true);
  }

  // Reutiliza um serviço já ativo (ex.: instância órfã de boot anterior).
  // Evita duplicar processos e "EADDRINUSE" na próxima instância.
  return probePipe(1500).then(async (alreadyActive) => {
    if (alreadyActive) {
      console.log("[Electron] Serviço já ativo no pipe. Reutilizando.");
      return true;
    }

    const serviceEntry = path.join(app.getAppPath(), "node_modules", "@cybersafe", "service", "dist", "index.js");

    console.log("[Electron] Iniciando serviço embutido:", serviceEntry);
    serviceProcess = spawn(process.execPath, [serviceEntry], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });

    let exitedEarly = false;
    serviceProcess.on("exit", (code) => {
      exitedEarly = true;
      console.log(`[Electron] Processo do Serviço encerrou com código: ${code}`);
      serviceProcess = null;
    });

    serviceProcess.on("error", (err) => {
      exitedEarly = true;
      console.error("[Electron] Falha ao iniciar processo do serviço:", err);
    });

    // Readiness assíncrono do próprio serviço (além do probe do pipe).
    serviceProcess.on("message", (msg: any) => {
      if (msg?.type === "service-ready") {
        console.log("[Electron] Serviço sinalizou service-ready via IPC.");
      }
    });

    const ready = await waitForPipe(25_000);
    if (!ready) {
      console.error("[Electron] Serviço não ficou pronto a tempo (pipe inacessível).");
      if (serviceProcess && !exitedEarly) {
        try { serviceProcess.kill(); } catch {}
      }
    }
    return ready;
  });
}

async function updateServiceStatus() {
  // Shutdown: a tray deixa de fazer leituras periódicas ao serviço.
  if (isQuitting) return;
  const status = client.isConnected ? 'RUNNING' : 'STOPPED';
  isServiceRunning = status === 'RUNNING';

  // Atualiza o menu da tray com o estado real (proteção + contadores).
  await refreshTrayProtectionInfo();
  updateTrayMenu();

  if (tray) {
    try {
      const defaultIconPath = resolveTrayIconPath();

      // Usa fs para checar se as imagens específicas existem, senão faz fallback pro ícone padrão
      let iconPathToUse = defaultIconPath;

      if (isServiceRunning && fs.existsSync(assetsPath("tray-icon-active.png"))) {
        iconPathToUse = assetsPath("tray-icon-active.png");
      } else if (!isServiceRunning && fs.existsSync(assetsPath("tray-icon-warning.png"))) {
        iconPathToUse = assetsPath("tray-icon-warning.png");
      }

      const image = nativeImage.createFromPath(iconPathToUse);
      if (!image.isEmpty()) {
        tray.setImage(image.resize({ width: 16, height: 16 }));
      }
    } catch (e) {
      console.error("Erro ao atualizar icone", e);
    }
  }
}

async function setProtectionEnabled(enabled: boolean): Promise<boolean> {
  const result = await (enabled ? client.request("monitor.start", undefined) : client.request("monitor.stop", undefined)).catch(() => ({ ok: false, protectionEnabled: !enabled }));

  const protectionEnabled = typeof result === "object" && result && "protectionEnabled" in result
    ? Boolean((result as { protectionEnabled?: boolean }).protectionEnabled)
    : Boolean((result as { ok?: boolean }).ok);

  return enabled ? protectionEnabled : !protectionEnabled;
}

/** Estado da proteção em cache para a tray (atualizado a cada poll de 5s). */
let trayProtectionInfo: TrayProtectionInfo = {
  serviceRunning: false,
  status: null,
  score: null,
  threats: null,
  quarantine: null,
};

async function refreshTrayProtectionInfo() {
  // Shutdown: nunca iniciar uma nova leitura ao serviço.
  if (isQuitting) return;
  try {
    const state = await Promise.race([
      client.request("protection.getState", undefined) as Promise<any>,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
    ]);
    const riskScore = state?.stats?.riskScore;
    trayProtectionInfo = {
      serviceRunning: isServiceRunning,
      // O estado interno fica aqui (e nos logs) — tray-menu.ts traduz antes de
      // chegar à UI, por isso o enum nunca é mostrado ao utilizador.
      status: typeof state?.status === "string" ? state.status : null,
      score: typeof riskScore === "number" ? Math.max(0, 100 - riskScore) : null,
      threats: typeof state?.stats?.totalEvents === "number" ? state.stats.totalEvents : null,
      quarantine: typeof state?.stats?.quarantinedCount === "number" ? state.stats.quarantinedCount : null,
    };
  } catch {
    trayProtectionInfo = {
      serviceRunning: isServiceRunning,
      status: null,
      score: null,
      threats: null,
      quarantine: null,
    };
  }
}

/** Encerramento completo: serviço → watcher/motores → Electron. Sem órfãos. */
async function quitCyberSafe() {
  // isQuitting = estado de shutdown da app: a partir daqui nem o renderer
  // (via guarda dos handlers) nem a tray iniciam leituras novas ao serviço.
  isQuitting = true;
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
  tray?.setToolTip("Encerrando CyberSafe...");

  console.log("[Electron] Electron shutdown requested");
  console.log("[Electron] Enviando comando de shutdown ao serviço...");
  await client.requestShutdown().catch((err) =>
    console.error("[Electron] Shutdown request falhou:", err));
  console.log("[Electron] Ligação ao serviço fechada; a terminar o Electron.");

  // O pedido shutdown já termina watcher/motores/updater no serviço (exit(0))
  // e o before-quit garante o kill do serviceProcess remanescente.
  app.quit();
}

function updateTrayMenu() {
  if (!tray) return;

  tray.setToolTip(
    isServiceRunning
      ? "CyberSafe: serviço ativo (proteção em tempo real a funcionar)"
      : "CyberSafe: serviço parado (proteção inativa)",
  );

  // Copy + tradução de estados vivem em tray-menu.ts (testável, sem enums crus).
  const template = buildTrayMenuTemplate(
    { ...trayProtectionInfo, serviceRunning: isServiceRunning },
    {
      open: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
      // Confirmação integrada (modal CyberSafe) — nunca o diálogo nativo branco.
      exit: () => {
        void exitConfirmation.request();
      },
    },
  );

  tray.setContextMenu(Menu.buildFromTemplate(template as Electron.MenuItemConstructorOptions[]));
}

// ── Confirmação de saída (modal CyberSafe no renderer) ──
// O diálogo nativo branco do Windows deixou de ser a UX: o tray pede o modal
// ao renderer e só depois corre o shutdown JÁ existente (quitCyberSafe).
let exitConfirmResolve: ((confirmed: boolean) => void) | null = null;
const EXIT_CONFIRM_TIMEOUT_MS = 30_000;

/** Mostra (ou recria, se tiver sido destruída) a janela principal. */
function ensureMainWindow(): BrowserWindow | null {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = null;
    createWindow();
  }
  const win = mainWindow;
  if (!win || win.isDestroyed()) return null;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return win;
}

/** O renderer consegue desenhar o modal? (janela viva e não crashada) */
function canAskRenderer(win: BrowserWindow | null): win is BrowserWindow {
  if (!win || win.isDestroyed()) return false;
  const contents = win.webContents;
  if (contents.isDestroyed()) return false;
  try {
    return !contents.isCrashed();
  } catch {
    return true;
  }
}

/** Pergunta ao utilizador no renderer (modal CyberSafe). true = confirmar. */
function askExitConfirmation(): Promise<boolean> {
  const win = ensureMainWindow();
  if (!canAskRenderer(win)) {
    console.warn("[Electron] Renderer indisponível para o modal de saída — confirmação de último recurso.");
    return nativeExitFallback();
  }

  return new Promise<boolean>((resolve) => {
    exitConfirmResolve = resolve;
    const send = () => {
      try {
        win.webContents.send("app:exit-confirm", true);
      } catch (error) {
        console.error("[Electron] Falha ao abrir o modal de saída:", error);
      }
    };
    // Janela recriada: espera o renderer carregar antes de pedir o modal.
    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", send);
    } else {
      send();
    }
  });
}

/**
 * Último recurso, usado APENAS quando não há renderer utilizável: sem isto o
 * utilizador ficaria sem forma de encerrar a aplicação pela tray.
 */
async function nativeExitFallback(): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Cancelar", "Sair"],
    defaultId: 0,
    cancelId: 0,
    title: "Sair do CyberSafe",
    message: "Sair do CyberSafe?",
    detail: "A proteção em tempo real será encerrada neste computador.",
  });
  return response === 1;
}

/**
 * Uma pergunta em curso não se duplica e cancelar nunca encerra. O shutdown
 * (quitCyberSafe) é chamado no máximo uma vez.
 */
const exitConfirmation = createExitConfirmation({
  ask: askExitConfirmation,
  onConfirmed: () => quitCyberSafe(),
  timeoutMs: EXIT_CONFIRM_TIMEOUT_MS,
  onTimeout: () => {
    const win = mainWindow;
    exitConfirmResolve = null;
    console.warn("[Electron] Sem resposta ao pedido de confirmação de saída — encerramento cancelado.");
    try {
      if (win && !win.isDestroyed()) win.webContents.send("app:exit-confirm", false);
    } catch {
      // A janela desapareceu entretanto: nada a fazer.
    }
  },
  onError: (error) => console.error("[Electron] Confirmação de saída falhou:", error),
});

function createTray() {
  const image = nativeImage.createFromPath(resolveTrayIconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));

  updateTrayMenu();

  // Poll service status every 5 seconds
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(updateServiceStatus, 5000);
  updateServiceStatus();
}

function wireRealtimeEvents() {
  client.onEvent((event: SecurityEvent) => {
    // Shutdown: nada de eventos para o renderer (que já está a encerrar).
    if (isQuitting) return;
    // Per-event logging stays off by default: a scan emits an event every few
    // files, and logging each one in the main process is pure overhead.
    if (process.env.CYBERSAFE_DEBUG_SCAN === "1" && event.type === "scan.progress") {
      const data = (event.data ?? {}) as { id?: string; status?: string; progress?: number; filesScanned?: number; phase?: string };
      console.log(`[ScanIPC] forward scanId=${data.id ?? "n/a"} status=${data.status} phase=${data.phase} progress=${data.progress} files=${data.filesScanned} at=${new Date().toISOString()}`);
    }
    mainWindow?.webContents.send("service:event", event);
    // Only show desktop notifications for truly dangerous events
    if (
      preferences.notificationsEnabled &&
      (event.type === "threat.detected" || event.type === "process.blocked") &&
      (event.severity === "critical" || event.severity === "high")
    ) {
      const fileId = event.data?.artifactPath || event.summary;
      const lastShown = notificationHistory.get(fileId) || 0;
      const now = Date.now();

      if (now - lastShown > DEBOUNCE_TIME) {
        notificationHistory.set(fileId, now);
        new Notification({
          title: "CyberSafe Protection",
          body: event.summary,
        }).show();
      }
    }
  });
}

let ipcRegistered = false;

function registerIpc() {
  // Idempotente: um segundo registo lançaria "Attempted to register a second
  // handler for '<channel>'" e deixaria o IPC do scanner morto.
  if (ipcRegistered) return;
  ipcRegistered = true;

  /**
   * Canal do renderer contra o serviço, com a guarda de shutdown:
   * - durante o shutdown não inicia leituras novas (o renderer já parou os
   *   pollers; isto é a segunda linha de defesa);
   * - pedidos que estavam em voo quando o pipe foi desligado resolvem em null,
   *   em vez do ruído "Error occurred in handler ... Service client disconnected";
   * - em runtime normal os erros reais continuam a propagar para o renderer.
   */
  const serviceRequest = (
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown,
  ) =>
    ipcMain.handle(channel, (event, ...args) =>
      guardedServiceRequest(() => isQuitting, () => Promise.resolve(handler(event, ...args))),
    );

  serviceRequest("service:get-protection-state", () => client.request("protection.getState", undefined));
  serviceRequest("service:get-events", (_event, payload) => client.request("events.list", payload));
  serviceRequest("service:get-threats", () => client.request("threats.list", undefined));
  serviceRequest("service:get-processes", () => client.request("processes.list", undefined));
  serviceRequest("service:get-connections", () => client.request("connections.list", undefined));
  serviceRequest("service:get-quarantine", () => client.request("quarantine.list", undefined));
  serviceRequest("service:clear-events", () => client.request("events.clear", undefined));
  serviceRequest("service:scan-artifact", (_event, filePath: string) => client.request("scan.artifact", { path: filePath }));
  serviceRequest("service:scan-full-system", () => client.request("scan.fullSystem", undefined));
  serviceRequest("service:kill-process-tree", (_event, pid: number) => client.request("process.killTree", { pid }));
  serviceRequest("service:analyze-process", (_event, pid: number) => client.request("process.analyze", { pid }));
  serviceRequest("service:get-hardware", () => client.request("hardware.snapshot", undefined));
  serviceRequest("service:get-windows-health", () => client.request("windows.healthSnapshot", undefined));
  serviceRequest("service:get-pcstate", () => client.request("pcstate.get", undefined));
  serviceRequest("service:restore-quarantine", (_event, id: string, trustAfterRestore = false) =>
    client.request("quarantine.restore", { id, trustAfterRestore }));
  serviceRequest("service:delete-quarantine", (_event, id: string) => client.request("quarantine.delete", { id }));
  serviceRequest("service:allow-hash", (_event, sha256: string) => client.request("trust.allowHash", { sha256 }));
  serviceRequest("service:allow-publisher", (_event, publisher: string) =>
    client.request("trust.allowPublisher", { publisher }));
  serviceRequest("service:run-restricted-analysis", (_event, filePath: string) =>
    client.request("analysis.restricted", { path: filePath }));
  serviceRequest("service:update-definitions", () => client.request("definitions.update", undefined));
  serviceRequest("service:start-scan", async (_event, type: string, targetPath?: string) => {
    console.log(`[ScanIPC] request received type=${type} targetPath=${targetPath ?? ""} at=${new Date().toISOString()}`);
    try {
      const result = await client.request("scan.start", { type, targetPath } as any);
      console.log(`[ScanIPC] forwarded to service -> ok=${result && (result as any).ok !== false} at=${new Date().toISOString()}`);
      return result;
    } catch (err: any) {
      console.error(`[ScanIPC] forwarded to service -> ERROR ${err.message} at=${new Date().toISOString()}`);
      throw err;
    }
  });
  // Snapshot de ressincronização: a UI pergunta pelo scan ativo ao montar
  // (voltar à página do Scanner não pode perder o progresso em curso).
  serviceRequest("service:get-active-scan", () => client.request("scan.getActive", undefined));
  serviceRequest("service:cancel-scan", (_event, id: string) =>
    client.request("scan.cancel", { id } as any));
  serviceRequest("service:threat-action", (_event, id: string, action: string) =>
    client.request("threat.action", { id, action } as any));

  ipcMain.handle("dialog:open-file", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "All Files", extensions: ["*"] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("dialog:open-folder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ── Confirmação de saída (modal CyberSafe no renderer) ──
  ipcMain.handle("app:exit-confirm-response", (_event, confirmed: boolean) => {
    const resolve = exitConfirmResolve;
    exitConfirmResolve = null;
    if (resolve) resolve(Boolean(confirmed));
    return { received: true };
  });

  // ── Auto-Start IPC ──
  ipcMain.handle("app:get-auto-start", () => {
    if (process.platform !== "win32") return { enabled: false, startMinimized: false };
    const settings = app.getLoginItemSettings();
    return { enabled: settings.openAtLogin, startMinimized: settings.args?.includes("--hidden") ?? false };
  });

  ipcMain.handle("app:set-auto-start", (_event, config: { enabled: boolean; startMinimized: boolean }) => {
    if (process.platform !== "win32") return { success: false };
    app.setLoginItemSettings({
      openAtLogin: config.enabled,
      path: process.execPath,
      args: config.enabled && config.startMinimized ? ["--hidden"] : [],
    });
    return { success: true };
  });

  // ── Notifications IPC ──
  ipcMain.handle("app:get-notifications-enabled", () => ({ enabled: preferences.notificationsEnabled }));

  ipcMain.handle("app:set-notifications-enabled", (_event, enabled: boolean) => {
    preferences.notificationsEnabled = Boolean(enabled);
    savePreferences();
    return { enabled: preferences.notificationsEnabled };
  });

  // ── Report Window IPC ──
  ipcMain.handle("app:open-report-window", async (_event, html: string) => {
    const reportWin = new BrowserWindow({
      width: 860,
      height: 640,
      title: "CyberSafe — Relatório de Segurança",
      icon: resolveWindowIconPath(),
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
      show: false,
    });
    reportWin.once("ready-to-show", () => reportWin.show());
    // data URI com encoding seguro (data:text/html;charset=utf-8)
    await reportWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    return { success: true };
  });
}

// ── Auto-Start Registration (Production Only, Windows Only) ──────────────────
function configureAutoStart() {
  if (process.platform !== "win32") return;

  app.setLoginItemSettings({
    openAtLogin: false, // FASE 1.1: Auto-start desativado por padrão
    path: process.execPath,
    args: app.isPackaged ? ["--hidden"] : [path.resolve(process.argv[1]), "--hidden"],
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    loadPreferences();
    // Identidade da aplicação no Windows (taskbar/notificações/ateliers).
    app.setName("CyberSafe");
    if (process.platform === "win32") {
      app.setAppUserModelId("com.cybersafe.assistant");
    }
    // Splash só aparece se não for boot silencioso
    if (!launchHidden) {
      createSplashScreen();
    }

    syncBrandingAssets();
    createWindow();
    registerIpc();
    configureAutoStart();
    createTray();

    const serviceOk = await startServiceProcess();

    if (!serviceOk) {
      console.error("Failed to start/reuse the background service.");
      splashWindow?.close();
      splashWindow = null;
      dialog.showErrorBox(
        "CyberSafe — Serviço indisponível",
        "O serviço de proteção em segundo plano não conseguiu iniciar.\nVerifique os logs em %USERPROFILE%\\.cybersafe-service\\error.log."
      );
      // Também é um shutdown: o renderer não pode continuar a pedir dados.
      isQuitting = true;
      app.quit();
      return;
    }

    try {
      await client.connect();
      wireRealtimeEvents();

      // Fecha splash após conexão bem-sucedida
      if (splashWindow) {
        setTimeout(() => {
          splashWindow?.close();
          splashWindow = null;
        }, 1000);
      }
    } catch (error) {
      console.error("Failed to connect to service:", error);
      splashWindow?.close();
      splashWindow = null;
      dialog.showErrorBox(
        "Service Connection Failed",
        `Failed to start or connect to the CyberSafe background service. Underlying error:\n${error}`
      );
      isQuitting = true;
      app.quit();
    }
  });
}

// Fecha apenas os filhos CyberSafe deste processo (nunca processos alheios).
let quitCleanupStarted = false;
app.on("before-quit", (event) => {
  if (!app.isPackaged) {
    // Em `npm run dev`, o `concurrently -k` mata os restantes watchers
    // (tsx/vite) com SIGTERM quando o Electron sai; os scripts npm que se
    // seguem terminam com code 1. Isso é comportamento esperado do dev
    // runner, não uma falha do produto — distinguimos no log.
    console.log("[Electron] EXPECTED DEV SHUTDOWN — encerramento limpo (não é falha).");
  }
  if (!serviceProcess || !serviceProcess.pid) return;
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  event.preventDefault();

  const deadline = Date.now() + 3000;
  const timer = setInterval(() => {
    if (Date.now() >= deadline || !serviceProcess || serviceProcess.exitCode !== null) {
      clearInterval(timer);
      app.exit(0);
    }
  }, 150);
  // Clear the status polling interval
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
  setTimeout(() => {
    try {
      if (serviceProcess && serviceProcess.exitCode === null) serviceProcess.kill();
    } catch {}
  }, 2000);
});
