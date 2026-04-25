import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, Tray, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ServiceClient } from "./service-client.js";
import type { SecurityEvent } from "@cybersafe/shared-types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
const client = new ServiceClient();

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
    mainWindow?.show();
    mainWindow?.webContents.openDevTools();
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("CyberSafe Endpoint Protection");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "CyberSafe Protection", enabled: false },
    { type: "separator" },
    { label: "Open Console", click: () => mainWindow?.show() },
    {
      label: "Exit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

function wireRealtimeEvents() {
  client.onEvent((event: SecurityEvent) => {
    mainWindow?.webContents.send("service:event", event);
    // Only show desktop notifications for truly dangerous events
    if (
      (event.type === "threat.detected" || event.type === "process.blocked") &&
      (event.severity === "critical" || event.severity === "high")
    ) {
      new Notification({
        title: "CyberSafe Protection",
        body: event.summary,
      }).show();
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

app.whenReady().then(async () => {
  createWindow();
  createTray();
  registerIpc();
  app.setLoginItemSettings({ openAtLogin: true });

  try {
    await client.connect();
    wireRealtimeEvents();
  } catch (error) {
    console.error("Failed to connect to service:", error);
    dialog.showErrorBox(
      "Service Connection Failed",
      `Failed to start or connect to the CyberSafe background service. Underlying error:\n${error}`
    );
  }
});
