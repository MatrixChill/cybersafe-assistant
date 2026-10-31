/**
 * consolidatedScanReport.ts
 *
 * Modelo de dados para agregação e consolidação de análises históricas (AG-18).
 *
 * Regras cruciais de integridade e privacidade:
 * 1. Não soma análises às cegas: distingue ficheiros considerados de ficheiros analisados.
 * 2. Ausência de dados não é transformada em zero.
 * 3. Análise parcial ou cancelada NÃO é convertida em limpa.
 * 4. Privacidade: suporte a sanitização / anonimização de caminhos e metadados pessoais.
 * 5. Reutilização de ScanHistoryEntry e funções existentes de scanHistoryReport.ts.
 */
import type { ScanHistoryEntry, ScanHistoryStatus, ScanType } from "@cybersafe/shared-types";
import { formatDuration, describeScanHistoryOutcome } from "./scanHistoryReport.js";

export interface ConsolidatedReportFilter {
  startDate?: string | null;
  endDate?: string | null;
  status?: ScanHistoryStatus | "all";
  type?: ScanType | "all";
  hidePersonalData?: boolean;
}

export interface ConsolidatedScanStats {
  totalScans: number;
  completedScans: number;
  cancelledScans: number;
  failedScans: number;
  partialScans: number;
  cleanCompletedScans: number;
  scansWithThreats: number;

  totalFilesConsidered: number | null;
  totalFilesAnalyzed: number | null;
  totalFilesExcluded: number | null;
  totalFilesFailed: number | null;
  totalFilesInconclusive: number | null;
  totalThreatsFound: number | null;
  totalDurationMs: number;
}

export interface ConsolidatedScanReport {
  generatedAt: string;
  filterApplied: ConsolidatedReportFilter;
  stats: ConsolidatedScanStats;
  entries: SanitizedHistoryEntry[];
  summaryText: string;
  limitations: string[];
}

export interface SanitizedHistoryEntry {
  id: string;
  type: ScanType;
  target: "default" | "custom";
  status: ScanHistoryStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  durationFormatted: string;
  filesConsidered: number | null;
  filesAnalyzed: number | null;
  filesExcluded: number | null;
  filesFailed: number | null;
  filesInconclusive: number | null;
  threatsFound: number | null;
  isPartial: boolean;
  outcomeLabel: string | null;
  engineLimitations: string[];
}

const counter = (n: unknown): number | null => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
const sumKnown = (a: number | null, b: number | null) => a === null || b === null ? null : a + b;

/** Sanitiza uma entrada individual do histórico respeitando a política de privacidade */
export function sanitizeHistoryEntry(
  entry: ScanHistoryEntry,
  hidePersonalData = false
): SanitizedHistoryEntry {
  const outcome = describeScanHistoryOutcome(entry.status, entry.filesInconclusive);
  const inconclusive = typeof entry.filesInconclusive === "number" && Number.isFinite(entry.filesInconclusive)
    ? entry.filesInconclusive
    : null;

  return {
    id: hidePersonalData ? "análise anonimizada" : entry.id,
    type: entry.type,
    target: entry.target,
    status: entry.status,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationMs: entry.durationMs,
    durationFormatted: formatDuration(entry.durationMs),
    filesConsidered: counter(entry.filesConsidered),
    filesAnalyzed: counter(entry.filesAnalyzed),
    filesExcluded: counter(entry.filesExcluded),
    filesFailed: counter(entry.filesFailed),
    filesInconclusive: inconclusive,
    threatsFound: counter(entry.threatsFound),
    isPartial: outcome.partial || (entry.status === "completed" && (inconclusive === null || (counter(entry.filesFailed) ?? 0) > 0 || (entry.engineLimitations?.length ?? 0) > 0)),
    outcomeLabel: outcome.label,
    engineLimitations: entry.engineLimitations ? entry.engineLimitations.map(lim => hidePersonalData ? "Limitação de motor reportada (detalhe ocultado por privacidade)." : lim) : [],
  };
}

/** Filtra entradas por data, status e tipo */
export function filterHistoryEntries(
  entries: readonly ScanHistoryEntry[],
  filter: ConsolidatedReportFilter
): ScanHistoryEntry[] {
  return entries.filter((entry) => {
    if (filter.status && filter.status !== "all" && entry.status !== filter.status) {
      return false;
    }
    if (filter.type && filter.type !== "all" && entry.type !== filter.type) {
      return false;
    }
    if (filter.startDate && (!Number.isFinite(Date.parse(filter.startDate)) || !Number.isFinite(Date.parse(entry.startedAt)))) return false;
    if (filter.endDate && (!Number.isFinite(Date.parse(filter.endDate)) || !Number.isFinite(Date.parse(entry.endedAt || entry.startedAt)))) return false;
    if (filter.startDate) {
      const entryTime = Date.parse(entry.startedAt);
      const startTime = Date.parse(filter.startDate);
      if (Number.isFinite(entryTime) && Number.isFinite(startTime) && entryTime < startTime) {
        return false;
      }
    }
    if (filter.endDate) {
      const entryTime = Date.parse(entry.endedAt || entry.startedAt);
      const endTime = Date.parse(filter.endDate);
      if (Number.isFinite(entryTime) && Number.isFinite(endTime) && entryTime > endTime) {
        return false;
      }
    }
    return true;
  });
}

/** Constrói o modelo de relatório consolidado */
export function buildConsolidatedScanReport(
  entries: readonly ScanHistoryEntry[],
  filter: ConsolidatedReportFilter = {}
): ConsolidatedScanReport {
  const filtered = filterHistoryEntries([...new Map(entries.map(entry => [entry.id, entry])).values()], filter);
  const hidePersonal = filter.hidePersonalData ?? false;
  const sanitizedEntries = filtered.map((e) => sanitizeHistoryEntry(e, hidePersonal));

  const stats: ConsolidatedScanStats = {
    totalScans: sanitizedEntries.length,
    completedScans: 0,
    cancelledScans: 0,
    failedScans: 0,
    partialScans: 0,
    cleanCompletedScans: 0,
    scansWithThreats: 0,
    totalFilesConsidered: 0,
    totalFilesAnalyzed: 0,
    totalFilesExcluded: 0,
    totalFilesFailed: 0,
    totalFilesInconclusive: 0,
    totalThreatsFound: 0,
    totalDurationMs: 0,
  };

  const allLimitations = new Set<string>();

  for (const entry of sanitizedEntries) {
    if (entry.status === "completed") {
      if (!entry.isPartial) stats.completedScans += 1;
      if ((entry.threatsFound ?? 0) > 0) {
        stats.scansWithThreats += 1;
      } else if (entry.threatsFound === 0 && !entry.isPartial) {
        stats.cleanCompletedScans += 1;
      }
    } else if (entry.status === "cancelled") {
      stats.cancelledScans += 1;
    } else if (entry.status === "failed") {
      stats.failedScans += 1;
    }

    if (entry.isPartial) {
      stats.partialScans += 1;
    }

    stats.totalFilesConsidered = sumKnown(stats.totalFilesConsidered, entry.filesConsidered);
    stats.totalFilesAnalyzed = sumKnown(stats.totalFilesAnalyzed, entry.filesAnalyzed);
    stats.totalFilesExcluded = sumKnown(stats.totalFilesExcluded, entry.filesExcluded);
    stats.totalFilesFailed = sumKnown(stats.totalFilesFailed, entry.filesFailed);
    stats.totalFilesInconclusive = sumKnown(stats.totalFilesInconclusive, entry.filesInconclusive);
    stats.totalThreatsFound = sumKnown(stats.totalThreatsFound, entry.threatsFound);
    stats.totalDurationMs += entry.durationMs;

    for (const lim of entry.engineLimitations) {
      allLimitations.add(lim);
    }
  }

  // Gera o resumo factual em português
  let summaryText = "";
  if (stats.totalScans === 0) {
    summaryText = "Nenhuma análise histórica selecionada ou correspondente aos filtros definidos.";
  } else {
    const scanWord = stats.totalScans === 1 ? "análise" : "análises";
    const threatWord = stats.totalThreatsFound === 1 ? "ocorrência de deteção" : "ocorrências de deteção (não ameaças únicas)";
    summaryText = `Relatório consolidado de ${stats.totalScans} ${scanWord} (${stats.completedScans} concluídas, ${stats.partialScans} parciais, ${stats.cancelledScans} canceladas, ${stats.failedScans} falhadas). Total de ${stats.totalFilesAnalyzed ?? "desconhecido"} de ${stats.totalFilesConsidered ?? "desconhecido"} ficheiros analisados pelos motores, com ${stats.totalThreatsFound ?? "total desconhecido de"} ${threatWord}.`;
  }

  return {
    generatedAt: new Date().toISOString(),
    filterApplied: { startDate: filter.startDate, endDate: filter.endDate, status: filter.status, type: filter.type, hidePersonalData: hidePersonal },
    stats,
    entries: sanitizedEntries,
    summaryText,
    limitations: Array.from(allLimitations),
  };
}
