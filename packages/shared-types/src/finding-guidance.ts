/**
 * WS-5 - DADO, SIGNIFICADO, PRIORIDADE e ORIENTACAO para um achado de estado.
 *
 * Um `Finding` do motor chega ao painel com o dado ja medido (`evidence`) e o
 * significado ja escrito (`summary`). A UI mostrava o rotulo e o summary, e
 * nunca o numero que justifica o summary. Numa app que promete honestidade,
 * "o computador precisa de atencao" sem o 87% que o diz e exatamente o tipo de
 * afirmacao que nao se pode provar.
 *
 * Funcao PURA e deterministica: sem fetch, sem IPC, sem estado, sem data de
 * hoje, sem Math.random. A mesma entrada da sempre a mesma saida. A UI
 * formata; nunca recalcula diagnosticos (o motor deriva, a UI mostra).
 *
 * R6 (o contrato de honestidade, nao uma sugestao): nao inventar orientacao.
 * De ~21 achados do motor, SO UM tem `actionable: true` (`monitor.start`,
 * pcstate.ts:175-176). Os outros ~20 sao `actionable: false`, e nao ha executor
 * de accao no produto. Escrever "o que fazer" para um achado que o proprio motor
 * diz que nao tem accao automatica seria escrever guidance que o produto nao
 * cumpre. Por isso:
 *   - `actionable: false` -> orientacao honesta: nao ha accao automatica aqui.
 *     E melhor do que um botao que parece uma porta e abre um estado geral.
 *   - `actionable: true` mas `actionId` desconhecido -> `orientacao: null`.
 *     NAO se inventa, e o `actionId` cru nunca vaza para o texto.
 *
 * Fica em shared-types porque @cybersafe/app so pode importar de la.
 */
import type { Finding, FindingEvidence, FindingSeverity } from "./index.js";
import { engineStatusPt } from "./engine-context.js";

/**
 * Rotulos de prioridade — a MESMA escala que o painel ja usava, movida para
 * ca para nao haver duas escalas (nem um quarto nivel inventado).
 */
export const FINDING_SEVERITY_LABEL: Record<FindingSeverity, string> = {
  urgent: "AGORA",
  attention: "PROBLEMA",
  recommended: "MELHORIA",
  informative: "NOTA",
};

export interface FindingGuidance {
  /** O DADO: so o que existe no `evidence`. Vazio quando nao ha evidence. */
  dado: string[];
  /** O SIGNIFICADO: `finding.summary`, verbatim. */
  significado: string;
  /** A PRIORIDADE: rotulo do `severity`, na escala do produto. */
  prioridade: string;
  /** A ORIENTACAO, ou `null` quando nao ha nada verdadeiro a dizer. */
  orientacao: string | null;
  /** Verdadeiro SO quando a orientacao e uma accao que o produto executa. */
  accionavel: boolean;
}

/**
 * Accoes que o produto sabe mesmo fazer. Chaveado por `actionId`.
 * Um `actionId` que nao esteja aqui NAO recebe orientacao: e o travão contra
 * a invenção. O `actionId` e um identificador interno e nunca sai daqui.
 */
const FINDING_ACTION_ORIENTATION: Record<string, string> = {
  // pcstate.ts:175-176 — "Serviço de proteção está parado".
  "monitor.start": "Para resolver, o serviço de proteção tem de voltar a arrancar.",
};

/** Numero em PT-PT, independente do ICU instalado: a coma e sempre vírgula. */
function numero(value: number, casas = 0): string {
  return value.toFixed(casas).replace(".", ",");
}

function numeroMilhar(value: number): string {
  return Math.round(value).toLocaleString("pt-PT");
}

/**
 * Bytes legiveis com a matematica certa: 1024^3 por GB, divisores decimais.
 * Uma casa a mais em GB para nao mentir: 12,35 GB nao e 12 GB.
 */
function bytesLegiveis(value: number): string {
  if (value >= 1024 ** 3) {
    return `${numero(value / 1024 ** 3, 2)} GB`;
  }
  if (value >= 1024 ** 2) {
    return `${numero(value / 1024 ** 2, 2)} MB`;
  }
  return `${numero(value / 1024, 2)} KB`;
}

/** Um campo so entra se for um numero finito. Campo ausente nao e inventado. */
function numeroValido(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * O DADO. Um campo por linha, so o que o motor mediu.
 * O nome tecnico do componente (`engine`) e o seu estado (`engineStatus`) sao
 * linhas SEPARADAS: sao dados diferentes, e colados parece unprofessional.
 */
export function buildFindingDado(evidence: FindingEvidence | undefined): string[] {
  if (!evidence) return [];
  const linhas: string[] = [];

  if (evidence.processName || evidence.pid !== undefined) {
    const nome = evidence.processName ?? "(sem nome)";
    linhas.push(evidence.pid !== undefined
      ? `Processo: ${nome} (PID ${numeroMilhar(evidence.pid)}).`
      : `Processo: ${nome}.`);
  }
  if (numeroValido(evidence.cpuPercent)) {
    linhas.push(`Processador: ${numero(evidence.cpuPercent)}%.`);
  }
  if (numeroValido(evidence.memoryPercent)) {
    linhas.push(`Memória: ${numero(evidence.memoryPercent)}%.`);
  }
  if (numeroValido(evidence.memoryBytes)) {
    linhas.push(`Memória: ${bytesLegiveis(evidence.memoryBytes)}.`);
  }
  if (numeroValido(evidence.durationSeconds)) {
    linhas.push(`Duração: ${numeroMilhar(evidence.durationSeconds)} s.`);
  }
  if (numeroValido(evidence.diskFreePercent)) {
    linhas.push(`Espaço livre: ${numero(evidence.diskFreePercent)}%.`);
  }
  if (numeroValido(evidence.diskUsagePercent)) {
    linhas.push(`Disco em uso: ${numero(evidence.diskUsagePercent)}%.`);
  }
  if (evidence.endpoint) {
    linhas.push(`Endereço: ${evidence.endpoint}.`);
  }
  // Componente e estado, em separado e por esta ordem: primeiro DE QUE, depois
  // EM QUE ESTADO.
  if (evidence.engine) {
    linhas.push(`Componente: ${evidence.engine}.`);
  }
  if (evidence.engineStatus !== undefined && evidence.engineStatus !== "") {
    // Tokens crus ("degraded", "unavailable") nao sao copy de ecra — a UI le
    // PT-PT. Uma linha por motor quando ha varios; o token interno nao vaza.
    const estados = String(evidence.engineStatus)
      .split(",")
      .map((s) => engineStatusPt(s.trim()))
      .join(", ");
    linhas.push(`Estado do componente: ${estados}.`);
  }
  if (evidence.status) {
    linhas.push(`Estado: ${evidence.status}.`);
  }
  // evidenceLines entra tal e qual. O motor ja decidiu o que e contexto tecnico.
  for (const linha of evidence.evidenceLines ?? []) {
    linhas.push(linha);
  }

  return linhas;
}

export function buildFindingGuidance(finding: Finding): FindingGuidance {
  const acaoConhecida = finding.actionable
    && typeof finding.actionId === "string"
    ? FINDING_ACTION_ORIENTATION[finding.actionId]
    : undefined;

  // Um `actionId` desconhecido NAO pode herdar a orientacao de "nao ha accao
  // automatica": o motor disse que este achado TEM accao, e nao a que. Dizer
  // "nao ha accao aqui" seria discordar do motor sem saber. Fica `null`, e a UI
  // nao renderiza orientacao nenhuma. Inventar seria o que este modulo proibe.
  if (finding.actionable) {
    return {
      dado: buildFindingDado(finding.evidence),
      significado: finding.summary,
      prioridade: FINDING_SEVERITY_LABEL[finding.severity],
      orientacao: acaoConhecida ?? null,
      accionavel: acaoConhecida !== undefined,
    };
  }

  return {
    dado: buildFindingDado(finding.evidence),
    significado: finding.summary,
    prioridade: FINDING_SEVERITY_LABEL[finding.severity],
    orientacao: "O CyberSafe não tem aqui uma ação automática: mediu e registou, mas não aplica nenhuma correção por si só.",
    accionavel: false,
  };
}
