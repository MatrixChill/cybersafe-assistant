import { Activity, Clock, Globe, Shield, Terminal } from "lucide-react";
import type {
  ConnectionSnapshot,
  ProcessSnapshot,
  ProtectionState,
  QuarantineEntry,
  SecurityEvent,
} from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";

interface MonitorPageProps {
  events: SecurityEvent[];
  processes: ProcessSnapshot[];
  connections: ConnectionSnapshot[];
  protection: ProtectionState | null;
  quarantine: QuarantineEntry[];
}

export default function MonitorPage({ events, processes, connections, protection, quarantine }: MonitorPageProps) {
  const latestEvents = [...events].sort((a, b) => b.sequence - a.sequence).slice(0, 50);

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">
            Protection <span className="text-primary">Monitor</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Telemetria em tempo real do service e do event bus
          </p>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 bg-secondary rounded-lg">
          <Clock className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-mono text-muted-foreground">Estado:</span>
          <span className="text-sm font-mono text-foreground font-bold">{protection?.status ?? "degraded"}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <MetricCard label="Eventos" value={events.length} />
        <MetricCard label="Processos" value={processes.length} />
        <MetricCard label="Conexoes" value={connections.length} />
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
          <div className="flex-1 overflow-y-auto p-4 space-y-1 scrollbar-hide">
            {latestEvents.length === 0 ? (
              <div className="h-full flex items-center justify-center opacity-20">
                <span className="animate-pulse italic">Sem telemetria do service</span>
              </div>
            ) : (
              latestEvents.map((event) => (
                <div key={event.id} className="flex gap-3 hover:bg-white/5 px-2 py-0.5 rounded transition-colors group">
                  <span className="text-muted-foreground shrink-0">[{new Date(event.timestamp).toLocaleTimeString()}]</span>
                  <span className="text-primary font-bold shrink-0">[{event.type.toUpperCase()}]</span>
                  <span className={cn(
                    "shrink-0 w-16",
                    event.severity === "critical" ? "text-cyber-red" : event.severity === "high" ? "text-cyber-yellow" : "text-cyber-cyan",
                  )}>
                    {event.severity.toUpperCase()}
                  </span>
                  <span className="text-foreground truncate grow">{event.summary}</span>
                </div>
              ))
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
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">Memoria</th>
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">Trust</th>
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
            Network Containment Layer
          </h3>
          <span className="text-xs font-mono text-muted-foreground">Basic containment only</span>
        </div>

        <div className="space-y-2">
          {connections.length === 0 ? (
            <div className="text-sm text-muted-foreground">Sem conexoes observadas.</div>
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
