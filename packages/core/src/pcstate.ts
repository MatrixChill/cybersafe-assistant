import { IMPORTANT_WINDOWS_SERVICES } from "@cybersafe/shared-types";
import type {
  Finding,
  FindingCategory,
  FindingEvidence,
  FindingSeverity,
  HardwareSnapshot,
  PcState,
  PcStateCounts,
  PcStateLevel,
  ProtectionState,
  ThreatEvent,
  WindowsHealthSnapshot,
} from "@cybersafe/shared-types";

export interface MetricSample {
  cpu: number;
  ram: number;
  disk: number;
  timestamp: number;
}

export interface PcStateConfig {
  sustainedSamples: number;
  graceSamples: number;
  maxSamples: number;
  ramAttentionPercent: number;
  ramRecommendedPercent: number;
  cpuAttentionPercent: number;
  cpuRecommendedPercent: number;
  diskAttentionFreePercent: number;
  diskRecommendedFreePercent: number;
  maxWindowsRecommendations: number;
}

export const DEFAULT_PC_STATE_CONFIG: PcStateConfig = {
  sustainedSamples: 3,
  graceSamples: 1,
  maxSamples: 30,
  ramAttentionPercent: 90,
  ramRecommendedPercent: 80,
  cpuAttentionPercent: 90,
  cpuRecommendedPercent: 75,
  diskAttentionFreePercent: 10,
  diskRecommendedFreePercent: 20,
  maxWindowsRecommendations: 3,
};

export interface PcStateEngineInput {
  hardware: HardwareSnapshot | null;
  protection: ProtectionState | null;
  windowsHealth: WindowsHealthSnapshot | null;
  threats: ThreatEvent[];
  now: number;
}

interface Candidate {
  key: string;
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  summary: string;
  source: string;
  evidence: FindingEvidence;
  minSamples: number;
  actionable: boolean;
  actionId?: string;
}

interface ActiveEntry {
  finding: Finding;
  streak: number;
  missed: number;
  minSamples: number;
}

const CLAMP = (v: number): number => Math.min(100, Math.max(0, v));

const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  urgent: 0,
  attention: 1,
  recommended: 2,
  informative: 3,
};

const CATEGORY_ORDER: Record<FindingCategory, number> = {
  security: 0,
  performance: 1,
  system: 2,
  privacy: 3,
};

const IMPERATIVE_ENGINES: Array<"yara" | "hashDb" | "clamav" | "nativeEngine"> = [
  "yara",
  "hashDb",
  "clamav",
  "nativeEngine",
];

type EngineStatusName = "yara" | "hashDb" | "clamav" | "nativeEngine" | "firewall";

const UNAVAILABLE_ENGINES: EngineStatusName[] = [...IMPERATIVE_ENGINES, "firewall"];

function engineNeedsAttention(name: EngineStatusName, engine: ProtectionState["engine"] | undefined): boolean {
  const status = engine?.[name]?.status;
  return status === "unavailable" || status === "degraded";
}

const WINDOWS_CATEGORY_BY_ID: Record<string, FindingCategory> = {
  "ram-high": "performance",
  "ram-attention": "performance",
  "many-cpu-processes": "performance",
  "disk-critical": "system",
  "disk-attention": "system",
  "service-down": "system",
  "firewall-disabled": "security",
};

export function normalizeSample(hardware: HardwareSnapshot): MetricSample {
  return {
    cpu: CLAMP(hardware.cpu.usage),
    ram: CLAMP(hardware.ram.usagePercent),
    disk: CLAMP(hardware.disk.usagePercent),
    timestamp: Date.parse(hardware.timestamp) || Date.now(),
  };
}

function trailingStreak(samples: MetricSample[], getter: (s: MetricSample) => number, threshold: number): number {
  let streak = 0;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (getter(samples[i]) >= threshold) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

function topProcessCpu(hardware: HardwareSnapshot | null): FindingEvidence {
  if (!hardware) return {};
  const top = hardware.topProcessesByCpu[0];
  if (!top || top.cpu < 50 || top.cpu < hardware.cpu.usage * 0.5) return {};
  return { processName: top.name, pid: top.pid, cpuPercent: Math.round(top.cpu) };
}

function topProcessRam(hardware: HardwareSnapshot | null): FindingEvidence {
  if (!hardware) return {};
  const top = hardware.topProcessesByRam[0];
  if (!top || top.memoryMb < 512) return {};
  return { processName: top.name, pid: top.pid, memoryBytes: Math.round(top.memoryMb * 1024 * 1024) };
}

function windowsCategoryForId(id: string): FindingCategory {
  return WINDOWS_CATEGORY_BY_ID[id] ?? "system";
}

function securityCandidates(input: PcStateEngineInput): Candidate[] {
  const p = input.protection;
  if (!p) return [];

  const engine = p.engine;
  const out: Candidate[] = [];

  if (engine && engine.serviceRunning === false) {
    out.push({
      key: "security:service-stopped",
      category: "security",
      severity: "urgent",
      title: "Serviço de proteção está parado",
      summary: "O serviço de proteção do CyberSafe está desligado e os motores de deteção não estão a correr.",
      source: "protection-engine",
      evidence: { engine: "service", engineStatus: "unavailable", status: "stopped" },
      minSamples: 1,
      actionable: true,
      actionId: "monitor.start",
    });
    return out;
  }

  if (engine) {
    const errored = IMPERATIVE_ENGINES.filter((name) => engine[name]?.status === "error");
    if (errored.length > 0) {
      out.push({
        key: "security:engine-error",
        category: "security",
        severity: "urgent",
        title: "Erro num motor de deteção",
        summary: `Motor(es) de deteção com erro: ${errored.join(", ")}. O sistema não consegue analisar ficheiros de forma fiável.`,
        source: "protection-engine",
        evidence: {
          engine: errored.join(", "),
          engineStatus: "error",
          evidenceLines: errored.map((name) => `${name}: ${engine[name]?.detail ?? "error"}`),
        },
        minSamples: 1,
        actionable: false,
      });
    }

    if (engine.firewall?.status === "error") {
      out.push({
        key: "security:firewall-error",
        category: "security",
        severity: "attention",
        title: "Erro no firewall",
        summary: "A proteção de firewall do sistema reporta um erro.",
        source: "protection-engine",
        evidence: { engine: "firewall", engineStatus: "error", status: engine.firewall.detail },
        minSamples: 1,
        actionable: false,
      });
    }

    const attentionEngines = UNAVAILABLE_ENGINES.filter((name) => engineNeedsAttention(name, engine));
    if (attentionEngines.length > 0) {
      out.push({
        key: "security:engine-unavailable",
        category: "security",
        severity: "attention",
        title: "Proteção parcialmente indisponível",
        summary:
          attentionEngines.length === 1
            ? "Um componente de proteção não está totalmente disponível."
            : `${attentionEngines.length} componentes de proteção precisam de atenção.`,
        source: "protection-engine",
        evidence: {
          engine: attentionEngines.map((name) => `${name} (${engine[name]?.status ?? "unknown"})`).join(", "),
          engineStatus: attentionEngines.map((name) => engine[name]?.status ?? "unknown").join(", "),
          evidenceLines: attentionEngines.map((name) => {
            const sub = engine[name];
            const status = sub?.status ?? "unknown";
            return `${name}: ${status}${sub?.detail ? ` — ${sub.detail}` : ""}`;
          }),
        },
        minSamples: 1,
        actionable: false,
      });
    }

    const specificSecurity = out.some((c) => c.severity === "urgent" || c.severity === "attention");
    if (!specificSecurity && (p.status === "attention" || p.status === "degraded")) {
      out.push({
        key: "security:protection-attention",
        category: "security",
        severity: "attention",
        title: "Proteção requer atenção",
        summary: "O estado geral de proteção indica degradação ou necessidade de atenção.",
        source: "protection-engine",
        evidence: { status: p.status, evidenceLines: engine.degradedReasons ?? [] },
        minSamples: 1,
        actionable: false,
      });
    }

    const noEngineUrgent = !out.some((c) => c.severity === "urgent");
    if (p.status === "critical" && noEngineUrgent) {
      out.push({
        key: "security:protection-critical",
        category: "security",
        severity: "urgent",
        title: "Proteção em estado crítico",
        summary: "O sistema de proteção reporta um estado crítico.",
        source: "protection-engine",
        evidence: { status: p.status },
        minSamples: 1,
        actionable: false,
      });
    }
  }

  const criticalThreat = input.threats.find((t) => t.severity === "critical");
  if (criticalThreat) {
    out.push({
      key: "security:critical-threat",
      category: "security",
      severity: "urgent",
      title: "Ameaça crítica detetada",
      summary: "Existe uma ameaça de severidade crítica registada.",
      source: "threat-monitor",
      evidence: {
        endpoint: criticalThreat.domain || criticalThreat.url,
        status: criticalThreat.action ?? "detected",
        evidenceLines: criticalThreat.summary ? [criticalThreat.summary] : undefined,
      },
      minSamples: 1,
      actionable: false,
    });
  } else {
    const highThreat = input.threats.find((t) => t.severity === "high");
    if (highThreat) {
      out.push({
        key: "security:high-threat",
        category: "security",
        severity: "attention",
        title: "Ameaça alta detetada",
        summary: "Existe uma ameaça de severidade alta registada.",
        source: "threat-monitor",
        evidence: {
          endpoint: highThreat.domain || highThreat.url,
          status: highThreat.action ?? "detected",
          evidenceLines: highThreat.summary ? [highThreat.summary] : undefined,
        },
        minSamples: 1,
        actionable: false,
      });
    }
  }

  return out;
}

function performanceCandidates(samples: MetricSample[], input: PcStateEngineInput, config: PcStateConfig): Candidate[] {
  const out: Candidate[] = [];
  if (samples.length === 0) return out;

  const last = samples[samples.length - 1];

  const ramStreakHigh = trailingStreak(samples, (s) => s.ram, config.ramAttentionPercent);
  if (ramStreakHigh >= config.sustainedSamples) {
    const startTime = samples[samples.length - ramStreakHigh].timestamp;
    out.push({
      key: "perf:ram-high",
      category: "performance",
      severity: "attention",
      title: "Memória RAM muito utilizada",
      summary: `Utilização de RAM sustentada acima de ${config.ramAttentionPercent}% durante várias amostras.`,
      source: "hardware-monitor",
      evidence: {
        memoryPercent: Math.round(last.ram),
        durationSeconds: Math.round((input.now - startTime) / 1000),
        ...topProcessRam(input.hardware),
      },
      minSamples: 1,
      actionable: false,
    });
  } else {
    const ramStreakRec = trailingStreak(samples, (s) => s.ram, config.ramRecommendedPercent);
    if (ramStreakRec >= config.sustainedSamples) {
      const startTime = samples[samples.length - ramStreakRec].timestamp;
      out.push({
        key: "perf:ram-recommended",
        category: "performance",
        severity: "recommended",
        title: "Utilização de RAM elevada",
        summary: `Utilização de RAM sustentada acima de ${config.ramRecommendedPercent}% durante várias amostras.`,
        source: "hardware-monitor",
        evidence: {
          memoryPercent: Math.round(last.ram),
          durationSeconds: Math.round((input.now - startTime) / 1000),
          ...topProcessRam(input.hardware),
        },
        minSamples: 1,
        actionable: false,
      });
    }
  }

  const cpuStreakHigh = trailingStreak(samples, (s) => s.cpu, config.cpuAttentionPercent);
  if (cpuStreakHigh >= config.sustainedSamples) {
    const startTime = samples[samples.length - cpuStreakHigh].timestamp;
    out.push({
      key: "perf:cpu-high",
      category: "performance",
      severity: "attention",
      title: "CPU muito utilizado",
      summary: `Utilização de CPU sustentada acima de ${config.cpuAttentionPercent}% durante várias amostras.`,
      source: "hardware-monitor",
      evidence: {
        cpuPercent: Math.round(last.cpu),
        durationSeconds: Math.round((input.now - startTime) / 1000),
        ...topProcessCpu(input.hardware),
      },
      minSamples: 1,
      actionable: false,
    });
  } else {
    const cpuStreakRec = trailingStreak(samples, (s) => s.cpu, config.cpuRecommendedPercent);
    if (cpuStreakRec >= config.sustainedSamples) {
      const startTime = samples[samples.length - cpuStreakRec].timestamp;
      out.push({
        key: "perf:cpu-recommended",
        category: "performance",
        severity: "recommended",
        title: "Utilização de CPU elevada",
        summary: `Utilização de CPU sustentada acima de ${config.cpuRecommendedPercent}% durante várias amostras.`,
        source: "hardware-monitor",
        evidence: {
          cpuPercent: Math.round(last.cpu),
          durationSeconds: Math.round((input.now - startTime) / 1000),
          ...topProcessCpu(input.hardware),
        },
        minSamples: 1,
        actionable: false,
      });
    }
  }

  return out;
}

function diskCandidates(samples: MetricSample[], config: PcStateConfig): Candidate[] {
  const out: Candidate[] = [];
  if (samples.length === 0) return out;

  const last = samples[samples.length - 1];
  const freePercent = 100 - last.disk;

  if (freePercent < config.diskAttentionFreePercent) {
    out.push({
      key: "system:disk-low",
      category: "system",
      severity: "attention",
      title: "Espaço em disco muito baixo",
      summary: `Menos de ${config.diskAttentionFreePercent}% de espaço livre em disco.`,
      source: "hardware-monitor",
      evidence: { diskFreePercent: Math.round(freePercent), diskUsagePercent: Math.round(last.disk) },
      minSamples: 1,
      actionable: false,
    });
  } else if (freePercent < config.diskRecommendedFreePercent) {
    out.push({
      key: "system:disk-recommended",
      category: "system",
      severity: "recommended",
      title: "Espaço em disco reduzido",
      summary: `Menos de ${config.diskRecommendedFreePercent}% de espaço livre em disco.`,
      source: "hardware-monitor",
      evidence: { diskFreePercent: Math.round(freePercent), diskUsagePercent: Math.round(last.disk) },
      minSamples: 1,
      actionable: false,
    });
  }

  return out;
}

/**
 * Recomendações de Windows Health que duplicam condições já cobertas
 * pelo hardware-monitor (disco) com regras mutuamente exclusivas e
 * anti-flapping. Não gerar dois findings para a mesma causa.
 */
const WINDOWS_RECS_COVERED_BY_HARDWARE: Record<string, true> = {
  "disk-critical": true,
  "disk-attention": true,
  "ram-high": true,
  "ram-attention": true,
};

/** Serviço do Windows que o estado do firewall da proteção já representa. */
const FIREWALL_SERVICE = "mpssvc";

function downImportantServices(health: WindowsHealthSnapshot): WindowsHealthSnapshot["services"] {
  return health.services.filter((s) => IMPORTANT_WINDOWS_SERVICES.includes(s.name) && !s.running);
}

function firewallCoveredByProtection(input: PcStateEngineInput): boolean {
  const firewall = input.protection?.engine?.firewall;
  return firewall !== undefined && firewall.status !== "active";
}

function windowsRecommendationsCandidates(input: PcStateEngineInput, config: PcStateConfig): Candidate[] {
  const health = input.windowsHealth;
  if (!health) return [];

  const firewallCovered = firewallCoveredByProtection(input);
  const downServices = downImportantServices(health);

  const out: Candidate[] = [];

  for (const rec of health.recommendations) {
    if (rec.status === "good") continue;
    if (WINDOWS_RECS_COVERED_BY_HARDWARE[rec.id]) continue;

    const severity: FindingSeverity =
      rec.severity === "high" ? "attention" : rec.severity === "medium" ? "recommended" : "informative";

    let summary = rec.description;

    if (rec.id === "service-down") {
      const remaining = firewallCovered
        ? downServices.filter((s) => s.name !== FIREWALL_SERVICE)
        : downServices;
      if (remaining.length === 0) continue;
      summary = remaining.map((s) => s.displayName || s.name).join(", ");
    }

    out.push({
      key: `system:win:${rec.id}`,
      category: windowsCategoryForId(rec.id),
      severity,
      title: rec.title,
      summary,
      source: "windows-health",
      evidence: { status: rec.status, evidenceLines: rec.suggestion ? [rec.suggestion] : undefined },
      minSamples: 1,
      actionable: false,
    });

    if (out.length >= config.maxWindowsRecommendations) break;
  }

  return out;
}

function detectCandidates(input: PcStateEngineInput, samples: MetricSample[], config: PcStateConfig): Candidate[] {
  return [
    ...securityCandidates(input),
    ...performanceCandidates(samples, input, config),
    ...diskCandidates(samples, config),
    ...windowsRecommendationsCandidates(input, config),
  ];
}

function toFinding(cand: Candidate, now: number, previous: Finding | null): Finding {
  const firstSeen = previous?.firstSeen ?? new Date(now).toISOString();
  return {
    id: cand.key,
    category: cand.category,
    severity: cand.severity,
    title: cand.title,
    summary: cand.summary,
    source: cand.source,
    evidence: cand.evidence,
    firstSeen,
    lastSeen: new Date(now).toISOString(),
    actionable: cand.actionable,
    actionId: cand.actionId,
  };
}

function sortFindings(a: Finding, b: Finding): number {
  const sw = SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity];
  if (sw !== 0) return sw;
  const co = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
  if (co !== 0) return co;
  return Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
}

function levelForCategory(category: FindingCategory, findings: Finding[]): PcStateLevel | null {
  const inCategory = findings.filter((f) => f.category === category);
  if (inCategory.some((f) => f.severity === "urgent")) return "critical";
  if (inCategory.some((f) => f.severity === "attention")) return "attention";
  return null;
}

function protectionLevel(p: ProtectionState | null): PcStateLevel {
  if (!p) return "unknown";
  switch (p.status) {
    case "critical":
      return "critical";
    case "attention":
    case "degraded":
      return "attention";
    case "safe":
      return "good";
    default:
      return "unknown";
  }
}

function toCounts(findings: Finding[]): PcStateCounts {
  const counts: PcStateCounts = { urgent: 0, attention: 0, recommended: 0, informative: 0 };
  for (const f of findings) {
    counts[f.severity] += 1;
  }
  return counts;
}

const RANK: Record<PcStateLevel, number> = { critical: 3, attention: 2, good: 1, unknown: 0 };

function overallLevel(security: PcStateLevel, performance: PcStateLevel, privacy: PcStateLevel, system: PcStateLevel): PcStateLevel {
  const max = Math.max(RANK[security], RANK[performance], RANK[privacy], RANK[system]);
  if (max === 0) return "unknown";
  return max === 3 ? "critical" : max === 2 ? "attention" : "good";
}

export class PcStateEngine {
  private readonly samples: MetricSample[] = [];
  private readonly active = new Map<string, ActiveEntry>();
  private last: PcState | null = null;

  constructor(private readonly config: PcStateConfig = DEFAULT_PC_STATE_CONFIG) {}

  update(input: PcStateEngineInput): PcState {
    if (input.hardware) {
      this.samples.push(normalizeSample(input.hardware));
      if (this.samples.length > this.config.maxSamples) {
        this.samples.splice(0, this.samples.length - this.config.maxSamples);
      }
    }

    const candidates = detectCandidates(input, this.samples, this.config);
    this.merge(candidates, input.now);

    const findings = this.currentFindings().sort(sortFindings);
    const counts = toCounts(findings);

    const security = levelForCategory("security", findings) ?? protectionLevel(input.protection);
    const performance = levelForCategory("performance", findings) ?? "good";
    const privacy: PcStateLevel = "unknown";
    const system =
      levelForCategory("system", findings) ?? (input.windowsHealth?.overallStatus ?? "unknown");

    const state: PcState = {
      overall: overallLevel(security, performance, privacy, system),
      security,
      performance,
      privacy,
      system,
      findings,
      counts,
      principalFinding: findings[0] ?? null,
      generatedAt: new Date(input.now).toISOString(),
    };

    this.last = state;
    return state;
  }

  getLast(): PcState | null {
    return this.last;
  }

  reset(): void {
    this.samples.length = 0;
    this.active.clear();
    this.last = null;
  }

  private merge(candidates: Candidate[], now: number): void {
    const fresh = new Set<string>();

    for (const cand of candidates) {
      fresh.add(cand.key);
    }

    // First pass: update/add entries for detected candidates
    for (const cand of candidates) {
      const entry: ActiveEntry = this.active.get(cand.key) ?? {
        finding: null as unknown as Finding,
        streak: 0,
        missed: 0,
        minSamples: cand.minSamples,
      };
      entry.streak += 1;
      entry.missed = 0;
      entry.finding = toFinding(cand, now, entry.finding);
      this.active.set(cand.key, entry);
    }

    // Second pass: collect entries to remove (not detected this cycle)
    // We collect keys first to avoid modifying Map during iteration
    const entriesToRemove: string[] = [];
    for (const [key, entry] of this.active) {
      if (!fresh.has(key)) {
        entry.missed += 1;
        if (entry.missed > this.config.graceSamples) {
          entriesToRemove.push(key);
        }
      }
    }
    for (const key of entriesToRemove) {
      this.active.delete(key);
    }
  }

  private currentFindings(): Finding[] {
    const out: Finding[] = [];
    for (const entry of this.active.values()) {
      if (entry.streak >= entry.minSamples) {
        out.push(entry.finding);
      }
    }
    return out;
  }
}