import type { DashboardSummary, EngineHealth } from "@cybersafe/shared-types";
import { realtimeCoverage, realtimeCoverageFacts } from "@cybersafe/shared-types";
import { deriveProtectionLevel, type ProtectionLevel, type RealtimeProtectionInfo } from "./protectionHealth";

/**
 * ── UMA decisão semântica para o estado da proteção ────────────────────────
 *
 * O Dashboard, a barra lateral, a faixa de sessão e a janela de detalhes
 * descrevem o MESMO estado medido. Antes, cada um voltava a decidir por si —
 * e a barra lateral e o modal chegavam a inferir "motores operacionais" por
 * comparação do TEXTO do título do Dashboard. Uma frase é apresentação, não
 * contrato: mudar a cópia mudava o estado, e o resultado foi o ecrã a dizer
 * "4 de 4 motores ativos" ao lado de "Proteção precisa de atenção".
 *
 * Esta função é a única autoridade. Os consumidores leem `kind`, `tone` e a
 * contagem de motores; nenhum compara títulos.
 *
 * Regras, por ordem:
 *  1. Sem ligação confirmada → `unconfirmed`.
 *  2. Erro de motor ou serviço parado → `critical`.
 *  3. Monitorização indisponível/pausada/desligada/não confirmada → o estado
 *     próprio, porque é a análise contínua que está em causa.
 *  4. Quatro motores ativos, sem ameaças críticas, sem perdas, e o ÚNICO
 *     limite é o filtro WFP opcional não iniciado neste perfil →
 *     `operational-network-off`: os motores estão operacionais e o filtro de
 *     rede é dito na sua própria linha, sem alarme geral.
 *  5. Quatro motores ativos e o único limite é a cobertura do tempo real
 *     ainda não confirmada (caminhos em espera ou não recuperados, watcher
 *     indeterminado) → `coverage-unconfirmed`: eixo próprio, com os números,
 *     em vez de "Proteção com limitações" ao lado de "4 de 4 motores".
 *     Histórico TODO recuperado não é limite atual e não bloqueia o passo 4.
 *  6. Qualquer outro limite real → `limited`.
 *  7. Caso contrário → `operational`.
 *
 * O WFP não desaparece em nenhum ramo: `networkFilter` continua a ser
 * publicado e a linha própria do modal continua a mostrá-lo. O que muda é não
 * se transformar um filtro opcional ausente num alerta grave sobre os motores.
 */
export type ProtectionTone = "ok" | "warn" | "crit" | "na";

export type ProtectionOverviewKind =
  | "unconfirmed"
  | "critical"
  | "monitoring-paused"
  | "monitoring-off"
  | "monitoring-unverified"
  | "operational-network-off"
  | "coverage-unconfirmed"
  | "limited"
  | "operational";

export type NetworkFilterState = "active" | "optional-off" | "inactive" | "error" | "unknown";

export interface ProtectionOverview {
  kind: ProtectionOverviewKind;
  level: ProtectionLevel;
  title: string;
  description: string;
  tone: ProtectionTone;
  enginesActive: number;
  enginesTotal: number;
  allEnginesActive: boolean;
  networkFilter: NetworkFilterState;
  /** Limitações reportadas pelo serviço, sem duplicados vazios. */
  reasons: string[];
}

const CORE_ENGINES = ["yara", "hashDb", "clamav", "nativeEngine"] as const;

const OPTIONAL_NETWORK_DETAIL = /sem tentativa de ativação neste perfil/i;

function networkFilterState(engine?: EngineHealth): NetworkFilterState {
  const wfp = engine?.wfp;
  if (!wfp) return "unknown";
  if (wfp.status === "active") return "active";
  if (wfp.status === "error") return "error";
  if (wfp.status === "unavailable" && OPTIONAL_NETWORK_DETAIL.test(wfp.detail ?? "")) return "optional-off";
  if (wfp.status === "unavailable" || wfp.status === "degraded") return "inactive";
  return "unknown";
}

function limitationText(reasons: string[]): string {
  return reasons.length ? ` Limitações reportadas: ${reasons.slice(0, 2).join(" · ")}.` : "";
}

export function protectionOverview(
  d: DashboardSummary,
  realtime: RealtimeProtectionInfo | undefined,
  connected: boolean | null | undefined,
): ProtectionOverview {
  const engine = d.engineHealth;
  const reports = CORE_ENGINES.map((key) => engine?.[key]).filter(
    (sub): sub is NonNullable<typeof sub> => !!sub,
  );
  const enginesTotal = reports.length > 0 ? reports.length : CORE_ENGINES.length;
  const enginesActive = reports.filter((sub) => sub.status === "active").length;
  const allEnginesActive = reports.length === CORE_ENGINES.length && enginesActive === CORE_ENGINES.length;
  const reasons = (engine?.degradedReasons ?? []).map((r) => r.trim()).filter((r) => r !== "");
  const networkFilter = networkFilterState(engine);
  const level = deriveProtectionLevel(d.systemStatus, engine, realtime);
  const base = { level, enginesActive, enginesTotal, allEnginesActive, networkFilter, reasons };

  if (connected !== true) {
    return {
      ...base,
      kind: "unconfirmed",
      title: "Ligação não confirmada",
      description: "Sem leitura atual do serviço. Não é possível confirmar o estado de proteção.",
      tone: "na",
    };
  }

  if (level === "critical") {
    return {
      ...base,
      kind: "critical",
      title: "Proteção com limitações",
      description:
        "O relatório recebido contém erros ou sinais críticos." +
        (reasons.length ? limitationText(reasons) : " Consulta o estado de cada motor."),
      tone: "crit",
    };
  }

  if (realtime?.disponivel === false) {
    return {
      ...base,
      kind: "monitoring-unverified",
      title: "Monitorização indisponível",
      description: "A leitura da monitorização está indisponível; consulta os detalhes da proteção.",
      tone: "warn",
    };
  }
  if (realtime?.pausedUntil) {
    return {
      ...base,
      kind: "monitoring-paused",
      title: "Monitorização em pausa",
      description: "O serviço reportou uma pausa. Os motores mantêm estados independentes.",
      tone: "warn",
    };
  }
  if (realtime?.enabled === false) {
    return {
      ...base,
      kind: "monitoring-off",
      title: "Monitorização desligada",
      description: "A análise contínua está desligada. As análises manuais continuam disponíveis.",
      tone: "warn",
    };
  }
  if (realtime?.enabled !== true) {
    return {
      ...base,
      kind: "monitoring-unverified",
      title: "Monitorização não verificada",
      description: "O serviço ainda não confirmou se a análise contínua está ligada.",
      tone: "warn",
    };
  }

  const coverage = realtimeCoverage(engine);
  const coverageConfirmed = coverage.state === "complete" || coverage.state === "recovered";
  const isCoverageReason = (reason: string) => /^Cobertura do tempo real não confirmada/i.test(reason);
  const isOptionalNetworkReason = (reason: string) => /filtro wfp/i.test(reason) && OPTIONAL_NETWORK_DETAIL.test(reason);
  const enginesHealthy =
    engine?.serviceRunning === true &&
    engine.osLayerHealthy !== false &&
    allEnginesActive &&
    (networkFilter === "optional-off" || networkFilter === "active") &&
    (d.highSeverityEvents ?? 0) === 0;
  const onlyOptionalNetworkLimits =
    enginesHealthy &&
    networkFilter === "optional-off" &&
    (d.riskScore ?? 0) >= 100 &&
    coverageConfirmed &&
    reasons.every(isOptionalNetworkReason);

  if (onlyOptionalNetworkLimits) {
    return {
      ...base,
      kind: "operational-network-off",
      title: "Motores de análise operacionais",
      description:
        "Os quatro motores de análise estão ativos. A proteção de rede adicional do CyberSafe não está ativada neste perfil.",
      tone: "ok",
    };
  }

  if (enginesHealthy && !coverageConfirmed && reasons.every((r) => isCoverageReason(r) || isOptionalNetworkReason(r))) {
    const numbers = realtimeCoverageFacts(coverage);
    return {
      ...base,
      kind: "coverage-unconfirmed",
      title: coverage.state === "recovering" ? "Cobertura do tempo real em recuperação" : "Cobertura do tempo real não confirmada",
      description:
        `Os ${enginesActive} motores de análise estão ativos. ${numbers.join("; ")}.` +
        (coverage.state === "recovering" ? "" : " Faz uma análise manual das pastas afetadas."),
      tone: "warn",
    };
  }

  if (level !== "protected") {
    return {
      ...base,
      kind: "limited",
      title: "Proteção com limitações",
      description:
        "Consulta a cobertura e os limites reportados antes de interpretar os resultados." +
        limitationText(reasons),
      tone: "warn",
    };
  }

  return {
    ...base,
    kind: "operational",
    title: "Monitorização ligada",
    description: "Estado reportado pelo serviço. Não confirma cobertura integral do Windows.",
    tone: "ok",
  };
}

/** Rótulo curto para a barra lateral, derivado do estado real — não do título. */
export function protectionEnginesBadge(overview: ProtectionOverview): string {
  if (overview.kind === "unconfirmed") return "A verificar";
  if (overview.allEnginesActive) return `${overview.enginesActive} de ${overview.enginesTotal} motores ativos`;
  return `${overview.enginesActive} de ${overview.enginesTotal} motores ativos`;
}
