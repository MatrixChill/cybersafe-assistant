import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  VirusTotalClient,
  HardwareHealthEngine,
  DEFAULT_SETTINGS,
  PIPE_NAME,
  SecurityEventBus,
  SignatureDatabase,
  TrustEngine,
  YaraEngine,
  MalwareAnalyzer,
  QuarantineManager,
  decodeMessages,
  encodeMessage,
  killProcessTree,
  scoreToStatus,
  ExclusionManager,
} from "@cybersafe/core";
import {
  NativeWindowsWatcher,
  ProcessMonitor,
  snapshotConnections,
  terminateProcessTree,
  type FileObservation,
} from "@cybersafe/native-windows";
import type {
  AnalysisResult,
  ConnectionSnapshot,
  EngineHealth,
  ProcessSnapshot,
  ProtectionState,
  ProtectionStats,
  QuarantineEntry,
  SecurityEvent,
  ServiceCommandMap,
  ServiceResponseMap,
  ThreatEvent,
} from "@cybersafe/shared-types";

interface RpcRequest<K extends keyof ServiceCommandMap = keyof ServiceCommandMap> {
  id: string;
  type: "request";
  method: K;
  payload: ServiceCommandMap[K];
}

interface RpcResponse<K extends keyof ServiceResponseMap = keyof ServiceResponseMap> {
  id: string;
  type: "response";
  ok: boolean;
  result?: ServiceResponseMap[K];
  error?: string;
}

export class ProtectionEngineService {
  private readonly baseDir = path.join(os.homedir(), ".cybersafe-service");
  private readonly definitionsDir = path.join(process.cwd(), "definitions");
  private readonly logsDir = path.join(process.cwd(), "logs");
  private readonly eventBus = new SecurityEventBus({ replayLimit: 500 });
  private readonly signatures = new SignatureDatabase();
  private readonly trust = new TrustEngine();
  private readonly yara = new YaraEngine();
  private readonly analyzer = new MalwareAnalyzer({
    signatures: this.signatures,
    trust: this.trust,
    yara: this.yara,
  });
  private readonly quarantine = new QuarantineManager(this.baseDir);
  private readonly watcher = new NativeWindowsWatcher();
  private readonly processMonitor = new ProcessMonitor();
  private readonly clients = new Set<net.Socket>();
  private readonly vt = new VirusTotalClient(process.env.VIRUSTOTAL_API_KEY);
  private readonly hardware = new HardwareHealthEngine();
  private readonly exclusions = new ExclusionManager();

  private server: net.Server | null = null;
  private events: SecurityEvent[] = [];
  private threats: ThreatEvent[] = [];
  private processes: ProcessSnapshot[] = [];
  private connections: ConnectionSnapshot[] = [];
  private blockedHashes = new Set<string>();
  private blockedPaths = new Set<string>();
  private definitionsUpdatedAt = "";
  private networkTimer: NodeJS.Timeout | null = null;

  async init() {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.mkdir(this.logsDir, { recursive: true });
    await this.quarantine.init();
    await this.signatures.load(path.join(this.definitionsDir, "hashes", "default.json"));
    await this.yara.load(path.join(this.definitionsDir, "yara", "default.json"));
    this.definitionsUpdatedAt = new Date().toISOString();

    this.bindEventBus();
    this.bindWatchers();
    await this.watcher.start();
    await this.processMonitor.start();
    this.processes = await this.processMonitor.list();
    await this.refreshConnections();
    
    // Initial hardware snapshot
    await this.hardware.getSnapshot();

    this.networkTimer = setInterval(() => {
      void this.refreshConnections();
      void this.hardware.getSnapshot().then((snapshot) => {
        if (snapshot.stressAlerts.length > 0) {
          // You could fire events here for high stress, but for now we just keep the snapshot updated
        }
      });
    }, 3_000); // 3 seconds poll for hardware & network
  }

  private bindEventBus() {
    this.eventBus.on("event", (event: SecurityEvent) => {
      this.events.push(event);
      if (this.events.length > 500) this.events.shift();
      void fs.appendFile(
        path.join(this.logsDir, "security-events.log"),
        `${JSON.stringify(event)}\n`,
        "utf-8",
      );
      this.broadcast({ type: "event", event });
    });
  }

  /** Well-known safe Windows processes that should never trigger alerts */
  private static readonly SAFE_PROCESSES = new Set([
    "powershell.exe",
    "pwsh.exe",
    "cmd.exe",
    "conhost.exe",
    "explorer.exe",
    "svchost.exe",
    "csrss.exe",
    "lsass.exe",
    "services.exe",
    "smss.exe",
    "wininit.exe",
    "winlogon.exe",
    "dwm.exe",
    "taskhostw.exe",
    "sihost.exe",
    "fontdrvhost.exe",
    "runtimebroker.exe",
    "searchhost.exe",
    "startmenuexperiencehost.exe",
    "textinputhost.exe",
    "ctfmon.exe",
    "dllhost.exe",
    "msiexec.exe",
    "audiodg.exe",
    "spoolsv.exe",
    "searchindexer.exe",
    "securityhealthservice.exe",
    "msedge.exe",
    "chrome.exe",
    "firefox.exe",
    "code.exe",
    "node.exe",
    "tsx.exe",
    "electron.exe",
    "vite.exe",
    "npm.cmd",
    "npx.cmd",
    "git.exe",
    "wt.exe",
    "windowsterminal.exe",
    "systemsettings.exe",
    "taskmgr.exe",
    "devenv.exe",
    "msbuild.exe",
  ]);

  private isSafeProcess(name: string): boolean {
    return ProtectionEngineService.SAFE_PROCESSES.has(name.toLowerCase());
  }

  private bindWatchers() {
    this.watcher.on("file.created", (event: FileObservation) => {
      this.eventBus.publish("file.created", "low", `New file observed: ${event.path}`, event);
      void this.scanArtifact(event.path, "service");
    });
    this.watcher.on("file.modified", (event: FileObservation) => {
      this.eventBus.publish("file.modified", "low", `Modified file observed: ${event.path}`, event);
    });
    this.watcher.on("registry.persistence.changed", (event: any) => {
      this.eventBus.publish("persistence.detected", "high", "Registry persistence changed", event);
    });

    this.processMonitor.on("process.started", (processInfo: ProcessSnapshot) => {
      this.processes = [processInfo, ...this.processes.filter((entry) => entry.pid !== processInfo.pid)].slice(0, 200);
      // Don't log or scan safe processes
      if (!this.isSafeProcess(processInfo.name)) {
        this.eventBus.publish("process.started", "low", `Process started: ${processInfo.name}`, processInfo);
        void this.handleProcessStart(processInfo);
      }
    });
    this.processMonitor.on("process.exited", (processInfo: ProcessSnapshot) => {
      this.processes = this.processes.filter((entry) => entry.pid !== processInfo.pid);
    });
  }

  private async handleProcessStart(processInfo: ProcessSnapshot) {
    // Double-check safe list
    if (this.isSafeProcess(processInfo.name)) return;

    // 1. Behavioral Check (Command Line)
    const suspiciousPatterns = [
      /powershell.*-nop.*-ep.*bypass/i,
      /powershell.*-encodedcommand/i,
      /cmd\.exe.*\/c.*del/i,
      /wscript\.exe.*vbscript:/i,
      /mshta\.exe.*http/i,
    ];

    if (processInfo.commandLine && suspiciousPatterns.some(pattern => pattern.test(processInfo.commandLine))) {
      await terminateProcessTree(processInfo.pid);
      this.eventBus.publish("process.blocked", "critical", `Suspicious behavior blocked: ${processInfo.name}`, {
        ...processInfo,
        reason: "Suspicious command line pattern detected"
      });
      return;
    }

    // 2. Path Check
    const lowerPath = processInfo.path.toLowerCase();
    if (this.blockedPaths.has(lowerPath)) {
      await terminateProcessTree(processInfo.pid);
      this.eventBus.publish("process.blocked", "critical", `Blocked process by path: ${processInfo.name}`, processInfo);
      return;
    }

    // 3. Signature Check (Hash/YARA)
    if (processInfo.path) {
      const analysis = await this.scanArtifact(processInfo.path, "service");
      if (analysis?.results[0]?.sha256 && this.blockedHashes.has(analysis.results[0].sha256)) {
        await terminateProcessTree(processInfo.pid);
        this.eventBus.publish("process.killed", "critical", `Killed blocked process (Malware signature): ${processInfo.name}`, processInfo);
      }
    }
  }

  private async refreshConnections() {
    this.connections = await snapshotConnections();
  }

  async dispose() {
    await this.watcher.stop();
    await this.processMonitor.stop();
    if (this.networkTimer) clearInterval(this.networkTimer);
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  getProtectionState(): ProtectionState {
    const recentThreats = this.threats.slice(0, 10);
    const maxRisk = recentThreats.length > 0 
      ? Math.max(...recentThreats.map(t => t.riskScore))
      : 0;

    const stats: ProtectionStats = {
      riskScore: maxRisk,
      totalEvents: this.threats.length,
      highSeverityEvents: this.threats.filter((event) => event.severity === "high" || event.severity === "critical").length,
      blockedExecutions: this.events.filter((event) => event.type === "process.blocked" || event.type === "process.killed").length,
      quarantinedCount: this.quarantine.list().length,
      monitoredProcesses: this.processes.length,
    };
    const engine: EngineHealth = {
      serviceRunning: true,
      osLayerHealthy: true,
      degradedReasons: [],
      monitoredPaths: this.watcher.getDefaultPaths(),
      definitionsUpdatedAt: this.definitionsUpdatedAt,
      lastEventAt: this.events.at(-1)?.timestamp,
    };

    return {
      status: scoreToStatus(stats.riskScore, false),
      stats,
      engine,
    };
  }

  async scanArtifact(filePath: string, source: ThreatEvent["source"]): Promise<ServiceResponseMap["scan.artifact"]> {
    try {
      // Gatekeeper: Check exclusions first
      if (this.exclusions.isExcluded(filePath)) {
        console.log(`[Service] Skipping scan for excluded path: ${filePath}`);
        return {
          results: [{
            fileName: path.basename(filePath),
            size: 0,
            severity: "low",
            confidence: 1,
            rulesTriggered: [],
            riskScore: 0,
            verdict: "safe",
            sha256: "",
          }],
          totalFiles: 1,
          highRiskCount: 0,
          overallSeverity: "low",
          rulesTriggered: [],
          riskScore: 0,
        };
      }

      const analysis = await this.analyzer.analyze(filePath);
      
      // Consult VT if enabled
      let vtResult = null;
      let finalRiskScore = analysis.riskScore;
      let finalSeverity = analysis.severity;
      
      if (this.vt.isEnabled() && analysis.sha256) {
        vtResult = await this.vt.scanHash(analysis.sha256);
        if (vtResult && vtResult.positives > 0) {
          // If VT detects it, boost the risk score
          const vtBoost = Math.min(40, vtResult.positives * 5); 
          finalRiskScore = Math.min(100, finalRiskScore + vtBoost);
          
          if (finalRiskScore > DEFAULT_SETTINGS.thresholds.alertMax) finalSeverity = "critical";
          else if (finalRiskScore > DEFAULT_SETTINGS.thresholds.monitorMax) finalSeverity = "high";
        }
      }

      this.eventBus.publish("artifact.analyzed", finalSeverity, `Analyzed ${analysis.fileName}`, { ...analysis, vtResult });

      const threat: ThreatEvent = {
        source,
        url: `file://${filePath}`,
        domain: path.basename(filePath),
        severity: finalSeverity,
        confidence: analysis.confidence,
        rulesTriggered: analysis.rulesTriggered,
        createdAt: analysis.scanTimestamp,
        riskScore: finalRiskScore,
        action: analysis.recommendedAction,
        filePath,
        summary: analysis.factors.map((factor) => factor.label).join(", ") + (vtResult && vtResult.positives > 0 ? ` (+${vtResult.positives} VT detections)` : ""),
      };
      
      if (finalSeverity === "high" || finalSeverity === "critical") {
        this.threats = [threat, ...this.threats].slice(0, 500);
      }

      if (analysis.recommendedAction === "quarantined" || finalSeverity === "critical") {
        this.blockedHashes.add(analysis.sha256);
        this.blockedPaths.add(filePath.toLowerCase());
        const quarantineEntry = await this.quarantine.quarantine({ ...analysis, riskScore: finalRiskScore });
        this.eventBus.publish("quarantine.added", "critical", `Quarantined ${analysis.fileName}`, quarantineEntry ?? analysis);
      }

      if (finalSeverity !== "low") {
         this.eventBus.publish("threat.detected", finalSeverity, `Threat detected in ${analysis.fileName}`, threat);
      }

      // Log VT result to Action log
      if (vtResult) {
         void fs.appendFile(path.join(this.logsDir, "actions.log"), `[ANALYSIS] ${filePath} | VT: ${vtResult.detectionRatio} | Score: ${finalRiskScore}\n`, "utf-8").catch(() => {});
      }

      return {
        results: [{
          fileName: analysis.fileName,
          size: analysis.size,
          severity: finalSeverity,
          confidence: analysis.confidence,
          rulesTriggered: analysis.rulesTriggered,
          riskScore: finalRiskScore,
          verdict: analysis.verdict,
          sha256: analysis.sha256,
        }],
        totalFiles: 1,
        highRiskCount: finalRiskScore > DEFAULT_SETTINGS.thresholds.monitorMax ? 1 : 0,
        overallSeverity: finalSeverity,
        rulesTriggered: analysis.rulesTriggered,
        riskScore: finalRiskScore,
      };
    } catch (err) {
      console.error("Scan error:", err);
      return null;
    }
  }

  async analyzeProcess(pid: number): Promise<ServiceResponseMap["process.analyze"] | null> {
    const processInfo = this.processes.find(p => p.pid === pid);
    if (!processInfo) return null;

    void fs.appendFile(path.join(this.logsDir, "actions.log"), `[INVESTIGATE] PID=${pid} | Name=${processInfo.name}\n`, "utf-8").catch(() => {});

    let fileScan = null;
    let virusTotal = null;

    if (processInfo.path) {
       fileScan = await this.scanArtifact(processInfo.path, "service");
       if (fileScan?.results[0]?.sha256 && this.vt.isEnabled()) {
          virusTotal = await this.vt.scanHash(fileScan.results[0].sha256);
       }
    }

    const isCritical = pid <= 100 || ["svchost.exe", "explorer.exe", "csrss.exe", "lsass.exe", "wininit.exe"].includes(processInfo.name.toLowerCase());
    
    let recommendation: "safe" | "suspicious" | "dangerous" = "safe";
    if (fileScan && fileScan.overallSeverity === "critical") recommendation = "dangerous";
    else if (fileScan && fileScan.overallSeverity === "high") recommendation = "suspicious";
    else if (virusTotal && virusTotal.positives > 2) recommendation = "dangerous";
    else if (virusTotal && virusTotal.positives > 0) recommendation = "suspicious";
    else if (processInfo.cpu > 80 && !isCritical) recommendation = "suspicious";

    return {
      process: processInfo,
      fileScan,
      virusTotal,
      isCritical,
      recommendation,
    };
  }

  async runRestrictedAnalysis(filePath: string) {
    return this.analyzer.analyze(filePath);
  }

  async allowHash(sha256: string) {
    this.trust.allowHash(sha256);
    this.blockedHashes.delete(sha256.toLowerCase());
    this.eventBus.publish("trust.updated", "low", `Allowed hash ${sha256}`, { sha256 });
    return { success: true };
  }

  async allowPublisher(publisher: string) {
    this.trust.allowPublisher(publisher);
    this.eventBus.publish("trust.updated", "low", `Allowed publisher ${publisher}`, { publisher });
    return { success: true };
  }

  async restoreQuarantine(id: string, trustAfterRestore = false) {
    const entry = this.quarantine.list().find((item) => item.id === id);
    const success = await this.quarantine.restore(id, "desktop-ui");
    if (success && trustAfterRestore && entry?.sha256) {
      await this.allowHash(entry.sha256);
    }
    if (success) {
      this.eventBus.publish("quarantine.restored", "low", `Restored quarantine entry ${id}`, { id });
    }
    return { success };
  }

  async deleteQuarantine(id: string) {
    const success = await this.quarantine.delete(id);
    return { success };
  }

  async updateDefinitions() {
    try {
      // Importar o updater e forçar download agora
      const { DefinitionUpdater } = await import("./updater.js");
      const updater = new DefinitionUpdater(this.definitionsDir);
      const result = await updater.checkAndUpdate(true);

      // Hot-reload: recarrega as definições em memória sem reiniciar o serviço
      await this.signatures.load(path.join(this.definitionsDir, "hashes", "default.json"));
      await this.yara.load(path.join(this.definitionsDir, "yara", "default.json"));

      this.definitionsUpdatedAt = new Date().toISOString();
      this.eventBus.publish("engine.health", "low", `Definitions updated (YARA: ${result.yaraUpdated}, ClamAV: ${result.clamUpdated}, Hashes: ${result.hashesUpdated})`, {
        updatedAt: this.definitionsUpdatedAt,
        ...result,
      });
      return { success: true, updatedAt: this.definitionsUpdatedAt };
    } catch (err: any) {
      console.error("[Engine] Falha ao atualizar definições:", err);
      return { success: false, updatedAt: this.definitionsUpdatedAt };
    }
  }

  async killProcess(pid: number) {
    const processInfo = this.processes.find(p => p.pid === pid);
    
    // Protect critical system processes
    const isCritical = pid <= 100 || (processInfo && ["svchost.exe", "explorer.exe", "csrss.exe", "lsass.exe", "wininit.exe"].includes(processInfo.name.toLowerCase()));
    
    if (isCritical) {
       console.warn(`[Service] Blocked attempt to kill critical process PID: ${pid}`);
       return { success: false, error: "Cannot terminate critical system process" };
    }

    void fs.appendFile(path.join(this.logsDir, "actions.log"), `[KILL] PID=${pid} | Name=${processInfo?.name || "unknown"}\n`, "utf-8").catch(() => {});

    const success = await killProcessTree(pid);
    if (success) {
      this.eventBus.publish("process.killed", "critical", `Killed process tree ${pid}`, { pid });
    }
    return { success };
  }

  async clearEvents() {
    this.events = [];
    this.threats = [];
    return { success: true };
  }

  private broadcast(message: unknown) {
    const payload = encodeMessage(message);
    for (const client of this.clients) {
      client.write(payload);
    }
  }

  async startPipeServer() {
    this.server = net.createServer((socket) => {
      this.clients.add(socket);
      let buffer = "";

      socket.on("data", async (chunk) => {
        buffer += chunk.toString();
        const decoded = decodeMessages(buffer);
        buffer = decoded.rest;
        for (const message of decoded.messages) {
          const request = message as RpcRequest;
          if (request.type !== "request") continue;
          const response = await this.handleRequest(request);
          socket.write(encodeMessage(response));
        }
      });

      socket.on("close", () => {
        this.clients.delete(socket);
      });

      const lastEvent = this.eventBus.getReplay().at(-1);
      if (lastEvent) {
        socket.write(encodeMessage({ type: "event", event: lastEvent }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(PIPE_NAME, () => resolve());
    });
  }

  private async handleRequest(request: RpcRequest): Promise<RpcResponse<any>> {
    try {
      const result = await this.dispatch(request.method, request.payload);
      return {
        id: request.id,
        type: "response",
        ok: true,
        result,
      };
    } catch (error: any) {
      return {
        id: request.id,
        type: "response",
        ok: false,
        error: error?.message ?? "Unknown service error",
      };
    }
  }

  private async dispatch(
    method: keyof ServiceCommandMap,
    payload: ServiceCommandMap[keyof ServiceCommandMap],
  ): Promise<any> {
    switch (method) {
      case "protection.getState":
        return this.getProtectionState();
      case "events.list":
        return this.eventBus.getReplay(
          (payload as { cursor?: number; limit?: number } | undefined)?.cursor,
          (payload as { cursor?: number; limit?: number } | undefined)?.limit ?? 100,
        );
      case "threats.list":
        return this.threats;
      case "processes.list":
        return this.processes;
      case "connections.list":
        return this.connections;
      case "quarantine.list":
        return this.quarantine.list();
      case "events.clear":
        return this.clearEvents();
      case "scan.artifact":
        return this.scanArtifact((payload as { path: string }).path, "dashboard");
      case "monitor.start":
        return { success: true };
      case "monitor.stop":
        return { success: true };
      case "process.killTree":
        return this.killProcess((payload as { pid: number }).pid);
      case "quarantine.restore":
        return this.restoreQuarantine(
          (payload as { id: string; trustAfterRestore?: boolean }).id,
          (payload as { id: string; trustAfterRestore?: boolean }).trustAfterRestore,
        );
      case "quarantine.delete":
        return this.deleteQuarantine((payload as { id: string }).id);
      case "trust.allowHash":
        return this.allowHash((payload as { sha256: string }).sha256);
      case "trust.allowPublisher":
        return this.allowPublisher((payload as { publisher: string }).publisher);
      case "definitions.update":
        return this.updateDefinitions();
      case "analysis.restricted":
        return this.runRestrictedAnalysis((payload as { path: string }).path);
      case "hardware.snapshot":
        return this.hardware.getLastSnapshot() || await this.hardware.getSnapshot();
      case "process.analyze":
        return this.analyzeProcess((payload as { pid: number }).pid);
      case "exclusions.get":
        return this.exclusions.getConfig();
      case "exclusions.update":
        return this.exclusions.updateConfig(payload as any);
      default:
        throw new Error(`Unsupported method: ${String(method)}`);
    }
  }
}
