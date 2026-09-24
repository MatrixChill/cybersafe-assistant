import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VirusTotalClient,
  HardwareHealthEngine,
  ClamavBridge,
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
  classifyKillTarget,
  isProcessAlive,
  killProcessTree,
  killTargetIdentity,
  normalizeProcessPath,
  reconcileProcessExit,
  scoreToStatus,
  ExclusionManager,
  engineIsDegraded,
  effectiveRiskScore,
  PcStateEngine,
  disposeTempHelper,
} from "@cybersafe/core";
import { NativeWindowsWatcher,
  ProcessMonitor,
  snapshotConnections,
  terminateProcessTree,
  WindowsHealthEngine,
  type FileObservation,
  EtwConsumer,
  WfpFilter,
  AmsiProvider
} from "@cybersafe/native-windows";
import { NativeEngineBridge } from "./native-engine-bridge.js";
import { isTransientFsError, TRANSIENT_SCAN_ERROR_WINDOW_MS } from "./scan-error.js";
import { DefinitionUpdater } from "./updater.js";
import { ScanManager } from "./scan-manager.js";
import type {
  AnalysisResult,
  ConnectionSnapshot,
  EngineHealth,
  PcState,
  ProcessKillResult,
  ProcessSnapshot,
  ProtectionState,
  ProtectionStats,
  QuarantineEntry,
  SecurityEvent,
  ServiceCommandMap,
  ServiceResponseMap,
  ThreatEvent,
} from "@cybersafe/shared-types";
import { hasDegradedProtections } from "@cybersafe/shared-types";
import type { KillProtectionContext } from "@cybersafe/core";

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

/**
 * Métodos que criam trabalho novo (scans, updates, ligar proteção).
 * Durante o shutdown são recusados — a desmontagem já começou e nenhum
error aqui deve prolongar o encerramento.
 */
const SHUTDOWN_BLOCKED_METHODS = new Set<string>([
  "scan.start",
  "scan.fullSystem",
  "definitions.update",
  "monitor.start",
]);

/** Códigos de erro de socket esperados quando o peer fecha o pipe primeiro. */
const EXPECTED_SOCKET_ERROR_CODES = new Set<string>([
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);

export class ProtectionEngineService {
  private readonly baseDir = path.join(os.homedir(), ".cybersafe-service");
  private readonly definitionsDir = path.join(this.baseDir, "definitions");
  private readonly logsDir = path.join(this.baseDir, "logs");
  private readonly eventBus = new SecurityEventBus({ replayLimit: 500 });
  private readonly signatures = new SignatureDatabase();
  private readonly trust = new TrustEngine();
  private readonly yara = new YaraEngine();
  private readonly clamav = new ClamavBridge();
  private readonly analyzer = new MalwareAnalyzer({
    signatures: this.signatures,
    trust: this.trust,
    yara: this.yara,
    clamav: this.clamav,
  });
  private readonly quarantine = new QuarantineManager(this.baseDir);
  private readonly watcher = new NativeWindowsWatcher();
  private readonly processMonitor = new ProcessMonitor();
  private readonly etwConsumer = new EtwConsumer();
  private readonly wfpFilter = new WfpFilter();
  private readonly amsiProvider = new AmsiProvider();
  private readonly clients = new Set<net.Socket>();
  private readonly vt = new VirusTotalClient(process.env.VIRUSTOTAL_API_KEY);
  private readonly hardware = new HardwareHealthEngine();
  private readonly windowsHealth = new WindowsHealthEngine();
  private readonly exclusions = new ExclusionManager();
  private readonly pcState = new PcStateEngine();
  private readonly scanManager = new ScanManager(this);
  private readonly historyPath = path.join(this.baseDir, "history.jsonl");
  private readonly updater = new DefinitionUpdater(this.definitionsDir);

  private server: net.Server | null = null;
  private events: SecurityEvent[] = [];
  private threats: ThreatEvent[] = [];
  private processes: ProcessSnapshot[] = [];
  private connections: ConnectionSnapshot[] = [];
  private blockedHashes = new Set<string>();
  private blockedPaths = new Set<string>();
  private definitionsUpdatedAt = "";
  private networkTimer: NodeJS.Timeout | null = null;
  private networkInFlight = false;
  private readonly recentScans = new Map<string, number>();
  /** Rate-limit para erros de scan transitórios (evita spam de stack traces). */
  private readonly transientScanLogAt = new Map<string, number>();
  private protectionState = false;
  private protectionTransition: Promise<{ ok: boolean; protectionEnabled: boolean }> | null = null;
  /** Estado explícito de encerramento: para o trabalho novo e o broadcast. */
  private isShuttingDown = false;
  /** Garante que dispose()/shutdown() não correm a desmontagem duas vezes. */
  private disposed = false;

  async init() {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.mkdir(this.logsDir, { recursive: true });
    await this.seedDefinitions();
    await this.quarantine.init();
    await this.signatures.load(path.join(this.definitionsDir, "hashes", "default.json"));
    // Se o package não trouxe hashes embutidos, garante um ficheiro com a base offline
    await this.signatures.ensureFile(path.join(this.definitionsDir, "hashes", "default.json"));
    await this.yara.load(path.join(this.definitionsDir, "yara", "default.yar"));
    this.definitionsUpdatedAt = new Date().toISOString();

    this.bindEventBus();
    this.bindWatchers();
    this.protectionState = false;
  }

  /**
   * Localização das definições empacotadas com a app: junto ao próprio módulo
   * do serviço (packages/service/definitions em dev, node_modules/@cybersafe/
   * service/definitions dentro do asar em produção). Independente de process.cwd().
   */
  private get bundledDefinitionsDir(): string {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    return path.join(moduleDir, "..", "definitions");
  }

  /**
   * Copia as definições empacotadas para o diretório de dados do utilizador
   * (writable) apenas quando em falta, para que os motores nativos (YARA-X)
   * consigam ler as regras — ficheiros dentro do asar não são "visíveis"
   * para módulos nativos. Nunca sobrepõe definições já atualizadas.
   */
  private async seedDefinitions(): Promise<void> {
    try {
      const bundled = this.bundledDefinitionsDir;
      const subDirs = ["yara", "hashes", "clamav"] as const;
      for (const sub of subDirs) {
        const srcDir = path.join(bundled, sub);
        const dstDir = path.join(this.definitionsDir, sub);
        let entries: string[] = [];
        try {
          entries = await fs.readdir(srcDir);
        } catch {
          continue;
        }
        await fs.mkdir(dstDir, { recursive: true });
        for (const entry of entries) {
          const src = path.join(srcDir, entry);
          const dst = path.join(dstDir, entry);
          try {
            const stat = await fs.stat(src);
            if (!stat.isFile()) continue;
          } catch {
            continue;
          }
          let exists = false;
          try {
            await fs.access(dst);
            exists = true;
          } catch {
            exists = false;
          }
          if (!exists) await fs.copyFile(src, dst);
        }
      }
      console.log("[Service] Definições asseguradas em", this.definitionsDir);
    } catch (error) {
      console.warn("[Service] Falha ao garantir definições locais:", error);
    }
  }

  async startProtection(): Promise<{ ok: boolean; protectionEnabled: boolean }> {
    if (this.protectionState) {
      return { ok: true, protectionEnabled: true };
    }

    if (this.protectionTransition) {
      return await this.protectionTransition;
    }

    this.protectionTransition = (async () => {
      let started = true;

      for (const [label, action] of [
        ["watcher", () => this.watcher.start()],
        ["processMonitor", () => this.processMonitor.start()],
        ["etwConsumer", () => this.etwConsumer.start()],
        ["wfpFilter", () => this.wfpFilter.start()],
        ["amsiProvider", () => this.amsiProvider.start()],
      ] as const) {
        try {
          await action();
        } catch (error) {
          started = false;
          console.error(`[Service] Failed to start ${label}:`, error);
        }
      }

      if (!started) {
        await this.stopProtection().catch(() => undefined);
        return { ok: false, protectionEnabled: false };
      }

      this.protectionState = true;
      this.updater.startScheduler();

      Promise.all([
        this.processMonitor.list().then((p) => {
          this.processes = p;
          return this.hardware.getSnapshot(this.processes);
        }),
        this.refreshConnections(),
      ]).catch((err) => console.error("[Service] Initial background snapshots failed:", err));

      if (!this.networkTimer) {
        this.networkTimer = setInterval(() => {
          if (this.networkInFlight) return;
          this.networkInFlight = true;
          Promise.allSettled([
            this.refreshConnections(),
            this.hardware.getSnapshot(this.processes),
          ]).finally(() => {
            this.networkInFlight = false;
          });
        }, 10_000);
      }

      return { ok: true, protectionEnabled: true };
    })();

    try {
      const result = await this.protectionTransition;
      return result;
    } finally {
      this.protectionTransition = null;
    }
  }

  async stopProtection(): Promise<{ ok: boolean; protectionEnabled: boolean }> {
    if (!this.protectionState && !this.networkTimer && !this.protectionTransition) {
      return { ok: true, protectionEnabled: false };
    }

    if (this.protectionTransition) {
      await this.protectionTransition.catch(() => undefined);
    }

    this.protectionState = false;
    this.updater.stopScheduler();

    if (this.networkTimer) {
      clearInterval(this.networkTimer);
      this.networkTimer = null;
    }

    await Promise.allSettled([
      this.watcher.stop(),
      this.processMonitor.stop(),
      this.etwConsumer.stop(),
      this.wfpFilter.stop(),
      this.amsiProvider.stop(),
    ]);

    return { ok: true, protectionEnabled: false };
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

  /**
   * Processos de sistema que nunca podem ser terminados pelo Gestor de Tarefas.
   * Usados **apenas como fallback**, quando não há PID/ppid/path fiáveis.
   */
  private static readonly CRITICAL_PROCESS_NAMES = [
    "system",
    "registry",
    "memory compression",
    "idle",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "svchost.exe",
    "explorer.exe",
    "dwm.exe",
  ];

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
      if (this.exclusions.isExcluded(event.path)) return;
      this.eventBus.publish("file.created", "low", `New file observed: ${event.path}`, event);
      void this.handleFileObservation(event.path);
    });
    this.watcher.on("file.modified", (event: FileObservation) => {
      if (this.exclusions.isExcluded(event.path)) return;
      this.eventBus.publish("file.modified", "low", `Modified file observed: ${event.path}`, event);
      void this.handleFileObservation(event.path);
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
      this.handleNaturalProcessExit(processInfo);
    });

    this.amsiProvider.on("script.blocked", (info: any) => {
      this.eventBus.publish("process.blocked", "high", `Blocked malicious script execution (${info.appName})`, info);
    });
  }

  /**
   * Saída natural detetada pelo ProcessMonitor. Publica `process.exited` só se
   * o PID ainda estava no cache: um kill reconciliado já filtrou a lista e
   * publicou `process.killed`/`process.exited`, portanto não há duplicado.
   */
  private handleNaturalProcessExit(processInfo: ProcessSnapshot) {
    const wasCached = this.processes.some((entry) => entry.pid === processInfo.pid);
    this.processes = this.processes.filter((entry) => entry.pid !== processInfo.pid);
    if (wasCached && !this.isShuttingDown) {
      this.eventBus.publish("process.exited", "low", `Process exited: ${processInfo.name}`, processInfo);
    }
  }

  private async handleFileObservation(filePath: string) {
    // Guarda ANTES de qualquer tentativa de leitura: no Windows o watcher pode
    // reportar junctions/reparse points e diretórios como entradas de ficheiro
    // (Documents\Meus Vídeos, Minhas Imagens, Minhas Músicas). Abri-los produz
    // EPERM/EISDIR — não é um erro do motor, é um alvo que não é ficheiro.
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isDirectory() || stat.isSymbolicLink()) return;
    } catch {
      // Desapareceu entre o evento e o stat — nada a analisar.
      return;
    }

    const now = Date.now();
    const lastScan = this.recentScans.get(filePath);

    // Evita analisar o mesmo ficheiro em menos de 10 segundos
    if (lastScan && now - lastScan < 10000) {
      return;
    }
    this.recentScans.set(filePath, now);

    // Limpar cache antiga para evitar memory leak (limpa a cada 50 scans, apenas entradas velhas)
    if (this.recentScans.size > 1000) {
      for (const [key, timestamp] of this.recentScans.entries()) {
        if (now - timestamp > 60000) {
          this.recentScans.delete(key);
        }
      }
    }

    void this.scanArtifact(filePath, "service");
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

    // 2.5 Auto-proteção contra kill
    if (processInfo.name.toLowerCase() === "taskkill.exe" || processInfo.name.toLowerCase() === "sc.exe") {
       if (processInfo.commandLine.toLowerCase().includes("cybersafe")) {
          await terminateProcessTree(processInfo.pid);
          this.eventBus.publish("process.blocked", "critical", `Blocked attempt to kill CyberSafe Service`, processInfo);
          return;
       }
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
    // Idempotente: pode ser chamado pelo shutdown e pelo handler de sinais.
    if (this.disposed) return;
    this.disposed = true;
    this.protectionState = false;
    this.updater.stopScheduler();
    if (this.networkTimer) {
      clearInterval(this.networkTimer);
      this.networkTimer = null;
    }

    await Promise.allSettled([
      this.watcher.stop(),
      this.processMonitor.stop(),
      this.etwConsumer.stop(),
      this.wfpFilter.stop(),
      this.amsiProvider.stop(),
      this.windowsHealth.dispose(),
    ]);

    if (this.server) {
      for (const client of this.clients) {
        client.destroy();
      }
      this.clients.clear();

      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      }).catch(() => undefined);
      this.server = null;
    }
  }

  async shutdown() {
    // Idempotente: um segundo pedido de encerramento não repete a desmontagem.
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    console.log("[Service] Service shutdown received");

    // Deadline máximo para a desmontagem: se algum .stop() de um subsistema
    // pendurar a promise (ex.: PowerShell a bloquear), não ficamos órfãos —
    // process.exit() abaixo executa sempre.
    await Promise.race([
      (async () => {
        await this.stopProtection().catch((err) =>
          console.error("[Service] Falha ao parar proteção:", err),
        );
        await this.dispose().catch((err) =>
          console.error("[Service] Falha ao dispor recursos:", err),
        );
        console.log("[Service] Service pipe closed");
      })(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);

    NativeEngineBridge.dispose();
    console.log("[Service] NativeEngine disposed");
    DefinitionUpdater.dispose();
    console.log("[Service] Updater disposed");
    disposeTempHelper();
    console.log("[Service] Service stopped");

    // Fecha a própria aplicação NodeJS
    setTimeout(() => {
       process.exit(0);
    }, 200);
  }

  getProtectionState(): ProtectionState {
    const recentThreats = this.threats.slice(0, 10);
    const maxRisk = recentThreats.length > 0
      ? Math.max(...recentThreats.map(t => t.riskScore))
      : 0;

    // Estado real dos motores — nunca inventamos "proteção ativa".
    const engine: EngineHealth = {
      serviceRunning: true,
      osLayerHealthy: true,
      degradedReasons: [],
      monitoredPaths: this.watcher.getDefaultPaths(),
      definitionsUpdatedAt: this.definitionsUpdatedAt,
      lastEventAt: this.events.at(-1)?.timestamp,
      yara: this.yara.health,
      hashDb: this.signatures.health,
      clamav: this.clamav.health,
      nativeEngine: NativeEngineBridge.health,
      firewall: {
        status: this.wfpFilter.isActive() ? "active" : "unavailable",
        detail: this.wfpFilter.isActive() ? "WFP filter active" : "WFP filter not started",
      },
      anyEngineDegraded: false,
    };
    engine.anyEngineDegraded = hasDegradedProtections(engine);
    if (engine.anyEngineDegraded) {
      for (const key of ["yara", "hashDb", "clamav", "nativeEngine", "firewall"] as const) {
        const sub = engine[key];
        if (sub && sub.status !== "active") {
          engine.degradedReasons!.push(`${key}: ${sub.status} — ${sub.detail ?? "no detail"}`);
        }
      }
    }

    // Se a proteção está degradada (motor core ausente/indisponível), o score base
    // sobe para refletir perda de confiança nas deteções — nunca mostramos "safe".
    const effectiveRisk = effectiveRiskScore(maxRisk, engine);
    const degradedForStatus = engineIsDegraded(engine);

    const stats: ProtectionStats = {
      riskScore: effectiveRisk,
      totalEvents: this.threats.length,
      highSeverityEvents: this.threats.filter((event) => event.severity === "high" || event.severity === "critical").length,
      blockedExecutions: this.events.filter((event) => event.type === "process.blocked" || event.type === "process.killed").length,
      quarantinedCount: this.quarantine.list().length,
      monitoredProcesses: this.processes.length,
    };

    return {
      status: scoreToStatus(stats.riskScore, degradedForStatus),
      stats,
      engine,
    };
  }

  getPcState(): PcState {
    const protection = this.getProtectionState();
    const hardware = this.hardware.getLastSnapshot();
    const windowsHealth = this.windowsHealth.getLastSnapshot();

    return this.pcState.update({
      hardware,
      protection,
      windowsHealth,
      threats: this.threats,
      now: Date.now(),
    });
  }

  public getEventBus() {
    return this.eventBus;
  }

  /** Gatekeeper de exclusões usado pelo ScanManager (contadores truthfully). */
  isExcluded(filePath: string): boolean {
    try {
      return this.exclusions.isExcluded(filePath);
    } catch {
      return false;
    }
  }

  /**
   * Decide se um erro de scan transitório merece uma linha de log. Agrupa por
   * código + diretório numa janela de 60s (ex.: centenas de EPERM no mesmo
   * diretório passam a uma única linha).
   */
  private shouldLogTransientScanError(code: string, dir: string, windowMs = TRANSIENT_SCAN_ERROR_WINDOW_MS): boolean {
    const key = `${code}:${dir.toLowerCase()}`;
    const now = Date.now();
    const last = this.transientScanLogAt.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    this.transientScanLogAt.set(key, now);
    if (this.transientScanLogAt.size > 500) {
      for (const [k, at] of this.transientScanLogAt.entries()) {
        if (now - at > windowMs) this.transientScanLogAt.delete(k);
      }
    }
    return true;
  }

  async scanArtifact(filePath: string, source: ThreatEvent["source"]): Promise<ServiceResponseMap["scan.artifact"]> {
    try {
      // Gatekeeper: Check exclusions first
      const exclusionReason = this.exclusions.exclusionReason(filePath);
      if (exclusionReason) {
        console.log(`[Service] Excluded: ${filePath} (${exclusionReason})`);
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
      const nativeOutcome = await NativeEngineBridge.scan(filePath);

      // Consult VT if enabled
      let vtResult = null;
      let finalRiskScore = analysis.riskScore;
      let finalSeverity = analysis.severity;

      if (nativeOutcome.ok && nativeOutcome.result) {
        const nativeScan = nativeOutcome.result;
        if (nativeScan.score > finalRiskScore) {
          finalRiskScore = nativeScan.score;
        }
        if (nativeScan.reasons.length > 0) {
          analysis.rulesTriggered = Array.from(new Set([...analysis.rulesTriggered, ...nativeScan.reasons])) as import("@cybersafe/shared-types").HeuristicRuleId[];
          analysis.factors.push({ id: "native-scan", category: "heuristic", label: `Native scan: ${nativeScan.level}`, weight: nativeScan.score });
        }
      }

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
        if (this.blockedHashes.size > 10_000) {
          const firstHash = this.blockedHashes.values().next().value;
          if (firstHash !== undefined) this.blockedHashes.delete(firstHash);
        }
        if (this.blockedPaths.size > 10_000) {
          const firstPath = this.blockedPaths.values().next().value;
          if (firstPath !== undefined) this.blockedPaths.delete(firstPath);
        }
        const quarantineEntry = await this.quarantine.quarantine({ ...analysis, riskScore: finalRiskScore });
        this.eventBus.publish("quarantine.added", "critical", `Quarantined ${analysis.fileName}`, quarantineEntry ?? analysis);

        // Em Fase 2, também bloqueamos a conexão do domínio suspeito com WFP
        if (vtResult && vtResult.positives > 10) {
           // Simulação: Bloquear IP (aqui não temos o IP, mas poderíamos extrair das conexões ativas)
           // await this.wfpFilter.blockIp("10.0.0.99");
        }
      }

      if (finalSeverity !== "low") {
         this.eventBus.publish("threat.detected", finalSeverity, `Threat detected in ${analysis.fileName}`, threat);
         void this.logHistory({ type: "threat.detected", threat, timestamp: new Date().toISOString() });
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
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (isTransientFsError(err)) {
        // Erro esperado (junction/reparse point, ficheiro transitório): uma
        // linha agregada, sem stack trace. Erros inesperados continuam visíveis.
        if (this.shouldLogTransientScanError(code ?? "UNKNOWN", path.dirname(filePath))) {
          console.warn(`[Service] Análise ignorada (${code}): ${path.basename(filePath)}`);
        }
      } else {
        console.error("Scan error:", err);
      }
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

  async runFullSystemScan() {
    this.eventBus.publish("scan.progress", "low", "Starting full system scan...", { progress: 0 });

    const pathsToScan = [
      path.join(os.homedir(), "Downloads"),
      path.join(os.homedir(), "Desktop"),
      process.env.TEMP || "C:\\Temp"
    ];

    let totalScanned = 0;

    for (const scanPath of pathsToScan) {
      try {
        const entries = await fs.readdir(scanPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
             const fullPath = path.join(scanPath, entry.name);
             await this.scanArtifact(fullPath, "system-scanner");
             totalScanned++;

             // Publish progress every 10 files
             if (totalScanned % 10 === 0) {
                this.eventBus.publish("scan.progress", "low", `Scanned ${totalScanned} files...`, { progress: totalScanned });
             }
          }
        }
      } catch (err) {
        console.warn(`[FullScan] Failed to read directory ${scanPath}:`, err);
      }
    }

    this.eventBus.publish("scan.progress", "low", `Full system scan completed. Scanned ${totalScanned} files.`, { progress: 100, done: true, status: "completed", filesScanned: totalScanned, filesTotal: totalScanned, filesAnalyzed: totalScanned, threatsFound: 0, filesExcluded: 0, filesFailed: 0 });
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
      const updater = new DefinitionUpdater(this.definitionsDir);
      const result = await updater.checkAndUpdate(true);

      // Hot-reload: recarrega as definições em memória sem reiniciar o serviço
      await this.signatures.load(path.join(this.definitionsDir, "hashes", "default.json"));
      await this.yara.load(path.join(this.definitionsDir, "yara", "default.yar"));

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

  /**
   * Contexto de auto-proteção do kill. O serviço identifica-se a si próprio e
   * à sua ascensão por PID/ppid; componentes internos por ppid e caminho. Nunca
   * depende do nome — só o usa como fallback quando não há caminho fiável.
   */
  private killProtectionContext(): KillProtectionContext {
    const ancestorPids = new Set<number>();
    if (process.ppid > 0) ancestorPids.add(process.ppid);
    const byPid = new Map(this.processes.map((entry) => [entry.pid, entry]));
    let cursor = process.ppid;
    for (let depth = 0; depth < 16 && cursor > 0; depth += 1) {
      const parent = byPid.get(cursor);
      if (!parent || parent.ppid <= 0 || parent.ppid === cursor || ancestorPids.has(parent.ppid)) break;
      ancestorPids.add(parent.ppid);
      cursor = parent.ppid;
    }

    const internalPaths = new Set<string>();
    const internalPathPrefixes = new Set<string>();
    const commandLineMarkers = new Set<string>();

    // Runtime do próprio serviço: proteção por caminho **apenas** quando o
    // executável é específico da app (ex.: cybersafe-service.exe). Em dev o
    // serviço corre num node.exe partilhado — aí a proteção vem do PID/ppid/
    // commandLine, para não bloquear globalmente todos os node.exe.
    if (/cybersafe/i.test(process.execPath)) {
      const selfExecutable = normalizeProcessPath(process.execPath);
      if (selfExecutable) internalPaths.add(selfExecutable);
    }

    // Código do serviço (dist/src): quem corre de lá, ou aponta para lá na
    // linha de comando, é componente interno.
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const moduleDirNormalized = normalizeProcessPath(moduleDir);
    if (moduleDirNormalized) {
      internalPathPrefixes.add(moduleDirNormalized);
      commandLineMarkers.add(moduleDirNormalized);
    }
    const entry = process.argv[1] ? normalizeProcessPath(process.argv[1]) : "";
    if (entry) commandLineMarkers.add(entry);

    // App/projeto CyberSafe: só quando o próprio runtime vive sob esse nome.
    if (/cybersafe/i.test(process.execPath) || /cybersafe/i.test(moduleDir)) {
      commandLineMarkers.add("cybersafe");
    }
    if (/cybersafe/i.test(process.execPath)) {
      const execDir = normalizeProcessPath(path.dirname(process.execPath));
      if (execDir) internalPathPrefixes.add(execDir);
    }
    // Helper de snapshot do próprio serviço (powershell Get-CimInstance Win32_Process).
    commandLineMarkers.add("get-ciminstance win32_process");

    const fallbackNames = new Set(ProtectionEngineService.CRITICAL_PROCESS_NAMES);

    return {
      selfPid: process.pid,
      ancestorPids: [...ancestorPids],
      internalPaths: [...internalPaths],
      internalPathPrefixes: [...internalPathPrefixes],
      commandLineMarkers: [...commandLineMarkers],
      fallbackNames: [...fallbackNames],
      systemPidThreshold: 100,
    };
  }

  async killProcess(pid: number): Promise<ProcessKillResult> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { success: false, status: "failed", pid, error: "PID inválido" };
    }

    const processInfo = this.processes.find(p => p.pid === pid);

    // Auto-proteção por PID/ppid/path (nome só como fallback).
    const protection = classifyKillTarget(processInfo ?? { pid }, this.killProtectionContext());
    if (protection) {
      console.warn(`[Service] Blocked attempt to kill protected process PID: ${pid} (${protection})`);
      return {
        success: false,
        status: "protected",
        pid,
        protectedReason: protection,
        error: "Cannot terminate protected CyberSafe/system process",
      };
    }

    // Já terminou: fora do snapshot e o PID não existe.
    if (!processInfo && !isProcessAlive(pid)) {
      return { success: true, status: "already-exited", pid };
    }

    const originalIdentity = processInfo ? killTargetIdentity(processInfo) : undefined;
    void fs.appendFile(path.join(this.logsDir, "actions.log"), `[KILL] PID=${pid} | Name=${processInfo?.name || "unknown"}\n`, "utf-8").catch(() => {});

    const taskkill = await killProcessTree(pid);

    if (taskkill.status === "not-found") {
      // Desapareceu entre o snapshot e o taskkill — nada para reconciliar.
      this.processes = this.processes.filter((entry) => entry.pid !== pid);
      return { success: true, status: "already-exited", pid };
    }
    if (taskkill.status === "timeout") {
      return { success: false, status: "timeout", pid, error: "taskkill não terminou dentro do prazo." };
    }
    if (!taskkill.ok) {
      return { success: false, status: "failed", pid, error: taskkill.error ?? "Falha ao terminar processo." };
    }

    // Reconciliação autoritativa: só publicamos depois de o PID desaparecer.
    const reconciled = await reconcileProcessExit({
      pid,
      originalIdentity,
      probe: async (candidate) => {
        if (!isProcessAlive(candidate)) return { alive: false };
        const current = (await this.processMonitor.list()).find((entry) => entry.pid === candidate);
        return { alive: true, identity: current ? killTargetIdentity(current) : undefined };
      },
    });

    if (reconciled.status === "reused") {
      // O PID passou a outro processo: não é a nossa terminação e não mexemos na lista.
      return { success: false, status: "reused", pid, error: "PID reutilizado por outro processo; terminação não confirmada." };
    }
    if (reconciled.status === "still-running") {
      return { success: false, status: "timeout", pid, error: "Processo ainda ativo depois do taskkill." };
    }

    // PID confirmado desaparecido: reconcilia a lista e publica os eventos.
    this.processes = this.processes.filter((entry) => entry.pid !== pid);
    this.eventBus.publish("process.killed", "critical", `Killed process tree ${pid}`, { pid, name: processInfo?.name });
    this.eventBus.publish("process.exited", "low", `Process exited: ${processInfo?.name ?? pid}`, processInfo ?? { pid });
    return {
      success: true,
      status: "killed",
      pid,
      target: processInfo ? { name: processInfo.name, path: processInfo.path } : undefined,
    };
  }

  async clearEvents() {
    this.events = [];
    this.threats = [];
    return { success: true };
  }

  public emitScanProgress(scanState: any) {
    // Durante o shutdown não emitimos eventos novos para sockets a morrer.
    if (this.isShuttingDown) return;
    // Emit scan.progress event to all connected IPC clients
    const payload = {
      type: "event",
      event: {
        id: `scan-progress-${scanState.id}`,
        type: "scan.progress",
        timestamp: new Date().toISOString(),
        sequence: Date.now(),
        severity: "low",
        summary: `Scan ${scanState.status}: ${scanState.filesScanned} files, ${scanState.threatsFound} threats`,
        data: scanState,
      },
    };
    if (process.env.CYBERSAFE_DEBUG_BRIDGE === "1") {
      console.log(`[ScanService] emitting progress scanId=${scanState.id} status=${scanState.status} progress=${scanState.progress} at=${new Date().toISOString()}`);
    }
    this.broadcast(payload);
  }

  private broadcast(message: unknown) {
    // Nada de broadcasts durante o shutdown: os sockets estão a ser fechados
    // e um write para um socket morto só gera ruído/EPIPE.
    if (this.isShuttingDown) return;
    const payload = encodeMessage(message);
    if (process.env.CYBERSAFE_DEBUG_BRIDGE === "1" && (message as any)?.event?.type === "scan.progress") {
      const ev = (message as any).event;
      console.log(`[PipeServer] sending event type=${ev.type} scanId=${ev.data?.id} at=${new Date().toISOString()}`);
    }
    for (const client of [...this.clients]) {
      this.safeWrite(client, payload);
    }
  }

  /**
   * Escrita segura num cliente do pipe.
   *
   * Centraliza: verificação de vida do socket (destroyed/writable/ended),
   * remoção imediata de sockets mortos da collection e tratamento de EPIPE/
   * ECONNRESET como erro esperado. Isto não elimina a race (o peer pode fechar
   * entre a verificação e o write — Node emite o erro de forma assíncrona), mas
   * o handler de "error" do socket garante que nunca sobe como uncaught.
   */
  private safeWrite(socket: net.Socket, payload: string): boolean {
    if (socket.destroyed || socket.writableEnded || !socket.writable) {
      this.clients.delete(socket);
      return false;
    }
    try {
      socket.write(payload, (err) => {
        if (err) this.handleSocketFailure(socket, err);
      });
      return true;
    } catch (err) {
      this.handleSocketFailure(socket, err);
      return false;
    }
  }

  /**
   * Remove o socket da collection e só faz ruído para erros inesperados.
   * EPIPE/ECONNRESET (peer fechou o pipe) são normais, sobretudo no shutdown.
   */
  private handleSocketFailure(socket: net.Socket, err?: unknown) {
    this.clients.delete(socket);
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (err && !this.isShuttingDown && !EXPECTED_SOCKET_ERROR_CODES.has(String(code))) {
      console.warn("[Service] pipe socket error:", err);
    }
  }

  /**
   * Liga os handlers de um socket do pipe (dados, erros, fecho) e faz replay
   * do último evento. Separa-se do `startPipeServer` para poder ser testado
   * com sockets reais sem depender do named pipe global nem do auto-start da
   * proteção.
   */
  private attachClientSocket(socket: net.Socket) {
    this.clients.add(socket);
    let buffer = "";

    // Sem este handler, um EPIPE/ECONNRESET assíncrono (o Electron fecha o
    // pipe antes de lermos a resposta) subia como uncaught exception.
    socket.on("error", (err) => this.handleSocketFailure(socket, err));

    socket.on("data", async (chunk) => {
      buffer += chunk.toString();
      const decoded = decodeMessages(buffer);
      buffer = decoded.rest;
      for (const message of decoded.messages) {
        const request = message as RpcRequest;
        if (request.type !== "request") continue;
        const response = await this.handleRequest(request);
        // A resposta pode chegar depois de o socket já ter sido fechado
        // (disconnect do Electron ou dispose() do próprio serviço).
        this.safeWrite(socket, encodeMessage(response));
      }
    });

    socket.on("end", () => this.clients.delete(socket));
    socket.on("close", () => this.clients.delete(socket));

    const lastEvent = this.eventBus.getReplay().at(-1);
    if (lastEvent) {
      this.safeWrite(socket, encodeMessage({ type: "event", event: lastEvent }));
    }
  }

  async startPipeServer() {
    this.server = net.createServer((socket) => {
      this.attachClientSocket(socket);

      // Auto-ativa a proteção quando a primeira UI/desktop se liga ao serviço,
      // para que processos, ligações e monitorização fiquem ativos de imediato.
      if (!this.isShuttingDown) {
        void this.startProtection().catch((err) =>
          console.error("[Service] Falha ao auto-iniciar proteção:", err),
        );
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
    // Durante o shutdown deixamos de aceitar trabalho novo (scans, updates,
    // ligar proteção). O pedido de shutdown em si continua a ser atendido.
    if (this.isShuttingDown && SHUTDOWN_BLOCKED_METHODS.has(method as string)) {
      throw new Error("Serviço a encerrar: pedido ignorado.");
    }
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
      case "scan.fullSystem":
        this.runFullSystemScan();
        return { success: true };
      case "monitor.start":
        return this.startProtection();
      case "monitor.stop":
        return this.stopProtection();
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
        return this.hardware.getLastSnapshot() || await this.hardware.getSnapshot(this.processes);
      case "windows.healthSnapshot":
        return this.windowsHealth.getCached();
      case "pcstate.get":
        return this.getPcState();
      case "process.analyze":
        return this.analyzeProcess((payload as { pid: number }).pid);
      case "exclusions.get":
        return this.exclusions.getConfig();
      case "exclusions.update":
        return this.exclusions.updateConfig(payload as any);
      case "scan.start": {
        const { type, targetPath } = payload as any;
        console.log(`[ScanService] received scan.start type=${String(type)} targetPath=${String(targetPath)} at=${new Date().toISOString()}`);
        const id = await this.scanManager.startScan(type, targetPath);
        if (!id) {
          console.warn("[ScanService] start rejected: another scan is already running");
          return { id: "", success: false, error: "Já existe uma análise em curso. Cancele ou aguarde a conclusão." };
        }
        console.log(`[ScanService] start accepted id=${id} at=${new Date().toISOString()}`);
        return { id, success: true };
      }
      case "scan.getActive": {
        // Snapshot for UI resync (remount / page navigation / missed event).
        return this.scanManager.getActiveScan() ?? null;
      }
      case "scan.cancel": {
        const { id } = payload as any;
        this.scanManager.cancelScan(id);
        return { success: true };
      }
      case "threat.action": {
        const { id, action } = payload as any;
        let success = false;

        if (action === "restore") {
          success = await this.quarantine.restore(id);
          if (success) void this.logHistory({ type: "threat.restored", id, timestamp: new Date().toISOString() });
        } else if (action === "delete") {
          success = await this.quarantine.delete(id);
          if (success) void this.logHistory({ type: "threat.deleted", id, timestamp: new Date().toISOString() });
        } else if (action === "quarantine") {
           // For a manual quarantine, we'd need the threat event.
           // We can look it up in this.threats
           const threat = this.threats.find(t => t.url === `file://${id}` || t.filePath === id);
           if (threat && threat.filePath) {
              const analysis = {
                artifactPath: threat.filePath,
                fileName: path.basename(threat.filePath),
                sha256: "", // We might not have it in the threat obj directly if not saved
                verdict: "suspicious",
                riskScore: threat.riskScore
              } as any;

              const entry = await this.quarantine.quarantine(analysis);
              success = !!entry;
              if (success) void this.logHistory({ type: "threat.quarantined_manual", id, timestamp: new Date().toISOString() });
           }
        }

        return { success };
      }
      case "service.shutdown":
        // O ACK é escrito pelo handler do socket assim que dispatch() resolve.
        // Adiamos a desmontagem para o tick seguinte para garantir que o ACK
        // sai antes de fecharmos o servidor/sockets. Sem isto, a escrita do
        // ACK corria contra o destroy() do próprio socket e gerava EPIPE.
        setImmediate(() => void this.shutdown());
        return { success: true };
      default:
        throw new Error(`Unsupported method: ${String(method)}`);
    }
  }

  private async logHistory(record: any) {
    try {
      await fs.appendFile(this.historyPath, JSON.stringify(record) + "\n", "utf-8");
    } catch {
      // Ignore
    }
  }
}
