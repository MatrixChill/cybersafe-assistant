import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { ScanState, ScanType, SecurityEvent } from "@cybersafe/shared-types";
import type { FileScanResponse, ThreatEvent } from "@cybersafe/shared-types";

/** Interface to avoid circular dependency with engine.ts */
export interface ScanEngine {
  scanArtifact(filePath: string, source: ThreatEvent["source"]): Promise<FileScanResponse | null>;
  emitScanProgress(scanState: ScanState): void;
}

export class ScanManager {
  private activeScans = new Map<string, ScanState>();
  private currentScanPromise: Promise<void> | null = null;
  private isCancelled = new Set<string>();

  constructor(private engine: ScanEngine) {}

  public getActiveScans(): ScanState[] {
    return Array.from(this.activeScans.values());
  }

  public getScan(id: string): ScanState | undefined {
    return this.activeScans.get(id);
  }

  public cancelScan(id: string) {
    if (this.activeScans.has(id)) {
      this.isCancelled.add(id);
      const state = this.activeScans.get(id)!;
      if (state.status === "running" || state.status === "queued") {
        this.updateScan(id, { status: "cancelled", endTime: new Date().toISOString() });
      }
    }
  }

  private updateScan(id: string, updates: Partial<ScanState>) {
    const current = this.activeScans.get(id);
    if (current) {
      const updated = { ...current, ...updates };
      this.activeScans.set(id, updated);
      // Emit scan progress event to notify connected clients
      this.engine.emitScanProgress(updated);
    }
  }

  public async startScan(type: ScanType, targetPath?: string): Promise<string> {
    const id = randomUUID();
    const state: ScanState = {
      id,
      type,
      status: "queued",
      progress: 0,
      filesScanned: 0,
      threatsFound: 0,
      startTime: new Date().toISOString(),
      targetPath
    };

    this.activeScans.set(id, state);

    // We run the scan async and don't block
    void this.runScanLoop(id, type, targetPath);
    return id;
  }

  private async runScanLoop(id: string, type: ScanType, targetPath?: string) {
    // Basic queueing: wait for current scan if any
    while (this.currentScanPromise) {
      if (this.isCancelled.has(id)) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (this.isCancelled.has(id)) return;

    let resolveScan: () => void;
    this.currentScanPromise = new Promise(r => { resolveScan = r; });
    this.updateScan(id, { status: "running" });

    try {
      const pathsToScan = await this.resolvePathsForScan(type, targetPath);
      let totalFiles = 0;
      let scanned = 0;
      let threats = 0;

      // 1. Gather files
      const files: string[] = [];
      for (const p of pathsToScan) {
        if (this.isCancelled.has(id)) break;
        await this.gatherFiles(p, files, id);
      }

      totalFiles = files.length;
      if (totalFiles === 0) {
        this.updateScan(id, { status: "completed", progress: 100, endTime: new Date().toISOString() });
        resolveScan!();
        this.currentScanPromise = null;
        return;
      }

      // 2. Scan files
      for (let i = 0; i < files.length; i++) {
        if (this.isCancelled.has(id)) break;

        const file = files[i];
        try {
          const result = await this.engine.scanArtifact(file, "system-scanner");
          scanned++;
          if (result && result.highRiskCount > 0) {
            threats++;
          }
        } catch (error) {
          console.error(`[ScanManager] Error scanning ${file}:`, error);
        }

        if (i % 10 === 0 || i === files.length - 1) {
          this.updateScan(id, {
            progress: Math.floor((scanned / totalFiles) * 100),
            filesScanned: scanned,
            threatsFound: threats
          });
        }
      }

      const finalState = this.activeScans.get(id)!;
      if (finalState.status === "running") {
         this.updateScan(id, { status: "completed", progress: 100, endTime: new Date().toISOString() });
      }

    } catch (error) {
      console.error(`[ScanManager] Scan ${id} failed:`, error);
      this.updateScan(id, { status: "failed", error: String(error), endTime: new Date().toISOString() });
    } finally {
      this.isCancelled.delete(id);
      resolveScan!();
      this.currentScanPromise = null;
    }
  }

  private async gatherFiles(dir: string, filesList: string[], scanId: string) {
    if (this.isCancelled.has(scanId)) return;
    try {
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat) return;

      if (stat.isFile()) {
        filesList.push(dir);
        return;
      }

      if (!stat.isDirectory()) return;

      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (this.isCancelled.has(scanId)) return;
        const fullPath = path.join(dir, entry.name);

        // Skip obvious heavy/system directories to avoid destructive behavior/infinite loops
        if (entry.isDirectory()) {
          const name = entry.name.toLowerCase();
          if (name === "node_modules" || name === ".git" || name === "windows" || name === "program files" || name === "program files (x86)") {
            continue;
          }
          await this.gatherFiles(fullPath, filesList, scanId);
        } else if (entry.isFile()) {
          filesList.push(fullPath);
          if (filesList.length > 50000) {
            // Cap at 50,000 files to avoid out of memory
            return;
          }
        }
      }
    } catch (e) {
      // Ignore access denied etc
    }
  }

  private async resolvePathsForScan(type: ScanType, targetPath?: string): Promise<string[]> {
    const home = os.homedir();
    if (type === "custom" && targetPath) {
      return [targetPath];
    }

    if (type === "quick") {
      return [
        path.join(home, "Downloads"),
        path.join(home, "Desktop"),
        path.join(home, "Documents"),
        path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
      ];
    }

    if (type === "full") {
      // Instead of whole C:\, we scan the whole user directory and maybe some other accessible places
      // Scanning the whole C:\ can cause permissions errors and take hours.
      return [
        home,
        "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"
      ];
    }

    return [];
  }
}
