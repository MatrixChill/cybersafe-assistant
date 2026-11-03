import type { HardwareSnapshot, ProtectionState } from "@cybersafe/shared-types";
import { cpuUsageForNarrative } from "@/lib/cpuUsage";
import {
  deriveProtectionLevel,
  engineStatusText,
  protectionStatusText,
  realtimeProtectionCopy,
} from "@/lib/protectionHealth";
import {
  answerLocalSecurityQuestion,
  type LocalSecurityAnswer,
  type LocalSecurityBridge,
} from "@/lib/localSecurityReply";

/**
 * Classificador determinístico de perguntas de ESTADO do CyberSafe.
 *
 * Existe porque o detector anterior exigia o sujeito "PC" ou frases fixas: uma
 * pergunta como "Verifique aí o estado de proteção" caía no fornecedor
 * generativo, que só conhecia a página aberta. Aqui o tópico decide a leitura.
 *
 * Devolve `null` para perguntas educativas ("o que fazer se...") e para
 * perguntas sobre processos — essas não são leituras de estado.
 */
export type MatrixLocalTopic = "protection" | "storage" | "resources" | "general";

const EDUCATIONAL =
  /(o que (fazer|devo|posso|significa)|porque|por que|explica|explicar|como (resolver|evitar|melhorar)|é normal|e normal)/i;
const PROCESS = /(processos?|programas?)/i;
const STATE_ASK =
  /(quanto|quantos|qual|como|est[áa]|est[ãa]o|verifica|verifique|mostra|mostre|diz|tens|tem|tenho|falta|livre|usad[oa]|dispon[ií]vel|ativos?|percentagem)/i;

const TOPICS: ReadonlyArray<readonly [Exclude<MatrixLocalTopic, "general">, RegExp]> = [
  ["storage", /(armazenamento|disco|espa[cç]o|gigabytes?|gb|ssd|hd)/i],
  ["resources", /(ram|mem[oó]ria|cpu|processador)/i],
  ["protection", /(prote[cç][cç][aã]o|motores?|antiv[ií]rus|clamav|yara|hashdb|tempo\s+real)/i],
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

function freshness(timestamp: string | undefined, now: number): string {
  const at = timestamp ? new Date(timestamp).getTime() : Number.NaN;
  if (!Number.isFinite(at) || at > now) return "sem leitura válida";
  const seconds = Math.round((now - at) / 1000);
  return seconds <= 1 ? "agora" : `há ${seconds} s`;
}

function storageReply(hardware: HardwareSnapshot | null, now: number): string {
  if (!hardware) return "Sem leitura de hardware agora — não posso dizer quanto espaço tem. Confirma que o serviço CyberSafe está a correr.";
  const used = num(hardware.disk?.usagePercent);
  const total = num(hardware.disk?.totalGb);
  const usedGb = num(hardware.disk?.usedGb);
  const free = total !== null && usedGb !== null ? total - usedGb : null;
  return [
    `Disco principal (${freshness(hardware.timestamp, now)}):`,
    used === null ? "· utilização sem leitura" : `· ${used}% utilizado`,
    free === null ? "· espaço livre sem leitura" : `· ${gb(free)} livres de ${gb(total)}`,
  ].join("
");
}

function resourcesReply(hardware: HardwareSnapshot | null, now: number): string {
  if (!hardware) return "Sem leitura de hardware agora — não posso dizer como está a CPU ou a RAM.";
  const cpu = cpuUsageForNarrative(hardware.cpu);
  const ram = num(hardware.ram?.usagePercent);
  return [
    `Recursos (${freshness(hardware.timestamp, now)}):`,
    cpu === null ? "· CPU sem leitura" : `· CPU ${cpu}%`,
    ram === null ? "· RAM sem leitura" : `· RAM ${ram}% de ${gb(num(hardware.ram?.totalGb))}`,
  ].join("
");
}

function protectionReply(protection: ProtectionState | null): string {
  if (!protection) return "Sem leitura da proteção — o estado é desconhecido. Confirma que o serviço CyberSafe está a correr.";
  if (!protection.engine.serviceRunning) return "O serviço CyberSafe não está a correr: não há leitura fiável da proteção.";
  const level = deriveProtectionLevel(protection.status, protection.engine);
  const realtime = realtimeProtectionCopy({
    enabled: protection.protectionEnabled,
    pausedUntil: protection.protectionPausedUntil,
  });
  const subsystems = [
    protection.engine.yara,
    protection.engine.hashDb,
    protection.engine.clamav,
    protection.engine.nativeEngine,
  ].filter(Boolean);
  const active = subsystems.filter((engine) => engine!.status === "active").length;
  const others = subsystems
    .filter((engine) => engine!.status !== "active")
    .map((engine) => engineStatusText(engine!.status));
  return [
    `Proteção: ${protectionStatusText(protection.status)}.`,
    `· Tempo real: ${realtime ? realtime.text : "não lido (desconhecido)"}`,
    `· Motores: ${subsystems.length === 0 ? "sem leitura" : `${active} ativos de ${subsystems.length}`}${
      others.length > 0 ? ` (${others.join(", ")})` : ""
    }`,
    `· Nível: ${level}`,
  ].join("
");
}

/**
 * Entrada única do chat para perguntas de estado que a MATRIX sabe ler.
 * Devolve `null` quando a pergunta não é uma leitura local.
 */
export async function answerMatrixLocalQuestion(
  question: string,
  bridge: LocalSecurityBridge | null,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<LocalSecurityAnswer | null> {
  const topic = classifyMatrixTopic(question);
  if (topic === null) return answerLocalSecurityQuestion(question, bridge, options);
  if (topic === "general") return answerLocalSecurityQuestion(question, bridge, options);
  if (!bridge) return { reply: "Sem acesso às leituras do serviço neste momento." };

  const clock = () => options.now ?? Date.now();
  if (options.signal?.aborted) return null;
  const [protection, hardware] = await Promise.allSettled([
    Promise.resolve().then(() => bridge.getProtectionState()),
    Promise.resolve().then(() => bridge.getHardwareSnapshot()),
  ]);
  if (options.signal?.aborted) return null;
  const now = clock();
  if (topic === "protection") {
    return { reply: protectionReply(protection.status === "fulfilled" ? protection.value : null) };
  }
  const snapshot = hardware.status === "fulfilled" ? hardware.value : null;
  return { reply: topic === "storage" ? storageReply(snapshot, now) : resourcesReply(snapshot, now) };
}
