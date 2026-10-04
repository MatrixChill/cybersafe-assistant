import { useState, useEffect } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  Cpu,
  MemoryStick,
  HardDrive,
  Server,
  Wifi,
  Flame,
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
  Info,
  CircleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { WindowsHealthSnapshot, WindowsHealthStatus } from "@cybersafe/shared-types";
import { buildHealthAlertsFromSnapshot } from "@cybersafe/shared-types";
import type { HealthAlert, HealthAlertSeverity } from "@cybersafe/shared-types";
import { isAppShuttingDown, onAppShutdown, runUnlessShuttingDown } from "@/lib/shutdownState";

function statusMeta(status: WindowsHealthStatus) {
  switch (status) {
    case "good":
      return { label: "BOM", color: "text-cyber-green", bg: "bg-cyber-green/10", border: "border-cyber-green/30", Icon: ShieldCheck };
    case "attention":
      return { label: "ATENÇÃO", color: "text-cyber-yellow", bg: "bg-cyber-yellow/10", border: "border-cyber-yellow/30", Icon: ShieldAlert };
    case "critical":
      return { label: "CRÍTICO", color: "text-cyber-red", bg: "bg-cyber-red/10", border: "border-cyber-red/30", Icon: ShieldAlert };
    default:
      return { label: "DESCONHECIDO", color: "text-muted-foreground", bg: "bg-white/5", border: "border-white/10", Icon: ShieldQuestion };
  }
}

function alertMeta(severity: HealthAlertSeverity) {
  switch (severity) {
    case "critical":
      return { label: "CRÍTICO", color: "text-cyber-red", bg: "bg-cyber-red/10", border: "border-cyber-red/30", Icon: CircleAlert };
    case "warning":
      return { label: "ATENÇÃO", color: "text-cyber-yellow", bg: "bg-cyber-yellow/10", border: "border-cyber-yellow/30", Icon: AlertTriangle };
    default:
      return { label: "INFORMAÇÃO", color: "text-cyber-cyan", bg: "bg-cyber-cyan/10", border: "border-cyber-cyan/30", Icon: Info };
  }
}

// Frase de impacto para leitura humana; nunca recalcula health, so traduz o alerta ja derivado.
const ALERT_MEANING: Record<string, string> = {
  "ram-high": "O PC pode ficar lento ou bloquear porque a RAM está quase toda ocupada.",
  "ram-attention": "Aplicações pesadas podem começar a ficar mais lentas.",
  "disk-critical": "Sem espaço livre, o Windows e as aplicações podem falhar ou não se atualizar.",
  "disk-attention": "Ainda há espaço, mas pode faltar para atualizações e novos ficheiros.",
  "firewall-disabled": "O PC está exposto a tentativas de acesso pela rede sem proteção.",
  "many-cpu-processes": "O processador está saturado; janelas e jogos podem correr aos soluços.",
  "service-down": "Funções como impressão, atualizações ou proteção podem deixar de funcionar.",
};

function alertMeaning(alert: HealthAlert): string {
  if (alert.id && ALERT_MEANING[alert.id]) return ALERT_MEANING[alert.id];
  switch (alert.severity) {
    case "critical": return "Pode afetar seriamente a utilização normal do PC.";
    case "warning": return "Pode causar lentidão ou falhas se nada for feito.";
    default: return "Detalhe do sistema a ter em conta, sem urgência.";
  }
}

// Rotulos PT-PT para strings de estado vindas do backend (evita ingles visivel).
const TCP_STATE_PT: Record<string, string> = {
  Established: "Estabelecida",
  Listen: "À escuta",
  SynSent: "A conectar",
  SynReceived: "A conectar",
  FinWait1: "A fechar",
  FinWait2: "A fechar",
  LastAck: "Último reconhecimento",
  Closing: "A fechar",
  Closed: "Fechada",
  TimeWait: "Em espera de fecho",
  CloseWait: "Aguarda fecho",
};

const FIREWALL_PROFILE_PT: Record<string, string> = {
  Domain: "Domínio",
  Private: "Privada",
  Public: "Pública",
  All: "Todos",
};

function HealthAlertsSection({ alerts }: { alerts: HealthAlert[] }) {
  if (alerts.length === 0) {
    return (
      <div className="bg-card cyber-border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck className="w-5 h-5 text-cyber-green" />
          <h3 className="text-lg font-semibold">Alertas do Sistema</h3>
        </div>
        <div className="flex items-center gap-3 p-4 rounded-lg bg-cyber-green/10 border border-cyber-green/30">
          <CheckCircle2 className="w-5 h-5 text-cyber-green flex-shrink-0" />
          <p className="text-sm text-cyber-green font-mono">Nenhum alerta importante detetado.</p>
        </div>
      </div>
    );
  }

  const sorted = [...alerts].sort((a, b) => {
    const order: Record<HealthAlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });

  return (
    <div className="bg-card cyber-border rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-cyber-yellow" />
          <h3 className="text-lg font-semibold">Alertas do Sistema</h3>
        </div>
        <span className="text-xs text-muted-foreground font-mono">{alerts.length} alerta(s)</span>
      </div>
      <div className="space-y-2">
        {sorted.map((alert, i) => {
          const meta = alertMeta(alert.severity);
          const Icon = meta.Icon;
          return (
            <div key={alert.id ?? i} className={cn("p-3 rounded-lg border", meta.bg, meta.border)}>
              <div className="flex items-start gap-3">
                <Icon className={cn("w-4 h-4 mt-0.5 flex-shrink-0", meta.color)} />
                <div className="flex-grow min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn("text-sm font-semibold", meta.color)}>{alert.title}</span>
                    <span className="text-xs uppercase tracking-wider font-mono px-1.5 py-0.5 rounded bg-secondary/50 text-foreground/80">{meta.label}</span>
                    <span className="text-xs text-muted-foreground font-mono px-1.5 py-0.5 rounded bg-secondary/50">{alert.category}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{alert.description}</p>
                  <p className="text-xs text-foreground/80 mt-2 leading-relaxed">
                    <span className="font-semibold text-foreground">O que significa: </span>
                    {alertMeaning(alert)}
                  </p>
                  {alert.evidence.length > 0 && (
                    <div className="mt-2">
                      <span className="text-xs font-semibold text-foreground">Evidência:</span>
                      <ul className="mt-1 space-y-1 px-1">
                        {alert.evidence.map((line, j) => (
                          <li key={j} className="text-xs text-muted-foreground font-mono flex items-start gap-2">
                            <span className={cn("mt-1.5 inline-block w-1 h-1 rounded-full flex-shrink-0", meta.color)} />
                            {line}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="mt-2 flex items-start gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-primary" />
                    <p className="text-xs text-foreground/80 leading-relaxed">
                      <span className="font-semibold text-foreground">O que fazer: </span>
                      {alert.recommendedAction}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MetricTile({ icon: Icon, label, value, sub, color }: {
  icon: typeof Cpu;
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-black/20 border border-white/5 rounded-lg p-4 flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider">
        <Icon className="w-4 h-4 text-primary" />
        {label}
      </div>
      <span className={cn("text-2xl font-mono font-bold", color || "text-foreground")}>{value}</span>
      {sub && <span className="text-xs text-muted-foreground font-mono">{sub}</span>}
    </div>
  );
}

function ProcessTable({ processes, title, coloredBy }: {
  processes: WindowsHealthSnapshot["topProcessesByCpu"];
  title: string;
  coloredBy: "cpu" | "ram";
}) {
  return (
    <div className="bg-card cyber-border rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <Cpu className="w-5 h-5 text-primary" />
        <h3 className="text-lg font-semibold">Top Processos ({title})</h3>
      </div>
      {processes.length === 0 ? (
        <p className="text-sm text-muted-foreground font-mono">Nenhum processo disponível</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted-foreground uppercase bg-secondary/50">
              <tr>
                <th className="px-3 py-2 rounded-tl-lg">Nome</th>
                <th className="px-3 py-2">PID</th>
                <th className="px-3 py-2 rounded-tr-lg">{coloredBy === "cpu" ? "CPU %" : "RAM (MB)"}</th>
              </tr>
            </thead>
            <tbody>
              {processes.map((p) => {
                const val = coloredBy === "cpu" ? p.cpuPercent : p.memoryMb;
                const hi = coloredBy === "cpu" ? p.cpuPercent > 50 : p.memoryMb > 2000;
                return (
                  <tr key={p.pid} className="border-b border-white/5 last:border-0">
                    <td className="px-3 py-2 font-mono truncate max-w-[160px]" title={p.path || p.name}>{p.name}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{p.pid}</td>
                    <td className={cn("px-3 py-2 font-mono font-bold", hi ? "text-cyber-red" : "text-foreground")}>
                      {coloredBy === "cpu" ? `${val.toFixed(1)}%` : `${val.toFixed(0)} MB`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function PCHealthSection() {
  const [health, setHealth] = useState<WindowsHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchHealth = async () => {
    if (!window.electronAPI) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    // Encerramento em curso: sem leituras novas ao serviço.
    if (isAppShuttingDown()) return;
    setRefreshing(true);
    try {
      const snap = await window.electronAPI.getWindowsHealth();
      if (isAppShuttingDown()) return;
      setHealth(snap);
    } catch (e) {
      // Cancelamento esperado durante o shutdown; erro real continua a ser logado.
      if (isAppShuttingDown()) return;
      console.error("[WindowsHealth] fetch error", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void fetchHealth();
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      runUnlessShuttingDown(() => { void fetchHealth(); });
    }, 12_000);
    // O polling pára assim que o utilizador confirma a saída.
    const stopOnShutdown = onAppShutdown(() => clearInterval(interval));
    return () => {
      stopOnShutdown();
      clearInterval(interval);
    };
  }, []);

  if (loading && !health) {
    return (
      <div className="w-full h-40 animate-pulse bg-card cyber-border rounded-xl flex items-center justify-center">
        <span className="text-sm text-muted-foreground font-mono">A recolher dados de saúde do Windows...</span>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="w-full bg-card cyber-border rounded-xl p-6 flex flex-col items-center justify-center gap-3 text-center">
        <Flame className="w-10 h-10 text-muted-foreground opacity-30" />
        <p className="text-sm text-muted-foreground font-mono">Indisponível. O serviço Windows pode não estar ativo.</p>
        <button
          onClick={() => void fetchHealth()}
          className="px-4 py-2 text-sm font-mono bg-primary/10 text-primary hover:bg-primary/20 rounded-lg"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  const meta = statusMeta(health.overallStatus);
  const StatusIcon = meta.Icon;
  const topDisk = [...health.disks].sort((a, b) => b.usagePercent - a.usagePercent)[0];

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-primary" />
          Saúde e Segurança do PC
        </h2>
        <button
          onClick={() => void fetchHealth()}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono rounded bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} />
          Atualizar
        </button>
      </div>

      <div className={cn("flex items-center justify-between gap-4 p-6 rounded-xl border bg-card", meta.border)}>
        <div className="flex items-center gap-4">
          <div className={cn("p-4 rounded-full", meta.bg)}>
            <StatusIcon className={cn("w-8 h-8", meta.color)} />
          </div>
          <div>
            <span className={cn("text-2xl font-bold", meta.color)}>{meta.label}</span>
            <span className="block text-sm text-muted-foreground">
              {health.system.osName} · {health.system.osVersion || "desconhecido"}
            </span>
            {health.errors.length > 0 && (
              <span className="block text-xs text-muted-foreground mt-1">
                {health.errors.length} fonte(s) indisponível(is) (pode exigir privilégio)
              </span>
            )}
          </div>
        </div>
        <div className="text-right">
          <span className="text-xs text-muted-foreground uppercase tracking-wider block">Score</span>
          <span className={cn("text-4xl font-mono font-bold", meta.color)}>{health.score}</span>
        </div>
      </div>

      {/* Métricas principais */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricTile
          icon={MemoryStick}
          label="RAM"
          value={health.system.available ? `${health.system.ramUsagePercent}%` : "—"}
          sub={health.system.available ? `${health.system.availableRamGb.toFixed(1)} / ${health.system.totalRamGb.toFixed(1)} GB livres` : "indisponível"}
          color={health.system.ramUsagePercent >= 90 ? "text-cyber-red" : health.system.ramUsagePercent >= 75 ? "text-cyber-yellow" : "text-cyber-green"}
        />
        <MetricTile
          icon={HardDrive}
          label="Disco principal"
          value={topDisk ? `${topDisk.usagePercent}%` : "—"}
          sub={topDisk ? `${topDisk.freeGb.toFixed(1)} GB livres` : "indisponível"}
          color={topDisk && topDisk.usagePercent >= 95 ? "text-cyber-red" : topDisk && topDisk.usagePercent >= 85 ? "text-cyber-yellow" : "text-cyber-green"}
        />
        <MetricTile
          icon={Server}
          label="Serviços"
          value={`${health.services.filter((s) => s.running).length}/${health.services.length}`}
          sub="ativos / total"
        />
        <MetricTile
          icon={Wifi}
          label="Firewall"
          value={health.firewall.available ? (health.firewall.enabled ? "Ativo" : "Desligado") : "—"}
          sub={health.firewall.available ? health.firewall.profiles.map((p) => `${FIREWALL_PROFILE_PT[p.name] ?? p.name}:${p.enabled ? "ativo" : "desligado"}`).join(" · ") : "indisponível"}
          color={!health.firewall.available ? undefined : health.firewall.enabled ? "text-cyber-green" : "text-cyber-red"}
        />
      </div>

      {/* Alertas do Sistema */}
      <HealthAlertsSection alerts={buildHealthAlertsFromSnapshot(health)} />

      {/* Recomendações */}
      {health.recommendations.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-base font-semibold flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-cyber-yellow" />
            Recomendações Locais
          </h3>
          <div className="grid gap-3">
            {health.recommendations.map((rec) => {
              const isCritical = rec.severity === "high";
              return (
                <div key={rec.id} className={cn(
                  "p-4 rounded-xl border flex flex-col md:flex-row gap-3",
                  isCritical ? "bg-cyber-red/10 border-cyber-red/30" : "bg-cyber-yellow/10 border-cyber-yellow/30",
                )}>
                  <div className="flex-shrink-0 mt-0.5">
                    {isCritical
                      ? <ShieldAlert className="w-5 h-5 text-cyber-red" />
                      : <AlertTriangle className="w-5 h-5 text-cyber-yellow" />}
                  </div>
                  <div className="flex-grow">
                    <h4 className={cn("text-sm font-semibold", isCritical ? "text-cyber-red" : "text-cyber-yellow")}>{rec.title}</h4>
                    <p className="text-sm text-muted-foreground mt-1">{rec.description}</p>
                    <p className="text-sm text-foreground/80 mt-2 flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                      <span>{rec.suggestion}</span>
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Conexões de rede */}
      {health.connections.length > 0 && (
        <div className="bg-card cyber-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <Wifi className="w-5 h-5 text-primary" />
            <h3 className="text-lg font-semibold">Conexões de Rede Ativas</h3>
          </div>
          <div className="overflow-x-auto max-h-64 overflow-y-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-muted-foreground uppercase bg-secondary/50 sticky top-0">
                <tr>
                  <th className="px-3 py-2 rounded-tl-lg">Processo</th>
                  <th className="px-3 py-2">Local</th>
                  <th className="px-3 py-2">Remoto</th>
                  <th className="px-3 py-2 rounded-tr-lg">Estado</th>
                </tr>
              </thead>
              <tbody>
                {health.connections.map((c, i) => (
                  <tr key={i} className="border-b border-white/5 last:border-0">
                    <td className="px-3 py-2 font-mono truncate max-w-[140px]">
                      {c.owningProcessName || c.owningProcessPid || "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{c.localAddress}:{c.localPort}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{c.remoteAddress}:{c.remotePort}</td>
                    <td className="px-3 py-2 font-mono">{TCP_STATE_PT[c.state] ?? c.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Top processos */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ProcessTable processes={health.topProcessesByCpu} title="CPU" coloredBy="cpu" />
        <ProcessTable processes={health.topProcessesByRam} title="RAM" coloredBy="ram" />
      </div>
    </section>
  );
}
