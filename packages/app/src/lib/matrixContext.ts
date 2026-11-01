import type { HardwareSnapshot, PcState, ProtectionState, ThreatEvent } from "@cybersafe/shared-types";
import { cpuUsageForNarrative } from "@/lib/cpuUsage";

/**
 * HORA 3/G3 — o contexto que o Matrix (assistente) recebe, extraido do App
 * para ser puro e testavel. Mesmos campos factuais de sempre, e so os campos
 * factuais:
 *
 *  · `Real-time protection: on|off|unknown` — leitura direta de
 *    `protectionEnabled`. `undefined` e "unknown", NUNCA "off": o tipo diz que
 *    ausente significa "nao foi lido", e afirmar off seria inventar.
 *  · `Protection paused until: <ISO>` — so quando o servico emite o campo.
 *
 * Continuamos sem caminhos, emails nem conteudo de ficheiros (privacidade).
 */

/**
 * Um número lido, ou `null` quando não há medição utilizável.
 *
 * Existe porque `== null` NÃO apanha `NaN`: uma serialização corrompida em IPC
 * (`NaN`/`Infinity`) passava a guarda e o contexto chegava à IA como
 * «Disk usage: NaN%» — a mesma classe de defeito que «0,0%» sem medição, e a que
 * o produto inteiro está proibido de mostrar. `Number.isFinite` fecha os dois.
 */
const readNumber = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Contagem por janela sobre a lista retida pelo App (limitada a 500 eventos).
 * Datas inválidas e futuras não entram; sem amostras utilizáveis não há linha.
 * O rótulo diz "retained feed" para não passar uma amostra por histórico total.
 */
function retainedThreatTrend(threats: ThreatEvent[], now: number): string | null {
  let recent = 0;
  let previous = 0;
  for (const threat of threats) {
    const at = Date.parse(threat.createdAt);
    if (!Number.isFinite(at) || at > now) continue;
    if (at >= now - DAY_MS) recent += 1;
    else if (at >= now - 2 * DAY_MS) previous += 1;
  }
  if (recent === 0 && previous === 0) return null;
  const delta = recent - previous;
  const trend = delta > 0 ? `up (+${delta})` : delta < 0 ? `down (${delta})` : "stable";
  return `Threats in retained feed: last 24h ${recent}, previous 24h ${previous}, trend ${trend}`;
}

export interface MatrixContextInput {
  protection: ProtectionState | null;
  hardware: HardwareSnapshot | null;
  pcState: PcState | null;
  threats: ThreatEvent[];
  /** Relógio injectável para a janela de 24h; ausente = agora. */
  now?: number;
}

export function buildMatrixContext({ protection, hardware, pcState, threats, now }: MatrixContextInput): string {
  const referenceNow = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const parts: string[] = [];
  if (protection) {
    parts.push(`Protection score: ${Math.max(0, 100 - protection.stats.riskScore)}`);
    parts.push(`Protection status: ${protection.status}`);
    parts.push(
      `Real-time protection: ${
        protection.protectionEnabled === true
          ? "on"
          : protection.protectionEnabled === false
            ? "off"
            : "unknown"
      }`,
    );
    if (typeof protection.protectionPausedUntil === "string" && protection.protectionPausedUntil.trim() !== "") {
      parts.push(`Protection paused until: ${protection.protectionPausedUntil.trim()}`);
    }
    parts.push(`Service running: ${protection.engine.serviceRunning}`);
    parts.push(`Security events (total): ${protection.stats.totalEvents}`);
    parts.push(`Quarantined items: ${protection.stats.quarantinedCount}`);
  }
  if (hardware) {
    const cpu = cpuUsageForNarrative(hardware.cpu);
    parts.push(cpu === null ? "CPU usage: sem leitura" : `CPU usage: ${cpu}%`);
    const ram = readNumber(hardware.ram.usagePercent);
    parts.push(ram === null ? "RAM usage: sem leitura" : `RAM usage: ${ram}%`);
    // Sem leitura não se manda "0%" para o contexto da IA: ausência de dado
    // tem de chegar como ausência, senão a IA explica um disco vazio que não existe.
    // `== null` (e não `=== null`) cobre também snapshots parciais de serviços
    // antigos, que não traziam o campo nenhum.
    const diskUsage = readNumber(hardware.disk.usagePercent);
    parts.push(
      diskUsage === null
        ? "Disk usage: sem leitura"
        : `Disk usage: ${diskUsage}%`,
    );
    // `volumes` só existe nos snapshots novos: sem a guarda, um serviço antigo
    // (ou um mock parcial) rebentava o construtor de contexto inteiro.
    const volumes = Array.isArray(hardware.disk.volumes) ? hardware.disk.volumes : [];
    const otherVolumes = volumes.filter(
      (volume) => volume.kind === "working" && volume.mount !== hardware.disk.primary?.mount,
    );
    for (const volume of otherVolumes) {
      // Only drive letters are telemetry; folder/UNC mounts can identify users.
      if (!/^[a-z]:\\?$/i.test(volume.mount)) continue;
      const free = readNumber(volume.freeGb);
      const used = readNumber(volume.usagePercent);
      // `mount` no Windows já traz os dois pontos ("D:"); o sufixo só entra se
      // não vier, senão o contexto dizia «Disk D:: 10 GB livres».
      const rotulo = volume.mount.endsWith(":") ? volume.mount : `${volume.mount}:`;
      parts.push(
        `Disk ${rotulo} ${free === null ? "livre sem leitura" : `${free} GB livres`}` +
          ` (${used === null ? "uso sem leitura" : `${used}% usado`})`,
      );
    }
  }
  if (pcState) {
    parts.push(`PC overall: ${pcState.overall}`);
    parts.push(`Security: ${pcState.security} | Performance: ${pcState.performance} | System: ${pcState.system}`);
    // Free-text findings can contain process names and paths. Process details
    // use the separate consent-gated structured contract, never this context.
    parts.push(`PC findings (count): ${Array.isArray(pcState.findings) ? pcState.findings.length : 0}`);
  }
  parts.push(`Active threats: ${threats.length}`);
  const retainedTrend = retainedThreatTrend(threats, referenceNow);
  if (retainedTrend) parts.push(retainedTrend);
  return parts.join("\n");
}
