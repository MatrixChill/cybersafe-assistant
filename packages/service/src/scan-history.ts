import * as fs from "node:fs/promises";
import type { ScanHistoryEntry, ScanHistoryPage, ScanHistoryStatus } from "@cybersafe/shared-types";
import type { ExtendedScanState, InconclusiveReasonCount } from "./scan-manager.js";

/**
 * O campo é opcional no contrato. A interseção local garante que este ficheiro
 * compila mesmo quando o `@cybersafe/shared-types` resolvido ainda é o dist
 * anterior (lane/DEV usam um node_modules partilhado) — o JSON é o mesmo.
 */
type HistoryEntryWithInconclusive = ScanHistoryEntry & {
  inconclusiveByReason?: InconclusiveReasonCount[];
};

/**
 * Histórico persistente de análises (R7-L3).
 *
 * Ficheiro próprio e separado (`<baseDir>/scans.jsonl`, injetado —
 * NUNCA derivado de `os.homedir()`, para o teste de isolamento de
 * runtime continuar a isolar o serviço num diretório temporário):
 * uma linha JSON por análise, escrita quando a análise atinge um
 * estado terminal, no máximo uma vez por scanId.
 *
 * O leitor é resiliente (linha corrompida = ignorada, não fatal) e
 * a retenção compacta por ficheiro temporário + `rename` — o
 * original nunca é reescrevido in-place. Nada disto bloqueia nem
 * falha um scan em execução: `record` nunca rejeita.
 */

/** Teto de entradas retidas (env `CYBERSAFE_SCAN_HISTORY_MAX`). */
export const DEFAULT_SCAN_HISTORY_MAX = 200;

/** Tamanho de página por omissão e máximo (o cliente não manda mais que isto). */
export const DEFAULT_SCAN_HISTORY_PAGE_SIZE = 20;
export const MAX_SCAN_HISTORY_PAGE_SIZE = 100;

const TERMINAL_STATUSES: ReadonlyArray<string> = ["completed", "cancelled", "failed"];

const INCONCLUSIVE_REASONS: ReadonlyArray<string> = [
  "engine-unavailable",
  "engine-failed",
  "no-verdict",
  "coverage-incomplete",
  "timeout",
  "invalid-output",
  "file-changed",
  "archive-incomplete",
  "cancelled",
];

/** Teto de retenção a partir do env; valor inválido = default. */
export function scanHistoryMaxFromEnv(env: string | undefined): number {
  const parsed = Number.parseInt(env ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SCAN_HISTORY_MAX;
}

/** Âmbito da análise: o caminho do utilizador NUNCA atravessa para o histórico. */
export function historyTargetOf(type: string): "default" | "custom" {
  return type === "custom" ? "custom" : "default";
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function historyDurationMs(startedAt?: string, endedAt?: string): number {
  const start = Date.parse(startedAt ?? "");
  const end = Date.parse(endedAt ?? "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;
}

/**
 * Denominador real: o mesmo que a UI calcula (scanResultBreakdown) —
 * `filesTotal` congelado no fim do gathering quando existe, senão
 * `filesScanned`. Nunca um máximo teórico.
 */
export function historyFilesConsidered(state: ExtendedScanState): number {
  const total =
    typeof state.filesTotal === "number" && state.filesTotal > 0
      ? state.filesTotal
      : state.filesScanned ?? 0;
  return nonNegativeInt(total);
}

/** Mapeia o estado terminal real para a entrada do histórico. Sem limitação medida, o campo fica ausente. */
export function toScanHistoryEntry(state: ExtendedScanState): HistoryEntryWithInconclusive {
  return {
    id: state.id,
    type: state.type,
    target: historyTargetOf(state.type),
    status: state.status as ScanHistoryStatus,
    startedAt: state.startTime ?? "",
    endedAt: state.endTime ?? "",
    durationMs: historyDurationMs(state.startTime, state.endTime),
    filesConsidered: historyFilesConsidered(state),
    filesAnalyzed: nonNegativeInt(state.filesAnalyzed),
    filesExcluded: nonNegativeInt(state.filesExcluded),
    filesFailed: nonNegativeInt(state.filesFailed),
    ...(typeof state.filesInconclusive === "number" &&
      Number.isInteger(state.filesInconclusive) && state.filesInconclusive >= 0
      ? { filesInconclusive: state.filesInconclusive }
      : {}),
    ...(Array.isArray(state.inconclusiveByReason) && state.inconclusiveByReason.length > 0
      ? { inconclusiveByReason: state.inconclusiveByReason }
      : {}),
    threatsFound: nonNegativeInt(state.threatsFound),
  };
}

export function isTerminalScanStatus(value: unknown): value is ScanHistoryStatus {
  return typeof value === "string" && TERMINAL_STATUSES.includes(value);
}

/** Validação de leitura: uma linha parseável mas inválida é ignorada como as corrompidas. */
function isScanHistoryEntry(value: unknown): value is ScanHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    entry.id === "" ||
    typeof entry.type !== "string" ||
    (entry.target !== "default" && entry.target !== "custom") ||
    !isTerminalScanStatus(entry.status) ||
    typeof entry.startedAt !== "string" ||
    typeof entry.endedAt !== "string" ||
    !Number.isFinite(entry.durationMs) ||
    !Number.isFinite(entry.filesConsidered) ||
    !Number.isFinite(entry.filesAnalyzed) ||
    !Number.isFinite(entry.filesExcluded) ||
    !Number.isFinite(entry.filesFailed) ||
    (entry.filesInconclusive !== undefined &&
      (typeof entry.filesInconclusive !== "number" ||
        !Number.isFinite(entry.filesInconclusive) ||
        entry.filesInconclusive < 0)) ||
    (entry.inconclusiveByReason !== undefined &&
      (!Array.isArray(entry.inconclusiveByReason) ||
        entry.inconclusiveByReason.some(
          (item) =>
            !item ||
            typeof item !== "object" ||
            !INCONCLUSIVE_REASONS.includes((item as { reason?: unknown }).reason as string) ||
            typeof (item as { count?: unknown }).count !== "number" ||
            !Number.isFinite((item as { count: number }).count) ||
            (item as { count: number }).count <= 0,
        ))) ||
    !Number.isFinite(entry.threatsFound)
  ) {
    return false;
  }
  if (
    entry.engineLimitations !== undefined &&
    (!Array.isArray(entry.engineLimitations) ||
      entry.engineLimitations.some((item) => typeof item !== "string"))
  ) {
    return false;
  }
  return true;
}

export function clampScanHistoryLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_SCAN_HISTORY_PAGE_SIZE;
  }
  return Math.min(MAX_SCAN_HISTORY_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

/** Cursor opaco: o deslocamento na lista mais-recente-primeiro, codificado. */
export function encodeScanHistoryCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

export function decodeScanHistoryCursor(cursor: unknown): number | null {
  if (typeof cursor !== "string" || cursor === "") return null;
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!/^\d+$/.test(raw)) return null;
  const offset = Number.parseInt(raw, 10);
  return Number.isFinite(offset) && offset >= 0 ? offset : null;
}

/** Página mais-recente-primeiro a partir da ordem de append do ficheiro. */
export function buildScanHistoryPage(
  all: ScanHistoryEntry[],
  limit?: number,
  cursor?: string,
): ScanHistoryPage {
  const size = clampScanHistoryLimit(limit);
  const offset = decodeScanHistoryCursor(cursor) ?? 0;
  const newestFirst = [...all].reverse();
  const entries = newestFirst.slice(offset, offset + size);
  const nextOffset = offset + entries.length;
  return {
    entries,
    nextCursor: nextOffset < newestFirst.length ? encodeScanHistoryCursor(nextOffset) : null,
  };
}

export interface ScanHistoryOptions {
  /** Teto de entradas retidas (default 200; env `CYBERSAFE_SCAN_HISTORY_MAX`). */
  max?: number;
}

export class ScanHistory {
  private readonly filePath: string;
  private readonly max: number;
  /** Serializa registos: dois fins de análise nunca intercalam leituras/escritas. */
  private chain: Promise<void> = Promise.resolve();

  constructor(filePath: string, options?: ScanHistoryOptions) {
    this.filePath = filePath;
    this.max = options?.max ?? scanHistoryMaxFromEnv(process.env.CYBERSAFE_SCAN_HISTORY_MAX);
  }

  /**
   * Regista o fim de uma análise. NUNCA rejeita: o scan que a chamou
   * é dono do ciclo — um falhanço de I/O no histórico não pode tocar
   * numa análise em execução.
   */
  record(state: ExtendedScanState): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        // Nunca regista um estado não terminal (defesa em profundidade:
        // quem chama já só chega aqui na transição terminal).
        if (!isTerminalScanStatus(state.status)) return;
        const entry = toScanHistoryEntry(state);
        const existing = await this.readEntries();
        // Idempotente: no máximo uma linha por scanId, mesmo a
        // chamada duplicada (reinstalação, retry do caller).
        if (existing.some((prior) => prior.id === entry.id)) return;
        await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
        if (existing.length + 1 > this.max) {
          await this.compact(existing.concat(entry));
        }
      } catch (error) {
        // Sem caminhos no log: a mensagem de erro do fs pode conter o
        // caminho do serviço (casa do utilizador).
        console.error(
          `[ScanHistory] falha ao registar a análise ${state.id} (histórico indisponível; scan sem impacto): ${
            error instanceof Error ? error.name : "erro"
          }`,
        );
      }
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  async query(limit?: number, cursor?: string): Promise<ScanHistoryPage> {
    // Observa todos os registos que já estavam enfileirados quando a
    // consulta começou. O evento terminal inicia record antes de emitir;
    // assim uma consulta disparada pelo próprio evento só lê após o append.
    const pendingRecords = this.chain;
    await pendingRecords;
    const entries = await this.readEntries();
    return buildScanHistoryPage(entries, limit, cursor);
  }

  /** Leitura resiliente: linha corrompida ou inválida é ignorada, não fatal. */
  private async readEntries(): Promise<ScanHistoryEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch {
      return []; // ficheiro ausente = histórico vazio (primeira análise)
    }
    const entries: ScanHistoryEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isScanHistoryEntry(parsed)) entries.push(parsed);
      } catch {
        continue; // linha corrompida: o histórico continua útil
      }
    }
    return entries;
  }

  /**
   * Retenção: ficheiro temporário + `rename`. O original nunca é
   * reescrito in-place (uma falha a meio não o deixava truncado).
   */
  private async compact(entries: ScanHistoryEntry[]): Promise<void> {
    const retained = entries.slice(-this.max);
    const body = retained.map((entry) => JSON.stringify(entry)).join("\n");
    await fs.writeFile(`${this.filePath}.tmp`, body === "" ? "" : `${body}\n`, "utf8");
    await fs.rename(`${this.filePath}.tmp`, this.filePath);
  }
}
