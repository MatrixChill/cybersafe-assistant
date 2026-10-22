import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Globe,
  Activity,
  Monitor,
  Search,
  RefreshCw,
  AlertCircle,
  Network,
  Eye,
  Shield,
  Lock,
} from "lucide-react";
import type {
  ConnectionSnapshot,
  ProcessSnapshot,
} from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";
import {
  buildProcessMap,
  enrichConnections,
  isTCP,
  countUniqueDestinations,
  UDP_COLLECTION_AVAILABLE,
  type EnrichedConnection,
} from "@/lib/business-network-utils";
import { isAppShuttingDown, onAppShutdown, runUnlessShuttingDown } from "@/lib/shutdownState";

// ── Types ──

type ConnectionState = "loading" | "ready" | "empty" | "error" | "unavailable";
type ProtocolFilter = "all" | "tcp";

// ── Component ──

interface BusinessSecurityCenterProps {
  connections: ConnectionSnapshot[];
  processes: ProcessSnapshot[];
}

export default function BusinessSecurityCenter({
  connections: initialConnections,
  processes: initialProcesses,
}: BusinessSecurityCenterProps) {
  const [connections, setConnections] = useState<ConnectionSnapshot[]>(initialConnections);
  const [processes, setProcesses] = useState<ProcessSnapshot[]>(initialProcesses);
  const [state, setState] = useState<ConnectionState>(() => {
    // Motor ausente: estado derivado na inicialização (sem setState em efeito).
    if (typeof window !== "undefined" && !window.electronAPI) return "unavailable";
    return initialConnections.length > 0 || initialProcesses.length > 0 ? "ready" : "loading";
  });
  const [error, setError] = useState(() =>
    typeof window !== "undefined" && !window.electronAPI ? "Motor de proteção indisponível." : "",
  );
  const [search, setSearch] = useState("");
  const [protocolFilter, setProtocolFilter] = useState<ProtocolFilter>("all");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selectedConnection, setSelectedConnection] = useState<EnrichedConnection | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  // ── Fetch latest data ──

  const fetchData = useCallback(async () => {
    // Motor ausente: o estado "unavailable" já é derivado na inicialização.
    if (!window.electronAPI) return;
    // Encerramento em curso: sem leituras novas ao serviço.
    if (isAppShuttingDown()) return;
    try {
      const [nextConnections, nextProcesses] = await Promise.all([
        window.electronAPI.getConnections(),
        window.electronAPI.getProcesses(),
      ]);
      if (!mountedRef.current) return;
      // Resultado que chega depois do shutdown é descartado.
      if (isAppShuttingDown()) return;
      setConnections(nextConnections);
      setProcesses(nextProcesses);
      setLastUpdated(new Date());
      setError("");
      setState(nextConnections.length === 0 ? "empty" : "ready");
    } catch {
      if (!mountedRef.current) return;
      // Cancelamento esperado no shutdown: sem estado de erro falso.
      if (isAppShuttingDown()) return;
      setState("error");
      setError("Não foi possível obter as ligações de rede.");
    }
  }, []);

  // ── Initial fetch + sync with props ──

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Sync com props durante a render (padrão de ajuste a props) ──
  // Evita setState dentro de efeitos: só reage quando as props mudam de facto.
  const [prevProps, setPrevProps] = useState({
    connections: initialConnections,
    processes: initialProcesses,
  });
  if (prevProps.connections !== initialConnections || prevProps.processes !== initialProcesses) {
    setPrevProps({ connections: initialConnections, processes: initialProcesses });
    setConnections(initialConnections);
    setProcesses(initialProcesses);
    if (initialConnections.length > 0 && state === "loading") {
      setState("ready");
      setLastUpdated(new Date());
    }
  }

  // ── Polling ──

  useEffect(() => {
    // Leitura inicial pelo timer, fora da fase síncrona do efeito: o lint de
    // hooks rejeita invocar diretamente uma função que faz setState no corpo.
    const firstPoll =
      connections.length === 0 && state === "loading"
        ? setTimeout(() => {
            runUnlessShuttingDown(() => {
              void fetchData();
            });
          }, 0)
        : null;

    const stopPolling = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    pollRef.current = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      runUnlessShuttingDown(() => { void fetchData(); });
    }, 5_000);

    // O polling pára assim que o utilizador confirma a saída.
    const stopOnShutdown = onAppShutdown(stopPolling);

    return () => {
      if (firstPoll !== null) clearTimeout(firstPoll);
      stopOnShutdown();
      stopPolling();
    };
  }, [fetchData, connections.length, state]);

  // ── Enriched data ──

  const processMap = useMemo(() => buildProcessMap(processes), [processes]);

  const enriched = useMemo(
    () => enrichConnections(connections, processMap),
    [connections, processMap],
  );

  // ── Filtered data ──

  const filtered = useMemo(() => {
    let result = enriched;
    if (protocolFilter === "tcp") {
      result = result.filter((e) => isTCP(e.connection));
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.processName.toLowerCase().includes(q) ||
          String(e.processPid ?? "").includes(q) ||
          e.connection.remoteAddress.toLowerCase().includes(q) ||
          (e.connection.domain ?? "").toLowerCase().includes(q),
      );
    }
    return result;
  }, [enriched, protocolFilter, search]);

  // ── Summary stats ──

  const stats = useMemo(() => {
    const total = connections.length;
    const tcpCount = connections.filter(isTCP).length;
    const processPids = new Set<number>();
    for (const c of connections) {
      if (c.processPid) processPids.add(c.processPid);
    }
    return {
      total,
      processCount: processPids.size,
      uniqueDestinations: countUniqueDestinations(connections),
      tcp: tcpCount,
    };
  }, [connections]);

  // ── Render ──

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500 overflow-y-auto max-h-[calc(100vh-100px)]">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tight">
          Business <span className="text-primary">Security Center</span>
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Monitorização local de ligações e atividade de rede deste equipamento.
        </p>
        <div className="flex items-center gap-2 mt-2">
          <div className="w-2 h-2 rounded-full bg-cyber-green cyber-pulse" />
          <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
            Estado: Monitorização local
          </span>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/50 text-destructive text-xs font-mono rounded flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {state === "loading" && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="cyber-border rounded-xl p-6 animate-pulse">
              <div className="h-4 bg-secondary/50 rounded w-16 mb-3" />
              <div className="h-8 bg-secondary/50 rounded w-12 mb-1" />
              <div className="h-3 bg-secondary/50 rounded w-20" />
            </div>
          ))}
        </div>
      )}

      {/* Summary cards */}
      {(state === "ready" || state === "empty") && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <SummaryCard
            icon={<Globe className="w-5 h-5 text-primary" />}
            label="Ligações ativas"
            value={stats.total}
          />
          <SummaryCard
            icon={<Monitor className="w-5 h-5 text-primary" />}
            label="Processos com atividade"
            value={stats.processCount}
          />
          <SummaryCard
            icon={<Network className="w-5 h-5 text-primary" />}
            label="Destinos únicos"
            value={stats.uniqueDestinations}
          />
          <SummaryCard
            icon={<Activity className="w-5 h-5 text-cyber-cyan" />}
            label="TCP"
            value={stats.tcp}
          />
          {!UDP_COLLECTION_AVAILABLE && (
            <div className="cyber-border rounded-xl p-5 relative overflow-hidden bg-secondary/20">
              <div className="flex items-center justify-between mb-3">
                <Activity className="w-5 h-5 text-muted-foreground/60" />
              </div>
              <div className="text-lg font-bold font-mono text-muted-foreground mb-1">Indisponível</div>
              <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">UDP</div>
              <p className="text-[10px] font-mono text-muted-foreground/60 mt-2">
                Recolha UDP não incluída nesta versão.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Connection Dashboard */}
      <div className="cyber-border rounded-xl overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 border-b border-border/50 bg-sidebar/30">
          <h3 className="font-mono font-semibold text-foreground flex items-center gap-2 text-sm">
            <Globe className="w-4 h-4 text-primary" />
            Ligações de Rede
            {lastUpdated && (
              <span className="text-[10px] font-normal text-muted-foreground ml-2">
                Atualizado {lastUpdated.toLocaleTimeString()}
              </span>
            )}
          </h3>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="Pesquisar processo, PID ou IP..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 pr-4 py-2 bg-secondary/50 border border-border rounded-lg text-xs font-mono focus:outline-none focus:border-primary/50 text-foreground w-64 transition-all"
              />
            </div>
            <div className="bg-secondary/50 rounded-lg p-1 flex">
              {(["all", "tcp"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setProtocolFilter(f)}
                  className={cn(
                    "px-3 py-1.5 text-xs font-mono rounded transition-all",
                    protocolFilter === f
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-secondary/50",
                  )}
                >
                  {f === "all" ? "Todos" : f.toUpperCase()}
                </button>
              ))}
            </div>
            <span
              className="text-[10px] font-mono text-muted-foreground/70 hidden sm:inline"
              title="A recolha UDP ainda não está disponível nesta versão do CyberSafe."
            >
              UDP indisponível
            </span>
            <button
              onClick={() => void fetchData()}
              className="p-2 rounded-lg bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-all"
              title="Atualizar agora"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          {state === "error" ? (
            <div className="p-12 flex flex-col items-center justify-center text-muted-foreground space-y-4">
              <AlertCircle className="w-12 h-12 opacity-20" />
              <p className="font-mono text-sm">Não foi possível obter as ligações de rede.</p>
              <button
                onClick={() => void fetchData()}
                className="px-4 py-2 bg-primary/10 text-primary rounded-lg text-xs font-mono hover:bg-primary/20 transition-all"
              >
                Tentar novamente
              </button>
            </div>
          ) : state === "unavailable" ? (
            <div className="p-12 flex flex-col items-center justify-center text-muted-foreground space-y-4">
              <Lock className="w-12 h-12 opacity-20" />
              <p className="font-mono text-sm">A monitorização de rede não está disponível.</p>
              <p className="text-xs text-muted-foreground text-center max-w-md">
                Execute a aplicação a partir do ambiente de trabalho do Electron para aceder à monitorização de rede.
              </p>
            </div>
          ) : state === "empty" ? (
            <div className="p-12 flex flex-col items-center justify-center text-muted-foreground space-y-4">
              <Globe className="w-12 h-12 opacity-20" />
              <p className="font-mono text-sm">Nenhuma ligação de rede ativa foi encontrada neste momento.</p>
              <p className="text-xs text-muted-foreground text-center max-w-md">
                As ligações de rede aparecerão aqui quando houver atividade de rede no equipamento.
              </p>
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">Processo</th>
                  <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">PID</th>
                  <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">Protocolo</th>
                  <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">Destino</th>
                  <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">Porta Remota</th>
                  <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">Estado</th>
                  <th className="text-right py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider w-20"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-12 text-center text-muted-foreground font-mono text-sm">
                      Nenhuma ligação corresponde aos filtros.
                    </td>
                  </tr>
                ) : (
                  filtered.map((item, idx) => (
                    <tr
                      key={`${item.connection.remoteAddress}-${item.connection.remotePort}-${item.processPid}-${idx}`}
                      className="border-b border-border/50 hover:bg-secondary/30 transition-colors"
                    >
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className={cn(
                            "w-2 h-2 rounded-full shrink-0",
                            item.processName === "Processo desconhecido"
                              ? "bg-muted-foreground/40"
                              : "bg-cyber-cyan",
                          )} />
                          <span className="font-mono text-sm text-foreground truncate max-w-[180px]">
                            {item.processName}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-mono text-xs text-muted-foreground">
                          {item.processPid ?? "—"}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className={cn(
                          "px-2 py-1 rounded text-[10px] font-mono uppercase font-bold border",
                          isTCP(item.connection)
                            ? "border-cyber-cyan/30 text-cyber-cyan bg-cyber-cyan/10"
                            : "border-border text-muted-foreground bg-secondary/30",
                        )}>
                          {item.connection.protocol ?? "—"}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-mono text-xs text-foreground">
                          {item.connection.remoteAddress || "—"}
                        </span>
                        {item.connection.domain && (
                          <span className="block text-[10px] text-muted-foreground truncate max-w-[160px]">
                            {item.connection.domain}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-mono text-xs text-muted-foreground">
                          {item.connection.remotePort ?? "—"}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className={cn(
                          "px-2 py-1 rounded text-[10px] font-mono border",
                          item.connection.state === "Established"
                            ? "border-cyber-green/30 text-cyber-green bg-cyber-green/10"
                            : item.connection.state === "Listen"
                              ? "border-cyber-yellow/30 text-cyber-yellow bg-cyber-yellow/10"
                              : item.connection.state === "Desconhecido"
                                ? "border-border text-muted-foreground bg-secondary/30 italic"
                                : "border-border text-muted-foreground bg-secondary/30",
                        )}>
                          {item.connection.state ?? "—"}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={() => setSelectedConnection(item)}
                          className="p-1.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                          title="Ver detalhes"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        {state === "ready" && filtered.length > 0 && (
          <div className="p-3 border-t border-border/50 bg-sidebar/30 flex items-center justify-between">
            <span className="text-[10px] font-mono text-muted-foreground">
              {filtered.length} de {connections.length} ligações
            </span>
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
              <Eye className="w-3 h-3" />
              {selectedConnection ? "Detalhes abertos" : "Selecione uma ligação para ver detalhes"}
            </div>
          </div>
        )}
      </div>

      {/* Privacy note */}
      <div className="flex items-start gap-3 p-4 rounded-xl bg-secondary/30 border border-border">
        <Shield className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[11px] text-muted-foreground font-mono leading-relaxed">
          O CyberSafe apresenta metadados de ligação. O conteúdo das comunicações não é capturado.
          Nenhuma password, mensagem, cookie ou payload integral é recolhido.
        </p>
      </div>

      {/* Business — Future Capabilities */}
      <div className="cyber-border rounded-xl p-6">
        <h3 className="font-mono font-semibold text-foreground text-sm mb-4 flex items-center gap-2">
          <Lock className="w-4 h-4 text-muted-foreground" />
          Business — Próximas capacidades
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "Inventário da Rede", desc: "Descoberta de dispositivos" },
            { label: "Deteção de Anomalias", desc: "Baselines de tráfego" },
            { label: "Monitorização de Saída", desc: "Alertas de exfiltração" },
            { label: "Múltiplos Endpoints", desc: "Console central" },
          ].map((item) => (
            <div
              key={item.label}
              className="p-3 rounded-lg bg-secondary/20 border border-border opacity-50"
            >
              <p className="text-xs font-mono text-muted-foreground font-semibold">{item.label}</p>
              <p className="text-[10px] font-mono text-muted-foreground/60 mt-1">{item.desc}</p>
              <span className="text-[9px] font-mono text-muted-foreground/40 mt-2 block">Em desenvolvimento futuro</span>
            </div>
          ))}
        </div>
      </div>

      {/* Detail modal */}
      {selectedConnection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-md cyber-border border-primary/50 bg-card rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-4 border-b border-border/50 flex justify-between items-center bg-secondary/50">
              <div className="flex items-center gap-3">
                <Globe className="w-5 h-5 text-primary" />
                <h2 className="font-mono font-bold text-sm">Detalhe da Ligação</h2>
              </div>
              <button
                onClick={() => setSelectedConnection(null)}
                className="text-muted-foreground hover:text-foreground text-xs font-mono"
              >
                Fechar
              </button>
            </div>
            <div className="p-6 space-y-4">
              <DetailRow label="Processo" value={selectedConnection.processName} />
              <DetailRow label="PID" value={selectedConnection.processPid != null ? String(selectedConnection.processPid) : "Desconhecido"} />
              {selectedConnection.processPath && (
                <DetailRow label="Caminho" value={selectedConnection.processPath} />
              )}
              <DetailRow label="Protocolo" value={selectedConnection.connection.protocol ?? "—"} />
              <DetailRow label="Endereço Remoto" value={selectedConnection.connection.remoteAddress || "—"} />
              <DetailRow label="Porta Remota" value={selectedConnection.connection.remotePort != null ? String(selectedConnection.connection.remotePort) : "—"} />
              <DetailRow label="Estado" value={selectedConnection.connection.state ?? "—"} />
              {selectedConnection.connection.domain && (
                <DetailRow label="Domínio" value={selectedConnection.connection.domain} />
              )}
              <DetailRow label="Observado" value={new Date(selectedConnection.connection.observedAt).toLocaleString()} />
            </div>
            <div className="p-4 border-t border-border/50 bg-secondary/30 flex justify-end">
              <button
                onClick={() => setSelectedConnection(null)}
                className="px-4 py-2 font-mono text-sm rounded bg-secondary/50 hover:bg-secondary transition-colors"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──

function SummaryCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="cyber-border rounded-xl p-5 relative overflow-hidden group">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="flex items-center justify-between mb-3">{icon}</div>
      <div className="text-3xl font-bold font-mono text-foreground mb-1">{value}</div>
      <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">{label}</div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center text-sm font-mono">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-foreground text-xs text-right max-w-[250px] truncate">{value}</span>
    </div>
  );
}
