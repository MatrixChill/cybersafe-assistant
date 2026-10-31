/**
 * ── ARMAZENAMENTO: leitura → estado publicável ───────────────────────────────
 *
 * Porque existe este módulo (auditoria de 2026-10-09): a falha de leitura do
 * volume era escrita como `0` em `mediumMetrics` — percentagem, usado e total —
 * e esse `0` viajava até ao ecrã. O utilizador via "0%" no PC Center e
 * "sem leitura do volume" no Dashboard ao mesmo tempo, sem saber qual era
 * verdade. Pior: cada leitura falhada DESCARTava o último valor bom, portanto um
 * erro passageiro de WMI apagava uma medição boa de segundos antes.
 *
 * A regra deste módulo é explícita:
 *   1. `0` é uma MEDIÇÃO (um disco pode estar mesmo vazio) e só existe se medido;
 *   2. "sem leitura" é OUTRO estado, com motivo, e nunca se disfarça de 0;
 *   3. um valor bom recente sobrevive a uma falha passageira (TTL) e é publicado
 *      como `stale` — a UI pode dizê-lo com a idade da leitura;
 *   4. volume minúsculo (< 1 GiB) é partição reservada do sistema, não é um
 *      disco de trabalho e não gera alarme.
 *
 * Tudo aqui é puro e determinístico: os testes correm sem WMI, sem Windows e
 * sem I/O, incluindo os caminhos de falha.
 */
import type {
  DiskReadStatus,
  DiskSnapshot,
  DiskVolumeKind,
  DiskVolumeSnapshot,
} from "@cybersafe/shared-types";

/**
 * Quanto tempo (ms) um último valor bom continua a ser publicado como `stale`
 * depois de uma leitura falhada. O tick de disco corre a cada 5 s, portanto 60 s
 * tolera até ~12 falhas seguidas (picos de WMI, suspensão, I/O saturado) sem o
 * número piscar.
 */
export const DISK_STALE_TTL_MS = 60_000;

/**
 * Abaixo disto (GiB) o volume é tratado como partição reservada do sistema.
 * Justificação medida: nesta instalação o volume "Reservado pelo Sistema" tem
 * 52 MB (0,05 GiB); nenhum volume de trabalho do Windows fica abaixo de 1 GiB.
 */
export const DISK_SYSTEM_RESERVED_MAX_GB = 1;

/** Entrada crua aceite de `systeminformation.fsSize()` (validada campo a campo). */
export interface RawFsEntry {
  fs?: unknown;
  type?: unknown;
  size?: unknown;
  used?: unknown;
  available?: unknown;
  use?: unknown;
  mount?: unknown;
  rw?: unknown;
}

export interface DiskReadOutcome {
  ok: boolean;
  volumes: DiskVolumeSnapshot[];
  /** Motivo legível quando `ok === false`. `null` quando a leitura foi boa. */
  reason: string | null;
}

export interface DiskLastGood {
  volumes: DiskVolumeSnapshot[];
  /** Momento (ISO) da leitura boa. */
  at: string;
}

const toFiniteNumber = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Arredonda uma capacidade em GB sem transformar volumes pequenos em zero:
 * 1 casa decimal a partir de 1 GB, 2 casas abaixo disso. Sem isto, a partição
 * reservada de 52 MB (0,05 GB) apareceria como "0 GB" — que é o mesmo defeito
 * de honestidade que este módulo existe para corrigir, só noutra escala.
 */
const roundGb = (value: number) => (value < 1 ? Math.round(value * 100) / 100 : round1(value));

const clamp01 = (value: number) => Math.min(100, Math.max(0, value));

const BYTES_PER_GB = 1024 ** 3;

function classify(sizeBytes: number): DiskVolumeKind {
  // Nota honesta: `fsSize()` não expõe o tipo de unidade (fixa/amovível/rede).
  // Só classificamos o que é verificável pela capacidade; uma unidade amovível
  // aparece com letra e capacidade e conta como volume de trabalho, que é o
  // comportamento correto enquanto estiver ligada.
  //
  // A comparação é feita em BYTES, não no valor já arredondado: medido nesta
  // instalação, a partição reservada tem 0,05 GB e arredondar primeiro para 1
  // casa decimal dava 0 — e um 0 deixava de ser "< 1 GB", passando a contarse
  // como disco de trabalho.
  return sizeBytes < DISK_SYSTEM_RESERVED_MAX_GB * BYTES_PER_GB ? "system-reserved" : "working";
}

/**
 * Valida e normaliza a lista crua de sistemas de ficheiros.
 * Nunca inventa valores: entradas sem montagem ou sem capacidade legível são
 * ignoradas e o motivo agregado é devolvido (para a UI poder explicar).
 */
export function describeDiskRead(entries: unknown, error?: string | null): DiskReadOutcome {
  if (error) {
    const trimmed = String(error).trim();
    return {
      ok: false,
      volumes: [],
      reason: trimmed
        ? `O serviço de armazenamento do Windows não respondeu (${trimmed}).`
        : "O serviço de armazenamento do Windows não respondeu.",
    };
  }
  if (!Array.isArray(entries)) {
    return { ok: false, volumes: [], reason: "O sistema não devolveu a lista de volumes." };
  }

  const volumes: DiskVolumeSnapshot[] = [];
  let ignoredWithoutMount = 0;
  let ignoredWithoutSize = 0;

  for (const raw of entries as RawFsEntry[]) {
    if (!raw || typeof raw !== "object") continue;

    const mount = typeof raw.mount === "string" && raw.mount.trim() ? raw.mount.trim() : null;
    if (!mount) {
      ignoredWithoutMount += 1;
      continue;
    }

    const sizeBytes = toFiniteNumber(raw.size);
    if (sizeBytes === null || sizeBytes <= 0) {
      ignoredWithoutSize += 1;
      continue;
    }

    const usedBytesRaw = toFiniteNumber(raw.used);
    const availableBytes = toFiniteNumber(raw.available);
    const usedBytes =
      usedBytesRaw !== null && usedBytesRaw >= 0
        ? Math.min(usedBytesRaw, sizeBytes)
        : availableBytes !== null && availableBytes >= 0
          ? Math.max(0, sizeBytes - availableBytes)
          : null;
    if (usedBytes === null) {
      ignoredWithoutSize += 1;
      continue;
    }

    const freeBytes =
      availableBytes !== null && availableBytes >= 0
        ? Math.min(availableBytes, sizeBytes)
        : Math.max(0, sizeBytes - usedBytes);

    volumes.push({
      mount,
      fileSystem: typeof raw.type === "string" && raw.type.trim() ? raw.type.trim() : "desconhecido",
      totalGb: roundGb(sizeBytes / BYTES_PER_GB),
      usedGb: roundGb(usedBytes / BYTES_PER_GB),
      freeGb: roundGb(freeBytes / BYTES_PER_GB),
      usagePercent: round1(clamp01((usedBytes / sizeBytes) * 100)),
      kind: classify(sizeBytes),
      readOnly: raw.rw === false,
    });
  }

  if (volumes.length === 0) {
    const details = [
      ignoredWithoutMount ? `${ignoredWithoutMount} sem ponto de montagem` : null,
      ignoredWithoutSize ? `${ignoredWithoutSize} sem capacidade legível` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(", ");
    return {
      ok: false,
      volumes: [],
      reason: details
        ? `Nenhum volume pôde ser medido (${details}).`
        : "Nenhum volume foi reportado pelo sistema.",
    };
  }

  // Volumes de trabalho primeiro (mais cheios à frente), reservados no fim.
  const rank = (volume: DiskVolumeSnapshot) => (volume.kind === "working" ? 0 : 1);
  volumes.sort((a, b) => rank(a) - rank(b) || b.usagePercent - a.usagePercent);

  return { ok: true, volumes, reason: null };
}

/**
 * Volume principal: o que hospeda o Windows (C:), se existir; senão o volume de
 * trabalho mais cheio. Escolha explícita e determinística — nunca `volumes[0]`
 * cego (a lista é ordenada por ocupação, o que mudaria de disco conforme o uso).
 */
export function pickPrimaryVolume(volumes: DiskVolumeSnapshot[]): DiskVolumeSnapshot | null {
  const working = volumes.filter((volume) => volume.kind === "working");
  if (working.length === 0) return null;
  const system = working.find((volume) => /^[a-z]:$/i.test(volume.mount) && volume.mount[0].toUpperCase() === "C");
  return system ?? working[0];
}

/** Volume de trabalho mais cheio — é dele que sai o aviso de pouco espaço. */
export function worstWorkingVolume(volumes: DiskVolumeSnapshot[]): DiskVolumeSnapshot | null {
  const working = volumes.filter((volume) => volume.kind === "working");
  if (working.length === 0) return null;
  return working.reduce((worst, volume) => (volume.usagePercent > worst.usagePercent ? volume : worst));
}

function fromVolumes(
  volumes: DiskVolumeSnapshot[],
  readStatus: DiskReadStatus,
  reason: string | null,
  lastGoodAt: string | null,
): DiskSnapshot {
  const primary = pickPrimaryVolume(volumes);
  return {
    readStatus,
    reason,
    lastGoodAt,
    volumes,
    primary,
    usagePercent: primary ? primary.usagePercent : null,
    usedGb: primary ? primary.usedGb : null,
    totalGb: primary ? primary.totalGb : null,
    fsType: primary ? primary.fileSystem : "unknown",
  };
}

/** Estado inicial honesto: nenhuma leitura foi feita ainda desde o arranque. */
export function initialDiskSnapshot(): DiskSnapshot {
  return fromVolumes([], "unavailable", "Ainda sem leitura do armazenamento desde o arranque.", null);
}

/**
 * Combina uma leitura (boa ou falhada) com a memória do último valor bom e
 * publica o estado a mostrar. Sem leitura e sem valor bom recente, os números
 * ficam `null` — nunca 0.
 */
export function buildDiskSnapshot(input: {
  read: DiskReadOutcome;
  lastGood: DiskLastGood | null;
  nowMs: number;
  nowIso: string;
  ttlMs?: number;
}): { snapshot: DiskSnapshot; lastGood: DiskLastGood | null } {
  const ttlMs = input.ttlMs ?? DISK_STALE_TTL_MS;

  if (input.read.ok) {
    const lastGood: DiskLastGood = { volumes: input.read.volumes, at: input.nowIso };
    return { snapshot: fromVolumes(input.read.volumes, "ok", null, lastGood.at), lastGood };
  }

  const reason = input.read.reason ?? "Sem leitura do armazenamento.";
  const previous = input.lastGood;
  if (previous) {
    const ageMs = input.nowMs - Date.parse(previous.at);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs) {
      return {
        snapshot: fromVolumes(previous.volumes, "stale", reason, previous.at),
        lastGood: previous,
      };
    }
  }

  return {
    snapshot: fromVolumes([], "unavailable", reason, previous?.at ?? null),
    lastGood: previous,
  };
}
