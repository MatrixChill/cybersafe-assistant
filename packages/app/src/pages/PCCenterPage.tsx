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
import { cpuUsageDisplay } from "@/lib/cpuUsage";
import { ramUsageDisplay } from "@/lib/ramUsageDisplay";
import { networkReadingDisplay } from "@/lib/networkReadings";
import { batteryDisplay, snapshotAgeText, type BatteryOrigin } from "@/lib/batteryDisplay";
import { devHwTraceAttrs, type DevTraceConnection } from "@/lib/devTrace";
import type { DiskSnapshot, HardwareSnapshot, PcState, PcStateLevel } from "@cybersafe/shared-types";
import PCHealthSection from "@/components/PCHealthSection";import {
  TEMPERATURE_UNAVAILABLE_HINT,
  useTemperatureDisplay,
} from "@/lib/temperature";
import {
  GPU_ABSENT_HINT,
  GPU_ABSENT_LABEL,
  GPU_NO_SENSOR_LABEL,
  GPU_PENDING_HINT,
  GPU_PENDING_LABEL,
  gpuPresence,
} from "@/lib/gpuDisplay";
import {
  diskReadLabel,
  diskUnavailableText,
  diskUsagePercentText,
  diskVolumeRows,
  formatGb,
  formatPercent,
  safeNumber,
  useNow,
} from "@/lib/diskDisplay";
import {
  diskHealthLabel,
  diskHealthDetail,
  diskHealthUnavailable,
  DISK_HEALTH_PENDING_REASON,
} from "@/lib/diskHealth";

interface PCCenterPageProps {
  hardware: HardwareSnapshot | null;
  pcState?: PcState | null;
  /** Origem da leitura da bateria: LIVE (omissão), CACHED (última leitura real) ou UNAVAILABLE. */
  dataOrigin?: BatteryOrigin;
  /**
   * Estado real de ligação do commit que pinta esta página, para metadados DEV-only.
   * `null`/ausente em produção; nunca derivado de um ref dentro de `useMemo`.
   */
  devTraceConnection?: DevTraceConnection | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
}

function getUsageColor(percent: number | null): string {
  if (percent === null) return "text-muted-foreground";
  if (percent < 60) return "text-cyber-green";
  if (percent < 85) return "text-cyber-yellow";
  return "text-cyber-red";
}

function getUsageBgColor(percent: number): string {
  if (percent < 60) return "bg-cyber-green";
  if (percent < 85) return "bg-cyber-yellow";
  return "bg-cyber-red";
}

/**
 * Cartão de armazenamento do PC Center.
 *
 * Regra única, partilhada com o Dashboard (`lib/diskDisplay`): sem leitura
 * mostra-se "—"/"Indisponível" com o motivo; NUNCA `0,0%` nem `0,0 / 0,0 GB`.
 * Com leitura, mostra o volume principal em destaque e a lista por unidade
 * (capacidade, usado, livre, percentagem), com as partições reservadas do
 * sistema identificadas como tal em vez de contarem como discos de trabalho.
 */
function StorageCard({ disk }: { disk: DiskSnapshot }) {
  const primary = disk.primary;
  const rows = diskVolumeRows(disk);
  // `useNow` em vez de `Date.now()` no corpo do render (ver lib/diskDisplay).
  const problem = diskUnavailableText(disk, useNow());

  // Saúde do disco (SMART/NVMe) — P1, ainda NÃO implementada.
  //
  // Havia aqui um shell-out para PowerShell no renderer. Foi removido porque não
  // podia funcionar: o renderer corre com contextIsolation/!nodeIntegration, o Vite
  // externaliza `node:child_process` e a chamada falhava em runtime. O estado é
  // "Indisponível" ESCRITO COM MOTIVO — que é o que um dado ausente deve mostrar.
  // A leitura real passa a exigir um canal `service:disk-health` (ver lib/diskHealth).
  const health = diskHealthUnavailable(DISK_HEALTH_PENDING_REASON);

  return (
    <div className="bg-card cyber-border rounded-xl p-6 relative overflow-hidden group hover:border-primary/50 transition-colors">
      <div className="absolute inset-0 bg-gradient-to-b from-transparent to-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="flex flex-col h-full justify-between relative">
        <div>
          <div className="flex items-center gap-2 mb-4">
            <HardDrive className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Armazenamento</h2>
          </div>

          {primary ? (
            <>
              <div className="flex justify-between items-end mb-2">
                <span className="text-xs text-muted-foreground uppercase font-mono">
                  {primary.mount} · {primary.fileSystem}
                </span>
                <span className={cn("text-2xl font-bold font-mono", getUsageColor(safeNumber(primary.usagePercent) ?? 0))}>
                  {formatPercent(primary.usagePercent)}
                </span>
              </div>
              <div className="w-full h-3 bg-secondary rounded-full overflow-hidden mb-4">
                <div
                  className={cn("h-full transition-all duration-1000", getUsageBgColor(safeNumber(primary.usagePercent) ?? 0))}
                  style={{ width: `${safeNumber(primary.usagePercent) ?? 0}%` }}
                />
              </div>
            </>
          ) : (
            <div className="mb-4">
              <span className="text-2xl font-bold font-mono text-muted-foreground">—</span>
              <p className="text-xs text-muted-foreground mt-1 leading-snug">{problem}</p>
            </div>
          )}
        </div>

        <div className="flex justify-between text-sm font-mono">
          <div>
            <span className="text-xs text-muted-foreground uppercase block mb-1">Usado</span>
            <span className="font-medium text-foreground">{primary ? formatGb(primary.usedGb) : "—"}</span>
          </div>
          <div className="text-right">
            <span className="text-xs text-muted-foreground uppercase block mb-1">Livre / Total</span>
            <span className="font-medium">
              {primary ? `${formatGb(primary.freeGb)} / ${formatGb(primary.totalGb)}` : "—"}
            </span>
          </div>
        </div>

        {rows.length > 0 && (
          <div className="mt-4 pt-3 border-t border-border space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
                Unidades {disk.readStatus === "ok" ? "medidas agora" : diskReadLabel(disk)}
              </span>
              <span className="text-[11px] font-mono text-muted-foreground">Livre</span>
            </div>
            {rows.map((row) => (
              <div key={row.mount} className="flex items-center justify-between gap-3 text-xs font-mono">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-primary/70" />
                  <span className={cn("font-semibold", row.kind === "system-reserved" ? "text-muted-foreground" : "text-foreground")}>
                    {row.mount}
                  </span>
                  <span className="text-muted-foreground truncate">
                    {row.kind === "system-reserved" ? row.kindLabel : `${row.usedText} usados · ${row.usagePercentText}`}
                  </span>
                </span>
                <span className={cn("whitespace-nowrap", row.kind === "system-reserved" ? "text-muted-foreground" : getUsageColor(row.usagePercent))}>
                  {row.freeText}
                </span>
              </div>
            ))}
          </div>
        )}
        {health && (
          <div className="mt-4 pt-3 border-t border-border">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-muted-foreground uppercase">Saúde do disco</span>
              <span className={cn(
                "font-semibold",
                health.status === "healthy" ? "text-cyber-green" :
                health.status === "critical" ? "text-cyber-red" :
                health.status === "warning" ? "text-cyber-yellow" :
                "text-muted-foreground",
              )}>
                {diskHealthLabel(health.status)}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
              {diskHealthDetail(health)}
            </p>
          </div>
        )}
      </div>
    </div>
  );
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


function SimpleView({ hardware, pcState, batteryOrigin }: { hardware: HardwareSnapshot; pcState?: PcState | null; batteryOrigin: BatteryOrigin }) {
  const isStressed = hardware.stressScore > 75;
  const isWarning = hardware.stressScore > 50 && hardware.stressScore <= 75;
  const cpuUsage = cpuUsageDisplay(hardware.cpu);
  const ramUsage = ramUsageDisplay(hardware.ram);
  const netReading = networkReadingDisplay(hardware.network);
  const battery = batteryDisplay(hardware.battery, batteryOrigin);
  const nowMs = useNow();
  const ramAgeText = ramUsage.state === "stale" ? snapshotAgeText(ramUsage.updatedAt, nowMs) : null;
  const ramCardText = ramAgeText ? `${ramUsage.text} · ${ramAgeText}` : ramUsage.text;
  const batteryColor =
    battery.percent === null ? "text-muted-foreground" :
    battery.percent < 20 ? "text-cyber-red" :
    battery.percent < 50 ? "text-cyber-yellow" : "text-cyber-green";
  // Sem temperatura medida, a contribuição térmica é 0 — mas 0 medido e 0 "por
  // ausência de sensor" NÃO são a mesma afirmação. O rótulo diz qual é qual.
  const temperatureMeasured = hardware.cpu.temperature != null;
  const stressBreakdown: Array<{ label: string; value: number; max: number; unmeasured?: boolean }> = [
    { label: hardware.cpu?.usageStatus === "available" ? "CPU" : "CPU (s/ leitura)", value: hardware.stressContributions?.cpu ?? 0, max: 35, unmeasured: hardware.cpu?.usageStatus !== "available" },
    { label: ramUsage.state === "available" ? "RAM" : "RAM (s/ leitura)", value: hardware.stressContributions?.ram ?? 0, max: 30, unmeasured: ramUsage.state !== "available" },
    { label: "Temperatura", value: hardware.stressContributions?.temperature ?? 0, max: 25, unmeasured: !temperatureMeasured },
    { label: "GPU", value: hardware.stressContributions?.gpu ?? 0, max: 0 },
  ].filter((c) => c.max > 0);

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

          {/* Tres medidas diferentes na mesma pagina. Sem esta frase, o titulo do
              estado, o «Indice de Stress» e a «Saude do PC» leem-se como o mesmo
              numero dito de tres maneiras — e nao sao: uma e um veredicto, outra
              e carga instantanea e a terceira e uma leitura do Windows. */}
          <p className="mt-3 max-w-md text-[11px] leading-relaxed text-muted-foreground">
            São três medidas diferentes e não se somam: o título acima é o veredicto dos achados do
            sistema (se há problemas a precisar de intervenção); este «Índice de Stress» é a carga
            instantânea deste momento (CPU, RAM e temperatura, quando é medida); e a «Saúde do PC»,
            mais abaixo, é a nota lida ao Windows.
          </p>

          {/* Stress breakdown */}
          {hardware.stressContributions && (
            <div className="mt-4 w-full max-w-xs space-y-2">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider text-center mb-1">
                Contribuições (0–100)
              </div>
              {stressBreakdown.map((c) => (
                <div key={c.label} className="flex items-center gap-2 text-xs">
                  <span className="w-20 text-muted-foreground font-mono">{c.label}</span>
                  <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                    <div
                      className={cn("h-full rounded-full transition-all", getUsageBgColor(c.value > 0 ? (c.value / c.max) * 100 : 0))}
                      style={{ width: `${c.unmeasured ? 0 : (c.value / c.max) * 100}%` }}
                    />
                  </div>
                  {/* Sem sensor seguro não há medição térmica: "0" dizer-se-ia medido. */}
                  <span
                    className="w-14 text-right font-mono text-muted-foreground"
                    title={c.unmeasured ? "Temperatura não medida — não conta para o índice" : undefined}
                  >
                    {c.unmeasured ? "s/ leitura" : c.value}
                  </span>
                </div>
              ))}
              <p className="text-[10px] text-muted-foreground text-center mt-2">
                {temperatureMeasured
                  ? "Stress = carga instantânea (CPU + RAM + Temperatura). Capacidade de disco é tratada separadamente."
                  : "Stress = carga instantânea (CPU + RAM). A temperatura não é medida neste PC, por isso não entra no índice."}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Simple Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
        <div className="bg-card cyber-border rounded-xl p-6 flex flex-col items-center text-center group hover:border-primary/50 transition-all">
          <Cpu className={cn("w-8 h-8 mb-4", cpuUsage.value != null ? getUsageColor(cpuUsage.value) : "text-muted-foreground")} />
          <h3 className="font-semibold mb-1">Processador</h3>
          <span className={cn("text-2xl font-mono font-bold mb-2", cpuUsage.value != null ? getUsageColor(cpuUsage.value) : "text-muted-foreground")} title={cpuUsage.hint ?? undefined}>
            {cpuUsage.text}
          </span>
          <span className="text-xs text-muted-foreground">Utilização atual</span>
        </div>

        <div className="bg-card cyber-border rounded-xl p-6 flex flex-col items-center text-center group hover:border-primary/50 transition-all">
          <MemoryStick className={cn("w-8 h-8 mb-4", getUsageColor(ramUsage.value))} />
          <h3 className="font-semibold mb-1">Memória RAM</h3>
          <span className={cn("text-2xl font-mono font-bold mb-2", getUsageColor(ramUsage.value))}>
            {ramCardText}
          </span>
          <span className="text-xs text-muted-foreground">{ramUsage.usedText}</span>
        </div>

        <div className="bg-card cyber-border rounded-xl p-6 flex flex-col items-center text-center group hover:border-primary/50 transition-all">
          <HardDrive
            className={cn(
              "w-8 h-8 mb-4",
              hardware.disk.usagePercent === null ? "text-muted-foreground" : getUsageColor(hardware.disk.usagePercent),
            )}
          />
          <h3 className="font-semibold mb-1">Armazenamento</h3>
          <span
            className={cn(
              "text-2xl font-mono font-bold mb-2",
              hardware.disk.usagePercent === null ? "text-muted-foreground" : getUsageColor(hardware.disk.usagePercent),
            )}
          >
            {/* Sem leitura é "—": antes escrevia-se 0%, que é uma afirmação falsa. */}
            {diskUsagePercentText(hardware.disk)}
          </span>
          <span className="text-xs text-muted-foreground">
            {hardware.disk.primary
              ? `Capacidade usada em ${hardware.disk.primary.mount}`
              : diskReadLabel(hardware.disk)}
          </span>
        </div>

        <div className="bg-card cyber-border rounded-xl p-6 flex flex-col items-center text-center group hover:border-primary/50 transition-all">
          <Wifi className="w-8 h-8 text-primary mb-4" />
          <h3 className="font-semibold mb-1">Rede Local</h3>
          <div className="flex items-center justify-center gap-4 mb-2">
            <div className="flex items-center gap-1">
              <ChevronDown className="w-4 h-4 text-cyber-cyan" />
              <span className="text-sm font-mono font-bold text-cyber-cyan">{netReading.rxSec != null ? formatBytes(netReading.rxSec) : "—"}</span>
            </div>
            <div className="flex items-center gap-1">
              <ChevronUp className="w-4 h-4 text-primary" />
              <span className="text-sm font-mono font-bold text-primary">{netReading.txSec != null ? formatBytes(netReading.txSec) : "—"}</span>
            </div>
          </div>
          <span className="text-xs text-muted-foreground mt-1" title={netReading.hint ?? undefined}>{netReading.state === "available" ? "Tráfego atual" : netReading.label}</span>
        </div>

        {/* Bateria: contrato real; sem leitura nunca é 0%, e a origem é sempre marcada. */}
        <div data-testid="simple-battery" className="bg-card cyber-border rounded-xl p-6 flex flex-col items-center text-center group hover:border-primary/50 transition-all">
          <Battery className={cn("w-8 h-8 mb-4", batteryColor)} />
          <h3 className="font-semibold mb-1">Bateria</h3>
          <span className={cn("text-2xl font-mono font-bold mb-2", batteryColor)}>{battery.percentText ?? "—"}</span>
          <span className="text-xs text-muted-foreground">{battery.label}</span>
          {battery.chargingText && (
            <span className="text-xs text-muted-foreground mt-1">
              {battery.chargingText}{battery.timeText ? ` · ${battery.timeText}` : ""}
            </span>
          )}
          {hardware.battery.status === "present" && snapshotAgeText(hardware.battery.updatedAt, nowMs) && (
            <span className="text-[10px] text-muted-foreground/70 mt-1 font-mono">Lida {snapshotAgeText(hardware.battery.updatedAt, nowMs)}</span>
          )}
          {battery.originText && <span className="text-[10px] text-muted-foreground/70 mt-1 font-mono">{battery.originText}</span>}
          {battery.hint && <p className="text-[10px] text-muted-foreground mt-1 leading-snug">{battery.hint}</p>}
          {battery.snapshotNote && <p className="text-[10px] text-muted-foreground/70 mt-1 leading-snug">{battery.snapshotNote}</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * Aviso comum de snapshot em cache (TP-3H-CACHED-NOTICE-FIX): o snapshot inteiro
 * (CPU, RAM, disco, rede, bateria) e a ultima leitura real guardada, nao uma medicao
 * atual. A idade so aparece com timestamp valido.
 */
export function CachedSnapshotNotice({ origin, ageText }: { origin: BatteryOrigin; ageText: string | null }) {
  if (origin !== "CACHED") return null;
  return (
    <div role="status" className="rounded-xl border border-cyber-yellow/30 bg-cyber-yellow/10 p-3 text-center text-xs font-mono text-cyber-yellow">
      Última leitura guardada{ageText ? ` · ${ageText}` : " · idade desconhecida"}. Sem ligação ao serviço: estes valores não são atuais.
    </div>
  );
}
export function AdvancedView({ hardware, batteryOrigin }: { hardware: HardwareSnapshot; batteryOrigin: BatteryOrigin }) {
  const ramUsage = ramUsageDisplay(hardware.ram);
  const nowMs = useNow();
  const ramAgeText = ramUsage.state === "stale" ? snapshotAgeText(ramUsage.updatedAt, nowMs) : null;
  const ramCardText = ramAgeText ? `${ramUsage.text} · ${ramAgeText}` : ramUsage.text;
  // Hooks antes de qualquer return antecipado. Canal por sensor: o prazo de
  // "indisponível" da CPU não é reiniciado pelo da GPU (e vice-versa).
  const cpuTemperature = useTemperatureDisplay(hardware?.cpu?.temperature ?? null, { channel: "cpu" });
  const gpuTemperature = useTemperatureDisplay(hardware?.gpu?.temperature ?? null, { channel: "gpu" });
  const cpuUsage = cpuUsageDisplay(hardware?.cpu);
  const netReading = networkReadingDisplay(hardware?.network);
  // Bateria: decide pelo status (C2). Sem status, só o legado hasBattery.
  const batteryDisp = batteryDisplay(hardware?.battery, batteryOrigin);
  const batteryCardVisible = hardware?.battery?.status !== undefined || hardware?.battery?.hasBattery === true;

  if (!hardware) {
    return <LoadingSkeleton />;
  }

  // "sem leitura" (null) e "não detetada" (available === false) são estados
  // diferentes: nunca se acusa o hardware de estar ausente por falta de leitura.
  const gpu = gpuPresence(hardware.gpu);

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
                    <div className="mt-3 flex items-start gap-2 bg-black/20 p-3 rounded-lg border border-border">
                      <Zap className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                      <div>
                        <span className="text-xs font-semibold text-primary uppercase block mb-1">Recomendação</span>
                        <p className="text-sm text-muted-foreground">{alert.recommendation}</p>
                      </div>
                    </div>
                  </div>
                  {alert.process && (
                    <div className="flex-shrink-0 min-w-[200px] bg-black/20 rounded-lg p-3 border border-border h-fit">
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
            <CircularGauge value={cpuUsage.value ?? 0} label={cpuUsage.value == null ? "N/A" : cpuUsage.state === "stale" ? "Última" : "Uso"} showFallback={cpuUsage.value == null} />
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
            {ramUsage.value !== null ? <CircularGauge value={ramUsage.value} label="Uso" /> : <span className="text-sm text-muted-foreground">{ramCardText}</span>}
            <div className="flex flex-col gap-3 text-right">
              <div>
                <span className="text-xs text-muted-foreground uppercase block">Em Uso</span>
                <span className={cn("text-lg font-bold font-mono", getUsageColor(ramUsage.value))}>
                  {ramUsage.usedText}
                </span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground uppercase block">Disponível</span>
                <span className="text-sm font-medium font-mono">
                  {ramUsage.freeText}
                </span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground uppercase block">Total</span>
                <span className="text-sm font-medium font-mono">{ramUsage.totalText}</span>
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

          {hardware.gpu && gpu !== "absent" ? (
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
          ) : (
            <div className="flex flex-col items-center justify-center h-24 text-muted-foreground">
              <Monitor className="w-8 h-8 mb-2 opacity-20" />
              <span
                className="text-sm font-medium cursor-help"
                title={gpu === "absent" ? GPU_ABSENT_HINT : GPU_PENDING_HINT}
              >
                {gpu === "absent" ? GPU_ABSENT_LABEL : GPU_PENDING_LABEL}
              </span>
            </div>
          )}
        </div>

        {/* Disk Card — a mesma regra do Dashboard vive em StorageCard/lib/diskDisplay */}
        <StorageCard disk={hardware.disk} />

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
                {netReading.interfaceName ? `${netReading.interfaceName}${netReading.label ? ` · ${netReading.label}` : ""}` : netReading.label}
              </span>
            </div>

            <div className="flex-grow flex flex-col justify-center gap-6">
              <div className="flex items-center justify-between bg-black/20 p-4 rounded-lg border border-border">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-cyber-cyan/10 rounded-full">
                    <ChevronDown className="w-5 h-5 text-cyber-cyan" />
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground uppercase block">Download</span>
                    <span className="text-xl font-bold font-mono text-cyber-cyan">
                      {netReading.rxSec != null ? formatBytes(netReading.rxSec) : "—"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between bg-black/20 p-4 rounded-lg border border-border">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-primary/10 rounded-full">
                    <ChevronUp className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground uppercase block">Upload</span>
                    <span className="text-xl font-bold font-mono text-primary">
                      {netReading.txSec != null ? formatBytes(netReading.txSec) : "—"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Battery Card (Conditionally Rendered) */}
        {batteryCardVisible && (
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
                    {batteryDisp.percent ?? "—"}
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
                    style={{ width: `${batteryDisp.percent ?? 0}%` }}
                  />
                </div>
              </div>

              <div className="text-center mt-auto">
                <span className="text-xs text-muted-foreground uppercase block mb-1">Status</span>
                <span className="font-mono text-sm text-foreground">
                  {batteryDisp.chargingText ?? batteryDisp.label}
                  {batteryDisp.timeText && (
                    <span className="text-muted-foreground ml-2">
                      ({batteryDisp.timeText})
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
                  <tr key={idx} className="border-b border-border last:border-0 hover:bg-secondary/50 transition-colors">
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
                  <tr key={idx} className="border-b border-border last:border-0 hover:bg-secondary/50 transition-colors">
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


export default function PCCenterPage({ hardware, pcState, dataOrigin, devTraceConnection }: PCCenterPageProps) {
  const [viewMode, setViewMode] = useState<"simple" | "advanced">("simple");
  // Hooks antes de qualquer return antecipado.
  const cpuTemperature = useTemperatureDisplay(hardware?.cpu?.temperature ?? null, { channel: "cpu" });
  const gpuTemperature = useTemperatureDisplay(hardware?.gpu?.temperature ?? null, { channel: "gpu" });
  const nowMs = useNow();
  const snapshotAge = snapshotAgeText(hardware?.timestamp, nowMs);

  if (!hardware) {
    return <LoadingSkeleton />;
  }

  // Ver nota em `AdvancedView`: `null` é "sem leitura", `available === false` é
  // "não detetada". Os dois cartões de GPU respondem pela mesma função.
  const gpu = gpuPresence(hardware.gpu);

  // Metadados DEV-only, calculados no commit que pinta esta amostra — sem `useMemo` sobre
  // refs e sem `Date.now()` obrigatório. Fora de DEV o objecto é vazio: nem atributos, nem
  // trabalho extra no render (o custo evitado é CPU/render, não memória do DOM).
  const devTraceAttrs = devHwTraceAttrs({
    dev: import.meta.env?.DEV === true,
    hardware,
    origin: dataOrigin ?? null,
    connection: devTraceConnection ?? null,
  });

  return (
    <div className="w-full h-full p-6 space-y-6 animate-in fade-in slide-in-from-bottom-4 overflow-y-auto" {...devTraceAttrs}>
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
              viewMode === "simple" ? "bg-primary text-primary-foreground" : "hover:bg-secondary/50 text-muted-foreground")}
          >
            <LayoutGrid className="w-4 h-4" />
            Visão Simples
          </button>
          <button
            onClick={() => setViewMode("advanced")}
            className={cn("flex items-center gap-2 px-4 py-2 rounded-md transition-colors text-sm font-medium",
              viewMode === "advanced" ? "bg-primary text-primary-foreground" : "hover:bg-secondary/50 text-muted-foreground")}
          >
            <Settings className="w-4 h-4" />
            Visão Avançada
          </button>
        </div>
      </div>

      <CachedSnapshotNotice origin={dataOrigin ?? "LIVE"} ageText={snapshotAge} />
      {viewMode === "simple" ? (
        <SimpleView hardware={hardware} pcState={pcState} batteryOrigin={dataOrigin ?? "LIVE"} />
      ) : (
        <AdvancedView hardware={hardware} batteryOrigin={dataOrigin ?? "LIVE"} />
      )}

      {/* Temperatures & Sensors */}
      <div className="bg-card cyber-border rounded-xl p-6 relative overflow-hidden group hover:border-primary/50 transition-colors">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="flex items-center gap-2 mb-6">
          <Thermometer className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Temperaturas e Sensores</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-secondary/30 rounded-lg p-4 border border-border">
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

          {hardware.gpu && gpu !== "absent" ? (
            <div className="bg-secondary/30 rounded-lg p-4 border border-border">
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
                <>
                  <span className="text-sm font-mono text-muted-foreground" title={TEMPERATURE_UNAVAILABLE_HINT}>{gpuTemperature.text}</span>
                  {/* A placa ESTÁ detetada: sem o modelo aqui, a falta de
                      temperatura lia-se como falta de placa gráfica. */}
                  <p className="text-xs text-muted-foreground mt-1 font-mono truncate" title={hardware.gpu.model}>{hardware.gpu.model}</p>
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5 font-mono">{GPU_NO_SENSOR_LABEL}</p>
                </>
              )}
            </div>
          ) : (
            <div className="bg-secondary/30 rounded-lg p-4 border border-border opacity-50">
              <div className="flex items-center gap-2 mb-2">
                <Monitor className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase font-mono">GPU</span>
              </div>
              <span
                className="text-lg font-mono text-muted-foreground cursor-help"
                title={gpu === "absent" ? GPU_ABSENT_HINT : GPU_PENDING_HINT}
              >
                {gpu === "absent" ? GPU_ABSENT_LABEL : GPU_PENDING_LABEL}
              </span>
            </div>
          )}

          <div className="bg-secondary/30 rounded-lg p-4 border border-border opacity-50">
            <div className="flex items-center gap-2 mb-2">
              <HardDrive className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground uppercase font-mono">NVMe/SSD</span>
            </div>
            <span className="text-lg font-mono text-muted-foreground">—</span>
            <p className="text-xs text-muted-foreground mt-1">Sensor não disponível</p>
          </div>

          <div className="bg-secondary/30 rounded-lg p-4 border border-border opacity-50">
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
