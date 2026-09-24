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
  /**
   * Gatekeeper de exclusões do motor. Quando implementado, o ScanManager deixa
   * de enviar ficheiros excluídos aos motores e conta-os como `filesExcluded`
   * (sem os apresentar como "analisados").
   */
  isExcluded?(filePath: string): boolean;
}

/**
 * Scan state as tracked by the worker. `ScanState` (shared-types) is the single
 * canonical contract for the whole pipeline (service → desktop → renderer);
 * this alias just keeps the historical local name.
 */
export type ExtendedScanState = ScanState;

// ── Quick Scan constants ──────────────────────────────────────────────
/** Maximum files a Quick Scan will gather (risk-based budget) */
const QUICK_SCAN_BUDGET = 800;
/** Maximum recursion depth for Quick Scan directory walking */
const QUICK_SCAN_MAX_DEPTH = 2;
/** Maximum age in ms for a file to be considered "recent" (30 days) */
const QUICK_SCAN_RECENT_MS = 30 * 24 * 60 * 60 * 1000;

/** High-risk extensions prioritised by Quick Scan */
const HIGH_RISK_EXTENSIONS = new Set([
  ".exe", ".dll", ".msi", ".scr", ".com", ".ps1", ".bat", ".cmd",
  ".vbs", ".js", ".jar", ".lnk", ".docm", ".xlsm", ".pptm",
  ".zip", ".7z", ".rar", ".iso", ".img", ".wsf", ".wsh",
]);

// Full Scan cap
const FULL_SCAN_MAX_FILES = 50000;

export class ScanManager {
  private activeScans = new Map<string, ExtendedScanState>();
  private currentScanPromise: Promise<void> | null = null;
  private isCancelled = new Set<string>();

  constructor(private engine: ScanEngine) {}

  public getActiveScans(): ExtendedScanState[] {
    return Array.from(this.activeScans.values());
  }

  /**
   * Currently running (or queued) scan, if any.
   * This is the backend source of truth the UI resyncs against after a remount
   * or a page navigation, so a running scan is never lost by the renderer.
   */
  public getActiveScan(): ExtendedScanState | null {
    for (const state of this.activeScans.values()) {
      if (state.status === "running" || state.status === "queued") return state;
    }
    return null;
  }

  public getScan(id: string): ExtendedScanState | undefined {
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

  private updateScan(id: string, updates: Partial<ExtendedScanState>) {
    const current = this.activeScans.get(id);
    if (current) {
      // Revisão monotónica: cada emissão tem uma revisão estritamente maior, para
      // que o renderer possa rejeitar um snapshot/evento atrasado (que faria os
      // contadores recuarem).
      const revision = (updates.revision ?? current.revision ?? 0) + 1;
      const updated: ExtendedScanState = {
        ...current,
        ...updates,
        revision,
        updatedAt: new Date().toISOString(),
      };
      this.activeScans.set(id, updated);
      if (process.env.CYBERSAFE_DEBUG_SCAN === "1") {
        console.log(`[ScanManager] emit id=${id} rev=${revision} status=${updated.status} progress=${updated.progress} files=${updated.filesScanned}/${updated.filesTotal ?? "?"} analyzed=${updated.filesAnalyzed ?? 0} excluded=${updated.filesExcluded ?? 0} failed=${updated.filesFailed ?? 0} phase=${updated.phase} at=${new Date().toISOString()}`);
      }
      this.engine.emitScanProgress(updated);
    }
  }

  public async startScan(type: ScanType, targetPath?: string): Promise<string | null> {
    // ONE ACTIVE SCAN: the backend refuses a second scan instead of queueing it
    // silently, so the UI can never end up with several accidental workers.
    if (this.getActiveScan()) {
      return null;
    }

    const id = randomUUID();
    const state: ExtendedScanState = {
      id,
      type,
      status: "queued",
      progress: 0,
      filesScanned: 0,
      filesAnalyzed: 0,
      filesExcluded: 0,
      filesFailed: 0,
      threatsFound: 0,
      revision: 0,
      startTime: new Date().toISOString(),
      targetPath,
      phase: "preparing",
    };

    this.activeScans.set(id, state);

    // We run the scan async and don't block
    void this.runScanLoop(id, type, targetPath);
    return id;
  }

  private async runScanLoop(id: string, type: ScanType, targetPath?: string) {
    if (this.isCancelled.has(id)) {
      this.isCancelled.delete(id);
      return;
    }

    let resolveScan: () => void;
    this.currentScanPromise = new Promise(r => { resolveScan = r; });

    // Check again after acquiring the promise — race with cancel
    if (this.isCancelled.has(id)) {
      resolveScan!();
      this.currentScanPromise = null;
      return;
    }

    // Files discovered during gathering — mutated in place and read live by the
    // heartbeat below (a filesystem walk can take a long time without producing
    // per-file events, which used to leave the UI blind during "gathering").
    const files: string[] = [];

    // Heartbeat: keep publishing the current state while the scan works, so the
    // UI can distinguish "engine busy" from "engine unreachable" (watchdog).
    const heartbeat = setInterval(() => {
      const state = this.activeScans.get(id);
      if (!state || (state.status !== "running" && state.status !== "queued")) return;
      if (state.phase === "gathering") {
        this.updateScan(id, { filesDiscovered: files.length });
      } else {
        this.engine.emitScanProgress(state);
      }
    }, 1000);

    this.updateScan(id, { status: "running", phase: "preparing" });

    try {
      const maxFiles = type === "quick" ? QUICK_SCAN_BUDGET : FULL_SCAN_MAX_FILES;
      const pathsToScan = await this.resolvePathsForScan(type, targetPath);
      let scanned = 0;
      let analyzed = 0;
      let excluded = 0;
      let threats = 0;
      let filesFailed = 0;

      // 0. Custom scan: reportar o tipo real do alvo (ficheiro ou pasta). Isto é
      // informação do serviço, por isso a UI continua correta mesmo depois de
      // ressincronizar (voltar à página a meio de um scan).
      if (type === "custom" && targetPath) {
        const targetStat = await fs.lstat(targetPath).catch(() => null);
        const targetKind = targetStat?.isFile()
          ? "file"
          : targetStat?.isDirectory()
            ? "directory"
            : undefined;
        // Num ficheiro único, o nome a analisar fica visível desde o início.
        this.updateScan(id, {
          targetKind,
          currentFile: targetKind === "file" ? path.basename(targetPath) : undefined,
        });
      }

      // 1. Gather files
      this.updateScan(id, {
        phase: "gathering",
        filesDiscovered: 0,
        filesScanned: 0,
        filesAnalyzed: 0,
        filesExcluded: 0,
        filesFailed: 0,
        progress: 0,
      });
      for (const p of pathsToScan) {
        if (this.isCancelled.has(id)) break;
        if (type === "quick") {
          await this.gatherFilesQuick(p, files, id, 0, QUICK_SCAN_MAX_DEPTH, maxFiles);
        } else {
          await this.gatherFiles(p, files, id, maxFiles);
        }
        if (files.length >= maxFiles) break;
      }

      // Sort quick scan files: high-risk extensions first, then recent first
      if (type === "quick") {
        files.sort((a, b) => {
          const extA = path.extname(a).toLowerCase();
          const extB = path.extname(b).toLowerCase();
          const riskA = HIGH_RISK_EXTENSIONS.has(extA) ? 0 : 1;
          const riskB = HIGH_RISK_EXTENSIONS.has(extB) ? 0 : 1;
          return riskA - riskB;
        });
      }

      // O total REAL de candidatos fica congelado aqui: é o denominador do
      // progresso. FULL_SCAN_MAX_FILES é um cap de segurança, não um total.
      const totalFiles = files.length;
      if (totalFiles === 0) {
        // Explicit terminal state — a zero-file scan must never stay "running".
        this.updateScan(id, {
          status: "completed",
          phase: "finalizing",
          progress: 100,
          filesDiscovered: 0,
          filesTotal: 0,
          filesScanned: 0,
          endTime: new Date().toISOString(),
        });
        return;
      }

      // Transition to scanning phase
      this.updateScan(id, { phase: "scanning", progress: 0, filesDiscovered: totalFiles, filesTotal: totalFiles });

      // 2. Scan files
      const startTime = Date.now();
      let lastEmit = 0;
      // Profiling DEV agregado (nunca por ficheiro, só com CYBERSAFE_DEBUG_SCAN=1).
      const perfEnabled = process.env.CYBERSAFE_DEBUG_SCAN === "1";
      let engineMs = 0;
      let zipCount = 0;
      for (let i = 0; i < files.length; i++) {
        if (this.isCancelled.has(id)) break;

        const file = files[i];
        try {
          // Política de exclusões: um ficheiro excluído não vai aos motores e
          // conta como excluído (nunca como "analisado sem deteções").
          if (this.engine.isExcluded?.(file)) {
            excluded++;
            scanned++;
          } else {
            // ZIP files: scan outer file + extract with safety protections
            // and scan the entries (bounded), so nested-archive handling is safe.
            const isZip = path.extname(file).toLowerCase() === ".zip" ||
              (await this.looksLikeZip(file));
            if (isZip) {
              zipCount++;
              const zipResult = await this.scanZipWithSafety(id, file, scanned, startTime);
              threats += zipResult.threats;
              scanned += zipResult.scanned;
              analyzed += zipResult.analyzed;
            }

            const fileStart = perfEnabled ? Date.now() : 0;
            const result = await this.engine.scanArtifact(file, "system-scanner");
            if (perfEnabled) engineMs += Date.now() - fileStart;
            analyzed++;
            scanned++;
            if (result && result.highRiskCount > 0) {
              threats++;
            }
          }
        } catch (error) {
          console.error(`[ScanManager] Error scanning ${file}:`, error);
          scanned++;
          filesFailed++;
        }

        // Emit progress every 4 files, at least once per second, or on last file
        if (i % 4 === 0 || i === files.length - 1 || Date.now() - lastEmit >= 1000) {
          lastEmit = Date.now();
          const elapsedSec = (Date.now() - startTime) / 1000;
          const filesPerSecond = elapsedSec > 0 ? Math.round((scanned / elapsedSec) * 10) / 10 : 0;
          // Monotónico: um progresso nunca recua dentro do mesmo scan.
          const currentProgress = this.activeScans.get(id)?.progress ?? 0;
          const nextProgress = Math.min(100, Math.floor((scanned / totalFiles) * 100));
          this.updateScan(id, {
            progress: Math.max(currentProgress, nextProgress),
            filesScanned: scanned,
            filesProcessed: scanned,
            filesAnalyzed: analyzed,
            filesExcluded: excluded,
            threatsFound: threats,
            filesFailed,
            filesPerSecond,
            currentFile: path.basename(file),
          });
        }
      }

      if (perfEnabled) {
        const elapsedMs = Date.now() - startTime;
        const perSec = elapsedMs > 0 ? Math.round((analyzed / (elapsedMs / 1000)) * 10) / 10 : 0;
        console.log(`[ScanPerf] type=${type} files=${analyzed} excluded=${excluded} failed=${filesFailed} zip=${zipCount} elapsed=${Math.round(elapsedMs / 1000)}s engine=${Math.round(engineMs / 1000)}s avg=${analyzed > 0 ? Math.round(engineMs / analyzed) : 0}ms/file filesPerSec=${perSec}`);
      }

      const finalState = this.activeScans.get(id)!;
      if (finalState.status === "running") {
        this.updateScan(id, { phase: "finalizing" });
        this.updateScan(id, {
          status: "completed",
          progress: 100,
          filesScanned: scanned,
          filesProcessed: scanned,
          filesAnalyzed: analyzed,
          filesExcluded: excluded,
          threatsFound: threats,
          filesFailed,
          endTime: new Date().toISOString(),
        });
      }

    } catch (error) {
      console.error(`[ScanManager] Scan ${id} failed:`, error);
      this.updateScan(id, {
        status: "failed",
        phase: "finalizing",
        error: error instanceof Error ? error.message : String(error),
        endTime: new Date().toISOString(),
      });
    } finally {
      clearInterval(heartbeat);
      this.isCancelled.delete(id);
      resolveScan!();
      this.currentScanPromise = null;
    }
  }

  // ── ZIP safety: extraction with zip-slip / bomb / limit protections ──
  private static readonly ZIP_MAX_ENTRIES = 500;
  private static readonly ZIP_MAX_DEPTH = 3;
  private static readonly ZIP_MAX_EXTRACTED_BYTES = 200 * 1024 * 1024; // 200 MB
  private static readonly ZIP_MAX_COMPRESSION_RATIO = 1000;

  /** Detect ZIP by magic bytes with a read of the first 4 bytes. */
  private async looksLikeZip(filePath: string): Promise<boolean> {
    try {
      const fh = await fs.open(filePath, "r");
      const buf = Buffer.alloc(4);
      await fh.read(buf, 0, 4, 0);
      await fh.close();
      return buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
    } catch {
      return false;
    }
  }

  /**
   * Scan a ZIP safely: list entries, enforce limits, extract to a temp dir
   * with zip-slip protection, scan the extracted files, clean up.
   * Returns the number of threats found inside the archive plus how many
   * entries were scanned/analyzed, so the caller can keep counters truthful.
   */
  private async scanZipWithSafety(
    scanId: string,
    zipPath: string,
    baseScanned: number,
    startTime: number
  ): Promise<{ threats: number; scanned: number; analyzed: number }> {
    let threats = 0;
    let zipScanned = 0;
    let zipAnalyzed = 0;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-zip-"));
    try {
      // Import AdmZip lazily (keeps it in the same module graph as core).
      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();

      // Limit entry count
      if (entries.length > ScanManager.ZIP_MAX_ENTRIES) return { threats: 0, scanned: 0, analyzed: 0 };

      // Depth-first bounded walk
      const normalizedPaths = new Set<string>();
      let extractedBytes = 0;

      for (const entry of entries) {
        if (this.isCancelled.has(scanId)) return { threats, scanned: zipScanned, analyzed: zipAnalyzed };
        if (entry.isDirectory) continue;

        const rawEntryName = entry.entryName;
        // Normalize / and \, protect against traversal.
        const safeName = rawEntryName.replace(/\\/g, "/");
        if (safeName.includes("..")) continue; // zip-slip protection
        if (/^[a-zA-Z]:/.test(safeName)) continue; // absolute path protection

        // Depth limit
        const depth = safeName.split("/").length - 1;
        if (depth > ScanManager.ZIP_MAX_DEPTH) continue;

        // Dedup by normalized path
        if (normalizedPaths.has(safeName)) continue;
        normalizedPaths.add(safeName);

        // Extract to temp, bounded by total uncompressed size
        const target = path.join(tmpRoot, safeName);
        if (!target.startsWith(tmpRoot)) continue; // belt-and-suspenders zip-slip
        try {
          entry.getData(); // triggers decompression; we just check size
          const entryData = entry.header
            ? (entry.header.size ?? 0)
            : 0;
          extractedBytes += entryData;
          if (extractedBytes > ScanManager.ZIP_MAX_EXTRACTED_BYTES) return { threats, scanned: zipScanned, analyzed: zipAnalyzed };
        } catch {
          // corrupt entry — skip
          continue;
        }
      }

      // Now actually extract (bounded) and scan each file
      const extractedFolder = path.join(tmpRoot, "x");
      await fs.mkdir(extractedFolder, { recursive: true });

      let unscannedThreats = 0;
      for (const entry of entries) {
        if (this.isCancelled.has(scanId)) return { threats, scanned: zipScanned, analyzed: zipAnalyzed };
        if (entry.isDirectory) continue;
        const rawEntryName = entry.entryName;
        const safeName = rawEntryName.replace(/\\/g, "/");
        if (safeName.includes("..")) continue;
        if (/^[a-zA-Z]:/.test(safeName)) continue;
        const depth = safeName.split("/").length - 1;
        if (depth > ScanManager.ZIP_MAX_DEPTH) continue;

        const target = path.join(extractedFolder, safeName);
        if (!target.startsWith(extractedFolder)) continue;
        try {
          await fs.mkdir(path.dirname(target), { recursive: true });
          const data = entry.getData();
          // Guard extracted size per-file too (compression bomb protection)
          if (data && data.length > (ScanManager.ZIP_MAX_EXTRACTED_BYTES / ScanManager.ZIP_MAX_ENTRIES)) {
            continue;
          }
          await fs.writeFile(target, data);
          zipScanned++;

          const res = await this.engine.scanArtifact(target, "system-scanner");
          zipAnalyzed++;
          if (res && res.highRiskCount > 0) unscannedThreats++;
        } catch {
          // ignore extraction errors
        }
      }
      threats += unscannedThreats;
    } catch {
      // invalid archive — skip (outer file still scanned)
    } finally {
      // Always clean up temp files, even on cancel/error
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
    return { threats, scanned: zipScanned, analyzed: zipAnalyzed };
  }

  // ── Quick Scan gather: depth-limited, extension-prioritised ──────────
  private async gatherFilesQuick(
    dir: string,
    filesList: string[],
    scanId: string,
    depth: number,
    maxDepth: number,
    budget: number,
  ): Promise<void> {
    if (this.isCancelled.has(scanId)) return;
    if (filesList.length >= budget) return;
    if (depth > maxDepth) return;

    try {
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat) return;

      if (stat.isFile()) {
        filesList.push(dir);
        return;
      }

      if (!stat.isDirectory()) return;

      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      // Sort: directories first (for breadth-first feel), then files
      entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return 0;
      });

      for (const entry of entries) {
        if (this.isCancelled.has(scanId)) return;
        if (filesList.length >= budget) return;

        const fullPath = path.join(dir, entry.name);
        const name = entry.name.toLowerCase();

        // Skip junk and symlinks
        if (name === "node_modules" || name === ".git" || name === ".venv" || name === "__pycache__") continue;
        if (entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          if (name === "windows" || name === "program files" || name === "program files (x86)") continue;
          await this.gatherFilesQuick(fullPath, filesList, scanId, depth + 1, maxDepth, budget);
        } else if (entry.isFile()) {
          // For Quick Scan: only add files with supported extensions or recent files
          const ext = path.extname(name).toLowerCase();
          const isHighRisk = HIGH_RISK_EXTENSIONS.has(ext);
          let isRecent = false;
          try {
            const stat = await fs.stat(fullPath);
            isRecent = (Date.now() - stat.mtimeMs) < QUICK_SCAN_RECENT_MS;
          } catch { /* ignore stat errors */ }

          // Include if: high-risk extension OR recent file
          if (isHighRisk || isRecent) {
            filesList.push(fullPath);
          }
        }
      }
    } catch {
      // Ignore access denied etc
    }
  }

  // ── Full Scan gather: recursive, uncapped depth ──────────────────────
  private async gatherFiles(dir: string, filesList: string[], scanId: string, maxFiles: number) {
    if (this.isCancelled.has(scanId)) return;
    if (filesList.length >= maxFiles) return;

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
        if (filesList.length >= maxFiles) return;

        const fullPath = path.join(dir, entry.name);
        const name = entry.name.toLowerCase();

        if (name === "node_modules" || name === ".git") continue;
        if (entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          if (name === "windows" || name === "program files" || name === "program files (x86)") continue;
          await this.gatherFiles(fullPath, filesList, scanId, maxFiles);
        } else if (entry.isFile()) {
          filesList.push(fullPath);
        }
      }
    } catch {
      // Ignore access denied etc
    }
  }

  private async resolvePathsForScan(type: ScanType, targetPath?: string): Promise<string[]> {
    const home = os.homedir();
    if (type === "custom" && targetPath) {
      return [targetPath];
    }

    const existingDirs = async (...parts: string[]): Promise<string | null> => {
      const full = path.join(...parts);
      try {
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink()) return null;
        const isDir = await fs.stat(full).then((s) => s.isDirectory()).catch(() => false);
        return isDir ? full : null;
      } catch {
        return null;
      }
    };

    if (type === "quick") {
      const candidates = await Promise.all([
        existingDirs(home, "Downloads"),
        existingDirs(home, "Desktop"),
        existingDirs(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
        existingDirs(home, "Documents"),
        existingDirs(os.tmpdir()),
      ]);
      return candidates.filter((p): p is string => p !== null);
    }

    if (type === "full") {
      return [
        home,
        "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"
      ];
    }

    return [];
  }
}
