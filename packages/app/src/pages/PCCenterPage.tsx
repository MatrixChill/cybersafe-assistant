import { useState, useEffect } from "react";
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
import { buildFindingGuidance, type DiskSnapshot, type HardwareSnapshot, type PcState, type PcStateLevel, type PcUsageMetric } from "@cybersafe/shared-types";
import PCHealthSection from "@/components/PCHealthSection";
import PcCenterVisual from "@/components/pccenter/PcCenterVisual";
import PcExplanations from "@/components/pccenter/PcExplanations";
import { TechnicalDiagnostic, redactDiagnostic } from "@/components/TechnicalDiagnostic";
import { StorageHealthPanel } from "@/components/StorageHealthPanel";
import { HardwareDetailPanel } from "@/components/HardwareDetailPanel";
import { classeDeUso, classeTermica, fundoDeUso, motivoTermico, notaTermica } from "@/lib/healthBands";
import { TelemetrySparkline, useTelemetryHistory } from "@/components/TelemetrySparkline";
import {
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
  DISK_ATIVIDADE_FONTE,
  diskActivityRows,
  diskAtividadeIndisponivelTexto,
} from "@/lib/diskActivityDisplay";

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

function getUsageColor(metric: PcUsageMetric, percent: number | null | undefined): string {
  return classeDeUso(metric, percent);
}

function getUsageBgColor(metric: PcUsageMetric, percent: number | null | undefined): string {
  return fundoDeUso(metric, percent);
}

/* ── Telemetria COM proveniência (TP-RC22-PCCENTER) ──────────────────────────
   Só se mostra o que o contrato JÁ mede. A saúde física (modelo, tipo,
   capacidade e contadores) chega em `disk.physical` e é apresentada em
   StorageHealthPanel. O que não existe (taxas de leitura/escrita, sensor da
   placa) não é estimado: fica "não lido", com o motivo. Helpers puros para
   poderem ser testados sem DOM. */

/** Percentagem de VRAM: só com dois números medidos; `null` se faltar um. */
export function vramPercentOf(
  usedMb: number | null | undefined,
  totalMb: number | null | undefined,
): number | null {
  if (typeof usedMb !== "number" || !Number.isFinite(usedMb) || usedMb < 0) return null;
  if (typeof totalMb !== "number" || !Number.isFinite(totalMb) || totalMb <= 0) return null;
  return Math.round(Math.min(100, (usedMb / totalMb) * 100));
}

/** Texto da VRAM: "1,2 / 6,0 GB · 20%", ou "—" quando não há leitura. */
export function vramReadout(gpu: HardwareSnapshot["gpu"]): { text: string; percent: number | null } {
  if (gpu?.available === false) return { text: "—", percent: null };
  const total = gpu?.vramTotalMb ?? null;
  const rawUsed = gpu?.vramUsedMb;
  const used = typeof rawUsed === "number" && Number.isFinite(rawUsed) && rawUsed >= 0 && total != null && rawUsed <= total ? rawUsed : null;
  if (total == null || !Number.isFinite(total) || !(total > 0)) return { text: "—", percent: null };
  const percent = vramPercentOf(used, total);
  const usedText = used != null ? `${(used / 1024).toFixed(1)} / ` : "";
  return {
    text: `${usedText}${(total / 1024).toFixed(1)} GB${percent != null ? ` · ${percent}%` : ""}`,
    percent,
  };
}

/** Proveniência da temperatura da GPU: sensor · fonte · aviso de cache. */
export function gpuTemperatureProvenance(gpu: HardwareSnapshot["gpu"]): string {
  if (!gpu) return "";
  const sensor = gpu.temperatureSensor?.trim() || "GPU Core";
  const source = gpu.temperatureSource?.trim();
  const stale = gpu.temperatureStatus === "stale" ? "última leitura guardada" : "";
  return [sensor, source, stale].filter(Boolean).join(" · ");
}

/** Sensores secundários da GPU que o contrato expõe (hotspot/junction), nunca o core duplicado. */
export function secondaryGpuTemperatures(
  gpu: HardwareSnapshot["gpu"],
): Array<{ label: string; value: number }> {
  if (!gpu) return [];
  const core = gpu.coreTemperature ?? gpu.temperature ?? null;
  const rows: Array<{ label: string; value: number }> = [];
  const add = (label: string, value: number | null | undefined) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
    if (core != null && value === core) return;
    rows.push({ label, value });
  };
  add("Hotspot", gpu.hotspotTemperature);
  add("Memory Junction", gpu.memoryJunctionTemperature);
  return rows;
}

/** Leitura de bateria para o cartão: sem percentagem NÃO há barra nem "— %". */
export function batteryReadout(percent: number | null): { text: string; width: number | null } {
  if (percent === null || !Number.isFinite(percent)) return { text: "—", width: null };
  const width = Math.min(100, Math.max(0, percent));
  // O número vai sozinho; a unidade é desenhada à parte e SÓ com leitura.
  return { text: `${Math.round(width)}`, width };
}

/** Proveniência da leitura de armazenamento: agora, última leitura boa, ou motivo. */
export function diskReadProvenance(disk: DiskSnapshot, nowMs: number): string {
  const reason = disk.reason?.trim() || "O Windows não devolveu uma leitura do armazenamento.";
  if (disk.readStatus === "ok") return "Volumes medidos agora pelo serviço.";
  const age = snapshotAgeText(disk.lastGoodAt, nowMs);
  if (disk.readStatus === "stale") return age ? `${reason} Último valor bom ${age}.` : reason;
  return reason;
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
  // Atividade = outra aquisição (PDH) e outro estado. Só entra quando o motor
  // mediu no intervalo actual; sem medição mostramos o motivo, nunca os números
  // do intervalo anterior.
  const atividade = diskActivityRows(disk);
  // `useNow` em vez de `Date.now()` no corpo do render (ver lib/diskDisplay).
  const nowMs = useNow();
  const problem = diskUnavailableText(disk, nowMs) ? diskReadProvenance(disk, nowMs) : null;
  const readSummary = disk.readStatus === "ok"
    ? "Volumes medidos agora pelo serviço."
    : disk.readStatus === "stale"
      ? `Última leitura válida${snapshotAgeText(disk.lastGoodAt, nowMs) ? ` ${snapshotAgeText(disk.lastGoodAt, nowMs)}` : ""}. Sem medição nova do armazenamento.`
      : "Leitura do armazenamento indisponível.";

  // A saúde física chega no contrato (`disk.physical`), lida no processo do
  // serviço. O renderer só apresenta: não faz shell-out nem inventa contadores.

  return (
    <div className="bg-card cyber-border rounded-xl p-6 relative group hover:border-primary/50 transition-colors">
      <div className="absolute inset-0 rounded-xl bg-gradient-to-b from-transparent to-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="relative flex min-w-0 max-w-full flex-col [overflow-wrap:anywhere]">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <HardDrive className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Armazenamento</h2>
          </div>

          {primary ? (
            <>
              <div className="flex flex-wrap justify-between items-end gap-2 mb-2">
                <span className="text-xs text-muted-foreground uppercase font-mono">
                  {redactDiagnostic(primary.mount)} · {redactDiagnostic(primary.fileSystem)}
                </span>
                <span className={cn("text-2xl font-bold font-mono", getUsageColor("disk", safeNumber(primary.usagePercent)))}>
                  {formatPercent(primary.usagePercent)}
                </span>
              </div>
              <div className="w-full h-3 bg-secondary rounded-full overflow-hidden mb-4">
                <div
                  className={cn("h-full transition-all duration-1000", getUsageBgColor("disk", safeNumber(primary.usagePercent)))}
                  style={{ width: `${safeNumber(primary.usagePercent) ?? 0}%` }}
                />
              </div>
            </>
          ) : (
            <div className="mb-4">
              <span className="text-2xl font-bold font-mono text-muted-foreground">—</span>
              <p className="text-xs text-muted-foreground mt-1 leading-snug">{readSummary}</p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap justify-between gap-3 text-sm font-mono tabular-nums">
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
              <div key={row.mount} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs font-mono">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-primary/70" />
                  <span className={cn("font-semibold", row.kind === "system-reserved" ? "text-muted-foreground" : "text-foreground")}>
                    {redactDiagnostic(row.mount)}
                  </span>
                  <span className="text-muted-foreground min-w-0 [overflow-wrap:anywhere]">
                    {row.kind === "system-reserved" ? row.kindLabel : `${row.usedText} usados · ${row.usagePercentText}`}
                  </span>
                </span>
                <span className={cn("whitespace-nowrap", row.kind === "system-reserved" ? "text-muted-foreground" : getUsageColor("disk", row.usagePercent))}>
                  {row.freeText}
                </span>
              </div>
            ))}
          </div>
        )}
        {atividade.length > 0 ? (
          <div data-testid="disk-activity" className="mt-3 pt-3 border-t border-border space-y-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
                Atividade medida
              </span>
              <span className="text-[11px] font-mono text-muted-foreground">Leitura / Escrita</span>
            </div>
            {atividade.map((linha) => (
              <div
                key={linha.chave}
                data-testid="disk-activity-row"
                title={linha.fonte}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs font-mono tabular-nums"
              >
                <span className={cn("min-w-0", linha.agregado ? "text-muted-foreground" : "font-semibold text-foreground")}>
                  {linha.agregado ? linha.rotulo : redactDiagnostic(linha.rotulo)}
                </span>
                <span className="flex items-center gap-3 whitespace-nowrap">
                  <span className="flex items-center gap-1 text-muted-foreground" title="Bytes lidos por segundo">
                    <ChevronDown className="w-3 h-3" />
                    <span className="text-foreground">{linha.leituraTexto}</span>
                  </span>
                  <span className="flex items-center gap-1 text-muted-foreground" title="Bytes escritos por segundo">
                    <ChevronUp className="w-3 h-3" />
                    <span className="text-foreground">{linha.escritaTexto}</span>
                  </span>
                </span>
              </div>
            ))}
            <p
              data-testid="disk-activity-provenance"
              className="text-[10px] font-mono leading-snug text-muted-foreground"
            >
              {DISK_ATIVIDADE_FONTE}
            </p>
          </div>
        ) : (
          <p
            data-testid="disk-activity-state"
            className="mt-3 pt-2 border-t border-border text-[10px] font-mono leading-snug text-muted-foreground"
          >
            {diskAtividadeIndisponivelTexto(disk)}
          </p>
        )}
        {/* Proveniência da leitura: agora, última leitura boa, ou o motivo real. */}
        <p
          data-testid="disk-read-provenance"
          className="mt-2 text-[10px] font-mono leading-snug text-muted-foreground"
        >
          {readSummary}
        </p>
        {problem && <TechnicalDiagnostic summary="Diagnóstico da leitura dos volumes." details={problem} />}
        {/* O contrato passou a trazer saúde física: o resumo compacto fica no
            cartão. As leituras e os motivos por disco vivem numa superfície
            expansível fora desta grelha, para não esticar Rede/Bateria.
            Healthy ≠ SMART validado. */}
        <div data-testid="disk-smart-note">
          <StorageHealthPanel disk={disk} nowMs={nowMs} mode="summary" />
        </div>
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

function CircularGauge({ value, metric, size = 100, label, showFallback }: { value: number; metric: PcUsageMetric; size?: number; label?: string; showFallback?: boolean }) {
  const strokeWidth = 10;
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const strokeDashoffset = circumference - (value / 100) * circumference;
  const colorClass = getUsageColor(metric, value);

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
  /**
   * Sem nenhuma entrada medida, `stressScore` é 0 por AUSÊNCIA de soma — não
   * uma medição de carga zero. Só se apresenta o índice quando há pelo menos
   * uma leitura atual (CPU/RAM) ou térmica; snapshots antigos sem
   * `stressContributions` só provam medição quando o índice é > 0.
   */
  const stressMeasured = hardware.stressContributions
    ? cpuUsage.state === "available" || ramUsage.state === "available" || temperatureMeasured
    : hardware.stressScore > 0;
  const stressBreakdown: Array<{ label: string; value: number; max: number; unmeasured?: boolean }> = [
    { label: hardware.cpu?.usageStatus === "available" ? "CPU" : "CPU (s/ leitura)", value: hardware.stressContributions?.cpu ?? 0, max: 35, unmeasured: hardware.cpu?.usageStatus !== "available" },
    { label: ramUsage.state === "available" ? "RAM" : "RAM (s/ leitura)", value: hardware.stressContributions?.ram ?? 0, max: 30, unmeasured: ramUsage.state !== "available" },
    { label: "Temperatura", value: hardware.stressContributions?.temperature ?? 0, max: 25, unmeasured: !temperatureMeasured },
    { label: "GPU", value: hardware.stressContributions?.gpu ?? 0, max: 0 },
  ].filter((c) => c.max > 0);

  // O título «Achados do sistema» é o veredicto do motor de estado (PcState) —
  // NUNCA o stress. Antes, sem PcState, o valor por omissão era «Sistema
  // Saudável» e o stress (0 por falta de leitura) confirmava-o: a ausência de
  // dados era pintada como boa notícia. Sem leitura, diz-se que não há leitura.
  const metaDoEstado = pcState?.overall ? overallStatusMeta(pcState.overall) : null;
  const statusTitle = metaDoEstado?.title ?? "Estado dos achados indisponível";
  const statusColor = metaDoEstado?.colorClass ?? "text-cyber-cyan";
  const statusBg = metaDoEstado?.bgClass ?? "bg-cyber-cyan/10";
  const statusBorder = metaDoEstado?.borderClass ?? "border-cyber-cyan/30";
  const StatusIcon = metaDoEstado?.StatusIcon ?? HelpCircle;
  const statusMessage = metaDoEstado?.message
    ?? "O serviço ainda não devolveu uma avaliação dos achados do sistema. A carga abaixo é telemetria, não um veredicto.";
  const principalFinding = pcState?.principalFinding ?? null;
  const principalGuidance = principalFinding ? buildFindingGuidance(principalFinding) : null;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4">

      {/* Main Status */}
      <div className={cn("flex flex-col items-center text-center p-8 rounded-xl border cyber-border bg-card", statusBorder)}>
        <div className={cn("p-6 rounded-full mb-6 relative", statusBg)}>
          <div className={cn("absolute inset-0 rounded-full animate-ping opacity-20", statusBg)} />
          <StatusIcon className={cn("w-16 h-16", statusColor)} />
        </div>
        {/* Domínio explícito: este título é o veredicto dos achados, não a carga
            instantânea nem a avaliação derivada dos dados do Windows. */}
        <span className="mb-1 block font-mono text-xs uppercase tracking-[0.09em] text-muted-foreground">Achados do sistema</span>
        <h2 className={cn("text-3xl font-bold mb-2", statusColor)}>{statusTitle}</h2>
        <p className="text-muted-foreground max-w-lg mx-auto">{statusMessage}</p>
        {/* AG-08: Diagnóstico e orientação concreta quando há achados relevantes (ex: ClamAV degradado ou serviço parado) */}
        {principalFinding && (
          <div data-testid="principal-finding-guidance" className="mt-4 max-w-lg mx-auto p-3.5 rounded-lg bg-secondary/50 border border-border text-left space-y-1.5 font-sans">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-xs uppercase tracking-wide text-foreground">
                {principalFinding.title}
              </span>
              <span className={cn("text-[10px] font-mono uppercase px-1.5 py-0.5 rounded",
                principalFinding.severity === "urgent" ? "bg-cyber-red/20 text-cyber-red font-bold" : "bg-cyber-yellow/20 text-cyber-yellow"
              )}>
                {principalGuidance?.prioridade ?? principalFinding.severity}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{principalFinding.summary}</p>
            {principalGuidance?.orientacao && (
              <p className="text-xs text-primary font-medium">{principalGuidance.orientacao}</p>
            )}
          </div>
        )}

        <div className="mt-8 flex w-full flex-col items-center border-t border-border pt-4">
          <span className="mb-1 block font-mono text-xs uppercase tracking-[0.09em] text-muted-foreground">Carga de desempenho</span>
          <span className="mt-1 mb-2 text-xs uppercase tracking-wider text-muted-foreground">Índice de Stress</span>
          <div className="flex items-center gap-2">
            <Gauge className={cn("w-6 h-6", stressMeasured ? getUsageColor("stress", hardware.stressScore) : "text-muted-foreground")} />
            <span
              className={cn("text-3xl font-mono font-bold", stressMeasured ? getUsageColor("stress", hardware.stressScore) : "text-muted-foreground")}
              title={stressMeasured ? undefined : "Sem CPU, RAM ou temperatura medidos nesta leitura: o índice não pode ser calculado."}
            >
              {stressMeasured ? <>{hardware.stressScore}/100</> : "—/100"}
            </span>
          </div>
          {!stressMeasured && (
            <p className="mt-1 max-w-md text-center text-[11px] leading-relaxed text-muted-foreground">
              Sem CPU, RAM ou temperatura medidos nesta leitura; o índice de stress não é 0, é desconhecido.
            </p>
          )}

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
                      className={cn("h-full rounded-full transition-all", getUsageBgColor("cpu", c.value > 0 ? (c.value / c.max) * 100 : 0))}
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

      {/* Simple Stats Grid — três leituras principais e, numa linha própria,
          rede e bateria: evita cinco colunas estreitas e cartões vazios. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <div className="bg-card cyber-border rounded-xl p-6 flex flex-col items-center text-center group hover:border-primary/50 transition-all">
          <Cpu className={cn("w-8 h-8 mb-4", cpuUsage.value != null ? getUsageColor("cpu", cpuUsage.value) : "text-muted-foreground")} />
          <h3 className="font-semibold mb-1">Processador</h3>
          <span className={cn("text-2xl font-mono font-bold mb-2", cpuUsage.value != null ? getUsageColor("cpu", cpuUsage.value) : "text-muted-foreground")} title={cpuUsage.hint ?? undefined}>
            {cpuUsage.text}
          </span>
          <span className="text-xs text-muted-foreground">Utilização atual</span>
        </div>

        <div className="bg-card cyber-border rounded-xl p-6 flex flex-col items-center text-center group hover:border-primary/50 transition-all">
          <MemoryStick className={cn("w-8 h-8 mb-4", getUsageColor("ram", ramUsage.value))} />
          <h3 className="font-semibold mb-1">Memória RAM</h3>
          <span className={cn("text-2xl font-mono font-bold mb-2", getUsageColor("ram", ramUsage.value))}>
            {ramCardText}
          </span>
          <span className="text-xs text-muted-foreground">{ramUsage.usedText}</span>
        </div>

        <div className="bg-card cyber-border rounded-xl p-6 flex flex-col items-center text-center group hover:border-primary/50 transition-all">
          <HardDrive
            className={cn(
              "w-8 h-8 mb-4",
              hardware.disk.usagePercent === null ? "text-muted-foreground" : getUsageColor("disk", hardware.disk.usagePercent),
            )}
          />
          <h3 className="font-semibold mb-1">Armazenamento</h3>
          <span
            className={cn(
              "text-2xl font-mono font-bold mb-2",
              hardware.disk.usagePercent === null ? "text-muted-foreground" : getUsageColor("disk", hardware.disk.usagePercent),
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

      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-card cyber-border rounded-xl p-6 flex flex-col items-center text-center group hover:border-primary/50 transition-all">
          <Wifi className="w-8 h-8 text-primary mb-4" />
          <h3 className="font-semibold mb-1">Rede Local</h3>
          {netReading.rxSec != null || netReading.txSec != null ? (
            <>
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
            </>
          ) : (
            <span className="text-sm text-muted-foreground" title={netReading.hint ?? undefined}>{netReading.label}</span>
          )}
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
          {battery.healthText && (
            <span data-testid="simple-battery-health" className="text-[10px] text-muted-foreground/70 mt-1 font-mono">
              {battery.healthText}{battery.capacityText ? ` · ${battery.capacityText}` : ""}
            </span>
          )}
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
  // Sem percentagem lida não há barra nem «— %»: só o texto do estado.
  const batteryCard = batteryReadout(batteryDisp.percent);
  const vramCard = vramReadout(hardware?.gpu ?? null);
  // Os gráficos só consomem os buffers que a aquisição já enche (App.tsx): nenhum
  // canal novo pergunta ao Windows. Cada métrica tem o seu buffer, por isso a
  // temperatura ausente não arrasta o gráfico da carga.
  const cpuUseHistory = useTelemetryHistory("cpu", 2000);
  const cpuTempHistory = useTelemetryHistory("cpu-temp", 2000);
  const ramUseHistory = useTelemetryHistory("ram", 2000);
  const gpuUseHistory = useTelemetryHistory("gpu", 2000);
  const gpuTempHistory = useTelemetryHistory("gpu-temp", 2000);

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

      {/* Main Grid: items-start mantém cada cartão na altura natural. Sem
          isto, a grelha esticava Rede/Bateria para a altura do cartão vizinho. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 items-start">

        {/* CPU Card */}
        <div className="bg-card cyber-border rounded-xl p-6 relative overflow-hidden group hover:border-primary/50 transition-colors">
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
          <div className="flex items-center gap-2 mb-6">
            <Cpu className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Processador (CPU)</h2>
          </div>
          <div className="flex items-center justify-between">
            <CircularGauge value={cpuUsage.value ?? 0} metric="cpu" label={cpuUsage.value == null ? "N/A" : cpuUsage.state === "stale" ? "Última" : "Uso"} showFallback={cpuUsage.value == null} />
            <div className="flex flex-col gap-3 text-right min-w-0">
              <div>
                <span className="text-xs text-muted-foreground uppercase block">Modelo</span>
                <span className="text-sm font-medium font-mono text-foreground break-words max-w-[18rem]" title={hardware.cpu.model}>
                  {hardware.cpu.model}
                </span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground uppercase block">Velocidade & Cores</span>
                <span className="text-sm font-medium font-mono">{hardware.cpu.speed} GHz / {hardware.cpu.cores} Cores</span>
              </div>
              <div>
                <span className="text-xs text-muted-foreground uppercase block">Temperatura</span>
                <span className={cn("text-sm font-medium font-mono flex items-center justify-end gap-1",
                  cpuTemperature.value != null ? classeTermica("cpu", cpuTemperature.value) : "text-muted-foreground"
                )}
                  title={cpuTemperature.value != null ? motivoTermico("cpu", cpuTemperature.value) : TEMPERATURE_UNAVAILABLE_HINT}
                >
                  <Thermometer className="w-3 h-3" />
                  {cpuTemperature.value != null
                    ? `${cpuTemperature.value}°C`
                    : <span title={TEMPERATURE_UNAVAILABLE_HINT} className="cursor-help">{cpuTemperature.text}</span>}
                </span>
              </div>
            </div>
          </div>
            {/* Evolução (uso + temperatura): a amostra vem do histórico real; sem
                leitura diz-se «Sem leitura de temperatura», nunca uma linha a zero. */}
            <div data-testid="cpu-trends" className="mt-4 flex flex-wrap items-end gap-4 border-t border-border pt-3">
              <TelemetrySparkline
                samples={cpuUseHistory}
                label="Uso"
                unit="%"
                max={100}
                width={216}
                height={40}
                showArea
                accessibleLabel="Histórico de utilização da CPU"
              />
              <TelemetrySparkline
                samples={cpuTempHistory}
                label="Temp."
                unit="°C"
                width={216}
                height={40}
                showArea
                accessibleLabel="Histórico da temperatura da CPU"
                unavailableLabel="Sem leitura de temperatura"
              />
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
            {ramUsage.value !== null ? <CircularGauge value={ramUsage.value} metric="ram" label="Uso" /> : <span className="text-sm text-muted-foreground">{ramCardText}</span>}
            <div className="flex flex-col gap-3 text-right min-w-0">
              <div>
                <span className="text-xs text-muted-foreground uppercase block">Em Uso</span>
                <span className={cn("text-lg font-bold font-mono", getUsageColor("ram", ramUsage.value))}>
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
            {/* Evolução do consumo: «utilização ao longo do tempo», não saúde. */}
            <div data-testid="ram-trend" className="mt-4 border-t border-border pt-3">
              <TelemetrySparkline
                samples={ramUseHistory}
                label="Uso"
                unit="%"
                max={100}
                width={216}
                height={40}
                showArea
                accessibleLabel="Histórico de utilização da RAM"
              />
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
            <>
            <div className="flex items-center justify-between">
              <CircularGauge value={hardware.gpu.usagePercent ?? 0} metric="workload" label={hardware.gpu.usagePercent != null ? "Uso" : "N/A"} showFallback={hardware.gpu.usagePercent == null} />
              <div className="flex flex-col gap-3 text-right min-w-0">
                <div>
                  <span className="text-xs text-muted-foreground uppercase block">Modelo</span>
                  <span className="text-sm font-medium font-mono text-foreground break-words max-w-[18rem]" title={hardware.gpu.model}>
                    {hardware.gpu.model}
                  </span>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground uppercase block">VRAM</span>
                  <span data-testid="gpu-vram" className="text-sm font-medium font-mono" title={vramCard.percent != null ? `${vramCard.percent}% da VRAM em uso` : "Sem leitura de VRAM"}>
                    {vramReadout(hardware.gpu).text}
                  </span>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground uppercase block">Temperatura</span>
                  <span className={cn("text-sm font-medium font-mono flex items-center justify-end gap-1",
                    gpuTemperature.value != null ? classeTermica("gpu", gpuTemperature.value) : "text-muted-foreground"
                  )}
                    title={gpuTemperature.value != null ? motivoTermico("gpu", gpuTemperature.value) : TEMPERATURE_UNAVAILABLE_HINT}
                  >
                    <Thermometer className="w-3 h-3" />
                    {gpuTemperature.value != null
                      ? `${gpuTemperature.value}°C`
                      : <span title={TEMPERATURE_UNAVAILABLE_HINT} className="cursor-help">{gpuTemperature.text}</span>}
                  </span>
                  {gpuTemperature.value != null && (
                    <span data-testid="gpu-temp-provenance" className="mt-0.5 block text-[10px] font-mono text-muted-foreground/70">
                      {gpuTemperatureProvenance(hardware.gpu)}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div data-testid="gpu-trends" className="mt-3 flex flex-wrap items-end gap-4 border-t border-border pt-2">
              <TelemetrySparkline
                samples={gpuUseHistory}
                label="Uso"
                unit="%"
                max={100}
                width={216}
                height={40}
                showArea
                accessibleLabel="Histórico de utilização da GPU"
              />
              <TelemetrySparkline
                samples={gpuTempHistory}
                label="Temp."
                unit="°C"
                width={216}
                height={40}
                showArea
                accessibleLabel="Histórico da temperatura da GPU"
                unavailableLabel="Sem leitura de temperatura"
              />
            </div>
            {secondaryGpuTemperatures(hardware.gpu).length > 0 && (
              <div data-testid="gpu-extra-sensors" className="mt-3 flex flex-wrap gap-2 border-t border-border pt-2">
                {secondaryGpuTemperatures(hardware.gpu).map((sensor) => (
                  <span key={sensor.label} className="rounded bg-secondary/50 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                    {sensor.label} <span className="font-bold text-foreground">{sensor.value}°C</span>
                  </span>
                ))}
              </div>
            )}
            {(hardware.gpu.gpus?.length ?? 0) > 1 && (
              <div data-testid="gpu-detected-list" className="mt-3 space-y-1 border-t border-border pt-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  GPUs detetadas ({hardware.gpu.gpus?.length})
                </span>
                {(hardware.gpu.gpus ?? []).map((placa, idx) => (
                  <div key={`${placa.model}-${idx}`} className="flex items-center justify-between gap-2 font-mono text-[11px]">
                    <span className="min-w-0 truncate" title={placa.model}>{placa.model}</span>
                    <span className="whitespace-nowrap text-muted-foreground">
                      {placa.vramTotalMb ? `${(placa.vramTotalMb / 1024).toFixed(1)} GB` : "—"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            </>
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
          <div className="flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Wifi className="w-5 h-5 text-primary" />
                <h2 className="text-lg font-semibold">Rede</h2>
              </div>
              <span className="text-xs font-mono bg-secondary px-2 py-1 rounded text-muted-foreground">
                {netReading.interfaceName ? `${netReading.interfaceName}${netReading.label ? ` · ${netReading.label}` : ""}` : netReading.label}
              </span>
            </div>

            <div className="flex flex-col gap-3">
              {netReading.rxSec != null || netReading.txSec != null ? (
                <>
                  <div className="flex items-center justify-between bg-black/20 p-3 rounded-lg border border-border">
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

                  <div className="flex items-center justify-between bg-black/20 p-3 rounded-lg border border-border">
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
                </>
              ) : (
                <p className="text-sm text-muted-foreground" title={netReading.hint ?? undefined}>{netReading.label}</p>
              )}
            </div>
          </div>
        </div>

        {/* Battery Card (Conditionally Rendered) */}
        {batteryCardVisible && (
          <div className="bg-card cyber-border rounded-xl p-6 relative overflow-hidden group hover:border-primary/50 transition-colors">
            <div className="absolute inset-0 bg-gradient-to-b from-transparent to-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Battery className="w-5 h-5 text-primary" />
                  <h2 className="text-lg font-semibold">Bateria</h2>
                </div>
                {hardware.battery.isCharging && (
                  <BatteryCharging className="w-5 h-5 text-cyber-green animate-pulse" />
                )}
              </div>

              <div className="flex flex-col items-center justify-center my-3">
                <div data-testid="battery-readout" className="text-4xl font-bold font-mono flex items-baseline gap-1">
                  <span className={cn(
                    batteryDisp.percent === null ? "text-muted-foreground" :
                    batteryDisp.percent < 20 ? "text-cyber-red" :
                    batteryDisp.percent < 50 ? "text-cyber-yellow" : "text-cyber-green"
                  )}>
                    {batteryCard.text}
                  </span>
                  {batteryCard.width != null && <span className="text-xl text-muted-foreground">%</span>}
                </div>
                {batteryCard.width != null && (
                  <div className="w-full max-w-[200px] h-6 border-2 border-secondary rounded-sm mt-4 p-0.5 relative">
                    <div className="absolute -right-1.5 top-1/2 -translate-y-1/2 w-1 h-3 bg-secondary rounded-r-sm" />
                    <div
                      className={cn(
                        "h-full rounded-sm transition-all duration-1000",
                        batteryDisp.percent !== null && batteryDisp.percent < 20 ? "bg-cyber-red" :
                        batteryDisp.percent !== null && batteryDisp.percent < 50 ? "bg-cyber-yellow" : "bg-cyber-green"
                      )}
                      style={{ width: `${batteryCard.width}%` }}
                    />
                  </div>
                )}
              </div>

              <div className="text-center mt-4">
                <span className="text-xs text-muted-foreground uppercase block mb-1">Status</span>
                <span className="font-mono text-sm text-foreground">
                  {batteryDisp.chargingText ?? batteryDisp.label}
                  {batteryDisp.timeText && (
                    <span className="text-muted-foreground ml-2">
                      ({batteryDisp.timeText})
                    </span>
                  )}
                </span>
                {batteryDisp.hint && (
                  <p data-testid="battery-hint" className="mt-1 font-mono text-[10px] leading-snug text-muted-foreground">{batteryDisp.hint}</p>
                )}
                {batteryDisp.healthText && (
                  <p data-testid="battery-health" className="mt-1 font-mono text-[10px] leading-snug text-muted-foreground">
                    {batteryDisp.healthText}
                    {batteryDisp.capacityText ? ` · ${batteryDisp.capacityText}` : ""}
                    {batteryDisp.cyclesText ? ` · ${batteryDisp.cyclesText}` : ""}
                  </p>
                )}
                {batteryDisp.healthHint && (
                  <p data-testid="battery-health-hint" className="mt-1 font-mono text-[10px] leading-snug text-muted-foreground/70">{batteryDisp.healthHint}</p>
                )}
                {hardware.battery.source && batteryCard.width != null && (
                  <p data-testid="battery-source" className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                    Fonte: {hardware.battery.source}
                    {snapshotAgeText(hardware.battery.updatedAt, nowMs) ? ` · lida ${snapshotAgeText(hardware.battery.updatedAt, nowMs)}` : ""}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Saúde física: superfície própria FORA da grelha. Abrir os detalhes
          não altera a altura de Rede/Bateria nem cria uma coluna vazia. */}
      {/* O que a aquisição já mede e os cartões não têm superfície própria: por
          núcleo, frequência atual vs. referência, compromisso/paginação, módulos,
          adaptadores e energia. Fica expansível para não esticar a grelha. */}
      <details data-testid="hardware-detail-surface" className="mt-6 min-w-0 max-w-full bg-card cyber-border rounded-xl p-4 [overflow-wrap:anywhere]">
        <summary className="cursor-pointer text-sm font-semibold">
          Detalhe medido — núcleos, frequência, memória, adaptadores e energia
        </summary>
        <div className="mt-3">
          <HardwareDetailPanel hardware={hardware} mostrarBateria={batteryCardVisible} />
        </div>
      </details>

      <details data-testid="storage-health-surface" className="mt-6 min-w-0 max-w-full bg-card cyber-border rounded-xl p-4 [overflow-wrap:anywhere]">
        <summary className="cursor-pointer font-mono text-xs text-muted-foreground">
          Saúde física dos discos · detalhes por disco
        </summary>
        <div className="mt-3 max-h-96 overflow-y-auto min-w-0 max-w-full pr-1">
          <StorageHealthPanel disk={hardware.disk} nowMs={nowMs} mode="details" />
        </div>
      </details>

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
  // AG-07: Exatamente duas vistas. Se existia preferência antiga de "lab", migra de forma segura para "advanced".
  useEffect(() => {
    try {
      const savedMode = localStorage.getItem("cybersafe_pccenter_view");
      if (savedMode === "lab") {
        localStorage.setItem("cybersafe_pccenter_view", "advanced");
        setViewMode("advanced");
      }
    } catch {
      // Ignora erro de acesso a localStorage em ambientes restritos
    }
  }, []);
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
        <>
          <AdvancedView hardware={hardware} batteryOrigin={dataOrigin ?? "LIVE"} />
          <details className="cyber-border rounded-xl p-4">
            <summary className="cursor-pointer font-medium">Resumo de recursos, sensores e proveniência</summary>
            <PcCenterVisual hardware={hardware} pcState={pcState} dataOrigin={dataOrigin ?? "LIVE"} modo="avancado" />
          </details>
        </>
      )}

      {/* Temperatures & Sensors */}
      <div className="bg-card cyber-border rounded-xl p-6 relative overflow-hidden group hover:border-primary/50 transition-colors">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
        <div className="flex items-center gap-2 mb-6">
          <Thermometer className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Temperaturas e Sensores</h2>
        </div>
        <p data-testid="thermal-band-note" className="mb-4 text-[11px] font-mono text-muted-foreground/70">
          {notaTermica}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-secondary/30 rounded-lg p-4 border border-border">
            <div className="flex items-center gap-2 mb-2">
              <Cpu className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground uppercase font-mono">CPU</span>
            </div>
            {cpuTemperature.value != null ? (
              <>
                <span title={motivoTermico("cpu", cpuTemperature.value)} className={cn("text-2xl font-mono font-bold", classeTermica("cpu", cpuTemperature.value))}>{cpuTemperature.value}°C</span>
                <p className="text-xs text-muted-foreground mt-1 font-mono truncate" title={hardware.cpu.model}>{hardware.cpu.model}</p>
                <p data-testid="cpu-temp-provenance" className="text-[10px] text-muted-foreground/60 mt-0.5 font-mono">
                  {hardware.cpu.temperatureStatus === "stale" ? "Última leitura guardada" : "Leitura do Windows"}
                </p>
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
                  <span title={motivoTermico("gpu", gpuTemperature.value)} className={cn("text-2xl font-mono font-bold", classeTermica("gpu", gpuTemperature.value))}>{gpuTemperature.value}°C</span>
                  <p className="text-xs text-muted-foreground mt-1 font-mono truncate" title={hardware.gpu.model}>{hardware.gpu.model}</p>
                  <p
                    data-testid="gpu-sensor-source"
                    className="text-[10px] text-muted-foreground/60 mt-0.5 font-mono truncate"
                    title={`${hardware.gpu.temperatureSource ?? "desconhecido"} · ${hardware.gpu.temperatureSensor ?? "GPU Core"}`}
                  >
                    {gpuTemperatureProvenance(hardware.gpu)}
                  </p>
                  {secondaryGpuTemperatures(hardware.gpu).length > 0 && (
                    <div data-testid="gpu-sensor-extras" className="mt-1 flex flex-wrap gap-1.5">
                      {secondaryGpuTemperatures(hardware.gpu).map((sensor) => (
                        <span key={sensor.label} className="rounded bg-secondary/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {sensor.label} <span className="font-bold text-foreground">{sensor.value}°C</span>
                        </span>
                      ))}
                    </div>
                  )}
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
            <p data-testid="disk-sensor-state" className="mt-1 text-xs leading-snug text-muted-foreground">
              {hardware.disk.physical && hardware.disk.physical.length > 0
                ? "Temperatura, desgaste e horas por disco estão no cartão Armazenamento, em «Saúde física»."
                : "Ainda sem leitura física dos discos; o motivo está no cartão Armazenamento."}
            </p>
          </div>

          <div className="bg-secondary/30 rounded-lg p-4 border border-border opacity-50">
            <div className="flex items-center gap-2 mb-2">
              <Server className="w-4 h-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground uppercase font-mono">Motherboard</span>
            </div>
            <span className="text-lg font-mono text-muted-foreground">—</span>
            <p data-testid="board-sensor-state" className="mt-1 text-xs leading-snug text-muted-foreground">
              Não lido: o contrato atual não expõe sensor da placa-mãe.
            </p>
          </div>
        </div>
      </div>

      {/* Saúde e Segurança do PC (camada PowerShell Windows, read-only) */}
      <PcExplanations hardware={hardware} pcState={pcState} />

      <PCHealthSection />
    </div>
  );
}
