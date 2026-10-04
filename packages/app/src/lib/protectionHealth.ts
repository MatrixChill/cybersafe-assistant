import type {
  EngineHealth,
  EngineSubsystemHealth,
  EngineSubsystemStatus,
  ProtectionStatus,
  WindowsFirewallState,
} from "@cybersafe/shared-types";
import { wfpHealth } from "@cybersafe/shared-types";

/**
 * Níveis apresentados no Dashboard.
 * O backend continua a ser a única fonte de verdade: o status (ProtectionStatus)
 * já é calculado com scoreToStatus(riskScore, degraded) + effectiveRiskScore().
 * Aqui apenas mapeamos para o nome visual e defendemos contra estados
 * contraditórios (ex.: "safe" com motores degradados).
 */
export type ProtectionLevel = "protected" | "attention" | "degraded" | "critical";

export function deriveProtectionLevel(
  status: ProtectionStatus,
  engine?: EngineHealth,
): ProtectionLevel {
  if (engine && !engine.serviceRunning) return "critical";
  const hasEngineError = engine
    && [engine.yara, engine.hashDb, engine.clamav, engine.nativeEngine, wfpHealth(engine)]
      .some((e) => e && e.status === "error");
  if (hasEngineError) return "critical";
  const unhealthy = engine?.anyEngineDegraded === true;

  if (status === "safe") return unhealthy ? "degraded" : "protected";
  if (status === "attention") return unhealthy ? "degraded" : "attention";
  if (status === "critical") return "critical";
  return "degraded";
}

/**
 * Texto e cor de cada estado de motor, tal como aparece ao utilizador.
 *
 * REGRA DE HONESTIDADE (medida no runtime, 2.º probe contra o serviço vivo):
 * o ClamAV chega aqui com `status: "degraded"` e o detalhe "ClamAV instalado mas
 * sem base de assinaturas ... corre freshclam". Este mapeamento tem de mostrar
 * EXATAMENTE o estado que o serviço reportou. Um motor instalado mas inerte
 * NUNCA pode aparecer como ACTIVE: instalado nao e operacional, e presentation-lo
 * como operacional seria a mesma mentira de dizer que o ClamAV analisar.
 * Um `degraded` que aparecesse como ACTIVE seria a UI a mentir sobre protecao.
 */
export function engineStatusText(status: EngineSubsystemStatus): string {
  // PT-PT curto. Antes devolvia os tokens tecnicos crus em maiusculas
  // ("ACTIVE", "DEGRADED", "ERROR", "UNAVAILABLE"): o nome da funcao prometia
  // texto humano e nao cumpria, e o utilizador lia DEGRADED no ecra.
  //
  // A cor continua a ser a que a tabela de badges ja usava, portanto nao ha
  // colisao visual: a distincao passou a estar na PALAVRA, nao so na cor.
  if (status === "active") return "Ativo";
  if (status === "degraded") return "Degradado";
  if (status === "error") return "Erro";
  // Estado desconhecido (nao e um dos quatro): "Indisponivel" seria uma
  // AFIRMACAO sobre o motor, e nao se sabe. Diz-se que nao se sabe.
  if (status === "unavailable") return "Indisponível";
  return "Estado desconhecido";
}

/**
 * O Windows Firewall e o modulo WFP do CyberSafe sao DUAS COISAS DIFERENTES, e
 * a interface estava a tratar um como se fosse o outro.
 *
 * O QUE O PRODUTO SABE DE FACTO (evidence de runtime, `protection.getState` ao
 * servico vivo): o campo `engine.firewall` vem de `this.wfpFilter.isActive()`
 * (engine.ts:762-765) e so fala do MODULO WFP do CyberSafe:
 *     firewall: { status: "unavailable", detail: "WFP filter not started" }
 *
 * O que diz sobre o Windows Firewall: NADA. Existe uma consulta real a ele
 * (packages\native-windows\src\powershell.ts:149-155,
 * Get-NetFirewallProfile, implementada em runFirewall() e devolvendo
 * `WindowsFirewallState`), mas so e usada dentro do proprio pacote
 * native-windows: o servico nunca a consulta, e a app nunca pede o
 * windows.healthSnapshot. Nao ha, portanto, evidencia sobre o Windows Firewall.
 *
 * REGRA: sem evidencia, o honesto e NAO VERIFICADO. Dizer "protecao desligada"
 * affirmaria que o Windows esta desprotegido — e o modulo do CyberSafe estar
 * inativo nao diz nada disso. E a mesma mentira do ClamAV instalado mas inerte.
 */
export const WFP_MODULE_NOT_STARTED_DETAIL =
  "O filtro de rede próprio do CyberSafe não está ativo. Isto não significa que o Firewall do Windows esteja desligado.";
export const WINDOWS_FIREWALL_UNKNOWN_DETAIL =
  "O CyberSafe ainda não consultou o estado do Firewall do Windows nesta vista.";

export interface WindowsFirewallDisplay {
  status: "unknown" | "active" | "inactive";
  text: string;
  detail: string;
}

/**
 * Estado do Windows Firewall para mostrar. So afirma alguma coisa quando existe
 * uma leitura real (o `WindowsFirewallState` que o native-windows ja produz).
 * Sem essa leitura: desconhecido — nunca "desligado".
 */
export function windowsFirewallDisplay(state?: WindowsFirewallState | null): WindowsFirewallDisplay {
  if (!state || !state.available) {
    return { status: "unknown", text: "Não verificado", detail: WINDOWS_FIREWALL_UNKNOWN_DETAIL };
  }
  if (state.enabled) {
    return {
      status: "active",
      text: "ATIVO",
      detail: `Todos os perfis ativos (${state.profiles.map((p) => p.name).join(", ")})`,
    };
  }
  const off = state.profiles.filter((p) => !p.enabled).map((p) => p.name);
  return {
    status: "inactive",
    text: "DESATIVADO",
    detail: `Perfis desligados: ${off.join(", ") || "desconhecido"}`,
  };
}

/**
 * Estado do modulo WFP do CyberSafe — este sim vem do servico. Mantem o motivo
 * tecnico acionavel e NAO o transforma numa afirmacao sobre o Windows.
 */
export function wfpModuleDisplay(sub?: EngineSubsystemHealth): { text: string; detail: string } {
  if (!sub) return { text: engineStatusText("unavailable"), detail: "Sem telemetria do módulo WFP." };
  const notStarted = /not started|not active/i.test(sub.detail ?? "");
  return {
    text: engineStatusText(sub.status),
    detail: notStarted ? WFP_MODULE_NOT_STARTED_DETAIL : (sub.detail ?? ""),
  };
}

export interface ProtectionLevelMeta {
  /** Texto longo no chip do Dashboard. */
  label: string;
  /** Texto curto junto ao gauge. */
  shortLabel: string;
  /**
   * Resposta DIRETA à pergunta do Painel ("O meu computador está bem?").
   * Uma palavra ou quase; é o que o olhar procura primeiro. Nunca repete o
   * `summary` nem o título da lista de prioridades — cada mensagem aparece
   * uma única vez no ecrã.
   */
  answer: string;
  /** Uma frase que diz o que está por trás da resposta, sem tecnicismos. */
  answerDetail: string;
  /** Texto simples para o banner / utilizador comum. */
  summary: string;
  /** Mensagem técnica curta para o modo técnico. */
  techSummary: string;
  /** Classes dos tokens semânticos reais do projeto (cyber-green/yellow/red). */
  dotClass: string;
  chipClass: string;
  textClass: string;
  bannerBadgeClass: string;
}

export const PROTECTION_LEVEL_META: Record<ProtectionLevel, ProtectionLevelMeta> = {
  protected: {
    label: "Sistema Protegido",
    shortLabel: "Protegido",
    answer: "Sim.",
    answerDetail: "Tudo a funcionar e sob vigilância.",
    summary: "Todos os componentes de proteção estão ativos e o teu sistema está bem.",
    techSummary: "Todos os motores reportam ACTIVE.",
    dotClass: "bg-cyber-green",
    chipClass: "border bg-cyber-green/10 border-cyber-green/30",
    textClass: "text-cyber-green",
    bannerBadgeClass: "bg-cyber-green/10 border-cyber-green/30 text-cyber-green",
  },
  attention: {
    label: "Atenção Necessária",
    shortLabel: "Atenção",
    answer: "Sim, com um aviso.",
    answerDetail: "Está protegido, mas há coisas que devias ver.",
    summary: "Proteção parcialmente disponível. Alguns componentes estão limitados, mas o sistema continua monitorizado.",
    techSummary: "Pelo menos um motor não está totalmente ativo.",
    dotClass: "bg-cyber-yellow",
    chipClass: "border bg-cyber-yellow/10 border-cyber-yellow/30",
    textClass: "text-cyber-yellow",
    bannerBadgeClass: "bg-cyber-yellow/10 border-cyber-yellow/30 text-cyber-yellow",
  },
  degraded: {
    label: "Proteção precisa de atenção",
    shortLabel: "Atenção",
    answer: "A meio.",
    answerDetail: "Está a vigiar, mas com menos olhos do que devia.",
    summary: "Alguns componentes de proteção não estão disponíveis neste computador. O sistema continua a monitorizar o que puder, mas a confiança nas deteções está reduzida.",
    techSummary: "Motores IMPORTANTES indisponíveis — a confiança nas deteções está reduzida.",
    dotClass: "bg-cyber-red",
    chipClass: "border bg-cyber-red/10 border-cyber-red/30",
    textClass: "text-cyber-red",
    bannerBadgeClass: "bg-cyber-red/10 border-cyber-red/30 text-cyber-red",
  },
  critical: {
    label: "Estado Crítico",
    shortLabel: "Crítico",
    answer: "Não está bem.",
    answerDetail: "Falta proteção essencial. Vê isto já.",
    summary: "Proteção essencial indisponível ou ameaça crítica detetada. Revisão imediata recomendada.",
    techSummary: "Motor essencial em ERROR ou serviço parado.",
    dotClass: "bg-cyber-red",
    chipClass: "border bg-cyber-red/10 border-cyber-red/40",
    textClass: "text-cyber-red",
    bannerBadgeClass: "bg-cyber-red/10 border-cyber-red/30 text-cyber-red",
  },
};

export function levelMeta(level: ProtectionLevel): ProtectionLevelMeta {
  return PROTECTION_LEVEL_META[level];
}

/**
 * Explicação determinística da pontuação com os pesos REAIS do backend.
 * Espelha `effectiveRiskScore()` (@cybersafe/core): o risco efetivo é o máximo
 * entre as ameaças recentes e um piso por motores de análise ativos
 * (0 ativos → 75; 1–2 → 45; 3–4 com algum degradado → 20; senão 0).
 * A pontuação apresentada é 100 − risco efetivo.
 */
export const SCORE_WEIGHTS = {
  floorAllUnavailable: 75,
  floorAtMostTwoActive: 45,
  floorDegraded: 20,
} as const;

export function explainProtectionScore(
  score: number,
  engine?: EngineHealth,
): { activeEngines: number; totalEngines: number; maxPossible: number; threatPenalty: number } {
  const subEngines = [engine?.yara, engine?.hashDb, engine?.clamav, engine?.nativeEngine]
    .filter((e): e is NonNullable<typeof e> => !!e);
  const active = subEngines.filter((e) => e.status === "active").length;
  const total = subEngines.length > 0 ? subEngines.length : 4;
  const hasDegraded = subEngines.some((e) => e.status === "degraded");
  const floor = active === 0
    ? SCORE_WEIGHTS.floorAllUnavailable
    : active <= 2
      ? SCORE_WEIGHTS.floorAtMostTwoActive
      : hasDegraded
        ? SCORE_WEIGHTS.floorDegraded
        : 0;
  const maxPossible = Math.max(0, 100 - floor);
  const threatPenalty = Math.max(0, maxPossible - Math.max(0, Math.min(100, score)));
  return { activeEngines: active, totalEngines: total, maxPossible, threatPenalty };
}

/** Garante que nunca degradamos para texto de "proteção absoluta". */
export const PROTECTED_ONLY_CLAIMS = new Set(["Sistema Protegido", "Protegido"]);

/**
 * ── DISCO: dado → significado → orientação ────────────────────────────────
 * O número cru (usado/total) não diz nada a ninguém, e "80% cheio" assusta sem
 * explicar. O que interessa é o ESPAÇO LIVRE e o que ele deixa de permitir.
 * Puro e determinístico para ser testável sem renderer.
 */
export type DiskUrgency = "ok" | "tight" | "critical" | "unknown";

export interface DiskSpaceGuidance {
  /** "412 GB livres" — o dado. `—` quando não há total válido. */
  freeText: string;
  freeGb: number | null;
  totalGb: number | null;
  /** O que significa ter este espaço livre. */
  meaning: string;
  /** O que fazer a seguir. Vazio quando não há nada a fazer. */
  action: string;
  urgency: DiskUrgency;
}

const CRITICAL_FREE_GB = 10;
const TIGHT_FREE_GB = 25;
/**
 * Duas réguas de propósito: os gigabytes absolutos mandam em volumes grandes
 * (10 GB livres num SSD de 2 TB não é "qualquer coisa"), e a percentagem manda
 * em volumes pequenos. O limiar de percentagem do estado crítico é apertado
 * (3%) para não converter um "20 GB livres" razoável em alarme.
 */
const CRITICAL_FREE_SHARE = 0.03;
const TIGHT_FREE_SHARE = 0.15;

const gb = (value: number) => `${Math.round(value).toLocaleString("pt-PT")} GB`;

export function describeDiskSpace(usedGb: number, totalGb: number): DiskSpaceGuidance {
  const total = Number(totalGb);
  const used = Number(usedGb);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used) || used < 0) {
    return {
      freeText: "—",
      freeGb: null,
      totalGb: null,
      meaning: "Sem leitura fiável do disco.",
      action: "",
      urgency: "unknown",
    };
  }
  const free = Math.max(0, total - used);
  const share = free / total;
  const base = { freeText: `${gb(free)} livres`, freeGb: free, totalGb: total };

  if (free < CRITICAL_FREE_GB || share < CRITICAL_FREE_SHARE) {
    return {
      ...base,
      urgency: "critical",
      meaning: "Sem espaço, o Windows falha, não instala atualizações e os programas deixam de abrir.",
      action: "Liberta espaço já: esvazia a Reciclagem e a pasta Transferências.",
    };
  }
  if (free < TIGHT_FREE_GB || share < TIGHT_FREE_SHARE) {
    return {
      ...base,
      urgency: "tight",
      meaning: "Folga curta para atualizações, ficheiros temporários e downloads grandes.",
      action: "Convém libertar uns gigabytes esta semana.",
    };
  }
  return {
    ...base,
    urgency: "ok",
    meaning: "Espaço a mais do que suficiente para trabalhar e atualizar.",
    action: "",
  };
}