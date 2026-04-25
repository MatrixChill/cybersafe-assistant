import { contextBridge, ipcRenderer } from "electron";
//#region src/preload.ts
contextBridge.exposeInMainWorld("electronAPI", {
	getThreatEvents: () => ipcRenderer.invoke("get-threat-events"),
	clearThreatEvents: () => ipcRenderer.invoke("clear-threat-events"),
	scanFile: (filePath) => ipcRenderer.invoke("scan-file", filePath),
	onThreatDetected: (callback) => {
		ipcRenderer.on("threat-detected", (_event, value) => callback(value));
	},
	onActivityLog: (callback) => {
		ipcRenderer.on("activity-log", (_event, value) => callback(value));
	},
	onQuickScan: (callback) => {
		ipcRenderer.on("quick-scan", () => callback());
	},
	getSystemStatus: () => ipcRenderer.invoke("get-system-status"),
	getSystemMetrics: () => ipcRenderer.invoke("get-system-metrics"),
	openFileDialog: () => ipcRenderer.invoke("open-file-dialog"),
	openFolderDialog: () => ipcRenderer.invoke("open-folder-dialog"),
	startMonitoring: (paths) => ipcRenderer.invoke("start-monitoring", paths),
	stopMonitoring: () => ipcRenderer.invoke("stop-monitoring"),
	getEngineStatus: () => ipcRenderer.invoke("get-engine-status"),
	getQuarantineFiles: () => ipcRenderer.invoke("get-quarantine-files"),
	restoreQuarantine: (id) => ipcRenderer.invoke("restore-quarantine", id),
	deleteQuarantine: (id) => ipcRenderer.invoke("delete-quarantine", id),
	getAppInfo: () => ipcRenderer.invoke("get-app-info")
});
//#endregion
