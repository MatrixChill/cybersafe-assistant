import { Shield, AlertTriangle, Download, Activity, CheckCircle2, Cpu, HardDrive, Wifi, Search, Play, FolderSearch } from "lucide-react";
import { useEffect, useState } from "react";
import type { DashboardSummary, HardwareSnapshot, PcState, PcStateLevel, Finding } from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";
import { MatrixAvatar } from "../components/MatrixAvatar";
import ProtectionDetails from "../components/ProtectionDetails";
import { deriveProtectionLevel, levelMeta } from "../lib/protectionHealth";
import { MetricBarSkeleton } from "../components/Skeleton";
import { TelemetrySparkline, useTelemetryHistory } from "../components/TelemetrySparkline";
import { useTemperatureDisplay } from "../lib/temperature";

interface DashboardPageProps {
  dashboard: DashboardSummary;
  isLoading: boolean;
  hardware?: HardwareSnapshot | null;
  pcState?: PcState | null;
  onScan?: (type: string, targetPath?: string) => void;
}

export default function DashboardPage({ dashboard, isLoading, hardware, pcState, onScan }: DashboardPageProps) {
  const level = deriveProtectionLevel(dashboard.systemStatus, dashboard.engineHealth);
  const meta = levelMeta(level);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [displayScore, setDisplayScore] = useState(0);

  const cpuSamples = useTelemetryHistory("cpu", 2000);
  const ramSamples = useTelemetryHistory("ram", 2000);
  const gpuSamples = useTelemetryHistory("gpu", 2000);
  const netRxSamples = useTelemetryHistory("net-rx", 2000);

  // Temperaturas: nunca 0 °C artificial. "A recolher dados..." e, passado o
  // prazo sem leitura segura, "Temperatura indisponível" (igual ao PC Center).
  const cpuTemp = useTemperatureDisplay(hardware?.cpu?.temperature ?? null);
  const gpuTemp = useTemperatureDisplay(hardware?.gpu?.temperature ?? null);

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
        <span className="tracking-[0.3em]">A Sincronizar Estado de Proteção...</span>
      </div>
    );
  }

  const matrixMood = level === "protected" ? "safe" : level === "attention" ? "guide" : "alert";
  const statusLabel = level === "protected" ? "Protegido" : level === "attention" ? "Atenção" : level === "degraded" ? "Degradado" : "Crítico";

  return (
    <div className="p-6 lg:p-8 space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">

      {/* ═══ CAMADA 1 — HERO / ESTADO PRINCIPAL ═══ */}
      <div className="hero-banner relative overflow-hidden rounded-xl border border-primary/20 bg-card p-6 lg:p-8">
        <div className="hero-gradient" />

        <div className="relative z-10 flex flex-col lg:flex-row items-start gap-6">
          {/* Matrix + Saudação */}
          <div className="flex items-start gap-4 flex-1 min-w-0">
            <MatrixAvatar mood={matrixMood} size="xl" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-xl font-bold font-mono tracking-tight text-foreground">
                  Olá! Sou a <span className="text-primary">Matrix</span>
                </h1>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyber-green/10 text-cyber-green border border-cyber-green/30">
                  ONLINE
                </span>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-lg">
                {level === "protected"
                  ? "Tudo calmo. Continuo a vigiar o teu sistema 24/7."
                  : level === "attention"
                    ? "Proteção ativa com algumas limitações. Alguns componentes precisam da tua atenção."
                    : level === "degraded"
                      ? "Alguns motores estão indisponíveis. O teu sistema está parcialmente protegido."
                      : "Proteção essencial indisponível ou ameaça crítica. Revisa já."}
              </p>
            </div>
          </div>

          {/* Score Ring + badges + CTA.
              Layout responsivo real: coluna em < xl (score + CTA lado a lado),
              linha completa apenas em ecrãs largos. O rótulo do anel nunca
              transborda (largura fixa + truncate). */}
          <div className="flex flex-col sm:flex-row xl:items-center justify-start lg:justify-end gap-6 min-w-0">
            <div className="flex items-center gap-4 min-w-0">
              <div className="relative w-28 h-28 shrink-0">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="6" className="text-secondary" />
                  <circle
                    cx="50" cy="50" r="40" fill="none" stroke="url(#hero-risk-gradient)" strokeWidth="6"
                    strokeLinecap="round" strokeDasharray={`${(displayScore / 100) * 251.2} 251.2`}
                    className="transition-all duration-500"
                  />
                  <defs>
                    <linearGradient id="hero-risk-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor={level === "protected" ? "var(--cyber-green)" : level === "attention" ? "var(--cyber-yellow)" : "var(--cyber-red)"} />
                      <stop offset="100%" stopColor="var(--primary)" />
                    </linearGradient>
                  </defs>
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center px-2">
                  <span className="text-3xl leading-none font-bold font-mono text-foreground">{displayScore}</span>
                  <span
                    className={cn("mt-1 text-[10px] leading-none font-mono uppercase tracking-wide whitespace-nowrap text-center", meta.textClass)}
                    title={meta.label}
                  >
                    {meta.shortLabel}
                  </span>
                </div>
              </div>

              {/* Category badges — podem encolher em janelas estreitas. */}
              {pcState && (
                <div className="grid grid-cols-1 min-w-0">
                  {([
                    { key: "security" as const, label: "Segurança" },
                    { key: "performance" as const, label: "Desempenho" },
                    { key: "system" as const, label: "Sistema" },
                    { key: "privacy" as const, label: "Privacidade" },
                  ]).map(({ key, label }) => {
                    const catMeta = LEVEL_META[pcState[key]];
                    return (
                      <div key={key} className="flex min-w-0 items-center gap-2 px-2 py-1 rounded-lg bg-white/[0.04] border border-white/[0.06]">
                        <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", catMeta.dotClass)} />
                        <span className="text-[11px] font-mono text-muted-foreground truncate">{label}</span>
                        <span className={cn("text-[10px] font-mono font-semibold whitespace-nowrap shrink-0", catMeta.textClass)}>{catMeta.label}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* CTA */}
            <div className="flex flex-col gap-2 shrink-0">
              <button
                onClick={() => setDetailsOpen(true)}
                title={`Estado geral: ${meta.label}`}
                className={cn("px-4 py-2 rounded-lg font-mono text-xs font-semibold whitespace-nowrap transition-all hover:brightness-110", meta.chipClass, meta.textClass)}
              >
                <div className="flex items-center gap-2">
                  <div className={cn("w-2 h-2 rounded-full shrink-0 cyber-pulse", meta.dotClass)} />
                  <span>{statusLabel}</span>
                </div>
              </button>
              <span className="text-[10px] font-mono text-muted-foreground text-center whitespace-nowrap">
                {dashboard.engineHealth?.definitionsUpdatedAt
                  ? `Atualizado: ${new Date(dashboard.engineHealth.definitionsUpdatedAt).toLocaleTimeString()}`
                  : "Definições:—"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ═══ CAMADA 2 — O QUE PRECISA DE ATENÇÃO AGORA ═══ */}
      {pcState && (pcState.counts.urgent + pcState.counts.attention > 0) && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-4 h-4 text-cyber-yellow" />
            <h2 className="text-sm font-mono font-bold text-foreground uppercase tracking-wider">O que precisa de atenção</h2>
          </div>
          <PcStateAttention pcState={pcState} onShowDetails={() => setDetailsOpen(true)} />
        </section>
      )}

      {/* ═══ CAMADA 3 — TELEMETRIA E MÉTRICAS ═══ */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-mono font-bold text-foreground uppercase tracking-wider">Telemetria</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Dados reais do serviço de proteção</p>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <StatCard label="Eventos" value={dashboard.totalEvents.toString()} icon={Activity} color="cyan" />
          <StatCard label="Ameaças" value={dashboard.highSeverityEvents.toString()} icon={AlertTriangle} color={dashboard.highSeverityEvents > 0 ? "red" : "green"} />
          <StatCard label="Downloads" value={dashboard.downloadRisk.toUpperCase()} icon={Download} color={dashboard.downloadRisk === "low" ? "green" : dashboard.downloadRisk === "medium" ? "yellow" : "red"} isText />
          <StatCard label="Quarentena" value={pcState ? `${pcState.findings.length}` : "—"} icon={Shield} color="cyan" />
        </div>

        {/* Hardware metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          {hardware ? (
            <>
              <MetricBar label="CPU" subValue={`${cpuTemp.text}${hardware.cpu.model ? ` · ${hardware.cpu.model}` : ""}`} value={hardware.cpu.usage || 0} icon={Cpu} alert={hardware.alerts.find((a) => a.category === "cpu")?.title} sparkline={<TelemetrySparkline samples={cpuSamples} height={32} width={160} showArea />} />
              <MetricBar label="RAM" subValue={`${hardware.ram.usedGb}/${hardware.ram.totalGb} GB`} value={hardware.ram.usagePercent || 0} icon={HardDrive} alert={hardware.alerts.find((a) => a.category === "ram")?.title} sparkline={<TelemetrySparkline samples={ramSamples} height={32} width={160} showArea />} />
              <MetricBar label="Disco" subValue={`${hardware.disk.usedGb}/${hardware.disk.totalGb} GB`} value={hardware.disk.usagePercent || 0} icon={HardDrive} alert={hardware.alerts.find((a) => a.category === "disk")?.title} />
              <MetricBar label="Rede" subValue={formatThroughput(hardware.network.rxSec)} value={Math.min(100, (hardware.network.rxSec || 0) / 1024 / 100)} icon={Wifi} sparkline={<TelemetrySparkline samples={netRxSamples} height={32} width={160} showArea />} />
            </>
          ) : (
            <>
              <MetricBarSkeleton />
              <MetricBarSkeleton />
              <MetricBarSkeleton />
              <MetricBarSkeleton />
            </>
          )}
        </div>

        {hardware?.gpu && (
          <div className="grid grid-cols-2 gap-4 mb-4">
            <MetricBar label="GPU" subValue={`${gpuTemp.text}${hardware.gpu.model ? ` · ${hardware.gpu.model}` : ""}`} value={hardware.gpu.usagePercent ?? 0} icon={Cpu} alert={hardware?.alerts.find((a) => a.category === "gpu")?.title} sparkline={<TelemetrySparkline samples={gpuSamples} height={32} width={160} showArea />} />
            {hardware.gpu.vramTotalMb && (
              <MetricBar label="VRAM" subValue={`${((hardware.gpu.vramUsedMb ?? 0) / 1024).toFixed(1)}/${(hardware.gpu.vramTotalMb / 1024).toFixed(1)} GB`} value={hardware.gpu.vramUsedMb ? (hardware.gpu.vramUsedMb / hardware.gpu.vramTotalMb) * 100 : 0} icon={Cpu} />
            )}
          </div>
        )}

        {/* Quick actions */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <ScanButton label="Rápida" sub="Áreas prioritárias do PC" icon={Search} color="cyan" scanType="quick" onScan={onScan} />
          <ScanButton label="Profunda" sub="Verificação do sistema" icon={Play} color="yellow" scanType="full" onScan={onScan} />
          <ScanButton label="Pasta" sub="Ficheiros de uma pasta" icon={FolderSearch} color="primary" scanType="custom" onScan={onScan} />
        </div>

        {/* Alerts + Threats */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="stat-card p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-mono text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-2">
                <Activity className="w-3.5 h-3.5 text-primary" />
                Alertas Recentes
              </h3>
              <span className="text-[10px] font-mono text-muted-foreground">
                {dashboard.alerts.length} registos
              </span>
            </div>
            {dashboard.alerts.length === 0 ? (
              <div className="flex flex-col items-center py-8 text-center">
                <CheckCircle2 className="w-8 h-8 text-cyber-green mb-2" />
                <p className="text-xs text-muted-foreground">Nenhum alerta severo</p>
              </div>
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {dashboard.alerts.map((alert) => (
                  <div key={alert.id} className="flex items-center justify-between p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                    <span className="text-[11px] font-mono text-foreground truncate">{alert.title}</span>
                    <span className="text-[9px] font-mono text-cyber-red uppercase shrink-0 ml-2">{alert.severity}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="stat-card p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-mono text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-2">
                <Shield className="w-3.5 h-3.5 text-primary" />
                Ameaças Recentes
              </h3>
            </div>
            {dashboard.recentThreats.length === 0 ? (
              <div className="flex flex-col items-center py-8 text-center">
                <Shield className="w-8 h-8 text-primary mb-2" />
                <p className="text-xs text-muted-foreground">Nenhuma ameaça detetada</p>
              </div>
            ) : (
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {dashboard.recentThreats.slice(0, 5).map((threat, i) => (
                  <div key={`${threat.createdAt}-${i}`} className="flex items-center justify-between p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={cn("w-1.5 h-1.5 rounded-full shrink-0",
                        threat.severity === "critical" ? "bg-cyber-red"
                          : threat.severity === "high" ? "bg-cyber-yellow" : "bg-cyber-cyan",
                      )} />
                      <span className="text-[11px] font-mono text-foreground truncate">{threat.domain}</span>
                    </div>
                    <span className={cn(
                      "text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border shrink-0 ml-2",
                      threat.severity === "critical" ? "bg-cyber-red/10 text-cyber-red border-cyber-red/30"
                        : threat.severity === "high" ? "bg-cyber-yellow/10 text-cyber-yellow border-cyber-yellow/30"
                          : "bg-cyber-cyan/10 text-cyber-cyan border-cyber-cyan/30",
                    )}>
                      {threat.severity}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <ProtectionDetails engine={dashboard.engineHealth} level={level} open={detailsOpen} onClose={() => setDetailsOpen(false)} score={dashboard.riskScore} />
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  icon: React.ElementType;
  color: "cyan" | "green" | "red" | "yellow";
  isText?: boolean;
}

function StatCard({ label, value, icon: Icon, color, isText }: StatCardProps) {
  const colorClasses = {
    cyan: "text-cyber-cyan",
    green: "text-cyber-green",
    red: "text-cyber-red",
    yellow: "text-cyber-yellow",
  };

  return (
    <div className="stat-card p-4 flex items-center gap-3">
      <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center shrink-0", `bg-${color === "cyan" ? "cyber-cyan" : color === "green" ? "cyber-green" : color === "red" ? "cyber-red" : "cyber-yellow"}/10`)}>
        <Icon className={cn("w-4 h-4", colorClasses[color])} />
      </div>
      <div className="min-w-0">
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider block">{label}</span>
        <span className={cn(isText ? "text-sm" : "text-xl", "font-bold font-mono", colorClasses[color])}>{value}</span>
      </div>
    </div>
  );
}

interface ScanButtonProps {
  label: string;
  sub: string;
  icon: React.ElementType;
  color: "cyan" | "yellow" | "primary";
  scanType: "quick" | "full" | "custom";
  onScan?: (type: string, targetPath?: string) => void;
}

function ScanButton({ label, sub, icon: Icon, color, scanType, onScan }: ScanButtonProps) {
  const colorMap = {
    cyan: "bg-cyber-cyan/10 text-cyber-cyan",
    yellow: "bg-cyber-yellow/10 text-cyber-yellow",
    primary: "bg-primary/10 text-primary",
  };

  const handleClick = async () => {
    if (scanType === "custom") {
      // Botão "Pasta": tem de abrir o seletor de PASTAS, não de ficheiros.
      if (!window.electronAPI) return;
      const path = await window.electronAPI.openFolderDialog();
      if (!path) return;
      onScan?.("custom", path);
    } else {
      onScan?.(scanType);
    }
  };

  return (
    <button
      onClick={handleClick}
      className="stat-card p-3 flex items-center gap-3 hover:border-primary/30 transition-all group text-left"
    >
      <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform", colorMap[color])}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0">
        <span className="text-xs font-mono font-semibold text-foreground block">{label}</span>
        <span className="text-[10px] text-muted-foreground">{sub}</span>
      </div>
    </button>
  );
}

interface MetricBarProps {
  label: string;
  value: number;
  subValue?: string;
  icon: React.ElementType;
  alert?: string;
}

function formatThroughput(bytes: number): string {
  if (!bytes) return "0 B/s";
  if (bytes < 1024) return `${bytes.toFixed(0)} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
}

function MetricBar({ label, value, subValue, icon: Icon, alert, sparkline }: MetricBarProps & { sparkline?: React.ReactNode }) {
  const safeValue = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;

  const getColor = (val: number) => {
    if (val < 60) return "bg-cyber-green";
    if (val < 85) return "bg-cyber-yellow";
    return "bg-cyber-red";
  };

  return (
    <div className="stat-card p-3 flex flex-col justify-between">
      <div>
        <div className="flex items-center justify-between mb-0.5">
          <div className="flex items-center gap-1.5">
            <Icon className="w-3.5 h-3.5 text-primary" />
            <span className="font-mono text-xs text-foreground font-semibold">{label}</span>
          </div>
          <span className="font-mono text-xs text-muted-foreground">{safeValue.toFixed(0)}%</span>
        </div>
        <div className="text-[10px] font-mono text-muted-foreground truncate">{subValue}</div>
      </div>

      {sparkline && <div className="mt-2">{sparkline}</div>}

      <div className="mt-2">
        <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
          <div className={`h-full ${getColor(safeValue)} transition-all duration-500`} style={{ width: `${safeValue}%` }} />
        </div>
        {alert && <div className="text-[9px] text-cyber-red mt-1 animate-pulse">{alert}</div>}
      </div>
    </div>
  );
}

// ── PC State / Findings Overview ──
// Os dados vêm já calculados do backend (PcStateEngine). A UI apenas apresenta.

const LEVEL_META: Record<PcStateLevel, { label: string; chipClass: string; textClass: string; dotClass: string }> = {
  good: {
    label: "Boa",
    chipClass: "bg-cyber-green/10 border-cyber-green/30",
    textClass: "text-cyber-green",
    dotClass: "bg-cyber-green",
  },
  attention: {
    label: "Atenção",
    chipClass: "bg-cyber-yellow/10 border-cyber-yellow/30",
    textClass: "text-cyber-yellow",
    dotClass: "bg-cyber-yellow",
  },
  critical: {
    label: "Crítico",
    chipClass: "bg-cyber-red/10 border-cyber-red/30",
    textClass: "text-cyber-red",
    dotClass: "bg-cyber-red",
  },
  unknown: {
    label: "Desconhecida",
    chipClass: "bg-white/5 border-white/10",
    textClass: "text-muted-foreground",
    dotClass: "bg-muted-foreground",
  },
};

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  urgent: "PROBLEMA",
  attention: "PROBLEMA",
  recommended: "MELHORIA",
  informative: "RECOMENDAÇÃO",
};

function severityChip(f: Finding) {
  const base = "text-[9px] font-mono uppercase px-2 py-1 rounded border";
  if (f.severity === "urgent") {
    return cn(base, "bg-cyber-red/10 text-cyber-red border-cyber-red/30");
  }
  if (f.severity === "attention") {
    return cn(base, "bg-cyber-yellow/10 text-cyber-yellow border-cyber-yellow/30");
  }
  if (f.severity === "recommended") {
    return cn(base, "bg-cyber-cyan/10 text-cyber-cyan border-cyber-cyan/30");
  }
  return cn(base, "bg-white/5 text-muted-foreground border-white/10");
}

function PcStateAttention({ pcState, onShowDetails }: { pcState: PcState; onShowDetails: () => void }) {
  const { principalFinding, findings } = pcState;
  const problems = findings.filter((f) => f.severity === "urgent" || f.severity === "attention");

  return (
    <div className={cn(
      "rounded-xl border p-4 space-y-3",
      pcState.overall === "critical"
        ? "border-cyber-red/30 bg-cyber-red/[0.03]"
        : "border-cyber-yellow/30 bg-cyber-yellow/[0.03]",
    )}>
      {principalFinding && (
        <div className="flex items-start gap-3">
          <div className={cn(
            "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
            principalFinding.severity === "urgent" ? "bg-cyber-red/10" : "bg-cyber-yellow/10",
          )}>
            {principalFinding.severity === "urgent"
              ? <AlertTriangle className="w-4 h-4 text-cyber-red" />
              : <AlertTriangle className="w-4 h-4 text-cyber-yellow" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className={cn(
                "text-[9px] font-mono font-bold uppercase tracking-widest",
                principalFinding.severity === "urgent" ? "text-cyber-red" : "text-cyber-yellow",
              )}>{SEVERITY_LABEL[principalFinding.severity]}</span>
              <span className="text-xs font-mono font-semibold text-foreground">{principalFinding.title}</span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">{principalFinding.summary}</p>
          </div>
          <button
            onClick={onShowDetails}
            className="text-[10px] font-mono text-primary hover:text-primary/80 shrink-0 uppercase tracking-wider"
          >
            Ver detalhes
          </button>
        </div>
      )}

      {problems.length > 1 && (
        <div className="space-y-1.5 pl-11">
          {problems.filter((f) => f.id !== principalFinding?.id).slice(0, 3).map((f) => (
            <div key={f.id} className="flex items-center justify-between p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
              <span className="text-[11px] font-mono text-foreground truncate">{f.title}</span>
              <span className={severityChip(f)}>{f.severity.toUpperCase()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
