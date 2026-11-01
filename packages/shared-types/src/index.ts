/**
 * Contrato unico do resultado da atualizacao de definicoes. Vive num modulo
 * proprio e e reexportado daqui para que servico, bridge e renderer partilhem
 * o MESMO tipo — `success` so e true com os tres componentes confirmados.
 */
export type { DefinitionsUpdateResult } from "./definitions-update.js";
export type Severity = "low" | "medium" | "high" | "critical";
export type ThreatAction = "quarantined" | "alerted" | "logged" | "allowed";
export type ProtectionStatus = "safe" | "attention" | "critical" | "degraded";
export type PlanType = "free" | "personal" | "business";
export type SubscriptionTier = "free" | "pro" | "enterprise";
/**
 * `inconclusive` NÃO é uma quarta opinião sobre o ficheiro: é a ausência de
 * opinião. Existe porque um motor que não conseguiu abrir o ficheiro (medido:
 * o Defender remove-o no instante em que o clamscan o abre) não pode ser
 * reportado como "safe" — "safe" é uma afirmação sobre o ficheiro, e ninguém o
 * examinou. Também não pode ser "suspicious": isso seria fabricar uma ameaça.
 */
export type AnalysisVerdict = "safe" | "suspicious" | "malicious" | "inconclusive";
export type TrustDecision = "trusted" | "neutral" | "untrusted";
export type EventType =
  | "artifact.discovered"
  | "artifact.analyzed"
  | "file.created"
  | "file.modified"
  | "file.renamed"
  | "file.deleted"
  | "registry.persistence.changed"
  | "scheduledtask.changed"
  | "process.started"
  | "process.exited"
  | "process.suspicious"
  | "process.blocked"
  | "process.killed"
  | "persistence.detected"
  | "threat.detected"
  | "threat.resolved"
  | "quarantine.added"
  | "quarantine.requested"
  | "quarantine.failed"
  | "quarantine.restored"
  | "trust.updated"
  | "scan.progress"
  | "protection.changed"
  | "engine.health";

export type HeuristicRuleId =
  | "no_https"
  | "lookalike_domain"
  | "suspicious_keywords_in_domain_or_path"
  | "excessive_subdomains_or_length"
  | "dangerous_file_extension"
  | "social_engineering_filename_pattern"
  | "suspicious_download_type"
  | "high_download_frequency"
  | "double_extension"
  | "executable_signature"
  | "archive_with_exe"
  | "magic_number_mismatch"
  | "high_entropy"
  | "encrypted_payload"
  | "behavioral_burst"
  | "process_injection_indicator"
  | "suspicious_location"
  | "persistence_attempt"
  | "trusted_publisher"
  | "trusted_system_path"
  | "known_bad_hash"
  | "dev_canary_signature"
  | "yara_match"
  | "allowlisted_hash"
  | "unsigned_binary"
  | "known_malware"
  | "office_child_process"
  | "script_spawns_binary"
  | "rapid_process_fanout"
  | "blocked_reexecution"
  | "scan_inconclusive";

export interface ThreatFactor {
  id: string;
  label: string;
  weight: number;
  category: "signature" | "yara" | "heuristic" | "behavior" | "trust" | "policy";
}

export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  name: string;
  path: string;
  commandLine: string;
  user?: string;
  cpu: number;
  memoryMb: number;
  startedAt: string;
  signer?: string;
  hash?: string;
  trusted: TrustDecision;
}

/** Motivo de uma enumeração de processos ter falhado. */
export interface ProcessEnumerationError {
  /**
   * `cim` — a fonte de verdade (Get-CimInstance Win32_Process) não respondeu;
   * `parse` — respondeu mas o payload não é utilizável;
   * `unknown` — outra causa, preservada como veio.
   */
  code: "cim" | "parse" | "unknown";
  message: string;
}

/** Registo da última TENTATIVA de enumerar, boa ou má. */
export interface ProcessEnumerationAttempt {
  startedAt: number;
  /** `null` enquanto a tentativa está em curso. */
  finishedAt: number | null;
  ok: boolean;
  error?: ProcessEnumerationError;
}

/**
 * Verdade da enumeração de processos — separada das linhas que são servidas.
 *
 * O contrato antigo devolvia `ProcessSnapshot[]` nu. Um array vazio significava
 * «zero processos» e «a enumeração rebentou» eram indistingíveis no pipe, e o
 * renderer carimbava frescura do lado do cliente. A partir daqui a resposta é o
 * objeto `ProcessListResult`: `processes` são as linhas, `truth` diz o que o
 * Windows efectivamente respondeu.
 *
 * Eixos separados, de propósito:
 *  · `state`   = o que sabe a última tentativa;
 *  · `servedFrom` = de onde vêm as linhas desta resposta;
 *  · `enumeratedAt` = a idade da informação (a da FOTO, não a da resposta).
 */
export interface ProcessEnumerationTruth {
  /**
   * `never` — ainda não houve tentativa desde que o serviço nasceu;
   * `in-progress` — há uma tentativa em curso AGORA, o resultado não se sabe;
   * `ok` — a última tentativa respondeu;
   * `failed` — a última tentativa falhou (a lista pode ser cache ou estar vazia);
   * `unreported` — quem respondeu não tem este contrato (serviço de um boot
   *   anterior reutilizado): as linhas existem, a frescura NÃO se afirma.
   */
  state: "never" | "in-progress" | "ok" | "failed" | "unreported";
  /** Instante da última foto bem-sucedida do SO; `null` = nunca houve foto. */
  enumeratedAt: number | null;
  servedFrom: "snapshot" | "cache";
  /** Última tentativa com início/fim reais; `null` quando nunca houve tentativa. */
  attempt: ProcessEnumerationAttempt | null;
  /** Quando esta resposta foi composta — permite à UI medir a idade. */
  asOf: number;
}

export interface ProcessListResult {
  processes: ProcessSnapshot[];
  truth: ProcessEnumerationTruth;
}

/**
 * Classifica o erro de uma enumeração sem lhe inventar causa.
 *
 * A mensagem é limitada e com espaços colapsados de propósito: ela vai ao
 * banner da UI e ao log. O que rebenta numa enumeração pode ser um erro de
 * `child_process` com o `stderr` do Windows inteiro dentro — texto longo com
 * caminhos e utilizadores de terceiros não é diagnóstico, é fuga de conteúdo.
 * O texto que fica continua a ser o do produtor, só não pode transbordar.
 */
export const PROCESS_ENUMERATION_ERROR_MESSAGE_MAX = 240;

export function classifyProcessEnumerationError(error: unknown): ProcessEnumerationError {
  const bruto =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const mensagem = bruto.replace(/\s+/g, " ").trim();
  const message =
    mensagem.length <= PROCESS_ENUMERATION_ERROR_MESSAGE_MAX
      ? mensagem
      : `${mensagem.slice(0, PROCESS_ENUMERATION_ERROR_MESSAGE_MAX - 1)}…`;
  const code: ProcessEnumerationError["code"] = /CIM|CimInstance|indispon/i.test(message)
    ? "cim"
    : /JSON|parse|Unexpected|is not valid JSON/i.test(message)
      ? "parse"
      : "unknown";
  return { code, message };
}

/**
 * Valida a forma do `truth` ANTES de a UI confiar nele. Um objeto com `state`
 * desconhecido ou sem `asOf` utilizável não é meia-verdade: é ausência de
 * contrato, e tratá-lo como tal é o que evita mostrar «actual» para sempre.
 */
const PROCESS_ENUMERATION_STATES = ["never", "in-progress", "ok", "failed", "unreported"] as const;

export function isProcessEnumerationTruth(value: unknown): value is ProcessEnumerationTruth {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  if (!PROCESS_ENUMERATION_STATES.includes(t.state as (typeof PROCESS_ENUMERATION_STATES)[number])) return false;
  if (!(t.enumeratedAt === null || (typeof t.enumeratedAt === "number" && Number.isFinite(t.enumeratedAt)))) return false;
  if (t.servedFrom !== "snapshot" && t.servedFrom !== "cache") return false;
  if (typeof t.asOf !== "number" || !Number.isFinite(t.asOf)) return false;
  if (t.attempt !== null) {
    const a = t.attempt as Record<string, unknown>;
    if (!a || typeof a !== "object") return false;
    if (typeof a.startedAt !== "number" || !Number.isFinite(a.startedAt)) return false;
    if (!(a.finishedAt === null || (typeof a.finishedAt === "number" && Number.isFinite(a.finishedAt)))) return false;
    if (typeof a.ok !== "boolean") return false;
  }
  return true;
}

/**
 * Verdade de um serviço SEM este contrato (ex.: instância de um boot anterior
 * reutilizada pelo pipe). As linhas existem; a frescura não é afirmada — `never`
 * seria uma afirmação falsa, `ok` também.
 */
export function unreportedProcessTruth(asOf = Date.now()): ProcessEnumerationTruth {
  return { state: "unreported", enumeratedAt: null, servedFrom: "cache", attempt: null, asOf };
}

/** Aceita o objeto do contrato e o array nu de um serviço antigo. */
export function normalizeProcessListResult(
  value: ProcessListResult | ProcessSnapshot[] | null | undefined,
  asOf = Date.now(),
): ProcessListResult {
  if (Array.isArray(value)) return { processes: value, truth: unreportedProcessTruth(asOf) };
  if (value && Array.isArray(value.processes)) {
    // As linhas sobrevivem a um `truth` malformado; a frescura não.
    return {
      processes: value.processes,
      truth: isProcessEnumerationTruth(value.truth) ? value.truth : unreportedProcessTruth(asOf),
    };
  }
  // Nem uma coisa nem outra: não se inventa lista nem frescura.
  return { processes: [], truth: unreportedProcessTruth(asOf) };
}

export interface KillProcessResult {
  ok: boolean;
  status: "ok" | "not-found" | "access-denied" | "timeout" | "failed";
  pid: number;
  exitCode?: number;
  error?: string;
  /** stdout/stderr reais do taskkill — diagnóstico preservado, nunca descartado. */
  stdout?: string;
  stderr?: string;
}

/** Desfecho estruturado de um pedido de terminar processo. */
export type ProcessKillStatus =
  | "killed"
  | "already-exited"
  | "protected"
  | "timeout"
  | "reused"
  | "access-denied"
  /**
   * O PID terminado era um stub/App Execution Alias (MSIX) ou morreu antes do
   * taskkill, e existe outra instância viva com a mesma identidade no OS —
   * o processo REAL (outro PID) continua vivo. Nunca é falso sucesso.
   */
  | "alias-stub"
  | "failed";

/** Porque é que um alvo de kill foi protegido. */
export type ProcessKillProtectionReason =
  | "self"
  | "ancestor"
  | "internal"
  | "system-pid"
  | "fallback-name";

export interface ProcessKillResult {
  success: boolean;
  status: ProcessKillStatus;
  pid: number;
  /** Mensagem pronta a apresentar quando `success === false`. */
  error?: string;
  /** Motivo quando `status === "protected"`. */
  protectedReason?: ProcessKillProtectionReason;
  /** Identidade do alvo capturada antes da tentativa (diagnóstico/PID reuse). */
  target?: { name?: string; path?: string };
  /** Código de saída real do taskkill (0 = terminado; 128 = já não existia; 5 = acesso negado…). */
  exitCode?: number;
  /** stdout/stderr brutos do taskkill — diagnóstico propagado até ao registo/UI. */
  stdout?: string;
  stderr?: string;
}

/** Individual termination: the service owns a pinned handle until confirmation. */
export interface ProcessTerminationSelection { pid: number; startedAt: string; }
export interface ProcessTerminationTarget extends ProcessTerminationSelection { name: string; }
export type ProcessTerminationPreparation =
  | { ok: true; ticket: string; target: ProcessTerminationTarget; expiresAt: number }
  | { ok: false; status: ProcessKillStatus; error: string; win32Code?: number };
export interface ProcessTerminationResult extends ProcessKillResult { win32Code?: number; confirmation?: "handle-signaled"; scope?: "single-process"; }
export const PROCESS_TERMINATION_WAIT_MS = 2000;
export const PROCESS_TERMINATION_TICKET_MS = 60000;

export interface ConnectionSnapshot {
  processPid?: number;
  processName?: string;
  remoteAddress: string;
  remotePort?: number;
  protocol?: string;
  state?: string;
  domain?: string;
  direction: "inbound" | "outbound";
  observedAt: string;
}

export interface QuarantineEntry {
  /** Absent in legacy manifests: isolation has not been verified by this version. */
  isolationStatus?: "confirmed" | "recovery-required";
  id: string;
  originalPath: string;
  quarantinePath: string;
  fileName: string;
  sha256?: string;
  verdict: AnalysisVerdict;
  riskScore: number;
  /**
   * Motivo factual da deteção (regras/fatores que dispararam), quando existir.
   * Ausente = não se mostra, em vez de se inventar.
   */
  detectionReason?: string;
  /** Motor que classificou o ficheiro, quando conhecido. */
  engine?: string;
  quarantinedAt: string;
  restoredAt?: string;
  restoredBy?: string;
}

export interface AnalysisResult {
  artifactPath: string;
  fileName: string;
  sha256: string;
  verdict: AnalysisVerdict;
  severity: Severity;
  riskScore: number;
  confidence: number;
  rulesTriggered: HeuristicRuleId[];
  factors: ThreatFactor[];
  recommendedAction: ThreatAction;
  signer?: string;
  publisherTrusted: boolean;
  systemPathTrusted: boolean;
  isExecutable: boolean;
  magicNumber?: string;
  detectedExtension?: string;
  extension?: string;
  size: number;
  entropy?: number;
  scanTimestamp: string;
}

export interface ThreatRecord {
  id: string;
  source: ThreatEvent["source"];
  createdAt: string;
  action: ThreatAction;
  eventType: EventType;
  analysis: AnalysisResult;
  process?: ProcessSnapshot;
}

export type EngineSubsystemStatus = "active" | "degraded" | "unavailable" | "error";

/**
 * COBERTURA — o que as regras/características carregadas COBREM, independente
 * de o motor estar a funcionar.
 *
 * `status` responde a "o motor carregou?". `coverage` responde a "o que ele
 * carregou serve para alguma coisa?". Um corpus que é apenas o canário EICAR
 * faz o motor funcionar e não detecta malware nenhum: as duas respostas são
 * ambas verdadeiras e um só campo não chega para as dizer.
 *
 * A assimetria entre os três valores é deliberada e é a segurança do contrato:
 *
 * - `"limited"`  afirmação SEGURA. Medimos e sabemos que é pouco. É o que se
 *                emite quando o corpus é o canário/fallback: o motor funciona,
 *                a análise por regras de malware está inativa.
 * - `"normal"`   afirmação FORTE. Só é emitido com evidência medida: um corpus
 *                que NÃO é o canário compilou com sucesso e está em memória.
 *                Nunca por presunça de caminho de código, nunca por ausência
 *                de marker num ficheiro que não foi lido.
 * - `"unknown"`  ausência de medição. O motor não carregou, ou o corpus não
 *                compilou, ou o ficheiro estava vazio. Não diz "limitada"
 *                porque isso afirmaria que medimos pouco; e sobre tudo não diz
 *                "normal", porque isso affirmaria uma proteção que não medimos.
 */
export type EngineSubsystemCoverage = "normal" | "limited" | "unknown";

export interface EngineSubsystemHealth {
  status: EngineSubsystemStatus;
  detail?: string;
  /**
   * Cobertura do que está carregado. Ausente = motor antigo que não envia o
   * campo; o consumidor tem de o tratar como `unknown`, nunca como `normal`.
   */
  coverage?: EngineSubsystemCoverage;
}

/**
 * Origens SEPARADAS de perda no tempo real (P0 C5, 15/10).
 *
 * Existe porque um número sozinho chegou ao ecrã como «2 493 eventos não analisados
 * por limite da fila» quando misturava duas coisas diferentes e ainda somava o total
 * cumulativo de cada sinal do watcher. Regras que este tipo obriga a respeitar:
 *  - `queueRejections` conta TENTATIVAS de análise rejeitadas, não ficheiros;
 *  - `queueDistinctPaths` é limitado e `queuePathsCapped` diz quando o teto foi
 *    atingido — um teto silencioso seria uma contagem mentirosa;
 *  - `watcherNamelessCallbacks` conta NOTIFICAÇÕES que chegaram sem nome de
 *    ficheiro. Isso é uma LACUNA DE COBERTURA POSSÍVEL, não prova de transbordo da
 *    fila do ReadDirectoryChangesW: o Node não garante `filename` em Windows, e a
 *    prova de transbordo desse API (`lpBytesReturned` zero) não é exposta aqui.
 *    Por isso `watcherCallbacksIndeterminate` é sempre `true`, e nenhuma string
 *    desta estrutura pode ser lida como «N ficheiros perdidos», como «perda de
 *    eventos confirmada pelo SO», nem como «N ficheiros analisados».
 */
export interface RealtimeLossSummary {
  queueRejections: number;
  queueDistinctPaths: number;
  queuePathsCapped: boolean;
  watcherSignals: number;
  watcherNamelessCallbacks: number;
  watcherCallbacksIndeterminate: boolean;
  raizesComPerda: string[];
}

export interface EngineHealth {
  serviceRunning: boolean;
  osLayerHealthy: boolean;
  degradedReasons: string[];
  monitoredPaths: string[];
  realtimeQueueDepth?: number;
  realtimeDroppedEvents?: number;
  /** Opcional para manter compatibilidade com serviços mais velhos do outro lado do pipe. */
  realtimeLoss?: RealtimeLossSummary;
  /**
   * Admissão recuperável do tempo real. `recovered` conta ADMISSÕES repetidas,
   * não análises concluídas: recuperar a entrada de uma fila cheia não prova
   * que todas as versões de um ficheiro foram vistas. O histórico de perdas
   * (`realtimeLoss`) continua degradado enquanto houver rejeições.
   */
  realtimeRecovery?: import("./realtime-recovery.js").RealtimeRecoverySnapshot;
  definitionsUpdatedAt?: string;
  lastEventAt?: string;
  yara?: EngineSubsystemHealth;
  hashDb?: EngineSubsystemHealth;
  clamav?: EngineSubsystemHealth;
  nativeEngine?: EngineSubsystemHealth;
  /**
   * O filtro WFP do CyberSafe — as regras de bloqueio de IP que o produto cria
   * (`wfp-filter.ts`, `New-NetFirewallRule -DisplayName 'CyberSafe Blocklist'`).
   *
   * NAO e o Firewall do Windows. O Firewall do Windows mede-se em outro sitio e
   * com outro tipo: `WindowsHealthSnapshot.firewall: WindowsFirewallState`, que vem
   * de `Get-NetFirewallProfile`. Os dois chamam-se "firewall" na natureza, mas aqui
   * `wfp` diz o que e.
   */
  wfp?: EngineSubsystemHealth;
  /**
   * @deprecated Alias temporario de `wfp`. Nao significa o Firewall do Windows.
   *
   * Existe porque o servico de fundo e um named-pipe JSON e sobrevive ao
   * arranque da UI: um servico de uma versao anterior pode continuar a servir
   * `firewall` a uma UI nova. Um renderer novo tem de ler os dois; um renderer
   * antigo so le este. Ver `wfpHealth()`, que e a unica forma de ler.
   *
   * REMOCAO: eliminar assim que oFloor(tabela de versoes do named-pipe) garantir
   * servico e UI na mesma versao. Nao ha prazo automatico — remocao de contrato
   * semelmudanca de versao maior, e nao se marca sozinha.
   */
  firewall?: EngineSubsystemHealth;
  anyEngineDegraded?: boolean;
}

export interface ProtectionStats {
  riskScore: number;
  totalEvents: number;
  highSeverityEvents: number;
  blockedExecutions: number;
  quarantinedCount: number;
  monitoredProcesses: number;
  /**
   * Politica EFETIVA de quarentena lida do servico (P0-3, 15/10): valor real
   * de `protection-policy.json` (ausente/invalido = "warn"). Opcional por
   * compatibilidade: sem o campo a UI diz "desconhecido", nunca assume OFF.
   */
  quarantinePolicy?: "warn" | "ask" | "automatic-high-confidence";
}

export interface SecurityEvent<T = unknown> {
  id: string;
  type: EventType;
  timestamp: string;
  sequence: number;
  severity: Severity;
  summary: string;
  data: T;
}

export interface ProtectionState {
  status: ProtectionStatus;
  stats: ProtectionStats;
  engine: EngineHealth;
  /**
   * Estado REAL on/off da proteção em tempo real, lido do motor.
   *
   * `undefined` = não foi lido (a UI deve tratar como desconhecido, NUNCA como
   * `false`). `false` = a proteção foi mesmo desligada ou nunca arrancou.
   *
   * Existe porque `status` sozinho não responde à pergunta "a proteção está a
   * correr?". `status` é derivado de ameaça + saúde dos sub-motores: um motor
   * com zero ameaças e sub-motores saudáveis dava "safe" mesmo com a proteção
   * desligada — o que seria Protected por ausência de más notícias, não por
   * proteção ativa. Esta flag é o facto que fecha essa fresta.
   */
  protectionEnabled?: boolean;
  /** ISO date até onde a proteção está em pausa. null = não está em pausa. */
  protectionPausedUntil?: string | null;
}

export interface ThreatEvent {
  /** Digest of the observed file; prevents a later manual action targeting replacement bytes. */
  sha256?: string;
  source: "extension" | "dashboard" | "download-monitor" | "system-scanner" | "service";
  url: string;
  domain: string;
  severity: Severity;
  confidence: number;
  rulesTriggered: HeuristicRuleId[];
  createdAt: string;
  riskScore: number;
  action?: ThreatAction;
  filePath?: string;
  processPid?: number;
  processName?: string;
  summary?: string;
}

export type ScanType = "quick" | "full" | "custom";
export type ScanStatus = "idle" | "queued" | "running" | "completed" | "cancelled" | "failed";
export type ScanPhase = "preparing" | "gathering" | "scanning" | "finalizing";

export interface ScanState {
  id: string;
  type: ScanType;
  status: ScanStatus;
  progress: number;
  filesScanned: number;
  threatsFound: number;
  startTime?: string;
  endTime?: string;
  targetPath?: string;
  error?: string;
  /** Current scan phase: gathering files or scanning them */
  phase?: ScanPhase;
  /** Files discovered so far (gathering phase — before analysis starts) */
  filesDiscovered?: number;
  /**
   * Número REAL de candidatos a analisar, congelado no fim do gathering.
   * É este o denominador do progresso — nunca o limite máximo de ficheiros
   * (FULL_SCAN_MAX_FILES é apenas um cap de segurança, não um total real).
   */
  filesTotal?: number;
  /**
   * Quantos ficheiros estão AGORA dentro do batch do ClamAV (uma única
   * invocação para todos eles, em curso).
   *
   * Existe porque esse batch demora ~7,6 s a carregar a base antes de devolver
   * qualquer coisa, e sem este campo a UI dizia "A verificar os ficheiros
   * encontrados" durante sete segundos sem ter verificado nada. É a diferença
   * entre "está a trabalhar em 20 ficheiros" e "está parado".
   *
   * NÃO é progresso: os ficheiros ainda não foram avaliados. `filesAnalyzed`
   * só cresce quando o batch devolve. Zero quando não há batch a correr.
   */
  filesInEngineBatch?: number;
  /** Ficheiros que passaram pelo pipeline (analisados, excluídos ou falhados) */
  filesProcessed?: number;
  /** Ficheiros que chegaram efetivamente aos motores de análise aplicáveis */
  filesAnalyzed?: number;
  /** Ficheiros analisados cujo resultado final ficou inconclusivo. */
  filesInconclusive?: number;
  /** Motivo agregado dos inconclusivos; ausente quando não foi medido. */
  inconclusiveByReason?: InconclusiveReasonCount[];
  /** Ficheiros ignorados pela política de exclusões (não passaram por nenhum motor) */
  filesExcluded?: number;
  /**
   * PORQUÊ cada ficheiro foi ignorado, agregado por categoria. É o que permite
   * explicar ao utilizador (em linguagem simples) de onde vem a diferença entre
   * "ficheiros considerados" e "analisados", sem apresentar os excluídos como
   * verificados. Nunca transporta caminhos do utilizador: `path` é a categoria,
   * não o caminho (ver `detail`).
   */
  filesExcludedBy?: ExclusionReasonCount[];
  /** Files that could not be analyzed (read/engine errors) */
  filesFailed?: number;
  /**
   * Revisão monotónica deste scan. Cada emissão de estado incrementa-a; o
   * renderer ignora snapshots/eventos com revisão inferior para que um estado
   * atrasado nunca faça os contadores recuar.
   */
  revision?: number;
  /** Ordem das sessões no processo do serviço; desempata arranques no mesmo milissegundo. */
  sessionSequence?: number;
  /** Momento da última atualização deste estado (ISO) */
  updatedAt?: string;
  /** Para scans personalizados: o alvo é um ficheiro ou uma pasta (informado pelo serviço) */
  targetKind?: "file" | "directory";
  /** Files scanned per second (computed during scanning phase) */
  filesPerSecond?: number;
  /** Basename of the file currently being scanned */
  currentFile?: string;
}

/**
 * Categoria de exclusão — o que aconteceu a um ficheiro que nunca chegou aos
 * motores. `detail` só é preenchido quando é um token seguro (uma extensão ou
 * um nome de ficheiro); para exclusões por caminho fica ausente, porque o
 * caminho pertence ao utilizador e não tem de atravessar o IPC.
 */
export interface ExclusionReasonCount {
  reason: "extension" | "path" | "filename";
  /** Extensão (`.log`) ou nome exato; ausente para exclusões por caminho. */
  detail?: string;
  count: number;
}

/**
 * Porque é que um ficheiro ficou inconclusivo. Categorias fechadas: a UI
 * explica o que os motores reportaram, sem inventar uma causa única.
 */
export type InconclusiveReason =
  | "engine-unavailable"
  | "engine-failed"
  | "no-verdict"
  | "coverage-incomplete";

export interface InconclusiveReasonCount {
  reason: InconclusiveReason;
  count: number;
}

/**
 * Histórico persistente de análises (R7-L3): uma linha por análise em
 * `<baseDir>/scans.jsonl`, escrita quando a análise atinge um estado
 * terminal. `target` nunca transporta o caminho do utilizador.
 */
export type ScanHistoryStatus = "completed" | "cancelled" | "failed";

export interface ScanHistoryEntry {
  id: string;
  type: ScanType;
  /** "default" | "custom" — NUNCA o caminho do utilizador. */
  target: "default" | "custom";
  status: ScanHistoryStatus;
  /** ISO — início da análise. */
  startedAt: string;
  /** ISO — momento em que atingiu o estado terminal. */
  endedAt: string;
  durationMs: number;
  /** Candidatos selecionados pelo scan (denominador real). */
  filesConsidered: number;
  /** Ficheiros que chegaram efetivamente aos motores. */
  filesAnalyzed: number;
  /** Ignorados pela política de exclusões (nenhum motor os viu). */
  filesExcluded: number;
  /** Não foi possível analisar (erro de leitura/motor). */
  filesFailed: number;
  /** Ficheiros analisados sem veredicto conclusivo de todos os motores aplicáveis. */
  filesInconclusive?: number;
  /** Motivo agregado dos inconclusivos; ausente quando não foi medido. */
  inconclusiveByReason?: InconclusiveReasonCount[];
  threatsFound: number;
  /** Só o que o MOTOR reportou. Ausente quando não houve limitação medida. */
  engineLimitations?: string[];
}

/** Página do histórico: mais recente primeiro. `nextCursor` null = fim. */
export interface ScanHistoryPage {
  entries: ScanHistoryEntry[];
  nextCursor: string | null;
}

// ── Proteção USB (R8) ──
// Opt-in: a proteção USB nasce DESLIGADA (enabled=false). A
// detecção confirma armazenamento E transporto USB por
// CIM/discos/associações — nunca pela letra da unidade.

/** Estado do monitor de dispositivos USB. */
export type UsbMonitorStatus = "starting" | "operational" | "unavailable";

/** Estado de um dispositivo USB na fila/estado do monitor. */
export type UsbDeviceStatus =
  | "detected"
  | "queued"
  | "scanning"
  | "completed"
  | "cancelled"
  | "failed"
  | "removed"
  | "incomplete";

/**
 * Configuração persistente da proteção USB (guardada
 * atomicamente no baseDir do serviço). `version: 1` fixo;
 * ficheiro ausente/corrompo = disabled com motivo, NUNCA
 * auto-enable.
 */
export interface UsbProtectionConfig {
  version: 1;
  enabled: boolean;
  updatedAt: string;
}

/**
 * Um dispositivo USB de armazenamento confirmado. `id` é a
 * identidade estável da inserção/dispositivo (serial do disco
 * físico quando existe) — NUNCA só a letra, que pode ser
 * reutilizada por outro dispositivo.
 */
export interface UsbDeviceState {
  id: string;
  /** Raiz da unidade (ex.: "E:\\") — nunca um caminho de ficheiro. */
  rootPath: string;
  /** Nome do volume, quando o Windows o publica. */
  label?: string;
  /** Presença confirmada na última enumeração. */
  present: boolean;
  status: UsbDeviceStatus;
  /** Id da análise custom (read-only) associada, quando houver. */
  scanId?: string;
  /** Resultado real da análise (reutiliza ScanState; nunca inventado). */
  result?: ScanState;
  /** Limitação honesta declarada (ex.: read-only não provado). */
  limitation?: string;
  /**
   * Disco USB DETETADO (transporte provado) ainda sem volume/letra publicados
   * pelo Windows. Estado explícito de espera: `rootPath` vazio e NUNCA
   * analisável — existe para a página poder mostrar o mesmo que o Windows vê
   * em vez de "sem dispositivo" (P0 fiabilidade USB, 14/10/2026).
   */
  awaitingVolume?: boolean;
}

/** Snapshot coalescido e bounded — consulta, nunca por progresso. */
export interface UsbProtectionSnapshot {
  enabled: boolean;
  monitorStatus: UsbMonitorStatus;
  updatedAt: string;
  devices: UsbDeviceState[];
  /** Motivo quando a enumeração falhou (desconhecido, não deteção inventada). */
  error?: string;
}

// ── R8-USB: análise MANUAL de um dispositivo (`usb.scan` / `usb.cancel`) ──────
//
// O renderer NUNCA envia caminhos/raízes: só a IDENTIDADE do dispositivo já
// detetado e um `requestId` do gesto autorizado. As raízes são resolvidas pelo
// serviço numa enumeração fresca. `consent` tem de ser o literal `true` —
// ausente/false é recusado com `{ ok: false, error }`, nunca aceite por omissão.

/** Pedido de `usb.scan` (IPC: `service:usb-scan` → tópico `usb.scan`). */
export interface UsbScanRequest {
  /** Identidade da inserção (serial/PNPDeviceID), nunca a letra. */
  deviceId: string;
  /** Idempotência do gesto: repetir o MESMO pedido devolve o MESMO scanId. */
  requestId: string;
  /** Literal `true`. Ausente/false ⇒ recusa explícita. */
  consent: true;
}

/** Resposta de `usb.scan`: sucesso com o scanId real, ou recusa com motivo. */
export type UsbScanResult =
  | { ok: true; deviceId: string; scanId: string }
  | { ok: false; error: string };

/** Pedido de `usb.cancel` (IPC: `service:usb-cancel` → tópico `usb.cancel`). */
export interface UsbCancelRequest {
  deviceId: string;
  scanId: string;
}

/** Resposta de `usb.cancel`. `ok:false` com motivo quando nada coincide. */
export interface UsbCancelResult {
  ok: boolean;
  error?: string;
}

export type ThreatStatus = "detected" | "quarantined" | "ignored" | "failed" | "restored" | "deleted";

export interface ThreatRecord {
  id: string;
  filePath: string;
  fileName: string;
  threatName: string;
  severity: Severity;
  detectionType: string;
  detectedAt: string;
  action: ThreatAction;
  status: ThreatStatus;
}

export interface Alert {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  createdAt: string;
}

export interface DashboardSummary {
  /**
   * Nota 0-100 MEDIDA pelo servico. `null` = ainda nao ha leitura — a UI
   * mostra "Sem leitura", nunca um numero por defeito (um 100 aqui era um
   * score perfeito nao medido).
   */
  riskScore: number | null;
  totalEvents: number;
  highSeverityEvents: number;
  downloadRisk: Severity;
  recentThreats: ThreatEvent[];
  alerts: Alert[];
  systemStatus: ProtectionStatus;
  engineHealth?: EngineHealth;
}

export interface UrlAnalysisResult {
  severity: Severity;
  confidence: number;
  rulesTriggered: HeuristicRuleId[];
  description?: string;
}

export interface NativeFileScanStatus {
  /** Outcome of this file's native invocation, not global engine health. */
  status: "completed" | "unavailable" | "error" | "cancelled";
  failure?: "unavailable" | "timeout" | "cancelled" | "spawn" | "exit" | "output";
}

export interface FileScanResult {
  /** Optional for compatibility with older service responses. */
  nativeEngine?: NativeFileScanStatus;
  analysisState?: "completed" | "excluded" | "failed" | "engine-unavailable" | "inconclusive";
  detail?: string;
  fileName: string;
  size: number;
  severity: Severity;
  confidence: number;
  rulesTriggered: HeuristicRuleId[];
  riskScore?: number;
  verdict?: AnalysisVerdict;
  sha256?: string;
}

export interface FileScanResponse {
  results: FileScanResult[];
  totalFiles: number;
  highRiskCount: number;
  overallSeverity: Severity;
  rulesTriggered: HeuristicRuleId[];
  riskScore?: number;
  threatRecords?: ThreatRecord[];
}

export interface DownloadEvent {
  url: string;
  domain: string;
  filename: string;
  severity: Severity;
  rulesTriggered: HeuristicRuleId[];
  timestamp: string;
}

export interface EventStats {
  total: number;
  low: number;
  medium: number;
  high: number;
  critical: number;
  downloadRisk: Severity;
  recentDownloadCount: number;
}

export interface ServiceSnapshot {
  protection: ProtectionState;
  events: SecurityEvent[];
  threats: ThreatEvent[];
  processes: ProcessSnapshot[];
  connections: ConnectionSnapshot[];
  quarantine: QuarantineEntry[];
}

export interface ExclusionConfig {
  paths: string[];
  extensions: string[];
  files: string[];
}

/**
 * Estado do opt-in de retoma ao arrancar, lido do registo persistido.
 *
 * `optin:"unknown"` cobre ausente/corrompido/legado/ilegivel: a UI mostra OFF e
 * diz que o registo nao e confiavel. `protecaoAtiva` e sempre observada pelo
 * servico — `optin==="enabled"` e uma preferencia em disco, nunca uma
 * afirmacao de que a protecao esta a correr.
 */
export interface ProtectionIntentState {
  optin: "enabled" | "disabled" | "unknown";
  registoConhecido: boolean;
  protecaoAtiva: boolean;
  pausedUntil: string | null;
  motivo?: string;
}

/** Escrita de preferencia. `guardado:true` so depois de reler o disco e confirmar. */
export interface ProtectionOptInResult {
  ok: boolean;
  guardado: boolean;
  motivo?: string;
}

/**
 * Estado de UMA fonte de definições de segurança (ClamAV / YARA / HashDB).
 *
 * Os IDs são estáveis e a legenda PT-PT vive no renderer — mas a distinção entre
 * os cinco estados é do serviço, porque só o serviço sabe se houve uma tentativa
 * ou um sucesso. `nunca_verificado` não é `indisponivel`, e `degradado` (o motor
 * analisa, a cobertura não é completa) não é `desactualizado` (a base é completa
 * mas antiga). Colapsá-los seria a UI a inventar o que o serviço não mediu.
 */
export type DefinitionsSourceState =
  | "actualizado"
  | "desactualizado"
  | "degradado"
  | "indisponivel"
  | "nunca_verificado";

export interface DefinitionsSourceStatus {
  fonte: "clamav" | "yara" | "hashes";
  estado: DefinitionsSourceState;
  /** Epoch ms do último SUCESSO; `null` se nunca houve um. */
  ultimaBemSucedidaAtMs: number | null;
  /** Epoch ms da última TENTATIVA (pode ter falhado). */
  ultimaTentativaAtMs: number | null;
  /** Último erro observado, com a causa; nunca uma falha inventada. */
  ultimoErro: string | null;
  /** Tentativas falhadas consecutivas; 0 com sucesso limpo. */
  tentativasConsecutivas: number;
  /** Quando a próxima verificação vai realmente acontecer (inclui backoff). */
  proximaVerificacaoAtMs: number;
  /** Cadência normal desta fonte, para a UI não a presumir igual para todas. */
  cadenciaMs: number;
  /** Versão/identificador da base, quando a fonte o publica (ex.: daily 28171). */
  identificadorBase: string | null;
  /** Quantidade efetivamente carregada, quando mensurável; `null` = não medido. */
  itensCarregados: number | null;
}

export interface DefinitionsStatus {
  fontes: DefinitionsSourceStatus[];
  /** `true` enquanto um ciclo corre — a UI não pode oferecer um segundo. */
  cicloEmCurso: boolean;
  geradoEmMs: number;
}

export interface ServiceCommandMap {
  "protection.getState": undefined;
  "events.list": { limit?: number; cursor?: number } | undefined;
  "threats.list": undefined;
  "processes.list": undefined;
  "connections.list": undefined;
  "quarantine.list": undefined;
  "events.clear": undefined;
  "scan.artifact": { path: string };
  "scan.fullSystem": undefined;
  "monitor.start": { paths?: string[] } | undefined;
  "monitor.stop": undefined;
  /**
   * Pausa com duração em ms. Ausente = pausa até ativação manual. O motor
   * reagenda sozinho; quem pede não tem de acordar nada.
   */
  "monitor.pause": { durationMs?: number } | undefined;
  /** Cancela a pausa e reativa já. */
  "monitor.resume": undefined;
  /** Le o opt-in persistido. Sem payload; nunca escreve. */
  "protectionIntent.get": undefined;
  /**
   * Unico canal que escreve a preferencia de retoma. Payload exatamente
   * `{ enabled: boolean }` — validado no servico; atalhos e campos extra
   * sao recusados. Ligar a protecao (`monitor.start`) NAO passa por aqui.
   */
  "protectionIntent.setOptIn": { enabled: boolean };
  "process.killTree": { pid: number };
  "process.termination.prepare": ProcessTerminationSelection;
  "process.termination.confirm": { ticket: string };
  "process.termination.cancel": { ticket: string };
  "process.analyze": { pid: number };
  "quarantine.restore": { id: string; trustAfterRestore?: boolean };
  "quarantine.delete": { id: string };
  "trust.allowHash": { sha256: string };
  "trust.allowPublisher": { publisher: string };
  "definitions.update": { source?: string } | undefined;
  // Leitura pura do estado por fonte — sem side-effect, sem rede, e por
  // isso não entra na lista de trabalho novo proibido no encerramento.
  "definitions.status": undefined;
  "analysis.restricted": { path: string };
  "hardware.snapshot": undefined;
  "windows.healthSnapshot": undefined;
  "pcstate.get": undefined;
  "exclusions.get": undefined;
  "exclusions.update": Partial<ExclusionConfig>;
  "scan.start": { type: ScanType; targetPath?: string };
  /** Estado da análise ativa (ressincronização da UI após remount/navegação). */
  "scan.getActive": undefined;
  "scan.getLast": { id?: string } | undefined;
  /** Histórico persistente de análises (paginado, mais recente primeiro). */
  "scan.history": { limit?: number; cursor?: string } | undefined;
  /** Estado da proteção USB (snapshot coalescido, bounded). */
  "usb.getState": undefined;
  /** Ativa/desativa a proteção USB (validação estrita; opt-in). */
  "usb.configure": { enabled: boolean };
  /**
   * Análise MANUAL de um dispositivo já detetado (opt-in irrelevante: o gesto
   * explícito do utilizador basta, sem ligar o auto-scan). A raiz resolve-se por
   * enumeração fresca no serviço — nenhum caminho vem do renderer.
   */
  "usb.scan": UsbScanRequest;
  /** Cancela apenas a análise USB indicada (exige os DOIS ids a coincidir). */
  "usb.cancel": UsbCancelRequest;
  "scan.cancel": { id: string };
  "threat.action": { id: string; action: "quarantine" | "restore" | "delete"; sha256?: string };
  "service.shutdown": undefined;
}

/**
 * Causa de um subsistema no arranque da proteção: rótulo + motivo JÁ SANITIZADO
 * pelo motor (sem caminhos pessoais). Serve para `failures` (falha fatal) e para
 * `degraded` (degradação não-fatal declarada, ex.: filtro de rede não aplicado).
 */
export interface ProtectionCause {
  label: string;
  reason: string;
}

/**
 * Resposta REAL de `monitor.start` (motor: `startProtection()`).
 * A forma vive aqui, e não em comentários: o motor declara este tipo e a ponte
 * do desktop lê este tipo, portanto um `{success: boolean}` inventado deixa de
 * ser possível — foi esta declaração errada que obrigou ao cast em `main.ts`.
 */
export interface ProtectionStartResult {
  ok: boolean;
  protectionEnabled: boolean;
  /** Presente quando um subsistema OBRIGATÓRIO falhou: `ok:false` + uma entrada por falha. */
  failures?: ProtectionCause[];
  /** Presente num `ok:true` com limitação declarada: nunca é silêncio. */
  degraded?: ProtectionCause[];
}

/** Resposta REAL de `monitor.stop` (motor: `stopProtection()`). */
/**
 * Falhar a persistência de uma revogação não altera o estado que o motor
 * observa — mas tem de ser dito. `revogacaoRetoma` fala só do registo em disco:
 * sem `confirmada`, um opt-in anterior pode sobreviver e religar ao arrancar.
 */
export interface ProtectionRevocation {
  revogacaoRetoma?: "confirmada" | "nao_confirmada";
  motivoRevogacao?: string;
}

export interface ProtectionStopResult extends ProtectionRevocation {
  ok: boolean;
  protectionEnabled: boolean;
}

/**
 * O que a ponte do desktop devolve ao renderer depois de `service:set-protection`.
 * Vive aqui (e não em `main.ts` + `electron.d.ts` duplicados) porque as duas
 * pontas têm de concordar: `protectionEnabled: null` é o estado "o serviço não
 * confirmou", e nem a tray nem o Painel têm autorização para o transformar em
 * ligado ou em desligado.
 */
export interface ProtectionToggleConfirmation extends ProtectionRevocation {
  ok: boolean;
  protectionEnabled: boolean | null;
  reason?: string;
  degraded?: ProtectionCause[];
}

export interface ServiceResponseMap {
  "protection.getState": ProtectionState;
  "events.list": SecurityEvent[];
  "threats.list": ThreatEvent[];
  "processes.list": ProcessListResult;
  "connections.list": ConnectionSnapshot[];
  "quarantine.list": QuarantineEntry[];
  "events.clear": { success: boolean };
  "scan.artifact": FileScanResponse | null;
  "scan.fullSystem": { success: boolean };
  "monitor.start": ProtectionStartResult;
  "monitor.stop": ProtectionStopResult;
  /** `pausedUntil` null = pausa sem prazo (até ativação manual), que vale OFF. */
  "monitor.pause": { ok: boolean; protectionEnabled: boolean; pausedUntil: string | null } & ProtectionRevocation;
  "monitor.resume": { ok: boolean; protectionEnabled: boolean; pausedUntil: string | null } & ProtectionRevocation;
  "protectionIntent.get": ProtectionIntentState;
  "protectionIntent.setOptIn": ProtectionOptInResult;
  "process.killTree": ProcessKillResult;
  "process.termination.prepare": ProcessTerminationPreparation;
  "process.termination.confirm": ProcessTerminationResult;
  "process.termination.cancel": { cancelled: boolean };
  "process.analyze": ProcessAnalysisResult | null;
  "quarantine.restore": { success: boolean; error?: string };
  "quarantine.delete": { success: boolean; error?: string };
  "trust.allowHash": { success: boolean };
  "trust.allowPublisher": { success: boolean };
  "definitions.update": { success: boolean; updatedAt: string };
  "definitions.status": DefinitionsStatus;
  "analysis.restricted": AnalysisResult | null;
  "hardware.snapshot": HardwareSnapshot;
  "windows.healthSnapshot": WindowsHealthSnapshot;
  "pcstate.get": PcState;
  "exclusions.get": ExclusionConfig;
  "exclusions.update": { success: boolean };
  "scan.start": { id: string; success: boolean; error?: string };
  "scan.getActive": ScanState | null;
  "scan.getLast": ScanState | null;
  "scan.history": ScanHistoryPage;
  "usb.getState": UsbProtectionSnapshot;
  "usb.configure": UsbProtectionSnapshot;
  "usb.scan": UsbScanResult;
  "usb.cancel": UsbCancelResult;
  "scan.cancel": { success: boolean };
  "threat.action": { success: boolean; error?: string };
  "service.shutdown": { success: boolean };
}

// ── VirusTotal ──

export interface VirusTotalEngine {
  name: string;
  detected: boolean;
  result: string | null;
}

export interface VirusTotalResult {
  sha256: string;
  positives: number;
  total: number;
  detectionRatio: string;
  engines: VirusTotalEngine[];
  scanDate: string;
  permalink: string;
  reputation: number;
  cached: boolean;
}

// ── Windows / PowerShell Health (READ-ONLY) ──
// Dados reais recolhidos de forma segura via PowerShell/CIM.
// Todas as operações são read-only; nenhum comando arbitrário é aceite.

export type WindowsHealthStatus = "good" | "attention" | "critical" | "unknown";

export interface WindowsSystemInfo {
  osName: string;
  osVersion: string;
  osBuild: string;
  manufacturer: string;
  model: string;
  architecture: string;
  totalRamGb: number;
  availableRamGb: number;
  ramUsagePercent: number;
  available: boolean;
}

export interface WindowsTopProcess {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryMb: number;
  path: string;
  user: string;
}

export interface WindowsServiceInfo {
  name: string;
  displayName: string;
  status: string;
  startType: string;
  running: boolean;
}

export interface WindowsTcpConnection {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: string;
  owningProcessPid: number | null;
  owningProcessName: string | null;
}

export interface WindowsUserInfo {
  name: string;
  fullName: string;
  enabled: boolean;
  local: boolean;
}

export interface WindowsDiskInfo {
  deviceId: string;
  volumeName: string;
  sizeGb: number;
  freeGb: number;
  usedGb: number;
  usagePercent: number;
  fileSystem: string;
}

export interface WindowsFirewallState {
  enabled: boolean;
  profiles: { name: string; enabled: boolean }[];
  available: boolean;
}

export interface WindowsHealthRecommendation {
  id: string;
  severity: "low" | "medium" | "high";
  status: WindowsHealthStatus;
  title: string;
  description: string;
  suggestion: string;
}

export interface WindowsHealthSnapshot {
  system: WindowsSystemInfo;
  topProcessesByCpu: WindowsTopProcess[];
  topProcessesByRam: WindowsTopProcess[];
  services: WindowsServiceInfo[];
  connections: WindowsTcpConnection[];
  users: WindowsUserInfo[];
  disks: WindowsDiskInfo[];
  firewall: WindowsFirewallState;
  overallStatus: WindowsHealthStatus;
  score: number;
  recommendations: WindowsHealthRecommendation[];
  collectedAt: string;
  errors: string[];
}

// ── Health Alerts (derived from WindowsHealthRecommendation[]) ──

export type HealthAlertSeverity = "info" | "warning" | "critical";

export interface HealthAlert {
  /** Identificador estável da recomendação de origem (ex.: "ram-high"), quando disponível. */
  id?: string;
  severity: HealthAlertSeverity;
  title: string;
  description: string;
  category: string;
  /** Evidências observadas (valores atuais) que fundamentam o alerta, quando disponíveis. */
  evidence: string[];
  /** Ação recomendada — apenas consultiva, nunca executada automaticamente. */
  recommendedAction: string;
}

const HEALTH_ALERT_CATEGORY: Record<string, string> = {
  "ram-high": "Memória",
  "ram-attention": "Memória",
  "disk-critical": "Armazenamento",
  "disk-attention": "Armazenamento",
  "firewall-disabled": "Segurança",
  "many-cpu-processes": "CPU",
  "service-down": "Serviços",
};

const HEALTH_ALERT_SEVERITY: Record<string, HealthAlertSeverity> = {
  high: "critical",
  medium: "warning",
  low: "info",
};

export const IMPORTANT_WINDOWS_SERVICES = ["Spooler", "WinDefend", "wuauserv", "mpssvc", "LanmanServer"];

/** Converte recomendações já calculadas em alertas compactos para a UI. */
export function buildHealthAlerts(recommendations: WindowsHealthRecommendation[]): HealthAlert[] {
  return recommendations.map((rec) => ({
    severity: HEALTH_ALERT_SEVERITY[rec.severity] ?? "info",
    title: rec.title,
    description: rec.description,
    category: HEALTH_ALERT_CATEGORY[rec.id] ?? "Geral",
    evidence: [],
    recommendedAction: rec.suggestion,
  }));
}

function formatGb(value: number): string {
  return value.toFixed(1);
}

function ramEvidence(snapshot: WindowsHealthSnapshot): string[] {
  const lines: string[] = [];
  if (snapshot.system.available) {
    lines.push(`Utilização atual da RAM: ${snapshot.system.ramUsagePercent}%`);
    lines.push(`${formatGb(snapshot.system.availableRamGb)} GB livres de ${formatGb(snapshot.system.totalRamGb)} GB`);
  }
  const top = snapshot.topProcessesByRam[0];
  if (top) {
    lines.push(`Maior consumidor: ${top.name} (PID ${top.pid}) — ${Math.round(top.memoryMb)} MB`);
  }
  return lines;
}

function diskEvidence(snapshot: WindowsHealthSnapshot): string[] {
  const top = [...snapshot.disks].sort((a, b) => b.usagePercent - a.usagePercent)[0];
  if (!top) return [];
  const lines = [`Disco afetado: ${top.deviceId}${top.volumeName ? ` (${top.volumeName})` : ""}`];
  lines.push(`Utilizado: ${top.usagePercent}%`);
  lines.push(`${formatGb(top.freeGb)} GB livres de ${formatGb(top.sizeGb)} GB`);
  if (top.fileSystem) {
    lines.push(`Sistema de ficheiros: ${top.fileSystem}`);
  }
  return lines;
}

function firewallEvidence(snapshot: WindowsHealthSnapshot): string[] {
  const { firewall } = snapshot;
  if (!firewall.available) {
    return ["Estado do firewall indisponível nesta recolha"];
  }
  const lines = [`Firewall do Windows: ${firewall.enabled ? "Ativado" : "Desativado"}`];
  if (firewall.profiles.length > 0) {
    lines.push(...firewall.profiles.map((p) => `Perfil ${p.name}: ${p.enabled ? "Ativado" : "Desativado"}`));
  } else {
    lines.push("Nenhum perfil de firewall relatado");
  }
  return lines;
}

function cpuProcessEvidence(snapshot: WindowsHealthSnapshot): string[] {
  const heavy = snapshot.topProcessesByCpu.filter((p) => p.cpuPercent > 50);
  if (heavy.length === 0) return [];
  return heavy.map((p) => `${p.name} (PID ${p.pid}) — ${p.cpuPercent.toFixed(1)}% CPU, ${Math.round(p.memoryMb)} MB`);
}

function serviceEvidence(snapshot: WindowsHealthSnapshot): string[] {
  const down = snapshot.services.filter((s) => IMPORTANT_WINDOWS_SERVICES.includes(s.name) && !s.running);
  return down.map((s) => `${s.displayName || s.name}: ${s.status || "parado"}`);
}

/** Evidências observadas para um alerta, derivadas apenas do payload de saúde existente. */
export function buildHealthAlertEvidence(id: string, snapshot: WindowsHealthSnapshot): string[] {
  switch (id) {
    case "ram-high":
    case "ram-attention":
      return ramEvidence(snapshot);
    case "disk-critical":
    case "disk-attention":
      return diskEvidence(snapshot);
    case "firewall-disabled":
      return firewallEvidence(snapshot);
    case "many-cpu-processes":
      return cpuProcessEvidence(snapshot);
    case "service-down":
      return serviceEvidence(snapshot);
    default:
      return [];
  }
}

/** Converte as recomendações do snapshot em alertas enriquecidos com evidências e ação recomendada. */
export function buildHealthAlertsFromSnapshot(snapshot: WindowsHealthSnapshot): HealthAlert[] {
  return snapshot.recommendations.map((rec) => ({
    id: rec.id,
    severity: HEALTH_ALERT_SEVERITY[rec.severity] ?? "info",
    title: rec.title,
    description: rec.description,
    category: HEALTH_ALERT_CATEGORY[rec.id] ?? "Geral",
    evidence: buildHealthAlertEvidence(rec.id, snapshot),
    recommendedAction: rec.suggestion,
  }));
}

// ── PC State / Findings Engine ──
// Derivado no service, fonte de verdade. A UI nunca recalcula diagnósticos.

export type FindingSeverity = "urgent" | "attention" | "recommended" | "informative";

export type FindingCategory = "security" | "performance" | "privacy" | "system";

export interface FindingEvidence {
  processName?: string;
  pid?: number;
  cpuPercent?: number;
  memoryPercent?: number;
  memoryBytes?: number;
  durationSeconds?: number;
  engine?: string;
  engineStatus?: EngineSubsystemStatus | string;
  diskFreePercent?: number;
  diskUsagePercent?: number;
  endpoint?: string;
  status?: string;
  /** Linhas de contexto técnico observadas (ex.: descrição da recomendação do Windows). */
  evidenceLines?: string[];
}

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  summary: string;
  source: string;
  evidence?: FindingEvidence;
  firstSeen: string;
  lastSeen: string;
  actionable: boolean;
  actionId?: string;
}

/** Reutiliza os estados já usados pelo Windows health — sem duplicação. */
export type PcStateLevel = WindowsHealthStatus;

/**
 * Bandas de apresentação da utilização, em percentagem. Os números NÃO são
 * locais: são os limiares com que `pcstate.ts` emite «elevado» (recommended) e
 * «muito utilizado» (attention). Vivem aqui para que a cor e a palavra de saúde
 * não possam divergir — antes deste bloco o Dashboard usava 75/90 (RAM) e
 * 85/95 (disco) e o PC Center 60/85 para tudo, com o motor a só dar atenção a
 * partir de 90.
 *
 * · `watch` = limiar de recomendação do motor;
 * · `alert` = limiar de «atenção» do motor;
 * · `null`  = a grandeza não é saúde. É o caso de `workload`: utilização de
 *   GPU é trabalho, não doença — uma RX 5600 XT a 99 % está a fazer o que se
 *   lhe pediu, e pintar isso de vermelho diria ao utilizador que o computador
 *   está doente quando está ocupado.
 * · valor `null`/`NaN`/fora de 0–100 devolve `null`: ausência de leitura não
 *   tem cor de saúde; o chamador diz o estado por letras.
 */
export const PC_USAGE_BANDS = {
  cpu: { watch: 75, alert: 90 },
  ram: { watch: 80, alert: 90 },
  /** Percentagem USED; o motor pensa em livre (<20 recomenda, <10 avisa). */
  disk: { watch: 80, alert: 90 },
  /** Score composto 0–100 do motor de stress; banda de apresentação. */
  stress: { watch: 60, alert: 85 },
  workload: { watch: null, alert: null },
} as const;

export type PcUsageMetric = keyof typeof PC_USAGE_BANDS;
export type PcUsageBand = "ok" | "watch" | "alert";

export function pcUsageBand(
  metric: PcUsageMetric,
  percent: number | null | undefined,
): PcUsageBand | null {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  const valor = Math.min(100, Math.max(0, percent));
  const banda = PC_USAGE_BANDS[metric];
  // Sem limiares declarados a grandeza nao e saude (`workload`). Dizer «ok»
  // seria uma afirmacao de saude sobre algo que nao mede saude.
  if (banda.watch === null && banda.alert === null) return null;
  if (typeof banda.alert === "number" && valor >= banda.alert) return "alert";
  if (typeof banda.watch === "number" && valor >= banda.watch) return "watch";
  return "ok";
}

/**
 * Bandas de temperatura, em graus Celsius.
 *
 * Nenhum sensor deste contrato expõe o limite declarado do próprio chip: ADL e
 * ACPI devolvem a leitura, não o `Tjmax`. Por isso isto é uma referência
 * GENÉRICA de apresentação — não a garantia de que aquele chip aguenta mais.
 * `PC_THERMAL_BAND_NOTE` acompanha o número no ecrã para a cor não ser lida
 * como diagnóstico. Fontes dos valores: 95 °C é o máximo de operação documentado
 * pela AMD para a série Ryzen 7000 (o processador de referência é um 7900X);
 * 90 °C é o limite habitual do sensor de borda das Radeon Navi; 70 °C é o valor
 * corrente nas especificações de consumidor para SSD/NVMe (o limite deste disco
 * concreto não é exposto pelo SMART).
 */
export const PC_THERMAL_BANDS = {
  cpu: { watch: 80, alert: 95 },
  gpu: { watch: 80, alert: 90 },
  storage: { watch: 55, alert: 70 },
} as const;

export const PC_THERMAL_BAND_NOTE =
  "Banda genérica de apresentação — o limite declarado por este chip não é exposto pelo sensor.";

export type PcThermalDevice = keyof typeof PC_THERMAL_BANDS;

export function pcThermalBand(
  device: PcThermalDevice,
  celsius: number | null | undefined,
): PcUsageBand | null {
  if (typeof celsius !== "number" || !Number.isFinite(celsius)) return null;
  const banda = PC_THERMAL_BANDS[device];
  if (celsius >= banda.alert) return "alert";
  if (celsius >= banda.watch) return "watch";
  return "ok";
}

export interface PcStateCounts {
  urgent: number;
  attention: number;
  recommended: number;
  informative: number;
}

export interface PcState {
  overall: PcStateLevel;
  security: PcStateLevel;
  performance: PcStateLevel;
  privacy: PcStateLevel;
  system: PcStateLevel;
  findings: Finding[];
  counts: PcStateCounts;
  /** Achado mais importante (pré-computado — a UI não ordena). */
  principalFinding: Finding | null;
  generatedAt: string;
}

// ── Hardware Monitoring ──

export interface HardwareAlert {
  severity: "low" | "medium" | "high" | "critical";
  category: "cpu" | "ram" | "disk" | "gpu" | "network" | "system";
  title: string;
  description: string;
  process?: ProcessSnapshot;
  recommendation: string;
}

/**
 * Classificação FACTUAL de um volume. A regra vive em `packages/core/src/disk.ts`
 * (um só sítio, sem inferência no renderer):
 *  - "working": volume de trabalho do utilizador (pode encher e pode ser limpo);
 *  - "system-reserved": volume minúsculo reservado pelo Windows/arranque — não é
 *    um disco a otimizar e não gera alarme.
 * "removable" não existe de propósito: `fsSize()` não diz o tipo de unidade e
 * inventá-lo seria afirmar o que não foi medido.
 */
export type DiskVolumeKind = "working" | "system-reserved";

export interface DiskVolumeSnapshot {
  /** Montagem tal como o SO a reporta (ex.: "C:", "D:"). */
  mount: string;
  fileSystem: string;
  totalGb: number;
  usedGb: number;
  freeGb: number;
  /** 0−100, uma casa decimal. É uma medição: só existe quando o volume foi lido. */
  usagePercent: number;
  kind: DiskVolumeKind;
  readOnly: boolean;
}

/**
 * Estado de LEITURA do armazenamento. Existe porque "0%" e "sem leitura" eram
 * o mesmo número até 2026-10-09, e o ecrã mostrava-os como se fossem iguais:
 *  - "ok": leitura válida feita agora;
 *  - "stale": a última leitura FALHOU, mas existe um valor bom recente (TTL);
 *  - "unavailable": não há leitura fiável (nunca houve, ou o valor bom expirou).
 */
export type DiskReadStatus = "ok" | "stale" | "unavailable";

/**
 * Estado da leitura dos contadores de fiabilidade dos discos.
 *
 * `available` = contadores reais medidos; `partial` = alguns discos com
 * contadores e outros sem suporte (não se esconde a indisponibilidade parcial);
 * `invalid` = o disco respondeu mas sem um único valor utilizável;
 * `denied` = permissões em falta (comprovado); `unsupported` = o hardware não
 * expõe contadores; `unavailable` = outras falhas de leitura.
 */
export type StorageCountersStatus =
  | "available"
  | "partial"
  | "invalid"
  | "denied"
  | "unsupported"
  | "unavailable";

export type StorageDiskHealthStatus = "healthy" | "warning" | "unhealthy" | "unknown";

/** `unknown` quando o Windows devolve "Unspecified" — não se adivinha SSD/HDD. */
export type StorageMediaType = "ssd" | "hdd" | "unknown";

/**
 * Saúde FÍSICA de um disco. Distinta da ocupação: espaço livre não é saúde.
 * Cada contador é `null` quando o Windows não o devolveu (por exemplo, sem
 * elevação), com `countersStatus`/`countersDetail` a explicar porquê.
 */
export interface StorageDiskSnapshot {
  deviceId: string;
  model: string;
  mediaType: StorageMediaType;
  busType: string | null;
  sizeGb: number | null;
  healthStatus: StorageDiskHealthStatus;
  operationalStatus: string | null;
  temperatureC: number | null;
  wearPercent: number | null;
  powerOnHours: number | null;
  readErrorsTotal: number | null;
  readErrorsUncorrected: number | null;
  writeErrorsTotal: number | null;
  writeErrorsUncorrected: number | null;
  countersStatus: StorageCountersStatus;
  countersDetail: string | null;
}

export interface DiskSnapshot {
  readStatus: DiskReadStatus;
  /** Motivo em PT-PT, para o utilizador. `null` só quando `readStatus === "ok"`. */
  reason: string | null;
  /** Momento (ISO) da última leitura BEM-SUCEDIDA. `null` = nunca houve. */
  lastGoodAt: string | null;
  /** Todos os volumes lidos (vazio quando não há leitura). */
  volumes: DiskVolumeSnapshot[];
  /** Volume principal: o que hospeda o Windows (C:), senão o de trabalho mais cheio. */
  primary: DiskVolumeSnapshot | null;
  /**
   * Campos derivados do volume principal, para compatibilidade dos ecrãs.
   * **`null` quando não há leitura — NUNCA 0**: encher um campo de medição com
   * zero é dizer "medi e está vazio", que é precisamente a mentira que o
   * utilizador viu no PC Center.
   */
  usagePercent: number | null;
  usedGb: number | null;
  totalGb: number | null;
  /**
   * Saúde física dos discos. Opcional: snapshots antigos não a trazem, e uma
   * máquina sem leitura não inventa uma lista vazia com ar de "saudável".
   */
  physical?: StorageDiskSnapshot[];
  /** Estado da leitura de saúde física (contadores). */
  physicalStatus?: StorageCountersStatus;
  /** Motivo legível quando os contadores não estão disponíveis. */
  physicalDetail?: string | null;
  /**
   * Atividade medida por volume (leitura/escrita em bytes/s e IOPS). Eixo
   * DIFERENTE de `physical*`: atividade é o que o disco está a fazer agora,
   * saúde física é o estado do dispositivo. Omitido quando ainda não há
   * medição — um array vazio com ar de "discos calmos" seria a mesma mentira
   * dos 0 B/s que este trabalho existe para eliminar.
   */
  activity?: DiskActivityReading[];
  /** Estado da aquisição de atividade, separado do estado da capacidade. */
  activityStatus?: ReadingStatus;
  /** Motivo legível quando a atividade não está disponível. */
  activityDetail?: string | null;
  /**
   * Momento (ISO) em que a última leitura BEM-SUCEDIDA terminou. Nunca é a
   * hora do snapshot: dois snapshots sem leitura nova partilham este valor.
   */
  physicalUpdatedAt?: string;
  /** `true` quando a última leitura boa já excedeu o prazo de validade. */
  physicalStale?: boolean;
  /** Erro da tentativa de leitura mais recente (sem apagar o último valor bom). */
  physicalErrorDetail?: string | null;
  fsType: string;
}

/**
 * Estado de uma leitura de hardware no PC Center.
 *
 * O motivo de existir para além de `TemperatureStatus` é o requisito explícito
 * de distinguir quatro coisas que antes se confundiam:
 *   `available`     — medido agora;
 *   `stale`         — medido há pouco, mas já fora do TTL (mostrar como antigo);
 *   `unavailable`   — sem leitura atual (erro, sem dados, expirado de mais);
 *   `error`         — o provider falhou;
 *   `unsupported`   — o hardware/OS NÃO expõe este sensor (não é falha nossa);
 *   `not-applicable`— a pergunta não se aplica a esta máquina (ex.: saúde da
 *                     bateria num computador de secretária sem bateria).
 * `unsupported` e `not-applicable` nunca podem ser apresentados como "saudável"
 * nem como "problema": são a resposta honesta a "não se pode saber".
 */
export type ReadingStatus =
  | "available"
  | "stale"
  | "unavailable"
  | "error"
  | "unsupported"
  | "not-applicable";

/** Utilização de um processador lógico. `percent` null = sem leitura (nunca 0). */
export interface CpuCoreReading {
  index: number;
  percent: number | null;
  status: ReadingStatus;
}

/**
 * Frequência do CPU. As duas perguntas separam-se porque as fontes separam-se:
 * a referência vem de metadados do processador, a atual de uma contagem. Quando
 * o OS não distingue as duas, `currentMHz === referenceMHz` e a UI tem de poder
 * dizê-lo — por isso existe `measuredAsCurrent`.
 */
export interface CpuFrequencyReading {
  currentMHz: number | null;
  referenceMHz: number | null;
  /** `false` quando o "atual" é na verdade o nominal declarado pelo OS. */
  measuredAsCurrent: boolean;
  status: ReadingStatus;
  source: string;
  updatedAt?: string;
  /** Motivo legível quando `status` não é `available`. */
  reason?: string;
}

/**
 * Memória comprometida (commit) — o número do Gestor de Tarefas "Em utilização /
 * Limite". NÃO é o ficheiro de paginação nem a RAM em uso: é o total de
 * endereço virtual reservado com backing store. Medido em kernel32
 * (GlobalMemoryStatusEx), sem PowerShell.
 */
export interface MemoryCommitReading {
  usedBytes: number | null;
  limitBytes: number | null;
  availableBytes: number | null;
  status: ReadingStatus;
  source: string;
  updatedAt?: string;
  /** Motivo legível quando `status` não é `available`. */
  reason?: string;
}

/** Página/ficheiro de paginação. `totalBytes` é DERIVADO (limite − RAM): marcado. */
export interface PagefileReading {
  totalBytes: number | null;
  usedBytes: number | null;
  /** O total é derivado do limite de compromisso, não medido no ficheiro. */
  totalIsDerived: boolean;
  status: ReadingStatus;
  source: string;
  updatedAt?: string;
}

/** Módulo de RAM físico, quando o firmware o expõe (Win32_PhysicalMemory). */
export interface RamModuleReading {
  bank: string | null;
  capacityBytes: number | null;
  type: string | null;
  speedMHz: number | null;
  manufacturer: string | null;
  partNumber: string | null;
}

/** Ocupação dos slots: só se conta um slot como ocupado com módulo detetado. */
export interface RamLayoutReading {
  modules: RamModuleReading[];
  slotsOccupied: number;
  /** Slots totais declarados pelo firmware; null quando não reportado. */
  slotsTotal: number | null;
  status: ReadingStatus;
  source: string;
  updatedAt?: string;
}

/**
 * Energia adaptada: o estado do adaptador e da bateria medidos em kernel32
 * (GetSystemPowerStatus). `hasBattery=false` comprovado é o que permite dizer
 * "Sem bateria — computador de secretária" sem inventar 0 %.
 */
export interface PowerReading {
  acLine: "on" | "off" | "unknown";
  /**
   * `null` = sem leitura do kernel. Não é `false`: afirmar "não há bateria" sem
   * prova é exatamente o erro que produz uma saúde de bateria de 0 % numa
   * máquina onde o sensor nunca respondeu.
   */
  hasBattery: boolean | null;
  isCharging: boolean | null;
  batteryPercent: number | null;
  remainingMinutes: number | null;
  batteryLow: boolean;
  status: ReadingStatus;
  source: string;
  updatedAt?: string;
  reason?: string;
}

/** Adaptador de rede com estado e contadores acumulados (taxas calculadas por nós). */
export interface NetworkAdapterReading {
  iface: string;
  label: string | null;
  kind: "wired" | "wireless" | "loopback" | "virtual" | "unknown";
  operstate: string | null;
  speedMbps: number | null;
  ip4: string | null;
  mac: string | null;
  rxBytesTotal: number | null;
  txBytesTotal: number | null;
  /** Nulo enquanto não existem duas amostras — o que permite calcular a taxa. */
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  status: ReadingStatus;
  updatedAt?: string;
}

/** Atividade de E/S por volume, medida pelos contadores do Windows. */
export interface DiskActivityReading {
  mount: string | null;
  device: string | null;
  readBytesPerSec: number | null;
  writeBytesPerSec: number | null;
  readsPerSec: number | null;
  writesPerSec: number | null;
  /**
   * `% Idle Time` do volume, tal como o Monitor de Recursos o mostra. É o
   * indicador de pressão do disco; `null` significa "não medido", nunca "0 %".
   */
  idlePercent?: number | null;
  status: ReadingStatus;
  source: string;
  updatedAt?: string;
}

/** Identidade física do disco (interface NVMe/SATA, tipo, SMART reportado). */
export interface DiskDeviceReading {
  device: string;
  name: string | null;
  type: string | null;
  interfaceType: string | null;
  sizeBytes: number | null;
  /** `smartStatus` literal reportado pelo firmware/OS (ex.: "Ok"). Não é
   *  diagnóstico nosso: sem relatório, `null` → saúde não verificada. */
  smartStatus: string | null;
  temperatureC: number | null;
  status: ReadingStatus;
  source: string;
  updatedAt?: string;
}

export interface HardwareSnapshot {
  cpu: {
    usage: number;
    /**
     * Estado da leitura de uso de CPU. Opcional por compatibilidade com
     * snapshots antigos (a candidata anterior não o traz): a ausência do campo
     * significa "tratar como available", nunca "0% garantido".
     * Uma falha de leitura NUNCA pode ser apresentada como 0% medido.
     */
    usageStatus?: TemperatureStatus;
    /** Momento (ISO) da última leitura boa de uso de CPU. */
    usageUpdatedAt?: string;
    model: string;
    cores: number;
    speed: number;
    /**
     * Processadores lógicos (threads) contados uma única vez. `cores` mantém o
     * significado histórico; este campo diz explicitamente o que é lógico.
     */
    logicalCores?: number | null;
    /** Núcleos físicos declarados pelo firmware; `null` = não reportado. */
    physicalCores?: number | null;
    /**
     * Utilização por processador lógico, indexada por `index`. A ausência do
     * campo significa "sem leitura", NUNCA "todos a 0 %".
     */
    perCore?: CpuCoreReading[];
    /**
     * ISO da última leitura BEM-SUCEDIDA da tabela por núcleo. A tabela vem na
     * mesma resposta de `currentLoad`; quando este campo falta, `perCore` também
     * não deve existir — a UI mostra "sem leitura por núcleo", nunca 0 %.
     */
    perCoreUpdatedAt?: string;
    /** Frequência atual vs. de referência, com origem declarada. */
    frequency?: CpuFrequencyReading;
    temperature: number | null;
    /** Estado do sensor térmico da CPU (auditado: Ryzen sem MSAcpi expõe "unavailable", nada inventado). */
    temperatureStatus?: TemperatureStatus;
  };
  /**
   * RAM medida vs. hipótese (TP-HARDWARE-MEASURED-CONTRACT). A leitura de RAM
   * era publicada como `number` desde o arranque: um 0 sem amostra (ou um erro
   * do provider) ficava indistinguível de "RAM ociosa medida".
   */
  ram: {
    /**
     * Utilização de RAM (%) da leitura ATUAL. `null` = não há leitura atual —
     * NUNCA significa 0%. Ver `usageStatus` e `usageLastGoodPercent`.
     */
    usagePercent: number | null;
    /** Memória usada da leitura atual (GB); `null` quando não há leitura atual. */
    usedGb: number | null;
    /**
     * Capacidade total instalada (GB): propriedade da máquina, não uma medição.
     * `null` = DESCONHECIDA (nunca foi medida) — nunca 0 GB. Quando existe,
     * mantém o último valor conhecido mesmo com a utilização `unavailable`.
     */
    totalGb: number | null;
    /**
     * Estado da leitura atual. AUSÊNCIA num snapshot significa estado NÃO
     * CONFIRMADO (snapshots antigos/outros produtores): não implica `available`
     * nem autoriza tratar o número como medição — cada consumidor decide a sua
     * política explicitamente.
     */
    usageStatus?: TemperatureStatus;
    /**
     * ISO da última leitura BEM-SUCEDIDA (não da publicação). A frescura da
     * medição decide-se pelo `usageStatus`, nunca por este campo sozinho.
     */
    usageUpdatedAt?: string;
    /**
     * Última leitura boa retida, mesmo já fora do TTL, para poder ser mostrada
     * como "última leitura conhecida" (CACHED). `null`/ausente = nunca houve
     * leitura boa. Não é carga atual e não entra no stress.
     */
    usageLastGoodPercent?: number | null;
    /**
     * Memória disponível para novos alocaimentos físicos (GB), medida. `null`
     * quando não há leitura atual — nunca 0 GB "disponível".
     */
    availableGb?: number | null;
    /**
     * Reservada pelo sistema/não disponível ao processo (GB). Derivada de
     * total − disponível − em uso; por isso `reservedIsDerived`.
     */
    reservedGb?: number | null;
    reservedIsDerived?: boolean;
    /** Compromisso (commit) medido em kernel32, sem PowerShell. */
    commit?: MemoryCommitReading;
    pagefile?: PagefileReading;
    /** Módulos físicos: utilização ≠ saúde. Nenhum campo daqui diz que a RAM está boa. */
    layout?: RamLayoutReading;
  };
  /** Armazenamento: capacidade por volume + estado de leitura explícito (ver `DiskSnapshot`). */
  disk: DiskSnapshot;
  network: {
    rxSec: number;
    txSec: number;
    interfaceName: string;
    /**
     * Estado da leitura de tráfego (TP-PAP-NETWORK-TRUTH). Primeira leitura
     * ainda não feita = "pending"; falha recente = "stale" (valores são a
     * última leitura); sem leitura atual/recente = "unavailable".
     * Ausente em snapshots antigos: a UI trata como "available" quando o
     * `interfaceName` é válido (compatibilidade documentada).
     */
    readStatus?: "pending" | "available" | "stale" | "unavailable";
    /** Instante ISO da última leitura válida. */
    updatedAt?: string;
    /**
     * Um por adaptador, com estado e contadores acumulados. O agregado acima é
     * a soma dos adaptadores medidos; sem esta lista não se pode dizer qual
     * interface está a transportar o tráfego nem que velocidade anuncia.
     */
    adapters?: NetworkAdapterReading[];
  };
  /**
   * Alimentar e bateria medidos em kernel32 (zero subprocessos). Existe em
   * separado de `battery` porque a pergunta é outra: `battery` responde "que
   * bateria vê o provider", `power` responde "de onde vem a energia agora".
   */
  power?: PowerReading;
  /**
   * Bateria. `hasBattery`/`percent`/`isCharging`/`timeRemaining` mantêm-se por
   * compatibilidade; `status` é o eixo de verdade da leitura (opcional em
   * snapshots antigos) e `updatedAt`/`source` só existem com leitura real.
   */
  battery: {
    hasBattery: boolean;
    percent: number;
    isCharging: boolean;
    timeRemaining: number | null;
    status?: BatteryReadStatus;
    /** ISO da última leitura boa; ausente quando nunca houve leitura. */
    updatedAt?: string;
    /** Provider que originou a leitura; nunca preenchido sem leitura real. */
    source?: string;
    /**
     * Saúde da bateria (capacidades reais). Campos opcionais: snapshots antigos
     * não os trazem. `healthPercent` só existe quando as capacidades são
     * válidas — a ausência do campo é "não medido", nunca 0%.
     */
    designCapacityWh?: number | null;
    maxCapacityWh?: number | null;
    /** Saúde percentual (0–100) = capacidade máxima / original. */
    healthPercent?: number | null;
    /** Desgaste percentual (0–100) = 100 − saúde. */
    wearPercent?: number | null;
    /** Ciclos de carga; ausente quando o firmware não os reporta. */
    cycleCount?: number | null;
    /**
     * Estado da leitura de saúde, distinto do estado de carga (`status`):
     * `available` = calculada; `unsupported` = o firmware não expõe
     * capacidades; `invalid` = valores implausíveis; `absent` = sem bateria
     * (a UI apresenta "Não aplicável").
     */
    healthStatus?: "available" | "invalid" | "unsupported" | "absent";
    /** Motivo legível quando `healthStatus` não é `available`. */
    healthDetail?: string;
  };
  gpu: {
    usagePercent: number | null;
    /**
     * Estado da leitura de utilização do GPU (mesma aquisição PMLog que dá a
     * temperatura). Ausente = o produtor não reporta utilização; `unavailable` =
     * reportou e não houve leitura. Em nenhum dos casos `usagePercent` é 0 %.
     */
    usageStatus?: TemperatureStatus;
    /** ISO da última leitura boa de utilização. */
    usageUpdatedAt?: string;
    /** Contador exato que produziu a percentagem (proveniência auditável). */
    usageSource?: string;
    /** Utilização da VRAM em %, quando o driver expõe ActivityMemory. */
    vramUsedPercent?: number | null;
    vramTotalMb: number | null;
    vramUsedMb: number | null;
    temperature: number | null;
    model: string;
    /** Temperatura principal/core da GPU (igual a `temperature`; explícito para a UI). */
    coreTemperature?: number | null;
    /** Temperatura do hotspot (não mostrada como "GPU" sem rótulo). */
    hotspotTemperature?: number | null;
    /** Temperatura do Memory Junction (não mostrada como "GPU" sem rótulo). */
    memoryJunctionTemperature?: number | null;
    /** Estado do sensor térmico da GPU: uma leitura falhada não apaga um valor ainda recente. */
    temperatureStatus?: TemperatureStatus;
    /** Momento da última leitura boa de temperatura (ISO) */
    temperatureUpdatedAt?: string;
    /** Provider user-mode que originou a temperatura (ex.: systeminformation, ACPI). */
    temperatureSource?: string;
    /** Nome do sensor exato que originou o valor principal (ex.: "GPU Core"). */
    temperatureSensor?: string;
    /** GPU escolhida é dedicada (discreta)? Derivado do modelo — nunca `controller[0]` cego. */
    dedicated?: boolean;
    /**
     * A placa foi DETETADA? `false` só quando o sistema não reportou nenhum
     * controlador gráfico — distinto de "ainda sem leitura" (`gpu === null`).
     * Ausência de temperatura/utilização NUNCA deve ser lida como ausência de
     * placa gráfica.
     */
    available?: boolean;
    /** Todas as GPUs detetadas (a UI pode não mostrar, mas o dado é real). */
    gpus?: GpuSnapshot[];
  } | null;
  system: { uptime: number; platform: string; osVersion: string; hostname: string };
  topProcessesByCpu: ProcessSnapshot[];
  topProcessesByRam: ProcessSnapshot[];
  stressScore: number;
  /** Breakdown of stress score contributions by category */
  stressContributions?: StressContributions;
  alerts: HardwareAlert[];
  timestamp: string;
}

/** Contribution of each category to the stress score (0–100 total) */
export interface StressContributions {
  cpu: number;
  ram: number;
  temperature: number;
  gpu: number;
}

/**
 * Estado de uma leitura de sensor. `stale` significa que a última leitura boa
 * ainda é recente (dentro do TTL) mas a poll mais recente falhou — o valor
 * mostrado não desaparece imediatamente.
 */
export type TemperatureStatus = "available" | "stale" | "unavailable" | "error";

/**
 * Estado da leitura de bateria (TP-BATTERY-C1-C2, decisão do owner):
 * `present` = bateria detetada por uma leitura boa (`percent` 0 é real);
 * `absent` = o provider respondeu e NÃO há bateria (ausência comprovada —
 * o único estado que autoriza `percent` 0 sem significado);
 * `unavailable` = sem leitura atual (nunca lida ou expirada);
 * `error` = o provider falhou sem qualquer leitura boa anterior.
 * `error`/`unavailable` NUNCA podem ser apresentados como "sem bateria".
 */
export type BatteryReadStatus = "present" | "absent" | "unavailable" | "error";

export interface GpuSnapshot {
  model: string;
  usagePercent: number | null;
  usageStatus?: TemperatureStatus;
  usageUpdatedAt?: string;
  usageSource?: string;
  vramUsedPercent?: number | null;
  vramTotalMb: number | null;
  vramUsedMb: number | null;
  temperature: number | null;
  temperatureStatus?: TemperatureStatus;
  temperatureUpdatedAt?: string;
  dedicated: boolean;
}

// ── Process Analysis ──

/**
 * Contrato base (foundation) para o futuro Task Manager (READ-ONLY hoje).
 * Garante que os dados de processo possam fornecer, quando permitido:
 * PID, nome, CPU, memória, caminho, utilizador e reputação/estado.
 * `ProcessSnapshot` (já usado pelo TaskManagerPage existente) e `WindowsTopProcess`
 * fornecem estes campos; este tipo documenta a superfície mínima que o Task
 * Manager consumirá no futuro.
 */
export interface TaskProcessEntry {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryMb: number;
  path?: string;
  user?: string;
  /** Reputação: estado/veredito futuro (ex.: motor de reputação local). */
  reputation?: "trusted" | "neutral" | "untrusted";
  /** Estado futuro (ex.: "running" | "suspended"), quando disponível. */
  state?: string;
}

export interface ProcessAnalysisResult {
  process: ProcessSnapshot;
  fileScan: FileScanResponse | null;
  virusTotal: VirusTotalResult | null;
  isCritical: boolean;
  /**
   * `inconclusive` = o motor não conseguiu avaliar o ficheiro. Não é uma
   * opinião sobre o processo; é a ausência de opinião. A UI tem de o desenhar
   * como tal — um badge verde com a palavra "Seguro" aqui seria uma mentira.
   */
  recommendation: "safe" | "suspicious" | "dangerous" | "inconclusive";
}

export interface TrainingResult {
  correctCount: number;
  totalCount: number;
  score: number;
  completedAt: string;
}

export interface TrainingScenario {
  id: string;
  url: string;
  description: string;
  isSafe: boolean;
  explanation: string;
}

export type GameType = "phishing" | "password" | "attachments" | "decisions" | " ransomware" | "navigation" | "alerts";

export interface PasswordChallenge {
  id: string;
  password: string;
  strength: "weak" | "medium" | "strong";
  reasons: string[];
}

export interface AttachmentChallenge {
  id: string;
  filename: string;
  isDangerous: boolean;
  explanation: string;
  redFlags: string[];
}

export interface DecisionScenario {
  id: string;
  situation: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface AlertResponseScenario {
  id: string;
  alertMessage: string;
  alertType: "virus" | "update" | "login" | "download" | "permission";
  options: string[];
  correctIndex: number;
  explanation: string;
}

export const PASSWORD_CHALLENGES: PasswordChallenge[] = [
  { id: "p1", password: "123456", strength: "weak", reasons: ["Sequência numérica muito simples", "Muito usado em ataques de dicionário", "Sem combinação de caracteres"] },
  { id: "p2", password: "senha123", strength: "weak", reasons: ["Palavra comum do dicionário", "Sequência previsível", "Fácil de adivinhar"] },
  { id: "p3", password: "Tr0ub4dor&3", strength: "medium", reasons: ["Substituição previsível (o por 0)", "Palavra do dicionário base", "Poderia ser mais longa"] },
  { id: "p4", password: "K9#mP2$xL@nQ8", strength: "strong", reasons: ["16 caracteres aleatórios", "Mistura maiúsculas, minúsculas, números e símbolos", "Sem palavras de dicionário"] },
  { id: "p5", password: "minhaSenhaForte2024!", strength: "medium", reasons: ["Frase passphrase é boa", "Mas usa palavras conhecidas", "Poderia usar palavras aleatórias"] },
  { id: "p6", password: "qwerty", strength: "weak", reasons: ["Sequência de teclado padrão", "Extremamente comum", "Sem variação"] },
  { id: "p7", password: "C0ntr4s3n@_S3gUr4", strength: "strong", reasons: ["Boa combinação de caracteres", "Tamanho razoável", "Mistura de tipos"] },
  { id: "p8", password: "admin", strength: "weak", reasons: ["Nome de usuário padrão", "Extremamente comum", "Sem caracteres especiais"] },
  { id: "p9", password: "Xy9#kL2@mNpQ", strength: "strong", reasons: ["完全ランダム", "Mistura completa de caracteres", "Impossível de adivinhar"] },
  { id: "p10", password: "amor123", strength: "weak", reasons: ["Palavra pessoal previsível", "Sequência numérica simples", "Informação pessoal"] },
];

export const ATTACHMENT_CHALLENGES: AttachmentChallenge[] = [
  { id: "a1", filename: "invoice.pdf.exe", isDangerous: true, explanation: "Extensão dupla! O verdadeiro tipo é .exe disfarçado de PDF", redFlags: ["Extensão dupla", "Executável mascarado"] },
  { id: "a2", filename: "relatorio_oficial.docm", isDangerous: true, explanation: "Arquivo Word com macros (.docm) pode executar código malicioso", redFlags: ["Extensão .docm", "Macros habilitados"] },
  { id: "a3", filename: "photo_vacation.jpg", isDangerous: false, explanation: "Imagem comum, extensão legítima, sem comportamentos suspeitos", redFlags: [] },
  { id: "a4", filename: "urgent_payment.scr", isDangerous: true, explanation: "Arquivo .scr é executável, muito usado em malware", redFlags: ["Extensão .scr", "Palavra 'urgent'"] },
  { id: "a5", filename: "documento.pdf", isDangerous: false, explanation: "PDF comum, formato amplamente usado em documentos legítimos", redFlags: [] },
  { id: "a6", filename: "winner_lottery.txt", isDangerous: false, explanation: "Arquivo de texto simples, sem risco de execução", redFlags: [] },
  { id: "a7", filename: "install_update.bat", isDangerous: true, explanation: "Batch script pode executar qualquer comando no sistema", redFlags: ["Extensão .bat", "Solicita instalação"] },
  { id: "a8", filename: "planilha_financial.xlsx", isDangerous: false, explanation: "Excel comum, formato legítimo para planilhas", redFlags: [] },
  { id: "a9", filename: "free_game.zip.exe", isDangerous: true, explanation: "Executável dentro de arquivo compactado, técnica comum de evasão", redFlags: ["Extensão dupla", "Promessa de 'free'"] },
  { id: "a10", filename: "presentation.ppsx", isDangerous: true, explanation: "PowerPoint Show pode executar macros automaticamente", redFlags: ["Extensão .ppsx", "Pode conter macros"] },
];

export const DECISION_SCENARIOS: DecisionScenario[] = [
  { id: "d1", situation: "Você recebe um email do 'suporte@bank-seguro.com' pedindo para confirmar sua senha", options: ["Clicar no link e logar", "Ignorar e verificar diretamente no site do banco", "Responder o email com os dados"], correctIndex: 1, explanation: "Nunca clique em links de emails pedindo dados sensíveis. Acesse o site diretamente pelo navegador." },
  { id: "d2", situation: "Um site pede permissão para instalar uma 'extensão de segurança' para continuar", options: ["Aceitar e instalar", "Recusar e sair do site", "Aceitar só desta vez"], correctIndex: 1, explanation: "Sites legítimos nunca pedem para instalar extensões assim. Isso é malware disfarçado." },
  { id: "d3", situation: "Seu antivírus detecta um arquivo suspeito e oferece opções: 'Quarentena' ou 'Ignorar'", options: ["Ignorar, deve ser falso positivo", "Colocar em quarentena", "Apagar imediatamente"], correctIndex: 1, explanation: "Quarentena é a melhor opção: isola o arquivo mas não o apaga, permitindo análise posterior." },
  { id: "d4", situation: "Um colega de trabalho pede para você abrir um arquivo 'presente.exe' no pendrive dele", options: ["Abrir para ser educado", "Recusar e escanear primeiro", "Abrir em máquina virtual"], correctIndex: 1, explanation: "Sempre escaneie arquivos de fontes desconhecidas, mesmo de colegas." },
  { id: "d5", situation: "Navegando, aparece pop-up dizendo 'Seu computador está infectado! Clique aqui'", options: ["Clicar para resolver", "Fechar e ignorá-lo", "Chamar técnico"], correctIndex: 1, explanation: "Pop-ups de 'você está infectado' são quase sempre golpes. Feche e use seu antivírus real." },
  { id: "d6", situation: "Você precisa baixar um software e o site oficial cobra, mas há um site 'gratuito' com download", options: ["Baixar do site gratuito", "Pagar no site oficial", "Procurar alternativa open source"], correctIndex: 1, explanation: "Sites não oficiais frequentemente incluem malware. Pague ou use alternativas legítimas." },
  { id: "d7", situation: "Recebe SMS com link para 'rastrear entrega' de compra que você não fez", options: ["Clicar para ver", "Ignorar e verificar compras", "Responder pedindo detalhes"], correctIndex: 1, explanation: "SMishing (SMS phishing) é comum. Verifique suas compras diretamente nos sites oficiais." },
  { id: "d8", situation: "Seu sistema pede para reiniciar para aplicar 'atualização de segurança crítica'", options: ["Reiniciar agora", "Verificar se é atualização real do sistema", "Adiar para depois"], correctIndex: 1, explanation: "Verifique nas configurações do sistema se há atualizações pendentes antes de reiniciar." },
];

export const ALERT_RESPONSE_SCENARIOS: AlertResponseScenario[] = [
  { id: "ar1", alertMessage: "O antivírus detectou: Trojan.GenericKD.46789234", alertType: "virus", options: ["Ignorar o alerta", "Colocar em quarentena", "Excluir o arquivo"], correctIndex: 1, explanation: "Quarentena isola o arquivo e impede que cause dano, mas permite recuperação se for falso positivo." },
  { alertMessage: "Atualização crítica disponível para seu sistema operacional", alertType: "update", options: ["Adiar para mais tarde", "Atualizar agora", "Ignorar"], correctIndex: 1, explanation: "Atualizações do sistema frequentemente corrigem vulnerabilidades de segurança.", id: "ar2" },
  { alertMessage: "Novo login detectado de: iPhone 14 Pro, São Paulo, Brasil", alertType: "login", options: ["Ignorar", "Revogar acesso", "Mudar senha imediatamente"], correctIndex: 1, explanation: "Revogar acesso é melhor que mudar senha - você pode reautenticar depois.", id: "ar3" },
  { alertMessage: "Deseja permitir que 'SuperDownload.exe' faça alterações no sistema?", alertType: "permission", options: ["Permitir", "Negar", "Ver detalhes primeiro"], correctIndex: 2, explanation: "Sempre verifique o que o programa quer fazer antes de permitir.", id: "ar4" },
  { alertMessage: "Download completado: setup_malware.exe", alertType: "download", options: ["Abrir arquivo", "Escanear antes de abrir", "Apagar diretamente"], correctIndex: 1, explanation: "Escaneie sempre arquivos baixados antes de executar.", id: "ar5" },
  { alertMessage: "Firewall bloqueou conexão suspeita para IP 192.168.1.100", alertType: "virus", options: ["Desativar firewall", "Ignorar", "Investigar a conexão"], correctIndex: 2, explanation: "Conexões bloqueadas podem indicar tentativas de ataque ou malware.", id: "ar6" },
];

const LOOKALIKE_BRANDS = ["paypal", "google", "facebook", "instagram", "microsoft", "bank"];
const SUSPICIOUS_KEYWORDS = [
  "verify",
  "login",
  "urgent",
  "security-check",
  "gift",
  "free",
  "bonus",
  "wallet"
];
const DANGEROUS_EXTENSIONS = [".exe", ".bat", ".scr", ".cmd", ".msi", ".js", ".vbs"];
const DOWNLOAD_SUSPICIOUS_EXTENSIONS = [".exe", ".bat", ".scr", ".zip", ".cmd", ".msi", ".vbs", ".ps1"];
const SOCIAL_ENGINEERING_PATTERNS = [
  /free[-_ ]?robux/i,
  /invoice[-_ ]?\d+/i,
  /urgent[-_ ]?payment/i,
  /crack(ed)?/i,
  /keygen/i
];

function severityFromRules(ruleCount: number): Severity {
  if (ruleCount >= 4) {
    return "critical";
  }
  if (ruleCount === 3) {
    return "high";
  }
  if (ruleCount === 2) {
    return "medium";
  }
  return "low";
}

export function analyzeUrlRisk(rawUrl: string): UrlAnalysisResult {
  const rulesTriggered: HeuristicRuleId[] = [];
  let hostname = "";
  let pathname = "";
  let protocol = "";

  try {
    const parsed = new URL(rawUrl);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname.toLowerCase();
    protocol = parsed.protocol;
  } catch {
    rulesTriggered.push("suspicious_keywords_in_domain_or_path");
    return {
      severity: "high",
      confidence: 0.9,
      rulesTriggered
    };
  }

  if (protocol !== "https:") {
    rulesTriggered.push("no_https");
  }

  if (
    LOOKALIKE_BRANDS.some(
      (brand) =>
        hostname.includes(brand.replace("o", "0")) ||
        hostname.includes(brand.replace("a", "4")) ||
        hostname.includes(brand.replace("i", "1"))
    )
  ) {
    rulesTriggered.push("lookalike_domain");
  }

  if (SUSPICIOUS_KEYWORDS.some((keyword) => hostname.includes(keyword) || pathname.includes(keyword))) {
    rulesTriggered.push("suspicious_keywords_in_domain_or_path");
  }

  const subdomains = hostname.split(".");
  if (subdomains.length >= 5 || hostname.length > 35) {
    rulesTriggered.push("excessive_subdomains_or_length");
  }

  const severity = severityFromRules(rulesTriggered.length);
  const confidence = Math.min(0.35 + rulesTriggered.length * 0.18, 0.98);

  return {
    severity,
    confidence,
    rulesTriggered
  };
}

export function analyzeDownloadFilename(filename: string): UrlAnalysisResult {
  const lower = filename.toLowerCase();
  const rulesTriggered: HeuristicRuleId[] = [];

  if (DANGEROUS_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    rulesTriggered.push("dangerous_file_extension");
  }

  if (SOCIAL_ENGINEERING_PATTERNS.some((pattern) => pattern.test(lower))) {
    rulesTriggered.push("social_engineering_filename_pattern");
  }

  const severity = severityFromRules(rulesTriggered.length);
  const confidence = rulesTriggered.length === 0 ? 0.2 : Math.min(0.4 + rulesTriggered.length * 0.25, 0.97);

  return {
    severity,
    confidence,
    rulesTriggered
  };
}

export function analyzeDownloadEvent(filename: string, url: string): UrlAnalysisResult {
  const lower = filename.toLowerCase();
  const rulesTriggered: HeuristicRuleId[] = [];

  if (DOWNLOAD_SUSPICIOUS_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    rulesTriggered.push("suspicious_download_type");
  }

  if (SOCIAL_ENGINEERING_PATTERNS.some((pattern) => pattern.test(lower))) {
    rulesTriggered.push("social_engineering_filename_pattern");
  }

  const urlAnalysis = analyzeUrlRisk(url);
  for (const rule of urlAnalysis.rulesTriggered) {
    if (!rulesTriggered.includes(rule)) {
      rulesTriggered.push(rule);
    }
  }

  const severity = severityFromRules(rulesTriggered.length);
  const confidence = rulesTriggered.length === 0 ? 0.15 : Math.min(0.4 + rulesTriggered.length * 0.2, 0.98);

  return { severity, confidence, rulesTriggered };
}

export function calculateDownloadRisk(downloadEvents: ThreatEvent[]): Severity {
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const recentDownloads = downloadEvents.filter(
    (e) => (e.source === "download-monitor" || e.source === "dashboard") && e.createdAt > oneMinuteAgo
  );
  if (recentDownloads.length > 5) return "critical";
  if (recentDownloads.length > 3) return "high";
  if (recentDownloads.length > 1) return "medium";
  return "low";
}

export const TRAINING_SCENARIOS: TrainingScenario[] = [
  {
    id: "s1",
    url: "https://accounts.google.com/security",
    description: "Página oficial de segurança da conta Google com HTTPS válido.",
    isSafe: true,
    explanation: "Domínio confiável e conhecido, com protocolo seguro."
  },
  {
    id: "s2",
    url: "http://paypa1-verify-login.security-check.example.ru",
    description: "Página urgente pedindo verificação de credenciais.",
    isSafe: false,
    explanation: "Domínio lookalike (paypa1), sem HTTPS, e padrão de phishing com palavras suspeitas."
  },
  {
    id: "s3",
    url: "https://learn.microsoft.com/",
    description: "Site de documentação educacional da Microsoft.",
    isSafe: true,
    explanation: "Domínio legítimo com conteúdo esperado."
  },
  {
    id: "s4",
    url: "https://facebook-login-bonus-gift.example.com",
    description: "Promete recompensa bônus após fazer login.",
    isSafe: false,
    explanation: "Uso indevido de marca e vocabulário de engenharia social."
  },
  {
    id: "s5",
    url: "https://github.com/microsoft/vscode",
    description: "Repositório oficial do VS Code no GitHub.",
    isSafe: true,
    explanation: "GitHub é uma plataforma confiável e este é um repositório verificado."
  },
  {
    id: "s6",
    url: "http://g00gle-security-alert.free-bonus.example.net/verify",
    description: "Alerta de segurança pedindo verificação imediata da sua conta.",
    isSafe: false,
    explanation: "Domínio lookalike (g00gle), sem HTTPS, URL excessivamente longa, e palavras-chave suspeitas."
  },
  {
    id: "s7",
    url: "https://www.amazon.com.br/",
    description: "Loja online oficial da Amazon Brasil.",
    isSafe: true,
    explanation: "Domínio oficial da Amazon com HTTPS."
  },
  {
    id: "s8",
    url: "http://instagram-free-followers.wallet-bonus.example.com/login",
    description: "Oferece seguidores grátis após fazer login com sua conta do Instagram.",
    isSafe: false,
    explanation: "Promessa de seguidores grátis é engenharia social, domínio falso, sem HTTPS."
  },
  {
    id: "s9",
    url: "https://stackoverflow.com/questions/tagged/javascript",
    description: "Página de perguntas sobre JavaScript no Stack Overflow.",
    isSafe: true,
    explanation: "Plataforma conhecida e confiável para desenvolvedores."
  },
  {
    id: "s10",
    url: "http://bank-security-urgent.verify-account.example.org/login",
    description: "Mensagem urgente do banco pedindo para confirmar seus dados de acesso.",
    isSafe: false,
    explanation: "Domínio com palavras suspeitas (bank, urgent, verify), sem HTTPS, padrão clássico de phishing bancário."
  }
];

/**
 * Le o filtro WFP do CyberSafe, aceitando o alias antigo `firewall`.
 *
 * FONTE UNICA, de proposito: `engine.firewall` e `engine.wfp` significam a MESMA
 * coisa (o filtro WFP), nunca o Firewall do Windows. Qualquer consumidor que
 * precise do modulo passa por aqui, para o alias nao ser esquecido num sitio e a
 * semantica nao divergir noutro.
 */
export function wfpHealth(
  engine?: { wfp?: EngineSubsystemHealth; firewall?: EngineSubsystemHealth },
): EngineSubsystemHealth | undefined {
  return engine?.wfp ?? engine?.firewall;
}

/**
 * Nome a MOSTRAR de cada motor, em PT-PT.
 *
 * Existe porque as findings do `pcstate` imprimem a chave do motor nas
 * evidenceLines. Imprimir `firewall` ai dizia ao utilizador que a proteccao de
 * rede do Windows estava desligada, quando o que se mediu foi o filtro WFP do
 * CyberSafe. A chave continua interna; a palavra e o que o utilizador le.
 */
export const ENGINE_DISPLAY_NAME: Record<string, string> = {
  yara: "YARA",
  hashDb: "Base de assinaturas",
  clamav: "ClamAV",
  nativeEngine: "Motor nativo",
  wfp: "Filtro WFP do CyberSafe",
  // Chave do alias antigo, caso alguma linha antiga a passe. A mesma palavra.
  firewall: "Filtro WFP do CyberSafe",
};

/** Verifica se algum motor de proteção está degradado ou indisponível. */
export function hasDegradedProtections(engine: EngineHealth): boolean {
  const engines = [engine.yara, engine.hashDb, engine.clamav, engine.nativeEngine, wfpHealth(engine)];
  return engines.some(e => e && (e.status === "degraded" || e.status === "unavailable" || e.status === "error"));
}

/** Conta motores ativos vs total reportados. */
export function activeEngineCount(engine: EngineHealth): { active: number; total: number } {
  const engines = [engine.yara, engine.hashDb, engine.clamav, engine.nativeEngine, wfpHealth(engine)];
  const reported = engines.filter(Boolean) as EngineSubsystemHealth[];
  return {
    active: reported.filter(e => e.status === "active").length,
    total: reported.length,
  };
}

// WS-4: orientação honesta sobre um processo (Gestao de Tarefas). Vive aqui
// porque @cybersafe/app só pode importar de @cybersafe/shared-types, e a
// função é pura — sem fetch, sem IPC, sem estado.
export {
  buildProcessGuidance,
  isProtectedProcess,
  PROTECTED_PROCESS_NAMES,
} from "./process-guidance.js";
export type { ProcessGuidance, ProcessPriority, SafeToClose } from "./process-guidance.js";
export {
  buildFindingGuidance,
  buildFindingDado,
  FINDING_SEVERITY_LABEL,
} from "./finding-guidance.js";
export type { FindingGuidance } from "./finding-guidance.js";
export type { ProcessIntelligenceContext } from "./process-intelligence.js";
export { engineContextCopy, engineStatusPt } from "./engine-context.js";
export type { EngineContextCopy } from "./engine-context.js";

// Validação de formato de email partilhada entre a app e a API (16/10/2026):
// evita duas cópias do mesmo regex a divergirem — o caso `gmail.c` passou nas
// duas. Formato, não confirmação.
export { isValidEmailFormat } from "./email-format.js";

// Contrato do updater de aplicação (TP-UPDATE): única exportação destes tipos —
// evita cópias que divergem. Não há mais nada de app-update aqui de propósito.
export * from "./app-update.js";
