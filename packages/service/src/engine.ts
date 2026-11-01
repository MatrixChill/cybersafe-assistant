import { RpcRequestQueue, INDEPENDENT_READ_METHODS } from './rpc-request-queue.js';
import { createDefinitionsUpdateResult } from "./definition-update-result.js";
import {
  ProtectionIntentStore,
  ProtectionStartup,
  protectionIntentPath,
  parseOptInPayload,
  type EscritaResultado,
} from "./protection-intent.js";
import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { StringDecoder } from "node:string_decoder";

// AUD-002 (review): tectos do lado do socket, além do decoder.
const RPC_MAX_PENDING_PER_CLIENT = 64;
const RPC_MAX_OUTBOUND_BYTES = 2 * 1024 * 1024;
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  VirusTotalClient,
  SafeProcessTermination,
  matchesSnapshotCreation,
  createWindowsTerminationOpener,
  type TerminationIdentity,
  HardwareHealthEngine,
  ClamavBridge,
  CLAMAV_ENGINE_PROCESS_NAMES,
  isTrackedClamavPid,
  DEFAULT_SETTINGS,
  PIPE_NAME,
  SecurityEventBus,
  SignatureDatabase,
  TrustEngine,
  YaraEngine,
  MalwareAnalyzer,
  QuarantineManager,
  decodeMessagesBounded,
  RPC_MAX_FRAME_BYTES,
  RPC_MAX_REST_BYTES,
  RPC_MAX_MESSAGES_PER_CHUNK,
  encodeMessage,
  classifyKillTarget,  isAliasStubTarget,
  isProcessAlive,
  killProcessTree,
  killTargetIdentity,
  KILL_REAP_DEADLINE_MS,
  KILL_REAP_INTERVAL_MS,
  normalizeProcessPath,
  reconcileProcessExit,
  scoreToStatus,
  deriveProtectionStatus,
  decideTaskkillRetry,
  treeChildrenOf,
  KILL_RETRY_DELAY_MS,
  TREE_SWEEP_MAX_DEPTH,
  TREE_SWEEP_MAX_TARGETS,
  ExclusionManager,
  type ExclusionCategory,
  engineIsDegraded,  effectiveRiskScore,
  PcStateEngine,
  disposeTempHelper,
  type ClamavFileOutcome,
  type ClamavJobPriority,
  PIPE_AUTH_VERSION,
  generatePipeNonce,
  isPipeNonce,
  makePipeProof,
  verifyPipeProof,
} from "@cybersafe/core";
import { NativeWindowsWatcher,
  ProcessMonitor,
  snapshotConnections,
  WindowsHealthEngine,
  type FileObservation,
  EtwConsumer,
  WfpFilter,
  AmsiProvider,
  PROCESS_POLL_INTERVAL_MS
} from "@cybersafe/native-windows";
import { NativeEngineBridge } from "./native-engine-bridge.js";
import { RealtimeFileQueue } from "./realtime-file-queue.js";
import { RealtimeRecovery, type SaturationStage } from "./realtime-recovery.js";
import { canAutoQuarantine, loadQuarantinePolicy, saveQuarantinePolicy, type QuarantinePolicy } from "./quarantine-policy.js";
import { hasReparseFreePath, isProtectedQuarantinePath } from "./quarantine-path-policy.js";
import { isTransientFsError, TRANSIENT_SCAN_ERROR_WINDOW_MS } from "./scan-error.js";
import { DefinitionUpdater, agendadorDefinicoesDeveArrancar, recuperacaoYaraPermitida } from "./updater.js";
import { ClamDatabaseGate } from "./clam-database-gate.js";
import { seedClamavDatabase } from "./clamav-seed.js";
import { shouldPublishEngineUnavailable, engineUnavailableKey, ENGINE_UNAVAILABLE_NOTIFY_COOLDOWN_MS } from "./engine-health-notifications.js";
import { resolverCorpusYara } from "./dev-test-yara.js";
import { ScanManager, linhaDeCancelamento } from "./scan-manager.js";
import { ScanHistory } from "./scan-history.js";
import { createServiceLogWriters, shouldPersistEvent, formatScanLog, scanIdFromContext, serviceBaseDir, type LogWriter } from "./log-writer.js";
import { UsbConfigStore, UsbProtectionMonitor } from "./usb-protection.js";
import { UsbReadOnlyScanAdapter, criarConfirmacaoPresencaUsb } from "./usb-scan-adapter.js";
import { criarDeteccaoUsbNativa } from "./usb-detection-adapter.js";
import { UsbProtectionRuntime, caminhoConfigUsb, motivoBloqueioUsbPolicy } from "./usb-protection-runtime.js";
import { formatKillBlockedLine, type KillRequestKind } from "./logging.js";
import type {
  AnalysisResult,
  ConnectionSnapshot,
  EngineHealth,
  HardwareSnapshot,
  KillProcessResult,
  PcState,
  ProcessEnumerationAttempt,
  ProcessEnumerationError,
  ProcessEnumerationTruth,
  ProcessKillResult,
ProcessKillProtectionReason,
  ProcessListResult,
  ProcessSnapshot,
  ProtectionState,
  ProtectionStats,
  QuarantineEntry,
  SecurityEvent,
  ServiceCommandMap,
  ServiceResponseMap,
  ThreatEvent,
  DefinitionsStatus,
  DefinitionsSourceStatus,
  DefinitionsSourceState,
} from "@cybersafe/shared-types";
import { hasDegradedProtections, ENGINE_DISPLAY_NAME, classifyProcessEnumerationError } from "@cybersafe/shared-types";
import { RealtimeLossLedger } from "./realtime-loss.js";
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
  "exclusions.update",
  "scan.start",
  "scan.fullSystem",
  "definitions.update",
  "monitor.start",
  // `monitor.resume` arranca a proteção, tal como `monitor.start`: prolonga o
  // encerramento e não pode passar. `monitor.pause` também não passa — durante
  // a desmontagem o estado da proteção deixa de ser do utilizador.
  "monitor.resume",
  "monitor.pause",
  // Ligar a proteção USB durante o encerramento só criaria trabalho novo
  // (inserções em fila) para um serviço que está a desmontar. Arrancar uma
  // análise MANUAL no shutdown (`usb.scan`) é o mesmo tipo de trabalho novo;
  // `usb.cancel` fica permitido — cancelar reduz, nunca prolonga.
  "usb.configure",
  "usb.scan",
]);

/**
 * Arranque progressivo (TP-PAP-F1-RUNTIME-20261026).
 *
 * O pipe abre depois das guardas (fixture/read-only) e ANTES de `init()`
 * terminar. Durante essa janela só passam leituras cujo valor não depende de
 * init; as restantes leituras esperam pela prontidão (com prazo) e as mutações
 * são recusadas com um erro estável. Isto não é «pipe ligado = proteção
 * pronta»: `getProtectionState()` continua a dizer OFF e o `service-ready` só
 * sai depois de init.
 *
 * As listas são fail-closed: um método novo no dispatch que não esteja aqui
 * fica recusado enquanto o motor arranca, em vez de correr sem guarda.
 */
type StartupState = "legacy" | "starting" | "ready" | "failed" | "disposed";

/** Prazo máximo de espera de uma leitura que precisa de init. */
const STARTUP_READY_WAIT_MS = 10_000;

/**
 * Leituras cuja resposta é honesta sem `init()`: não afirmam saúde, nem
 * histórico/exclusões/intenção que só são carregados no init.
 *
 * `protection.getState` NÃO entra aqui: antes de init `osLayerHealthy` seria
 * uma afirmação sem leitura real. O gate deixa-a esperar, tal como o histórico
 * (`scan.history`), exclusões, intenção de proteção e o estado USB.
 */
const STARTUP_IMMEDIATE_READS = new Set<string>([
  "events.list",
  "threats.list",
  "processes.list",
  "scan.getActive",
]);

/** Leituras que esperam por init (saúde/histórico/exclusões/quarentena). */
const STARTUP_DEFERRED_READS = new Set<string>([
  "protection.getState",
  "connections.list",
  "quarantine.list",
  "scan.getLast",
  "scan.history",
  "exclusions.get",
  "protectionIntent.get",
  "usb.getState",
  "hardware.snapshot",
  "windows.healthSnapshot",
  "pcstate.get",
]);

const SERVICE_STARTING_MESSAGE = "Serviço a arrancar: inicialização em curso; tente de novo em instantes.";
const SERVICE_STARTUP_FAILED_MESSAGE = "Serviço indisponível: a inicialização falhou; reinicie a aplicação.";
const SERVICE_DISPOSED_MESSAGE = "Serviço indisponível: a encerrar.";

/** Erro estável da janela de arranque. O código é local; o pipe leva a mensagem. */
class ServiceStartupError extends Error {
  constructor(
    message: string,
    readonly code: "SERVICE_STARTING" | "SERVICE_STARTUP_FAILED" | "SERVICE_DISPOSED",
  ) {
    super(message);
    this.name = "ServiceStartupError";
  }
}

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

/**
 * Identidade de criação de um processo, tal como o Windows a reporta.
 *
 * O mesmo instante chega em formatos diferentes (`2026-10-02T10:00:00.0000000+00:00`
 * do CIM, ou o número de milissegundos que o monitor já traz). Normalizar aqui é
 * o que permite comparar sem depender de quem chamou.
 */
function normaliseCreationIdentity(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  const ms = Date.parse(value);
  if (Number.isFinite(ms)) return String(ms);
  return value.trim() || null;
}

/**
 * Identidade de criação que serve para AUTORIZAR uma ação destrutiva.
 *
 * Ao contrário de `normaliseCreationIdentity` (que também serve para comparar
 * chaves de cache), aqui uma data em texto livre NÃO é identidade: tem de ser
 * um instante positivo e não futuro. `null` significa "não provado" — e quem
 * chama recusa a ação. É esta a diferença entre um PID e o dono do PID.
 */
function trustedCreationIdentity(value: string | number | undefined | null): string | null {
  const normalised = normaliseCreationIdentity(value);
  if (normalised === null) return null;
  const ms = Number(normalised);
  if (!Number.isFinite(ms) || ms <= 0 || ms > Date.now()) return null;
  return normalised;
}

/** O que sabemos de um PID que lançámos: quando nasceu e quando o registámos. */
interface OwnChildRecord {
  /** Identidade de criação normalizada. `null` = não a conseguimos observar. */
  startedAt: string | null;
  /** Quando o registo foi criado — cache e TTL de descoberta, nunca ownership. */
  registeredAt: number;
}

/**
 * Veredicto de ownership. Só `owned` concede imunidade; só `owned` com as três
 * provas é `owned`.
 *
 *  - `owned`    — identidade confirmada. A EXCEPÇÃO: `unknown` é o que não dá
 *                 imunidade, e `foreign` é a prova de que não é nosso.
 *  - `unknown`  — falta uma prova. Não é "provavelmente nosso": é ausência de
 *                 informação, e é tratada como ausência de autorização.
 *  - `foreign`  — CONTRADIÇÃO observada: o PID pertence a outro processo.
 *  - `absent`   — não há registo nenhum contra o qual este processo se levante.
 *                 É o único estado em que nome/caminho ainda podem falar, e
 *                 mesmo aí são exclusão de scan, nunca autorização de kill.
 */
export type OwnChildVerdictKind = "owned" | "unknown" | "foreign" | "absent";

export interface OwnChildVerdict {
  kind: OwnChildVerdictKind;
  /** Porquê, em português. Entra no diagnóstico quando isto falha. */
  reason: string;
  /** Que relação sustentou o ownership, quando `kind === "owned"`. */
  relation?: "direct" | "descendant";
}

/**
 * TTL DE DESCOBERTA DE DESCENDENTES. NÃO é autoridade de ownership.
 *
 * DECISÃO DO UTILIZADOR (2026-10-03): uma janela temporal NUNCA autoriza kill,
 * NUNCA concede imunidade, NUNCA prova uma relação pai/filho. Tempo **selecciona
 * o que merece a pena validar**; a identidade decide.
 *
 * O nome anterior (`OWN_CHILD_DESCENT_MAX_AGE_MS`) prometia autoridade de
 * segurança e não tinha nenhuma — foi por isso que a janela virava `match` e
 * `match` virava imunidade. O nome agora diz o que é.
 *
 * O único uso que tem: um registo de filho próprio mais velho que este TTL e
 * **ausente** da foto do SO é descartado. É uma política de cache — o que se
 * descarta é sempre um registo, e descartar um registo só pode **tirar**
 * imunidade, nunca dar. A prova (`classifyOwnChild`) é independente da idade:
 * uma relação com mais de cinco minutos continua `owned` se as três provas
 * baterem, e continua `unknown` se não baterem, dentro ou fora da janela.
 *
 * O que NÃO pode acontecer (e era o custo conhecido): sem ela, a cascata do P0
 * volta — o `clamscan` do Chocolatey é um shim que arranca o clamscan
 * verdadeiro, e o filho nasce DEPOIS do pai. Esse custo é hoje absorvido pela
 * identidade do pai observada e pela vaga `poisoned` do motor, não por esta
 * constante.
 */
const DESCENDANT_DISCOVERY_TTL_MS = 5 * 60 * 1000;

/**
 * B2 — JANELA DE UM PID CUJA IDENTIDADE FOI CONTRADITA.
 *
 * O que fecha: `classifyOwnChild` consome a contradição na PRIMEIRA chamada e
 * APAGA o registo. A segunda chamada — a que `shouldScanStartedProcess` faz no
 * handler real — já não tem registo contra o qual se levantar, dá `absent`, e
 * em `absent` o nome de motor + caminho de motor concedem de novo a imunidade.
 * A OWNERSHIP foi negada correctamente; o que voltava era a DEFESA 3, por um
 * caminho que não prova nada.
 *
 * Por isso a negação tem de ter ESTADO, não só um valor de retorno: enquanto a
 * janela viver, este PID é `unknown` no mínimo — nunca `absent`, nunca `owned`
 * por nome/caminho.
 *
 * O que a janela NÃO faz, e é deliberado:
 *  - não autoriza nada. Só RECUSA o atalho fraco.
 *  - não é prova de que o processo é de outro. Isso é `foreign`, e o veredicto
 *    continua a dizer exactamente isso enquanto a identidade observada for a
 *    que foi contradita.
 *
 * Limite: janela + tamanho. Passada a janela (ou quando o serviço reinicia) o
 * estado é perdido — que é o mesmo limite que o resto dos caches de PID tem, e
 * é honesto: sem identidade capturada não há ownership a dar.
 */
const OWN_CHILD_CONTRADICTION_TTL_MS = 5 * 60 * 1000;

/**
 * Tolerância entre a identidade de criação observada de um processo e o
 * instante em que o registámos.
 *
 * Um processo é carimbado pelo kernel ANTES de o vermos, portanto a criação é
 * sempre <= ao registo. Um snapshot cuja identidade de criação é POSTERIOR ao
 * registo não pode ser o mesmo processo — e é a assinatura do placeholder
 * `startedAt = now` que o `ProcessMonitor` usa quando o CIM não devolve
 * CreationDate (packages/native-windows/src/index.ts, fora do nosso scope para
 * corrigir). Sem este filtro, esse placeholder descartaria o registo do nosso
 * próprio motor em cada poll.
 */
const OWN_CHILD_IDENTITY_FUTURE_SLACK_MS = 2_000;

/**
 * Janela (ms) em que um `HardwareSnapshot` já construído pode ser reutilizado.
 *
 * REGRESSÃO P0 MEDIDA (2026-10-10): o handler `hardware.snapshot` devolvia
 * `getLastSnapshot() || await getSnapshot()` e era esse curto-circuito a única
 * via de leitura. O primeiro snapshot é construído ANTES de a leitura do
 * armazenamento (e da GPU e da temperatura) ter chegado — os ticks médio/lento
 * são fire-and-forget — e ficava em cache PARA SEMPRE: nada voltava a chamar
 * `getSnapshot()` quando a proteção estava desligada (o poller de 10 s só vive
 * dentro de `startProtection`). Resultado observado pelo utilizador: Dashboard e
 * PC Center presos em "Ainda sem leitura do armazenamento desde o arranque" /
 * "—" e GPU "Não detetada", enquanto a Saúde do Windows (cache próprio, com
 * TTL) mostrava o C: a 89% e 106,4 GB livres.
 *
 * A cache existe para não repetir trabalho entre chamadas quase simultâneas
 * (renderer a 2 s + tray). Fora dessa janela, o snapshot é RECONSTRUÍDO — o
 * motor de hardware já tem o seu próprio ritmo interno (rápido 1 s, médio 5 s,
 * lento 10 s), portanto reconstruir é barato e é o que garante que uma leitura
 * válida chega ao ecrã em vez de ficar presa na primeira fotografia.
 */
const HARDWARE_SNAPSHOT_REUSE_MS = 1_000;

/** Traduz o codigo de bloqueio para uma causa accionavel. Sem caminhos. */
export function terminationBlockedMessage(code: string): string {
  switch (code) {
    case "session-unauthenticated": return "Sessão não autenticada; nenhuma terminação foi enviada. Volta a iniciar sessão na aplicação.";
    case "service-shutting-down": return "O serviço está a encerrar; nenhuma terminação foi enviada.";
    case "service-not-ready": return "O serviço ainda não terminou o arranque; tenta novamente quando estiver pronto.";
    case "readonly-mode": return "Modo de leitura ativo: a terminação de processos está desativada nesta sessão.";
    case "critical-operation": return "Há uma operação crítica da aplicação em curso; a terminação fica indisponível até terminar.";
    case "realtime-work-in-progress": return "A proteção em tempo real está a analisar ficheiros; aguarda alguns segundos e tenta novamente.";
    case "scan-in-progress": return "Há uma análise em curso; a terminação de processos fica indisponível até terminar.";
    case "definitions-update-in-progress": return "Está a decorrer uma atualização de definições; tenta novamente quando terminar.";
    case "protected-or-identity-unconfirmed": return "O processo é protegido ou a identidade já não corresponde à instância selecionada.";
    default: return "Terminação indisponível: " + code;
  }
}

export class ProtectionEngineService {
  /** Admission can be OFF while a previous module teardown remains unconfirmed. */
  private protectionStopUnconfirmed = false;
  private readonly realtimeQueue = new RealtimeFileQueue();
  private readonly realtimeRecovery = new RealtimeRecovery();
  private quarantinePolicy: QuarantinePolicy = "warn";
  private lastClamavAvailability: boolean | undefined;
  private lastClamavStatus: string | undefined;
  /** Última notificação de indisponibilidade POR MOTIVO (dedupe de flapping). */
  private lastClamavUnavailablePublish: { key: string; at: number } | undefined;
  private fileObservationReads = 0;
  private realtimeDroppedEvents = 0;
  private overflowNoticeAt = -Infinity;
  private coverageNoticeAt = -Infinity;
  /** Única fonte dos números de perda: separa fila de watcher e nunca soma cumulativos. */
  private loss = new RealtimeLossLedger();
  /** Últimos buracos de cobertura reportados pelo filho do watcher (janela limitada). */
  private coverageGaps: { path: string; motivo: string; detectedAt: string }[] = [];
  /**
   * Raiz de dados do serviço. Injetável para que um teste nunca escreva em
   * `%USERPROFILE%\.cybersafe-service`; o default de PRODUÇÃO é exatamente o de
   * sempre, portanto a app não muda de comportamento.
   *
   * Atribuído no constructor (e não como field initializer) porque os fields
   * abaixo derivam dele e, em TypeScript, os field initializers correm ANTES do
   * corpo do constructor — um initializer leria `this.baseDir` como `undefined`.
   */
  private readonly baseDir: string;
  private readonly definitionsDir: string;
  private readonly logsDir: string;
  /** Contador para o `Req=` de correlação (ver `nextKillRequestId`). */
  private killRequestSeq = 0;

  /**
   * Registo duravel de uma recusa de kill, no MESMO formato para as cinco
   * razoes. Nao pode lancer: um `actions.log` que falha de escrever nao pode
   * transformar uma recusa (que e a resposta CORRETA) num erro do pedido.
   */
  private logKillBlocked(
    request: KillRequestKind,
    subject: { pid: number; name?: string; path?: string; ppid?: number },
    reason: ProcessKillProtectionReason,
    requestId: string,
  ): void {
    void fs
      .appendFile(
        path.join(this.logsDir, "actions.log"),
        formatKillBlockedLine({
          timestamp: new Date().toISOString(),
          request,
          requestId,
          subject,
          reason,
        }) + "\n",
        "utf-8",
      )
      .catch(() => {
        // Silencio deliberado: perder uma linha de registo e melhor do que
        // responder ao utilizador com um erro de disco.
      });
  }

  /**
   * Id de correlação para UM pedido de kill. Contador monotónico + PID: dois
   * pedidos para o mesmo alvo em tempos diferentes têm ids diferentes.
   *
   * Isto é o que responde à pergunta "quatro linhas = quatro pedidos ou um
   * pedido registado quatro vezes?": quatro `Req=` distintos são quatro
   * pedidos; o mesmo `Req=` quatro vezes é um pedido escrito quatro vezes.
   *
   * MECANISMO: gerado no serviço, uma vez por chamada de `killProcess`. NÃO
   * vem do renderer. Um id gerado pelo renderer diria também "vieram do mesmo
   * clique?", mas isso obriga a atravessar o IPC (preload -> main -> payload
   * -> tipo do comando) e a mexer no contrato; com um id por chamada, a
   * distinção que interessa já fica legível. Fica registado como dívida.
   */
  private nextKillRequestId(pid: number): string {
    this.killRequestSeq += 1;
    return `k${this.killRequestSeq}-${pid}`;
  }
  private readonly eventBus = new SecurityEventBus({ replayLimit: 500 });
  private readonly signatures = new SignatureDatabase();
  private readonly trust = new TrustEngine();
  private readonly yara = new YaraEngine();
  private readonly clamDatabaseGate = new ClamDatabaseGate();
  /**
   * P1-1 — a bridge adquire uma LEASE sobre a base, não faz um check.
   *
   * A MESMA instância de gate que o updater usa. Duas instâncias seriam duas
   * autoridades independentes a concordar por sorte, que é exactamente como se
   * reintroduz a corrida que este gate fecha.
   *
   * `null` = o gate recusa (update pendente ou activo) e o scan responde
   * `unavailable` sem spawn.
   */
  private readonly clamav: ClamavBridge;
  private readonly analyzer: MalwareAnalyzer;
  private readonly quarantine: QuarantineManager;
  private readonly watcher = new NativeWindowsWatcher();
  private readonly processMonitor = new ProcessMonitor();
  private readonly etwConsumer = new EtwConsumer();
  private readonly wfpFilter = new WfpFilter();
  private readonly amsiProvider = new AmsiProvider();
  private readonly clients = new Set<net.Socket>();
  private readonly authenticatingClients = new Set<net.Socket>();
  /**
   * Nonces de cliente já vistos por esta instância do pipe. A prova assina AMBOS
   * os nonces e o nonce de servidor é novo por ligação, por isso um transcripto
   * gravado de outra ligação não revalida sozinha; reenviar um `clientNonce`
   * já usado é recusado aqui à mesma, porque só pode ser replay ou confusão de
   * estado. Limitado: um pipe não é um arquivo de nonces.
   */
  private readonly seenClientNonces = new Set<string>();
  private static readonly SEEN_NONCES_MAX = 4096;
  private readonly pipeToken = process.env.CYBERSAFE_PIPE_TOKEN;
  private readonly pipeAuthRequired = process.env.NODE_ENV === "production" || process.env.CYBERSAFE_PIPE_TOKEN !== undefined;
  private readonly vt = new VirusTotalClient(process.env.VIRUSTOTAL_API_KEY);
  private readonly hardware = new HardwareHealthEngine((line) => {
    // Opt-in trace is retained by the existing bounded writer; stdout is drained.
    this.actionsLog?.write('[hardware-query] ' + line);
  });
  private readonly windowsHealth = new WindowsHealthEngine();
  private readonly exclusions = new ExclusionManager();
  private readonly pcState = new PcStateEngine();
  /** Histórico persistente de análises (`<baseDir>/scans.jsonl`). */
  private readonly scanHistory: ScanHistory;
  private readonly scanManager: ScanManager;
  /** Adapter real do scan USB: forca `readOnly` no caminho do motor. */
  private readonly usbAdapter: UsbReadOnlyScanAdapter;
  /** Runtime da protecao USB (poll, opt-in, handlers usb.*). */
  private readonly usbRuntime: UsbProtectionRuntime;
  private readonly historyPath: string;
  private readonly updater: DefinitionUpdater;
  private readonly logWriters: ReturnType<typeof createServiceLogWriters>;
  readonly eventsLog: LogWriter;
  readonly actionsLog: LogWriter;
  /** Log verboso de scan desligado por omissão (I/O). */
  private readonly scanDebugEnabled = process.env.CYBERSAFE_DEBUG_BRIDGE === "1";

  /**
   * @param baseDir Raiz de dados do serviço. OMITIR = comportamento de PRODUÇÃO,
   *   resolvido por `serviceBaseDir()` — que é exatamente
   *   `path.join(os.homedir(), ".cybersafe-service")` no regime normal, e só
   *   aponta para outra raiz sob o otim-in EXPLÍCITO de desenvolvimento. Passar
   *   um diretório temporário é o que isola um teste: definições, logs,
   *   histórico e quarantine nascem todos aí.
   *
   * O corpo atribui pela ordem das dependências (baseDir -> derivados -> logs),
   * porque não pode contar com os field initializers.
   */
  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? serviceBaseDir();
    this.definitionsDir = path.join(this.baseDir, "definitions");
    this.clamav = new ClamavBridge({
      definitionsDir: this.definitionsDir,
      fallbackDatabaseDir: async () => {
        const seed = await seedClamavDatabase({ seedDir: process.env.CYBERSAFE_CLAMAV_SEED_DIR, definitionsDir: this.definitionsDir });
        if (seed.status === "invalid") console.warn(`[Service] ${seed.reason}`);
        return seed.status === "readonly-ready" ? seed.databaseDir : null;
      },
      acquireDatabaseLease: (scanId) => {
        const attempt = this.clamDatabaseGate.tryAcquireScanLease();
        if (process.env.CYBERSAFE_DEBUG_SCAN === "1") {
          const gate = this.clamDatabaseGate.state;
          console.log(
            `[ScanPerf] DB_LEASE_GATE_RESULT scanId=${scanId ?? "n/a"} at=${new Date().toISOString()} result=${attempt.ok ? "granted" : "denied"} reason=${attempt.ok ? "none" : attempt.reason} activeScans=${gate.activeScans} updatePending=${gate.updatePending} updateActive=${gate.updateActive} updateWaiters=${gate.updateWaiters}`,
          );
        }
        if (attempt.ok) return attempt.lease;
        // A CAUSA vai com a recusa. Sem ela a bridge anunciava sempre "estão a
        // ser actualizadas", o que é falso quando o serviço está a encerrar:
        // não há actualização a caminho, e esperar não ajuda ninguém.
        return { refused: true, reason: attempt.reason };
      },
    });
    this.analyzer = new MalwareAnalyzer({
      signatures: this.signatures,
      trust: this.trust,
      yara: this.yara,
      clamav: this.clamav,
    });
    this.logsDir = path.join(this.baseDir, "logs");
    this.quarantine = new QuarantineManager(this.baseDir);
    this.historyPath = path.join(this.baseDir, "history.jsonl");
    this.scanHistory = new ScanHistory(path.join(this.baseDir, "scans.jsonl"));
    this.scanManager = new ScanManager(this, this.scanHistory);
    this.protectionStartup = new ProtectionStartup({
      store: new ProtectionIntentStore(protectionIntentPath(this.baseDir)),
      agora: () => Date.now(),
      // O serviço confirma. `true` só quando o motor aceitou E a proteção está
      // de facto ativa — nunca quando o pedido simplesmente regressou.
      iniciar: async () => {
        const resultado = await this.startProtection();
        return resultado.ok === true && this.protectionState === true;
      },
    });

    // ── Protecao USB (R8) ──
    // O adapter FORCA `readOnly: true` no caminho do motor e exige o contrato
    // de read-only (nome+versao) declarado pelo motor. Sem contrato, nao ha
    // auto-scan. O runtime fica criado aqui e arranca em `init()`.
    // UMA porta de deteção partilhada: o monitor enumera para a fila e a
    // identidade, e o adapter volta a enumerar para CONFIRMAR o alvo ANTES de
    // o scan declarar `completed` — as duas leem a mesma fonte, sem duplicar
    // o enumerador nativo.
    const deteccaoUsb = criarDeteccaoUsbNativa();
    this.usbAdapter = new UsbReadOnlyScanAdapter({
      scans: {
        startScan: (type, targetPath, options) => this.scanManager.startScan(type, targetPath, options),
        cancelScan: (id) => this.scanManager.cancelScan(id),
        getScan: (id) => this.scanManager.getScan(id),
      },
      capacidade: () => this.usbReadOnlyCapacidade(),
      confirmarPresenca: criarConfirmacaoPresencaUsb(deteccaoUsb),
    });
    this.usbRuntime = new UsbProtectionRuntime({
      baseDir: this.baseDir,
      monitor: new UsbProtectionMonitor({
        deteccao: deteccaoUsb,
        store: new UsbConfigStore(caminhoConfigUsb(this.baseDir)),
        analise: this.usbAdapter,
        readOnly: this.usbAdapter,
        // Uma analise global (manual) em curso ocupa o unico slot.
        analiseManualAtiva: () => this.scanManager.getActiveScan() !== null,
      }),
      estadoDoScan: (scanId) => this.scanManager.getScan(scanId) ?? null,
      verificarCapacidade: () => this.usbAdapter.verificar(),
      // Análise MANUAL (`usb.scan`): a MESMA porta read-only do auto-scan e a
      // MESMA enumeração nativa. A raiz resolve-se aqui, por enumeração fresca
      // a partir do `deviceId` — nunca vem do renderer.
      analise: this.usbAdapter,
      enumerar: () => deteccaoUsb.listar(),
      slotOcupado: () => this.scanManager.getActiveScan() !== null,
      // TP-GUI02-USB: a MESMA condição do `init()` (logo abaixo) é dita ao runtime
      // na construção, para que `usb.getState` saiba que neste processo a enumeração
      // nunca foi autorizada. É um campo declarado, não uma adivinhação: `null`
      // significa «vai arrancar, deixa-o contar o que viu». Sem isto, o modo de
      // leitura publica para sempre o `starting` de construtor — «a arrancar» —
      // enquanto o PC Center mostra a pen ligada.
      bloqueioPorPolitica: motivoBloqueioUsbPolicy(process.env),
      registar: (mensagem, detalhe) => {
        if (this.scanDebugEnabled) console.log(`[Service] ${mensagem}`, detalhe ?? "");
      },
    });

    this.updater = new DefinitionUpdater(this.definitionsDir, {
      gate: this.clamDatabaseGate,
      // P1-1 (2) — o re-probe é o MESMO nos dois caminhos, porque os dois
      // chamam `checkAndUpdate`. Um `force: true` que só o caminho manual
      // fazia deixava o caminho periódico (o normal, de 6 em 6 horas) a publicar
      // o estado de antes da actualização.
      afterSwap: async () => {
        await this.clamav.isAvailable(true);
      },
      afterYaraUpdated: async () => {
        const rulesPath = path.join(this.definitionsDir, "yara", "default.yar");
        const publishedRules = await fs.readFile(rulesPath, "utf-8");
        await this.yara.load(rulesPath);
        const loadedRules = await fs.readFile(rulesPath, "utf-8");
        if (loadedRules !== publishedRules || !this.yara.isAvailable || this.yara.health.status === "error") {
          throw new Error("YARA reload did not retain the published corpus.");
        }
      },
      afterYaraRollbackFailed: () => {
        this.yara.markUnavailable("YARA desativado: não foi possível repor e recarregar o corpus anterior.");
      },
      afterDefinitionsUpdated: async (result) => {
        if (result.hashesUpdated) {
          await this.signatures.load(path.join(this.definitionsDir, "hashes", "default.json"));
        }
      },
    });
    // O caminho do binário ClamAV é uma exclusão de scan, e é o que fecha a
    // defesa por caminho: o motor nunca analisa o seu próprio motor.
    this.clamav
      .isAvailable()
      .then(() => this.noteClamavBinary(this.clamav.binaryPath))
      .catch(() => undefined);
    this.logWriters = createServiceLogWriters(this.baseDir);
    this.eventsLog = this.logWriters.events;
    this.actionsLog = this.logWriters.actions;
  }

  private server: net.Server | null = null;
  private events: SecurityEvent[] = [];
  private threats: ThreatEvent[] = [];
  private processes: ProcessSnapshot[] = [];
  /** Quando foi a última reconciliação de `processes` com a verdade do SO. */
  private processesEnumeratedAt = 0;
  /**
   * Quando foi tirada a última FOTO bem-sucedida do SO. Distinta de
   * `processesEnumeratedAt`: esse marcador é também a janela de frescura, e o
   * caminho do kill põe-no a 0 para forçar re-enumeração. A idade da informação
   * que se mostra ao utilizador não pode desaparecer com a invalidação — a foto
   * aconteceu, e é isso que `truth.enumeratedAt` afirma.
   */
  private processesPhotoAt = 0;
  /** Reconciliações concorrentes partilham uma única enumeração (nunca duas). */
  private processesEnumerating: Promise<{ rows: ProcessSnapshot[]; servedFrom: "snapshot" | "cache" }> | null = null;
  /**
   * Registo da última TENTATIVA de enumerar o SO — boa ou má. Existe porque o
   * resultado de uma falha não pode ser apagado: sem este registo, `[]` no wire
   * significava «zero processos» quando queria dizer «o Windows não respondeu».
   */
  private processesAttempt: ProcessEnumerationAttempt | null = null;
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
  /** Only births received during the current OS enumeration may overlay it. */
  private processBirthsDuringEnumeration: Map<number, ProcessSnapshot> | null = null;
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
  /**
   * DELTA DE CONGELAMENTO (`f1-kill-disable-20261026`).
   *
   * `true` = o serviço recusa terminar QUALQUER processo, dentro do próprio
   * `killProcess` — e como o dispatch do pipe (`process.killTree`) chama
   * exatamente esse método, a recusa cobre também chamadas IPC diretas.
   *
   * Porque existe: a identidade de criação é provada na revalidação, mas a
   * operação revalidação→taskkill NÃO é atómica (o taskkill é por PID). Onde o
   * freeze não aceitar essa janela residual, este delta desativa a terminação
   * em vez de a fingir segura. O que NÃO desativa: a listagem
   * (`processes.list`), a monitorização e a proteção. A UI deve comunicar
   * indisponibilidade — reconciliação Codex/Qoder; nenhum contrato partilhado
   * é alterado aqui.
   */
  private static readonly KILL_TERMINATION_DISABLED = true;

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
  /** Rate-limit para erros de scan transitórios (evita spam de stack traces). */
  private readonly transientScanLogAt = new Map<string, number>();
  private protectionState = false;
  /**
   * Opt-in de retoma ao arrancar. Deliberadamente separado da proteção viva:
   * o registo em disco é uma preferência, nunca uma observação de que algo está
   * a correr. Ver `ProtectionStartup` e `human-protection-startup.test.js`.
   */
  private readonly protectionStartup: ProtectionStartup;
  private protectionTransition: Promise<{ ok: boolean; protectionEnabled: boolean }> | null = null;
  /**
   * Pausa temporária: até quando a proteção fica desligada, e o timer que a
   * volta a ligar. `null` = não há pausa. O timer é a ÚNICA fonte de
   * reativação automática — o desktop nunca "acorda" a proteção por conta
   * própria, para não haver duas autoridades a competir pelo mesmo estado.
   */
  private protectionPausedUntil: string | null = null;
  private protectionResumeTimer: NodeJS.Timeout | null = null;
  /** Estado explícito de encerramento: para o trabalho novo e o broadcast. */
  private isShuttingDown = false;
  /** Garante que dispose()/shutdown() não correm a desmontagem duas vezes. */
  private disposed = false;
  /** Estado do arranque progressivo. `legacy` = regime antigo, sem gate. */
  private startupStateValue: StartupState = "legacy";
  /** Só o bootstrap real pede o modo progressivo; testes/legado ficam iguais. */
  private progressiveStartRequested = false;
  private readinessPromise: Promise<StartupState> | null = null;
  private resolveReadiness: ((state: StartupState) => void) | null = null;
  private protectionGeneration = 0;
  private backgroundAbort = new AbortController();

  /**
   * O regime de teste não lê nem escreve o registo de intenção: alguns testes
   * correm com a `baseDir` real, e aí a preferência pertence a quem está a usar
   * a máquina. Em runtime decide o serviço — nunca a UI.
   */
  private get intentAtivo(): boolean {
    return process.env.NODE_ENV !== "test";
  }

  /**
   * Estado observável do arranque. `legacy`/`ready` servem tudo; `starting`
   * aplica o gate; `failed`/`disposed` recusam leituras e mutações.
   */
  get startupState(): StartupState {
    return this.startupStateValue;
  }

  /** Prontidão para ações que exigem init (compatível com o contrato antigo). */
  get ready(): boolean {
    return this.startupStateValue === "legacy" || this.startupStateValue === "ready";
  }

  /**
   * Ativa o modo progressivo. Idempotente. Sem esta chamada o motor mantém o
   * comportamento de sempre (servir sem init), que os testes e arranques
   * legados dependem.
   */
  beginProgressiveStart(): void {
    if (this.progressiveStartRequested) return;
    this.progressiveStartRequested = true;
    if (this.startupStateValue === "ready") return;
    this.startupStateValue = "starting";
    this.readinessPromise = new Promise<StartupState>((resolve) => {
      this.resolveReadiness = resolve;
    });
  }

  /** Resolve a prontidão uma única vez; dispose/falha nunca ficam pendurados. */
  private settleStartup(state: StartupState): void {
    if (!this.progressiveStartRequested) return;
    if (this.startupStateValue === "disposed") return;
    this.startupStateValue = state;
    const resolve = this.resolveReadiness;
    this.resolveReadiness = null;
    resolve?.(state);
  }

  /** Espera pela prontidão com prazo; devolve o estado no fim da espera. */
  private async awaitStartup(deadlineMs: number): Promise<StartupState | "timeout"> {
    if (this.startupStateValue !== "starting") return this.startupStateValue;
    const readiness = this.readinessPromise;
    if (!readiness) return this.startupStateValue;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(1, deadlineMs));
      timer.unref?.();
    });
    const outcome = await Promise.race([readiness, timeout]);
    if (timer) clearTimeout(timer);
    return outcome;
  }

  /**
   * Gate do dispatch durante a janela. Leituras seguras passam; leituras que
   * dependem de init esperam (com prazo) e mutações são recusadas. Tudo o que
   * não está nas listas é recusado — fail-closed, não fail-open.
   */
  private async gateMethodDuringStartup(method: string): Promise<void> {
    if (!this.progressiveStartRequested) return;
    const state = this.startupStateValue;
    if (state === "ready" || state === "legacy") return;
    // Encerrar é sempre possível: é a vida do processo, não uma ação no motor.
    if (method === "service.shutdown") return;
    if (state === "starting") {
      if (STARTUP_IMMEDIATE_READS.has(method)) return;
      if (STARTUP_DEFERRED_READS.has(method)) {
        const outcome = await this.awaitStartup(STARTUP_READY_WAIT_MS);
        if (outcome === "ready") return;
        if (outcome === "failed") {
          throw new ServiceStartupError(SERVICE_STARTUP_FAILED_MESSAGE, "SERVICE_STARTUP_FAILED");
        }
        if (outcome === "disposed") {
          throw new ServiceStartupError(SERVICE_DISPOSED_MESSAGE, "SERVICE_DISPOSED");
        }
        throw new ServiceStartupError(SERVICE_STARTING_MESSAGE, "SERVICE_STARTING");
      }
      throw new ServiceStartupError(SERVICE_STARTING_MESSAGE, "SERVICE_STARTING");
    }
    if (state === "failed") {
      throw new ServiceStartupError(SERVICE_STARTUP_FAILED_MESSAGE, "SERVICE_STARTUP_FAILED");
    }
    throw new ServiceStartupError(SERVICE_DISPOSED_MESSAGE, "SERVICE_DISPOSED");
  }

  /**
   * Wrapper de init: a prontidão só é resolvida no fim (sucesso) ou na falha.
   * O corpo antigo vive em `initInternal` para não alterar a ordem interna.
   */
  async init() {
    try {
      await this.initInternal();
      // O dispose pode chegar durante um await do init. Nesse caso o motor já
      // está a encerrar: NUNCA se declara ready nem se deixa o bootstrap enviar
      // `service-ready` sobre um serviço meio-desmontado.
      if (this.disposed) {
        throw new ServiceStartupError(SERVICE_DISPOSED_MESSAGE, "SERVICE_DISPOSED");
      }
      this.settleStartup("ready");
    } catch (error) {
      if (this.startupStateValue !== "disposed") this.settleStartup("failed");
      throw error;
    }
  }

  /** Portão local para efeitos de init que já não podem começar. */
  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new ServiceStartupError(SERVICE_DISPOSED_MESSAGE, "SERVICE_DISPOSED");
    }
  }

  /**
   * O ÚNICO caminho que liga o agendador de definições. `initInternal` chama-o;
   * `startProtection` NÃO. A decisão (test/readonly/fixture) vive no updater
   * (`agendadorDefinicoesDeveArrancar`) para o teste de wiring medir a matriz
   * real sem arrancar rede nem binários.
   */
  private agendarDefinicoesSePermitido(): boolean {
    if (!agendadorDefinicoesDeveArrancar()) return false;
    this.updater.startScheduler();
    return true;
  }

  private async initInternal() {
    this.throwIfDisposed();
    await fs.mkdir(this.baseDir, { recursive: true });
    await this.exclusions.init(path.join(this.baseDir, "exclusions.json"), [path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), path.dirname(process.execPath)]);
    this.quarantinePolicy = await loadQuarantinePolicy(path.join(this.baseDir, "protection-policy.json"));
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
    // Corpus YARA do arranque. Sem `CYBERSAFE_DEV_TEST_YARA_PATH` isto é byte a byte
    // o caminho de sempre e nenhum I/O novo acontece aqui; com a variável, o resolutor
    // exige isolamento + gate montado + corpus validado ANTES do load, e uma config
    // inválida faz o serviço não arrancar (a mesma regra do gate de fixture: falha ⇒ zero
    // sessão) em vez de silenciosamente detetar com um corpus que ninguém reviu.
    const corpusYara = await resolverCorpusYara({
      env: process.env,
      definitionsDir: this.definitionsDir,
      scanManager: this.scanManager,
    });
    if (corpusYara.origem === "dev-test") {
      // Nunca o caminho: só o que foi provado. O registo do serviço é lido por gente externa.
      console.log(`[Service] corpus YARA de TESTE montado: ${corpusYara.motivo}`);
    }
    const yaraT0 = performance.now();
    await this.yara.load(corpusYara.path);
    // Instrumentação sanitizada: só estado e duração, nunca caminhos/regras.
    // Existe para o próximo ensaio na VM conseguir distinguir «motor lento» de
    // «motor indisponível» sem repetir o arranque à adivinha.
    console.log(`[Service] engine-init yaraMs=${Math.round(performance.now() - yaraT0)} coverage=${this.yara.health.coverage}`);
    // Corpus só de teste (EICAR/canário) é o que a interface mostra como
    // DEGRADADO. O scheduler só volta a tentar daqui a 6 horas, por isso um
    // corpus que falhou uma vez ficava horas no estado degradado. Uma única
    // tentativa, no arranque, e só do YARA (nem freshclam, nem hashes, nem
    // proteção). O corpus dev-test é explícito e não se auto-substitui.
    if (
      this.yara.health.coverage === "limited" &&
      corpusYara.origem !== "dev-test" &&
      process.env.NODE_ENV !== "test" &&
      // Guarda de MODO, ao lado da de teste. Read-only e fixture não fazem
      // rede nem escrevem definições: o recovery não chega a ser chamado.
      recuperacaoYaraPermitida()
    ) {
      void this.updater.refreshYaraCorpus().catch(() => undefined);
    }
    // ClamAV (Workstream C): corre o probe UMA vez no arranque — binário +
    // base de assinaturas. Sem isto, protection.getState mostra clamav
    // "Not checked" para sempre mesmo com o clamscan instalado.
    const clamavT0 = performance.now();
    await this.clamav.isAvailable();
    console.log(`[Service] engine-init clamavMs=${Math.round(performance.now() - clamavT0)} status=${this.clamav.health.status}`);

    // ── DEFINIÇÕES NÃO DEPENDEM DA PROTEÇÃO ESTAR LIGADA ─────────────────────
    //
    // CAUSA MEDIDA (TP-RETOMA-01, 2026-10-29): o único `startScheduler()` vivia
    // em `startProtection()`. Com a proteção OFF — o estado por omissão de um
    // serviço acabado de arrancar e a intenção persistida nesta instalação —
    // o freshclam nunca voltava a correr. A base de
    // `~/.cybersafe-service/definitions/clamav` ficou com os ficheiros de
    // 2026-10-18 e, ao fim de 7 dias, o probe classificou o motor `degraded`
    // ("as definições têm 10 dia(s)") apesar de binário, DLLs e base carregarem
    // 3.628.169 assinaturas. O agendador arranca agora com o SERVIÇO.
    //
    // A guarda é a mesma superfície fechada dos modos de leitura/fixture: nesses
    // modos não há rede nem escrita em definições. Em teste o agendador também
    // não nasce — os testes instanciam o motor sem querer I/O de rede.
    this.agendarDefinicoesSePermitido();
    // Motor nativo: EXISTIR O BINÁRIO NÃO É ESTAR UTILIZÁVEL. Um probe real
    // (fixture benigna gerada por nós, 15 s) prova a invocação uma vez no
    // arranque; até lá o estado é `degraded` e não `active`. Fora de teste —
    // o probe spawna o binário e os testes provam-no isoladamente.
    if (NativeEngineBridge.probePermitida()) {
      void NativeEngineBridge.probe().catch(() => undefined);
    }
    // O arranque não comprova uma atualização das definições.

    // Último ponto antes de abrir watchers/listeners: um shutdown durante as
    // leituras caras acima não pode deixar trabalho novo a nascer depois do
    // dispose. O wrapper `init()` volta a verificar no fim para o caso de a
    // corrida acontecer dentro do bloco seguinte.
    this.throwIfDisposed();
    this.bindEventBus();
    this.bindWatchers();
    this.protectionState = false;

    // R8 — protecao USB. So' arranca onde faz sentido (servico real): em teste
    // nao se liga o poll nativo (PowerShell/CIM) nem a prova de read-only — o
    // runtime e' provado isoladamente. `CYBERSAFE_USB_PROTECTION=0` desliga-o.
    //
    // NAO mover nem alargar esta condição sem mexer no outro lado: é a MESMA
    // decisão que `motivoBloqueioUsbPolicy` declara na construção do runtime, e é
    // ela que faz `usb.getState` dizer «indisponível, a enumeração não foi
    // autorizada» em vez de prometer «a arrancar» para sempre. Cortar o poll é o
    // contrato do modo de leitura (`exige_poll_usb_cortado`); continuar a publicar
    // um `starting` transitório por um ramo que nunca arranca é o defeito que a
    // linha de cima criou sem querer — e remover o corte não é a correção.
    this.throwIfDisposed();
    if (process.env.CYBERSAFE_USB_PROTECTION !== "0" && process.env.NODE_ENV !== "test") {
      await this.usbRuntime.iniciar().catch((erro) => {
        console.warn("[Service] Protecao USB indisponivel no arranque:", (erro as Error)?.message ?? erro);
      });
    }

    // A corrida pode ter entrado durante o `iniciar()` acima. Se o USB
    // completou depois do dispose, desmonta o que acabou de nascer antes de
    // recusar; nunca fica um poll a correr num motor encerrado.
    if (this.disposed) {
      await this.usbRuntime.dispose().catch(() => undefined);
      this.throwIfDisposed();
    }
    // ── Retoma ao arrancar ──────────────────────────────────────────────────
    // Opt-in separado, persistido, e lido AQUI. A ausência do registo vale OFF;
    // um registo ilegível vale OFF; só `{desired:"enabled"}` escrito pelo controlo
    // de Definições pode ligar. Ligar a proteção manualmente (`monitor.start`)
    // não escreve nada — não há consentimento inferido de clique.
    if (!this.intentAtivo) {
      // teste: nem ler nem escrever a preferência de um utilizador real
    } else if (process.env.CYBERSAFE_STARTUP_RESUME === "0") {
      console.info("[Service] Retoma ao arrancar desativada por ENV; registo não consultado.");
    } else {
      const resultado = await this.protectionStartup.avaliarAoArrancar();
      console.info(
        `[Service] Retoma ao arrancar: decisao=${resultado.decisao} motivo=${resultado.motivo} iniciada=${resultado.iniciado}`
        + (resultado.falha ? ` falha=${resultado.falha}` : ""),
      );
    }
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
      // ClamAV tem um caminho próprio: a semente é um extraResource (fora do
      // asar) e exige manifesto/hashes; ver `seedClamavDatabase`.
      const subDirs = ["yara", "hashes"] as const;
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

  /**
   * Publica o estado CONFIRMADO da proteção. Evento de BAIXA frequência: só sai
   * quando o motor muda mesmo de estado (arranque, paragem, pausa), nunca num
   * poll. A tray e o renderer usam-no para actualizar sem esperar 5 s — e sem
   * pintar um sucesso que o motor ainda não confirmou.
   */
  private publishProtectionChanged(): void {
    this.eventBus.publish(
      "protection.changed",
      this.protectionState ? "low" : "medium",
      this.protectionPausedUntil
        ? "Proteção em tempo real em pausa"
        : this.protectionState
          ? "Proteção em tempo real ativa"
          : "Proteção em tempo real desativada",
      {
        protectionEnabled: this.protectionState,
        protectionPausedUntil: this.protectionPausedUntil,
      },
    );
  }

  async startProtection(): Promise<ServiceResponseMap["monitor.start"]> {
    if (this.isShuttingDown) return { ok: false, protectionEnabled: false };
    if (this.protectionStopUnconfirmed) return {
      ok: false, protectionEnabled: false,
      failures: [{ label: "shutdown", reason: "O encerramento anterior não foi confirmado. Volte a pedir a desativação antes de ativar a proteção." }],
    };
    if (this.protectionState) {
      return { ok: true, protectionEnabled: true };
    }

    if (this.protectionTransition) {
      return await this.protectionTransition;
    }

    this.protectionTransition = (async () => {
      let started = true;
      // FIX P1-1: `processMonitor.start()` emite `process.started` imediatamente,
      // mas `this.protectionState` só vira `true` mais abaixo (L670). O handler
      // em `handleProcessStart` (L1562) descarta silenciosamente os eventos que
      // chegam enquanto `!protectionState`, e como o ProcessMonitor já integrou
      // o PID no seu `previous`, o processo nunca mais é reemitido — fica
      // permanentemente sem análise. Acumulamos os starts em voo e
      // reanalisá-los após a proteção confirmar; se o arranque falhar,
      // descartamos e removemos o listener (sem leaks).
      const pendingStarts: ProcessSnapshot[] = [];
      const startCapture = (p: ProcessSnapshot) => { pendingStarts.push(p); };
      this.processMonitor.on("process.started", startCapture);
      // Events observed after watcher readiness but before all subsystems start
      // must not disappear when protection is subsequently confirmed.
      const pendingFiles = new Map<string, string>();
      const fileCapture = (event: FileObservation) => {
        if (this.isShuttingDown || this.exclusions.isExcluded(event.path)) return;
        const key = path.resolve(event.path).toLowerCase();
        if (!pendingFiles.has(key) && pendingFiles.size >= 64) { this.reportRealtimeOverflow(event.path); return; }
        pendingFiles.set(key, event.path);
      };
      this.watcher.on("file.created", fileCapture);
      this.watcher.on("file.modified", fileCapture);
      const stopFileCapture = () => {
        this.watcher.off("file.created", fileCapture);
        this.watcher.off("file.modified", fileCapture);
      };


      // P0 GUI-TEST-18/19 + OPCAO A (transferencia titular 15/10, Codex Maestro):
      //  1) a causa de falha deixou de ser engolida — `failures[{label,reason}]`
      //     com motivo SANITIZADO segue pelo monitor.start ate a UI;
      //  2) o WFP NAO E MAIS INICIADO na ativacao: o seu `start()` corre
      //     `New-NetFirewallRule` (operacao privilegiada) e `stop()` removeria a
      //     regra — zero alteracoes do Windows implícitas num clique de protecao.
      //     O filtro de rede fica em DEGRADACAO EXPLICITA e permanente ate haver
      //     provisionamento privilegiado separado, autorizado pelo titular. Essa
      //     degradacao e medida no estado real (`engine.wfp.status = unavailable`)
      //     e publicada em `engine.degradedReasons`; o motivo em linguagem vai no
      //     resultado do arranque, ao lado do ok que continua a ser verdadeiro.
      //  3) watcher/processMonitor/etwConsumer/amsiProvider continuam FATAIS:
      //     qualquer um a falhar => ok:false, teardown de todos, UI mostra a causa.
      const failures: { label: string; reason: string }[] = [];
      const degraded: { label: string; reason: string }[] = [
        {
          label: "wfpFilter",
          // Vai ao ecra (toast da tray + painel de protecao): PT-PT com acentos,
          // e fala SEMPRE do NOSSO modulo, nunca do Firewall do Windows.
          reason: "filtro de rede do CyberSafe não aplicado — a criação da regra de firewall exige provisionamento privilegiado separado; nada foi alterado no Windows por esta ativação",
        },
      ];
      const sanitizeReason = (err: unknown) => {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        return msg.replace(/[A-Za-z]:[\\/](?:Users|users)[\\/][^\\/\s"']+/g, "C:\\Users\\<utilizador>").slice(0, 200);
      };
      for (const [label, action] of [
        ["watcher", () => this.watcher.start()],
        ["processMonitor", () => this.processMonitor.start()],
        ["etwConsumer", () => this.etwConsumer.start()],
        ["amsiProvider", () => this.amsiProvider.start()],
      ] as const) {
        try {
          await action();
        } catch (error) {
          const reason = sanitizeReason(error);
          console.error(`[Service] Failed to start ${label}:`, error);
          started = false;
          failures.push({ label, reason });
        }
      }

      if (this.isShuttingDown) started = false;
      if (!started) {
        stopFileCapture();
        pendingFiles.clear();
        // FIX P1-1: remover o listener temporário antes do teardown (sem leaks,
        // mesmo no caminho de falha).
        this.processMonitor.off("process.started", startCapture);
        // DEADLOCK MEDIDO (P0 REALTIME_TRAY): `stopProtection()` espera pelo
        // `protectionTransition` quando ele existe — e nestes momentos ele É este
        // bloco. `startProtection` -> `stopProtection` -> `await
        // protectionTransition` -> este bloco -> `stopProtection`: um arranque
        // falhado ficava pendurado para SEMPRE, sem erro e sem estado, e a tray
        // nunca chegava a saber que a proteção não subiu. Soltar o transition
        // antes de desmontar quebra o ciclo; a montagem seguinte volta a
        // instalá-lo.
        this.protectionTransition = null;
        // FIX P1-2 (correcao Maestro, 09/10): a ativacao falhada tambem
        // tem de matar a pausa agendada. Sem isto, uma "pausa 15 min"
        // sobrevivia a uma ativacao falhada e o motor voltava a ligar-se
        // sozinho (regressao apanhada por protection-pause-timers.test.js).
        if (this.protectionResumeTimer) {
          clearTimeout(this.protectionResumeTimer);
          this.protectionResumeTimer = null;
        }
        this.protectionPausedUntil = null;
        if (this.networkTimer) {
          clearInterval(this.networkTimer);
          this.networkTimer = null;
        }
        // FIX P1-2: não confiar no atalho de `stopProtection()` (que sai no
        // early-return quando `!protectionState` e deixa os subsistemas que
        // arrancaram com sucesso antes da falha órfãos em background).
        // Teardown forçado direto de todos os subsistemas, com tolerância a
        // falha, e publicar o estado resultante.
        await Promise.allSettled([
          this.watcher.stop(),
          this.processMonitor.stop(),
          this.etwConsumer.stop(),
          this.wfpFilter.stop(),
          this.amsiProvider.stop(),
        ]);
        this.publishProtectionChanged();
        return { ok: false, protectionEnabled: false, failures };
      }

      ++this.protectionGeneration;
      this.backgroundAbort = new AbortController();
      this.protectionState = true;
      stopFileCapture();
      for (const file of pendingFiles.values()) void this.handleFileObservation(file);
      pendingFiles.clear();
      // FIX P1-1: remover o listener temporário ANTES de drenar — evita
      // re-entrância se algum handleProcessStart reativar o monitor.
      this.processMonitor.off("process.started", startCapture);
      // FIX P1-1: reanalisar os processos que nasceram enquanto a proteção
      // estava em transição. Cada um passa pela mesma guarda de
      // `shouldScanStartedProcess` que os starts diretos, portanto não há
      // duplo-scan: um PID já analisado em voo é idempotente.
      for (const p of pendingStarts) {
        void this.handleProcessStart(p);
      }
      // P0 REALTIME_TRAY: uma proteção LIGADA não pode trazer consigo uma pausa.
      //
      // MEDIDO: "Pausar 15 minutos" seguido de "Ativar proteção agora" (o botão
      // da tray chama `monitor.start`) arrancava o watcher, mas deixava
      // `protectionPausedUntil` no passado e o `protectionResumeTimer` VIVO. A
      // tray continuava a mostrar pausa/desativado com a proteção a correr, e o
      // timer antigo podia depois disparar sobre um estado que já não era dele.
      // Todos os caminhos que ligam a proteção — o fim da pausa, `monitor.start`
      // da tray, `monitor.resume` — passam por aqui, e é aqui que a pausa morre.
      if (this.protectionResumeTimer) {
        clearTimeout(this.protectionResumeTimer);
        this.protectionResumeTimer = null;
      }
      this.protectionPausedUntil = null;
      // O agendador de definições pertence ao SERVIÇO, não à proteção. Ligar a
      // proteção não o volta a arrancar (e não contorna a guarda readonly).

      Promise.all([
        this.processMonitor.list().then((p) => {
          const revisionBefore = this.processesRevision;
          this.processes = this.withoutTombstoned(p);
          // O restart da proteção pode apanhar um kill em curso: vale a mesma
          // regra de `listProcesses()` — só se re-arma o TTL se nada mudou
          // entretanto, e um PID morto confirmado não volta por aqui.
          if (revisionBefore === this.processesRevision) this.processesEnumeratedAt = Date.now();
          else this.processesEnumeratedAt = 0;
          return this.readHardwareSnapshot();
        }),
        this.refreshConnections(),
      ]).catch((err) => console.error("[Service] Initial background snapshots failed:", err));

      if (!this.networkTimer) {
        this.networkTimer = setInterval(() => {
          if (this.networkInFlight) return;
          this.networkInFlight = true;
          Promise.allSettled([
            this.refreshConnections(),
            this.readHardwareSnapshot(),
          ]).finally(() => {
            this.networkInFlight = false;
          });
        }, 10_000);
      }

      this.publishProtectionChanged();
      return { ok: true, protectionEnabled: true, degraded };
    })();

    try {
      const result = await this.protectionTransition;
      return result;
    } finally {
      this.protectionTransition = null;
    }
  }

  async stopProtection(): Promise<ServiceResponseMap["monitor.stop"]> {
    ++this.protectionGeneration;
    this.realtimeQueue.clear();
    this.realtimeRecovery.clear();
    // A contagem de perda é por sessão de proteção: sem ela, um número de
    // ontem é apresentado como se fosse do estado atual.
    this.loss.reset();
    this.realtimeDroppedEvents = 0;
    this.backgroundAbort.abort();
    // O atalho "já está tudo parado" só vale se não houver NADA a parar — e um
    // timer de retomada agendado é precisamente algo a parar. Sem esta cláusula
    // o bypass era um buraco: "pausar 15 min" num motor que já estava parado
    // agendava a retomada, e o "desligar" seguinte devolvia por aqui sem
    // cancelar o timer. MEDIDO: timer VIVO depois de `stopProtection()`.
    if (
      !this.protectionState &&
      !this.protectionStopUnconfirmed &&
      !this.networkTimer &&
      !this.protectionTransition &&
      !this.protectionResumeTimer
    ) {
      return { ok: true, protectionEnabled: false };
    }

    if (this.protectionTransition) {
      await this.protectionTransition.catch(() => undefined);
    }

    this.protectionState = false;
    ++this.protectionGeneration;
    this.backgroundAbort.abort(); // Also invalidate a start that was in flight.
    // O agendador de definições NÃO morre com a proteção: assinaturas frescas
    // são uma condição do motor, não um efeito de a vigilância estar ligada.
    // Fechá-lo aqui reproduzia a causa medida do ClamAV degradado (o scheduler
    // só existia enquanto `startProtection` corria). O `dispose()` do serviço
    // continua a ser quem para o timer (`stopScheduler`).

    // Uma paragem manual cancela qualquer retomada agendada. Sem isto, "Pausar
    // 15 min" seguido de "Desligar" deixava o timer vivo e a proteção voltava
    // sozinha aos 15 minutos — o utilizador desligou-a e ela ignorou-o.
    // Quem manda parar é o utilizador: parar tem de ser definitivo.
    if (this.protectionResumeTimer) {
      clearTimeout(this.protectionResumeTimer);
      this.protectionResumeTimer = null;
      this.protectionPausedUntil = null;
    }

    if (this.networkTimer) {
      clearInterval(this.networkTimer);
      this.networkTimer = null;
    }

    const actions = [
      ["watcher", () => this.watcher.stop()],
      ["processMonitor", () => this.processMonitor.stop()],
      ["etwConsumer", () => this.etwConsumer.stop()],
      ["wfpFilter", () => this.wfpFilter.stop()],
      ["amsiProvider", () => this.amsiProvider.stop()],
    ] as const;
    const stopped = await Promise.allSettled(actions.map(async ([label, stop]) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(stop),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: stop não confirmado no prazo`)), 800); }),
        ]);
      } finally { clearTimeout(timer); }
    }));
    this.protectionStopUnconfirmed = stopped.some(result => result.status === "rejected");
    if (this.protectionStopUnconfirmed) this.eventBus.publish(
      "engine.health", "high",
      "A admissão de análises foi desativada, mas o encerramento de um ou mais módulos não foi confirmado.",
      { reason: "protection-stop-unconfirmed", modules: actions.filter((_, i) => stopped[i].status === "rejected").map(([label]) => label) },
    );

    this.publishProtectionChanged();
    return { ok: !this.protectionStopUnconfirmed, protectionEnabled: false };
  }

  /**
   * Pausa a proteção por um período limitado, com reativação AUTOMÁTICA.
   *
   * `durationMs` undefined/`Infinity` = pausa até ativação manual (não expira).
   * Qualquer outro valor agenda o regresso. A reativação corre no motor, não no
   * renderer: se o Electroncrashar ou fechar, a proteção volta na mesma.
   *
   * Uma pausa que termina é um Window em que a máquina NÃO está protegida. Por
   * isso o estado exposto passa a `critical` enquanto decorre — nunca "safe".
   */
  async pauseProtection(durationMs?: number): Promise<{ ok: boolean; protectionEnabled: boolean; pausedUntil: string | null }> {
    const result = await this.stopProtection();
    if (!result.ok) return { ...result, pausedUntil: null };

    if (this.protectionResumeTimer) {
      clearTimeout(this.protectionResumeTimer);
      this.protectionResumeTimer = null;
    }

    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) {
      this.protectionPausedUntil = null; // até ativação manual
      this.publishProtectionChanged();
      return { ...result, pausedUntil: null };
    }

    const until = new Date(Date.now() + durationMs).toISOString();
    this.protectionPausedUntil = until;
    this.protectionResumeTimer = setTimeout(() => {
      this.protectionResumeTimer = null;
      this.protectionPausedUntil = null;
      void this.startProtection().catch((err) =>
        console.error("[Service] Falha ao reativar proteção após pausa:", err),
      );
    }, durationMs);
    // Não segura o processo aberto só por causa de uma pausa agendada.
    this.protectionResumeTimer.unref?.();
    this.publishProtectionChanged();
    return { ...result, pausedUntil: until };
  }

  /** Cancela qualquer pausa agendada e reativa já. */
  async resumeProtection(): Promise<{ ok: boolean; protectionEnabled: boolean; pausedUntil: string | null }> {
    if (this.protectionResumeTimer) {
      clearTimeout(this.protectionResumeTimer);
      this.protectionResumeTimer = null;
    }
    this.protectionPausedUntil = null;
    const result = await this.startProtection();
    return { ...result, pausedUntil: null };
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
  /**
   * AbortControllers por scan, para que cancelar um scan mate o motor que ele
   * estiver a usar — em vez de o deixar a terminar sozinho (~1 GB de RAM por
   * perto de 6 s, por processo).
   */
  private readonly scanAbortControllers = new Map<string, AbortController>();
  /**
   * INTENÇÃO de abortar um scan, guardada pelo ScanManager (`cancelScan`)
   * antes de o controller do motor existir. O `signalForScan` lê-a quando
   * criar o controller, para o signal nascer já abortado.
   *
   * Limpa-se em `releaseScanAbort` (chamado no `finally` do scan) — sem
   * isto, um scanId cancelado e nunca usado ficava na Set para sempre.
   */
  private readonly scanAbortIntents = new Set<string>();

  /** Controller do scan pedido (cria se ainda não existir). */
  private signalForScan(scanId: string | undefined): AbortSignal | undefined {
    if (!scanId) return undefined;
    let controller = this.scanAbortControllers.get(scanId);
    if (!controller) {
      controller = new AbortController();
      // P1 — ABORT STICKY: um cancel que chegue antes de este controller
      // existir (janela de looksLikeZip) deixa a intenção guardada em
      // `scanAbortIntents`. Quando o motor criar o controller, nasce JÁ
      // abortado — o signal never reports a live signal to a cancelled scan.
      //
      // MEDIDO (scan-cancel-prefetch-window.test.js): sem isto, o
      // prefetchClamav criava o controller no interior do engine e o signal
      // era vivo mesmo com o scan já cancelado, porque abortEngineWork só
      // abortava um controller que ainda não existia.
      if (this.scanAbortIntents.has(scanId)) {
        controller.abort();
      }
      this.scanAbortControllers.set(scanId, controller);
    }
    return controller.signal;
  }

  /**
   * Marca a INTENÇÃO de abortar um scan. Chamado pelo ScanManager
   * (`cancelScan`) ANTE de o controller do motor existir.
   *
   * A intenção sobrevive até o controller nascer (signalForScan) ou até
   * `releaseScanAbort` limpar — o que vier primeiro. Sem isto, um cancel na
   * janela de looksLikeZip era silencioso: o controller nascia depois, vivo.
   */
  public markScanAborted(scanId: string): void {
    this.scanAbortIntents.add(scanId);
    this.scanAbortControllers.get(scanId)?.abort();
  }

  /**
   * Aborta o trabalho de motores de um scan. Chamado pelo `cancelScan`.
   *
   * Não apaga logo o controller: o `scanFile` ainda pode estar a ler o signal
   * enquanto corre, e um controller já descartado perderia o abort.
   */
  abortEngineWork(scanId: string): void {
    this.markScanAborted(scanId);
  }

  /** Libertação explícita da intenção e do controller de um scan terminado. */
  public releaseScanAbort(scanId: string | undefined): void {
    if (scanId) {
      this.scanAbortIntents.delete(scanId);
      this.scanAbortControllers.delete(scanId);
    }
  }

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

  /**
   * Directórios onde vive um motor de scan. Só para exclusão de scan — nunca
   * para matar nem para confiar: são paths, não autorização.
   *
   * Preenchido em runtime a partir do próprio binário clamado (ver
   * `noteClamavBinary`), porque a localização varia com a instalação
   * (Chocolatey, Program Files, winget...). Só se acrescenta o que foi
   * realmente visto — nunca um prefixo amplo que apanhasse o utilizador.
   */
  private static readonly scanEngineDirs = new Set<string>([
    // SEMENTE: so o layout de instalacao mais comum. O caminho REAL, onde o
    // clamscan esta de facto, e acrescentado depois pelo probe.
    // Sem semente, a exclusão por path só começaria depois do probe assíncrono,
    // e havia uma janela em que o motor ainda se auto-analisava.
    "C:\\Program Files\\ClamAV",
    "C:\\Program Files (x86)\\ClamAV",
    "C:\\ProgramData\\ClamAV",
    "C:\\ProgramData\\chocolatey\\lib\\clamav",
    "/usr/local/clamav",
    "/usr/share/clamav",
    "/var/lib/clamav",
  ]);
  private static readonly MAX_OWN_CHILD_PIDS = 1024;

  /**
   * Janela de PIDs de filhos próprios (ver `registerOwnChild`).
   *
   * P1-6 (Codex): o valor NÃO é um timestamp de registo, é a IDENTIDADE DE
   * CRIAÇÃO com que o processo nasceu. Um `Map<pid, Date.now()>` prova ownership
   * para sempre, e o Windows reutiliza PIDs dentro da mesma sessão: o processo
   * externo que herda o número herdava também a imunidade de análise e de
   * auto-kill. A identidade de criação é o que denuncia a troca.
   */
  private readonly ownChildPids = new Map<number, OwnChildRecord>();
  /**
   * B2 — PIDs cuja identidade de criação foi CONTRADITA (ver `classifyOwnChild`).
   *
   * `identity` é a identidade OBSERVADA no momento da contradição. Enquanto o
   * PID continuar a mostrar essa mesma identidade, o veredicto é `foreign` e
   * nada lhe devolve imunidade por nome/caminho. Se o PID passar a mostrar
   * OUTRA identidade, o Windows reciclou o número outra vez: a contradição
   * antiga já não descreve ESTE processo e é descartada — reter a negação seria
   * negar um processo que ainda não foi visto.
   */
  private ownChildContradictions = new Map<number, { identity: string | null; expiresAt: number }>();

  /** Regista o directório do binário ClamAV como motor de scan. */
  noteClamavBinary(binaryPath: string | null | undefined): void {
    if (!binaryPath) return;
    const dir = path.dirname(binaryPath);
    // Só directorios que REIDEM ser o ClamAV. Um path typo não pode broad-brush
    // a exclusão e apanhar programas do utilizador.
    if (!dir.toLowerCase().includes("clam")) return;
    ProtectionEngineService.scanEngineDirs.add(dir);
  }

  static get SCAN_ENGINE_DIRS(): ReadonlySet<string> {
    return ProtectionEngineService.scanEngineDirs;
  }

  private isSafeProcess(name: string): boolean {
    // Lista de CONFIANÇA. Deliberadamente NÃO inclui os nomes do ClamAV.
    //
    // Estavam lá até revisão de 2026-10-02, e era um erro: `handleProcessStart`
    // faz `return` imediato para um processo "safe", o que dá a qualquer
    // `clamscan.exe` imunidade de análise e de auto-kill. Dar-se a si próprio o
    // nome de uma ferramenta de segurança é evasão trivial. A imunidade do
    // motor de scan passa agora por identidade de processo (ver
    // `shouldScanStartedProcess`), que não se pode falsificar.
    return ProtectionEngineService.SAFE_PROCESSES.has(name.toLowerCase());
  }

  /**
   * DEFESA 2 — exclusão por CAMINHO do binário do motor.
   *
   * A lista de nomes só cobre o caso comum: o binário pode ter outro nome, e
   * qualquer outro motor que o serviço lance tem o mesmo problema. O caminho
   * identifica o motor independentemente do nome.
   *
   * Nunca deve excluir um programa do utilizador: só directorios de motores de
   * scan, onde vivem clamscan/clamd/freshclam.
   */
  shouldScanProcessPath(filePath: string): boolean {
    if (!filePath) return false;
    const lower = filePath.toLowerCase();
    if (!lower.includes("clam")) return true;
    for (const dir of ProtectionEngineService.SCAN_ENGINE_DIRS) {
      // Fronteira de directório, não `startsWith`: `C:\Program Files\ClamAV-tools`
      // NÃO está dentro de `C:\Program Files\ClamAV`. Com `startsWith` simples,
      // qualquer directório queasse por nome à frente do motor da imunidade —
      // e a imunidade também é uma porta de entrada para o auto-kill.
      const d = dir.toLowerCase();
      if (lower === d) return false;
      if (lower.startsWith(d.endsWith(path.sep) ? d : d + path.sep)) return false;
    }
    return true;
  }

  /**
   * DEFESA 3 — PIDs de processos que o SERVIÇO lançou.
   *
   * É a defesa que sobrevive a qualquer motor futuro: não depende do nome, da
   * directoria, nem de alguém se lembrar de actualizar uma lista. Se o serviço
   * lançou o processo, o monitor não o volta a analisar.
   *
   * Janela limitada de propósito: um poll a cada 2 s com processos novos não
   * pode tornar-se um leak de memória num serviço de vida longa.
   */
  registerOwnChild(pid: number, startedAt?: string): void {
    if (!Number.isFinite(pid) || pid <= 0) return;
    // B2 — a contradição só se desfaz com uma IDENTIDADE COMPROVADA nova.
    // Este é o único sítio do código que a pode desfazer: registar um PID é
    // afirmar que nós o lançámos, e o `startedAt` é a identidade de criação que
    // foi capturada desse lançamento. Nome e caminho nunca chegam aqui.
    const identity = normaliseCreationIdentity(startedAt);
    if (identity) this.ownChildContradictions.delete(pid);
    if (this.ownChildPids.size >= ProtectionEngineService.MAX_OWN_CHILD_PIDS) {
      const oldest = this.ownChildPids.keys().next();
      if (!oldest.done) this.ownChildPids.delete(oldest.value);
    }
    this.ownChildPids.set(pid, { startedAt: normaliseCreationIdentity(startedAt), registeredAt: Date.now() });
  }

  releaseOwnChild(pid: number): void {
    this.ownChildPids.delete(pid);
  }

  /**
   * Este PID tem um registo? Pergunta de EXISTÊNCIA, nunca de autorização.
   *
   * Serve para escolher o que merece ser validado. Chamar-lhe "ownership" era
   * o defeito: `if (!startedAt) return true` respondia `true` a uma consulta
   * por presença, e o `shouldScanStartedProcess` tratava esse `true` como
   * imunidade. Hoje o veredicto é `classifyOwnChild`, e esta função existe
   * apenas para não repetir o `Map.get` em dois sítios.
   */
  hasOwnChildRecord(pid: number): boolean {
    return Number.isFinite(pid) && pid > 0 && this.ownChildPids.has(pid);
  }

  /**
   * Este PID é NOSSO, com identidade confirmada dos dois lados?
   *
   * `startedAt` do processo actual tem de bater com a identidade com que foi
   * registado. Sem `startedAt` não há prova de identidade — e um PID sozinho é a
   * mesma coisa que não ter ownership, por isso a resposta é `false`, nunca
   * `true`. Se não bater, o PID foi REUTILIZADO: o registo antigo é descartado
   * (a partir de agora o número pertence a outro processo) e o novo é tratado
   * como externo.
   */
  isOwnChildPid(pid: number, startedAt?: string): boolean {
    return this.classifyOwnChild({ pid, startedAt }).kind === "owned";
  }

  /**
   * A identidade de criação OBSERVADA de um PID, tal como o SO a reportou.
   *
   * Vem do snapshot de processos, que é a única observação que o serviço tem
   * sem fazer uma leitura síncrona do SO no caminho de decisão. `null` = não
   * temos observação: o que é falta de informação, e falta de informação dá
   * `unknown`.
   */
  private observedCreationIdentity(pid: number): string | null {
    const entry = this.processes.find((p) => p.pid === pid);
    if (!entry) return null;
    return normaliseCreationIdentity(entry.startedAt);
  }

  /**
   * Veredicto de ownership com as três provas (A3/A4/A6).
   *
   * DECISÃO DO UTILIZADOR (2026-10-03): tempo, nome, path e PID **sozinhos nunca
   * concedem ownership**. São precisos:
   *
   *  - **Directo**: o PID foi registado por nós E a identidade de criação
   *    observada agora é igual à identidade capturada no registo.
   *  - **Descendente**: (1) o pai foi registado por nós com identidade
   *    capturada, (2) a identidade OBSERVADA do próprio pai bate com essa
   *    captura — o `startedAt` do FILHO nunca entra aqui, era esse o bug — e
   *    (3) a relação pai/filho foi observada e a identidade do descendente é
   *    legível e posterior à do pai.
   *
   * `unknown` é o resultado honesto sempre que falta uma prova. E `unknown`
   * **não concede imunidade nem autoriza kill**: é `shouldScanStartedProcess` que
   * o traduz em "analisar", e é o caminho de kill que o trata como
   * indeterminate.
   *
   * `absent` é o único caso em que o nome/caminho ainda pode falar: não há
   * registo nenhum contra o qual este processo se levante.
   */
  classifyOwnChild(processInfo: { pid: number; ppid?: number; startedAt?: string }): OwnChildVerdict {
    const pid = processInfo.pid;
    if (!Number.isFinite(pid) || pid <= 0) {
      return { kind: "unknown", reason: `PID inválido: ${pid}` };
    }
    const ownIdentity = normaliseCreationIdentity(processInfo.startedAt);

    // ── B2: uma contradição anterior ainda é contradição ───────────────────
    //
    // Ver o comentário de `ownChildContradictions`. Sem esta porta, o segundo
    // `classifyOwnChild` do mesmo `process.started` não encontrava registo (a
    // contradição apagou-o), daria `absent`, e a DEFESA 3 — nome de motor +
    // caminho de motor — devolveria a imunidade a um PID cuja identidade já
    // tinha sido provadamente contradita.
    if (this.contradictionHolds(pid, ownIdentity)) {
      return {
        kind: "foreign",
        reason: `a identidade do PID ${pid} já foi contraditada: nenhum nome ou caminho the devolve ownership`,
      };
    }

    // ── Directo ────────────────────────────────────────────────────────────
    const record = this.ownChildPids.get(pid);
    if (record) {
      if (!ownIdentity) {
        return {
          kind: "unknown",
          reason: `o PID ${pid} tem registo nosso mas a identidade de criação do processo actual não foi observada`,
        };
      }
      if (!record.startedAt) {
        return { kind: "unknown", reason: `o registo do PID ${pid} não tem identidade de criação capturada` };
      }
      if (record.startedAt !== ownIdentity) {
        this.ownChildPids.delete(pid);
        this.rememberContradiction(pid, ownIdentity);
        return { kind: "foreign", reason: `o PID ${pid} foi reutilizado por outro processo` };
      }
      return { kind: "owned", relation: "direct", reason: `PID ${pid} é a instância que lançámos` };
    }

    // ── Descendência ────────────────────────────────────────────────────────
    const parentPid = processInfo.ppid;
    if (!Number.isInteger(parentPid) || (parentPid as number) <= 0) {
      return { kind: "absent", reason: `não há registo do PID ${pid} nem pai conhecido` };
    }
    const parentRecord = this.ownChildPids.get(parentPid as number);
    if (!parentRecord) {
      // B2 — o PAI é que está sob contradição, não este PID. Sem esta linha o
      // descendente caía em `absent` pelo mesmo atalho que o B2 fecha no
      // próprio PID: a DEFESA 3 (nome + caminho de motor) concedia imunidade a
      // um filho de um pai cuja identidade tinha sido provadamente contradita.
      //
      // A identidade do PAI é observada de propósito: é ela que decide se a
      // contradição ainda descreve o processo actual. Sem observação
      // (`null`), a dúvida mantém-se — ausência de informação não resolve nada.
      const observedParentNow = this.observedCreationIdentity(parentPid as number);
      if (this.contradictionHolds(parentPid as number, observedParentNow)) {
        return {
          kind: "unknown",
          reason:
            `a identidade do pai ${parentPid} já foi contraditada: ` +
            `nenhum nome ou caminho do filho the dá ownership`,
        };
      }
      return { kind: "absent", reason: `o pai ${parentPid} não é um PID nosso` };
    }
    // Prova 1 — o pai foi registado com identidade capturada.
    if (!parentRecord.startedAt) {
      return { kind: "unknown", reason: `o pai ${parentPid} foi registado sem identidade de criação` };
    }
    // Prova 2 — a identidade OBSERVADA do próprio pai. É aqui que entrava a
    // identidade do filho, e era por isso que uma data diferente do pai apagava
    // ownership legítimo e uma data ausente aceite o PPID sozinho.
    const observedParent = this.observedCreationIdentity(parentPid as number);
    if (!observedParent) {
      return { kind: "unknown", reason: `a identidade de criação do pai ${parentPid} não está observada` };
    }
    if (observedParent !== parentRecord.startedAt) {
      this.ownChildPids.delete(parentPid as number);
      this.rememberContradiction(parentPid as number, observedParent);
      return { kind: "foreign", reason: `o PID do pai ${parentPid} pertence a outro processo` };
    }
    // Prova 3 — relação observada (o `ppid` que o SO reportou) e identidade do
    // descendente legível e posterior à do pai.
    if (!ownIdentity) {
      return { kind: "unknown", reason: `o descendente do PID ${parentPid} não tem identidade de criação observada` };
    }
    const childMs = Date.parse(String(processInfo.startedAt));
    const parentMs = Number(parentRecord.startedAt);
    if (Number.isFinite(childMs) && Number.isFinite(parentMs) && parentMs > childMs) {
      this.rememberContradiction(pid, ownIdentity);
      return {
        kind: "foreign",
        reason: `o PID ${pid} nasceu antes do seu pai ${parentPid}: o número já era de outro processo`,
      };
    }
    return { kind: "owned", relation: "descendant", reason: `descendente verificado do PID ${parentPid}` };
  }

  /**
   * B2 — regista que a identidade deste PID foi contradita.
   *
   * Só RECUSA. Não concede, não autoriza, não prova que o processo é de outro:
   * o que faz é impedir que a contradição se perca entre duas chamadas e o
   * atalho por nome/caminho volte a valer. É estado, porque o defeito era
   * exactamente um estado que não existia.
   *
   * Teto de tamanho: um poll a cada 10 s com processos novos não pode ser um
   * leak num serviço de vida longa.
   */
  private rememberContradiction(pid: number, identity: string | null): void {
    if (!Number.isFinite(pid) || pid <= 0) return;
    if (
      this.ownChildContradictions.size >= ProtectionEngineService.MAX_OWN_CHILD_PIDS &&
      !this.ownChildContradictions.has(pid)
    ) {
      const oldest = this.ownChildContradictions.keys().next();
      if (!oldest.done) this.ownChildContradictions.delete(oldest.value);
    }
    this.ownChildContradictions.set(pid, {
      identity,
      expiresAt: Date.now() + OWN_CHILD_CONTRADICTION_TTL_MS,
    });
  }

  /**
   * B2 — a negação ainda vale para ESTA identidade?
   *
   * Três casos, e só um é subtil:
   *  - expirou → a janela passou: `false`. É uma janela, não um estado eterno.
   *  - a identidade observada é a MESMA que foi contradita → `true`. É o caso
   *    que a DEFESA 3 explorava.
   *  - a identidade observada é OUTRA → o Windows reciclou o número outra vez e
   *    a contradição já não descreve este processo: `false`, e a contradição é
   *    descartada. Negar aqui seria negar um processo que ainda não foi visto —
   *    o mesmo erro de "ausência de informação prova ownership", ao contrário.
   *  - identidade observada AUSENTE → a contradição não se pode comparar, e
   *    logo não se pode descartar: `true`. Ausência de informação mantém a
   *    dúvida; nunca a resolve.
   */
  private contradictionHolds(pid: number, observedIdentity: string | null): boolean {
    const entry = this.ownChildContradictions.get(pid);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      this.ownChildContradictions.delete(pid);
      return false;
    }
    if (observedIdentity && entry.identity && observedIdentity !== entry.identity) {
      this.ownChildContradictions.delete(pid);
      return false;
    }
    return true;
  }

  /**
   * Reconciliação com um snapshot do SO.
   *
   * O caso que o `process.exited` não apanha: o processo morreu entre dois
   * polls, ou o poll falhou, e nunca houve evento de saída. Sem isto, o PID
   * ficava imune para sempre. Um PID ausente do snapshot NÃO é prova de morte —
   * um poll é uma fotografia — por isso só se descarta o que o snapshot
   * contradiz, e o que fica fora do TTL de descoberta (política de cache, ver
   * `DESCENDANT_DISCOVERY_TTL_MS`).
   *
   * Devolve quantos registos foram descartados.
   */
  reconcileOwnChildren(
    snapshot: ReadonlyArray<{ pid: number; startedAt?: string }>,
    nowMs = Date.now(),
  ): number {
    if (snapshot.length === 0) return 0;
    let discarded = 0;
    const seen = new Set<number>();
    for (const entry of snapshot) {
      if (!Number.isFinite(entry?.pid) || entry.pid <= 0) continue;
      seen.add(entry.pid);
      const record = this.ownChildPids.get(entry.pid);
      if (!record) continue;
      const incoming = normaliseCreationIdentity(entry.startedAt);
      // Snapshot sem identidade de criação: não prova nada, não descarta.
      if (!record.startedAt || !incoming) continue;
      // Uma criação POSTERIOR ao registo não pode ser a mesma instância: ou o
      // PID foi reutilizado, ou a identidade veio do placeholder do poll.
      const incomingMs = Number(incoming);
      if (Number.isFinite(incomingMs) && incomingMs > record.registeredAt + OWN_CHILD_IDENTITY_FUTURE_SLACK_MS) {
        continue;
      }
      if (record.startedAt !== incoming) {
        this.ownChildPids.delete(entry.pid);
        discarded++;
      }
    }
    // Política de cache: um registo mais velho que o TTL de descoberta e ausente
    // da foto do SO não pode voltar a ser confirmado por nenhuma via.
    for (const [pid, record] of [...this.ownChildPids]) {
      if (seen.has(pid)) continue;
      if (nowMs - record.registeredAt <= DESCENDANT_DISCOVERY_TTL_MS) continue;
      this.ownChildPids.delete(pid);
      discarded++;
    }
    return discarded;
  }

  ownChildCount(): number {
    return this.ownChildPids.size;
  }

  /**
   * Decisão final para um `process.started`: este processo deve ser analisado?
   *
   * DECISÃO DO UTILIZADOR (2026-10-03): o TEMPO nunca decide, o NOME nunca
   * decide, o PATH nunca decide, o PID nunca decide. A imunidade sai de uma
   * identidade confirmada, e só isso.
   *
   *  1. **Identidade directa**: o PID é um que lançámos E a identidade de
   *     criação observada agora bate com a capturada no registo.
   *  2. **Identidade de descendência**: as três provas de `classifyOwnChild` —
   *     pai registado com identidade capturada, identidade observada do próprio
   *     pai, e relação observada com identidade do descendente. Isto não é
   *     preciosismo: o `clamscan` do Chocolatey é um shim que arranca o
   *     clamscan verdadeiro, e o PID que nós vêamos não é o PID que carrega os
   *     981 MB.
   *  3. **Nome E caminho de motor, juntos** — e apenas quando `absent`, ou seja
   *     quando não há NENHUM registo contra o qual este processo se levantar.
   *
   * O ponto 3 é o que o Codex marked como A5: era um atalho que contornava a
   * prova do descendente. Um veredicto `unknown` ou `foreign` NÃO pode recuperar
   * imunidade por nome/caminho — se o registo diz que há dúvida sobre a
   * identidade, o caminho do binário não a resolve.
   */
  shouldScanStartedProcess(processInfo: { pid: number; name: string; path?: string; ppid?: number; startedAt?: string }): boolean {
    const verdict = this.classifyOwnChild(processInfo);
    if (verdict.kind === "owned") return false;

    if (this.isSafeProcess(processInfo.name)) return false;

    // A5 — nome/caminho são CANDIDATOS a validar, nunca substituto da
    // identidade. Só valem em `absent`: com `unknown` ou `foreign` há uma
    // dúvida ou uma contradição de identidade em curso, e um clamscan.exe no
    // directório do motor não a desfaz. O caso 5 do contrato é exactamente este:
    // um filho EXTERNO com o mesmo nome e o mesmo caminho, dentro da janela.
    if (verdict.kind !== "absent") return true;

    // Nome E caminho, nunca só o nome. E com caminho VAZIO não há defesa
    // nenhuma: um `clamscan.exe` de que não sabemos a origem é um
    // `clamscan.exe` desconhecido, que é exactamente o que se quer ver.
    const processPath = processInfo.path ?? "";
    if (
      processPath &&
      CLAMAV_ENGINE_PROCESS_NAMES.has(processInfo.name.toLowerCase()) &&
      !this.shouldScanProcessPath(processPath)
    ) {
      return false;
    }
    return true;
  }

  private bindWatchers() {
    this.watcher.on("watcher.error", ({ error }: { error: NodeJS.ErrnoException }) => {
      if (["EPERM", "ENOENT", "EACCES", "EBUSY"].includes(error.code ?? "")) return;
      // Loss of monitoring must be visible. Recovery is an explicit monitor.start.
      console.error("[Service] Monitorização de ficheiros indisponível:", error);
      void this.stopProtection().catch(err => console.error("[Service] Falha ao parar proteção:", err));
    });
    this.watcher.on("watcher.coverage", (info: { motivo?: string; path?: string; message?: string; novos?: number; total?: number; eventosSemNome?: number }) => {
      // Degradação de VIGILÂNCIA, não do motor: continua tudo ativo nas restantes
      // raízes, por isso NÃO pode ir pelo canal de erro (que pararia a proteção).
      // `novos`/`total` chegam do filho; o contador decide sozinho o delta — um
      // cumulativo re-somado foi exatamente o defeito medido na C5.
      // `total` so e passado quando existe mesmo: um 0 inventado faria o ledger
      // tratar a mensagem como cumulativa e ignorar o `novos` legitimo do legado.
      const totalBruto = info?.total ?? info?.eventosSemNome;
      const temTotal = totalBruto !== undefined && totalBruto !== null && Number.isFinite(Number(totalBruto));
      this.reportCoverageGap(
        info?.path ?? "",
        info?.motivo ?? "overflow",
        Number(info?.novos ?? (temTotal ? Number(totalBruto) : 0)) || 0,
        temTotal ? Number(totalBruto) : Number.NaN,
        info?.message ?? "cobertura degradada",
      );
    });
    this.watcher.on("file.created", (event: FileObservation) => {
      if (!this.protectionState || this.isShuttingDown) return;
      if (this.exclusions.isExcluded(event.path)) return;
      this.eventBus.publish("file.created", "low", `Novo ficheiro observado: ${event.path}`, event);
      void this.handleFileObservation(event.path);
    });
    this.watcher.on("file.modified", (event: FileObservation) => {
      if (!this.protectionState || this.isShuttingDown) return;
      if (this.exclusions.isExcluded(event.path)) return;
      this.eventBus.publish("file.modified", "low", `Ficheiro modificado observado: ${event.path}`, event);
      void this.handleFileObservation(event.path);
    });
    this.watcher.on("file.deleted", (event: FileObservation) => {
      if (!this.protectionState || this.isShuttingDown) return;
      this.eventBus.publish("file.deleted", "low", `Ficheiro removido: ${path.basename(event.path)}`, event);
    });
    this.watcher.on("registry.persistence.changed", (event: any) => {
      if (!this.protectionState || this.isShuttingDown) return;
      this.eventBus.publish("persistence.detected", "high", "Persistência de registo alterada", event);
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
      this.processBirthsDuringEnumeration?.set(processInfo.pid, processInfo);
      this.processes = [processInfo, ...this.processes.filter((entry) => entry.pid !== processInfo.pid)];
      // DEFESA DE IDENTIDADE no ponto de entrada: um processo que o SERVICO
      // lancou entra no cache (para a lista estar certa) mas nunca volta a
      // ser analisado. A lista de nomes, sozinha, NAO da imunidade.
      // (ver shouldScanStartedProcess)
      if (isTrackedClamavPid(processInfo.pid)) {
        this.registerOwnChild(processInfo.pid, processInfo.startedAt);
        return;
      }
      // DESCENDENCIA. O shim do Chocolatey e o PID que lancamos; o clamscan
      // verdadeiro, que carrega os ~981 MB, e filho DELE. Sem esta linha, o
      // PID que nos lancamos protegia o PID que nos nao lancamos, e o P0
      // voltava -- exactamente o que o review de 2026-10-02 mediu.
      //
      // A6: o veredicto é o MESMO que `shouldScanStartedProcess` usa. Passar
      // `processInfo.startedAt` (que e do FILHO) como identidade do PAI era o
      // bug: datas diferentes apagavam o ownership legitimo do pai, e datas
      // ausentes aceitavam o PPID sozinho. `classifyOwnChild` compara o pai com
      // a identidade OBSERVADA do proprio pai, e so regista o filho depois de
      // confirmar a relacao E a identidade dele.
      if (this.classifyOwnChild(processInfo).kind === "owned") {
        this.registerOwnChild(processInfo.pid, processInfo.startedAt);
        return;
      }
      // Don't log or scan safe processes
      if (this.shouldScanStartedProcess(processInfo)) {
        this.eventBus.publish("process.started", "low", `Processo iniciado: ${processInfo.name}`, processInfo);
        void this.handleProcessStart(processInfo);
      }
    });
    this.processMonitor.on("process.exited", (processInfo: ProcessSnapshot) => {
      this.handleNaturalProcessExit(processInfo);
    });

    this.amsiProvider.on("script.blocked", (info: any) => {
      this.eventBus.publish("process.blocked", "high", `Execução de script malicioso bloqueada (${info.appName})`, info);
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
    // Saída CONFIRMADA pelo Windows: o PID já não existe, portanto o registo de
    // ownership pode sair. É o único sítio onde o limpamos — se o limpássemos
    // quando o grace expira, perderíamos a identidade de um processo vivo.
    this.releaseOwnChild(processInfo.pid);
    const wasCached = this.processes.some((entry) => entry.pid === processInfo.pid);
    this.dropCachedProcess(processInfo.pid, processInfo, { tombstone: true, invalidateTruth: false });
    if (wasCached && !this.isShuttingDown) {
      this.eventBus.publish("process.exited", "low", `Processo terminado: ${processInfo.name}`, processInfo);
    }
  }

  private async handleFileObservation(filePath: string, retry = false, recoverySignal?: AbortSignal): Promise<boolean> {
    const generation = this.protectionGeneration;
    if (!this.protectionState || this.isShuttingDown || recoverySignal?.aborted) return true;
    if (this.fileObservationReads >= 64) { this.reportRealtimeOverflow(filePath, "metadata", retry); return false; }
    ++this.fileObservationReads;
    // Guarda ANTES de qualquer tentativa de leitura: no Windows o watcher pode
    // reportar junctions/reparse points e diretórios como entradas de ficheiro
    // (Documents\Meus Vídeos, Minhas Imagens, Minhas Músicas). Abri-los produz
    // EPERM/EISDIR — não é um erro do motor, é um alvo que não é ficheiro.
    let fingerprint: string;
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isDirectory() || stat.isSymbolicLink()) return true;
      fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
    } catch {
      if (this.protectionState && !this.isShuttingDown && generation === this.protectionGeneration) this.publishInconclusiveFile(filePath, "Ficheiro inacessível ou removido antes da análise.", "file-changed");
      return true;
    } finally {
      --this.fileObservationReads;
    }

    if (!this.protectionState || this.isShuttingDown || generation !== this.protectionGeneration || recoverySignal?.aborted) return true;
    const signal = this.backgroundAbort.signal;
    const admission = this.realtimeQueue.enqueue(path.resolve(filePath).toLowerCase(), fingerprint, async () => {
      if (!this.protectionState || this.isShuttingDown || generation !== this.protectionGeneration || signal.aborted) return;
      await this.scanArtifact(filePath, "service", { backgroundSignal: signal, skipVirusTotal: true });
    }, this.realtimePriority(filePath));
    if (admission === "full") { this.reportRealtimeOverflow(filePath, "analysis", retry); return false; }
    return true;
  }

  /** Downloads primeiro: e onde o EICAR chega e onde a detecao tardia se nota. */
  private realtimePriority(filePath: string): "high" | "normal" {
    const home = process.env.USERPROFILE || os.homedir();
    const downloads = path.resolve(home, "Downloads").toLowerCase() + path.sep;
    return path.resolve(filePath).toLowerCase().startsWith(downloads) ? "high" : "normal";
  }

  private reportRealtimeOverflow(caminho = "", stage: SaturationStage = "analysis", retry = false): void {
    // Só a primeira rejeição agenda. Uma retry falhada não cria outra cadeia.
    if (retry) this.realtimeRecovery.recordRejection(caminho, stage);
    else this.realtimeRecovery.defer(path.resolve(caminho), stage, signal => this.handleFileObservation(caminho, true, signal));
    ++this.realtimeDroppedEvents;
    this.loss.noteQueueRejection(caminho || "caminho-desconhecido");
    const now = Date.now();
    if (now - this.overflowNoticeAt < 10000) return;
    const resumo = this.loss.summary();
    this.overflowNoticeAt = now;
    this.eventBus.publish("engine.health", "high", `A fila de análise do tempo real está cheia: ${resumo.queueRejections} tentativas não entraram (em ${resumo.queueDistinctPaths} caminhos distintos${resumo.queuePathsCapped ? ", contagem de caminhos limitada" : ""}). Alguns ficheiros podem não ter sido analisados; faça uma análise manual.`, {reason:"queue-overflow",admissionStage:stage,recoveryEventId:this.realtimeRecovery.snapshot().lastEventId,metadataRejections:this.realtimeRecovery.snapshot().metadataRejections,analysisRejections:this.realtimeRecovery.snapshot().analysisRejections,queueDepth:this.realtimeQueue.size,recoveryDepth:this.realtimeRecovery.snapshot().pending,droppedEvents:this.realtimeDroppedEvents,distinctPaths:resumo.queueDistinctPaths,capped:resumo.queuePathsCapped});
  }

  /**
   * Lacuna de cobertura reportada pelo filho do watcher (15/10): notificações que
   * chegaram sem nome de ficheiro, raiz apagada em runtime, ou raiz cujo attach
   * falhou. NÃO toca em `realtimeDroppedEvents`: a conta do watcher é outra origem
   * e outro número. E não promete o que o sinal não diz — o Node não garante
   * `filename` em Windows, por isso isto é lacuna POSSÍVEL com quantidade de
   * ficheiros desconhecida, não perda provada de eventos do SO (a prova de
   * transbordo do ReadDirectoryChangesW e `lpBytesReturned` zero, que o Node não
   * expõe aqui).
   */
  private reportCoverageGap(caminho: string, motivo: string, novos: number, total: number, mensagem: string): void {
    this.loss.noteWatcherSignal({ path: caminho, novos, total });
    this.coverageGaps.push({ path: caminho, motivo, detectedAt: new Date().toISOString() });
    if (this.coverageGaps.length > 50) this.coverageGaps.shift();
    const agora = Date.now();
    if (agora - this.coverageNoticeAt < 10000) return;
    this.coverageNoticeAt = agora;
    const resumo = this.loss.summary();
    const frase = motivo === "raiz-desaparecida"
      ? `Pasta de vigilância desapareceu: ${caminho || "sem caminho"}. Deixou de estar vigiada; faz uma análise manual dessa localização.`
      : motivo === "raiz-inacessivel" || motivo === "raiz-excluida-validacao"
        ? `Pasta não vigiada: ${caminho || "sem caminho"}. ${mensagem}`
        : `Vigilância de ${caminho || "sem caminho"} recebeu ${resumo.watcherNamelessCallbacks} notificações sem nome de ficheiro (${resumo.watcherSignals === 1 ? "1 aviso" : `${resumo.watcherSignals} avisos`}). Pode haver ficheiros por analisar nessa pasta e não se sabe quantos; faz uma análise manual.`;
    this.eventBus.publish("engine.health", "high", frase, {
      reason: "watcher-coverage",
      motivo,
      path: caminho,
      novos,
      total,
      watcherSignals: resumo.watcherSignals,
      watcherNamelessCallbacks: resumo.watcherNamelessCallbacks,
      // `indeterminado` e o campo que impede a leitura contraria: diz que a
      // quantidade de ficheiros afetados nao e conhecida, so o numero de sinais.
      indeterminado: true,
      detalhe: mensagem,
    });
  }

  private publishInconclusiveFile(
    filePath: string,
    reason: string,
    inconclusiveReason: import("@cybersafe/shared-types").InconclusiveReason = "no-verdict",
    inconclusiveEngine: import("@cybersafe/shared-types").InconclusiveEngine = "filesystem",
  ): ServiceResponseMap["scan.artifact"] {
    const result = { fileName:path.basename(filePath),size:0,severity:"low" as const,confidence:0,rulesTriggered:[],riskScore:0,verdict:"inconclusive" as const,sha256:"",analysisState:"failed" as const,inconclusiveReason,inconclusiveEngines:[inconclusiveEngine],detail:reason };
    this.eventBus.publish("artifact.analyzed", "low", reason, {...result,artifactPath:filePath,reason});
    return {results:[result],totalFiles:1,highRiskCount:0,overallSeverity:"low",rulesTriggered:[],riskScore:0};
  }

  private async requestQuarantine(analysis: AnalysisResult, authorization: "manual" | "automatic"): Promise<boolean> {
    const evidence = {artifactPath:analysis.artifactPath,fileName:analysis.fileName,sha256:analysis.sha256,authorization};
    const caminhoPermitido = !isProtectedQuarantinePath(analysis.artifactPath, { baseDir: this.baseDir, execPath: process.execPath })
      && await hasReparseFreePath(analysis.artifactPath);
    if (!caminhoPermitido) {
      this.eventBus.publish("quarantine.failed", "high", `Isolamento recusado por caminho protegido: ${analysis.fileName}`, {...evidence, reason:"protected-path"});
      void this.logHistory({type:"quarantine.failed",...evidence,reason:"protected-path",timestamp:new Date().toISOString()});
      return false;
    }
    this.eventBus.publish("quarantine.requested", "high", `Quarentena solicitada: ${analysis.fileName}`, evidence);
    try {
      const entry = await this.quarantine.quarantine(analysis);
      if (!entry) throw new Error("Operação não confirmada");
      this.eventBus.publish("quarantine.added", "critical", `Colocado em quarentena ${analysis.fileName}`, entry);
      void this.logHistory({type:"quarantine.added",entry,timestamp:new Date().toISOString()});
      return true;
    } catch {
      this.eventBus.publish("quarantine.failed", "high", `Não foi possível confirmar o isolamento de ${analysis.fileName}. Verifique a quarentena e o ficheiro.`, evidence);
      void this.logHistory({type:"quarantine.failed",...evidence,timestamp:new Date().toISOString()});
      return false;
    }
  }

  private async handleProcessStart(processInfo: ProcessSnapshot) {
    const generation = this.protectionGeneration;
    if (!this.protectionState || this.isShuttingDown) return;
    // Dupla verificação no ponto de entrada. `isSafeProcess` sozinho já não
    // chega: quem decide é `shouldScanStartedProcess`, que conhece a
    // descendência do nosso próprio motor de scan.
    if (!this.shouldScanStartedProcess(processInfo)) return;

    // 1. Behavioral Check (Command Line). WS-2B: os padroes continuam a ser
    // testados e a deteccao continua, mas o sinal NAO salta para kill
    // automatico. Publica-se atencao (warning, nao critical) com evidencia —
    // o processo, o padrao que casou e a command line — para o utilizador
    // ver e decidir. A verificacao de assinatura em :652 segue em frente.
    const suspiciousPatterns = [
      /powershell.*-nop.*-ep.*bypass/i,
      /powershell.*-encodedcommand/i,
      /cmd\.exe.*\/c.*del/i,
      /wscript\.exe.*vbscript:/i,
      /mshta\.exe.*http/i,
    ];

    if (processInfo.commandLine) {
      const matched = suspiciousPatterns.find((pattern) => pattern.test(processInfo.commandLine));
      if (matched) {
        // WS-2B: medium = atencao com evidencia, NAO critical, NAO kill.
        this.eventBus.publish("process.suspicious", "medium",
          `Heuristica de linha de comando: ${processInfo.name}`,
          {
            ...processInfo,
            reason: "Padrão suspeito na linha de comando (sem auto-kill)",
            pattern: matched.source,
          });
      }
    }

    // 2. Path Check
    const lowerPath = processInfo.path.toLowerCase();
    if (this.blockedPaths.has(lowerPath)) {
      // P1: o auto-kill passa pelo MESMO guard do kill manual. Um falso-positivo
      // num binario de sistema ou num componente do CyberSafe matava a arvore
      // toda a forca, sem perguntar nada.
      const protection = classifyKillTarget(processInfo, this.killProtectionContext());
      if (protection) {
        // Houve deteccao, MAS nao houve kill. Publicar "blocked" seria dizer que
        // o processo foi parado, e nao foi.
        console.warn(
          `[Service] Deteccao por path em alvo protegido (${protection}), sem auto-kill: PID ${processInfo.pid}`,
        );
        this.logKillBlocked("auto", processInfo, protection, this.nextKillRequestId(processInfo.pid));
        this.eventBus.publish("process.suspicious", "medium",
          `Alvo de deteccao por caminho, mas nao foi terminado (protegido): ${processInfo.name}`,
          { ...processInfo, reason: `path bloqueado mas protegido por ${protection} (sem auto-kill)` });
      } else {
        this.eventBus.publish("process.suspicious", "high", `Deteção anterior neste caminho; processo não terminado: ${processInfo.name}`, {...processInfo,reason:"Requer decisão manual; o CyberSafe não terminou o processo."});
      }
      return;
    }

// 2.5 Auto-protecao contra kill. WS-2B: o padrao continua a ser testado e a
    // deteccao continua, mas o sinal NAO salta para kill automatico. Publica-se
    // atencao (warning) com evidencia para o utilizador ver e decidir. A
    // verificacao de assinatura em :652 segue em frente.
    if (processInfo.name.toLowerCase() === "taskkill.exe" || processInfo.name.toLowerCase() === "sc.exe") {
       if (processInfo.commandLine.toLowerCase().includes("cybersafe")) {
          // WS-2B: medium = atencao com evidencia, NAO critical, NAO kill.
          this.eventBus.publish("process.suspicious", "medium",
            `Possível tentativa de terminar o serviço CyberSafe: ${processInfo.name}`,
            {
              ...processInfo,
              reason: "taskkill/sc.exe com 'cybersafe' na linha de comando (sem auto-kill)",
            });
       }
    }

    // 3. Signature Check (Hash/YARA)
    // DEFESA 2: um binário de motor de scan não é reanalisado por caminho.
    if (processInfo.path && !this.shouldScanProcessPath(processInfo.path)) return;
    if (processInfo.path) {
      const analysis = await this.scanArtifact(processInfo.path, "service", {
        origin: "process_monitor", backgroundSignal: this.backgroundAbort.signal,
      });
      if (!this.protectionState || this.isShuttingDown || generation !== this.protectionGeneration) return;
      if (analysis?.results[0]?.sha256 && this.blockedHashes.has(analysis.results[0].sha256)) {
        // P1: mesmo guard, mesmo sítio — imediatamente antes da chamada que mata.
        const protection = classifyKillTarget(processInfo, this.killProtectionContext());
        if (protection) {
          console.warn(
            `[Service] Deteccao por hash em alvo protegido (${protection}), sem auto-kill: PID ${processInfo.pid}`,
          );
          this.logKillBlocked("auto", processInfo, protection, this.nextKillRequestId(processInfo.pid));
          this.eventBus.publish("process.suspicious", "medium",
            `Alvo de deteccao por assinatura, mas nao foi terminado (protegido): ${processInfo.name}`,
            { ...processInfo, reason: `hash bloqueado mas protegido por ${protection} (sem auto-kill)` });
        } else {
          this.eventBus.publish("process.suspicious", "high", `Assinatura detetada; processo não terminado: ${processInfo.name}`, {...processInfo,reason:"Requer decisão manual; o CyberSafe não terminou o processo."});
        }
      }
    }
  }

  private async refreshConnections() {
    this.connections = await snapshotConnections();
  }

  async dispose() {
    ++this.protectionGeneration;
    this.backgroundAbort.abort();
    this.realtimeQueue.clear();
    this.realtimeRecovery.clear();
    // Idempotente: pode ser chamado pelo shutdown e pelo handler de sinais.
    if (this.disposed) return;
    this.disposed = true;
    this.individualTermination?.dispose();
    // Se o encerramento apanhar a janela progressiva, nada fica à espera dela.
    this.settleStartup("disposed");
    this.hardware.dispose();
    this.protectionState = false;
    this.updater.stopScheduler();
    // Uma pausa agendada NUNCA pode reanimar a proteção durante o
    // encerramento: o timer disparava `startProtection()` em pleno teardown,
    // a abrir watchers e ETW num motor que já está a desmontar.
    if (this.protectionResumeTimer) {
      clearTimeout(this.protectionResumeTimer);
      this.protectionResumeTimer = null;
      this.protectionPausedUntil = null;
    }
    if (this.networkTimer) {
      clearInterval(this.networkTimer);
      this.networkTimer = null;
    }

    // Deadline POR SUBSISTEMA, nao um deadline global em volta do
    // Promise.allSettled. A versao anterior esperava que TODOS os .stop()
    // resolvessem antes de mexer nos sockets; um unico .stop() pendurado
    // (PowerShell a bloquear, handle ETW preso) fazia o allSettled nunca
    // resolver e os sockets NUNCA eram fechados — medido: destroyed=false,
    // clients=1, ainda apos +800 ms. O deadline do shutdown() nao salvava
    // nada aqui: ele so garante o process.exit, que mata o processo e
    // arrasta os sockets na queda em vez de os fechar.
    //
    // Com um deadline por subsistema, um .stop() que nao responde custa o seu
    // orcamento e NAO rouba o dos outros. O cleanup dos sockets corre sempre.
    const parar = async (nome: string, accao: () => unknown, ms: number) => {
      const aviso = setTimeout(() => {
        console.error(`[Service] ${nome} não parou em ${ms}ms — a seguir com o resto`);
      }, ms);
      try {
        await Promise.race([
          Promise.resolve().then(() => accao()),
          new Promise<void>((resolve) => setTimeout(resolve, ms)),
        ]);
      } catch (err) {
        console.error(`[Service] Falha ao parar ${nome}:`, err);
      } finally {
        clearTimeout(aviso);
      }
    };

    await Promise.all([
      parar("watcher", () => this.watcher.stop(), 800),
      parar("processMonitor", () => this.processMonitor.stop(), 800),
      parar("etwConsumer", () => this.etwConsumer.stop(), 800),
      parar("wfpFilter", () => this.wfpFilter.stop(), 800),
      parar("amsiProvider", () => this.amsiProvider.stop(), 800),
      parar("windowsHealth", () => this.windowsHealth.dispose(), 800),
      // O poll da protecao USB nao pode sobreviver ao servico.
      parar("usbRuntime", () => this.usbRuntime.dispose(), 800),
    ]);

    // O cleanup dos recursos criticos de IPC corre independentemente do que os
    // subsistemas fizeram: um `.stop()` que ultrapasse o seu orcamento nao
    // pode impedir isto. Nao afirmamos que o `stop()` parou — apenas que foi
    // TENTADO dentro de um orcamento limitado, e que o pipe morre na mesma.
    // E a ultima coisa que o utilizador ve: o pipe tem de morrer, senao a app
    // seguinte liga-se a um servico meio-desligado.
    if (this.server) {
      for (const client of [...this.clients, ...this.authenticatingClients]) {
        client.destroy();
      }
      this.clients.clear();
      this.authenticatingClients.clear();

      await new Promise<void>((resolve) => {
        try {
          this.server?.close(() => resolve());
        } catch {
          resolve();
        }
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
    // O clamscan carrega ~1 GB antes de começar a trabalhar. Fechar a app sem o
    // terminar deixava-o a varrer sozinho, sem dono e sem forma de cancelar.
    //
    // P1-5 (Codex): isto vive DEPOIS do race de propósito — se um `.stop()`
    // pendurar, o race expira e esta linha era a única que ainda podia
    // terminar o processo pesado.
    //
    // BUG B (fixado): a versão anterior fazia `let clamavStopped = true` e só o
    // punha a `false` dentro do `.catch`. Se o TIMEOUT ganhasse, `clamavStopped`
    // continuava `true` e imprimíamos "ClamAV disposed" sem nunca ter
    // confirmado nada — a mesma mentira que este shutdown existe para não
    // dizer. O resultado é agora explícito: `disposed` | `failed` | `timeout`.
    // Nunca se infere sucesso da ausência de rejeição.
    const clamavOutcome = await Promise.race([
      this.clamav
        .dispose()
        .then(() => "disposed" as const, (err: unknown) => {
          console.error("[Service] Falha ao terminar o motor ClamAV:", err);
          return "failed" as const;
        }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3000)),
    ]);
    if (clamavOutcome === "disposed") {
      console.log("[Service] ClamAV disposed");
    } else {
      // O `ClamavBridge` deixa a vaga `poisoned` quando não confirma a morte, e
      // o próximo scan responde `unavailable` em vez de fingir. Dizer isto é
      // obrigatorio: quem ler o log tem de saber que saiu um processo pesado.
      console.error(
        clamavOutcome === "timeout"
          ? "[Service] ClamAV NÃO confirmado como terminado (expirou o orçamento de 3s) — pode haver clamscan vivo"
          : "[Service] ClamAV NÃO terminado (dispose falhou) — pode haver clamscan vivo",
      );
    }
    DefinitionUpdater.dispose();
    console.log("[Service] Updater disposed");
    disposeTempHelper();
    console.log("[Service] Service stopped");

    // Fecha a própria aplicação NodeJS
    setTimeout(() => {
       process.exit(0);
    }, 200);
  }

  private async changeQuarantinePolicy(payload: { policy?: unknown; consent?: unknown }): Promise<{ ok: boolean; policy: QuarantinePolicy; error?: string }> {
    const saved = await saveQuarantinePolicy(
      path.join(this.baseDir, "protection-policy.json"),
      payload?.policy,
      payload?.consent,
    );
    if (!saved.ok) return saved;
    this.quarantinePolicy = saved.policy;
    void this.logHistory({
      type: "quarantine.policy.changed",
      policy: saved.policy,
      authorization: saved.policy === "automatic-high-confidence" ? "user-consent" : "explicit",
      timestamp: new Date().toISOString(),
    });
    return { ok: true, policy: saved.policy };
  }

  getProtectionState(): ProtectionState {
    const status = this.clamav.health.status;
    const available = status === "active";
    const now = Date.now();
    const previous = this.lastClamavAvailability === undefined
      ? null
      : { engine: "ClamAV", available: this.lastClamavAvailability, status: this.lastClamavStatus ?? "unknown" };
    const nextEngine = { engine: "ClamAV", available, status };
    if (shouldPublishEngineUnavailable(previous, nextEngine, now, this.lastClamavUnavailablePublish, ENGINE_UNAVAILABLE_NOTIFY_COOLDOWN_MS)) {
      this.eventBus.publish("engine.health", "high", "O ClamAV deixou de conseguir analisar; os resultados podem ser inconclusivos.", {engine:"ClamAV",essentialUnavailable:true,status});
      this.lastClamavUnavailablePublish = { key: engineUnavailableKey(nextEngine), at: now };
    }
    this.lastClamavAvailability = available;
    this.lastClamavStatus = status;
    const recentThreats = this.threats.slice(0, 10);
    const maxRisk = recentThreats.length > 0
      ? Math.max(...recentThreats.map(t => t.riskScore))
      : 0;

    // O estado do filtro tem de dizer a sua ORIGEM. `isActive()` só é true
    // depois de leitura de volta; `nao_iniciado`, `parado` e `falhou` são
    // coisas diferentes e nenhuma delas autoriza a frase "o Firewall do
    // Windows está desligado" — o módulo medido é o filtro do CyberSafe.
    // O `status` mantém o vocabulário de contrato (pinned por service-copy);
    // é no `detail` que a causa distinguível chega ao consumidor.
    const wfpEstado = this.wfpFilter.estado();
    const wfpStatus = wfpEstado.estado === "ativo_confirmado" ? "active" : "unavailable";
    const wfpCausa =
      wfpEstado.estado === "falhou"
        ? `tentativa recusada: ${wfpEstado.motivo}`
        : wfpEstado.estado === "parado"
          ? "parado por pedido"
          : wfpEstado.estado === "solicitado_nao_verificado"
            ? "pedido enviado, estado não lido de volta"
            : undefined;
    const wfpDetail = wfpCausa
      ? `filtro WFP inativo — ${wfpCausa}`
      : wfpStatus === "active" ? "filtro WFP ativo" : "filtro WFP inativo";

    // Estado real dos motores — nunca inventamos "proteção ativa". Antes de
    // init não houve leitura dos motores: `osLayerHealthy:true` seria uma
    // afirmação sem fonte. `failed`/`disposed` também não são saudáveis.
    const startupNotReady =
      this.startupStateValue === "starting" ||
      this.startupStateValue === "failed" ||
      this.startupStateValue === "disposed";
    const engine: EngineHealth = {
      serviceRunning: true,
      osLayerHealthy: !startupNotReady,
      degradedReasons: startupNotReady
        ? ["Arranque em curso: a saúde dos motores ainda não foi confirmada por uma leitura real."]
        : [],
      monitoredPaths: this.protectionState ? this.watcher.getMonitoredPaths() : [],
      realtimeQueueDepth: this.realtimeQueue.size,
      realtimeDroppedEvents: this.loss.summary().queueRejections,
      realtimeLoss: this.loss.summary(),
      realtimeRecovery: { ...this.realtimeRecovery.snapshot(), metadataInFlight: this.fileObservationReads, analysisQueueDepth: this.realtimeQueue.size },
      definitionsUpdatedAt: this.definitionsUpdatedAt,
      lastEventAt: this.events.at(-1)?.timestamp,
      yara: this.yara.health,
      hashDb: this.signatures.health,
      clamav: this.clamav.health,
      nativeEngine: NativeEngineBridge.health,
      // O filtro WFP do CyberSafe. NAO e o Firewall do Windows: e o que mede
      // `wfpFilter.estado()`, isto e, se as nossas regras de bloqueio de IP
      // estao activas. O Firewall do Windows mede-se em `WindowsHealthSnapshot`.
      //
      // `firewall` e o MESMO objecto, publicado como alias temporario para o
      // renderer antigo. Nao e um segundo sentido: e o mesmo valor sob o nome
      // antigo. Um renderer novo tem de ler `wfp` (ou `wfpHealth()`).
      wfp: { status: wfpStatus, detail: wfpDetail },
      firewall: { status: wfpStatus, detail: wfpDetail },
      anyEngineDegraded: false,
    };
    engine.anyEngineDegraded = startupNotReady || hasDegradedProtections(engine) || engineIsDegraded(engine);
    const perda = this.loss.summary();
    if (perda.queueRejections > 0 || perda.watcherCallbacksIndeterminate) {
      // `degradedReasons` é obrigatória no contrato: sem `!` e sem push condicional
      // sobre um campo que pode não existir.
      engine.degradedReasons.push("Cobertura do tempo real não confirmada: houve rejeições ou sinais de perda do watcher. Recuperar admissão não confirma análise de todas as versões.");
    }
    if (engine.anyEngineDegraded) {
      for (const key of ["yara", "hashDb", "clamav", "nativeEngine", "wfp"] as const) {
        const sub = key === "wfp" ? engine.wfp : engine[key];
        if (sub && sub.status !== "active") {
          // A string vai ate ao ecra (pcstate.ts:250 e ProtectionDetails.tsx:76),
          // por isso leva o NOME e nao a chave: "firewall: unavailable" dizia ao
          // utilizador que a proteccao de rede do Windows estava desligada.
          const label = ENGINE_DISPLAY_NAME[key] ?? key;
          engine.degradedReasons!.push(`${label}: ${sub.status} — ${sub.detail ?? "no detail"}`);
        }
      }
    }

    // Se a proteção está degradada (motor core ausente/indisponível), o score base
    // sobe para refletir perda de confiança nas deteções — nunca mostramos "safe".
    const effectiveRisk = effectiveRiskScore(maxRisk, engine);
    const degradedForStatus = engineIsDegraded(engine);

    // Facto real on/off, lido do motor. É independente das ameaças: zero
    // ameaças não significa proteção ativa.
    const protectionEnabled = this.protectionState === true;

    const stats: ProtectionStats = {
      riskScore: effectiveRisk,
      totalEvents: this.threats.length,
      highSeverityEvents: this.threats.filter((event) => event.severity === "high" || event.severity === "critical").length,
      blockedExecutions: this.events.filter((event) => event.type === "process.blocked" || event.type === "process.killed").length,
      quarantinedCount: this.quarantine.list().filter(entry => entry.isolationStatus === "confirmed").length,
      monitoredProcesses: this.processes.length,
      // P0-3 (15/10): a UI mostra a politica EFETIVA, lida do disco pelo
      // loader no arranque (ausente/invalido = "warn"). Nada aqui ativa nada.
      quarantinePolicy: this.quarantinePolicy,
    };

    // A decisão vive em `deriveProtectionStatus` (core) para haver UM só sítio
    // onde "protegido" é decidido, e para os testes poderem exercitar a mesma
    // função que o motor usa em vez de uma cópia dela.
    const derivedStatus = deriveProtectionStatus(
      protectionEnabled,
      stats.riskScore,
      degradedForStatus,
    );

    return {
      status: derivedStatus,
      stats,
      engine,
      protectionEnabled,
      protectionPausedUntil: this.protectionPausedUntil ?? null,
    };
  }

  /**
   * Snapshot de hardware para CONSUMO (IPC e PC State).
   *
   * Cache só dentro da janela de reutilização (ver HARDWARE_SNAPSHOT_REUSE_MS):
   * um snapshot antigo nunca é servido indefinidamente. É o ponto único por onde
   * passam o Dashboard, o PC Center e o PC State — a mesma verdade, com a mesma
   * idade, em todas as páginas.
   */
  private hardwareSnapshotFlight: Promise<HardwareSnapshot> | null = null;

  private async readHardwareSnapshot(): Promise<HardwareSnapshot> {
    const cached = this.hardware.getLastSnapshot();
    const cachedAt = cached ? Date.parse(cached.timestamp) : Number.NaN;
    if (cached && Number.isFinite(cachedAt) && Date.now() - cachedAt < HARDWARE_SNAPSHOT_REUSE_MS) {
      return cached;
    }
    if (this.hardwareSnapshotFlight) return this.hardwareSnapshotFlight;
    const flight = this.hardware.getSnapshot(this.processes);
    this.hardwareSnapshotFlight = flight;
    try { return await flight; }
    finally { if (this.hardwareSnapshotFlight === flight) this.hardwareSnapshotFlight = null; }
  }

  async getPcState(): Promise<PcState> {
    const protection = this.getProtectionState();
    // Mesmo snapshot que o Dashboard e o PC Center: o PC State não pode ficar
    // com uma fotografia antiga enquanto as outras páginas já têm a leitura nova.
    const hardware = await this.readHardwareSnapshot();
    const windowsHealth = this.windowsHealth.getLastSnapshot();

    return this.pcState.update({
      hardware,
      protection,
      windowsHealth,
      threats: this.threats,
      now: Date.now(),
    });
  }

  /**
   * Capacidade ESTRUTURAL do caminho read-only implementado: nome + versao.
   * Mudar a semantica do modo USB (o que o motor deixa de/comeca a fazer)
   * exige subir a versao: um adapter que espere outra versao bloqueia o
   * auto-scan em vez de assumir. Nao e' prova dinamica de seguranca — a
   * verificacao real do comportamento esta' nos testes com o ScanManager real.
   */
  public usbReadOnlyCapacidade() {
    return { nome: "usb-readonly", versao: 1 };
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
   * PORQUÊ um ficheiro ficou fora dos motores, em categoria — é isto que o
   * ScanManager agrega para a UI poder explicar a diferença entre
   * "considerados" e "analisados" sem inventar. Nunca devolve caminhos: a
   * categoria `path` não transporta o caminho que casou.
   */
  exclusionCategory(filePath: string): ExclusionCategory | null {
    try {
      return this.exclusions.exclusionCategory(filePath);
    } catch {
      return null;
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

  /**
   * Veredictos de ClamAV obtidos NUMA unica invocacao para N ficheiros.
   *
   * FASE 4 (P0 CLAMAV_RESOURCE_EXHAUSTION). O clamscan paga o carregamento da
   * base de assinaturas POR PROCESSO: ~6,2 s e ~981 MB, medidos. Um scan de 50
   * ficheiros em 50 invocacoes pagava isso 50 vezes -- 5 minutos e 49 GB de
   * RAM, um de cada vez. Numa invocacao sao 6,2 s e 981 MB.
   *
   * O que NAO muda: a analise por ficheiro (YARA, hash, nativo, VT), os threat
   * records, a quarentena, o progresso e o cancelamento. So o clamscan muda de
   * sitio, e o resultado continua a ser POR FICHEIRO -- que e o que permite
   * atribuir uma deteccao ao ficheiro certo em vez de dizer "o batch estava
   * infectado".
   */
  /**
   * P1-3 — o prefetch é POR SCAN, e tem um DONO.
   *
   * MEDIDO (2026-10-03): `clamavPrefetch` era um Map GLOBAL e
   * `clearClamavPrefetch()` não recebia scanId. Dois defeitos com a mesma raiz:
   *
   *  1. **Sem dono**: o clear de A limpava o prefetch de B, e o veredicto de A
   *     sobrevivia ao clear de A se o `await` do batch resolvesse DEPOIS dele —
   *     que é a ordem normal quando o scan é cancelado a meio do clamscan (o
   *     `finally` corre, o `await` só resolve quando o SO fecha o pipes).
   *  2. **Sem escopo**: um ficheiro de A lido em B herdava a deteção de A.
   *
   * A correccao e um Map por scanId, mais uma geracao. O
   * Generation é o que fecha o caso 1: se o clear aconteceu, o que arrive
   * depois pertence a uma geração que já não é a do dono, e é descartado em vez
   * de instalar um Map órfão.
   *
   * Janela limitada: um serviço de vida longa não pode Guardar um veredicto por
   * ficheiro de cada scan para sempre. O dono é removido no `finally`; isto é
   * só a rede contra um dono que nunca chegou a ser limpo.
   */
  private clamavPrefetches = new Map<string, { generation: number; files: Map<string, ClamavFileOutcome> }>();
  /** Geração global do prefetch. Só incrementa; nunca é reatribuído. */
  private clamavPrefetchGeneration = 0;

  /** Chave de comparacao: o mesmo ficheiro escrito de outra maneira tem de casar. */
  private static prefetchKey(file: string): string {
    return file.replace(/\//g, "\\").toLowerCase();
  }

  /**
   * Corre UM clamscan para todos os ficheiros e guarda o resultado por
   * ficheiro. Nunca lanca: uma falha aqui tem de deixar o scan continuar com
   * o clamscan por ficheiro, que e lento mas correcto.
   */
  async prefetchClamav(
    filePaths: string[],
    scanId?: string,
    onProgress?: (processedFiles: number) => void,
  ): Promise<{ spawned: boolean; error?: string; files?: number }> {
    if (filePaths.length === 0) return { spawned: false, files: 0 };
    const generation = ++this.clamavPrefetchGeneration;
    const owner = scanId ?? `sem-id-${generation}`;
    const existing = scanId === undefined ? undefined : this.clamavPrefetches.get(owner);
    const mergedFiles = existing?.files ?? new Map<string, ClamavFileOutcome>();
    this.clamavPrefetches.set(owner, { generation, files: mergedFiles });
    const perfEnabled = process.env.CYBERSAFE_DEBUG_SCAN === "1";
    if (perfEnabled) {
      console.log(`[ScanPerf] PREFETCH_BEGIN scanId=${owner} files=${filePaths.length} at=${new Date().toISOString()}`);
    }
    try {
      // `onProgress` e' o que tira o batch da caixa preta: o clamscan diz,
      // linha a linha, quantos ficheiros ja varreu. Sem isto a UI ficava 0/N
      // durante os minutos que o batch demora (P0 SCANNER_REAL_BATCH_STALL).
      const batch = await this.clamav.scanFiles(filePaths, {
        signal: this.signalForScan(scanId),
        onProgress,
        scanId: owner,
        // Um prefetch só existe porque o ScanManager o pediu: é sempre trabalho
        // de um scan do utilizador, e é ele que não pode ficar atrás da fila de
        // análises automáticas (P0 SCANNER_RUNTIME_ZERO_PROGRESS).
        priority: "user",
      });
      const files = new Map(batch.files.map((f) => [ProtectionEngineService.prefetchKey(f.file), f]));
      // O dono pode ter sido limpo (ou trocado) durante o await. Se for, este
      // resultado é de um scan que já acabou: descartar é o honesto.
      if (this.clamavPrefetches.get(owner)?.generation !== generation) {
        if (perfEnabled) {
          console.log(`[ScanPerf] prefetch discard owner=${owner} generation=${generation}`);
        }
        return { spawned: true, error: undefined };
      }
      const current = this.clamavPrefetches.get(owner);
      if (!current || current.generation !== generation) {
        return { spawned: true, error: undefined };
      }
      for (const [key, outcome] of files) current.files.set(key, outcome);
      if (perfEnabled) {
        // `batch.files.length` = um veredicto terminal POR ficheiro pedido
        // (parseClamavOutput mapeia sobre `files`). `files.size` e' o numero de
        // chaves normalizadas e pode ser MENOR se dois caminhos colidirem: e'
        // isso que separa "o clamscan perdeu uma linha de progresso" de "dois
        // pedidos sao o mesmo ficheiro".
        console.log(`[ScanPerf] PREFETCH_RESOLVE scanId=${owner} requested=${filePaths.length} outcomes=${batch.files.length} unique=${files.size} status=${batch.status.status} at=${new Date().toISOString()}`);
      }
      // O numero de outcomes e' a verdade terminal do batch: o `onProgress`
      // (linhas `OK`/`FOUND`) pode omitir um ficheiro que o clamscan nomeou de
      // outra forma, mas o veredicto por ficheiro existe sempre.
      return {
        spawned: true,
        error: batch.status.status === "degraded" ? batch.status.detail : undefined,
        files: batch.files.length,
      };
    } catch (err) {
      if (perfEnabled) {
        const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
        console.log(`[ScanPerf] PREFETCH_REJECT scanId=${owner} code=${String(code)} at=${new Date().toISOString()}`);
      }
      // Sem prefetch, `scanArtifact` volta ao caminho de um ficheiro de cada
      // vez. Lento, mas nunca errado nem vazio.
      this.clamavPrefetches.delete(owner);
      return { spawned: false, error: (err as Error)?.message };
    }
  }

  /**
   * Liberta o prefetch DESTE scan. Chamar SEMPRE no fim do scan, mesmo em
   * cancelamento.
   *
   * O `generation` sobe para que um `await` já em curso saiba que o dono
   * desapareceu — é isto que impede o veredicto de um scan cancelado de
   * reaparecer depois.
   */
  clearClamavPrefetch(scanId?: string): void {
    if (process.env.CYBERSAFE_DEBUG_SCAN === "1") {
      console.log(`[ScanPerf] PREFETCH_CLEAR scanId=${scanId ?? "all"} at=${new Date().toISOString()}`);
    }
    // P1 — ABORT STICKY: o controller de abort e a intenção de abort
    // viviam no engine sem nunca serem limpos quando o scan terminava sem
    // nunca ter criado o controller (cancel na janela de looksLikeZip). O
    // `finally` do scan chama clearClamavPrefetch, por isso é o único ponto
    // de limpeza e garante que um scanId never sobrevive ao seu terminal.
    this.releaseScanAbort(scanId);
    if (scanId === undefined) {
      // Sem id não há dono a nomear: limpa-se tudo e invalida-se tudo. É o que
      // um chamador sem id genuinamente nao pode limpar so um.
      this.clamavPrefetchGeneration++;
      this.clamavPrefetches.clear();
      return;
    }
    this.clamavPrefetches.delete(scanId);
  }

  /** O veredicto de um ficheiro, se o prefetch DESTE scan o tiver. */
  private clamavOutcomeFor(filePath: string, scanId?: string): ClamavFileOutcome | undefined {
    const entry = scanId !== undefined ? this.clamavPrefetches.get(scanId) : undefined;
    return entry?.files.get(ProtectionEngineService.prefetchKey(filePath));
  }

  /**
   * Decides, BEFORE any clamav work, whether this requested file is already a
   * terminal batch outcome for the same scan. Eta/terminal progress would keep
   * reporting 728/800 forever unless the post-batch UI is fed from this source
   * of truth instead of re-running clamav for every batched file.
   *
   * Cache is valid only when the scanId matches (one scan = one prefetch
   * tenancy). Because the cache is keyed by normalized lower-cased Windows
   * separator paths, exact dev-vs-run path forms that refer to the same file
   * still resolve to the same outcome. It is intentionally NOT a heuristic:
   * if there is no scanId, there is no owner, and we do not guess.
   */
  private isAlreadyCachedScanArtifact(
    filePath: string,
    source: ThreatEvent["source"],
    options?: { scanId?: string },
  ): boolean {
    if (options?.scanId === undefined) return false;
    const entry = this.clamavPrefetches.get(options.scanId);
    if (entry === undefined) return false;
    return entry.files.has(ProtectionEngineService.prefetchKey(filePath));
  }

  async scanArtifact(
    filePath: string,
    source: ThreatEvent["source"],
    options?: {
      skipVirusTotal?: boolean;
      origin?: string;
      scanId?: string;
      clamavOutcome?: ClamavFileOutcome;
      /** Only automatic observations: OFF aborts queued/running background jobs. */
      backgroundSignal?: AbortSignal;
      /**
       * Classe na vaga global do ClamAV. Por omissão deriva do `scanId`: quem
       * pertence a um scan do utilizador (ScanManager) tem prioridade; as
       * análises automáticas (ficheiro observado, processo iniciado) não.
       */
      priority?: ClamavJobPriority;
      /**
       * USB: analise estritamente READ-ONLY. Nunca coloca em quarentena,
       * nunca escreve/move nada no dispositivo e forca skipVirusTotal.
       * Um scan USB nao pode alterar o que esta' a analisar.
       */
      readOnly?: boolean;
    },
  ): Promise<ServiceResponseMap["scan.artifact"]> {
    try {
      options?.backgroundSignal?.throwIfAborted();
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
            verdict: "inconclusive",
            analysisState: "excluded",
            detail: "Ficheiro excluído pela configuração; não foi analisado.",
            sha256: "",
          }],
          totalFiles: 1,
          highRiskCount: 0,
          overallSeverity: "low",
          rulesTriggered: [],
          riskScore: 0,
        };
      }

      let beforeFile: string;
      try {
        const stat = await fs.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) return this.publishInconclusiveFile(filePath, "O alvo não é um ficheiro regular; análise não realizada.", "no-verdict");
        beforeFile = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
      } catch {
        return options?.backgroundSignal?.aborted ? null : this.publishInconclusiveFile(filePath, "Ficheiro inacessível ou removido antes da análise.", "file-changed");
      }
      const analysis = await this.analyzer.analyze(filePath, undefined, undefined, {
        signal: options?.backgroundSignal ?? this.signalForScan(options?.scanId),
        // FASE 4: se o batch ja correu, o veredicto vem dai. Sem batch, o
        // analyzer corre o seu proprio scanFile.
        clamavOutcome: options?.clamavOutcome ?? this.clamavOutcomeFor(filePath, options?.scanId),
        // PRIORIDADE na vaga global do ClamAV. O default é explícito para que a
        // intenção fique legível no chamador: pertencer a um scan do utilizador
        // (tem scanId) dá prioridade; uma análise automática não a tem.
        priority: options?.priority ?? (options?.scanId ? "user" : "background"),
      });
      options?.backgroundSignal?.throwIfAborted();
      const nativeTiming = process.env.CYBERSAFE_DEBUG_SCAN === "1";
      const nativeStarted = nativeTiming ? Date.now() : 0;
      const nativeOutcome = await NativeEngineBridge.scan(filePath, {
        signal: options?.backgroundSignal ?? this.signalForScan(options?.scanId),
      });
      options?.backgroundSignal?.throwIfAborted();
      if (nativeTiming) console.log(`[ScanPerf] ENGINE_PHASE engine=native elapsedMs=${Date.now() - nativeStarted} outcome=${nativeOutcome.ok ? "completed" : nativeOutcome.failure ?? "output"}`);
      if (beforeFile !== undefined) {
        try {
          const stat = await fs.lstat(filePath);
          if (beforeFile !== `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`) return this.publishInconclusiveFile(filePath, "Ficheiro alterado durante a análise; o resultado anterior não foi aplicado.", "file-changed");
        } catch { return this.publishInconclusiveFile(filePath, "Ficheiro removido ou inacessível durante a análise.", "file-changed"); }
      }

      // Per-file coverage must come from this invocation, never cached health.
      const nativeCompleted = nativeOutcome.ok && nativeOutcome.result !== null;
      const nativeFailure = nativeCompleted ? undefined : nativeOutcome.failure ?? "output";
      const nativeEngine: import("@cybersafe/shared-types").NativeFileScanStatus = {
        status: nativeCompleted ? "completed" : nativeFailure === "unavailable" ? "unavailable"
          : nativeFailure === "cancelled" ? "cancelled" : "error",
        ...(nativeFailure ? { failure: nativeFailure } : {}),
      };
      const nativeDetail = nativeCompleted ? undefined
        : nativeFailure === "unavailable" ? "Motor nativo indisponível; verificação nativa não realizada."
        : nativeFailure === "cancelled" ? "Verificação do motor nativo interrompida; cobertura inconclusiva."
        : "Falha na verificação do motor nativo; cobertura inconclusiva.";

      // Consult VT if enabled
      let vtResult = null;
      let finalRiskScore = analysis.riskScore;
      let finalSeverity = analysis.severity;
      const hasStrongLocalEvidence = analysis.severity === "critical" && analysis.recommendedAction === "quarantined";

      if (nativeOutcome.ok && nativeOutcome.result) {
        const nativeScan = nativeOutcome.result;
        const nativeContribution = Math.max(0, Math.min(100, nativeScan.score) - finalRiskScore);
        finalRiskScore += nativeContribution;
        if (nativeScan.reasons.length > 0 || nativeContribution > 0) {
          analysis.rulesTriggered = Array.from(new Set([...analysis.rulesTriggered, ...nativeScan.reasons])) as import("@cybersafe/shared-types").HeuristicRuleId[];
          analysis.factors.push({ id: "native-scan", category: "heuristic", label: "Análise nativa: sinais heurísticos", weight: nativeContribution });
        }
      }

// Decisão de produto: quick/deep/custom (incluindo ZIPs) dispensam VT para
      // evitar 15,5 s por ficheiro. Com chave saudável, perdem o boost
      // min(40, positives * 5) e podem não escalar para high/critical: perda de
      // sensibilidade em massa aceite. Com HTTP 401, vtResult já seria null.
      // Ficheiro único e realtime/processos mantêm o enriquecimento por omissão.
      // Um scan USB e' estritamente read-only: nao fala com a rede sobre o
      // dispositivo nem toca em nada dele. `skipVirusTotal` fica forcado AQUI
      // para que nenhum chamador consiga esquecer-se.
      const readOnlyUsb = options?.readOnly === true;
      if (!readOnlyUsb && options?.skipVirusTotal !== true && this.vt.isEnabled() && analysis.sha256) {
        vtResult = await this.vt.scanHash(analysis.sha256, options?.origin || `scanArtifact:${source}`);
        if (vtResult && vtResult.positives > 0) {
          // If VT detects it, boost the risk score
          const vtBoost = Math.min(40, vtResult.positives * 5);
          const vtContribution = Math.min(100 - finalRiskScore, vtBoost);
          finalRiskScore += vtContribution;
          analysis.factors.push({ id: "virustotal", category: "signature", label: `VirusTotal: ${vtResult.positives} deteções`, weight: vtContribution });
        }
      }

      // Native PE/entropy signals and generic YARA are heuristics, not proof.
      options?.backgroundSignal?.throwIfAborted();
      // Match the existing process policy: >2 VT detections corroborate danger.
      const corroborated = hasStrongLocalEvidence || (vtResult?.positives ?? 0) > 2;
      if (!corroborated && finalRiskScore > DEFAULT_SETTINGS.thresholds.alertMax) {
        analysis.factors.push({ id: "service-evidence-bound", category: "heuristic", label: "Limite de risco sem corroboração", weight: DEFAULT_SETTINGS.thresholds.alertMax - finalRiskScore });
        finalRiskScore = DEFAULT_SETTINGS.thresholds.alertMax;
      }
      if (finalRiskScore > DEFAULT_SETTINGS.thresholds.alertMax) finalSeverity = "critical";
      else if (finalRiskScore > DEFAULT_SETTINGS.thresholds.monitorMax) finalSeverity = "high";
      analysis.riskScore = finalRiskScore;
      analysis.severity = finalSeverity;
      analysis.verdict = finalSeverity === "critical" ? "malicious" : finalSeverity !== "low" ? "suspicious" : analysis.verdict;
      analysis.recommendedAction = finalSeverity === "critical" ? "alerted"
        : finalRiskScore > DEFAULT_SETTINGS.thresholds.monitorMax ? "alerted"
        : finalRiskScore > DEFAULT_SETTINGS.thresholds.safeMax ? "logged" : "allowed";

      // A missing native result cannot turn into a negative verdict. Preserve
      // positive evidence from other engines while reporting incomplete coverage.
      if (!nativeCompleted && analysis.verdict === "safe") analysis.verdict = "inconclusive";
      // A positive detection and completed native scan do not prove that the
      // other engines evaluated this file. Use this invocation's structured
      // factors, never cached engine health, to retain upstream coverage gaps.
      const upstreamIncomplete = analysis.verdict === "inconclusive" ||
        analysis.rulesTriggered.includes("scan_inconclusive") ||
        analysis.factors.some(factor => ["clamav-inconclusive", "yara-inconclusive", "yara-timeout", "scan-cancelled"].includes(factor.id));
      const analysisState: import("@cybersafe/shared-types").FileScanResult["analysisState"] =
        !nativeCompleted ? nativeFailure === "unavailable" ? "engine-unavailable"
          : nativeFailure === "cancelled" ? "inconclusive" : "failed"
        : upstreamIncomplete ? "inconclusive" : "completed";
      // A causa e' um codigo desta invocacao. `coverageDetail` e' apenas texto.
      const inconclusiveReason: import("@cybersafe/shared-types").InconclusiveReason | undefined =
        !nativeCompleted
          ? nativeFailure === "unavailable" ? "engine-unavailable"
            : nativeFailure === "cancelled" ? "cancelled"
            : nativeFailure === "timeout" ? "timeout"
            : nativeFailure === "output" ? "invalid-output"
            : "engine-failed"
          : analysis.factors.some((factor) => factor.id === "scan-cancelled") ? "cancelled"
          : analysis.factors.some((factor) => factor.id === "yara-timeout") ? "timeout"
          : analysis.factors.some((factor) => ["clamav-inconclusive", "yara-inconclusive"].includes(factor.id)) ? "engine-failed"
          : upstreamIncomplete ? "coverage-incomplete"
          : undefined;
      const inconclusiveEngines: import("@cybersafe/shared-types").InconclusiveEngine[] = [
        ...(!nativeCompleted ? ["native" as const] : []),
        ...(analysis.factors.some((factor) => factor.id === "clamav-inconclusive") ? ["clamav" as const] : []),
        ...(analysis.factors.some((factor) => ["yara-inconclusive", "yara-timeout"].includes(factor.id)) ? ["yara" as const] : []),
      ];
      const coverageDetail = nativeDetail ?? (upstreamIncomplete
        ? "Pelo menos um motor não conseguiu avaliar o ficheiro; a deteção disponível foi preservada, mas a cobertura é inconclusiva."
        : undefined);

      // Read-only: a recomendacao tem de dizer o que o motor faz de facto.
      // Recomendar quarentena sem a executar faria a UI e o historico
      // afirmarem uma quarentena que nunca aconteceu.

      const threat: ThreatEvent = {
        source,
        sha256: analysis.sha256,
        url: `file://${filePath}`,
        domain: path.basename(filePath),
        severity: finalSeverity,
        confidence: analysis.confidence,
        rulesTriggered: analysis.rulesTriggered,
        createdAt: analysis.scanTimestamp,
        riskScore: finalRiskScore,
        action: analysis.recommendedAction,
        filePath,
        summary: analysis.factors.map((factor) => factor.label).join(", ") + (vtResult && vtResult.positives > 0 ? ` (+${vtResult.positives} deteções VT)` : ""),
      };

      // O mesmo criterio que a emissao de threat.detected em :936: medium tambem
      // conta como ameaca visivel na pagina Ameacas. Sem isto o scan mostrava 1
      // e a pagina Ameacas mostrava 0 para deteccoes medium.
      if (finalSeverity !== "low") {
        this.threats = [threat, ...this.threats].slice(0, 500);
        this.eventBus.publish("threat.detected", finalSeverity, `Ameaça detetada em ${analysis.fileName}`, {...threat});
        void this.logHistory({type:"threat.detected",threat:{...threat},timestamp:new Date().toISOString()});
      }

      if (finalSeverity === "critical") {
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
        if (!readOnlyUsb && canAutoQuarantine(this.quarantinePolicy, analysis)) {
          if (await this.requestQuarantine(analysis, "automatic")) {
            analysis.recommendedAction = "quarantined";
            threat.action = "quarantined";
          }
        }

      }

      this.eventBus.publish("artifact.analyzed", finalSeverity, `Analisado ${analysis.fileName}`, { ...analysis, vtResult, analysisState, inconclusiveReason, inconclusiveEngines, nativeEngine, detail: coverageDetail });


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
          analysisState,
          inconclusiveReason,
          inconclusiveEngines,
          nativeEngine,
          detail: coverageDetail,
          sha256: analysis.sha256,
        }],
        totalFiles: 1,
        highRiskCount: finalRiskScore > DEFAULT_SETTINGS.thresholds.monitorMax ? 1 : 0,
        overallSeverity: finalSeverity,
        rulesTriggered: analysis.rulesTriggered,
        riskScore: finalRiskScore,
      };
    } catch (err) {
      if (options?.backgroundSignal?.aborted) return null;
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
      return this.publishInconclusiveFile(filePath, "A análise falhou; não foi possível concluir um veredicto.", "engine-failed");
    }
  }

  async analyzeProcess(pid: number): Promise<ServiceResponseMap["process.analyze"] | null> {
    const processInfo = this.processes.find(p => p.pid === pid);
    if (!processInfo) return null;

    void this.actionsLog.write(`[INVESTIGATE] PID=${pid} | Name=${processInfo.name}`);

    let fileScan = null;
    let virusTotal = null;

if (processInfo.path) {
        // O utilizador clicou "analisar este processo": é trabalho PEDIDO, e por
        // isso tem prioridade sobre as análises automáticas na vaga do ClamAV.
        fileScan = await this.scanArtifact(processInfo.path, "service", {
          origin: "analyze_process",
          priority: "user",
        });
        if (fileScan?.results[0]?.sha256 && this.vt.isEnabled()) {
           virusTotal = await this.vt.scanHash(fileScan.results[0].sha256, "analyze_process");
        }
      }

    const isCritical = pid <= 100 || ["svchost.exe", "explorer.exe", "csrss.exe", "lsass.exe", "wininit.exe"].includes(processInfo.name.toLowerCase());

    // Um "error" do ClamAV NUNCA é "safe". O `verdict` do resultado carrega
    // `inconclusive` nesse caso; sem esta guarda a app desenhava um badge
    // VERDE com um escudo e a palavra "Seguro" por cima de um ficheiro que o
    // motor não conseguiu abrir.
    const scanInconclusive = fileScan?.results?.[0]?.verdict === "inconclusive";
    let recommendation: "safe" | "suspicious" | "dangerous" | "inconclusive" =
      scanInconclusive ? "inconclusive" : "safe";
    if (fileScan && fileScan.overallSeverity === "critical") recommendation = "dangerous";
    else if (fileScan && fileScan.overallSeverity === "high") recommendation = "suspicious";
    else if (virusTotal && virusTotal.positives > 2) recommendation = "dangerous";
    else if (virusTotal && virusTotal.positives > 0) recommendation = "suspicious";
    // WS-2: o sinal de CPU NAO e veredicto de seguranca. A linha anterior
      // (processInfo.cpu > 80 -> suspicious) foi removida: desempenho continua
    // visivel na UI como dado de desempenho, mas nunca como ameaca.

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
    this.eventBus.publish("scan.progress", "low", "A iniciar análise completa do sistema...", { progress: 0 });

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
             // Análise completa pedida pelo utilizador: prioridade de utilizador
             // (esta varredura antiga corre um ficheiro de cada vez, mas não
             // pode ser atropelada pelas análises automáticas).
             await this.scanArtifact(fullPath, "system-scanner", { priority: "user" });
             totalScanned++;

             // Publish progress every 10 files
             if (totalScanned % 10 === 0) {
                this.eventBus.publish("scan.progress", "low", `Analisados ${totalScanned} ficheiros...`, { progress: totalScanned });
             }
          }
        }
      } catch (err) {
        console.warn(`[FullScan] Failed to read directory ${scanPath}:`, err);
      }
    }

    this.eventBus.publish("scan.progress", "low", `Análise completa do sistema concluída. ${totalScanned} ficheiros analisados.`, { progress: 100, done: true, status: "completed", filesScanned: totalScanned, filesTotal: totalScanned, filesAnalyzed: totalScanned, threatsFound: 0, filesExcluded: 0, filesFailed: 0 });
  }

  async allowHash(sha256: string) {
    this.trust.allowHash(sha256);
    this.blockedHashes.delete(sha256.toLowerCase());
    this.eventBus.publish("trust.updated", "low", `Hash permitido ${sha256}`, { sha256 });
    return { success: true };
  }

  async allowPublisher(publisher: string) {
    this.trust.allowPublisher(publisher);
    this.eventBus.publish("trust.updated", "low", `Editor permitido ${publisher}`, { publisher });
    return { success: true };
  }

  async restoreQuarantine(id: string, trustAfterRestore = false) {
    const entry = this.quarantine.list().find((item) => item.id === id);
    const { success: restored, error } = await this.quarantine.restore(id, "desktop-ui");
    const success = restored === true;
    if (success && trustAfterRestore && entry?.sha256) {
      await this.allowHash(entry.sha256);
    }
    if (success) {
      this.eventBus.publish("quarantine.restored", "low", `Entrada de quarentena restaurada ${id}`, { id });
    }
    return { success, ...(error !== undefined ? { error } : {}) };
  }

  async deleteQuarantine(id: string) {
    // Sem evento publico: um "eliminado" nao tem tipo de evento proprio e
    // reaproveitar "restored" seria mentir sobre o que aconteceu ao ficheiro.
    return this.quarantine.delete(id);
  }

  /**
   * `definitions.status` — leitura do estado POR FONTE para a UI das definições.
   *
   * Sem side-effect e sem rede: é a memória do serviço + o `.update-meta.json`.
   * O que importa aqui é a honestidade dos cinco estados: um motor que não está
   * instalado não pode aparecer como «desactualizado» (sugeriria que bastava
   * esperar), e uma base parcial não pode aparecer como «actualizada» porque a
   * última tentativa correu. Por isso a saúde do motor tem precedência sobre a
   * idade da base, e a idade só é mostrada quando a saúde confirma cobertura.
   */
  async definitionsStatus(): Promise<DefinitionsStatus> {
    const agora = Date.now();
    const brutas = this.updater.estadoDasFontes(agora);
    const saudeClamav = this.clamav.health;
    const saudeYara = this.yara.health;

    let nomesDaBase: string[] = [];
    try {
      nomesDaBase = await fs.readdir(path.join(this.definitionsDir, "clamav"));
    } catch {
      nomesDaBase = [];
    }
    const diaria = nomesDaBase.find((n) => /^daily[-.]/i.test(n)) ?? null;

    const fontes: DefinitionsSourceStatus[] = brutas.map((bruta) => {
      const motor: "out" | "degradado" | "ok" =
        bruta.fonte === "clamav"
          ? saudeClamav.status === "active"
            ? "ok"
            : saudeClamav.status === "degraded"
              ? "degradado"
              : "out"
          : bruta.fonte === "yara"
            ? saudeYara.status === "error" || saudeYara.status === "unavailable"
              ? "out"
              : saudeYara.status !== "active"
                ? "degradado"
                : "ok"
            : "ok";
      let estado: DefinitionsSourceState;
      if (motor === "out") {
        estado = bruta.nuncaVerificado ? "nunca_verificado" : "indisponivel";
      } else if (motor === "degradado" || bruta.emBackoff) {
        estado = "degradado";
      } else if (bruta.ultimaBemSucedidaAtMs === null) {
        estado = "nunca_verificado";
      } else {
        estado =
          agora - bruta.ultimaBemSucedidaAtMs > bruta.cadenciaMs ? "desactualizado" : "actualizado";
      }
      return {
        fonte: bruta.fonte,
        estado,
        ultimaBemSucedidaAtMs: bruta.ultimaBemSucedidaAtMs,
        ultimaTentativaAtMs: bruta.ultimaTentativaAtMs,
        ultimoErro: bruta.ultimoErro,
        tentativasConsecutivas: bruta.tentativasConsecutivas,
        proximaVerificacaoAtMs: bruta.proximaVerificacaoAtMs,
        cadenciaMs: bruta.cadenciaMs,
        identificadorBase:
          bruta.fonte === "clamav" ? diaria : bruta.fonte === "hashes" ? "hashes/default.json" : "yara/default.yar",
        itensCarregados:
          bruta.fonte === "hashes"
            ? this.signatures.size
            : bruta.fonte === "clamav"
              ? nomesDaBase.filter((n) => /\.(cvd|cld)$/i.test(n)).length || null
              : null,
      };
    });

    return { fontes, cicloEmCurso: this.updater.operationInProgress, geradoEmMs: agora };
  }

  async updateDefinitions() {
    // `""` é "nunca atualizado", não uma data. O contrato devolve null nesse caso.
    const anterior = this.definitionsUpdatedAt || null;
    try {
      // A instância partilhada assegura que a atualização manual e o scheduler
      // executam os mesmos gates e recarregam os motores pelo mesmo callback.
      // O que se devolve são as FLAGS reais do updater: terminar não prova que
      // os três conjuntos de definições mudaram.
      const result = await this.updater.checkAndUpdate(true);
      const response = createDefinitionsUpdateResult(result, anterior, new Date().toISOString());
      if (response.yaraUpdated || response.clamUpdated || response.hashesUpdated) {
        this.definitionsUpdatedAt = response.checkedAt;
      }
      // Os nomes dos componentes só aparecem na mensagem quando os três
      // confirmam: "atualizado" sem dizer o quê seria mais honesto do que uma
      // frase completa construída sobre flags que não foram todas verdade.
      this.eventBus.publish("engine.health", response.success ? "low" : "medium",
        response.success
          ? `Definições atualizadas (YARA: ${response.yaraUpdated}, ClamAV: ${response.clamUpdated}, Hashes: ${response.hashesUpdated})`
          : "Atualização de definições incompleta ou com avisos", response);
      return response;
    } catch (err: any) {
      console.error("[Engine] Falha ao atualizar definições:", err);
      const checkedAt = new Date().toISOString();
      return createDefinitionsUpdateResult({
        yaraUpdated: false, clamUpdated: false, hashesUpdated: false,
        errors: ["O serviço não confirmou a atualização de definições."], warnings: [], timestamp: checkedAt,
      }, anterior, checkedAt);
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

    // Mapa `pid -> ppid` do snapshot, para a regra DIRECIONAL de descendência:
    // "o selfPid está na cadeia de ancestrais DO ALVO?". Sem este mapa, um
    // helper a dois níveis (serviço -> helper -> worker) não seria protegido.
    //
    // É o inverso de `ancestorPids`: aquele sobe a partir do serviço, este
    // permite subir a partir de qualquer alvo. O ancestral partilhado
    // (explorer) aparece nos dois lados e não protege nada — é essa a
    // direcionalidade que elimina o falso positivo.
    const parentOf: Record<number, number> = {};
    for (const entry of this.processes) {
      if (Number.isInteger(entry.ppid) && entry.ppid > 0) parentOf[entry.pid] = entry.ppid;
    }

    return {
      selfPid: process.pid,
      ancestorPids: [...ancestorPids],
      parentOf,
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
   * MEDIÇÃO DE 2026-09-30 (substitui os 0,3 s acima, que eram falsos):
   * `snapshotProcesses()` medido em 652, 284, 574, 582, 591, 594 ms —
   * MEDIANA 591 ms, MAX 652 ms, com 355+ processos. O custo real de UMA
   * enumeração é ~0,6 s, não 0,3 s. Daí o cálculo da cadência adaptativa:
   * 591/2000 = 29,6% de um núcleo enquanto há observador; 591/10000 = 5,9%
   * em repouso. Se este número mudar, mede-se de novo — nunca por palpite.
   *
   * Regra que isto NÃO pode perder: um cache mais velho que o TTL obriga a
   * reconciliação on-demand (é a única forma de o cache liar), e um PID
   * tombstonado nunca reentra por nenhum dos dois caminhos.
   */
  private static readonly PROCESS_TRUTH_TTL_MS = PROCESS_POLL_INTERVAL_MS * 2;

  /**
   * Depois de uma enumeração falhada, a próxima leitura tenta de novo passado
   * este intervalo, mesmo que ainda exista uma foto dentro do TTL. Sem isto,
   * uma falha ficava 2×PROCESS_POLL_INTERVAL_MS a servir cache como se a
   * última tentativa tivesse sido boa. Não é um limiter de leitura: é o
   * intervalo mínimo entre tentativas de RECUPERAÇÃO depois de erro.
   */
  private static readonly PROCESS_RETRY_AFTER_FAILURE_MS = 1_000;

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
    this.processBirthsDuringEnumeration?.delete(pid);
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
   * Verdade da enumeração SEM linhas e SEM origem: é a leitura do estado, não a
   * resposta a um pedido. Quem serve a lista usa `composeProcessesTruth`, que
   * sabe de onde vêm as linhas; aqui `servedFrom` não tem significado, e por
   * isso é `null` em vez de um palpite.
   */
  get processesTruth(): Omit<ProcessEnumerationTruth, "servedFrom"> & { servedFrom: null } {
    const { servedFrom: _origem, ...resto } = this.composeProcessesTruth("cache");
    return { ...resto, servedFrom: null };
  }

  /**
   * Compõe o `ProcessEnumerationTruth` a partir do registo de tentativas.
   *
   * `servedFrom` é decidido por quem chama (a foto que acabou de chegar, ou o
   * que já cá estava). A idade afirmada é sempre a da FOTO (`processesPhotoAt`),
   * nunca o instante em que a resposta foi composta — foi exatamente essa
   * confusão, feita do lado do cliente, que permitia ler cache velho como actual.
   */
  private composeProcessesTruth(servedFrom: "snapshot" | "cache"): ProcessEnumerationTruth {
    const attempt = this.processesAttempt;
    const state: ProcessEnumerationTruth["state"] = !attempt
      ? "never"
      : attempt.finishedAt === null
        ? "in-progress"
        : attempt.ok
          ? "ok"
          : "failed";
    return {
      state,
      enumeratedAt: this.processesPhotoAt > 0 ? this.processesPhotoAt : null,
      servedFrom,
      attempt: attempt ? { ...attempt } : null,
      asOf: Date.now(),
    };
  }

  /**
   * processes.list com reconciliação on-demand: a fonte de verdade é o SO
   * (`processMonitor.list()`), não o cache de eventos. Antes disto, o handler
   * devolvia só o cache (cap silencioso de 200, nunca re-enumerava) e o
   * "refresh" da UI nunca via a realidade — processos reais ficavam invisíveis.
   *
   * P1-PROCESS-TRUTH: Enumeração falhou → serve o que existir, mas diz que
   * falhou. O `catch` já não apaga o facto: as linhas vêm com `truth.state`
   * `"failed"` e o motivo, e `enumeratedAt` continua a ser a idade da última
   * foto boa (ou `null` se nunca a houve). Devolver `[]` nu era afirmar «este
   * computador não tem processos».
   */
  async listProcesses(): Promise<ProcessListResult> {
    // P0 de latência: este pedido é o sinal de "há alguém a olhar". O
    // ProcessMonitor usa-o para passar da cadência lenta (10 s) à rápida (2 s)
    // e volta atrás sozinho quando os pedidos param. Não é preciso a UI
    // dizer em que página está: pedir a lista já é olhar.
    this.processMonitor.noteObserver();

    const cached = this.withoutTombstoned(this.processes);
    // Uma falha recente não invalida a foto imediatamente (não se apaga a
    // última verdade). Durante o intervalo de retry serve-se a cache com
    // `truth.state=failed` (evita uma tempestade de PowerShell); passado esse
    // intervalo a próxima leitura vai AO SO, mesmo que a foto ainda esteja
    // dentro do TTL — é isto que fecha a recuperação depois de um erro.
    const failedAt =
      this.processesAttempt !== null && this.processesAttempt.ok === false
        ? this.processesAttempt.finishedAt
        : null;
    const retryDue =
      failedAt !== null &&
      Date.now() - failedAt >= ProtectionEngineService.PROCESS_RETRY_AFTER_FAILURE_MS;
    const withinFailureRetryWindow = failedAt !== null && !retryDue;
    if (
      cached.length > 0 &&
      !retryDue &&
      (withinFailureRetryWindow ||
        Date.now() - this.processesEnumeratedAt < ProtectionEngineService.PROCESS_TRUTH_TTL_MS)
    ) {
      return { processes: cached, truth: this.composeProcessesTruth("cache") };
    }
    if (!this.processesEnumerating) {
      const startedAt = Date.now();
      this.processesAttempt = { startedAt, finishedAt: null, ok: false };
      this.processBirthsDuringEnumeration = new Map();
      this.processesEnumerating = (async () => {
        let falhou = false;
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
          // A7 — a reconciliação é parte do CONSUMO do snapshot, não uma função que só
          // os testes chamavam. Corre ANTES de `this.processes` ser substituído
          // e antes de qualquer decisão que use o registo, para que a foto do
          // SO seja o que reconcilia, e preserva a distinção entre ausência
          // (o registo fica) e contradição (o registo morre). Isto não
          // dispensa validação de identidade no ponto de decisão — o veredicto
          // continua a ser dado por `classifyOwnChild`.
          this.reconcileOwnChildren(fresh);
          this.processes = this.withoutTombstoned(this.mergeEventObserved(fresh));
          this.processesEnumeratedAt = Date.now();
          this.processesPhotoAt = this.processesEnumeratedAt;
          this.processesAttempt = { startedAt, finishedAt: Date.now(), ok: true };
        } catch (error) {
          console.error("[Service] processes.list: falhou a enumeração do SO; a servir a última lista conhecida como degrada:", error);
          this.processesAttempt = {
            startedAt,
            finishedAt: Date.now(),
            ok: false,
            error: classifyProcessEnumerationError(error),
          };
          falhou = true;
        } finally {
          this.processBirthsDuringEnumeration = null;
          this.processesEnumerating = null;
        }
        // `servedFrom` descreve o que FOI servido, não o ramo que foi tomado:
        // quando a tentativa rebenta, as linhas são as que já cá estavam (ou
        // nenhuma), e dizer «snapshot» seria afirmar uma foto que não existe.
        return { rows: this.processes, servedFrom: falhou ? ("cache" as const) : ("snapshot" as const) };
      })();
    }
    const { rows, servedFrom } = await this.processesEnumerating;
    return { processes: rows, truth: this.composeProcessesTruth(servedFrom) };
  }

  /**
   * Foto do SO + o que o monitor-publicou durante a foto. Só entra o que ainda
   * está no cache de eventos: um processo que saiu foi removido do cache e
   * tombstonado, portanto não pode ser ressuscitado por aqui.
   */
  private mergeEventObserved(fresh: ProcessSnapshot[]): ProcessSnapshot[] {
    const byPid = new Map(fresh.map((entry) => [entry.pid, entry]));
    for (const born of this.processBirthsDuringEnumeration?.values() ?? []) {
      byPid.set(born.pid, born);
    }
    return Array.from(byPid.values());
  }

  /**
   * CIM query com FILTRO ALVO (A1): um único PowerShell com WQL exato
   * (ProcessId=n / Name='x') — barato (~0.3–1 s) vs a enumeração completa
   * (~2 s) que o caminho do kill fazia antes em cada PID fora do cache.
   *
   * CONTRATO R1: falha de fonte LANÇA. «Não consegui perguntar» nunca pode ser
   * a mesma resposta que «o PID não existe»; quem quer tolerância (diagnóstico
   * de alias) chama um wrapper explícito. Seam de teste: substituível.
   */
  async queryCimProcesses(cimFilter: string, timeoutMs = ProtectionEngineService.CIM_QUERY_TIMEOUT_MS): Promise<Array<KillTargetInfo & { startedAt?: string }>> {
    try {
      return await this.runCimQuery(cimFilter, timeoutMs);
    } catch (error) {
      console.warn(`[Service] CIM query falhou (${cimFilter}):`, (error as Error)?.message ?? error);
      throw error;
    }
  }

  /**
   * Query CIM ESTRITA: uma falha lança. É a versão usada pela revalidação
   * pré-kill, onde «não há linha» e «não consegui perguntar» não podem ser a
   * mesma resposta — a primeira é um PID que já não existe, a segunda é uma
   * identidade que não foi provada. Nessa segunda, nenhuma ação é executada.
   */
  private async runCimQuery(cimFilter: string, timeoutMs = ProtectionEngineService.CIM_QUERY_TIMEOUT_MS): Promise<Array<KillTargetInfo & { startedAt?: string }>> {
    const psLiteral = `'${cimFilter.replace(/'/g, "''")}'`;
    const script =
      "$ErrorActionPreference='Stop';" +
      ` Get-CimInstance -ClassName Win32_Process -Filter ${psLiteral}` +
      " | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,@{n='CreatedIso';e={$_.CreationDate.ToUniversalTime().ToString('o')}}" +
      " | ConvertTo-Json -Compress";
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
        // Timestamp DA FONTE (CreationDate), não o instante da query. É a
        // identidade usada para recusar ações sobre um PID reutilizado.
        startedAt: raw.CreatedIso ? String(raw.CreatedIso) : undefined,
      }))
      .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
  }

  /** Identidade de UM PID por query-alvo — não enumera o SO (A1). */
  private async lookupProcessByPid(
    pid: number,
    timeoutMs?: number,
  ): Promise<(KillTargetInfo & { startedAt?: string }) | undefined> {
    const rows = await this.queryCimProcesses(`ProcessId=${pid}`, timeoutMs);
    return rows.find((entry) => entry.pid === pid);
  }

  private async findLiveProcessesByName(name: string, timeoutMs?: number): Promise<KillTargetInfo[]> {
    // Reconcílio de alias é DIAGNÓSTICO depois de o taskkill já ter dito
    // not-found; uma falha de CIM aqui não pode inventar uma instância viva.
    // Por isso este é o único caminho tolerante explícito.
    try {
      return await this.queryCimProcesses(`Name='${name.replace(/'/g, "''")}'`, timeoutMs);
    } catch {
      return [];
    }
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
    try {
      const row = await this.lookupProcessByPid(pid, timeoutMs);
      return !!row;
    } catch {
      // CIM indisponível: não provou ausência. "Vivo/desconhecido" é o lado
      // seguro — evita retry e evita declarar morte sem testemunha.
      return true;
    }
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

  private individualTermination: SafeProcessTermination | null = null;
  private criticalRpcOperations = 0;

  private terminationBlocked(identity?: TerminationIdentity): string | null {
    const gate = this.clamDatabaseGate.state;
    // Cada causa tem o seu codigo: a UI nao pode dizer "operacao critica" a quem
    // so precisa de saber que a sessao nao esta autenticada ou que ha um scan a
    // correr. O bloqueio mantem-se exatamente o mesmo; so a RAZAO fica nomeada.
    if (!this.pipeAuthRequired || !this.pipeToken) return "session-unauthenticated";
    if (this.disposed || this.isShuttingDown) return "service-shutting-down";
    if (this.startupStateValue !== "ready") return "service-not-ready";
    if (process.env.CYBERSAFE_DEV_WINDOWS_READONLY === "1" ||
        process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN === "1") return "readonly-mode";
    if (this.criticalRpcOperations > 0 || this.protectionTransition || this.protectionStopUnconfirmed) return "critical-operation";
    if (this.fileObservationReads > 0 || this.realtimeQueue.size > 0 || this.realtimeQueue.active > 0 || this.clamavPrefetches.size > 0) return "realtime-work-in-progress";
    if (this.scanAbortControllers.size > 0 || this.scanManager.getActiveScan()) return "scan-in-progress";
    if (this.updater.operationInProgress || gate.activeScans > 0 || gate.updatePending || gate.updateActive) return "definitions-update-in-progress";
    if (identity) {
      const cached = this.processes.find(p => p.pid === identity.pid);
      if (!cached || !matchesSnapshotCreation(cached.startedAt,identity.creation) ||
          classifyKillTarget({...cached, path:identity.path, name:identity.name}, this.killProtectionContext()) ||
          this.ownChildPids.has(identity.pid)) return "protected-or-identity-unconfirmed";
    }
    return null;
  }

  private nativeTerminationOpen: ReturnType<typeof createWindowsTerminationOpener> | null = null;
  private openIndividualProcess(pid:number) {
    this.nativeTerminationOpen ??= createWindowsTerminationOpener();
    return this.nativeTerminationOpen(pid);
  }

  private terminationController(): SafeProcessTermination {
    if (!this.individualTermination) {
      // Binding is lazy, after normal startup/readonly guards, never at import.
      const open = (pid:number) => this.openIndividualProcess(pid);
      this.individualTermination = new SafeProcessTermination({
        open, blocked: identity => this.terminationBlocked(identity),
        audit: event => {
          void fs.appendFile(path.join(this.logsDir,"actions.log"), JSON.stringify({
            timestamp:new Date().toISOString(), action:"process.termination", ...event,
          })+"\n", "utf-8").catch(()=>{});
          if (event.status === "killed") {
            this.eventBus.publish("process.killed", "low", `Processo terminado pelo CyberSafe (PID ${event.pid})`, {
              pid:event.pid, source:event.source, operationId:event.operationId, confirmed:true, scope:"single-process",
            });
          }
        },
      });
    }
    return this.individualTermination;
  }

  private async confirmIndividualProcess(ticket:unknown) {
    const result = await this.individualTermination?.confirm(ticket) ?? {
      success:false,status:"failed" as const,pid:0,error:"Confirmação ausente ou expirada.",
    };
    if (["killed","already-exited","reused","timeout"].includes(result.status)) {
      // Do not remove rows by PID: the OS may already have reused it. Let an
      // existing enumeration settle, then force the next processes-only refresh
      // to ask Windows rather than serving the pre-operation TTL cache.
      await this.processesEnumerating?.catch(()=>{});
      this.processesEnumeratedAt=0;
      this.processesAttempt=null;
    }
    return result;
  }

  async killProcess(pid: number): Promise<ProcessKillResult> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { success: false, status: "failed", pid, error: "PID inválido" };
    }

    if (ProtectionEngineService.KILL_TERMINATION_DISABLED) {
      // Fail-closed: sem ação, sem consulta, sem tentativa. Registar apenas
      // a recusa global, sem inventar identidade ou classificação do alvo.
      await this.actionsLog.write(JSON.stringify({
        timestamp: new Date().toISOString(),
        action: "process.termination.refused",
        request: "manual",
        requestId: this.nextKillRequestId(pid),
        pid,
        reason: "legacy-disabled",
        executed: false,
      }));
      return {
        success: false,
        status: "failed",
        pid,
        error: "Terminação de processos indisponível: identidade não pode ser provada de ponta a ponta; nenhuma ação foi executada.",
      };
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

    let processInfo: (KillTargetInfo & { startedAt?: string }) | undefined =
      this.processes.find((p) => p.pid === pid);
    const processInfoFromCache = processInfo !== undefined;

    // Auto-proteção por PID/ppid/path antes de qualquer query. Sem cache, o
    // PID 4/self continua a ser recusado sem ir ao CIM; com cache, a identidade
    // real é aplicada logo abaixo, uma única vez.
    const protecaoInicial = classifyKillTarget(processInfo ?? { pid }, this.killProtectionContext());
    if (protecaoInicial) {
      console.warn(`[Service] Blocked attempt to kill protected process PID: ${pid} (${protecaoInicial})`);
      // A recusa acontece ANTES de qualquer taskkill, e portanto ANTES do
      // `logKillAttempt`. Sem esta linha a unica prova vivia num console.warn
      // efemero — foi o que impediu o diagnostico do falso positivo `internal`.
      this.logKillBlocked("manual", processInfo ?? { pid }, protecaoInicial, this.nextKillRequestId(pid));
      return {
        success: false,
        status: "protected",
        pid,
        protectedReason: protecaoInicial,
        error: "Cannot terminate protected CyberSafe/system process",
      };
    }

    // Sem cache: consultar o OS para CLASSIFICAR proteção, nunca para autorizar
    // a ação. Uma linha fresca do CIM, sozinha, não prova que o PID selecionado
    // pelo utilizador era este; falta a referência do snapshot.
    let sourceError: unknown = null;
    if (!processInfo && isProcessAlive(pid)) {
      try {
        processInfo = await this.lookupProcessByPid(pid, step(ProtectionEngineService.CIM_QUERY_TIMEOUT_MS));
      } catch (error) {
        sourceError = error;
      }
    }

    // A linha do CIM (quando existe) pode revelar proteção por path/ancestral
    // que o PID sozinho não revelava. Continua a ser recusa, nunca ação.
    if (!processInfoFromCache) {
      const protecaoFonte = classifyKillTarget(processInfo ?? { pid }, this.killProtectionContext());
      if (protecaoFonte) {
        this.logKillBlocked("manual", processInfo ?? { pid }, protecaoFonte, this.nextKillRequestId(pid));
        return {
          success: false,
          status: "protected",
          pid,
          protectedReason: protecaoFonte,
          error: "Cannot terminate protected CyberSafe/system process",
        };
      }
      if (!processInfo) {
        if (!isProcessAlive(pid)) return { success: true, status: "already-exited", pid };
        return {
          success: false,
          status: "failed",
          pid,
          error: sourceError
            ? `Identidade do processo não confirmada: a fonte CIM falhou (${(sourceError as Error)?.message ?? String(sourceError)}); terminação recusada.`
            : `Identidade do processo não confirmada: o CIM não devolveu o PID ${pid}, mas o processo está vivo; terminação recusada.`,
        };
      }
      // Existe linha, mas não existe referência de snapshot do utilizador.
      // Nome/comando iguais não substituem a seleção que originou o pedido.
      return {
        success: false,
        status: "failed",
        pid,
        target: { name: processInfo.name, path: processInfo.path },
        error: `Identidade do processo não confirmada: o PID ${pid} não tem referência no snapshot; terminação recusada.`,
      };
    }

    // ── Identidade de criação: a referência é o SNAPSHOT, não a idade do PID ──
    // A comparação só autoriza com CreationDate válida dos dois lados. Uma data
    // em falta/inválida/futura é "não provado" e recusa — nome/comando iguais
    // não são identidade. A idade do processo não diz se a seleção que o
    // utilizador viu ainda descreve o dono do PID; e a foto, por fresca que
    // seja, não prova que o dono não mudou — a fonte é revalidada em TODA a
    // ação (abaixo).
    if (!processInfo) {
      return {
        success: false,
        status: "failed",
        pid,
        error: "Identidade do processo não confirmada: referência de snapshot ausente; terminação recusada.",
      };
    }
    const cacheCriacao = trustedCreationIdentity(processInfo.startedAt);
    if (!cacheCriacao) {
      return {
        success: false,
        status: "failed",
        pid,
        target: processInfo ? { name: processInfo.name, path: processInfo.path } : undefined,
        error: "Identidade do processo não confirmada: CreationDate ausente ou inválida no snapshot; terminação recusada.",
      };
    }
    // ── A fonte é consultada ANTES de agir, SEMPRE ─────────────────────────
    // A idade da foto é metadado de cache, não identidade: dentro da própria
    // janela de frescura o processo pode ter morrido e o PID sido reciclado.
    // Uma foto de 1 ms não pode dispensar a fonte. (FINDING-FRESH-PID-REUSE:
    // foto fresca + mesmo nome/comando com outra CreationDate chegava ao
    // taskkill sem a fonte ser consultada.)
    let fresco: (KillTargetInfo & { startedAt?: string }) | undefined;
    try {
      const linhas = await this.queryCimProcesses(
        `ProcessId=${pid}`,
        step(ProtectionEngineService.CIM_QUERY_TIMEOUT_MS),
      );
      fresco = linhas.find((entry) => entry.pid === pid);
    } catch (error) {
      // Não se provou que o alvo mudou NEM que morreu: não se age. Um CIM
      // indisponível não é um PID morto.
      return {
        success: false,
        status: "failed",
        pid,
        error: `Identidade do processo não confirmada: a fonte CIM falhou (${(error as Error)?.message ?? String(error)}); terminação recusada.`,
      };
    }
    if (!fresco) {
      this.dropCachedProcess(pid, processInfo, { tombstone: true, invalidateTruth: true });
      return { success: true, status: "already-exited", pid };
    }
    const fonteCriacao = trustedCreationIdentity(fresco.startedAt);
    if (!fonteCriacao) {
      return {
        success: false,
        status: "failed",
        pid,
        target: { name: fresco.name, path: fresco.path },
        error: "Identidade do processo não confirmada: a fonte não devolveu CreationDate válida; terminação recusada.",
      };
    }
    const identidadeMudou = killTargetIdentity(fresco) !== killTargetIdentity(processInfo);
    const criacaoMudou = fonteCriacao !== cacheCriacao;
    if (identidadeMudou || criacaoMudou) {
      // O registo cacheado descreve um processo que já não é este PID. Não se
      // tombstone: o PID está vivo e pertence a outro processo.
      this.dropCachedProcess(pid, processInfo, { tombstone: false, invalidateTruth: true });
      return {
        success: false,
        status: "reused",
        pid,
        error: "PID reutilizado por outro processo; terminação recusada.",
      };
    }
    // A linha fresca é a fonte para o resto do caminho (logs/target).
    processInfo = fresco;

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
      // afirma seja o que for. Se o CIM falhar a meio, não há testemunha para
      // dizer que a árvore caiu: falha explícita, nunca killed inventado.
      let sweep: { killed: number[]; survived: number[]; refusedProtected: number[] };
      try {
        sweep = await this.sweepProcessTree(pid, step);
      } catch (error) {
        return {
          success: false,
          status: "failed",
          pid,
          exitCode: taskkill.exitCode,
          error: `Árvore não confirmada: a fonte CIM falhou (${(error as Error)?.message ?? String(error)}); terminação não declarada.`,
        };
      }
      const rootAlive = await this.killTargetStillAlive(pid, step(ProtectionEngineService.KILL_ALIAS_QUERY_TIMEOUT_MS));

      if (!rootAlive && sweep.survived.length === 0) {
        // Raiz confirmada morta pelo Windows e nada da arvore sobreviveu: e um
        // kill concluido, nao um sucesso inventado a partir de um exit code.
        this.dropCachedProcess(pid, processInfo, { tombstone: true, invalidateTruth: true });
        this.eventBus.publish("process.killed", "critical", `Árvore de processos terminada ${pid}`, { pid, name: processInfo?.name });
        this.eventBus.publish("process.exited", "low", `Processo terminado: ${processInfo?.name ?? pid}`, processInfo ?? { pid });
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
        let current: (KillTargetInfo & { startedAt?: string }) | undefined;
        try {
          const linhas = await this.queryCimProcesses(
            `ProcessId=${candidate}`,
            step(ProtectionEngineService.CIM_QUERY_TIMEOUT_MS),
          );
          current = linhas.find((entry) => entry.pid === candidate);
        } catch {
          // Falha de CIM não é ausência: a streak NÃO avança e o processo não
          // pode ser declarado morto por uma pergunta que não obteve resposta.
          return { alive: true };
        }
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
    this.eventBus.publish("process.killed", "critical", `Árvore de processos terminada ${pid}`, { pid, name: processInfo?.name });
    this.eventBus.publish("process.exited", "low", `Processo terminado: ${processInfo?.name ?? pid}`, processInfo ?? { pid });

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
        summary: `Análise ${scanState.status}: ${scanState.filesScanned} ficheiros, ${scanState.threatsFound} ameaças`,
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
    // Backpressure de saída: um peer que não lê acumulava respostas (incluindo
    // recusas "busy") sem limite no buffer do socket. Fechar é preferível a
    // crescer memória em nome de um cliente que não consome.
    if (socket.writableLength > RPC_MAX_OUTBOUND_BYTES) {
      this.clients.delete(socket);
      socket.destroy();
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
    const requests = new RpcRequestQueue(4, RPC_MAX_PENDING_PER_CLIENT);
    socket.once("close", () => requests.close());
    let buffer = "";
    // AUD-002: `chunk.toString()` cortava um caractere multibyte ao meio e
    // deixava U+FFFD no payload. O StringDecoder recompõe os bytes entre chunks.
    const decoder = new StringDecoder("utf8");
    // Marcado antes de qualquer escrita: nenhum chunk posterior é aceite.
    const state = { protocolClosed: false };

    // Sem este handler, um EPIPE/ECONNRESET assíncrono (o Electron fecha o
    // pipe antes de lermos a resposta) subia como uncaught exception.
    socket.on("error", (err) => this.handleSocketFailure(socket, err));

    socket.on("data", (chunk: Buffer) => {
      if (state.protocolClosed || socket.destroyed) return;
      buffer += decoder.write(chunk);
      const decoded = decodeMessagesBounded(buffer, {
        maxFrameBytes: RPC_MAX_FRAME_BYTES,
        maxRestBytes: RPC_MAX_REST_BYTES,
        maxMessages: RPC_MAX_MESSAGES_PER_CHUNK,
      });
      buffer = decoded.rest;
      if (decoded.error) {
        // Limite/JSON inválido: fechar é mais seguro do que continuar a
        // interpretar bytes de um cliente que não respeita o contrato.
        this.closeClientForProtocol(socket, requests, state, decoded.error);
        return;
      }
      for (const message of decoded.messages) {
        const request = message as RpcRequest;
        if (!request || typeof request !== "object" || request.type !== "request") continue;
        if (!this.isValidRpcEnvelope(request)) {
          this.closeClientForProtocol(socket, requests, state, "invalid-envelope");
          return;
        }
        const enqueuedAt = performance.now();
        const accepted = requests.enqueue(INDEPENDENT_READ_METHODS.has(request.method), async () => {
          const start = performance.now();
          const response = await this.handleRequest(request);
          // Só nomes canónicos e duração; nenhum payload, PID, caminho ou segredo.
          if (process.env.CYBERSAFE_DEBUG_BRIDGE === "1" && INDEPENDENT_READ_METHODS.has(request.method)) {
            console.log(`[rpc-latency] id=${/^req-\d+$/.test(request.id) ? request.id : "noncanonical"} method=${request.method} queueMs=${(start-enqueuedAt).toFixed(1)} executionMs=${(performance.now()-start).toFixed(1)} totalMs=${(performance.now()-enqueuedAt).toFixed(1)} ok=${response.ok}`);
          }
          this.safeWrite(socket, encodeMessage(response));
        });
        if (!accepted) {
          // Backpressure explícito: o cliente recebe uma recusa com o id do
          // pedido. Nunca empurrar para uma fila sem tecto, nem desaparecer.
          // Peer que não lê: recusas ilimitadas também enchem o socket.
          if (socket.writableLength > RPC_MAX_OUTBOUND_BYTES) {
            this.closeClientForProtocol(socket, requests, state, "outbound-backpressure");
            return;
          }
          this.safeWrite(socket, encodeMessage({
            id: request.id,
            type: "response",
            ok: false,
            error: "Serviço ocupado: demasiados pedidos pendentes nesta ligação.",
          }));
        }
      }
    });

    socket.on("end", () => this.clients.delete(socket));
    socket.on("close", () => this.clients.delete(socket));

    const lastEvent = this.eventBus.getReplay().at(-1);
    if (lastEvent) {
      this.safeWrite(socket, encodeMessage({ type: "event", event: lastEvent }));
    }
  }


  /**
   * Contrato mínimo do envelope. Os limites de comprimento existem para que a
   * própria validação não seja um caminho de memória ilimitada.
   */
  private isValidRpcEnvelope(request: RpcRequest): boolean {
    return typeof request.id === "string" && request.id.length > 0 && request.id.length <= 64 &&
      typeof request.method === "string" && request.method.length > 0 && request.method.length <= 64;
  }

  /**
   * Fecho controlado por violação de protocolo (nunca por um pedido válido).
   *
   * `state.protocolClosed` é marcado ANTES de qualquer escrita: entre a decisão
   * e o `destroy` ainda chegam chunks, e nenhum pode ser aceite/enfileirado.
   * `pause()` trava leitura nova; o fecho é determinístico — uma vez por
   * ligação — e a razão é fixa, sem eco de bytes recebidos.
   */
  private closeClientForProtocol(
    socket: net.Socket,
    requests: RpcRequestQueue,
    state: { protocolClosed: boolean },
    reason: string,
  ) {
    if (state.protocolClosed) return;
    state.protocolClosed = true;
    requests.close();
    this.clients.delete(socket);
    try {
      socket.pause();
    } catch {
      /* socket já inutilizável */
    }
    if (socket.destroyed || this.isShuttingDown) {
      socket.destroy();
      return;
    }
    console.warn(`[Service] ligação RPC encerrada: ${reason}`);
    this.safeWrite(socket, encodeMessage({ type: "error", error: "Protocolo RPC inválido; ligação encerrada." }));
    socket.end();
    const timer = setTimeout(() => socket.destroy(), 100);
    timer.unref();
  }

  /**
   * Handshake de posse v2 — nenhum pedido, replay ou identidade é exposto antes
   * de as DUAS partes provarem conhecer o segredo, e o segredo nunca passa pelo
   * pipe.
   *
   * Fases: `auth-hello(clientNonce)` → `auth-challenge(serverNonce, prova do
   * servidor)` → `auth-response(prova do cliente)` → `{auth, ok:true}` e só então
   * `attachClientSocket`. As provas são HMAC do helper puro (`@cybersafe/core`),
   * com o papel dentro do domínio: a prova do servidor não serve como prova do
   * cliente, e vice-versa.
   *
   * Um `{auth, ok:true}` isolado — o que um listener arbitrário consegue enviar —
   * NÃO autoriza nada, e um primeiro frame `{type:"auth", token}` (cliente
   * legado v1) é recusado em vez de aceite: não há downgrade em produção.
   */
  private authenticateClientSocket(socket: net.Socket) {
    if (this.authenticatingClients.size >= 64) { socket.destroy(); return; }
    this.authenticatingClients.add(socket);
    const token = this.pipeToken;
    let buffer = "";
    let fase: "hello" | "response" = "hello";
    let clientNonce = "";
    let serverNonce = "";
    const cleanup = () => {
      clearTimeout(deadline);
      this.authenticatingClients.delete(socket);
      socket.removeListener("data", onData);
    };
    /** A razão é sempre fixa e nossa: nunca ecoa frames nem valores recebidos. */
    const reject = (razao: string) => {
      cleanup();
      socket.end(encodeMessage({ type: "auth", ok: false, error: razao }));
      // Um cliente que não lê a recusa não pode manter o socket vivo.
      const close = setTimeout(() => socket.destroy(), 100);
      close.unref();
      socket.once("close", () => clearTimeout(close));
    };
    const prazo = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => reject("Autenticação do pipe expirou"), 3000);
      deadline.unref();
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 4096) { reject("Handshake do pipe excedeu o limite de frame"); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      // O handshake é um frame por fase: mais do que isso é protocolo inválido,
      // não uma cortesia a tolerar.
      if (buffer.slice(newline + 1).length !== 0) { reject("Handshake do pipe com frames excedentes"); return; }
      let message: any;
      try { message = JSON.parse(buffer.slice(0, newline)); }
      catch { reject("Handshake do pipe inválido"); return; }
      buffer = "";

      if (message?.v !== PIPE_AUTH_VERSION) { reject("Versão do protocolo do pipe não suportada"); return; }

      if (fase === "hello") {
        if (!token || message?.type !== "auth-hello" || !isPipeNonce(message?.nonce)) {
          reject("Protocolo do pipe não suportado"); return;
        }
        clientNonce = message.nonce;
        if (this.seenClientNonces.has(clientNonce)) { reject("Replay: nonce do pipe já foi usado"); return; }
        this.seenClientNonces.add(clientNonce);
        if (this.seenClientNonces.size > ProtectionEngineService.SEEN_NONCES_MAX) {
          const maisAntigo = this.seenClientNonces.values().next().value;
          if (maisAntigo !== undefined) this.seenClientNonces.delete(maisAntigo);
        }
        serverNonce = generatePipeNonce();
        fase = "response";
        prazo();
        socket.write(encodeMessage({
          type: "auth-challenge",
          v: PIPE_AUTH_VERSION,
          nonce: serverNonce,
          proof: makePipeProof(token, "server", clientNonce, serverNonce),
        }));
        return;
      }

      if (message?.type !== "auth-response" ||
          !token ||
          !verifyPipeProof(token, "client", clientNonce, serverNonce, message?.proof)) {
        reject("Prova do cliente recusada"); return;
      }
      cleanup();
      socket.write(encodeMessage({ type: "auth", ok: true }));
      this.attachClientSocket(socket);
    };
    let deadline = setTimeout(() => reject("Autenticação do pipe expirou"), 3000);
    deadline.unref();
    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
    socket.once("close", cleanup);
  }

  async startPipeServer(pipeName: string = PIPE_NAME) {
    if (this.pipeAuthRequired && (!this.pipeToken || !/^[a-f0-9]{64}$/.test(this.pipeToken))) {
      throw new Error("Credencial de autenticação do pipe ausente ou inválida");
    }
    if (!this.pipeAuthRequired) {
      console.warn("[Service] AVISO S4: DEV externo sem autenticação do pipe; não utilizar em produção.");
    }
    this.server = net.createServer((socket) => {
      if (this.pipeAuthRequired) this.authenticateClientSocket(socket);
      else this.attachClientSocket(socket);

      // Connecting/reconnecting is read-only. Only monitor.start/resume (or an
      // explicitly scheduled pause expiry) may enable protection.
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(pipeName, () => resolve());
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
        error: error?.message ?? "Erro desconhecido do serviço",
      };
    }
  }

  /**
   * A escrita da preferência é melhor-esforço: o estado que o utilizador viu
   * mudar já mudou. Mas uma falha não pode passar em branco nem contar como
   * "preferência guardada" — fica registada com o motivo sanitizado.
   */
  private async registrarPreferencia(escrita: Promise<EscritaResultado>, descricao: string): Promise<void> {
    const resultado = await escrita.catch((erro) => ({
      ok: false, guardado: false, motivo: String((erro as Error)?.message ?? erro),
    }));
    if (!resultado.guardado) {
      console.warn(`[Service] Preferência de proteção não gravada (${descricao}): ${resultado.motivo ?? "desconhecido"}`);
    }
  }

  private async dispatch(
    method: keyof ServiceCommandMap,
    payload: ServiceCommandMap[keyof ServiceCommandMap],
  ): Promise<any> {
    // Across different pipe clients, a critical mutation can remain in flight
    // while another client requests termination. Track the complete async span.
    const critical = /^(scan\.|quarantine\.|trust\.)/.test(method) && !["scan.history","scan.getActive","scan.getLast","quarantine.list"].includes(method)
      || ["definitions.update","analysis.restricted","process.analyze","threat.action"].includes(method);
    if(critical) ++this.criticalRpcOperations;
    try { return await this.dispatchTracked(method,payload); }
    finally { if(critical) --this.criticalRpcOperations; }
  }

  private async dispatchTracked(
    method: keyof ServiceCommandMap,
    payload: ServiceCommandMap[keyof ServiceCommandMap],
  ): Promise<any> {
    await this.gateMethodDuringStartup(method as string);
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
      case "quarantine.policy.get":
        return { policy: this.quarantinePolicy };
      case "quarantine.policy.set":
        return this.changeQuarantinePolicy(payload as { policy?: unknown; consent?: unknown });
      // ── Protecao USB (R8) ──
      // Leitura coalescida do estado e opt-in. Nenhum caminho/target vem do
      // renderer: o auto-scan usa o dispositivo que ESTE servico confirmou.
      case "usb.getState":
        return this.usbRuntime.snapshot();
      case "usb.configure":
        return this.usbRuntime.configure(payload as { enabled: boolean });
      // Análise MANUAL de um dispositivo USB (R8). Validacao estrita e
      // resolucao das raizes ficam no runtime — nenhum caminho vem daqui.
      case "usb.scan":
        return this.usbRuntime.scan(payload);
      case "usb.cancel":
        return this.usbRuntime.cancel(payload);
      case "events.clear":
        return this.clearEvents();
      case "scan.artifact":
        // Ficheiro escolhido pelo utilizador na UI: prioridade de utilizador.
        return this.scanArtifact((payload as { path: string }).path, "dashboard", {
          priority: "user",
        });
      case "scan.fullSystem":
        this.runFullSystemScan();
        return { success: true };
      case "monitor.start":
        // Nada é gravado: ligar agora não é pedir a retoma ao próximo arranque.
        return this.startProtection();
      case "monitor.stop": {
        // Só o pedido do utilizador revoga. `dispose()`/`shutdown()` chamam
        // `stopProtection()` diretamente e não passam por aqui — fechar a app
        // não é um OFF.
        const vivo = await this.stopProtection();
        if (!this.intentAtivo) {
          return { ...vivo, revogacaoRetoma: "nao_confirmada" as const, motivoRevogacao: "isolamento_teste" };
        }
        // O estado observado e a persistência são respostas diferentes: um OFF
        // que não se consegue gravar continua a ser um OFF agora, mas a retoma
        // anterior pode sobreviver no registo e voltar a ligar ao arrancar.
        return this.protectionStartup.ofManualConfirmado(vivo);
      }
      case "monitor.pause": {
        // `durationMs` ausente = pausa até ativação manual. O payload chega
        // como o próprio corpo do pedido neste transporte.
        const raw = (payload as { durationMs?: number } | undefined)?.durationMs;
        const durationMs = typeof raw === "number" ? raw : undefined;
        const vivo = await this.pauseProtection(durationMs);
        if (!this.intentAtivo) {
          return { ...vivo, revogacaoRetoma: "nao_confirmada" as const, motivoRevogacao: "isolamento_teste" };
        }
        // Pausa SEM prazo é ficar desligado até ação manual. Gravar
        // `pausedUntil:null` com `desired:"enabled"` faria a app retomar
        // sozinha ao arranque — exatamente o contrário do pedido.
        if (!(typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0)) {
          return this.protectionStartup.ofManualConfirmado(vivo);
        }
        await this.registrarPreferencia(this.protectionStartup.registrarPausa(vivo.pausedUntil), "prazo de pausa");
        return vivo;
      }
      case "monitor.resume": {
        const resultado = await this.resumeProtection();
        if (this.intentAtivo && resultado.ok) {
          await this.registrarPreferencia(this.protectionStartup.registrarPausa(null), "limpar prazo de pausa");
        }
        return resultado;
      }
      case "protectionIntent.get":
        // `protecaoAtiva` é o que o serviço observa agora, nunca o que está em
        // disco: um `enabled` lido não prova proteção a correr.
        return this.intentAtivo
          ? this.protectionStartup.estado(this.protectionState)
          : {
              optin: "unknown" as const, registoConhecido: false, protecaoAtiva: this.protectionState,
              pausedUntil: null, motivo: "isolamento_teste",
            };
      case "protectionIntent.setOptIn": {
        const entrada = parseOptInPayload(payload);
        if (!entrada.ok) return { ok: false, guardado: false, motivo: entrada.motivo };
        return this.protectionStartup.definirOptin(entrada.enabled);
      }
      case "process.termination.prepare":
        const bloqueio = this.terminationBlocked();
        if (bloqueio) return {ok:false,status:"protected",error:terminationBlockedMessage(bloqueio)};
        try { return this.terminationController().prepare(payload); }
        catch { return {ok:false,status:"failed",error:"Componente nativo de terminação indisponível; nenhuma ação executada."}; }
      case "process.termination.confirm":
        return this.confirmIndividualProcess((payload as {ticket?:unknown})?.ticket);
      case "process.termination.cancel":
        return this.individualTermination?.cancel((payload as {ticket?:unknown})?.ticket) ?? {cancelled:false};
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
      // Leitura pura: não cria trabalho novo, não toca na rede, não precisa do
      // gate de encerramento — é o que permite à UI mostrar os cinco estados.
      case "definitions.status":
        return this.definitionsStatus();
      case "analysis.restricted":
        return this.runRestrictedAnalysis((payload as { path: string }).path);
      case "hardware.snapshot":
        return await this.readHardwareSnapshot();
      case "windows.healthSnapshot":
        return this.windowsHealth.getCached();
      case "pcstate.get":
        return this.getPcState();
      case "process.analyze":
        return this.analyzeProcess((payload as { pid: number }).pid);
      case "exclusions.get":
        return this.exclusions.getConfig();
      case "exclusions.update":
        return this.exclusions.updateRules(payload);
      case "scan.start": {
        const { type, targetPath } = payload as any;
        const id = await this.scanManager.startScan(type, targetPath);
        if (!id) {
          const error = "Já existe uma análise em curso. Cancele ou aguarde a conclusão.";
          console.warn(`[ScanService] start rejected: ${error}`);
          throw new Error(error);
        }
        // Correlação: o scanId é propagado para os logs de scan e eventos.
        console.log(`[ScanService] ${formatScanLog(id, `scan.start accepted type=${String(type)} target=${String(targetPath)} at=${new Date().toISOString()}`)}`);
        return { id, success: true };
      }
      case "scan.getActive": {
        // Snapshot for UI resync (remount / page navigation / missed event).
        return this.scanManager.getActiveScan() ?? null;
      }
      case "scan.getLast": {
        const id = (payload as { id?: unknown } | undefined)?.id;
        if (id !== undefined && (typeof id !== "string" || !id)) {
          throw new Error("Identificador de análise inválido.");
        }
        return this.scanManager.getLastScan(id as string | undefined);
      }
      case "scan.history": {
        const historyPayload = (payload as { limit?: unknown; cursor?: unknown } | undefined) ?? {};
        const limit = typeof historyPayload.limit === "number" ? historyPayload.limit : undefined;
        const cursor = typeof historyPayload.cursor === "string" ? historyPayload.cursor : undefined;
        return this.scanHistory.query(limit, cursor);
      }
      case "scan.cancel": {
        const { id } = payload as any;
        // Estágio 1 — «recebido no handler». Antes de chamar o manager, e sem tocar no
        // valor recebido: um id que não é UUID conta como `invalido`, nunca é ecoado.
        // O ACK confirma apenas um cancelamento realmente aceite pelo manager.
        // Um id desconhecido ou já terminal não representa uma nova ação.
        linhaDeCancelamento(this.scanManager, "recebido", id);
        const desfecho = this.scanManager.cancelScan(id);
        return { success: desfecho === "cancelado" };
      }
      case "threat.action": {
        const { id, action, sha256 } = (payload ?? {}) as any;
        if (typeof id !== "string" || id.length === 0 || id.length > 32768 || !["restore","delete","quarantine"].includes(action)) return {success:false,error:"Pedido de ação inválido."};
        let success = false;

        if (action === "restore") {
          const { success: restored, error } = await this.quarantine.restore(id);
          success = restored === true;
          if (success) void this.logHistory({ type: "threat.restored", id, timestamp: new Date().toISOString() });
          return { success, ...(error !== undefined ? { error } : {}) };
        } else if (action === "delete") {
          const result = await this.quarantine.delete(id);
          success = result.success;
          if (success) void this.logHistory({ type: "threat.deleted", id, timestamp: new Date().toISOString() });
        } else if (action === "quarantine") {
           // For a manual quarantine, we'd need the threat event.
           // We can look it up in this.threats
           if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256)) return {success:false,error:"Confirme novamente a deteção: falta o digest do ficheiro autorizado."};
           const threat = this.threats.find(t => (t.url === `file://${id}` || t.filePath === id) && t.sha256?.toLowerCase() === sha256.toLowerCase());
           if (!threat) return {success:false,error:"Esta identidade de ficheiro não corresponde a uma deteção registada. Volte a analisar."};
           if (threat && threat.filePath) {
              const analysis = {
                artifactPath: threat.filePath,
                fileName: path.basename(threat.filePath),
                sha256: threat.sha256 ?? "",
                verdict: "suspicious",
                riskScore: threat.riskScore
              } as any;

              if (!threat.sha256 || !/^[a-f0-9]{64}$/i.test(threat.sha256)) {
                this.eventBus.publish("quarantine.failed", "high", "Deteção sem digest verificável; volte a analisar o ficheiro antes de o isolar.", {artifactPath:threat.filePath,fileName:analysis.fileName});
                return {success:false,error:"Volte a analisar o ficheiro: esta deteção não contém uma identidade verificável."};
              }
              success = await this.requestQuarantine(analysis, "manual");
              if (success) {
                threat.action = "quarantined";
                void this.logHistory({ type: "threat.quarantined_manual", id, timestamp: new Date().toISOString() });
              }
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
