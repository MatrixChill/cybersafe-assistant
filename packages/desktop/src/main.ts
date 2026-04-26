import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, Tray, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ServiceClient } from "./service-client.js";
import type { SecurityEvent } from "@cybersafe/shared-types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
const client = new ServiceClient();
const notificationHistory = new Map<string, number>();
const DEBOUNCE_TIME = 15000; // 15 segundos de silêncio para o mesmo arquivo

// Detecta se foi lançado via auto-start (boot do Windows) para iniciar escondido na tray
const launchHidden = process.argv.includes("--hidden");

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    backgroundColor: "#090b12",
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

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
let isServiceRunning = false;

async function checkServiceStatusLegacy(): Promise<'RUNNING' | 'STOPPED' | 'UNKNOWN'> {
  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -Command "Get-Service -Name \'CyberSafe Engine\' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Status"',
      { windowsHide: true, timeout: 5000 }
    );
    if (stdout.trim() === 'Running') return 'RUNNING';
    if (stdout.trim() === 'Stopped') return 'STOPPED';
    return 'UNKNOWN';
  } catch (error) {
    console.error('Falha ao ler status do serviço:', error);
    return 'UNKNOWN';
  }
}

async function updateServiceStatus() {
  const status = await checkServiceStatusLegacy();
  const wasRunning = isServiceRunning;
  isServiceRunning = status === 'RUNNING';
  
  // Atualiza apenas se houve mudança de status ou na primeira execução
  updateTrayMenu();
  
  if (tray) {
    try {
      const activeIconPath = path.join(__dirname, "assets", "tray-icon-active.png");
      const warningIconPath = path.join(__dirname, "assets", "tray-icon-warning.png");
      const defaultIconPath = path.join(__dirname, "assets", "icon.png");
      
      // Usa fs para checar se as imagens específicas existem, senão faz fallback pro icon.png padrão
      const fs = require("node:fs");
      let iconPathToUse = defaultIconPath;
      
      if (isServiceRunning && fs.existsSync(activeIconPath)) {
        iconPathToUse = activeIconPath;
      } else if (!isServiceRunning && fs.existsSync(warningIconPath)) {
        iconPathToUse = warningIconPath;
      }
      
      tray.setImage(nativeImage.createFromPath(iconPathToUse));
    } catch (e) {
      console.error("Erro ao atualizar icone", e);
    }
  }
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
      label: "Iniciar Motor (Admin)",
      visible: !isServiceRunning,
      click: () => {
        // Tenta iniciar o serviço se estiver parado
        exec('powershell -Command "Start-Process sc.exe -ArgumentList \'start\", \"\"CyberSafe Engine\"\"\' -Verb RunAs"');
      }
    },
    {
      label: "Sair",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray() {
  const iconPath = path.join(__dirname, "assets", "icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  
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
  ipcMain.handle("service:kill-process-tree", (_event, pid: number) => client.request("process.killTree", { pid }));
  ipcMain.handle("service:analyze-process", (_event, pid: number) => client.request("process.analyze", { pid }));
  ipcMain.handle("service:get-hardware", () => client.request("hardware.snapshot", undefined));
  ipcMain.handle("service:restore-quarantine", (_event, id: string, trustAfterRestore = false) =>
    client.request("quarantine.restore", { id, trustAfterRestore }));
  ipcMain.handle("service:delete-quarantine", (_event, id: string) => client.request("quarantine.delete", { id }));
  ipcMain.handle("service:allow-hash", (_event, sha256: string) => client.request("trust.allowHash", { sha256 }));
  ipcMain.handle("service:allow-publisher", (_event, publisher: string) =>
    client.request("trust.allowPublisher", { publisher }));
  ipcMain.handle("service:run-restricted-analysis", (_event, filePath: string) =>
    client.request("analysis.restricted", { path: filePath }));
  ipcMain.handle("service:update-definitions", () => client.request("definitions.update", undefined));

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
    openAtLogin: true,
    path: process.execPath,
    args: app.isPackaged ? ["--hidden"] : [path.resolve(process.argv[1]), "--hidden"],
  });
}

app.whenReady().then(async () => {
  // Splash só aparece se não for boot silencioso
  if (!launchHidden) {
    createSplashScreen();
  }

  createWindow();
  registerIpc();
  configureAutoStart();
  createTray();

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
