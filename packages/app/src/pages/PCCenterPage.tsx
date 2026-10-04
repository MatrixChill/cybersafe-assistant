import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  LayoutGrid,
  Settings,
  ShieldCheck,
  Cpu,
  HardDrive,
  Wifi,
  Battery,
  Monitor,
  Thermometer,
  AlertTriangle,
  Server,
  ChevronUp,
  ChevronDown,
  Gauge,
  MemoryStick,
  BatteryCharging,
  Zap,
  ShieldAlert,
  HelpCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { HardwareSnapshot, PcState, PcStateLevel } from "@cybersafe/shared-types";
import PCHealthSection from "@/components/PCHealthSection";
import { TEMPERATURE_UNAVAILABLE_HINT, useTemperatureDisplay } from "@/lib/temperature";

interface PCCenterPageProps {
  hardware: HardwareSnapshot | null;
  pcState?: PcState | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
}

function getUsageColor(percent: number): string {
  if (percent < 60) return "text-cyber-green";
  if (percent < 85) return "text-cyber-yellow";
  return "text-cyber-red";
}

function getUsageBgColor(percent: number): string {
  if (percent < 60) return "bg-cyber-green";
  if (percent < 85) return "bg-cyber-yellow";
  return "bg-cyber-red";
}

// A copy/estado de temperatura vive em @/lib/temperature (partilhada com o
// Dashboard): "A recolher dados..." → "Temperatura indisponível". Nunca 0 °C.

// O veredicto geral vem do PcState (Findings Engine) — a UI não cria uma
// segunda opinião sobre a saúde do sistema. stressScore continua a mostrado
// como métrica de telemetria, mas sem decidir o título do estado.
function overallStatusMeta(overall: PcStateLevel): {
  title: string;
  message: string;
  colorClass: string;
  bgClass: string;
  borderClass: string;
  StatusIcon: LucideIcon;
} {
  switch (overall) {
    case "good":
      return {
        title: "Sistema Saudável",
        message: "Não encontrámos problemas que exijam atenção neste momento.",
        colorClass: "text-cyber-green",
        bgClass: "bg-cyber-green/10",
        borderClass: "border-cyber-green/30",
        StatusIcon: ShieldCheck,
      };
    case "attention":
      return {
        title: "Sistema precisa de atenção",
        message: "Há componentes do sistema que não estão totalmente saudáveis.",
        colorClass: "text-cyber-yellow",
        bgClass: "bg-cyber-yellow/10",
        borderClass: "border-cyber-yellow/30",
        StatusIcon: AlertTriangle,
      };
    case "critical":
      return {
        title: "Problema crítico",
        message: "Existem problemas que precisam da tua intervenção.",
        colorClass: "text-cyber-red",
        bgClass: "bg-cyber-red/10",
        borderClass: "border-cyber-red/30",
        StatusIcon: ShieldAlert,
      };
    case "unknown":
    default:
      return {
        title: "Estado parcialmente desconhecido",
        message: "Alguns dados ainda não estão disponíveis por completo.",
        colorClass: "text-cyber-cyan",
        bgClass: "bg-cyber-cyan/10",
        borderClass: "border-cyber-cyan/30",
        StatusIcon: HelpCircle,
      };
  }
}

function CircularGauge({ value, size = 100, label, showFallback }: { value: number; size?: number; label?: string; showFallback?: boolean }) {
  const strokeWidth = 10;
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const strokeDashoffset = circumference - (value / 100) * circumference;
  const colorClass = getUsageColor(value);

  return (
    <div className="relative flex flex-col items-center justify-center" style={{ width: size, height: size }}>
      <svg className="transform -rotate-90 w-full h-full">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          className="stroke-secondary fill-none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          className={cn("fill-none transition-all duration-1000 ease-out", colorClass.replace("text-", "stroke-"))}
        />
      </svg>
      <div className="absolute flex flex-col items-center justify-center">
        <span className={cn("text-xl font-bold font-mono", showFallback ? "text-muted-foreground" : colorClass)}>
          {showFallback ? "—" : `${Math.round(value)}%`}
        </span>
        {label && <span className="text-xs text-muted-foreground uppercase tracking-wider mt-1">{label}</span>}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="w-full space-y-6 animate-pulse p-6">
      <div className="h-24 bg-card cyber-border rounded-xl"></div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="h-48 bg-card cyber-border rounded-xl"></div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="h-64 bg-card cyber-border rounded-xl"></div>
        <div className="h-64 bg-card cyber-border rounded-xl"></div>
      </div>
    </div>
  );
}


function SimpleView({ hardware, pcState }: { hardware: HardwareSnapshot; pcState?: PcState | null }) {
  const isStressed = hardware.stressScore > 75;
  const isWarning = hardware.stressScore > 50 && hardware.stressScore <= 75;

  let statusTitle = "Sistema Saudável";
  let statusColor = "text-cyber-green";
  let statusBg = "bg-cyber-green/10";
  let statusBorder = "border-cyber-green/30";
  let StatusIcon = ShieldCheck;
  let statusMessage = "Os componentes do seu sistema estão a operar de forma eficiente e dentro dos limites seguros.";

  if (pcState && pcState.overall) {
    const meta = overallStatusMeta(pcState.overall);
    statusTitle = meta.title;
    statusColor = meta.colorClass;
    statusBg = meta.bgClass;
    statusBorder = meta.borderClass;
    StatusIcon = meta.StatusIcon;
    statusMessage = meta.message;
  } else if (isStressed) {
    statusTitle = "Sistema em Sobrecarga";
    statusColor = "text-cyber-red";
    statusBg = "bg-cyber-red/10";
    statusBorder = "border-cyber-red/30";
    StatusIcon = AlertTriangle;
    statusMessage = "O sistema encontra-se sob stress elevado. Recomendamos fechar aplicações pesadas em segundo plano.";
  } else if (isWarning) {
    statusTitle = "Atenção Necessária";
    statusColor = "text-cyber-yellow";
    statusBg = "bg-cyber-yellow/10";
    statusBorder = "border-cyber-yellow/30";
    StatusIcon = AlertTriangle;
    statusMessage = "Alguns componentes registam utilização moderadamente alta.";
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4">
      {/* Main Status */}
      <div className={cn("flex flex-col items-center text-center p-8 rounded-xl border cyber-border bg-card", statusBorder)}>
        <div className={cn("p-6 rounded-full mb-6 relative", statusBg)}>
          <div className={cn("absolute inset-0 rounded-full animate-ping opacity-20", statusBg)} />
          <StatusIcon className={cn("w-16 h-16", statusColor)} />
        </div>
        <h2 className={cn("text-3xl font-bold mb-2", statusColor)}>{statusTitle}</h2>
        <p className="text-muted-foreground max-w-lg mx-auto">{statusMessage}</p>

        <div className="mt-8 flex flex-col items-center">
          <span className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Índice de Stress</span>
          <div className="flex items-center gap-2">
            <Gauge className={cn("w-6 h-6", getUsageColor(hardware.stressScore))} />
            <span className={cn("text-3xl font-mono font-bold", getUsageColor(hardware.stressScore))}>
              {hardware.stressScore}/100
            </span>
          </div>

          {/* Stress breakdown */}
          {hardware.stressContributions && (
            <div className="mt-4 w-full max-w-xs space-y-2">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider text-center mb-1">
                Contribuições (0–100)
              </div>
              {[
                { label: "CPU", value: hardware.stressContributions.cpu, max: 35 },
                { label: "RAM", value: hardware.stressContributions.ram, max: 30 },
                { label: "Temperatura", value: hardware.stressContributions.temperature, max: 25 },
                { label: "GPU", value: hardware.stressContributions.gpu, max: 0 },
              ].filter(c => c.max > 0).map((c) => (
                <div key={c.label} className="flex items-center gap-2 text-xs">
                  <span className="w-20 text-muted-foreground font-mono">{c.label}</span>
                  <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                    <div
                      className={cn("h-full rounded-full transition-all", getUsageBgColor(c.value > 0 ? (c.value / c.max) * 100 : 0))}
                      style={{ width: `${c.max > 0 ? (c.value / c.max) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="w-8 text-right font-mono text-muted-foreground">{c.value}</span>
                </div>
              ))}
              <p className="text-[10px] text-muted-foreground text-center mt-2">
                Stress = carga instantânea (CPU + RAM + Temperatura). Capacidade de disco é tratada separadamente.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Simple Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-card cyber-border rounded-xl p-6 flex flex-col items-center text-center group hover:border-primary/50 transition-all">
          <Cpu className={cn("w-8 h-8 mb-4", getUsageColor(hardware.cpu.usage))} />
          <h3 className="font-semibold mb-1">Processador</h3>
          <span className={cn("text-2xl font-mono font-bold mb-2", getUsageColor(hardware.cpu.usage))}>
            {Math.round(hardware.cpu.usage)}%
          </span>
          <span className="text-xs text-muted-foreground">Utilização atual</span>
        </div>

        <div className="bg-card cyber-border rounded-xl p-6 flex flex-col items-center text-center group hover:border-primary/50 transition-all">
          <MemoryStick className={cn("w-8 h-8 mb-4", getUsageColor(hardware.ram.usagePercent))} />
          <h3 className="font-semibold mb-1">Memória RAM</h3>
          <span className={cn("text-2xl font-mono font-bold mb-2", getUsageColor(hardware.ram.usagePercent))}>
            {Math.round(hardware.ram.usagePercent)}%
          </span>
          <span className="text-xs text-muted-foreground">{hardware.ram.usedGb.toFixed(1)} GB em uso</span>
        </div>

        <div className="bg-card cyber-border rounded-xl p-6 flex flex-col items-center text-center group hover:border-primary/50 transition-all">
          <HardDrive className={cn("w-8 h-8 mb-4", getUsageColor(hardware.disk.usagePercent))} />
          <h3 className="font-semibold mb-1">Armazenamento</h3>
          <span className={cn("text-2xl font-mono font-bold mb-2", getUsageColor(hardware.disk.usagePercent))}>
            {Math.round(hardware.disk.usagePercent)}%
          </span>
          <span className="text-xs text-muted-foreground">Capacidade usada</span>
        </div>

        <div className="bg-card cyber-border rounded-xl p-6 flex flex-col items-center text-center group hover:border-primary/50 transition-all">
          <Wifi className="w-8 h-8 text-primary mb-4" />
          <h3 className="font-semibold mb-1">Rede Local</h3>
          <div className="flex items-center justify-center gap-4 mb-2">
            <div className="flex items-center gap-1">
              <ChevronDown className="w-4 h-4 text-cyber-cyan" />
              <span className="text-sm font-mono font-bold text-cyber-cyan">{formatBytes(hardware.network.rxSec)}</span>
            </div>
            <div className="flex items-center gap-1">
              <ChevronUp className="w-4 h-4 text-primary" />
              <span className="text-sm font-mono font-bold text-primary">{formatBytes(hardware.network.txSec)}</span>
            </div>
          </div>
          <span className="text-xs text-muted-foreground mt-1">Tráfego atual</span>
        </div>
      </div>
    </div>
  );
}
function AdvancedView({ hardware }: { hardware: HardwareSnapshot }) {
  // Hooks antes de qualquer return antecipado.
  const cpuTemperature = useTemperatureDisplay(hardware?.cpu?.temperature ?? null);
  const gpuTemperature = useTemperatureDisplay(hardware?.gpu?.temperature ?? null);

  if (!hardware) {
    return <LoadingSkeleton />;
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4">
      {/* Alerts Section */}
      {hardware.alerts && hardware.alerts.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-cyber-yellow" />
            Alertas de Sistema
          </h2>
          <div className="grid gap-4">
            {hardware.alerts.map((alert, idx) => {
              const isCritical = alert.severity === 'critical' || alert.severity === 'high';
              const bgColor = isCritical ? 'bg-cyber-red/10' : 'bg-cyber-yellow/10';
              const borderColor = isCritical ? 'border-cyber-red/30' : 'border-cyber-yellow/30';
              const iconColor = isCritical ? 'text-cyber-red' : 'text-cyber-yellow';

              return (
                <div key={idx} className={cn("flex flex-col md:flex-row gap-4 p-4 rounded-xl border", bgColor, borderColor)}>
                  <div className="flex-shrink-0 mt-1">
                    <AlertTriangle className={cn("w-6 h-6", iconColor)} />
                  </div>
                  <div className="flex-grow">
                    <h3 className={cn("text-base font-semibold", iconColor)}>{alert.title}</h3>
                    <p className="text-sm text-foreground/80 mt-1">{alert.description}</p>
                    <div className="mt-3 flex items-start gap-2 bg-black/20 p-3 rounded-lg border border-white/5">
                      <Zap className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                      <div>
                        <span className="text-xs font-semibold text-primary uppercase block mb-1">Recomendação</span>
                        <p className="text-sm text-muted-foreground">{alert.recommendation}</p>
                      </div>
                    </div>
                  </div>
                  {alert.process && (
                    <div className="flex-shrink-0 min-w-[200px] bg-black/20 rounded-lg p-3 border border-white/5 h-fit">
                      <span className="text-xs text-muted-foreground uppercase block mb-1">Processo Afetado</span>
                      <div className="font-mono text-sm text-foreground truncate" title={alert.process.name}>
                        {alert.process.name}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono mt-1">
                        PID: {alert.process.pid} | CPU: {alert.process.cpu}%
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Main Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

        {/* CPU Card */}
        <div className="bg-card cyber-border rounded-xl p-6 relative overflow-hidden group hover:border-primary/50 transition-colors">
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="flex items-center gap-2 mb-6">
            <Cpu className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Processador (CPU)</h2>
          </div>
          <div className="flex items-center justify-between">
            <CircularGauge value={hardware.cpu.usage} label="Uso" />
            <div className="flex flex-col gap-3 text-right">
              <div>
                <span className="text-xs text-muted-foreground uppercase block">Modelo</span>
                <span className="text-sm font-medium font-mono text-foreground" title={hardware.cpu.model}>
                  {hardware.cpu.model.length > 20 ? hardware.cpu.model.substring(0, 20) + '...' : hardware.cpu.model}
                </span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground uppercase block">Velocidade & Cores</span>
                <span className="text-sm font-medium font-mono">{hardware.cpu.speed} GHz / {hardware.cpu.cores} Cores</span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground uppercase block">Temperatura</span>
                <span className={cn("text-sm font-medium font-mono flex items-center justify-end gap-1",
                  cpuTemperature.value != null ? getUsageColor(cpuTemperature.value) : "text-muted-foreground"
                )}>
                  <Thermometer className="w-3 h-3" />
                  {cpuTemperature.value != null
                    ? `${cpuTemperature.value}°C`
                    : <span title={TEMPERATURE_UNAVAILABLE_HINT} className="cursor-help">{cpuTemperature.text}</span>}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* RAM Card */}
        <div className="bg-card cyber-border rounded-xl p-6 relative overflow-hidden group hover:border-primary/50 transition-colors">
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="flex items-center gap-2 mb-6">
            <MemoryStick className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Memória (RAM)</h2>
          </div>
          <div className="flex items-center justify-between">
            <CircularGauge value={hardware.ram.usagePercent} label="Uso" />
            <div className="flex flex-col gap-3 text-right">
              <div>
                <span className="text-xs text-muted-foreground uppercase block">Em Uso</span>
                <span className={cn("text-lg font-bold font-mono", getUsageColor(hardware.ram.usagePercent))}>
                  {hardware.ram.usedGb.toFixed(1)} GB
                </span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground uppercase block">Disponível</span>
                <span className="text-sm font-medium font-mono">
                  {(hardware.ram.totalGb - hardware.ram.usedGb).toFixed(1)} GB
                </span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground uppercase block">Total</span>
                <span className="text-sm font-medium font-mono">{hardware.ram.totalGb.toFixed(1)} GB</span>
              </div>
            </div>
          </div>
        </div>

        {/* GPU Card */}
        <div className="bg-card cyber-border rounded-xl p-6 relative overflow-hidden group hover:border-primary/50 transition-colors">
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="flex items-center gap-2 mb-6">
            <Monitor className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Gráficos (GPU)</h2>
          </div>

          {!hardware.gpu ? (
            <div className="flex flex-col items-center justify-center h-24 text-muted-foreground">
              <Monitor className="w-8 h-8 mb-2 opacity-20" />
              <span className="text-sm font-medium">GPU não detetada</span>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <CircularGauge value={hardware.gpu.usagePercent ?? 0} label={hardware.gpu.usagePercent != null ? "Uso" : "N/A"} showFallback={hardware.gpu.usagePercent == null} />
              <div className="flex flex-col gap-3 text-right">
                <div>
                  <span className="text-xs text-muted-foreground uppercase block">Modelo</span>
                  <span className="text-sm font-medium font-mono text-foreground" title={hardware.gpu.model}>
                    {hardware.gpu.model.length > 20 ? hardware.gpu.model.substring(0, 20) + '...' : hardware.gpu.model}
                  </span>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground uppercase block">VRAM</span>
                  <span className="text-sm font-medium font-mono">
                    {hardware.gpu.vramUsedMb != null ? `${(hardware.gpu.vramUsedMb / 1024).toFixed(1)} / ` : ""}{hardware.gpu.vramTotalMb ? `${(hardware.gpu.vramTotalMb / 1024).toFixed(1)} GB` : "—"}
                  </span>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground uppercase block">Temperatura</span>
                  <span className={cn("text-sm font-medium font-mono flex items-center justify-end gap-1",
                    gpuTemperature.value != null ? getUsageColor(gpuTemperature.value) : "text-muted-foreground"
                  )}>
                    <Thermometer className="w-3 h-3" />
                    {gpuTemperature.value != null
                      ? `${gpuTemperature.value}°C`
                      : <span title={TEMPERATURE_UNAVAILABLE_HINT} className="cursor-help">{gpuTemperature.text}</span>}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Disk Card */}
        <div className="bg-card cyber-border rounded-xl p-6 relative overflow-hidden group hover:border-primary/50 transition-colors">
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="flex flex-col h-full justify-between">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <HardDrive className="w-5 h-5 text-primary" />
                <h2 className="text-lg font-semibold">Armazenamento</h2>
              </div>
              <div className="flex justify-between items-end mb-2">
                <span className="text-xs text-muted-foreground uppercase font-mono">{hardware.disk.fsType}</span>
                <span className={cn("text-2xl font-bold font-mono", getUsageColor(hardware.disk.usagePercent))}>
                  {hardware.disk.usagePercent.toFixed(1)}%
                </span>
              </div>
              <div className="w-full h-3 bg-secondary rounded-full overflow-hidden mb-4">
                <div
                  className={cn("h-full transition-all duration-1000", getUsageBgColor(hardware.disk.usagePercent))}
                  style={{ width: `${hardware.disk.usagePercent}%` }}
                />
              </div>
            </div>
            <div className="flex justify-between text-sm font-mono mt-auto">
              <div>
                <span className="text-xs text-muted-foreground uppercase block mb-1">Usado</span>
                <span className="font-medium text-foreground">{hardware.disk.usedGb.toFixed(1)} GB</span>
              </div>
              <div className="text-right">
                <span className="text-xs text-muted-foreground uppercase block mb-1">Livre / Total</span>
                <span className="font-medium">{(hardware.disk.totalGb - hardware.disk.usedGb).toFixed(1)} / {hardware.disk.totalGb.toFixed(1)} GB</span>
              </div>
            </div>
          </div>
        </div>

        {/* Network Card */}
        <div className="bg-card cyber-border rounded-xl p-6 relative overflow-hidden group hover:border-primary/50 transition-colors">
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Wifi className="w-5 h-5 text-primary" />
                <h2 className="text-lg font-semibold">Rede</h2>
              </div>
              <span className="text-xs font-mono bg-secondary px-2 py-1 rounded text-muted-foreground">
                {hardware.network.interfaceName}
              </span>
            </div>

            <div className="flex-grow flex flex-col justify-center gap-6">
              <div className="flex items-center justify-between bg-black/20 p-4 rounded-lg border border-white/5">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-cyber-cyan/10 rounded-full">
                    <ChevronDown className="w-5 h-5 text-cyber-cyan" />
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground uppercase block">Download</span>
                    <span className="text-xl font-bold font-mono text-cyber-cyan">
                      {formatBytes(hardware.network.rxSec)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between bg-black/20 p-4 rounded-lg border border-white/5">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-primary/10 rounded-full">
                    <ChevronUp className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground uppercase block">Upload</span>
                    <span className="text-xl font-bold font-mono text-primary">
                      {formatBytes(hardware.network.txSec)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Battery Card (Conditionally Rendered) */}
        {hardware.battery.hasBattery && (
          <div className="bg-card cyber-border rounded-xl p-6 relative overflow-hidden group hover:border-primary/50 transition-colors">
            <div className="absolute inset-0 bg-gradient-to-b from-transparent to-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="flex flex-col h-full justify-between">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Battery className="w-5 h-5 text-primary" />
                  <h2 className="text-lg font-semibold">Bateria</h2>
                </div>
                {hardware.battery.isCharging && (
                  <BatteryCharging className="w-5 h-5 text-cyber-green animate-pulse" />
                )}
              </div>

              <div className="flex flex-col items-center justify-center my-4">
                <div className="text-4xl font-bold font-mono flex items-baseline gap-1">
                  <span className={cn(
                    hardware.battery.percent < 20 ? "text-cyber-red" :
                    hardware.battery.percent < 50 ? "text-cyber-yellow" : "text-cyber-green"
                  )}>
                    {hardware.battery.percent}
                  </span>
                  <span className="text-xl text-muted-foreground">%</span>
                </div>
                <div className="w-full max-w-[200px] h-6 border-2 border-secondary rounded-sm mt-4 p-0.5 relative">
                  <div className="absolute -right-1.5 top-1/2 -translate-y-1/2 w-1 h-3 bg-secondary rounded-r-sm" />
                  <div
                    className={cn(
                      "h-full rounded-sm transition-all duration-1000",
                      hardware.battery.percent < 20 ? "bg-cyber-red" :
                      hardware.battery.percent < 50 ? "bg-cyber-yellow" : "bg-cyber-green"
                    )}
                    style={{ width: `${hardware.battery.percent}%` }}
                  />
                </div>
              </div>

              <div className="text-center mt-auto">
                <span className="text-xs text-muted-foreground uppercase block mb-1">Status</span>
                <span className="font-mono text-sm text-foreground">
                  {hardware.battery.isCharging ? "A carregar" : "A descarregar"}
                  {!hardware.battery.isCharging && hardware.battery.timeRemaining && (
                    <span className="text-muted-foreground ml-2">
                      (~{Math.floor(hardware.battery.timeRemaining / 60)}h {hardware.battery.timeRemaining % 60}m restantes)
                    </span>
                  )}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Top Processes */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">

        {/* Top CPU Processes */}
        <div className="bg-card cyber-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-6">
            <Cpu className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Top 5 Processos (CPU)</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-muted-foreground uppercase bg-secondary/50">
                <tr>
                  <th className="px-4 py-3 rounded-tl-lg">Nome</th>
                  <th className="px-4 py-3">PID</th>
                  <th className="px-4 py-3">CPU %</th>
                  <th className="px-4 py-3 rounded-tr-lg">RAM (MB)</th>
                </tr>
              </thead>
              <tbody>
                {hardware.topProcessesByCpu.map((proc, idx) => (
                  <tr key={idx} className="border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors">
                    <td className="px-4 py-3 font-mono font-medium truncate max-w-[150px]" title={proc.name}>
                      {proc.name}
                    </td>
                    <td className="px-4 py-3 font-mono text-muted-foreground">{proc.pid}</td>
                    <td className={cn("px-4 py-3 font-mono font-bold", proc.cpu > 50 ? "text-cyber-red" : "text-foreground")}>
                      {proc.cpu.toFixed(1)}%
                    </td>
                    <td className="px-4 py-3 font-mono text-muted-foreground">{proc.memoryMb.toFixed(0)}</td>
                  </tr>
                ))}
                {hardware.topProcessesByCpu.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground font-mono">
                      Nenhum processo encontrado
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Top RAM Processes */}
        <div className="bg-card cyber-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-6">
            <MemoryStick className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Top 5 Processos (RAM)</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-muted-foreground uppercase bg-secondary/50">
                <tr>
                  <th className="px-4 py-3 rounded-tl-lg">Nome</th>
                  <th className="px-4 py-3">PID</th>
                  <th className="px-4 py-3">RAM (MB)</th>
                  <th className="px-4 py-3 rounded-tr-lg">CPU %</th>
                </tr>
              </thead>
              <tbody>
                {hardware.topProcessesByRam.map((proc, idx) => (
                  <tr key={idx} className="border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors">
                    <td className="px-4 py-3 font-mono font-medium truncate max-w-[150px]" title={proc.name}>
                      {proc.name}
                    </td>
                    <td className="px-4 py-3 font-mono text-muted-foreground">{proc.pid}</td>
                    <td className={cn("px-4 py-3 font-mono font-bold", proc.memoryMb > 2000 ? "text-cyber-yellow" : "text-foreground")}>
                      {proc.memoryMb.toFixed(0)}
                    </td>
                    <td className="px-4 py-3 font-mono text-muted-foreground">{proc.cpu.toFixed(1)}%</td>
                  </tr>
                ))}
                {hardware.topProcessesByRam.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground font-mono">
                      Nenhum processo encontrado
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}


export default function PCCenterPage({ hardware, pcState }: PCCenterPageProps) {
  const [viewMode, setViewMode] = useState<"simple" | "advanced">("simple");
  // Hooks antes de qualquer return antecipado.
  const cpuTemperature = useTemperatureDisplay(hardware?.cpu?.temperature ?? null);
  const gpuTemperature = useTemperatureDisplay(hardware?.gpu?.temperature ?? null);

  if (!hardware) {
    return <LoadingSkeleton />;
  }

  return (
    <div className="w-full h-full p-6 space-y-6 animate-in fade-in slide-in-from-bottom-4 overflow-y-auto">
      {/* Header com Toggle */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center bg-card cyber-border rounded-xl p-6 relative overflow-hidden group">
        <div className="absolute inset-0 bg-gradient-to-r from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
        <div className="flex items-center gap-4 z-10">
          <div className="p-3 bg-primary/10 rounded-lg">
            <Server className="w-8 h-8 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">PC Center</h1>
            <p className="text-sm text-muted-foreground">Monitorização inteligente do seu sistema</p>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-4 md:mt-0 z-10 bg-secondary/50 p-1 rounded-lg cyber-border">
          <button
            onClick={() => setViewMode("simple")}
            className={cn("flex items-center gap-2 px-4 py-2 rounded-md transition-colors text-sm font-medium",
              viewMode === "simple" ? "bg-primary text-primary-foreground" : "hover:bg-white/5 text-muted-foreground")}
          >
            <LayoutGrid className="w-4 h-4" />
            Visão Simples
          </button>
          <button
            onClick={() => setViewMode("advanced")}
            className={cn("flex items-center gap-2 px-4 py-2 rounded-md transition-colors text-sm font-medium",
              viewMode === "advanced" ? "bg-primary text-primary-foreground" : "hover:bg-white/5 text-muted-foreground")}
          >
            <Settings className="w-4 h-4" />
            Visão Avançada
          </button>
        </div>
      </div>

      {viewMode === "simple" ? (
        <SimpleView hardware={hardware} pcState={pcState} />
      ) : (
        <AdvancedView hardware={hardware} />
      )}

      {/* Temperatures & Sensors */}
      <div className="bg-card cyber-border rounded-xl p-6 relative overflow-hidden group hover:border-primary/50 transition-colors">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="flex items-center gap-2 mb-6">
          <Thermometer className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Temperaturas e Sensores</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-secondary/30 rounded-lg p-4 border border-white/5">
            <div className="flex items-center gap-2 mb-2">
              <Cpu className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground uppercase font-mono">CPU</span>
            </div>
            {cpuTemperature.value != null ? (
              <>
                <span className={cn("text-2xl font-mono font-bold", getUsageColor(cpuTemperature.value))}>{cpuTemperature.value}°C</span>
                <p className="text-xs text-muted-foreground mt-1 font-mono truncate" title={hardware.cpu.model}>{hardware.cpu.model}</p>
                <p className="text-[10px] text-muted-foreground/60 mt-0.5 font-mono">Sensor térmico ACPI</p>
              </>
            ) : (
              <span className="text-sm font-mono text-muted-foreground" title={TEMPERATURE_UNAVAILABLE_HINT}>{cpuTemperature.text}</span>
            )}
          </div>

          {hardware.gpu ? (
            <div className="bg-secondary/30 rounded-lg p-4 border border-white/5">
              <div className="flex items-center gap-2 mb-2">
                <Monitor className="w-4 h-4 text-primary" />
                <span className="text-xs text-muted-foreground uppercase font-mono">GPU</span>
              </div>
              {gpuTemperature.value != null ? (
                <>
                  <span className={cn("text-2xl font-mono font-bold", getUsageColor(gpuTemperature.value))}>{gpuTemperature.value}°C</span>
                  <p className="text-xs text-muted-foreground mt-1 font-mono truncate" title={hardware.gpu.model}>{hardware.gpu.model}</p>
                  <p
                    className="text-[10px] text-muted-foreground/60 mt-0.5 font-mono truncate"
                    title={`${hardware.gpu.temperatureSource ?? "desconhecido"} · ${hardware.gpu.temperatureSensor ?? "GPU Core"}`}
                  >
                    {hardware.gpu.temperatureSensor ?? "GPU Core"}
                    {hardware.gpu.temperatureStatus === "stale" ? " (última leitura)" : ""}
                  </p>
                </>
              ) : (
                <span className="text-sm font-mono text-muted-foreground" title={TEMPERATURE_UNAVAILABLE_HINT}>{gpuTemperature.text}</span>
              )}
            </div>
          ) : (
            <div className="bg-secondary/30 rounded-lg p-4 border border-white/5 opacity-50">
              <div className="flex items-center gap-2 mb-2">
                <Monitor className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase font-mono">GPU</span>
              </div>
              <span className="text-lg font-mono text-muted-foreground">Não detetada</span>
            </div>
          )}

          <div className="bg-secondary/30 rounded-lg p-4 border border-white/5 opacity-50">
            <div className="flex items-center gap-2 mb-2">
              <HardDrive className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground uppercase font-mono">NVMe/SSD</span>
            </div>
            <span className="text-lg font-mono text-muted-foreground">—</span>
            <p className="text-xs text-muted-foreground mt-1">Sensor não disponível</p>
          </div>

          <div className="bg-secondary/30 rounded-lg p-4 border border-white/5 opacity-50">
            <div className="flex items-center gap-2 mb-2">
              <Server className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground uppercase font-mono">Motherboard</span>
            </div>
            <span className="text-lg font-mono text-muted-foreground">—</span>
            <p className="text-xs text-muted-foreground mt-1">Sensor não disponível</p>
          </div>
        </div>
      </div>

      {/* Saúde e Segurança do PC (camada PowerShell Windows, read-only) */}
      <PCHealthSection />
    </div>
  );
}
