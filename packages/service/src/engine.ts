import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  isAliasStubTarget,
  isProcessAlive,
  killProcessTree,
  killTargetIdentity,
  KILL_REAP_DEADLINE_MS,
  KILL_REAP_INTERVAL_MS,
  normalizeProcessPath,
  reconcileProcessExit,
  scoreToStatus,
  decideTaskkillRetry,
  treeChildrenOf,
  KILL_RETRY_DELAY_MS,
  TREE_SWEEP_MAX_DEPTH,
  TREE_SWEEP_MAX_TARGETS,
  ExclusionManager,
  engineIsDegraded,  effectiveRiskScore,
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
  AmsiProvider,
  PROCESS_POLL_INTERVAL_MS
} from "@cybersafe/native-windows";
import { NativeEngineBridge } from "./native-engine-bridge.js";
import { isTransientFsError, TRANSIENT_SCAN_ERROR_WINDOW_MS } from "./scan-error.js";
import { DefinitionUpdater } from "./updater.js";
import { ScanManager } from "./scan-manager.js";
import { createServiceLogWriters, shouldPersistEvent, formatScanLog, scanIdFromContext, type LogWriter } from "./log-writer.js";
import type {
  AnalysisResult,
  ConnectionSnapshot,
  EngineHealth,
  KillProcessResult,
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
import type { KillProtectionContext, KillTargetInfo } from "@cybersafe/core";

const execFileAsync = promisify(execFile);

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

/** Sanitiza output do taskkill para uma única linha legível no actions.log. */
function oneLineLog(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

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
  private readonly logWriters = createServiceLogWriters(this.baseDir);
  readonly eventsLog: LogWriter = this.logWriters.events;
  readonly actionsLog: LogWriter = this.logWriters.actions;
  /** Log verboso de scan desligado por omissão (I/O). */
  private readonly scanDebugEnabled = process.env.CYBERSAFE_DEBUG_BRIDGE === "1";

  private server: net.Server | null = null;
  private events: SecurityEvent[] = [];
  private threats: ThreatEvent[] = [];
  private processes: ProcessSnapshot[] = [];
  /** Quando foi a última reconciliação de `processes` com a verdade do SO. */
  private processesEnumeratedAt = 0;
  /** Reconciliações concorrentes partilham uma única enumeração (nunca duas). */
  private processesEnumerating: Promise<ProcessSnapshot[]> | null = null;
  /**
   * PIDs cuja MORTE foi confirmada pelo Windows, com a identidade que tinham.
   * Uma enumeração demora 2–4 s e o poll do monitor só corre a cada 10 s: os
   * dois podem chegar com um processo que já morreu lá pelo meio. Nenhum
   * snapshot velho pode reescrever a verdade, portanto um PID tombado só volta
   * à lista depois de expirar — ou quando o Windows lhe der OUTRO dono
   * (reutilização real de PID, que é um processo legítimo novo).
   */
  private processTombstones = new Map<number, { expiresAt: number; identity: string }>();
  /** `identity` de um alvo cuja identidade nunca foi conhecida: vale para qualquer dono. */
  private static readonly TOMBSTONE_ANY_IDENTITY = "*";
  /** Incrementa em cada remoção autoritativa de `processes` (época da enumeração em voo). */
  private processesRevision = 0;
  // ── P4: orçamento global do kill ────────────────────────────────────────
  // O renderer (packages/app/src/lib/processActions.ts: KILL_TIMEOUT_MS) deriva
  // o prazo DESTAS parcelas. Antes, o serviço podia levar 27–33 s porque cada
  // etapa tinha o seu timeout independente e todos eram ADITIVOS — e o deadline
  // do reap (5 s) não limitava a sua própria probe CIM (6 s): em
  // packages/core/src/response.ts a probe é awaited (linha 407) e o deadline só
  // é verificado depois (linha 411), logo uma query a meio transborda.
  //
  // Agora há UM deadline e cada etapa recebe `remaining()` — incluindo a espera
  // entre tentativas. Cada etapa mantém o seu limite generoso sempre que houver
  // orçamento; o que deixa de existir é a soma.
  //
  // A aritmética do pior caso, e porque 12 000 e não 13 000: o reap tem um PISO
  // de 2 s (abaixo) que pode ultrapassar o `remaining` quando o orçamento já
  // está quase gasto. Pior caso absoluto = orçamento + piso = 12 000 + 2 000 =
  // 14 000 ms. O renderer soma a isto uma margem para o invoke e o pipe
  // (16 000 ms), logo nunca desiste antes de o serviço responder. Com 13 000 o
  // pior caso daria 15 000 — o renderer e o serviço a expirar no mesmo
  // instante, que é a divergência que estamos a fechar.
  private static readonly KILL_TOTAL_BUDGET_MS = 12_000;
  /** Timeout de uma query CIM por alvo. Generoso de propósito: um WQL
   *  `ProcessId=n` custa 0.3–1 s; isto só é atingido com o CIM estrangulado. */
  private static readonly CIM_QUERY_TIMEOUT_MS = 6_000;
  /** Query de alias/stub: é só DIAGNÓSTICO. Devolver `null` cai no
   *  `already-exited`/`killed`, que já são as respostas correctas — por isso
   *  encolher aqui é seguro por construção. */
  private static readonly KILL_ALIAS_QUERY_TIMEOUT_MS = 2_000;
  /** Piso do reap: `killProbeConfirmations` ausências CIM e
   *  `killProbeMinIntervalMs` entre queries implicam ~1.5–2 s para confirmar a
   *  morte. Encolher abaixo disto fabricaria `still-running` falsos. */
  private static readonly KILL_REAP_FLOOR_MS = 2_000;
  /** Tecto de um `taskkill` a um DESCENDENTE na varredura de árvore. Cada
   *  filho leva o seu próprio attempt; sem teto, três filhos teimosos
   *  gastavam o orçamento todo antes de chegar a vez do reap. */
  private static readonly KILL_TREE_CHILD_TIMEOUT_MS = 2_000;
  /** Seam de teste do prazo/intervalo da reconciliação pós-kill. */
  private killReapDeadlineMs = KILL_REAP_DEADLINE_MS;
  private killReapIntervalMs = KILL_REAP_INTERVAL_MS;
  /**
   * Intervalo mínimo entre queries-alvo ao PID dentro da reconciliação. Sem
   * isto, cada iteração de 150 ms lançava um PowerShell novo — até ~33
   * processos, que é o que tornava o "A terminar processo" lento e a máquina
   * um inferno.
   */
  private killProbeMinIntervalMs = 500;
  /** Antes de quantas confirmações seguidas o CIM diz "não existe"? Um falhanço transitório não mata ninguém. */
  private killProbeConfirmations = 2;
  /** Seam de teste: execução do taskkill (mesmo padrão do spawnImpl no core).
   *  P4: aceita `timeoutMs` para que o kill possa limitar a etapa ao orçamento
   *  global restante. `killProcessTree` no core já suporta `timeoutMs`, logo
   *  esta é a única superfície que alarga — o core não muda. */
  private readonly runTaskkill: (pid: number, options?: { timeoutMs?: number }) => Promise<KillProcessResult> = killProcessTree;
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
      // Re-semeia quando a base em disco contém registos legados (ex.: hash EICAR
      // fabricado) que já foram corrigidos no built-in — o runtime nunca fica
      // com uma base desactualizada.
      await this.signatures.refreshBuiltinIfStale(path.join(this.definitionsDir, "hashes", "default.json"));
    await this.yara.load(path.join(this.definitionsDir, "yara", "default.yar"));
    // ClamAV (Workstream C): corre o probe UMA vez no arranque — binário +
    // base de assinaturas. Sem isto, protection.getState mostra clamav
    // "Not checked" para sempre mesmo com o clamscan instalado.
    await this.clamav.isAvailable();
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
          const revisionBefore = this.processesRevision;
          this.processes = this.withoutTombstoned(p);
          // O restart da proteção pode apanhar um kill em curso: vale a mesma
          // regra de `listProcesses()` — só se re-arma o TTL se nada mudou
          // entretanto, e um PID morto confirmado não volta por aqui.
          if (revisionBefore === this.processesRevision) this.processesEnumeratedAt = Date.now();
          else this.processesEnumeratedAt = 0;
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
      // Log hygiene (Workstream F): rotation + dedupe via LogWriter, never
      // unbounded append that grows security-events.log to hundreds of MB.
      // Só persistimos eventos úteis: file.created/modified, process.started/
      // exited e scan.progress são ruído de alta frequência (ETW/watcher) e
      // eram a maior fonte de volume em disco. Continuam a ser transmitidos
      // em direto para a UI no broadcast abaixo.
      if (shouldPersistEvent(event)) {
        const scanId = scanIdFromContext(event as any);
        void this.eventsLog.write(
          scanId
            ? JSON.stringify({ ...event, scanId })
            : JSON.stringify(event),
        );
      }
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
      // O cap de 200 foi REMOVIDO: cada evento empurrava a cauda para fora do
      // cache em silêncio, e com 330+ processos reais qualquer processo —
      // incluindo um notepad — podia ficar invisível. A fonte de verdade é o
      // SO via listProcesses(); os eventos só mantêm o cache vivo entre pedidos.
      //
      // P1: o snapshot deste poll foi capturado antes (o poll demora segundos e
      // só corre a cada 10 s). Um PID que já confirmámos morto não reentra por
      // aqui — isso era exatamente o zombie "morto no Windows, visível no
      // CyberSafe". Identidade diferente = reutilização real de PID, e essa é
      // bem-vinda.
      if (this.tombstoneBlocks(processInfo.pid, processInfo.name, processInfo.commandLine)) return;
      this.processes = [processInfo, ...this.processes.filter((entry) => entry.pid !== processInfo.pid)];
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
   *
   * Aqui o Windows já matou o processo (foi o poll que o viu desaparecer), por
   * isso o PID fica tombado — mas NÃO invalida a janela de frescura: as saídas
   * naturais são frequentes e o cache já está correto; invalidar cada uma era
   * uma tempestade de enumerações de 2-4 s.
   */
  private handleNaturalProcessExit(processInfo: ProcessSnapshot) {
    const wasCached = this.processes.some((entry) => entry.pid === processInfo.pid);
    this.dropCachedProcess(processInfo.pid, processInfo, { tombstone: true, invalidateTruth: false });
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
        // Uma linha por ficheiro excluído = uma linha por ficheiro do disco
        // durante um scan completo. Só interessa com debug ligado.
        if (this.scanDebugEnabled) {
          console.log(`[Service] Excluded: ${filePath} (${exclusionReason})`);
        }
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

      // Log VT result to Action log (Workstream F: rotation + dedupe)
      if (vtResult) {
        void this.actionsLog.write(`[ANALYSIS] ${filePath} | VT: ${vtResult.detectionRatio} | Score: ${finalRiskScore}`);
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

    void this.actionsLog.write(`[INVESTIGATE] PID=${pid} | Name=${processInfo.name}`);

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

  /**
   * Janela de frescura da enumeração do SO para `processes.list`. É a MESMA
   * cadência de descoberta, o dobro: o `ProcessMonitor` re-enumera o SO de
   * `PROCESS_POLL_INTERVAL_MS` em `PROCESS_POLL_INTERVAL_MS`, e cada evento
   * `process.started`/`process.exited` mantém o cache actualizado entre rounds.
   * O TTL não é "quanto tempo podemos mentir": é "quando é que o monitor
   * deixou de respirar e a lista tem de ir ao SO por conta própria".
   *
   * Medido (servico vivo, 355+ processos, app ligada):
   *   TTL de 2 000 ms com poll de 10 000 ms  -> 3 pedidos de lista em 60 s,
   *     0 hits, 3 misses. TODOS os pedidos re-enumeravam o SO, ao lado do poll
   *     que já o tinha enumerado segundos antes: ~7 enumerações/min a competir
   *     entre si, e a enumeração deixou de custar 0,3 s para custar 8-25 s
   *     (storm de WMI). Foi essa a fonte dos "segundos" que o utilizador viu.
   *   TTL alinhado com o poll -> 0 misses em repouso; a lista responde a cache
   *     (1 ms) e o SO continua reconciliado pelo monitor a cada 5 s.
   *
   * Regra que isto NÃO pode perder: um cache mais velho que o TTL obriga a
   * reconciliação on-demand (é a única forma de o cache liar), e um PID
   * tombstonado nunca reentra por nenhum dos dois caminhos.
   */
  private static readonly PROCESS_TRUTH_TTL_MS = PROCESS_POLL_INTERVAL_MS * 2;

  /**
   * Um tombstone barra este PID? Barra quando é o mesmo processo que
   * confirmámos morto (ou quando não conhecíamos a identidade do morto e por
   * isso qualquer candidato é suspeito). Se a identidade for DIFERENTE, o
   * Windows reutilizou o PID: o tombstone deixa de fazer sentido e é removido.
   */
  private tombstoneBlocks(pid: number, name?: string, commandLine?: string): boolean {
    const tombstone = this.processTombstones.get(pid);
    if (!tombstone) return false;
    if (tombstone.expiresAt <= Date.now()) {
      this.processTombstones.delete(pid);
      return false;
    }
    if (
      tombstone.identity !== ProtectionEngineService.TOMBSTONE_ANY_IDENTITY &&
      killTargetIdentity({ name, commandLine }) !== tombstone.identity
    ) {
      this.processTombstones.delete(pid);
      return false;
    }
    return true;
  }

  /** Aplica os tombstones a uma lista vinda do SO/eventos (no-op quando não há). */
  private withoutTombstoned(list: ProcessSnapshot[]): ProcessSnapshot[] {
    const now = Date.now();
    for (const [pid, tombstone] of this.processTombstones) {
      if (tombstone.expiresAt <= now) this.processTombstones.delete(pid);
    }
    if (this.processTombstones.size === 0) return list;
    return list.filter((entry) => !this.tombstoneBlocks(entry.pid, entry.name, entry.commandLine));
  }

  /**
   * Remove um PID do cache de forma autoritativa — o único caminho que decide
   * se o PID fica tombado (morreu: nunca pode voltar por um snapshot velho) e
   * se a janela de frescura é invalidada (precisamos de uma nova palavra do
   * Windows já a seguir).
   */
  private dropCachedProcess(
    pid: number,
    entry: { name?: string; commandLine?: string } | undefined,
    options: { tombstone: boolean; invalidateTruth: boolean },
  ) {
    this.processes = this.processes.filter((cached) => cached.pid !== pid);
    this.processesRevision += 1;
    if (options.tombstone) {
      this.processTombstones.set(pid, {
        // Duas janelas de frescura: o tempo de uma enumeração em curso chegar ao
        // fim, e o teto de um PID que o Windows há de reutilizar.
        expiresAt: Date.now() + ProtectionEngineService.PROCESS_TRUTH_TTL_MS * 2,
        identity: entry
          ? killTargetIdentity(entry)
          : ProtectionEngineService.TOMBSTONE_ANY_IDENTITY,
      });
    } else {
      this.processTombstones.delete(pid);
    }
    if (options.invalidateTruth) this.processesEnumeratedAt = 0;
  }

  /**
   * processes.list com reconciliação on-demand: a fonte de verdade é o SO
   * (`processMonitor.list()`), não o cache de eventos. Antes disto, o handler
   * devolvia só o cache (cap silencioso de 200, nunca re-enumerava) e o
   * "refresh" da UI nunca via a realidade — processos reais ficavam invisíveis.
   * Enumeração falhou → serve o cache (degradado, nunca lista vazia silenciosa).
   */
  async listProcesses(): Promise<ProcessSnapshot[]> {
    const cached = this.withoutTombstoned(this.processes);
    if (
      cached.length > 0 &&
      Date.now() - this.processesEnumeratedAt < ProtectionEngineService.PROCESS_TRUTH_TTL_MS
    ) {
      return cached;
    }
    if (!this.processesEnumerating) {
      this.processesEnumerating = (async () => {
        try {
          const fresh = await this.processMonitor.list();
          // Uma enumeração é uma FOTO. Um processo que nasce (ou que a UI mata)
          // enquanto ela corre não pode estar na foto, e overwrite simples
          // apagava do cache um processo VIVO — ou trazia de volta um morto.
          //
          // A reconciliação é a mesma nos dois sentidos, e é o que a medição
          // pediu: a foto do SO é a base, e por cima dela fica o que o próprio
          // monitor publican enquanto a foto era tirada. O que saiu entretanto
          // já não está no cache E está tombstonado, logo não volta por este
          // caminho — `withoutTombstoned` é quem garante isso, e a truth
          // continua a ser reconciliada pelo SO no próximo pedido em cache.
          //
          // Antes, uma saída natural durante a enumeração invalidava a
          // frescura (`processesEnumeratedAt = 0`) e TODOS os pedidos seguintes
          // voltavam ao Windows: medido, 6 enumerações por minuto a mais, sem
          // qualquer ganho de correcção — a foto já era correcta.
          this.processes = this.withoutTombstoned(this.mergeEventObserved(fresh));
          this.processesEnumeratedAt = Date.now();
        } catch (error) {
          console.error("[Service] processes.list: falhou a enumeração do SO; a servir o cache de eventos:", error);
        } finally {
          this.processesEnumerating = null;
        }
        return this.processes;
      })();
    }
    return this.processesEnumerating;
  }

  /**
   * Foto do SO + o que o monitor-publicou durante a foto. Só entra o que ainda
   * está no cache de eventos: um processo que saiu foi removido do cache e
   * tombstonado, portanto não pode ser ressuscitado por aqui.
   */
  private mergeEventObserved(fresh: ProcessSnapshot[]): ProcessSnapshot[] {
    const byPid = new Map(fresh.map((entry) => [entry.pid, entry]));
    for (const cached of this.processes) {
      if (!byPid.has(cached.pid)) byPid.set(cached.pid, cached);
    }
    return Array.from(byPid.values());
  }

  /**
   * CIM query com FILTRO ALVO (A1): um único PowerShell com WQL exato
   * (ProcessId=n / Name='x') — barato (~0.3–1 s) vs a enumeração completa
   * (~2 s) que o caminho do kill fazia antes em cada PID fora do cache.
   * Falhou ⇒ devolve []: o kill segue com a classificação que tem (PID,
   * limiares, ancestrais), nunca fica bloqueado pelo diagnóstico.
   * Seam de teste: este método é substituível na instância.
   */
  async queryCimProcesses(cimFilter: string, timeoutMs = ProtectionEngineService.CIM_QUERY_TIMEOUT_MS): Promise<KillTargetInfo[]> {
    const psLiteral = `'${cimFilter.replace(/'/g, "''")}'`;
    const script =
      "$ErrorActionPreference='Stop';" +
      ` Get-CimInstance -ClassName Win32_Process -Filter ${psLiteral}` +
      " | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath" +
      " | ConvertTo-Json -Compress";
    try {
      const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        // P4: parametrizado para que a reconcileação possa limitar a probe ao
        // orçamento restante. Uma query já em voo não pode ser interrompida a
        // meio, por isso o transbordo do deadline do reap nascia daqui.
        timeout: Math.max(1, timeoutMs),
        maxBuffer: 4_000_000,
      });
      const text = stdout.trim();
      if (!text) return [];
      const parsed = JSON.parse(text) as Record<string, unknown> | Record<string, unknown>[];
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .map((raw) => ({
          pid: Number(raw.ProcessId),
          ppid: Number(raw.ParentProcessId) || 0,
          name: raw.Name ? String(raw.Name) : undefined,
          // ExecutablePath pode ser null sem privilégios — mantém "", nunca se inventa.
          path: raw.ExecutablePath ? String(raw.ExecutablePath) : "",
          commandLine: raw.CommandLine ? String(raw.CommandLine) : "",
        }))
        .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
    } catch (error) {
      console.warn(`[Service] CIM query falhou (${cimFilter}):`, (error as Error)?.message ?? error);
      return [];
    }
  }

  /** Identidade de UM PID por query-alvo — não enumera o SO (A1). */
  private async lookupProcessByPid(
    pid: number,
    timeoutMs?: number,
  ): Promise<KillTargetInfo | undefined> {
    const rows = await this.queryCimProcesses(`ProcessId=${pid}`, timeoutMs);
    return rows.find((entry) => entry.pid === pid);
  }

  private async findLiveProcessesByName(name: string, timeoutMs?: number): Promise<KillTargetInfo[]> {
    return this.queryCimProcesses(`Name='${name.replace(/'/g, "''")}'`, timeoutMs);
  }

  /**
   * A3 — Reconciliação alias/stub. O PID alvo era um launcher de App
   * Execution Alias (MSIX — morre depois de ativar a app) ou já tinha morrido
   * antes do taskkill: query por nome ao OS; se existir OUTRA instância viva
   * com a mesma identidade, o processo que o utilizador vê continua vivo —
   * desfecho explícito alias-stub, nunca falso killed/already-exited.
   * Conservador por desenho:
   *  - kill bem-sucedido de processo NORMAL não faz check (apps
   *    multi-instância — 2 janelas de notepad — seriam falsos positivos);
   *  - not-found sem commandLine fiável mantém o already-exited clássico.
   */
  private async detectRealInstanceForDeadTarget(
    captured: KillTargetInfo | undefined,
    deadPid: number,
    allowSameIdentityMatch: boolean,
    timeoutMs = ProtectionEngineService.KILL_ALIAS_QUERY_TIMEOUT_MS,
  ): Promise<{ realPid: number; message: string } | null> {
    if (!captured?.name) return null;
    const stub = isAliasStubTarget(captured);
    const sameIdentity = allowSameIdentityMatch && !stub && Boolean(captured.commandLine?.trim());
    if (!stub && !sameIdentity) return null;
    const expectedIdentity = sameIdentity ? killTargetIdentity(captured) : "";
    for (const instance of await this.findLiveProcessesByName(captured.name, timeoutMs)) {
      if (instance.pid === deadPid || !isProcessAlive(instance.pid)) continue;
      if (sameIdentity && killTargetIdentity(instance) !== expectedIdentity) continue;
      return stub
        ? {
            realPid: instance.pid,
            message: `O PID ${deadPid} era um stub/App Execution Alias do Windows; o processo real com a mesma identidade está vivo no PID ${instance.pid} — termina esse PID.`,
          }
        : {
            realPid: instance.pid,
            message: `O PID ${deadPid} já tinha terminado antes do taskkill; existe outra instância viva com a mesma identidade (PID ${instance.pid}).`,
          };
    }
    return null;
  }

  /**
   * O PID ainda é um processo vivo para o Windows? `isProcessAlive` mente para
   * o lado "vivo" (objeto do processo fica abrível com handles), por isso o CIM
   * tem a última palavra — é o mesmo critério da reconciliação do P2.
   */
  private async killTargetStillAlive(pid: number, timeoutMs: number): Promise<boolean> {
    if (!isProcessAlive(pid)) return false;
    const row = await this.lookupProcessByPid(pid, timeoutMs);
    return !!row;
  }

  /**
   * Varre a árvore do PID e mata os descendentes UM A UM.
   *
   * Porque é preciso: `taskkill /T` só alcança quem ainda é filho daquele PID
   * naquele instante. Quando a raiz da árvore morre antes (è o caso dos pacotes
   * MSIX e dos launchers), os netos ficam órfãos/re-parented e o `/T` do pai já
   * não os toca — ficava "o processo morreu e há janelas assim mesmo". A
   * enumeração é por nível (CIM `ParentProcessId=n`), com teto de profundidade
   * e de alvos, e nunca mira componentes do próprio CyberSafe.
   */
  private async sweepProcessTree(
    rootPid: number,
    step: (ceiling: number) => number,
  ): Promise<{ killed: number[]; survived: number[]; refusedProtected: number[] }> {
    const killed: number[] = [];
    const survived: number[] = [];
    const refusedProtected: number[] = [];
    const seen = new Set<number>([rootPid]);
    let frontier: number[] = [rootPid];

    for (
      let depth = 0;
      depth < TREE_SWEEP_MAX_DEPTH && frontier.length > 0 && killed.length + survived.length < TREE_SWEEP_MAX_TARGETS;
      depth += 1
    ) {
      const next: number[] = [];
      for (const parentPid of frontier) {
        const children = treeChildrenOf(
          parentPid,
          await this.queryCimProcesses(`ParentProcessId=${parentPid}`, step(ProtectionEngineService.KILL_ALIAS_QUERY_TIMEOUT_MS)),
        );
        for (const child of children) {
          if (seen.has(child.pid)) continue;
          seen.add(child.pid);
          if (classifyKillTarget(child, this.killProtectionContext())) {
            refusedProtected.push(child.pid);
            continue;
          }
          if (!isProcessAlive(child.pid)) continue;
          const result = await this.runTaskkill(child.pid, { timeoutMs: step(ProtectionEngineService.KILL_TREE_CHILD_TIMEOUT_MS) });
          const stillThere = await this.killTargetStillAlive(child.pid, step(ProtectionEngineService.KILL_ALIAS_QUERY_TIMEOUT_MS));
          if (!stillThere && result.status !== "timeout") {
            killed.push(child.pid);
            next.push(child.pid);
          } else {
            survived.push(child.pid);
          }
        }
      }
      frontier = next;
    }
    return { killed, survived, refusedProtected };
  }

  async killProcess(pid: number): Promise<ProcessKillResult> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { success: false, status: "failed", pid, error: "PID inválido" };
    }

    // ── P4: orçamento global ──────────────────────────────────────────────
    // Um deadline só, do qual cada etapa recebe o que resta. Cada etapa mantém
    // o seu timeout generoso enquanto houver orçamento; o que deixa de existir
    // é a soma. Pior caso absoluto: KILL_TOTAL_BUDGET_MS + KILL_REAP_FLOOR_MS
    // (14 000 ms) — o reap é o único estravas, porque uma probe pode transbordar
    // `remaining` até ao piso sem fabricar `still-running` falsos. O renderer
    // (packages/app/src/lib/processActions.ts: KILL_TIMEOUT_MS) deriva o prazo
    // destas mesmas parcelas mais a margem do pipe, portanto ainda não desistiu
    // quando o serviço responde. O contrato é testado em kill-budget.test.js.
    const killDeadline = Date.now() + ProtectionEngineService.KILL_TOTAL_BUDGET_MS;
    const remaining = () => killDeadline - Date.now();
    /** Timeout de uma etapa: o que resta do orçamento, nunca acima do tecto. */
    const step = (ceiling: number) => Math.max(0, Math.min(ceiling, remaining()));

    let processInfo: KillTargetInfo | undefined = this.processes.find((p) => p.pid === pid);
    // O processo existe mas não está no cache: ir ao OS, mas por QUERY-ALVO
    // do PID (A1) — a listProcesses() completa custava ~2 s no meio do
    // clique e era isso que tornava o modal lenta.
    if (!processInfo && isProcessAlive(pid)) {
      processInfo = await this.lookupProcessByPid(pid, step(ProtectionEngineService.CIM_QUERY_TIMEOUT_MS));
    }

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

    // Orçamento já esgotado antes de matar: dizemos a verdade em vez de
    // disparar um taskkill que só viria entregar a resposta depois do prazo.
    if (remaining() <= 0) {
      return {
        success: false,
        status: "timeout",
        pid,
        error: `Orçamento de ${ProtectionEngineService.KILL_TOTAL_BUDGET_MS} ms esgotado antes do taskkill.`,
      };
    }

    const logKillAttempt = (attempt: number, result: KillProcessResult) => {
      void fs
        .appendFile(
          path.join(this.logsDir, "actions.log"),
          `[KILL] PID=${pid} | Name=${processInfo?.name ?? "unknown"} | Cmd=taskkill /F /T /PID ${pid}` +
          ` | Attempt=${attempt} | Status=${result.status} | Exit=${result.exitCode ?? "n/a"}` +
          ` | Stdout="${oneLineLog(result.stdout)}" | Stderr="${oneLineLog(result.stderr)}"\n`,
          "utf-8",
        )
        .catch(() => {});
    };

    let attempt = 1;
    let taskkill = await this.runTaskkill(pid, { timeoutMs: remaining() });
    logKillAttempt(attempt, taskkill);

    // Retry com critério do SO, não do taskkill: o exit 255 nao distingue "ja
    // nao existe" de "nao consegui terminar", por isso o que manda é a
    // verificacao de vivacidade. Repetir o mesmo comando sobre um PID que o
    // Windows ja nao tinha era o ciclo que se estava a chamar resiliencia a
    // si proprio. Cada tentativa fica registada no actions.log.
    while (!taskkill.ok) {
      const alive = await this.killTargetStillAlive(pid, step(ProtectionEngineService.KILL_ALIAS_QUERY_TIMEOUT_MS));
      const decision = decideTaskkillRetry({
        attempts: attempt,
        targetAlive: alive,
        budgetRemainingMs: remaining(),
        status: taskkill.status,
      });
      if (decision !== "retry") break;
      // A espera tambem come orçamento: `decideTaskkillRetry` so autoriza a
      // repetição com resto, mas nao pode passar do deadline global.
      const retryDelay = Math.min(KILL_RETRY_DELAY_MS, Math.max(0, remaining()));
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      attempt += 1;
      taskkill = await this.runTaskkill(pid, { timeoutMs: remaining() });
      logKillAttempt(attempt, taskkill);
    }

    // (o registo por tentativa fica no `logKillAttempt` acima: PID, comando,
    // exit code, stdout e stderr reais de cada `taskkill`.)

    if (taskkill.status === "not-found") {
      // Desapareceu entre o snapshot e o taskkill — nada para reconciliar.
      // A2/P1: o cache acabou de perder um membro — invalida a janela de
      // frescura para o próximo processes.list re-enumerar, e o tombstone barra
      // o morto que uma enumeração já em curso traria de volta.
      this.dropCachedProcess(pid, processInfo, { tombstone: true, invalidateTruth: true });
      const alias = await this.detectRealInstanceForDeadTarget(
        processInfo,
        pid,
        true,
        step(ProtectionEngineService.KILL_ALIAS_QUERY_TIMEOUT_MS),
      );
      if (alias) {
        return {
          success: false,
          status: "alias-stub",
          pid,
          exitCode: taskkill.exitCode,
          target: processInfo ? { name: processInfo.name, path: processInfo.path } : undefined,
          error: alias.message,
        };
      }
      return { success: true, status: "already-exited", pid, exitCode: taskkill.exitCode };
    }
    if (taskkill.status === "timeout") {
      return {
        success: false,
        status: "timeout",
        pid,
        exitCode: taskkill.exitCode,
        stdout: taskkill.stdout,
        stderr: taskkill.stderr,
        error: "taskkill não terminou dentro do prazo.",
      };
    }
    if (taskkill.status === "access-denied") {
      // O Windows recusou o término (ex.: exit 5) — processo protegido ou sem
      // privilégios. É desfecho próprio, nunca "falha genérica" sem diagnóstico.
      return {
        success: false,
        status: "access-denied",
        pid,
        exitCode: taskkill.exitCode,
        stdout: taskkill.stdout,
        stderr: taskkill.stderr,
        error: taskkill.error ?? "Acesso negado ao terminar o processo.",
      };
    }
    if (!taskkill.ok) {
      // O `/T` nao apanhou a arvore. Na pratica isto acontece quando a raiz ja
      // morreu e os descendentes ficaram orfaos/re-parented — o taskkill do pai
      // nao os toca, e o utilizador ve janelas vivas com "o processo morreu".
      // Varre a arvore e mata cada PID individualmente; so depois e que se
      // afirma seja o que for.
      const sweep = await this.sweepProcessTree(pid, step);
      const rootAlive = await this.killTargetStillAlive(pid, step(ProtectionEngineService.KILL_ALIAS_QUERY_TIMEOUT_MS));

      if (!rootAlive && sweep.survived.length === 0) {
        // Raiz confirmada morta pelo Windows e nada da arvore sobreviveu: e um
        // kill concluido, nao um sucesso inventado a partir de um exit code.
        this.dropCachedProcess(pid, processInfo, { tombstone: true, invalidateTruth: true });
        this.eventBus.publish("process.killed", "critical", `Killed process tree ${pid}`, { pid, name: processInfo?.name });
        this.eventBus.publish("process.exited", "low", `Process exited: ${processInfo?.name ?? pid}`, processInfo ?? { pid });
        return {
          success: true,
          status: "killed",
          pid,
          exitCode: taskkill.exitCode,
          target: processInfo ? { name: processInfo.name, path: processInfo.path } : undefined,
        };
      }

      const survivors = [...(rootAlive ? [pid] : []), ...sweep.survived];
      return {
        success: false,
        status: "failed",
        pid,
        exitCode: taskkill.exitCode,
        stdout: taskkill.stdout,
        stderr: taskkill.stderr,
        error:
          `${taskkill.error ?? "Falha ao terminar processo."} ` +
          `Tentativas=${attempt}; ` +
          (survivors.length > 0
            ? `continuam vivos no Windows: PID ${survivors.join(", ")}.`
            : `a arvore caiu mas o PID ${pid} nao foi confirmado morto.`),
      };
    }

    // Reconciliação autoritativa: só publicamos depois de o PID desaparecer.
    //
    // P2 — o Windows é a fonte final, mas os dois sinais discordam:
    // `process.kill(pid, 0)`/OpenProcess responde **vivo** para um processo já
    // TERMINADO enquanto houver handles abertos (Notepad com documento por
    // guardar é o caso clássico). O CIM — que é precisamente o que a lista usa
    // — já não tem o PID, e é esse que manda. Sem isto, o kill gastava o
    // deadline todo e devolvia um falso `still-running`, deixando na UI um
    // processo morto.
    //   · identidade por query-alvo no máximo 1× por `killProbeMinIntervalMs`
    //     (antes eram ~33 PowerShell num kill lento — a latência e a carga);
    //   · só `killProbeConfirmations` ausências **consecutivas** declaram a
    //     morte: uma query que falhou não pode matar um processo vivo.
    let identityQueryAt = 0;
    let cimAbsentStreak = 0;
    const reconciled = await reconcileProcessExit({
      pid,
      originalIdentity,
      // P4: o reap deixa de ter prazo próprio infinito em relação ao resto.
      // Recebe o que resta do orçamento global, mas nunca menos que o piso de
      // ~2 s que `killProbeConfirmations`/`killProbeMinIntervalMs` exigem para
      // confirmar a morte sem fabricar `still-running` falsos.
      deadlineMs: Math.max(
        Math.min(this.killReapDeadlineMs, remaining()),
        Math.min(ProtectionEngineService.KILL_REAP_FLOOR_MS, ProtectionEngineService.KILL_TOTAL_BUDGET_MS),
      ),
      intervalMs: this.killReapIntervalMs,
      probe: async (candidate) => {
        if (!isProcessAlive(candidate)) return { alive: false };
        const now = Date.now();
        if (now - identityQueryAt < this.killProbeMinIntervalMs) return { alive: true };
        identityQueryAt = now;
        // A1: identidade por query-alvo ao PID — nunca enumerar o SO inteiro
        // dentro do caminho do kill.
        //
        // P4: a probe herda o orçamento restante. É a peça que fechou o
        // transbordo: `reconcileProcessExit` (packages/core/src/response.ts)
        // faz `await options.probe(...)` e só DEPOIS verifica o deadline, pelo
        // que uma query sem limite transbordava o prazo do reap em 6 s.
        // `isProcessAlive` acima é síncrono e não consome orçamento.
        const current = await this.lookupProcessByPid(candidate, step(ProtectionEngineService.CIM_QUERY_TIMEOUT_MS));
        if (!current) return { alive: (cimAbsentStreak += 1) < this.killProbeConfirmations };
        cimAbsentStreak = 0;
        return { alive: true, identity: killTargetIdentity(current) };
      },
    });

    if (reconciled.status === "reused") {
      // O PID passou a outro processo: não foi a nossa terminação, mas a
      // entrada em cache é do dono antigo e está errada. P3: retirá-la (SEM
      // tombstone — o PID agora tem um dono vivo) e invalidar a frescura, para
      // que a próxima leitura peça a identidade nova ao Windows.
      this.dropCachedProcess(pid, processInfo, { tombstone: false, invalidateTruth: true });
      return { success: false, status: "reused", pid, exitCode: taskkill.exitCode, error: "PID reutilizado por outro processo; terminação não confirmada." };
    }
    if (reconciled.status === "still-running") {
      // Vivo para o CIM **e** para o OpenProcess: a linha não se mente para
      // baixo. P3 exige cair a janela de frescura — sem isto este desfecho não
      // tocava no cache nem publicava nada e o zombie ficava lá para sempre,
      // porque a Gestor de Tarefas não tem polling próprio.
      this.processesEnumeratedAt = 0;
      this.processesRevision += 1;
      return {
        success: false,
        status: "timeout",
        pid,
        exitCode: taskkill.exitCode,
        stdout: taskkill.stdout,
        stderr: taskkill.stderr,
        error: "Processo ainda ativo depois do taskkill.",
      };
    }

    // PID confirmado desaparecido: reconcilia a lista e publica os eventos.
    // P1: o tombstone barra o morto que uma enumeração iniciada antes do kill
    // traria de volta ao resolver depois dele.
    this.dropCachedProcess(pid, processInfo, { tombstone: true, invalidateTruth: true });
    this.eventBus.publish("process.killed", "critical", `Killed process tree ${pid}`, { pid, name: processInfo?.name });
    this.eventBus.publish("process.exited", "low", `Process exited: ${processInfo?.name ?? pid}`, processInfo ?? { pid });

    // A3: se o que matámos era um stub de App Execution Alias (MSIX) — que
    // morre logo após ativar a app — o processo REAL continua vivo noutro
    // PID. Reporta explicitamente em vez de falso sucesso. Só se aplica a
    // alvos com marcador WindowsApps\...: multi-instância normal não é
    // confundida (o check de mesma-identidade só corre no not-found).
    if (processInfo && isAliasStubTarget(processInfo)) {
      // P4: mesma regra do outro call site — é diagnóstico, e o fallback
      // (`killed`) já é a resposta correcta, por isso encolher é seguro.
      const alias = await this.detectRealInstanceForDeadTarget(
        processInfo,
        pid,
        false,
        step(ProtectionEngineService.KILL_ALIAS_QUERY_TIMEOUT_MS),
      );
      if (alias) {
        return {
          success: false,
          status: "alias-stub",
          pid,
          exitCode: taskkill.exitCode,
          target: { name: processInfo.name, path: processInfo.path },
          error: alias.message,
        };
      }
    }
    return {
      success: true,
      status: "killed",
      pid,
      exitCode: taskkill.exitCode,
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
        // scanId explícito no topo do evento: permite correlacionar progresso,
        // eventos de ameaça e linhas de log do mesmo scan.
        scanId: scanState.id,
        timestamp: new Date().toISOString(),
        sequence: Date.now(),
        severity: "low",
        summary: `Scan ${scanState.status}: ${scanState.filesScanned} files, ${scanState.threatsFound} threats`,
        data: scanState,
      },
    };
    if (this.scanDebugEnabled) {
      console.log(`[ScanService] emitting progress scanId=${scanState.id} status=${scanState.status} progress=${scanState.progress} at=${new Date().toISOString()}`);
    }
    this.broadcast(payload);
  }

  private broadcast(message: unknown) {
    // Nada de broadcasts durante o shutdown: os sockets estão a ser fechados
    // e um write para um socket morto só gera ruído/EPIPE.
    if (this.isShuttingDown) return;
    const payload = encodeMessage(message);
    if (this.scanDebugEnabled && (message as any)?.event?.type === "scan.progress") {
      const ev = (message as any).event;
      console.log(`[PipeServer] sending event type=${ev.type} scanId=${ev.scanId ?? ev.data?.id} at=${new Date().toISOString()}`);
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
        return this.listProcesses();
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
        const id = await this.scanManager.startScan(type, targetPath);
        if (!id) {
          console.warn("[ScanService] start rejected: another scan is already running");
          return { id: "", success: false, error: "Já existe uma análise em curso. Cancele ou aguarde a conclusão." };
        }
        // Correlação: o scanId é propagado para os logs de scan e eventos.
        console.log(`[ScanService] ${formatScanLog(id, `scan.start accepted type=${String(type)} target=${String(targetPath)} at=${new Date().toISOString()}`)}`);
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
