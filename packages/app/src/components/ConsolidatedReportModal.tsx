import { useState, useMemo, useEffect, useRef } from "react";
import { FileText, CheckSquare, Square, Eye, AlertTriangle, X, Lock } from "lucide-react";
import type { ScanHistoryEntry, ScanHistoryStatus, ScanType } from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";
import { generateConsolidatedPdfHtml } from "./consolidatedPdfTemplate";
import {
  buildConsolidatedScanReport,
  filterHistoryEntries,
  type ConsolidatedScanReport,
} from "@/lib/consolidatedScanReport";

interface ConsolidatedReportModalProps {
  entries: readonly ScanHistoryEntry[];
  isOpen: boolean;
  onClose: () => void;
}

export function ConsolidatedReportModal({
  entries,
  isOpen,
  onClose,
}: ConsolidatedReportModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input, select, [tabindex="0"]') ?? [])];
    focusable()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key === "Tab") {
        const nodes=focusable(), first=nodes[0], last=nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    dialog?.addEventListener("keydown", key);
    return () => { dialog?.removeEventListener("keydown", key); previous?.focus(); };
  }, [isOpen, onClose]);
  // Filtros
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [statusFilter, setStatusFilter] = useState<ScanHistoryStatus | "all">("all");
  const [typeFilter, setTypeFilter] = useState<ScanType | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [hidePersonal, setHidePersonal] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);

  // Lista filtrada
  const filteredEntries = useMemo(() => {
    return filterHistoryEntries(entries, { startDate: startDate ? new Date(`${startDate}T00:00:00`).toISOString() : undefined, endDate: endDate ? new Date(`${endDate}T23:59:59.999`).toISOString() : undefined }).filter((e) => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (typeFilter !== "all" && e.type !== typeFilter) return false;
      if (searchQuery.trim() !== "") {
        const q = searchQuery.toLowerCase();
        const matchId = e.id.toLowerCase().includes(q);
        const matchType = e.type.toLowerCase().includes(q);
        if (!matchId && !matchType) return false;
      }
      return true;
    });
  }, [entries, statusFilter, typeFilter, searchQuery, startDate, endDate]);

  // Ações de seleção
  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAllFiltered = () => {
    setSelectedIds(new Set(filteredEntries.map((e) => e.id)));
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  // Entradas selecionadas
  const selectedEntries = useMemo(() => {
    return entries.filter((e) => selectedIds.has(e.id));
  }, [entries, selectedIds]);

  // Relatório gerado
  const report: ConsolidatedScanReport | null = useMemo(() => {
    if (selectedEntries.length === 0) return null;
    return buildConsolidatedScanReport(selectedEntries, {
      hidePersonalData: hidePersonal,
    });
  }, [selectedEntries, hidePersonal]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div
        ref={dialogRef}
        role="dialog"
        aria-labelledby="consolidated-report-title"
        aria-modal="true"
        className="cyber-border relative flex flex-col w-full max-w-4xl max-h-[90vh] bg-background rounded-xl overflow-hidden shadow-2xl border"
      >
        {/* Cabeçalho */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-sidebar/40">
          <div className="flex items-center gap-2.5">
            <FileText className="w-5 h-5 text-primary" />
            <div>
              <h2 id="consolidated-report-title" className="font-mono text-base font-bold text-foreground">
                Relatório Consolidado de Análises
              </h2>
              <p className="text-xs text-muted-foreground">
                Selecione as análises históricas para agregar indicadores e resultados consolidados
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Barra de Filtros & Ações de Seleção */}
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-border bg-card/30 text-xs font-mono">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-muted-foreground">
              <span>Estado:</span>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as ScanHistoryStatus | "all")}
                className="bg-secondary/60 border border-border rounded px-2 py-1 text-foreground"
              >
                <option value="all">Todos</option>
                <option value="completed">Concluída</option>
                <option value="cancelled">Cancelada</option>
                <option value="failed">Falhou</option>
              </select>
            </label>

            <label className="flex items-center gap-1.5 text-muted-foreground">
              <span>Tipo:</span>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as ScanType | "all")}
                className="bg-secondary/60 border border-border rounded px-2 py-1 text-foreground"
              >
                <option value="all">Todos</option>
                <option value="quick">Rápida</option>
                <option value="full">Profunda</option>
                <option value="custom">Personalizada</option>
              </select>
            </label>

            <label>Desde <input aria-label="Data inicial" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="bg-background text-foreground" /></label>
            <label>Até <input aria-label="Data final" type="date" value={endDate} min={startDate || undefined} onChange={e => setEndDate(e.target.value)} className="bg-background text-foreground" /></label>
            <input
              type="text"
              aria-label="Pesquisar análises por ID"
              placeholder="Pesquisar por ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-secondary/60 border border-border rounded px-2.5 py-1 text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSelectAllFiltered}
              className="px-2.5 py-1 rounded border border-border text-foreground hover:bg-secondary transition-colors"
            >
              Selecionar filtradas ({filteredEntries.length})
            </button>
            <button
              type="button"
              onClick={handleClearSelection}
              disabled={selectedEntries.length === 0}
              className="px-2.5 py-1 rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
            >
              Limpar seleção
            </button>
          </div>
        </div>

        {/* Conteúdo Principal: Tabela de Seleção + Painel de Pré-visualização */}
        <div className="flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-12 divide-y md:divide-y-0 md:divide-x divide-border">
          {/* Lista de Seleção (7 colunas) */}
          <div className="md:col-span-7 flex flex-col h-full overflow-hidden">
            <div className="p-3 bg-sidebar/20 text-xs font-mono text-muted-foreground border-b border-border flex justify-between">
              <span>{filteredEntries.length} análises disponíveis</span>
              <span className="text-primary font-semibold">{selectedEntries.length} selecionadas{selectedEntries.some(e => !filteredEntries.some(f => f.id === e.id)) ? " (inclui seleção fora dos filtros atuais)" : ""}</span>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-border/40">
              {filteredEntries.length === 0 ? (
                <div className="p-6 text-center text-xs text-muted-foreground font-mono">
                  Nenhuma análise corresponde aos filtros atuais.
                </div>
              ) : (
                filteredEntries.map((e) => {
                  const isSelected = selectedIds.has(e.id);
                  return (
                    <div
                      key={e.id}
                      className={cn(
                        "flex items-center gap-3 p-3 text-xs font-mono cursor-pointer transition-colors",
                        isSelected ? "bg-primary/10 hover:bg-primary/15" : "hover:bg-secondary/40"
                      )}
                    >
                      <button
                        type="button"
                        aria-checked={isSelected}
                        role="checkbox"
                        aria-label={`Selecionar análise ${e.id}`}
                        onClick={() => handleToggleSelect(e.id)}
                        className="text-primary"
                      >
                        {isSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4 text-muted-foreground" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-foreground uppercase">{e.type}</span>
                          <span className={cn(
                            "px-1.5 py-0.5 rounded text-[10px] uppercase font-bold",
                            e.status === "completed" ? "bg-cyber-green/10 text-cyber-green" : e.status === "failed" ? "bg-cyber-red/10 text-cyber-red" : "bg-muted text-muted-foreground"
                          )}>
                            {e.status}
                          </span>
                          <span className="text-muted-foreground truncate text-[11px]">{new Date(e.startedAt).toLocaleString()}</span>
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          {e.filesAnalyzed ?? "—"} analisados · {e.threatsFound ?? "—"} ocorrências · {e.filesInconclusive ?? "—"} inconclusivos
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          {e.filesConsidered ?? "—"} considerados · {e.filesExcluded ?? "—"} excluídos · {e.filesFailed ?? "—"} falhados
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Painel de Pré-visualização Consolidada (5 colunas) */}
          <div className="md:col-span-5 flex flex-col h-full overflow-hidden bg-sidebar/10 p-4 font-mono text-xs space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-border">
              <span className="font-semibold text-foreground flex items-center gap-1.5">
                <Eye className="w-4 h-4 text-primary" /> Pré-visualização
              </span>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={hidePersonal}
                  onChange={(e) => setHidePersonal(e.target.checked)}
                  className="rounded text-primary"
                />
                <Lock className="w-3 h-3" />
                Ocultar dados pessoais
              </label>
            </div>

            {report === null ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground p-6">
                <FileText className="w-8 h-8 mb-2 opacity-40" />
                <p>Selecione uma ou mais análises para visualizar o resumo consolidado.</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-3.5 pr-1">
                <div className="p-3 rounded-lg bg-card border border-border space-y-1">
                  <div className="text-muted-foreground text-[10px] uppercase tracking-wider">Resumo Executivo</div>
                  <p className="text-foreground text-[11px] leading-relaxed">{report.summaryText}</p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="p-2.5 rounded bg-card border border-border">
                    <div className="text-muted-foreground text-[10px]">Análises Concluídas</div>
                    <div className="text-base font-bold text-foreground">{report.stats.completedScans}</div>
                  </div>
                  <div className="p-2.5 rounded bg-card border border-border">
                    <div className="text-muted-foreground text-[10px]">Análises Parciais</div>
                    <div className={cn("text-base font-bold", report.stats.partialScans > 0 ? "text-cyber-yellow" : "text-foreground")}>
                      {report.stats.partialScans}
                    </div>
                  </div>
                  <div className="p-2.5 rounded bg-card border border-border">
                    <div className="text-muted-foreground text-[10px]">Ficheiros Analisados</div>
                    <div className="text-base font-bold text-foreground">{report.stats.totalFilesAnalyzed ?? "—"}</div>
                  </div>
                  <div className="p-2.5 rounded bg-card border border-border">
                    <div className="text-muted-foreground text-[10px]">Ocorrências de deteção</div>
                    <div className={cn("text-base font-bold", (report.stats.totalThreatsFound ?? 0) > 0 ? "text-cyber-red" : "text-cyber-green")}>
                      {report.stats.totalThreatsFound ?? "—"}
                    </div>
                  </div>
                </div>

                {report.limitations.length > 0 && (
                  <div className="p-2.5 rounded bg-cyber-yellow/10 border border-cyber-yellow/30 text-cyber-yellow space-y-1">
                    <div className="flex items-center gap-1 font-semibold text-[11px]">
                      <AlertTriangle className="w-3.5 h-3.5" /> Limitações de Motores
                    </div>
                    <p className="text-[10px] leading-tight text-muted-foreground">
                      {report.limitations.join(", ")}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Rodapé do Modal */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-border bg-sidebar/40 text-xs font-mono">
          <span className="text-muted-foreground">
            {selectedEntries.length === 0
              ? "Nenhuma análise selecionada."
              : `${selectedEntries.length} ${selectedEntries.length === 1 ? "análise pronta" : "análises prontas"} para compilar.`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-border text-foreground hover:bg-secondary transition-colors"
            >
              Fechar
            </button>
            {exportFeedback && (
              <span className="text-xs text-primary mr-2">{exportFeedback}</span>
            )}
            <button
              type="button"
              disabled={selectedEntries.length === 0 || isExporting}
              onClick={async () => {
                if (!report || selectedEntries.length === 0 || isExporting) return;
                setIsExporting(true);
                setExportFeedback(null);
                try {
                  const html = generateConsolidatedPdfHtml(report);
                  const suggested = `cybersafe-relatorio-consolidado-${new Date().toISOString().slice(0, 10)}.pdf`;
                  const api = window.electronAPI;
                  if (api?.exportReportPdf) {
                    const res = await api.exportReportPdf(html, suggested);
                    if (res?.success) {
                      setExportFeedback("PDF exportado com sucesso.");
                    } else if (res?.canceled) {
                      setExportFeedback("Exportação cancelada.");
                    } else {
                      setExportFeedback(res?.error || "Falha ao exportar PDF.");
                    }
                  } else {
                    setExportFeedback("Interface nativa de PDF não disponível. Nada foi guardado.");
                  }
                } catch {
                  setExportFeedback("Erro inesperado ao gerar PDF.");
                } finally {
                  setIsExporting(false);
                }
              }}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
            >
              {isExporting ? "A gerar PDF..." : "Exportar Relatório Consolidado em PDF"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
