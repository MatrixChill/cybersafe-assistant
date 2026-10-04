import { Activity, AlertTriangle, Clock, Globe, Shield, Terminal, Lock, FileSearch, Download, Info } from "lucide-react";
import type {
  ConnectionSnapshot,
  ProcessSnapshot,
  ProtectionState,
  QuarantineEntry,
  SecurityEvent,
  EngineSubsystemStatus,
} from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";
import { engineStatusText } from "@/lib/protectionHealth";

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
  "engine.health": { label: "Definições atualizadas", icon: Download, tone: "ok" },
};

function describeEvent(event: SecurityEvent): string {
  // Usa o resumo original quando existir; caso contrário gera um texto simples.
  if (event.summary) return event.summary;
  return event.type.replace(/[._]/g, " ");
}

export default function MonitorPage({ events, processes, connections, protection, quarantine }: MonitorPageProps) {
  const latestEvents = [...events].sort((a, b) => b.sequence - a.sequence).slice(0, 50);

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">
            Monitor de <span className="text-primary">Proteção</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Telemetria em tempo real do serviço e do barramento de eventos
          </p>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 bg-secondary rounded-lg">
          <Clock className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-mono text-muted-foreground">Estado:</span>
          <span className="text-sm font-mono text-foreground font-bold">
            {protection?.status
              ? engineStatusText(protection.status as EngineSubsystemStatus)
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
                <span className="animate-pulse italic">Sem telemetria do service</span>
              </div>
            ) : (
              latestEvents.map((event) => {
                const meta = EVENT_LABELS[event.type] ?? {
                  label: event.type.replace(/[._]/g, " "),
                  icon: Info,
                  tone: "info" as const,
                };
                const Icon = meta.icon;
                return (
                  <div key={event.id} className="flex items-center gap-2.5 hover:bg-white/5 px-2 py-1.5 rounded transition-colors group">
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
              })
            )}
          </div>
        </div>
      </div>

      <div className="cyber-border rounded-xl p-6">
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
