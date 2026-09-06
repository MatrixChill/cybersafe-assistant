import { useState, useMemo } from "react";
import { FileBarChart, Download, Filter, Calendar, AlertTriangle, Shield, Activity, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SecurityEvent, ThreatEvent, QuarantineEntry } from "@cybersafe/shared-types";

interface ReportsPageProps {
  events: SecurityEvent[];
  threats: ThreatEvent[];
  quarantine: QuarantineEntry[];
}

type SeverityFilter = "all" | "low" | "medium" | "high" | "critical";

const severityLabel: Record<string, string> = {
  all: "Todas",
  critical: "Crítica",
  high: "Alta",
  medium: "Média",
  low: "Baixa",
};

export default function ReportsPage({ events, threats, quarantine }: ReportsPageProps) {
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [showExportToast, setShowExportToast] = useState(false);

  const filteredThreats = useMemo(() => {
    if (severityFilter === "all") return threats;
    return threats.filter(t => t.severity === severityFilter);
  }, [threats, severityFilter]);

  const stats = useMemo(() => ({
    totalEvents: events.length,
    totalThreats: threats.length,
    highCritical: threats.filter(t => t.severity === "high" || t.severity === "critical").length,
    quarantined: quarantine.length,
    sources: [...new Set(threats.map(t => t.source))],
  }), [events, threats, quarantine]);

  const severityColor = (s: string) => {
    switch (s) {
      case "critical": return "text-cyber-red bg-cyber-red/10 border-cyber-red/30";
      case "high": return "text-cyber-red bg-cyber-red/10 border-cyber-red/20";
      case "medium": return "text-cyber-yellow bg-cyber-yellow/10 border-cyber-yellow/20";
      case "low": return "text-cyber-green bg-cyber-green/10 border-cyber-green/20";
      default: return "text-muted-foreground bg-white/5 border-white/10";
    }
  };

  return (
    <div className="p-8 h-full flex flex-col space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">
            Relatórios <span className="text-primary">&amp; Análise</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Resumo consolidado de segurança e histórico de eventos
          </p>
        </div>
        <button
          onClick={() => {
            setShowExportToast(true);
            setTimeout(() => setShowExportToast(false), 3000);
          }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors text-sm font-mono"
        >
          <Download className="w-4 h-4" />
          Exportar PDF
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 shrink-0">
        {[
          { label: "Eventos Totais", value: stats.totalEvents, icon: Activity, color: "text-primary" },
          { label: "Ameaças", value: stats.totalThreats, icon: AlertTriangle, color: stats.totalThreats > 0 ? "text-cyber-yellow" : "text-cyber-green" },
          { label: "Alta + Crítica", value: stats.highCritical, icon: AlertTriangle, color: stats.highCritical > 0 ? "text-cyber-red" : "text-cyber-green" },
          { label: "Em Quarentena", value: stats.quarantined, icon: Shield, color: "text-cyber-cyan" },
          { label: "Fontes Ativas", value: stats.sources.length, icon: ArrowUpRight, color: "text-primary" },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-card cyber-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Icon className={cn("w-4 h-4", color)} />
              <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider">{label}</span>
            </div>
            <span className={cn("text-2xl font-bold font-mono", color)}>{value}</span>
          </div>
        ))}
      </div>

      {/* Severity Filter */}
      <div className="flex items-center gap-3 shrink-0">
        <Filter className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground font-mono uppercase">Severidade:</span>
        {(["all", "critical", "high", "medium", "low"] as SeverityFilter[]).map(f => (
          <button
            key={f}
            onClick={() => setSeverityFilter(f)}
            className={cn(
              "px-3 py-1.5 text-xs font-mono rounded border transition-all",
              severityFilter === f
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-secondary/50 text-muted-foreground border-white/5 hover:bg-white/5"
            )}
          >
            {severityLabel[f as SeverityFilter] ?? f.toUpperCase()}
          </button>
        ))}
        <span className="text-xs text-muted-foreground font-mono ml-auto">
          {filteredThreats.length} resultado(s)
        </span>
      </div>

      {/* Threat Table */}
      <div className="cyber-border rounded-xl flex-1 overflow-hidden flex flex-col">
        <div className="grid grid-cols-12 gap-4 items-center p-4 border-b border-border/50 bg-sidebar/50 text-xs font-mono font-semibold text-muted-foreground uppercase tracking-wider shrink-0">
          <div className="col-span-2">Data / Hora</div>
          <div className="col-span-2">Severidade</div>
          <div className="col-span-3">Tipo</div>
          <div className="col-span-4">Resumo</div>
          <div className="col-span-1 text-right">Fonte</div>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-hide">
          {filteredThreats.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground space-y-4">
              <FileBarChart className="w-12 h-12 opacity-20" />
              <p className="font-mono text-sm">Nenhuma ameaça registada com esta severidade</p>
            </div>
          ) : (
            <div className="flex flex-col">
              {filteredThreats.map((threat, idx) => (
                <div
                  key={threat.summary + threat.createdAt + idx}
                  className="grid grid-cols-12 gap-4 items-center p-4 border-b border-white/5 hover:bg-white/[0.02] transition-colors"
                >
                  <div className="col-span-2 text-xs font-mono text-muted-foreground flex items-center gap-2">
                    <Calendar className="w-3 h-3" />
                    {new Date(threat.createdAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
                  </div>
                  <div className="col-span-2">
                    <span className={cn("text-[10px] font-mono uppercase px-2 py-1 rounded border", severityColor(threat.severity))}>
                      {severityLabel[threat.severity] ?? threat.severity}
                    </span>
                  </div>
                  <div className="col-span-3 text-xs font-mono text-foreground truncate">{threat.domain || threat.source}</div>
                  <div className="col-span-4 text-xs font-mono text-muted-foreground truncate" title={threat.summary}>
                    {threat.summary}
                  </div>
                  <div className="col-span-1 text-right text-[10px] font-mono text-muted-foreground uppercase">
                    {threat.source}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Export Toast */}
      {showExportToast && (
        <div className="fixed bottom-6 right-6 z-[110] animate-in slide-in-from-bottom-4">
          <div className="px-4 py-3 rounded-lg bg-card border border-primary/30 shadow-lg text-sm font-mono text-primary flex items-center gap-2">
            <Download className="w-4 h-4" />
            Relatório exportado com sucesso (demo)
          </div>
        </div>
      )}
    </div>
  );
}
