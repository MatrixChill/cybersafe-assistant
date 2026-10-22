import { useState } from "react";
import { Activity, AlertTriangle, Clock, Globe, Shield, Terminal, Lock, FileSearch, Download, Info, ChevronDown, ChevronRight } from "lucide-react";
import type {
  ConnectionSnapshot,
  ProcessSnapshot,
  ProtectionState,
  QuarantineEntry,
  SecurityEvent,
} from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";
import { protectionStatusText } from "@/lib/protectionHealth";
import { buildEventRows, startedGroupLabel } from "@/lib/eventRows";
import { engineHealthPresentation } from "@/lib/engineHealthPresentation";

interface MonitorPageProps {
  events: SecurityEvent[];
  processes: ProcessSnapshot[];
  connections: ConnectionSnapshot[];
  protection: ProtectionState | null;
  quarantine: QuarantineEntry[];
}

// Traduz os tipos de evento para mensagens legíveis por qualquer pessoa.
const EVENT_LABELS: Record<string, { label: string; icon: typeof Info; tone: "danger" | "warning" | "info" | "ok" }> = {
  "threat.detected": { label: "Ameaça detetada", icon: AlertTriangle, tone: "danger" },
  "process.blocked": { label: "Processo bloqueado", icon: Lock, tone: "danger" },
  "process.killed": { label: "Processo encerrado", icon: Lock, tone: "danger" },
  // WS-2B: sinal heuristico de command line — NAO e ameaca confirmada, e um
  // sinal a rever. Sem kill automatico. Tone de atencao, nao info.
  "process.suspicious": { label: "Sinal a rever", icon: AlertTriangle, tone: "warning" },
  "process.started": { label: "Processo iniciado", icon: Activity, tone: "info" },
  "persistence.detected": { label: "Persistência suspeita", icon: AlertTriangle, tone: "warning" },
  "artifact.analyzed": { label: "Ficheiro analisado", icon: FileSearch, tone: "info" },
  "quarantine.added": { label: "Colocado em quarentena", icon: Shield, tone: "warning" },
  "quarantine.restored": { label: "Recuperado da quarentena", icon: Shield, tone: "ok" },
  "file.created": { label: "Novo ficheiro", icon: FileSearch, tone: "info" },
  "file.modified": { label: "Ficheiro modificado", icon: FileSearch, tone: "info" },
  "scan.progress": { label: "Análise em curso", icon: FileSearch, tone: "info" },
  "trust.updated": { label: "Confiança atualizada", icon: Shield, tone: "ok" },
  "engine.health": { label: "Estado do motor", icon: Download, tone: "warning" },
};

function describeEvent(event: SecurityEvent): string {
  if (event.type === "engine.health") return engineHealthPresentation(event).description;
  if (event.summary) return event.summary;
  return event.type.replace(/[._]/g, " ");
}

function EventLine({ event }: { event: SecurityEvent }) {
  const meta = event.type === "engine.health"
    ? { ...engineHealthPresentation(event), icon: Info }
    : EVENT_LABELS[event.type] ?? {
    label: event.type.replace(/[._]/g, " "),
    icon: Info,
    tone: "info" as const,
  };
  const Icon = meta.icon;
  return (
    <div className="flex items-center gap-2.5 hover:bg-secondary/50 px-2 py-1.5 rounded transition-colors group">
      <Icon className={cn(
        "w-3.5 h-3.5 shrink-0",
        meta.tone === "danger" ? "text-cyber-red"
          : meta.tone === "warning" ? "text-cyber-yellow"
          : meta.tone === "ok" ? "text-cyber-green"
          : "text-cyber-cyan",
      )} />
      <span className="text-muted-foreground shrink-0">{new Date(event.timestamp).toLocaleTimeString()}</span>
      <span className={cn(
        "shrink-0 px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase",
        meta.tone === "danger" ? "border-cyber-red/40 text-cyber-red"
          : meta.tone === "warning" ? "border-cyber-yellow/40 text-cyber-yellow"
          : meta.tone === "ok" ? "border-cyber-green/40 text-cyber-green"
          : "border-cyber-cyan/40 text-cyber-cyan",
      )}>
        {meta.label}
      </span>
      <span className="text-foreground truncate grow">{describeEvent(event)}</span>
    </div>
  );
}

export default function MonitorPage({ events, processes, connections, protection, quarantine }: MonitorPageProps) {
  const latestEvents = [...events].sort((a, b) => b.sequence - a.sequence).slice(0, 50);
  // Agregacao puramente apresentativa dos `process.started` do mesmo nome:
  // a lista cru (50) mantem-se, nenhum evento sai do store nem e filtrado.
  const rows = buildEventRows(latestEvents);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">
            Eventos de Segurança
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Telemetria e atividade de proteção em tempo real
          </p>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 bg-secondary rounded-lg">
          <Clock className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-mono text-muted-foreground">Estado:</span>
          <span className="text-sm font-mono text-foreground font-bold">
            {protection?.status
              ? protectionStatusText(protection.status)
              : "Sem dados do serviço"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <MetricCard label="Eventos" value={events.length} />
        <MetricCard label="Processos" value={processes.length} />
        <MetricCard label="Conexões" value={connections.length} />
        <MetricCard label="Quarentena" value={quarantine.length} />
      </div>

      <div className="cyber-border rounded-xl relative overflow-hidden flex flex-col min-h-[320px]">
        <div className="flex items-center justify-between py-3 px-4 border-b border-border/50 bg-sidebar/30">
          <div className="text-xs font-mono flex items-center gap-2 font-semibold text-foreground">
            <Terminal className="w-4 h-4 text-primary" />
            security_event_bus.log
          </div>
        </div>
        <div className="p-0 flex-1 flex flex-col bg-black/40 font-mono text-[11px] relative">
          <div className="flex-1 overflow-y-auto p-4 space-y-1.5 scrollbar-hide">
            {latestEvents.length === 0 ? (
              <div className="h-full flex items-center justify-center opacity-20">
                <span className="animate-pulse italic">Sem dados de telemetria</span>
              </div>
            ) : (
              rows.map((row) => {
                if (row.kind === "single") {
                  return <EventLine key={row.key} event={row.event} />;
                }
                const expanded = expandedGroups.has(row.key);
                const latest = row.events[0];
                const Chevron = expanded ? ChevronDown : ChevronRight;
                return (
                  <div key={row.key}>
                    <div className="flex items-center gap-2.5 hover:bg-secondary/50 px-2 py-1.5 rounded transition-colors group">
                      <Activity className="w-3.5 h-3.5 shrink-0 text-cyber-cyan" />
                      <span className="text-muted-foreground shrink-0">{new Date(latest.timestamp).toLocaleTimeString()}</span>
                      <span className="shrink-0 px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase border-cyber-cyan/40 text-cyber-cyan">
                        {EVENT_LABELS["process.started"].label}
                      </span>
                      <span className="text-foreground shrink-0">{row.name}</span>
                      <span className="text-muted-foreground grow">{startedGroupLabel(row.events.length)}</span>
                      <button
                        type="button"
                        onClick={() => toggleGroup(row.key)}
                        aria-expanded={expanded}
                        className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded border border-border/60 text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                      >
                        <Chevron className="w-3 h-3" />
                        {expanded ? "ocultar" : "expandir"}
                      </button>
                    </div>
                    {expanded && (
                      <div className="ml-6 pl-2 border-l border-border/40 space-y-1.5 py-1.5">
                        {row.events.map((event) => (
                          <EventLine key={event.id} event={event} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div className="cyber-border rounded-xl p-6">
        {/* Grupos por metadados reais do serviço. */}
        <div className="flex items-center justify-between mb-6">
          <h3 className="font-mono font-semibold text-foreground flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" />
            Processos Ativos
          </h3>
          <span className="text-xs font-mono text-muted-foreground">{processes.length} processos monitorados</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">Processo</th>
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">PID</th>
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">CPU</th>
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">Memória</th>
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">Confiança</th>
              </tr>
            </thead>
            <tbody>
              {processes.slice(0, 20).map((process) => (
                <tr key={process.pid} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
                  <td className="py-3 px-4"><span className="font-mono text-sm text-foreground">{process.name}</span></td>
                  <td className="py-3 px-4"><span className="font-mono text-xs text-muted-foreground">{process.pid}</span></td>
                  <td className="py-3 px-4"><span className="font-mono text-xs text-muted-foreground">{process.cpu.toFixed(1)}%</span></td>
                  <td className="py-3 px-4"><span className="font-mono text-xs text-muted-foreground">{process.memoryMb.toFixed(0)} MB</span></td>
                  <td className="py-3 px-4"><span className="font-mono text-xs uppercase text-primary">{process.trusted}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="cyber-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="font-mono font-semibold text-foreground flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" />
            Camada de Contenção de Rede
          </h3>
          <span className="text-xs font-mono text-muted-foreground">Contenção básica apenas</span>
        </div>

        <div className="space-y-2">
          {connections.length === 0 ? (
            <div className="text-sm text-muted-foreground">Sem conexões observadas.</div>
          ) : (
            connections.slice(0, 20).map((connection, index) => (
              <div key={`${connection.remoteAddress}-${index}`} className="p-3 rounded-lg bg-secondary/30 flex items-center justify-between">
                <div className="text-sm font-mono text-foreground">{connection.remoteAddress}</div>
                <div className="text-xs text-muted-foreground">{connection.protocol ?? "tcp"}:{connection.remotePort ?? "-"}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="cyber-border rounded-xl p-6 relative overflow-hidden group">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="flex items-center justify-between mb-4">
        <Activity className="w-5 h-5 text-primary" />
      </div>
      <div className="text-3xl font-bold font-mono text-foreground mb-1">{value}</div>
      <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{label}</div>
    </div>
  );
}
