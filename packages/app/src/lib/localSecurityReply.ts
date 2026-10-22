/**
 * POSTHUMAN13 — resposta local determinista a
 * perguntas de estado do PC ("Meu PC está seguro?"),
 * exclusivamente a partir do snapshot real recente
 * do serviço, lido pela bridge existente
 * (`window.electronAPI`). Sem IA externa, sem APIs
 * novas, sem chamadas diretas ao serviço (4000/pipe).
 *
 * REGRAS DE HONESTIDADE (frescura e desconhecido
 * são a prioridade):
 *  · NUNCA se declara o PC absolutamente seguro — a
 *    resposta é "segundo as leituras do serviço",
 *    com a idade de cada fonte.
 *  · Frescura por FONTE: `PcState.generatedAt` e
 *    `HardwareSnapshot.timestamp` são validados
 *    (data inválida ou FUTURA nunca se finge
 *    fresca). `ProtectionState` NÃO publica
 *    timestamp próprio — a limitação é declarada:
 *    a idade da proteção é medida da receção da
 *    resposta, e a resposta não diz "recente" por
 *    isso. Nenhum prazo de staleness é inventado
 *    (o contrato partilhado não define nenhum).
 *  · Leituras PARCIAIS são honestas: se uma fonte
 *    falhar, essa fonte aparece como "desconhecido
 *    (sem leitura)" — NUNCA se infere "0 eventos"
 *    ou "sem problemas" de uma falha.
 *  · Desconhecido, degradado, desligado e erro são
 *    DISTINTOS; um motor degradado nunca aparece
 *    como "ativo".
 *  · Snapshot indisponível, rejeitado ou chegado
 *    tarde (após abort/unmount) NÃO inventa números.
 *  · A proteção em tempo real segue a regra do tipo:
 *    `undefined` = não foi lido (desconhecido), NUNCA
 *    "desligada".
 *  · Perguntas de estado respondem-se LOCALMENTE,
 *    ANTES do provider — estas perguntas nunca tocam
 *    o fornecedor de IA (zero provider, inclusive
 *    em erro/staleness).
 */

import type {
  HardwareSnapshot,
  PcState,
  ProtectionState,
  ThreatEvent,
} from "@cybersafe/shared-types";
import {
  deriveProtectionLevel,
  engineStatusText,
  protectionStatusText,
  realtimeProtectionCopy,
} from "@/lib/protectionHealth";
import { cpuUsageForNarrative } from "@/lib/cpuUsage";

/**
 * As leituras reais do serviço, via bridge existente
 * (preload). Injetável para testes com fakes
 * controladas — os testes nunca correm Electron nem
 * chamam o serviço.
 */
export interface LocalSecurityBridge {
  getProtectionState: () => Promise<ProtectionState>;
  getHardwareSnapshot: () => Promise<HardwareSnapshot>;
  getPCState: () => Promise<PcState>;
  getThreatEvents: () => Promise<ThreatEvent[]>;
}

/** Assunto de PC (com ou sem artigo/possessivo). */
const PC_SUBJECT =
  /\b(pcs?|computadores?|portáteis?|máquinas?)\b/i;

/** Palavra de estado/segurança — sem ela, "pc" sozinho não é pergunta de estado. */
const SAFETY_WORD =
  /\b(segur|protegid|protec\w*|risco|ameaç|vírus|malware|algo errado|a salvo|problema)/i;

/** Frases de estado diretas, com ou sem assunto de PC explícito. */
const DIRECT_STATUS = [
  /\bestou\s+(segur|protegid)/i,
  /\bprote[cç][cç]?[aã]o\s+em\s+tempo\s+real\b/i,
  /\bmotores?\s+(est[ãa]o|está|ativ|funcion|estado)/i,
  /\balgo\s+errado\b/i,
  /\bestá\s+tudo\s+bem\b/i,
  /\b(tens?|tenho)\s+problemas?\b/i,
  /\bestá\s+segur/i,
  /\bestá\s+protegid/i,
];

/**
 * Deteta perguntas de ESTADO do PC (conservador):
 * assuntos de PC + palavras de estado, ou frases
 * diretas de estado. Perguntas de conselho/educação
 * ("o que é phishing?", "como melhorar segurança?")
 * NÃO são — essas continuam no fluxo normal.
 */
export function isLocalSecurityQuestion(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (!lower) return false;
  for (const pattern of DIRECT_STATUS) {
    if (pattern.test(lower)) return true;
  }
  return PC_SUBJECT.test(lower) && SAFETY_WORD.test(lower);
}

/**
 * Snapshot recente lido pela bridge. `threats` é
 * `ThreatEvent[] | null` — `null` significa "sem
 * leitura" (distinto de `[]`, que são 0 eventos
 * reais). `protectionReceivedAt` é o momento da
 * receção da resposta de proteção (o serviço não
 * publica timestamp próprio para esse estado).
 */
export interface LocalSecuritySnapshotInput {
  protection: ProtectionState | null;
  hardware: HardwareSnapshot | null;
  pcState: PcState | null;
  threats: ThreatEvent[] | null;
  /** Receção da resposta de proteção (relógio do cliente). */
  protectionReceivedAt: number;
  /** Relógio do cliente para medir idades. */
  now: number;
}

/** Resposta pronta para o chat. */
export interface LocalSecurityAnswer {
  reply: string;
}

/**
 * Valida um timestamp ISO do serviço: válido e no
 * passado → idade em segundos; ausente/inválido/
 * FUTURO → falha com a razão (nunca se finge
 * frescura nem se inventa um prazo de staleness).
 */
type TimestampCheck =
  | { ok: true; ageSeconds: number }
  | { ok: false; reason: "missing" | "invalid" | "future" };

function checkTimestamp(
  timestamp: string | undefined,
  now: number,
): TimestampCheck {
  if (typeof timestamp !== "string" || timestamp.trim() === "") {
    return { ok: false, reason: "missing" };
  }
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) {
    return { ok: false, reason: "invalid" };
  }
  const ageMs = now - time;
  if (ageMs < 0) {
    return { ok: false, reason: "future" };
  }
  return { ok: true, ageSeconds: Math.round(ageMs / 1000) };
}

/** Texto PT-PT da idade validada de uma fonte. */
function timestampText(check: TimestampCheck): string {
  if (check.ok) {
    return check.ageSeconds <= 1 ? "agora" : `há ${check.ageSeconds} s`;
  }
  if (check.reason === "future") return "data futura (inválida)";
  if (check.reason === "invalid") return "data inválida";
  return "sem timestamp";
}

/** Número lido, ou `null` quando não há medição utilizável (nunca NaN/0 fingido). */
const readNumber = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Linha de motores: ativos contam-se, e cada motor
 * NÃO ativo aparece com o seu estado real (Erro,
 * Degradado, Indisponível) — um motor degradado
 * nunca aparece como "ativo". Sem leitura de motores
 * (serviço antigo) = desconhecido.
 */
function enginesLine(engine: ProtectionState["engine"]): string {
  const subsystems: ReadonlyArray<
    readonly [string, ProtectionState["engine"]["yara"]]
  > = [
    ["Yara", engine.yara],
    ["Base de assinaturas", engine.hashDb],
    ["ClamAV", engine.clamav],
    ["Motor nativo", engine.nativeEngine],
  ];
  const present = subsystems.filter(([, sub]) => !!sub);
  if (present.length === 0) return "sem leitura de motores";
  const active = present.filter(([, sub]) => sub!.status === "active");
  const others = present.filter(([, sub]) => sub!.status !== "active");
  if (others.length === 0) {
    return `${present.length} ativos`;
  }
  const detail = others.map(([name, sub]) => `${name}: ${engineStatusText(sub!.status)}`);
  return `${active.length} ativos; ${detail.join("; ")}`;
}

/**
 * Frases de nível. REGRA: o nível deriva do status
 * (risco) e da saúde dos motores — NUNCA afirma a
 * proteção em tempo real, que é EIXO SEPARADO e
 * tem a sua própria linha. "Protegido" com RT
 * desligada é "sem alertas reportados na leitura",
 * nunca "proteção ativa" — a frase contradiria a
 * linha de RT logo abaixo.
 */
const LEVEL_PHRASES: Record<
  ReturnType<typeof deriveProtectionLevel>,
  string
> = {
  protected: "sem alertas reportados na leitura",
  attention: "atenção: algum componente limitado",
  degraded: "proteção reduzida: motores indisponíveis ou degradados",
  critical: "estado crítico: revisão imediata recomendada",
};

/** Linha de recursos (hardware) com a idade validada do snapshot. */
function resourcesLine(hardware: HardwareSnapshot, now: number): string {
  const age = timestampText(checkTimestamp(hardware.timestamp, now));
  const cpu = cpuUsageForNarrative(hardware.cpu);
  const ram = readNumber(hardware.ram?.usagePercent);
  const disk = readNumber(hardware.disk?.usagePercent);
  const parts = [
    cpu === null ? "CPU sem leitura" : `CPU ${cpu}%`,
    ram === null ? "RAM sem leitura" : `RAM ${ram}%`,
    disk === null ? "disco sem leitura" : `disco ${disk}%`,
  ];
  return `· Recursos (${age}): ${parts.join(", ")}`;
}

/**
 * Constrói a resposta PT-PT, determinista e pura
 * (testável sem renderer). Nunca afirma segurança
 * absoluta — mesmo o nível "protegido" é apresentado
 * como a última leitura, não como garantia. Leituras
 * em falta são "desconhecido", nunca zero.
 */
export function buildLocalSecurityReply(
  input: LocalSecuritySnapshotInput,
): string {
  const { protection, hardware, pcState, threats, now } = input;
  const lines: string[] = [];
  lines.push("Segundo as leituras do serviço:");
  if (pcState) {
    const labels = { good: "Estável", attention: "Atenção", critical: "Crítico", unknown: "Sem leitura" };
    lines.push(`· Estado do PC (${timestampText(checkTimestamp(pcState.generatedAt, now))}): ${labels[pcState.overall] ?? "Sem leitura"}`);
  } else {
    lines.push("· Estado do PC: desconhecido (sem leitura).");
  }
  const protectionAge = Number.isFinite(input.protectionReceivedAt) && input.protectionReceivedAt <= now
    ? Math.round((now - input.protectionReceivedAt) / 1000)
    : null;
  const protectionWhen = protectionAge === null ? "receção sem data válida" : protectionAge <= 1 ? "leitura de agora" : `resposta recebida há ${protectionAge} s`;

  // ── Proteção (sem timestamp próprio: receção) ──
  if (protection) {
    if (!protection.engine.serviceRunning) {
      lines.push(
        "· Proteção: o serviço não está a correr — sem leitura fiável.",
      );
      lines.push(
        "Não posso afirmar que o PC está seguro. Confirma que o serviço CyberSafe está em execução.",
      );
    } else {
      const level = deriveProtectionLevel(protection.status, protection.engine);
      lines.push(
        `· Proteção: ${protectionStatusText(protection.status)} — ${LEVEL_PHRASES[level]} (${protectionWhen})`,
      );
      const realtime = realtimeProtectionCopy({
        enabled: protection.protectionEnabled,
        pausedUntil: protection.protectionPausedUntil,
      });
      lines.push(
        `· Proteção em tempo real: ${realtime ? realtime.text : "não lida (desconhecida)"}`,
      );
      lines.push(`· Motores: ${enginesLine(protection.engine)}`);
    }
  } else {
    lines.push("· Proteção: sem leitura fiável — o estado é desconhecido.");
    lines.push("Não posso afirmar que o PC está seguro nem que não está.");
    lines.push(
      "Confirma que o serviço CyberSafe está em execução e pergunta de novo.",
    );
  }

  // ── Eventos de segurança (null ≠ 0) ──
  if (threats === null) {
    lines.push(
      "· Eventos de segurança disponíveis: desconhecidos (sem leitura) — não é zero.",
    );
  } else {
    lines.push(
      `· Eventos de segurança disponíveis: ${threats.length}${
        threats.length > 0 ? " — vê a página Ameaças" : ""
      } (consulta ao serviço)`,
    );
  }

  // ── Problemas do PC (generatedAt validado) ──
  if (pcState) {
    const age = timestampText(checkTimestamp(pcState.generatedAt, now));
    const findings = Array.isArray(pcState.findings) ? pcState.findings : [];
    if (findings.length > 0) {
      const titles = findings.slice(0, 3).map((finding) => finding.title);
      lines.push(`· Problemas detetados (${age}): ${titles.join("; ")}`);
    } else {
      lines.push(`· Problemas detetados (${age}): nenhum na última geração`);
    }
  } else {
    lines.push("· Problemas detetados: desconhecidos (sem leitura) — não é zero.");
  }

  // ── Recursos (timestamp validado) ──
  if (hardware) {
    lines.push(resourcesLine(hardware, now));
  } else {
    lines.push("· Recursos: sem leitura.");
  }

  lines.push(
    "Não posso garantir segurança absoluta — estas são as últimas leituras do serviço " +
      "(a proteção não publica timestamp próprio: a sua idade é medida da resposta), " +
      "não uma prova de que nada pode acontecer.",
  );
  return lines.join("\n");
}

/**
 * Controlo funcional de cancelamento: uma resposta
 * que chega depois de cancelada (abort), depois de
 * a janela ter fechado, ou depois de uma pergunta
 * mais recente, é DESCARTADA — o controller antigo
 * nunca escreve fase nem mensagem sobre a pergunta
 * nova (sem late append).
 */
export function cancelLocalSecurityRequest(controller: AbortController | null): void {
  controller?.abort();
}

export function shouldDiscardLateAnswer(options: {
  signalAborted: boolean;
  questionId: number;
  currentQuestionId: number;
}): boolean {
  return (
    options.signalAborted ||
    options.questionId !== options.currentQuestionId
  );
}

/**
 * Ponto de entrada do chat: se a pergunta for de
 * estado do PC, lê os 4 snapshots reais pela bridge
 * e devolve a resposta determinista. Devolve `null`
 * quando a pergunta NÃO é de estado (o fluxo normal
 * continua).
 *
 * Leituras parciais são honestas (`Promise.allSettled`):
 * cada fonte que falhar aparece como desconhecida,
 * nunca como zero. A bridge ausente ou leituras
 * rejeitadas não ecoam erros internos. Um abort
 * (utilizador cancelou/fechou) descarta a resposta —
 * um snapshot que chega tarde nunca produz texto
 * nem números (sem late append).
 *
 * LIMITAÇÃO DECLARADA (não inventada): as leituras
 * da bridge dependem do serviço, e o contrato
 * partilhado não define deadline para estas leituras
 * — por isso não se inventa budget de tempo; a
 * resposta chega quando chega e é descartada se
 * entretanto cancelada.
 */
export async function answerLocalSecurityQuestion(
  question: string,
  bridge: LocalSecurityBridge | null,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<LocalSecurityAnswer | null> {
  if (!isLocalSecurityQuestion(question)) {
    return null;
  }
  const clock = () => options.now ?? Date.now();

  if (!bridge) {
    const now = clock();
    return {
      reply: buildLocalSecurityReply({
        protection: null,
        hardware: null,
        pcState: null,
        threats: null,
        protectionReceivedAt: now,
        now,
      }),
    };
  }

  if (options.signal?.aborted) return null;
  let protectionReceivedAt = clock();
  const [protectionResult, hardwareResult, pcStateResult, threatsResult] =
    await Promise.allSettled([
      Promise.resolve().then(() => bridge.getProtectionState()).then(value => {
        protectionReceivedAt = clock();
        return value;
      }),
      Promise.resolve().then(() => bridge.getHardwareSnapshot()),
      Promise.resolve().then(() => bridge.getPCState()),
      Promise.resolve().then(() => bridge.getThreatEvents()),
    ]);

  // Chegada tardia (cancelar/janela fechada): descarta.
  if (options.signal?.aborted) {
    return null;
  }

  const now = clock();
  return {
    reply: buildLocalSecurityReply({
      protection:
        protectionResult.status === "fulfilled" ? protectionResult.value : null,
      hardware:
        hardwareResult.status === "fulfilled" ? hardwareResult.value : null,
      pcState:
        pcStateResult.status === "fulfilled" ? pcStateResult.value : null,
      threats:
        threatsResult.status === "fulfilled" ? threatsResult.value : null,
      protectionReceivedAt,
      now,
    }),
  };
}
