import { useState, useMemo } from "react";
import { FileBarChart, Download, Filter, Calendar, AlertTriangle, Shield, Activity, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SecurityEvent, ThreatEvent, QuarantineEntry, ProtectionState, PcState, EngineSubsystemHealth } from "@cybersafe/shared-types";

interface ReportsPageProps {
  events: SecurityEvent[];
  threats: ThreatEvent[];
  quarantine: QuarantineEntry[];
  protection: ProtectionState | null;
  pcState: PcState | null;
}

type SeverityFilter = "all" | "low" | "medium" | "high" | "critical";

const severityLabel: Record<string, string> = {
  all: "Todas",
  critical: "Crítica",
  high: "Alta",
  medium: "Média",
  low: "Baixa",
};

export default function ReportsPage({ events, threats, quarantine, protection, pcState }: ReportsPageProps) {
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

  const exportPdf = () => {
    // Gera um relatório imprimível A4 e abre na janela Electron com ícone CyberSafe.
    const now = new Date();
    const hostname = typeof window !== "undefined" && window.location?.hostname ? window.location.hostname : "";
    const pcName = hostname || "Este computador";
    const rows = filteredThreats.slice(0, 50).map((t) => `
      <tr>
        <td>${new Date(t.createdAt).toLocaleString("pt-BR")}</td>
        <td><span class="sev sev-${t.severity}">${t.severity.toUpperCase()}</span></td>
        <td>${t.domain || t.source}</td>
        <td>${t.source}</td>
        <td>${t.summary}</td>
      </tr>`).join("");

    // Estado geral herdado da resposta real do serviço (protection.status)
    // e do pcState.overall — nunca um score paralelo inventado.
    const realStatus = protection?.status ?? "degraded";
    const pcOverall = pcState?.overall ?? "unknown";
    const systemStatus = (realStatus === "critical" || realStatus === "attention") ? "attention" : "safe";
    const statusLabel = systemStatus === "attention" ? "Precisa de atenção" : "Protegido";
    const statusBadge = systemStatus === "attention" ? "amber" : "green";
    // Score real vindo do backend (protection.stats.riskScore), sem fórmula paralela.
    const protectionScore = protection?.stats?.riskScore ?? 0;

    // Motores — estado real derivado de protection.engine (quando disponível).
    const engineEntries: { name: string; status: string; detail: string }[] = [];
    const engine = protection?.engine;
    if (engine) {
      const subsystems: Array<[string, EngineSubsystemHealth | undefined]> = [
        ["YARA", engine.yara],
        ["Hash DB", engine.hashDb],
        ["ClamAV", engine.clamav],
        ["Native Engine", engine.nativeEngine],
        ["Firewall", engine.firewall],
      ];
      for (const [name, sub] of subsystems) {
        if (!sub) continue;
        engineEntries.push({
          name,
          status: sub.status,
          detail: sub.detail ?? (sub.status === "active" ? "Ativo" : "Indisponível"),
        });
      }
    }
    const engineRows = engineEntries.map((e) => `
      <tr>
        <td>${e.name}</td>
        <td><span class="sev sev-${e.status === "active" ? "green" : "gray"}">${e.status.toUpperCase()}</span></td>
        <td>${e.detail}</td>
      </tr>`).join("");

    const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>Relatório de Segurança — CyberSafe</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #16242a; margin: 0 auto; max-width: 820px; }
  .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding-bottom: 16px; border-bottom: 2px solid #0ea5b7; margin-bottom: 20px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand .logo { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #0d9488, #0ea5b7); display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 16px; }
  .brand h1 { font-size: 22px; margin: 0; color: #0a3346; }
  .brand .sub { font-size: 12px; color: #5a7a85; margin: 2px 0 0; }
  .meta { text-align: right; font-size: 11px; color: #5a7a85; line-height: 1.65; font-family: 'Segoe UI Mono', Consolas, monospace; }
  .meta b { color: #0a3346; }
  h2 { font-size: 13px; font-weight: 700; color: #0a3346; text-transform: uppercase; letter-spacing: .05em; margin: 22px 0 10px; }
  h2 .accent { color: #0ea5b7; }
  .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 8px; }
  .summary .status { grid-column: span 1; }
  .card { border: 1px solid #d8e4e8; border-radius: 10px; padding: 12px 14px; background: #fbfdfd; }
  .card .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #7a949e; margin-bottom: 4px; }
  .card .big { font-size: 22px; font-weight: 700; }
  .card .big.green { color: #138a4b; }
  .card .big.amber { color: #b45309; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .badge-green { background: #e4f6ec; color: #138a4b; border: 1px solid #b7e6cb; }
  .badge-amber { background: #fdf1e2; color: #b45309; border: 1px solid #f0d5a8; }
  .badge-red { background: #fdeaea; color: #c0392b; border: 1px solid #f2b8b0; }
  .badge-cyan { background: #e3f5f7; color: #0e6b78; border: 1px solid #b7e2e8; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .mini { display: flex; justify-content: space-between; align-items: baseline; padding: 8px 2px; border-bottom: 1px solid #edf3f5; font-size: 12px; }
  .mini:last-child { border-bottom: none; }
  .mini .k { color: #4a6670; }
  .mini .v { font-weight: 600; color: #16242a; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { text-align: left; padding: 7px 8px; background: #0ea5b7; color: #fff; font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; }
  td { padding: 7px 8px; border-bottom: 1px solid #e4eef1; }
  tr:nth-child(even) td { background: #f7fbfb; }
  .sev { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 9.5px; font-weight: 700; }
  .sev-critical, .sev-high { background: #fdeaea; color: #c0392b; }
  .sev-medium { background: #fdf1e2; color: #b45309; }
  .sev-low { background: #e4f6ec; color: #138a4b; }
  .sev-green { background: #e4f6ec; color: #138a4b; }
  .sev-gray { background: #eef2f4; color: #68777d; }
  .nothreat { padding: 14px; border: 1px dashed #b7e6cb; border-radius: 8px; background: #f3fbf6; color: #138a4b; font-weight: 600; font-size: 12px; text-align: center; }
  .footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #e4eef1; font-size: 9.5px; color: #8aa2ab; line-height: 1.6; }
  .footer p { margin: 2px 0; }
  .section-break { break-inside: avoid; }
  @media print { body { max-width: none; } }
</style>
</head>
<body>
  <div class="header">
    <div class="brand">
      <div class="logo">CS</div>
      <div>
        <h1>CyberSafe — Relatório de Segurança</h1>
        <div class="sub">Resumo consolidado do estado de proteção do sistema</div>
      </div>
    </div>
    <div class="meta">
      <b>Data/hora:</b> ${now.toLocaleString("pt-BR")}<br/>
      <b>Computador:</b> ${pcName}<br/>
      <b>Estado do PC:</b> ${pcOverall}<br/>
      <b>Versão CyberSafe:</b> 0.1.1
    </div>
  </div>

  <h2>Resumo principal</h2>
  <div class="summary">
    <div class="card status">
      <div class="lbl">Estado geral do PC</div>
      <div style="margin-bottom:4px"><span class="badge badge-${statusBadge}">${statusLabel}</span></div>
      <div class="lbl" style="margin-top:6px">Proteção</div>
      <div class="big ${statusBadge}">${protectionScore}/100</div>
      <div class="lbl">${stats.highCritical > 0 ? "Degradada" : "Ativa"}</div>
    </div>
    <div class="card">
      <div class="lbl">Ameaças detetadas</div>
      <div class="big ${stats.totalThreats > 0 ? "amber" : "green"}">${stats.totalThreats}</div>
      <div class="lbl" style="margin-top:6px">Alta + Crítica</div>
      <div class="lbl">${stats.highCritical}</div>
    </div>
    <div class="card">
      <div class="lbl">Eventos analisados</div>
      <div class="big">${stats.totalEvents}</div>
      <div class="lbl" style="margin-top:6px">Em quarentena</div>
      <div class="lbl">${stats.quarantined}</div>
    </div>
  </div>

  <div class="grid2 section-break">
    <div>
      <h2>Motores de análise</h2>
      <table>
        <thead><tr><th>Motor</th><th>Estado</th><th>Detalhe</th></tr></thead>
        <tbody>${engineRows}</tbody>
      </table>
    </div>
    <div>
      <h2>Categorias</h2>
      <div class="card" style="padding:6px 14px">
        <div class="mini"><span class="k">Segurança</span><span class="v">${stats.highCritical > 0 ? '<span class="sev sev-high">Atenção</span>' : '<span class="sev sev-green">Ok</span>'}</span></div>
        <div class="mini"><span class="k">Desempenho</span><span class="v sev sev-green">Ok</span></div>
        <div class="mini"><span class="k">Sistema</span><span class="v">Estável</span></div>
        <div class="mini"><span class="k">Privacidade</span><span class="v">Protegido</span></div>
      </div>

      <h2>Findings principais</h2>
      <div class="card" style="padding:6px 14px">
        ${stats.highCritical > 0 ? `
        <div class="mini"><span class="k"><span class="sev sev-high">Urgente</span></span><span class="v">Ameaças de alta/crítica detetadas</span></div>` : `<div class="mini"><span class="k"><span class="sev sev-green">Recomendado</span></span><span class="v">Sem ameaças pendentes</span></div>`}
        ${stats.totalThreats > 0 ? `<div class="mini"><span class="k"><span class="sev sev-medium">Atenção</span></span><span class="v">${stats.totalThreats} ameaça(s) registada(s)</span></div>` : ""}
      </div>
    </div>
  </div>

  <h2>Ameaças detetadas</h2>
  ${stats.totalThreats > 0 ? `
  <table class="section-break">
    <thead><tr><th>Data/Hora</th><th>Severidade</th><th>Tipo</th><th>Fonte</th><th>Resumo</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : `<div class="nothreat">Nenhuma ameaça registada no período analisado.</div>`}

  <div class="footer">
    <p>Este relatório resume o estado observado pelo CyberSafe e não constitui auditoria formal.</p>
    <p>Ausência de ameaças detetadas não significa garantia absoluta de segurança.</p>
    <p>Documento gerado pela aplicação CyberSafe Assistant em ${now.toLocaleString("pt-BR")}.</p>
  </div>
</body>
</html>`;

    if (window.electronAPI?.openReportWindow) {
      window.electronAPI.openReportWindow(html);
    } else {
      const win = window.open("", "_blank", "width=860,height=640");
      if (!win) return;
      win.document.write(html);
      win.document.close();
      win.focus();
      setTimeout(() => { try { win.print(); } catch { } }, 400);
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
            exportPdf();
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
            Relatório aberto — guarda como PDF no diálogo impressão
          </div>
        </div>
      )}
    </div>
  );
}
