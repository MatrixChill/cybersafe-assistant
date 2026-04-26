export type Severity = "low" | "medium" | "high" | "critical";
export type ThreatAction = "quarantined" | "alerted" | "logged" | "allowed";
export type ProtectionStatus = "safe" | "attention" | "critical" | "degraded";
export type PlanType = "free" | "personal" | "business";
export type SubscriptionTier = "free" | "pro" | "enterprise";
export type AnalysisVerdict = "safe" | "suspicious" | "malicious";
export type TrustDecision = "trusted" | "neutral" | "untrusted";
export type EventType = "artifact.discovered" | "artifact.analyzed" | "file.created" | "file.modified" | "file.renamed" | "registry.persistence.changed" | "scheduledtask.changed" | "process.started" | "process.exited" | "process.suspicious" | "process.blocked" | "process.killed" | "persistence.detected" | "threat.detected" | "threat.resolved" | "quarantine.added" | "quarantine.restored" | "trust.updated" | "scan.progress" | "engine.health";
export type HeuristicRuleId = "no_https" | "lookalike_domain" | "suspicious_keywords_in_domain_or_path" | "excessive_subdomains_or_length" | "dangerous_file_extension" | "social_engineering_filename_pattern" | "suspicious_download_type" | "high_download_frequency" | "double_extension" | "executable_signature" | "archive_with_exe" | "magic_number_mismatch" | "high_entropy" | "encrypted_payload" | "behavioral_burst" | "process_injection_indicator" | "suspicious_location" | "persistence_attempt" | "trusted_publisher" | "trusted_system_path" | "known_bad_hash" | "yara_match" | "allowlisted_hash" | "unsigned_binary" | "known_malware" | "office_child_process" | "script_spawns_binary" | "rapid_process_fanout" | "blocked_reexecution";
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
    "events.list": {
        limit?: number;
        cursor?: number;
    } | undefined;
    "threats.list": undefined;
    "processes.list": undefined;
    "connections.list": undefined;
    "quarantine.list": undefined;
    "events.clear": undefined;
    "scan.artifact": {
        path: string;
    };
    "monitor.start": {
        paths?: string[];
    } | undefined;
    "monitor.stop": undefined;
    "process.killTree": {
        pid: number;
    };
    "process.analyze": {
        pid: number;
    };
    "quarantine.restore": {
        id: string;
        trustAfterRestore?: boolean;
    };
    "quarantine.delete": {
        id: string;
    };
    "trust.allowHash": {
        sha256: string;
    };
    "trust.allowPublisher": {
        publisher: string;
    };
    "definitions.update": {
        source?: string;
    } | undefined;
    "analysis.restricted": {
        path: string;
    };
    "hardware.snapshot": undefined;
    "exclusions.get": undefined;
    "exclusions.update": Partial<ExclusionConfig>;
}
export interface ServiceResponseMap {
    "protection.getState": ProtectionState;
    "events.list": SecurityEvent[];
    "threats.list": ThreatEvent[];
    "processes.list": ProcessSnapshot[];
    "connections.list": ConnectionSnapshot[];
    "quarantine.list": QuarantineEntry[];
    "events.clear": {
        success: boolean;
    };
    "scan.artifact": FileScanResponse | null;
    "monitor.start": {
        success: boolean;
    };
    "monitor.stop": {
        success: boolean;
    };
    "process.killTree": {
        success: boolean;
    };
    "process.analyze": ProcessAnalysisResult | null;
    "quarantine.restore": {
        success: boolean;
    };
    "quarantine.delete": {
        success: boolean;
    };
    "trust.allowHash": {
        success: boolean;
    };
    "trust.allowPublisher": {
        success: boolean;
    };
    "definitions.update": {
        success: boolean;
        updatedAt: string;
    };
    "analysis.restricted": AnalysisResult | null;
    "hardware.snapshot": HardwareSnapshot;
    "exclusions.get": ExclusionConfig;
    "exclusions.update": {
        success: boolean;
    };
}
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
export interface HardwareSnapshot {
    cpu: {
        usage: number;
        model: string;
        cores: number;
        speed: number;
        temperature: number | null;
    };
    ram: {
        usagePercent: number;
        usedGb: number;
        totalGb: number;
    };
    disk: {
        usagePercent: number;
        usedGb: number;
        totalGb: number;
        fsType: string;
    };
    network: {
        rxSec: number;
        txSec: number;
        interfaceName: string;
    };
    battery: {
        hasBattery: boolean;
        percent: number;
        isCharging: boolean;
        timeRemaining: number | null;
    };
    stressScore: number;
    stressAlerts: string[];
    timestamp: string;
}
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
export declare const PASSWORD_CHALLENGES: PasswordChallenge[];
export declare const ATTACHMENT_CHALLENGES: AttachmentChallenge[];
export declare const DECISION_SCENARIOS: DecisionScenario[];
export declare const ALERT_RESPONSE_SCENARIOS: AlertResponseScenario[];
export declare function analyzeUrlRisk(rawUrl: string): UrlAnalysisResult;
export declare function analyzeDownloadFilename(filename: string): UrlAnalysisResult;
export declare function analyzeDownloadEvent(filename: string, url: string): UrlAnalysisResult;
export declare function calculateDownloadRisk(downloadEvents: ThreatEvent[]): Severity;
export declare const TRAINING_SCENARIOS: TrainingScenario[];
