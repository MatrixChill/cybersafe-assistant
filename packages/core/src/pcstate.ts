import { IMPORTANT_WINDOWS_SERVICES, wfpHealth, ENGINE_DISPLAY_NAME, engineContextCopy, PC_USAGE_BANDS } from "@cybersafe/shared-types";
import type {
  Finding,
  FindingCategory,
  FindingEvidence,
  FindingSeverity,
  EngineSubsystemHealth,
  HardwareSnapshot,
  PcState,
  PcStateCounts,
  PcStateLevel,
  ProtectionState,
  ThreatEvent,
  WindowsHealthSnapshot,
} from "@cybersafe/shared-types";

export interface MetricSample {
  /**
   * Utilização total de CPU (%); `null` = não medido. `0` só aparece quando o
   * produtor do snapshot afirma ter medido 0 — a afirmação vem em
   * `cpu.usageStatus`, e era exatamente aí que esta amostra mentia enquanto
   * aceitava `CLAMP(usage)` sem olhar o estado.
   */
  cpu: number | null;
  /** Utilização de RAM (%); `null` = não medido (distinto de 0%). */
  ram: number | null;
  /** Ocupação do volume principal (%); `null` = não medido (distinto de 0%). */
  disk: number | null;
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
  // Os números vivem em `PC_USAGE_BANDS` (shared-types), que é também o que a
  // interface usa para colorir. Definí-los aqui deixaria a cor e o achado do
  // motor a divergir em silêncio; derivá-los torna isso impossível.
  ramAttentionPercent: PC_USAGE_BANDS.ram.alert,
  ramRecommendedPercent: PC_USAGE_BANDS.ram.watch,
  cpuAttentionPercent: PC_USAGE_BANDS.cpu.alert,
  cpuRecommendedPercent: PC_USAGE_BANDS.cpu.watch,
  diskAttentionFreePercent: 100 - PC_USAGE_BANDS.disk.alert,
  diskRecommendedFreePercent: 100 - PC_USAGE_BANDS.disk.watch,
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
  /**
   * Saida imediata para findings que sao FACTOS de estado confirmados pelo
   * servico (nao metricas amostradas): numero de updates ausentes antes de
   * remover. Ausente = `config.graceSamples` (o comportamento das metricas).
   */
  exitGrace?: number;
  actionable: boolean;
  actionId?: string;
}

interface ActiveEntry {
  finding: Finding;
  streak: number;
  missed: number;
  minSamples: number;
  /** Quantos updates ausentes antes de remover (ver Candidate.exitGrace). */
  exitGrace: number;
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

type EngineStatusName = "yara" | "hashDb" | "clamav" | "nativeEngine" | "wfp";

const UNAVAILABLE_ENGINES: EngineStatusName[] = [...IMPERATIVE_ENGINES, "wfp"];

/**
 * Le um motor pelo nome interno, resolvendo o `wfp` pelos DOIS nomes.
 *
 * Sem isto, um servico que so publique o alias antigo `firewall` deixava de ser
 * contado, e o WFP em falta desaparecia das findings em silencio. Indexar
 * `engine["wfp"]` direto e o bug que o helper existe para evitar.
 */
function readEngine(
  name: EngineStatusName,
  engine: ProtectionState["engine"] | undefined,
): EngineSubsystemHealth | undefined {
  return name === "wfp" ? wfpHealth(engine) : engine?.[name];
}

function engineNeedsAttention(name: EngineStatusName, engine: ProtectionState["engine"] | undefined): boolean {
  const status = readEngine(name, engine)?.status;
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

/**
 * O número de CPU só vale o que o produtor dele afirma. `usageStatus` é essa
 * afirmação: `available` = medido agora; `stale`/`unavailable`/`error` = não é
 * a carga deste instante. Ausência do campo = produtor anterior ao contrato,
 * tratado como medido (compatibilidade declarada no próprio contrato).
 */
function cpuLoadMeasured(cpu: HardwareSnapshot["cpu"]): boolean {
  if (typeof cpu.usage !== "number" || !Number.isFinite(cpu.usage)) return false;
  return cpu.usageStatus === undefined || cpu.usageStatus === "available";
}

export function normalizeSample(hardware: HardwareSnapshot): MetricSample {
  return {
    // O número que chega do monitor vale apenas quando o próprio monitor diz de
    // onde ele veio. `stale` / `unavailable` / `error` significam «isto não é a
    // carga deste instante» → `null`, a mesma política de RAM e disco abaixo.
    cpu: cpuLoadMeasured(hardware.cpu) ? CLAMP(hardware.cpu.usage) : null,
    // RAM: `usagePercent` é `null` quando não há leitura ATUAL — nunca se
    // converte em 0. Política explícita DESTE consumidor (core/PcState): o valor
    // observado é transportado tal como veio; a ausência de `usageStatus`
    // (snapshot legado/outro produtor) é "não confirmado" e NÃO é tratada como
    // `available` — afirmar frescura é responsabilidade de quem apresenta (UI),
    // não deste eixo. A última leitura boa (`usageLastGoodPercent`) não entra
    // aqui: não é carga atual.
    ram: hardware.ram.usagePercent === null ? null : CLAMP(hardware.ram.usagePercent),
    // `null` propaga-se (sem leitura) — nunca se converte em 0.
    disk: hardware.disk.usagePercent === null ? null : CLAMP(hardware.disk.usagePercent),
    timestamp: Date.parse(hardware.timestamp) || Date.now(),
  };
}

function trailingStreak(
  samples: MetricSample[],
  getter: (s: MetricSample) => number | null,
  threshold: number,
): number {
  let streak = 0;
  for (let i = samples.length - 1; i >= 0; i--) {
    const value = getter(samples[i]);
    // Uma amostra SEM medição (`null`) não pode sustentar um achado de carga
    // sustentada: interrompe a série em vez de contar como valor baixo.
    if (value !== null && value >= threshold) {
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
  // A comparação «este processo é uma fatia relevante da carga total» precisa de
  // uma carga total medida. Sem medição, `usage` não é zero medido — é ausência,
  // e usá-la silenciaria (ou inventaria) uma atribuição. Sem base, não se
  // atribui: a evidência fica de fora e o achado continua a ser o que as
  // amostras sustentam.
  if (!cpuLoadMeasured(hardware.cpu)) return {};
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

  // CG1: `status` sozinho nao responde "a protecao esta a correr?". Com o
  // tempo real DESLIGADO o estado geral ate pode ser `critical` generico — e
  // "Protecao em estado critico" nao diz ao utilizador o que e que desligou.
  // `undefined` NUNCA conta como desligado (nao inventamos uma leitura que nao
  // houve); so `false` explicito e' um facto.
  const realtimeOff = p.protectionEnabled === false;

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
    const errored = IMPERATIVE_ENGINES.filter((name) => readEngine(name, engine)?.status === "error");
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
          evidenceLines: errored.map((name) => {
            const copy = engineContextCopy(name, readEngine(name, engine));
            return `${ENGINE_DISPLAY_NAME[name] ?? name}: ${copy.estado} — ${copy.texto}`;
          }),
        },
        minSamples: 1,
        actionable: false,
      });
    }

    if (wfpHealth(engine)?.status === "error") {
      out.push({
        key: "security:firewall-error",
        category: "security",
        severity: "attention",
        // "Erro no firewall" e "A proteccao de firewall do SISTEMA" eram as duas
        // metades da mesma mentira: o que reportou erro foi o filtro WFP do
        // CyberSafe, e nada disto diz o que o Windows Firewall esta a fazer.
        title: "Erro no filtro WFP do CyberSafe",
        summary: "O filtro de bloqueio de rede do CyberSafe reporta um erro. Nada disto diz respeito ao Firewall do Windows.",
        source: "protection-engine",
        evidence: { engine: "wfp", engineStatus: "error", status: wfpHealth(engine)?.detail },
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
            // Nomes sem tokens: "(degraded)" no DADO do painel era o estado
            // interno do servico a aparecer como copy de ecra. O estado PT-PT
            // vem por linha, e o detail cru fica so nos detalhes tecnicos.
            engine: attentionEngines.map((name) => ENGINE_DISPLAY_NAME[name] ?? name).join(", "),
            engineStatus: attentionEngines.map((name) => readEngine(name, engine)?.status ?? "unknown").join(", "),
            evidenceLines: attentionEngines.flatMap((name) => {
              const copy = engineContextCopy(name, readEngine(name, engine));
              const linha = `${ENGINE_DISPLAY_NAME[name] ?? name}: ${copy.estado} — ${copy.texto}`;
              return copy.contexto ? [linha, copy.contexto] : [linha];
            }),
          },
        minSamples: 1,
        actionable: false,
      });
    }

    const specificSecurity = realtimeOff || out.some((c) => c.severity === "urgent" || c.severity === "attention");
    if (!specificSecurity && (p.status === "attention" || p.status === "degraded")) {
      // Fallback do estado geral: as `degradedReasons` cruas trazem tokens e
      // paths do provider. Aqui so sai copy humana, linha por motor.
      const unhealthyLines = UNAVAILABLE_ENGINES
        .filter((name) => {
          const status = readEngine(name, engine)?.status;
          return status === "degraded" || status === "unavailable" || status === "error";
        })
        .map((name) => {
          const copy = engineContextCopy(name, readEngine(name, engine));
          return `${ENGINE_DISPLAY_NAME[name] ?? name}: ${copy.estado} — ${copy.texto}`;
        });
      out.push({
        key: "security:protection-attention",
        category: "security",
        severity: "attention",
        title: "Proteção requer atenção",
        summary: "O estado geral de proteção indica degradação ou necessidade de atenção.",
        source: "protection-engine",
        evidence: { status: p.status, evidenceLines: unhealthyLines.length > 0 ? unhealthyLines : (engine.degradedReasons ?? []) },
        minSamples: 1,
        actionable: false,
      });
    }

    const noEngineUrgent = !out.some((c) => c.severity === "urgent");
    if (p.status === "critical" && noEngineUrgent && !realtimeOff) {
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

  // Fora do bloco do motor: o tempo real desligado e' um facto da Protecao
  // que se aplica mesmo quando nao ha dados de sub-motores para ler.
  if (realtimeOff) {
    out.push({
      key: "security:realtime-off",
      category: "security",
      severity: "urgent",
      title: "Proteção em tempo real desativada",
      summary:
        "A proteção em tempo real do CyberSafe está desligada: os ficheiros não são vigiados fora de uma análise, apesar dos motores continuarem disponíveis.",
      source: "protection-engine",
      evidence: { engine: "realtime", engineStatus: "off", status: p.status },
      minSamples: 1,
      // Facto de estado CONFIRMADO pelo servico: quando a protecao volta a
      // estar ativa, o finding sai no update seguinte — sem esperar amostras.
      // O atraso de um ciclo deixava o Painel a contradizer o Controlo
      // ("Protecao em tempo real desativada" com a protecao ativa; GUI-PAP-02).
      exitGrace: 0,
      // Sem acao wired na UI: marcar `actionable` prometia um botao que nao
      // existe. O utilizador reativa pelo Painel/Traia, como ja faz.
      actionable: false,
    });
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
  // Política (igual à do disco): sem medição de RAM (`null`) não se emite achado
  // de memória — um 0 inventado faria nascer "RAM muito utilizada"; um 0 real
  // continua a ser medição e mantém-se elegível.
  if (last.ram !== null && ramStreakHigh >= config.sustainedSamples) {
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
    if (last.ram !== null && ramStreakRec >= config.sustainedSamples) {
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
  // Mesma política da RAM e do disco: sem medição atual não se emite achado de
  // carga. Um `0` por ausência de sensor nunca conta como «série acima do
  // limiar», e a série que quebra no `null` já não sustenta nada.
  if (last.cpu !== null && cpuStreakHigh >= config.sustainedSamples) {
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
    if (last.cpu !== null && cpuStreakRec >= config.sustainedSamples) {
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
  // Sem leitura do volume principal (`null`) não se afirma nada sobre espaço:
  // um 0 faria nascer um achado "disco quase cheio" a partir de uma não-leitura
  // e um achado inventado é pior do que a ausência de achado.
  if (last.disk === null) return out;

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

/**
 * NOTA sobre `mpssvc` (o servico do Firewall do Windows).
 *
 * Este ficheiro chegou a ter `firewallCoveredByProtection()`, que devolvia
 * `true` quando o filtro WFP do CyberSafe estava INACTIVO, e usava esse `true`
 * para REMOVER o `mpssvc` de "servicos importantes em baixo". E o contrario do
 * nome e o contrario da seguranca: quando o CyberSafe estava mais fraco, o
 * achado de rede desprotegida era silenciado. O `mpssvc` parado e um problema do
 * Windows Firewall, exista ou nao exista filtro do CyberSafe.
 *
 * O estado do Windows Firewall tem fonte propria e com dado real:
 * `WindowsHealthSnapshot.firewall` (`Get-NetFirewallProfile`), e e essa que
 * produz a finding `firewall-disabled`.
 */

function downImportantServices(health: WindowsHealthSnapshot): WindowsHealthSnapshot["services"] {
  return health.services.filter((s) => IMPORTANT_WINDOWS_SERVICES.includes(s.name) && !s.running);
}

/**
 * O filtro WFP do CyberSafe e o Firewall do Windows sao coisas diferentes, e por
 * isso esta funcao deixou de existir.
 *
 * A versao anterior devolvia `true` quando o filtro WFP estava INACTIVO, e esse
 * `true` servia para filtrar o servico `mpssvc` (o Firewall do Windows) de
 * "servicos importantes em baixo". E o contrario do nome e o contrario da
 * seguranca: quando o CyberSafe esta mais fraco, o achado de rede desprotegida
 * era silenciado. E o `mpssvc` parado mantem-se um problema do Windows Firewall
 * com ou sem filtro do CyberSafe.
 *
 * O estado do Windows Firewall tem a sua propria fonte, com dado real:
 * `WindowsHealthSnapshot.firewall` (`Get-NetFirewallProfile`), e e essa que
 * produz a finding `firewall-disabled`.
 */

function windowsRecommendationsCandidates(input: PcStateEngineInput, config: PcStateConfig): Candidate[] {
  const health = input.windowsHealth;
  if (!health) return [];

  const downServices = downImportantServices(health);

  const out: Candidate[] = [];

  for (const rec of health.recommendations) {
    if (rec.status === "good") continue;
    if (WINDOWS_RECS_COVERED_BY_HARDWARE[rec.id]) continue;

    const severity: FindingSeverity =
      rec.severity === "high" ? "attention" : rec.severity === "medium" ? "recommended" : "informative";

    let summary = rec.description;

    if (rec.id === "service-down") {
      // Sem filtro do `mpssvc`: o Windows Firewall parado e um problema do
      // Windows Firewall, e nao se esconde por o CyberSafe ter (ou nao ter) o
      // filtro WFP activo.
      if (downServices.length === 0) continue;
      summary = downServices.map((s) => s.displayName || s.name).join(", ");
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
    // Ausência de achados de desempenho NÃO é saúde: é, tantas vezes, ausência de
    // medição. O `?? "good"` anterior dizia «Sistema Saudável» num arranque sem
    // nenhum snapshot, ou com todos os sensores a responder `unavailable` — a
    // máquina pintava-se de verde por não se saber nada. Só há direito a «good»
    // quando existe pelo menos uma amostra efetivamente medida; sem base, o
    // estado é «unknown», que a UI já mostra como «Estado parcialmente
    // desconhecido».
    const baseMedida = this.samples.some((s) => s.cpu !== null || s.ram !== null || s.disk !== null);
    const performance =
      levelForCategory("performance", findings) ?? (baseMedida ? "good" : "unknown");
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
        exitGrace: cand.exitGrace ?? this.config.graceSamples,
      };
      entry.streak += 1;
      // O candidato pode mudar o `exitGrace` entre rondas: a entrada segue a
      // definicao atual, nunca uma copia congelada da primeira aparicao.
      entry.exitGrace = cand.exitGrace ?? this.config.graceSamples;
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
        if (entry.missed > entry.exitGrace) {
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