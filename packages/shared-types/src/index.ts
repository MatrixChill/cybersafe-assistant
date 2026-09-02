export type Severity = "low" | "medium" | "high" | "critical";
export type ThreatAction = "quarantined" | "alerted" | "logged" | "allowed";
export type ProtectionStatus = "safe" | "attention" | "critical" | "degraded";
export type PlanType = "free" | "personal" | "business";
export type SubscriptionTier = "free" | "pro" | "enterprise";
export type AnalysisVerdict = "safe" | "suspicious" | "malicious";
export type TrustDecision = "trusted" | "neutral" | "untrusted";
export type EventType =
  | "artifact.discovered"
  | "artifact.analyzed"
  | "file.created"
  | "file.modified"
  | "file.renamed"
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
  | "quarantine.restored"
  | "trust.updated"
  | "scan.progress"
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
  | "yara_match"
  | "allowlisted_hash"
  | "unsigned_binary"
  | "known_malware"
  | "office_child_process"
  | "script_spawns_binary"
  | "rapid_process_fanout"
  | "blocked_reexecution";

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
  id: string;
  originalPath: string;
  quarantinePath: string;
  fileName: string;
  sha256?: string;
  verdict: AnalysisVerdict;
  riskScore: number;
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

export interface EngineHealth {
  serviceRunning: boolean;
  osLayerHealthy: boolean;
  degradedReasons: string[];
  monitoredPaths: string[];
  definitionsUpdatedAt?: string;
  lastEventAt?: string;
}

export interface ProtectionStats {
  riskScore: number;
  totalEvents: number;
  highSeverityEvents: number;
  blockedExecutions: number;
  quarantinedCount: number;
  monitoredProcesses: number;
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
}

export interface ThreatEvent {
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
  riskScore: number;
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

export interface FileScanResult {
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
  "process.killTree": { pid: number };
  "process.analyze": { pid: number };
  "quarantine.restore": { id: string; trustAfterRestore?: boolean };
  "quarantine.delete": { id: string };
  "trust.allowHash": { sha256: string };
  "trust.allowPublisher": { publisher: string };
  "definitions.update": { source?: string } | undefined;
  "analysis.restricted": { path: string };
  "hardware.snapshot": undefined;
  "exclusions.get": undefined;
  "exclusions.update": Partial<ExclusionConfig>;
  "scan.start": { type: ScanType; targetPath?: string };
  "scan.cancel": { id: string };
  "threat.action": { id: string; action: "quarantine" | "restore" | "delete" };
  "service.shutdown": undefined;
}

export interface ServiceResponseMap {
  "protection.getState": ProtectionState;
  "events.list": SecurityEvent[];
  "threats.list": ThreatEvent[];
  "processes.list": ProcessSnapshot[];
  "connections.list": ConnectionSnapshot[];
  "quarantine.list": QuarantineEntry[];
  "events.clear": { success: boolean };
  "scan.artifact": FileScanResponse | null;
  "scan.fullSystem": { success: boolean };
  "monitor.start": { success: boolean };
  "monitor.stop": { success: boolean };
  "process.killTree": { success: boolean };
  "process.analyze": ProcessAnalysisResult | null;
  "quarantine.restore": { success: boolean };
  "quarantine.delete": { success: boolean };
  "trust.allowHash": { success: boolean };
  "trust.allowPublisher": { success: boolean };
  "definitions.update": { success: boolean; updatedAt: string };
  "analysis.restricted": AnalysisResult | null;
  "hardware.snapshot": HardwareSnapshot;
  "exclusions.get": ExclusionConfig;
  "exclusions.update": { success: boolean };
  "scan.start": { id: string; success: boolean };
  "scan.cancel": { success: boolean };
  "threat.action": { success: boolean };
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

// ── Hardware Monitoring ──

export interface HardwareAlert {
  severity: "low" | "medium" | "high" | "critical";
  category: "cpu" | "ram" | "disk" | "gpu" | "network" | "system";
  title: string;
  description: string;
  process?: ProcessSnapshot;
  recommendation: string;
}

export interface HardwareSnapshot {
  cpu: { usage: number; model: string; cores: number; speed: number; temperature: number | null };
  ram: { usagePercent: number; usedGb: number; totalGb: number };
  disk: { usagePercent: number; usedGb: number; totalGb: number; fsType: string };
  network: { rxSec: number; txSec: number; interfaceName: string };
  battery: { hasBattery: boolean; percent: number; isCharging: boolean; timeRemaining: number | null };
  gpu: { usagePercent: number | null; vramTotalMb: number | null; vramUsedMb: number | null; temperature: number | null; model: string } | null;
  system: { uptime: number; platform: string; osVersion: string; hostname: string };
  topProcessesByCpu: ProcessSnapshot[];
  topProcessesByRam: ProcessSnapshot[];
  stressScore: number;
  alerts: HardwareAlert[];
  timestamp: string;
}

// ── Process Analysis ──

export interface ProcessAnalysisResult {
  process: ProcessSnapshot;
  fileScan: FileScanResponse | null;
  virusTotal: VirusTotalResult | null;
  isCritical: boolean;
  recommendation: "safe" | "suspicious" | "dangerous";
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
