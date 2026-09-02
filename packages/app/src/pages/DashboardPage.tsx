import { Shield, AlertTriangle, Download, Activity, CheckCircle2, Clock, Cpu, HardDrive, Wifi, Search, Play, FolderSearch } from "lucide-react";
import { useEffect, useState } from "react";
import type { DashboardSummary, HardwareSnapshot } from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";

interface DashboardPageProps {
  dashboard: DashboardSummary;
  isLoading: boolean;
  hardware?: HardwareSnapshot | null;
}

export default function DashboardPage({ dashboard, isLoading, hardware }: DashboardPageProps) {
  const isAtRisk = dashboard.riskScore <= 60;
  const [displayScore, setDisplayScore] = useState(0);

  useEffect(() => {
    const target = dashboard.riskScore;
    const step = Math.ceil(Math.max(target, 1) / 20);
    const interval = setInterval(() => {
      setDisplayScore((prev) => {
        if (prev >= target) {
          clearInterval(interval);
          return target;
        }
        return Math.min(prev + step, target);
      });
    }, 50);
    return () => clearInterval(interval);
  }, [dashboard.riskScore]);

  if (isLoading) {
    return (
      <div className="p-8 h-full flex flex-col items-center justify-center font-mono text-primary animate-pulse space-y-4">
        <Shield className="w-12 h-12" />
        <span className="tracking-[0.3em]">SYNCING_PROTECTION_STATE...</span>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">
            System <span className="text-primary">Status</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Telemetria real do service de protecao
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-full border",
            dashboard.systemStatus === "safe" ? "bg-cyber-green/10 border-cyber-green/30"
              : dashboard.systemStatus === "attention" ? "bg-cyber-yellow/10 border-cyber-yellow/30"
                : "bg-cyber-red/10 border-cyber-red/30",
          )}>
            <div className={cn(
              "w-2 h-2 rounded-full cyber-pulse",
              dashboard.systemStatus === "safe" ? "bg-cyber-green"
                : dashboard.systemStatus === "attention" ? "bg-cyber-yellow"
                  : "bg-cyber-red",
            )} />
            <span className={cn(
              "text-sm font-mono uppercase tracking-wider",
              dashboard.systemStatus === "safe" ? "text-cyber-green"
                : dashboard.systemStatus === "attention" ? "text-cyber-yellow"
                  : "text-cyber-red",
            )}>
              {dashboard.systemStatus === "safe" ? "Sistema Protegido"
                : dashboard.systemStatus === "attention" ? "Atencao Necessaria"
                  : "Protecao Degradada"}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-1 cyber-border rounded-xl p-6 relative overflow-hidden group">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-4">
            Protection Score
          </div>
          <div className="flex items-center justify-center">
            <div className="relative w-32 h-32">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="8" className="text-secondary" />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="url(#risk-gradient)"
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={`${(displayScore / 100) * 251.2} 251.2`}
                  className="transition-all duration-500"
                />
                <defs>
                  <linearGradient id="risk-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor={isAtRisk ? "var(--cyber-red)" : "oklch(0.7 0.2 145)"} />
                    <stop offset="100%" stopColor="var(--primary)" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-4xl font-bold font-mono text-foreground">{displayScore}</span>
                <span className={cn("text-xs font-mono uppercase tracking-wider", isAtRisk ? "text-cyber-red" : "text-cyber-green")}>
                  {isAtRisk ? "At Risk" : "Healthy"}
                </span>
              </div>
            </div>
          </div>
        </div>

        <StatCard label="Eventos" value={dashboard.totalEvents.toString()} description="Eventos de seguranca persistidos" icon={Activity} color="cyan" />
        <StatCard label="Ameacas Severas" value={dashboard.highSeverityEvents.toString()} description="High + Critical" icon={AlertTriangle} color={dashboard.highSeverityEvents > 0 ? "red" : "green"} />
        <StatCard label="Risco de Downloads" value={dashboard.downloadRisk.toUpperCase()} description="Baseado em eventos reais" icon={Download} color={dashboard.downloadRisk === "low" ? "green" : dashboard.downloadRisk === "medium" ? "yellow" : "red"} isText />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <MetricBar label="CPU" subValue={hardware?.cpu.model.split(" ")[0]} value={hardware?.cpu.usage || 0} icon={Cpu} alert={hardware?.alerts.find((a) => a.category === "cpu")?.title} />
        <MetricBar label="Memória" subValue={`${hardware?.ram.usedGb || 0} / ${hardware?.ram.totalGb || 0} GB`} value={hardware?.ram.usagePercent || 0} icon={HardDrive} alert={hardware?.alerts.find((a) => a.category === "ram")?.title} />
        <MetricBar label="Disco" subValue={`${hardware?.disk.usedGb || 0} / ${hardware?.disk.totalGb || 0} GB`} value={hardware?.disk.usagePercent || 0} icon={HardDrive} alert={hardware?.alerts.find((a) => a.category === "disk")?.title} />
        <MetricBar label="Rede" subValue={`${hardware ? (hardware.network.rxSec / 1024 / 1024).toFixed(1) : 0} MB/s`} value={Math.min(100, (hardware?.network.rxSec || 0) / 1024 / 100)} icon={Wifi} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="cyber-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-mono font-semibold text-foreground flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />
              Alertas Recentes
            </h3>
            <span className="text-xs font-mono text-muted-foreground">
              {dashboard.recentThreats[0] ? new Date(dashboard.recentThreats[0].createdAt).toLocaleTimeString() : "sem eventos"}
            </span>
          </div>

          <div className="flex flex-col items-center justify-center py-12 text-center">
            {dashboard.alerts.length === 0 ? (
              <>
                <div className="w-16 h-16 rounded-full bg-cyber-green/10 border border-cyber-green/30 flex items-center justify-center mb-4 relative">
                  <CheckCircle2 className="w-8 h-8 text-cyber-green" />
                  <div className="absolute inset-0 rounded-full border border-cyber-green/50 animate-ping opacity-20" />
                </div>
                <p className="text-muted-foreground text-sm">Nenhum alerta severo no momento.</p>
                <p className="text-cyber-green text-sm font-mono mt-1">Tudo sincronizado</p>
              </>
            ) : (
              <div className="w-full space-y-2">
                {dashboard.alerts.map((alert) => (
                  <div key={alert.id} className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5">
                    <span className="text-xs font-mono text-foreground truncate">{alert.title}</span>
                    <span className="text-[9px] font-mono text-cyber-red uppercase">{alert.severity}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="cyber-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-mono font-semibold text-foreground flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              Ameacas Recentes
            </h3>
            <button className="text-xs font-mono text-primary hover:text-primary/80 transition-colors">Feed real</button>
          </div>

          <div className="space-y-3">
            {dashboard.recentThreats.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center mb-4">
                  <Shield className="w-8 h-8 text-primary" />
                </div>
                <p className="text-muted-foreground text-sm">Nenhuma ameaca detetada ainda.</p>
                <p className="text-primary text-sm font-mono mt-1">Motor em observacao</p>
              </div>
            ) : (
              dashboard.recentThreats.slice(0, 4).map((threat, index) => (
                <div key={`${threat.createdAt}-${index}`} className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5 group hover:border-primary/30 transition-all">
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      "w-2 h-2 rounded-full",
                      threat.severity === "critical" ? "bg-cyber-red shadow-[0_0_8px_var(--cyber-red)]"
                        : threat.severity === "high" ? "bg-cyber-yellow"
                          : "bg-cyber-cyan",
                    )} />
                    <div className="flex flex-col">
                      <span className="text-sm font-mono text-foreground truncate max-w-[150px]">{threat.domain}</span>
                      <span className="text-[10px] text-muted-foreground font-mono">{threat.source}</span>
                    </div>
                  </div>
                  <span className={cn(
                    "text-[10px] font-mono uppercase px-2 py-1 rounded border",
                    threat.severity === "critical" ? "bg-cyber-red/10 text-cyber-red border-cyber-red/30"
                      : threat.severity === "high" ? "bg-cyber-yellow/10 text-cyber-yellow border-cyber-yellow/30"
                        : "bg-cyber-cyan/10 text-cyber-cyan border-cyber-cyan/30",
                  )}>
                    {threat.severity}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <button
          onClick={async () => {
            if (window.electronAPI) {
              const res = await window.electronAPI.startScan("quick");
              if (res.success) alert("Quick scan iniciado! ID: " + res.id);
            }
          }}
          className="cyber-border rounded-xl p-6 flex flex-col items-center justify-center gap-4 hover:bg-white/5 transition-colors group">
          <div className="w-12 h-12 rounded-full bg-cyber-cyan/10 flex items-center justify-center group-hover:scale-110 transition-transform">
            <Search className="w-6 h-6 text-cyber-cyan" />
          </div>
          <div className="text-center">
            <h3 className="font-mono font-semibold text-foreground">Quick Scan</h3>
            <p className="text-xs text-muted-foreground mt-1">Verifica áreas críticas e memória</p>
          </div>
        </button>

        <button
          onClick={async () => {
            if (window.electronAPI) {
              const res = await window.electronAPI.startScan("full");
              if (res.success) alert("Full scan iniciado! ID: " + res.id);
            }
          }}
          className="cyber-border rounded-xl p-6 flex flex-col items-center justify-center gap-4 hover:bg-white/5 transition-colors group">
          <div className="w-12 h-12 rounded-full bg-cyber-yellow/10 flex items-center justify-center group-hover:scale-110 transition-transform">
            <Play className="w-6 h-6 text-cyber-yellow" />
          </div>
          <div className="text-center">
            <h3 className="font-mono font-semibold text-foreground">Full Scan</h3>
            <p className="text-xs text-muted-foreground mt-1">Verifica todo o sistema (demorado)</p>
          </div>
        </button>

        <button
          onClick={async () => {
            if (window.electronAPI) {
              const path = await window.electronAPI.openFileDialog();
              if (path) {
                const res = await window.electronAPI.startScan("custom", path);
                if (res.success) alert("Custom scan iniciado em " + path);
              }
            }
          }}
          className="cyber-border rounded-xl p-6 flex flex-col items-center justify-center gap-4 hover:bg-white/5 transition-colors group">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center group-hover:scale-110 transition-transform">
            <FolderSearch className="w-6 h-6 text-primary" />
          </div>
          <div className="text-center">
            <h3 className="font-mono font-semibold text-foreground">Custom Scan</h3>
            <p className="text-xs text-muted-foreground mt-1">Escolha uma pasta específica</p>
          </div>
        </button>
      </div>

      <div className="cyber-border rounded-xl p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center">
              <Shield className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h3 className="font-mono font-semibold text-foreground">Protecao Residente</h3>
              <div className="flex items-center gap-2 mt-1">
                <Clock className="w-3 h-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  Definitions: {dashboard.engineHealth?.definitionsUpdatedAt ? new Date(dashboard.engineHealth.definitionsUpdatedAt).toLocaleString() : "desconhecido"}
                </span>
              </div>
            </div>
          </div>

          <button className="px-6 py-3 bg-primary text-primary-foreground font-mono text-sm rounded-lg hover:bg-primary/90 transition-all cyber-glow">
            Service Online
          </button>
        </div>
      </div>
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  description: string;
  icon: React.ElementType;
  color: "cyan" | "green" | "red" | "yellow";
  isText?: boolean;
}

function StatCard({ label, value, description, icon: Icon, color, isText }: StatCardProps) {
  const colorClasses = {
    cyan: "text-cyber-cyan",
    green: "text-cyber-green",
    red: "text-cyber-red",
    yellow: "text-cyber-yellow",
  };

  return (
    <div className="cyber-border rounded-xl p-6 relative overflow-hidden group">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="flex items-start justify-between mb-4">
        <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{label}</span>
        <Icon className={`w-4 h-4 ${colorClasses[color]}`} />
      </div>
      <div className={`${isText ? "text-2xl" : "text-4xl"} font-bold font-mono ${colorClasses[color]} mb-2`}>{value}</div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

interface MetricBarProps {
  label: string;
  value: number;
  subValue?: string;
  icon: React.ElementType;
  alert?: string;
}

function MetricBar({ label, value, subValue, icon: Icon, alert }: MetricBarProps) {
  const getColor = (val: number) => {
    if (val < 60) return "bg-cyber-green";
    if (val < 85) return "bg-cyber-yellow";
    return "bg-cyber-red";
  };

  return (
    <div className="cyber-border rounded-xl p-4 flex flex-col justify-between">
      <div>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4 text-primary" />
            <span className="font-mono text-sm text-foreground">{label}</span>
          </div>
          <span className="font-mono text-sm text-muted-foreground">{value}%</span>
        </div>
        <div className="text-[10px] font-mono text-muted-foreground h-4">
           {subValue}
        </div>
      </div>

      <div className="mt-3">
        <div className="h-2 bg-secondary rounded-full overflow-hidden">
          <div className={`h-full ${getColor(value)} transition-all duration-500 progress-glow`} style={{ width: `${value}%` }} />
        </div>
        {alert && <div className="text-[9px] text-cyber-red mt-2 animate-pulse">{alert}</div>}
      </div>
    </div>
  );
}
