import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, Tray, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { ServiceClient } from "./service-client.js";
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
  const status = client.isConnected ? 'RUNNING' : 'STOPPED';
  const wasRunning = isServiceRunning;
  isServiceRunning = status === 'RUNNING';

  // Atualiza apenas se houve mudança de status ou na primeira execução
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

function updateTrayMenu() {
  if (!tray) return;
  const statusLabel = isServiceRunning ? "🔵 Status: ATIVO" : "⚠️ Status: PARADO (Serviço Inativo)";

  tray.setToolTip(isServiceRunning ? "CyberSafe: Serviço Ativo (Motor funcionando)" : "CyberSafe: Serviço Parado (clique para iniciar)");

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: "separator" },
    { label: "Abrir Painel de Controle", click: () => mainWindow?.show() },
    {
      label: "Sair",
      click: async () => {
        isQuitting = true;
        tray?.setToolTip("Encerrando CyberSafe...");

        console.log("[Electron] Enviando comando de shutdown ao serviço...");
        await client.requestShutdown();

        // Em produção, serviceProcess deve morrer pelo exit(0)
        // O app.quit() encerra o Electron e qualquer processo filho remanescente.
        app.quit();
      },
    },
  ]));
}

function createTray() {
  const image = nativeImage.createFromPath(resolveTrayIconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));

  updateTrayMenu();

  // Poll service status every 5 seconds
  setInterval(updateServiceStatus, 5000);
  updateServiceStatus();
}

function wireRealtimeEvents() {
  client.onEvent((event: SecurityEvent) => {
    mainWindow?.webContents.send("service:event", event);
    // Only show desktop notifications for truly dangerous events
    if (
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

function registerIpc() {
  ipcMain.handle("service:get-protection-state", () => client.request("protection.getState", undefined));
  ipcMain.handle("service:get-events", (_event, payload) => client.request("events.list", payload));
  ipcMain.handle("service:get-threats", () => client.request("threats.list", undefined));
  ipcMain.handle("service:get-processes", () => client.request("processes.list", undefined));
  ipcMain.handle("service:get-connections", () => client.request("connections.list", undefined));
  ipcMain.handle("service:get-quarantine", () => client.request("quarantine.list", undefined));
  ipcMain.handle("service:clear-events", () => client.request("events.clear", undefined));
  ipcMain.handle("service:scan-artifact", (_event, filePath: string) => client.request("scan.artifact", { path: filePath }));
  ipcMain.handle("service:scan-full-system", () => client.request("scan.fullSystem", undefined));
  ipcMain.handle("service:kill-process-tree", (_event, pid: number) => client.request("process.killTree", { pid }));
  ipcMain.handle("service:analyze-process", (_event, pid: number) => client.request("process.analyze", { pid }));
  ipcMain.handle("service:get-hardware", () => client.request("hardware.snapshot", undefined));
  ipcMain.handle("service:get-windows-health", () => client.request("windows.healthSnapshot", undefined));
  ipcMain.handle("service:restore-quarantine", (_event, id: string, trustAfterRestore = false) =>
    client.request("quarantine.restore", { id, trustAfterRestore }));
  ipcMain.handle("service:delete-quarantine", (_event, id: string) => client.request("quarantine.delete", { id }));
  ipcMain.handle("service:allow-hash", (_event, sha256: string) => client.request("trust.allowHash", { sha256 }));
  ipcMain.handle("service:allow-publisher", (_event, publisher: string) =>
    client.request("trust.allowPublisher", { publisher }));
  ipcMain.handle("service:run-restricted-analysis", (_event, filePath: string) =>
    client.request("analysis.restricted", { path: filePath }));
  ipcMain.handle("service:update-definitions", () => client.request("definitions.update", undefined));
  ipcMain.handle("service:start-scan", (_event, type: string, targetPath?: string) =>
    client.request("scan.start", { type, targetPath } as any));
  ipcMain.handle("service:cancel-scan", (_event, id: string) =>
    client.request("scan.cancel", { id } as any));
  ipcMain.handle("service:threat-action", (_event, id: string, action: string) =>
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
      app.quit();
    }
  });
}

// Fecha apenas os filhos CyberSafe deste processo (nunca processos alheios).
let quitCleanupStarted = false;
app.on("before-quit", (event) => {
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
  setTimeout(() => {
    try {
      if (serviceProcess && serviceProcess.exitCode === null) serviceProcess.kill();
    } catch {}
  }, 2000);
});
