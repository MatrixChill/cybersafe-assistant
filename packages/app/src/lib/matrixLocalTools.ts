import type { HardwareSnapshot, ProtectionState } from "@cybersafe/shared-types";
import { cpuUsageForNarrative } from "./cpuUsage";
import {
  deriveProtectionLevel,
  engineStatusText,
  protectionStatusText,
  realtimeProtectionCopy,
} from "./protectionHealth";
import {
  answerLocalSecurityQuestion,
  type LocalSecurityAnswer,
  type LocalSecurityBridge,
} from "./localSecurityReply";

/**
 * Classificador determinístico de perguntas de ESTADO do CyberSafe.
 *
 * O detector antigo exigia o sujeito "PC" ou frases fixas: "Verifique aí o
 * estado de proteção" caía no fornecedor generativo, que só conhecia a página
 * aberta. Aqui o tópico escolhe a fonte de leitura, independentemente da página.
 *
 * `null` = não é leitura de estado (conhecimento geral, conselho, processo).
 */
export type MatrixLocalTopic = "protection" | "storage" | "resources" | "general";

// String.raw: numa string normal "\p" vira "p" e a fronteira deixava de o ser
// («gramática» e «telegrama» eram lidas como perguntas sobre RAM).
const B0 = String.raw`(?<![\p{L}\p{N}])`;
const B1 = String.raw`(?![\p{L}\p{N}])`;
const rx = (body: string) => new RegExp(B0 + body + B1, "iu");

const EDUCATIONAL =
  /(?<![\p{L}\p{N}])(o que (fazer|devo|posso|significa)|porque|por que|explica|explicar|como (resolver|evitar|melhorar)|é normal|e normal)(?![\p{L}\p{N}])/iu;
const PROCESS = /(?<![\p{L}\p{N}])(processos?|programas?)(?![\p{L}\p{N}])/iu;
const STATE_ASK =
  /(?<![\p{L}\p{N}])(quanto|quantos|qual|como|est[áa]|est[ãa]o|estou|verifica|verifique|mostra|mostre|diz|tens|tem|tenho|falta|livre|usad[oa]|dispon[ií]vel|ativos?|percentagem)(?![\p{L}\p{N}])/iu;

const TOPICS: ReadonlyArray<readonly [Exclude<MatrixLocalTopic, "general">, RegExp]> = [
  ["storage", rx("(armazenamento|disco|espa[cç]o|gigabytes?|gb|ssd|hd)")],
  ["resources", rx("(ram|mem[oó]ria|cpu|processador)")],
  ["protection", rx("(prote[cç][aã]o|motores?|antiv[ií]rus|clamav|yara|hashdb|tempo\s+real)")],
];

export function classifyMatrixTopic(text: string): MatrixLocalTopic | null {
  const lower = text.trim().toLowerCase();
  if (!lower) return null;
  if (EDUCATIONAL.test(lower)) return null;
  if (PROCESS.test(lower)) return null;
  if (!STATE_ASK.test(lower)) return null;
  for (const [topic, pattern] of TOPICS) {
    if (pattern.test(lower)) return topic;
  }
  return "general";
}

const num = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const gb = (value: number | null): string =>
  value === null ? "sem leitura" : `${Math.round(value * 10) / 10} GB`;

// Fontes com semânticas diferentes: hardware é amostrado a cada poucos segundos;
// a proteção muda por acção do utilizador e chega pelo serviço. Um limite único
// escondia leituras válidas de proteção ou dava hardware antigo como atual.
const HARDWARE_STALE_MS = 120_000;
const PROTECTION_STALE_MS = 300_000;

/** Nunca apresenta leitura futura, inválida ou antiga como estado atual. */
function freshness(timestamp: string | undefined, now: number, limiteMs = HARDWARE_STALE_MS): { ok: boolean; text: string } {
  const at = timestamp ? new Date(timestamp).getTime() : Number.NaN;
  if (!Number.isFinite(at)) return { ok: false, text: "sem leitura válida" };
  const age = now - at;
  if (age < 0) return { ok: false, text: "leitura inválida (data futura)" };
  if (age > limiteMs) return { ok: false, text: `leitura antiga (há ${Math.round(age / 1000)} s)` };
  return { ok: true, text: age <= 1000 ? "agora" : `há ${Math.round(age / 1000)} s` };
}

function storageReply(hardware: HardwareSnapshot | null, now: number): string {
  if (!hardware) {
    return "Sem leitura de hardware agora — não posso dizer quanto espaço tem. Confirma que o serviço CyberSafe está a correr.";
  }
  const fresh = freshness(hardware.timestamp, now);
  if (!fresh.ok) {
    return `A última leitura do disco não é atual (${fresh.text}) — não a apresento como estado de agora.`;
  }
  const used = num(hardware.disk?.usagePercent);
  const total = num(hardware.disk?.totalGb);
  const usedGb = num(hardware.disk?.usedGb);
  const free = total !== null && usedGb !== null ? total - usedGb : null;
  return [
    `Disco principal (${fresh.text}):`,
    used === null ? "· utilização sem leitura" : `· ${used}% utilizado`,
    free === null ? "· espaço livre sem leitura" : `· ${gb(free)} livres de ${gb(total)}`,
  ].join("\n");
}

function resourcesReply(hardware: HardwareSnapshot | null, now: number): string {
  if (!hardware) {
    return "Sem leitura de hardware agora — não posso dizer como está a CPU ou a RAM.";
  }
  const fresh = freshness(hardware.timestamp, now);
  if (!fresh.ok) {
    return `A última leitura de recursos não é atual (${fresh.text}) — não a apresento como estado de agora.`;
  }
  const cpu = cpuUsageForNarrative(hardware.cpu);
  const ram = num(hardware.ram?.usagePercent);
  return [
    `Recursos (${fresh.text}):`,
    cpu === null ? "· CPU sem leitura" : `· CPU ${cpu}%`,
    ram === null ? "· RAM sem leitura" : `· RAM ${ram}% de ${gb(num(hardware.ram?.totalGb))}`,
  ].join("\n");
}

const ENGINES = [
  ["YARA", "yara"],
  ["HashDB", "hashDb"],
  ["ClamAV", "clamav"],
  ["Native", "nativeEngine"],
] as const;

function protectionReply(protection: ProtectionState | null, now: number): string {
  if (!protection) {
    return "Sem leitura da proteção — o estado é desconhecido. Confirma que o serviço CyberSafe está a correr.";
  }
  if (!protection.engine?.serviceRunning) {
    return "O serviço CyberSafe não está a correr: não há leitura fiável da proteção.";
  }
  const realtime = realtimeProtectionCopy({
    enabled: protection.protectionEnabled,
    pausedUntil: protection.protectionPausedUntil,
  });
  const engines = ENGINES.map(([label, key]) => {
    const engine = protection.engine[key];
    return engine ? `${label} ${engineStatusText(engine.status)}` : `${label} sem leitura`;
  });
  const carimbo = (protection as unknown as { timestamp?: string; measuredAt?: string }).timestamp
    ?? (protection as unknown as { measuredAt?: string }).measuredAt;
  const idade = carimbo ? freshness(carimbo, now, PROTECTION_STALE_MS) : null;
  const cabeca = idade
    ? `Proteção: ${protectionStatusText(protection.status)} (${idade.text}).`
    : `Proteção: ${protectionStatusText(protection.status)}.`;
  const aviso = idade && !idade.ok
    ? ["Aviso: este é o último estado conhecido e pode já não ser o atual."]
    : [];
  return [
    ...aviso,
    cabeca,
    `· Tempo real: ${realtime ? realtime.text : "não lido (desconhecido)"}`,
    `· Motores: ${engines.join(" · ")}`,
    `· Nível: ${deriveProtectionLevel(protection.status, protection.engine)}`,
  ].join("\n");
}

/**
 * Entrada única do chat para perguntas de estado. Lê apenas a fonte do tópico.
 * Devolve `null` quando a pergunta não é uma leitura local.
 */
export async function answerMatrixLocalQuestion(
  question: string,
  bridge: LocalSecurityBridge | null,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<LocalSecurityAnswer | null> {
  const topic = classifyMatrixTopic(question);
  if (topic === null || topic === "general") {
    return answerLocalSecurityQuestion(question, bridge, options);
  }
    if (!bridge) return { reply: "Sem acesso às leituras do serviço neste momento." };
  if (options.signal?.aborted) return null;

  const now = options.now ?? Date.now();
  if (topic === "protection") {
    const result = await Promise.allSettled([Promise.resolve().then(() => bridge.getProtectionState())]);
    if (options.signal?.aborted) return null;
    const first = result[0];
    return { reply: protectionReply(first.status === "fulfilled" ? first.value : null, now) };
  }
  const result = await Promise.allSettled([Promise.resolve().then(() => bridge.getHardwareSnapshot())]);
  if (options.signal?.aborted) return null;
  const first = result[0];
  const snapshot = first.status === "fulfilled" ? first.value : null;
  return { reply: topic === "storage" ? storageReply(snapshot, now) : resourcesReply(snapshot, now) };
}
