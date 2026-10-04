import { Shield, AlertTriangle, Download, Activity, CheckCircle2, Cpu, HardDrive, MemoryStick, Wifi, Search, Play, FolderSearch } from "lucide-react";
import { useEffect, useState } from "react";
import type { DashboardSummary, EngineHealth, HardwareSnapshot, PcState, PcStateLevel, Severity, Finding } from "@cybersafe/shared-types";
// WS-5: a escala de prioridade e a construcao do DADO/SIGNIFICADO/ORIENTACAO
// vivem em shared-types (o motor deriva, a UI formata). Nao duplicam-se aqui.
import { buildFindingGuidance, FINDING_SEVERITY_LABEL, wfpHealth } from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";
import { MatrixAvatar } from "../components/MatrixAvatar";
import ProtectionDetails from "../components/ProtectionDetails";
import { describeDiskSpace, deriveProtectionLevel, levelMeta } from "../lib/protectionHealth";
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
  const statusLabel = level === "protected" ? "Protegido" : level === "attention" ? "Atenção" : level === "degraded" ? "Precisa de atenção" : "Crítico";

  return (
    <div className="p-4 lg:p-6 space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">

      {/* ═══ CAMADA 1 — A PERGUNTA E A RESPOSTA ═══
          Tudo cabe numa olhadela: a pergunta, a resposta, o número. O detalhe
          vive na lista de prioridades e no overlay — o hero não repete frases
          de nenhum dos dois. */}
      <section className="hero-banner relative overflow-hidden rounded-xl border border-primary/20 bg-card px-4 py-3 lg:px-5 lg:py-4">
        <div className="hero-gradient" />

        <div className="relative z-10 flex flex-wrap items-center gap-x-5 gap-y-3">
          {/* Pergunta central + resposta direta (hierarquia: pergunta → resposta → porquê).
              min-w em vez de min-w-0: com min-w-0 este bloco encolhia até ao
              tamanho do score (medido: 38 px de largura a 640 px de viewport, o
              título em 5 linhas de uma palavra). Com um piso de 268 px o
              flex-wrap do pai faz o score descer para a linha própria, que é o
              comportamento pedido a janela estreita — nada é escondido. */}
          <div className="order-2 sm:order-1 flex min-w-[268px] flex-1 items-center gap-3">
            <MatrixAvatar mood={matrixMood} size="md" />
            <div className="min-w-0">
              <h1 className="text-base lg:text-lg font-bold font-mono tracking-tight text-foreground leading-tight">
                O meu computador está bem?
              </h1>
              <p className="mt-0.5 text-sm leading-snug">
                <span className={cn("font-mono font-bold", meta.textClass)}>{meta.answer}</span>{" "}
                <span className="text-muted-foreground">{meta.answerDetail}</span>
              </p>
            </div>
          </div>

          {/* Score: número grande, etiqueta pequena, chip de estado ao lado. */}
          <div className="order-1 sm:order-2 flex shrink-0 items-center gap-3">
            <div className="relative w-[68px] h-[68px] shrink-0">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="9" className="text-secondary" />
                <circle
                  cx="50" cy="50" r="40" fill="none" stroke="url(#hero-risk-gradient)" strokeWidth="9"
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
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl leading-none font-bold font-mono text-foreground tabular-nums">{displayScore}</span>
                <span className={cn("mt-0.5 text-[9px] leading-none font-mono uppercase tracking-wide whitespace-nowrap", meta.textClass)} title={meta.label}>
                  /100
                </span>
              </div>
            </div>

            <div className="flex min-w-0 flex-col items-start gap-1">
              <button
                onClick={() => setDetailsOpen(true)}
                title={`Estado geral: ${meta.label}`}
                className={cn(
                  "px-3 py-1.5 rounded-lg font-mono text-xs font-semibold whitespace-nowrap transition-all hover:brightness-110",
                  meta.chipClass,
                  meta.textClass,
                )}
              >
                <span className="flex items-center gap-2">
                  <span className={cn("w-2 h-2 rounded-full shrink-0 cyber-pulse", meta.dotClass)} />
                  {statusLabel}
                </span>
              </button>
              <span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap">
                {dashboard.engineHealth?.definitionsUpdatedAt
                  ? `Definições: ${new Date(dashboard.engineHealth.definitionsUpdatedAt).toLocaleDateString("pt-PT")}`
                  : "Definições: sem data"}
              </span>
            </div>
          </div>

          {/* Quatro frentes numa linha: a cor já diz o estado, não repetimos palavras. */}
          {pcState && (
            <div className="order-3 flex flex-wrap items-center gap-1.5 sm:w-auto w-full">
              {([
                { key: "security" as const, label: "Segurança" },
                { key: "performance" as const, label: "Desempenho" },
                { key: "system" as const, label: "Sistema" },
                { key: "privacy" as const, label: "Privacidade" },
              ]).map(({ key, label }) => {
                const catMeta = LEVEL_META[pcState[key]];
                return (
                  <span
                    key={key}
                    title={`${label}: ${catMeta.label}`}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/[0.04] border border-white/[0.06]"
                  >
                    <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", catMeta.dotClass)} />
                    <span className="text-[10px] font-mono text-muted-foreground">{label}</span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ═══ CAMADA 2 — PRIORIDADES (a única vez que as frases de aviso aparecem) ═══ */}
      {pcState && (pcState.counts.urgent + pcState.counts.attention > 0) && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-cyber-yellow" />
            <h2 className="text-sm font-mono font-bold text-foreground uppercase tracking-wider">O que precisa de atenção</h2>
          </div>
          <PcStateAttention pcState={pcState} engine={dashboard.engineHealth} />
        </section>
      )}

      {/* ═══ CAMADA 3 — O QUE O PC ESTÁ A FAZER AGORA ═══ */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-mono font-bold text-foreground uppercase tracking-wider">Estado do computador</h2>
          <span className="text-[10px] font-mono text-muted-foreground">medido agora pelo serviço</span>
        </div>

        {/* As quatro métricas que interessam no dia a dia. */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {hardware ? (
            <>
              <MetricBar label="CPU" subValue={`${cpuTemp.text}${hardware.cpu.model ? ` · ${hardware.cpu.model}` : ""}`} value={hardware.cpu.usage || 0} icon={Cpu} alertTitle={hardware.alerts.find((a) => a.category === "cpu")?.title} sparkline={<TelemetrySparkline samples={cpuSamples} height={28} width={150} showArea />} />
              <MetricBar label="RAM" subValue={`${hardware.ram.usedGb.toFixed(1)} de ${hardware.ram.totalGb} GB usados`} value={hardware.ram.usagePercent || 0} icon={MemoryStick} alertTitle={hardware.alerts.find((a) => a.category === "ram")?.title} sparkline={<TelemetrySparkline samples={ramSamples} height={28} width={150} showArea />} />
              <DiskMetric disk={hardware.disk} alertTitle={hardware.alerts.find((a) => a.category === "disk")?.title} />
              <MetricBar label="Rede" subValue={`a receber ${formatThroughput(hardware.network.rxSec)}`} value={Math.min(100, (hardware.network.rxSec || 0) / 1024 / 100)} icon={Wifi} sparkline={<TelemetrySparkline samples={netRxSamples} height={28} width={150} showArea />} />
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

        {/* GPU/VRAM: informação secundária — uma linha, não quatro cartões. */}
        {hardware?.gpu && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 rounded-lg border border-white/[0.06] bg-white/[0.02]">
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Secundário</span>
            <span className="text-[11px] font-mono text-foreground">
              GPU {hardware.gpu.usagePercent !== null && hardware.gpu.usagePercent !== undefined ? `${hardware.gpu.usagePercent.toFixed(0)}%` : "sem leitura"}
            </span>
            {hardware.gpu.vramTotalMb ? (
              <span className="text-[11px] font-mono text-muted-foreground">
                VRAM {((hardware.gpu.vramUsedMb ?? 0) / 1024).toFixed(1)} de {(hardware.gpu.vramTotalMb / 1024).toFixed(1)} GB
              </span>
            ) : (
              <span className="text-[11px] font-mono text-muted-foreground">VRAM sem leitura</span>
            )}
            <span className="text-[11px] font-mono text-muted-foreground">{gpuTemp.text}</span>
            {hardware.gpu.model && <span className="text-[11px] font-mono text-muted-foreground truncate max-w-[220px]">{hardware.gpu.model}</span>}
            {hardware.alerts.find((a) => a.category === "gpu") && (
              <span className="text-[11px] font-mono text-cyber-yellow">{hardware.alerts.find((a) => a.category === "gpu")?.title}</span>
            )}
          </div>
        )}

        {/* Contagem de atividade — discretos, ao lado um do outro. */}
        <div className="flex flex-wrap items-stretch gap-3">
          <StatCard label="Eventos" value={dashboard.totalEvents.toString()} icon={Activity} color="foreground" />
          <StatCard label="Ameaças graves" value={dashboard.highSeverityEvents.toString()} icon={AlertTriangle} color={dashboard.highSeverityEvents > 0 ? "red" : "green"} />
          <StatCard label="Downloads" value={DOWNLOAD_RISK_LABEL[dashboard.downloadRisk]} icon={Download} color={dashboard.downloadRisk === "low" ? "green" : dashboard.downloadRisk === "medium" ? "yellow" : "red"} isText />
          <StatCard label="Recomendações" value={pcState ? `${pcState.findings.length}` : "—"} icon={Shield} color="foreground" />
        </div>

        {/* Ações do Scanner: um grupo só, com a primaria destacada. */}
        <div className="stat-card p-3">
          <div className="flex items-baseline justify-between gap-3 mb-2">
            <h3 className="text-xs font-mono font-semibold text-foreground uppercase tracking-wider">Procurar ameaças</h3>
            <span className="text-[10px] font-mono text-muted-foreground">demora uns minutos; podes continuar a usar o PC</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ScanButton label="Análise Rápida" sub="Áreas onde os problemas costumam estar" icon={Search} tone="primary" scanType="quick" onScan={onScan} />
            <ScanButton label="Análise Profunda" sub="Pastas do seu utilizador e arranques automáticos" icon={Play} tone="ghost" scanType="full" onScan={onScan} />
            <ScanButton label="Analisar uma Pasta" sub="Escolhes a pasta e só ela é vista" icon={FolderSearch} tone="ghost" scanType="custom" onScan={onScan} />
          </div>
        </div>

        {/* Alertas + Ameaças: só listas com conteúdo ganham espaço. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ListPanel
            title="Alertas recentes"
            icon={Activity}
            empty="Nenhum alerta grave. Não há nada aqui para ver."
            count={`${dashboard.alerts.length}`}
          >
            {dashboard.alerts.map((alert) => (
              <div key={alert.id} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                <span className="text-[11px] font-mono text-foreground truncate">{alert.title}</span>
                <span className="text-[9px] font-mono text-cyber-red uppercase shrink-0">{alert.severity}</span>
              </div>
            ))}
          </ListPanel>

          <ListPanel
            title="Ameaças recentes"
            icon={Shield}
            empty="Nenhuma ameaça detetada. Continua tranquilo."
            count={`${dashboard.recentThreats.length}`}
          >
            {dashboard.recentThreats.slice(0, 5).map((threat, i) => (
              <div key={`${threat.createdAt}-${i}`} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0",
                    threat.severity === "critical" ? "bg-cyber-red"
                      : threat.severity === "high" ? "bg-cyber-yellow" : "bg-cyber-cyan",
                  )} />
                  <span className="text-[11px] font-mono text-foreground truncate">{threat.domain}</span>
                </div>
                <span className={cn(
                  "text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border shrink-0",
                  threat.severity === "critical" ? "bg-cyber-red/10 text-cyber-red border-cyber-red/30"
                    : threat.severity === "high" ? "bg-cyber-yellow/10 text-cyber-yellow border-cyber-yellow/30"
                      : "bg-cyber-cyan/10 text-cyber-cyan border-cyber-cyan/30",
                )}>
                  {threat.severity}
                </span>
              </div>
            ))}
          </ListPanel>
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
  color: "cyan" | "green" | "red" | "yellow" | "foreground";
  isText?: boolean;
}

/** Contagem discreta: o valor é que interessa, não a cor do ícone. */
function StatCard({ label, value, icon: Icon, color, isText }: StatCardProps) {
  const colorClasses: Record<StatCardProps["color"], string> = {
    cyan: "text-cyber-cyan",
    green: "text-cyber-green",
    red: "text-cyber-red",
    yellow: "text-cyber-yellow",
    foreground: "text-foreground",
  };

  return (
    <div className="stat-card px-3 py-2 flex items-center gap-2.5 min-w-[150px] flex-1">
      <Icon className={cn("w-4 h-4 shrink-0", colorClasses[color])} />
      <div className="min-w-0">
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider block">{label}</span>
        <span className={cn(isText ? "text-sm" : "text-lg", "font-bold font-mono tabular-nums", colorClasses[color])}>{value}</span>
      </div>
    </div>
  );
}

/** "MEDIUM" a gritar em maiúsculas não é linguagem de pessoa. */
const DOWNLOAD_RISK_LABEL: Record<Severity, string> = {
  low: "Baixo",
  medium: "Médio",
  high: "Alto",
  critical: "Crítico",
};

interface ScanButtonProps {
  label: string;
  sub: string;
  icon: React.ElementType;
  tone: "primary" | "ghost";
  scanType: "quick" | "full" | "custom";
  onScan?: (type: string, targetPath?: string) => void;
}

function ScanButton({ label, sub, icon: Icon, tone, scanType, onScan }: ScanButtonProps) {
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
      title={sub}
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-2 font-mono text-xs transition-all border",
        tone === "primary"
          ? "bg-primary/15 border-primary/40 text-primary font-semibold hover:bg-primary/25"
          : "bg-white/[0.03] border-white/[0.08] text-foreground hover:bg-white/[0.07]",
      )}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      {label}
    </button>
  );
}

interface MetricBarProps {
  label: string;
  value: number;
  subValue?: string;
  icon: React.ElementType;
  /**
   * Aviso calculado pelo motor. Não se imprime aqui — a lista de prioridades
   * já o diz, e repeti-lo em cada cartão era a fonte do "ecrã todo em alerta".
   * Continua acessível no `title` da barra.
   */
  alertTitle?: string;
  hint?: string;
  sparkline?: React.ReactNode;
}

function formatThroughput(bytes: number): string {
  if (!bytes) return "0 B/s";
  if (bytes < 1024) return `${bytes.toFixed(0)} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
}

function metricColor(val: number) {
  if (val < 60) return "bg-cyber-green";
  if (val < 85) return "bg-cyber-yellow";
  return "bg-cyber-red";
}

function MetricBar({ label, value, subValue, icon: Icon, alertTitle, hint, sparkline }: MetricBarProps) {
  const safeValue = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;

  return (
    <div className="stat-card p-3 flex flex-col justify-between gap-1" title={alertTitle}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          <span className="font-mono text-xs text-foreground font-semibold">{label}</span>
        </div>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{safeValue.toFixed(0)}%</span>
      </div>

      <div className="text-[10px] font-mono text-muted-foreground truncate">{subValue}</div>

      {sparkline && <div className="mt-1">{sparkline}</div>}

      <div className="mt-1">
        <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
          <div className={cn("h-full transition-all duration-500", metricColor(safeValue))} style={{ width: `${safeValue}%` }} />
        </div>
        {hint && <div className="text-[9px] font-mono text-muted-foreground mt-1 leading-snug">{hint}</div>}
      </div>
    </div>
  );
}

/**
 * Disco em três linhas, por ordem: o dado (espaço LIVRE), o significado e a
 * orientação. "62% usado" não diz a ninguém o que fazer.
 */
function DiskMetric({ disk, alertTitle }: { disk: HardwareSnapshot["disk"]; alertTitle?: string }) {
  const guidance = describeDiskSpace(disk.usedGb, disk.totalGb);
  const usedPercent = Number.isFinite(disk.usagePercent)
    ? Math.min(100, Math.max(0, disk.usagePercent))
    : 0;

  return (
    <div className="stat-card p-3 flex flex-col justify-between gap-1" title={alertTitle}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <HardDrive className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          <span className="font-mono text-xs text-foreground font-semibold">Disco</span>
        </div>
        <span
          className={cn(
            "font-mono text-xs tabular-nums",
            guidance.urgency === "critical" ? "text-cyber-red" : guidance.urgency === "tight" ? "text-cyber-yellow" : "text-muted-foreground",
          )}
        >
          {guidance.freeText}
        </span>
      </div>

      <div className="text-[10px] font-mono text-muted-foreground truncate">
        {guidance.totalGb ? `${guidance.totalGb} GB no total · ${usedPercent.toFixed(0)}% usado` : "sem leitura do volume"}
      </div>

      <div className="mt-1">
        <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
          <div className={cn("h-full transition-all duration-500", metricColor(usedPercent))} style={{ width: `${usedPercent}%` }} />
        </div>
        {/* A orientação é texto, não botão: não há ação de limpeza no backend. */}
        {guidance.action ? (
          <div className="text-[9px] font-mono mt-1 leading-snug text-cyber-yellow">{guidance.action}</div>
        ) : (
          <div className="text-[9px] font-mono mt-1 leading-snug text-muted-foreground">{guidance.meaning}</div>
        )}
      </div>
    </div>
  );
}

interface ListPanelProps {
  title: string;
  icon: React.ElementType;
  count: string;
  /** Copy do empty state — uma linha, sem ícone gigante. */
  empty: string;
  children: React.ReactNode;
}

function ListPanel({ title, icon: Icon, count, empty, children }: ListPanelProps) {
  const hasItems = Array.isArray(children) ? children.length > 0 : !!children;

  return (
    <div className="stat-card p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-mono text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-2">
          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
          {title}
        </h3>
        <span className="text-[10px] font-mono text-muted-foreground tabular-nums">{count}</span>
      </div>
      {hasItems ? (
        <div
          className="space-y-1.5 max-h-36 overflow-y-auto pr-1"
          style={{ scrollbarWidth: "thin", scrollbarColor: "color-mix(in oklch, var(--muted-foreground) 30%, transparent) transparent" }}
        >
          {children}
        </div>
      ) : (
        <p className="flex items-center gap-2 py-2 text-[11px] font-mono text-muted-foreground">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-cyber-green" />
          {empty}
        </p>
      )}
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

/**
 * Quantos achados partilham a prioridade de um achado. Lê `pcState.counts`,
 * que o service derivou — a UI não conta nada, só mostra.
 */
function contagemPrioridade(severity: Finding["severity"], counts: PcState["counts"]): number {
  return counts[severity];
}

/** Rótulo de um bloco, com o nome visível — o utilizador tem de saber o que lê. */function Bloco({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="mt-1.5">
      <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground/70">{titulo}</div>
      {children}
    </div>
  );
}

/**
 * WS-B — DADO humano dos motores, RENDERIZADO pela página.
 * Uma linha por componente que o serviço mediu como não-operacional: nome +
 * estado em PT-PT + o que significa. Nenhum token interno ("degraded",
 * "unavailable"), nenhum path do provider, nenhuma mensagem crua. As
 * condições vêm do `engineHealth` medido — nada é afirmado sem leitura.
 */
function engineDadoLinhas(engine: EngineHealth): string[] {
  const linhas: string[] = [];

  if (engine.clamav && engine.clamav.status !== "active") {
    if (engine.clamav.status === "degraded") {
      linhas.push("ClamAV: Degradado — Motor instalado, mas a base de assinaturas antivírus ainda não está disponível.");
      linhas.push("As assinaturas precisam de ser instaladas ou atualizadas antes de o ClamAV poder contribuir plenamente para a análise.");
    } else if (engine.clamav.status === "unavailable") {
      linhas.push("ClamAV: Indisponível — o motor antivírus não está disponível neste computador.");
    } else {
      linhas.push("ClamAV: Erro — o motor antivírus reporta um erro.");
    }
  }

  const wfp = wfpHealth(engine);
  if (wfp && wfp.status !== "active") {
    if (wfp.status === "degraded") {
      linhas.push("Filtro WFP do CyberSafe: Degradado — O filtro de rede próprio do CyberSafe não está a funcionar como esperado.");
    } else if (wfp.status === "unavailable") {
      linhas.push("Filtro WFP do CyberSafe: Indisponível — O filtro de rede próprio do CyberSafe não está ativo.");
    } else {
      linhas.push("Filtro WFP do CyberSafe: Erro — O filtro de rede próprio do CyberSafe reporta um erro.");
    }
    // O nosso filtro não diz nada do firewall da Microsoft — o disclaimer vai
    // com a linha, em todos os estados.
    linhas.push("Isto não significa que o Firewall do Windows esteja desligado.");
  }

  if (engine.yara && engine.yara.status !== "active") {
    linhas.push(
      engine.yara.status === "degraded"
        ? "YARA: Degradado — o motor de análise por regras não está totalmente operacional."
        : engine.yara.status === "unavailable"
          ? "YARA: Indisponível — o motor de análise por regras não está ativo."
          : "YARA: Erro — o motor de análise por regras reporta um erro.",
    );
  }

  if (engine.hashDb && engine.hashDb.status !== "active") {
    linhas.push(
      engine.hashDb.status === "degraded"
        ? "Base de assinaturas: Degradado — a base local de assinaturas não está totalmente operacional."
        : engine.hashDb.status === "unavailable"
          ? "Base de assinaturas: Indisponível — a base local de assinaturas não está carregada."
          : "Base de assinaturas: Erro — a base local de assinaturas reporta um erro.",
    );
  }

  if (engine.nativeEngine && engine.nativeEngine.status !== "active") {
    linhas.push(
      engine.nativeEngine.status === "degraded"
        ? "Motor nativo: Degradado — o motor nativo de análise não está totalmente operacional."
        : engine.nativeEngine.status === "unavailable"
          ? "Motor nativo: Indisponível — o motor nativo de análise não está disponível."
          : "Motor nativo: Erro — o motor nativo de análise reporta um erro.",
    );
  }

  return linhas;
}

export function PcStateAttention({ pcState, engine }: { pcState: PcState; engine?: EngineHealth }) {
  const { principalFinding, findings } = pcState;
  const problems = findings.filter((f) => f.severity === "urgent" || f.severity === "attention");
  const principal = principalFinding ? buildFindingGuidance(principalFinding) : null;
  // A finding dos motores tem copy humana própria nesta página (WS-B); os
  // restantes achados continuam pelo caminho genérico do motor.
  const ehFindingMotores = !!principalFinding
    && principalFinding.source === "protection-engine"
    && String(principalFinding.id).startsWith("security:engine");
  const dadoLinhas = engine && ehFindingMotores ? engineDadoLinhas(engine) : principal?.dado ?? [];

  return (
    <div className={cn(
      "rounded-xl border p-4 space-y-3",
      pcState.overall === "critical"
        ? "border-cyber-red/30 bg-cyber-red/[0.03]"
        : "border-cyber-yellow/30 bg-cyber-yellow/[0.03]",
    )}>
      {principalFinding && principal && (
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
              )}>{FINDING_SEVERITY_LABEL[principalFinding.severity]}</span>
              <span className="text-xs font-mono font-semibold text-foreground">{principalFinding.title}</span>
            </div>

            {/* DADO — só quando existe. Um bloco vazio é pior que um bloco
                ausente: parece que falta informação quando não falta. */}
            {dadoLinhas.length > 0 && (
              <Bloco titulo="Dado">
                <ul className="mt-0.5 space-y-0.5">
                  {dadoLinhas.map((linha) => (
                    <li key={linha} className="text-[11px] font-mono text-foreground/80">{linha}</li>
                  ))}
                </ul>
              </Bloco>
            )}

            {/* SIGNIFICADO — o `summary` do motor, verbatim. */}
            <Bloco titulo="Significado">
              <p className="text-[11px] text-muted-foreground leading-relaxed">{principal.significado}</p>
            </Bloco>

            {/* PRIORIDADE — o rótulo da escala do motor, e quantos achados
                partilham essa mesma prioridade. As contagens vêm de
                `pcState.counts` (derivadas no service); a UI não as recalcula. */}
            <Bloco titulo="Prioridade">
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {principal.prioridade} — {contagemPrioridade(principalFinding.severity, pcState.counts)} achado(s) com esta prioridade.
              </p>
            </Bloco>

            {/* ORIENTAÇÃO — o que o produto sabe mesmo fazer, e nada mais.
                O antigo botão "Ver detalhes" foi removido de propósito: sugeria
                que havia algo a resolver ao alcance do utilizador e abria um
                estado geral que não é uma solução. */}
            {principal.orientacao && (
              <Bloco titulo="Orientação">
                <p className="text-[11px] text-muted-foreground leading-relaxed">{principal.orientacao}</p>
              </Bloco>
            )}
          </div>
        </div>
      )}

      {problems.length > 1 && (
        <div className="space-y-1.5 pl-11">
          {problems.filter((f) => f.id !== principalFinding?.id).slice(0, 3).map((f) => {
            const g = buildFindingGuidance(f);
            return (
              <div key={f.id} className="p-2 rounded-lg bg-white/[0.03] border border-white/[0.06] space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-mono text-foreground truncate">{f.title}</span>
                  <span className={severityChip(f)}>{FINDING_SEVERITY_LABEL[f.severity]}</span>
                </div>
                {g.dado.length > 0 && (
                  <ul className="space-y-0.5">
                    {g.dado.map((linha) => (
                      <li key={linha} className="text-[10px] font-mono text-foreground/70">{linha}</li>
                    ))}
                  </ul>
                )}
                {g.orientacao && (
                  <p className="text-[10px] text-muted-foreground leading-relaxed">{g.orientacao}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
