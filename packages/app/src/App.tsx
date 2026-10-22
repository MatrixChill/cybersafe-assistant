import { useEffect, useState, useCallback, useRef, useMemo, Component, type ReactNode } from "react";
import type {
  ConnectionSnapshot,
  DashboardSummary,
  PcState,
  ProcessSnapshot,
  ProtectionState,
  QuarantineEntry,
  SecurityEvent,
  ThreatEvent,
  HardwareSnapshot,
} from "@cybersafe/shared-types";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { AppearanceProvider, useAppearance } from "./contexts/AppearanceContext";
import { deriveProtectionLevel } from "./lib/protectionHealth";
import { deriveLoadingState, DEFAULT_STARTUP_TIMEOUT_MS } from "./lib/loadingStates";
import { deriveBootReadiness, BOOT_COPY } from "./lib/bootReadiness";
import { classificarLeitura, resumoSync } from "./lib/serviceSyncStatus";
import { buildMatrixContext } from "./lib/matrixContext";
import { criarHistoricoProcessos, estadoDeIdentidade } from "./lib/processIntelligence";
import { buildProcessMatrixContext } from "./lib/processMatrix";
import { canUserAccess, FEATURES } from "./lib/featureControl";
import Sidebar, { type Page } from "./components/Sidebar";

import DashboardPage from "./pages/DashboardPage";
import { type ProtectionPending } from "./components/ProtectionControl";
import ThreatsPage from "./pages/ThreatsPage";
import FileScannerPage from "./pages/FileScannerPage";

import MonitorPage from "./pages/MonitorPage";
import SimulatorPage from "./pages/SimulatorPage";
import TaskManagerPage from "./pages/TaskManagerPage";
import PCCenterPage from "./pages/PCCenterPage";
import ReportsPage from "./pages/ReportsPage";
import BusinessSecurityCenter from "./pages/BusinessSecurityCenter";
import OtimizarPage from "./pages/OtimizarPage";
import SettingsPage from "./pages/SettingsPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import AIAssistant from "./components/AIAssistant";
import { OnboardingOverlay } from "./components/OnboardingOverlay";
import { ExitConfirmHost } from "./components/ExitConfirmDialog";
import { BrandLogo } from "./components/BrandLogo";
import { BootScreen, type BootStep } from "./components/BootScreen";
import { AppTitleBar } from "./components/AppTitleBar";
import { hasSeenOnboarding } from "./lib/onboarding";
import { toastTypeLabel } from "./lib/toastCopy";
import { cpuUsageDisplay } from "./lib/cpuUsage";
import { ramUsageDisplay } from "./lib/ramUsageDisplay";
import { networkTelemetrySample } from "./lib/networkReadings";
import { pcCenterDataOrigin } from "./lib/batteryDisplay";
import { AlertCircle, Loader2, Lock } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { addTelemetrySample } from "@/components/TelemetrySparkline";
import {
  ipcUnlessShuttingDown,
  isAppShuttingDown,
  onAppShutdown,
} from "@/lib/shutdownState";
import {
  PROCESSES_POLL_MS,
  PROCESSES_REFRESH_COALESCE_MS,
  resolveEventRefresh,
} from "@/lib/processActions";

type AuthPage = "login" | "register";

class ErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="auth-page">
          <div className="auth-bg-gradient" />
          <div className="flex flex-col items-center gap-4 w-full max-w-md text-center p-6">
            <div className="p-4 rounded-full bg-destructive/10 border border-destructive/30">
              <AlertCircle className="w-10 h-10 text-destructive" />
            </div>
            <h1 className="text-xl font-bold font-mono text-foreground">Erro no renderer</h1>
            <p className="text-sm text-muted-foreground">
              Não foi possível carregar esta área do CyberSafe.
            </p>
            <details className="w-full text-left">
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                Detalhes técnicos
              </summary>
              <pre className="mt-2 text-[11px] font-mono text-destructive/80 bg-destructive/5 border border-destructive/20 rounded-lg p-3 overflow-auto max-h-48">
                {this.state.error.message}
                {"\n"}
                {this.state.error.stack}
              </pre>
            </details>
            <button
              onClick={() => { this.setState({ error: null }); window.location.reload(); }}
              className="mt-2 px-6 py-2.5 bg-primary text-primary-foreground font-mono text-sm rounded-lg hover:bg-primary/90 transition-all"
            >
              Tentar novamente
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const emptySummary: DashboardSummary = {
  // null = o servico nao leu nada. Um 100 aqui era um score perfeito NAO
  // medido — o hero animaria 0→100 e o utilizador leria "protegido a 100"
  // sem nenhuma leitura. Sem dado, sem numero.
  riskScore: null,
  totalEvents: 0,
  highSeverityEvents: 0,
  downloadRisk: "low",
  recentThreats: [],
  alerts: [],
  systemStatus: "degraded",
};

function buildDashboard(protection: ProtectionState | null, threats: ThreatEvent[]): DashboardSummary {
  if (!protection) return emptySummary;
  const alerts = threats
    .filter((item) => item.severity === "high" || item.severity === "critical")
    .slice(0, 5)
    .map((item, index) => ({
      id: `${item.createdAt}-${index}`,
      title: item.summary || item.domain,
      description: item.rulesTriggered.join(", "),
      severity: item.severity,
      createdAt: item.createdAt,
    }));

  return {
    // Sem numero do motor, sem score na UI: `null` = nao medido. Um valor por
    // defeito aqui seria uma garantia inventada (Fase B: Dashboard honesto).
    riskScore:
      typeof protection.stats.riskScore === "number" && Number.isFinite(protection.stats.riskScore)
        ? Math.max(0, 100 - protection.stats.riskScore)
        : null,
    totalEvents: protection.stats.totalEvents,
    highSeverityEvents: protection.stats.highSeverityEvents,
    downloadRisk: threats.some((item) => item.source === "download-monitor" && item.severity === "critical")
      ? "critical"
      : threats.some((item) => item.source === "download-monitor" && item.severity === "high")
        ? "high"
        : "low",
    recentThreats: threats.slice(0, 10),
    alerts,
    systemStatus: protection.status,
    engineHealth: protection.engine,
  };
}

function AuthenticatedApp() {
  const { user, logout } = useAuth();
  const { identity } = useAppearance();
  const [page, setPage] = useState<Page>("dashboard");
  const [protection, setProtection] = useState<ProtectionState | null>(null);
  const [serviceConnected, setServiceConnected] = useState<boolean | null>(null);
  const serviceConnectionRef = useRef<boolean | null>(null);
  // Invalida respostas de pedidos anteriores a uma queda/reconexão.
  const connectionGeneration = useRef(0);
  const snapshotGeneration = useRef(0);
  /**
   * Instante de montagem, para o contrato de carregamento medir a demora do
   * arranque e conseguir apresentar um motivo (`timeout`) em vez de um
   * «A carregar» sem fim. Só conta a partir do momento em que a app autenticada
   * existe; não é telemetria nem vai a lado nenhum.
   */
  const startedAtRef = useRef<number>(Date.now());
  const [threats, setThreats] = useState<ThreatEvent[]>([]);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [processes, setProcesses] = useState<ProcessSnapshot[]>([]);
  const processHistoryRef = useRef<ReturnType<typeof criarHistoricoProcessos> | null>(null);
  if (!processHistoryRef.current) processHistoryRef.current = criarHistoricoProcessos();
  const [processesObservedAt, setProcessesObservedAt] = useState<number | null>(null);
  const [processExplanation, setProcessExplanation] = useState<{id: number; pid?: number; startedAt?: string | null} | null>(null);
  const [connections, setConnections] = useState<ConnectionSnapshot[]>([]);
  const [quarantine, setQuarantine] = useState<QuarantineEntry[]>([]);
  const [hardware, setHardware] = useState<HardwareSnapshot | null>(null);
  const [pcState, setPcState] = useState<PcState | null>(null);
  // Última leitura REAL de hardware. Sobrevive à queda do serviço (que põe `hardware`
  // a null) para o PC Center mostrar CACHED em vez de nada. Nunca recebe fixtures.
  const lastRealHardwareRef = useRef<HardwareSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  /** Leituras recusadas por política na última sincronização (gate de fixture). */
  const [syncRecusas, setSyncRecusas] = useState(0);
  const [isClearing, setIsClearing] = useState(false);
  const [toasts, setToasts] = useState<{ id: string; event: SecurityEvent }[]>([]);
  /** Scan session that FileScannerPage should auto-start. */
  const [pendingScan, setPendingScan] = useState<{ type: string; targetPath?: string } | null>(null);
  /**
   * Pedido de proteção EM VOO iniciado a partir do Painel. É FEEDBACK de
   * clique, nunca estado confirmado: o estado real continua a vir de
   * `protection` (getProtectionState). Bloqueia segundos cliques e ações no
   * controlo enquanto a operação não é confirmada pelo serviço.
   */
  const [protectionPending, setProtectionPending] = useState<ProtectionPending>(null);
  const [protectionActionError, setProtectionActionError] = useState<string | null>(null);

  /**
   * "booting" = moldura de arranque. "ready" = abriu por facto confirmado.
   * "limited" = o utilizador entrou sem confirmação; a limitação fica visível
   * no painel e nada é afirmado sobre a proteção.
   */
  const [bootPhase, setBootPhase] = useState<"booting" | "ready" | "limited">("booting");
  /**
   * Orçamento de APRESENTAÇÃO esgotado. Não é um facto do serviço nem uma
   * promoção a pronto: com dados em falta o estado passa a UNKNOWN.
   */
  const [bootPastDeadline, setBootPastDeadline] = useState(false);
  /** Onboarding de boas-vindas: aparece apenas na primeira utilização. */
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => !hasSeenOnboarding());
  /** Evita rajadas do mesmo ficheiro/alerta na UI (notificações nativas já têm debounce no Electron). */
  const toastDebounceRef = useRef<Map<string, number>>(new Map());
  const toastDismissTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const TOAST_DEBOUNCE_MS = 12_000;
  const TOAST_AUTO_DISMISS_MS = 10_000;

  /**
   * Lista de processos: caminho PRÓPRIO, com uma só garantia de trabalho.
   *
   * Medido nesta máquina: o poll inicial do serviço emitiu 177 eventos
   * `process.started` num único poll, e cada evento fazia fetchSnapshot completo
   * (7 pedidos IPC) — ou seja, a rajada de arranque virava milhares de pedidos
   * para atualizar uma lista. `processes.list` mede 720–1085 ms; os outros seis
   * tópicos do snapshot medem 0–1 ms. Por isso:
   *   · um evento de processos pede UM pedido (processes), nunca os 7;
   *   · a rajada é agrupada numa janela de 250 ms (0,3× de uma enumeração);
   *   · com um pedido em voo não se abre outro (o serviço, aliás, já
   *     partilha uma única enumeração concorrente).
   */
  /**
   * Restauro partilhado do scroll entre rotas.
   *
   * O contentor que faz scroll é o `<main>` (overflow-y-auto), e ele NÃO é
   * remontado quando a página muda — só o filho `motion.div key={page}` é.
   * Sem este ancoragem, quem chega do fundo do Gestor de Tarefas abre o
   * Monitor de Rede ou as Definições já no meio do scroll.
   *
   * O reset está atrelado à MONTAGEM do elemento da nova página (ref callback
   * com `key={page}`), não ao render: um simples refresh da mesma rota
   * (poling, busca, toast) não remonta nada e por isso não perde a posição.
   */
  const mainScrollRef = useRef<HTMLElement | null>(null);
  // Identidade ESTAVEL de proposito: um ref recreated a cada render seria
  // desanexado/reanexado pelo React em cada commit, e o reset passaria a
  // acontecer tambem nos refreshes da mesma rota. Assim so dispara quando o
  // elemento da pagina e realmente montado (mudanca de `key={page}`).
  const anchorNewPageAtTop = useCallback((node: HTMLDivElement | null) => {
    if (node && mainScrollRef.current) mainScrollRef.current.scrollTop = 0;
  }, []);

  const processesRefreshRef = useRef<{ inFlight: boolean; lastRequestedAt: number; timer?: ReturnType<typeof setTimeout> }>({
    inFlight: false,
    lastRequestedAt: 0,
  });

  const acceptProcesses = useCallback((next: ProcessSnapshot[]) => {
    const observedAt = Date.now();
    processHistoryRef.current?.registar(next, observedAt);
    setProcessesObservedAt(observedAt);
    setProcesses(next);
  }, []);

  const refreshProcesses = useCallback(async (): Promise<void> => {
    const api = window.electronAPI;
    if (!api || isAppShuttingDown() || serviceConnectionRef.current === false) return;
    const generation = connectionGeneration.current;
    const state = processesRefreshRef.current;
    if (state.inFlight) return; // um pedido em voo: não se deita trabalho fora
    state.inFlight = true;
    try {
      const next = await ipcUnlessShuttingDown(() => api.getProcesses());
      if (next && generation === connectionGeneration.current) acceptProcesses(next);
    } catch {
      // Falha isolada: o próximo refresh (evento ou poll) corrige. A lista
      // anterior fica no ecrã — nunca uma lista vazia por causa de um erro.
    } finally {
      state.inFlight = false;
    }
  }, [acceptProcesses]);

  /** Pedido agrupado: várias ondas de uma rajada dão UM pedido no fim. */
  const scheduleProcessesRefresh = useCallback(() => {
    const state = processesRefreshRef.current;
    const fire = () => {
      state.timer = undefined;
      state.lastRequestedAt = Date.now();
      void refreshProcesses();
    };
    if (state.timer !== undefined) return; // já há uma janela aberta
    state.timer = setTimeout(fire, PROCESSES_REFRESH_COALESCE_MS);
  }, [refreshProcesses]);

  useEffect(() => {
    // Poll da lista só enquanto uma página mostra processos, e só com a janela
    // visível.
    //
    // 2 s, e não 10 s: o PRODUTOR passou a produzir nova verdade de 2 em 2 s
    // (cadência adaptativa do serviço, com um custo de enumeração de mediana
    // 591 ms). Ler de 10 em 10 s significava ler a verdade 5 vezes atrasada — o
    // serviço descobria o processo novo em ~2,1 s e o ecrã só o mostrava ~5 s
    // depois, em média. Alinhar consumidor com produtor é o patch.
    //
    // E baixar este número NÃO paga o preço que parece: este poll é um pedido
    // IPC de LEITURA DE CACHE, não uma enumeração do SO. Quem decide o ritmo
    // de enumerar é o cadence adaptativo do serviço. Com este poll a marcar
    // observador, o cache tem sempre ~2 s de idade, muito abaixo do TTL de 20 s:
    // o serviço responde de cache e não força enumeração nenhuma. Medido: 30
    // pedidos em 60 s dão 1 enumeração (teste em service/test/process-kill).
    const showsProcesses = page === "taskmanager" || page === "monitor";
    if (!showsProcesses || !window.electronAPI) return;
    const interval = setInterval(() => {
      if (serviceConnectionRef.current === false) return;
      if (document.visibilityState !== "visible") return;
      scheduleProcessesRefresh();
    }, PROCESSES_POLL_MS);
    const stopOnShutdown = onAppShutdown(() => {
      clearInterval(interval);
      const state = processesRefreshRef.current;
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
    });
    return () => {
      stopOnShutdown();
      clearInterval(interval);
      const state = processesRefreshRef.current;
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
    };
  }, [page, scheduleProcessesRefresh]);


  const fetchSnapshot = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) {
      setError("Motor de proteção indisponível.");
      setIsLoading(false);
      return;
    }

    // Encerramento em curso: não inicia o ciclo de 7 pedidos IPC (o main já
    // desligou o ServiceClient — eram estes que geravam "Service client
    // disconnected" repetidos no log).
    if (isAppShuttingDown() || serviceConnectionRef.current === false) return;
    const generation = connectionGeneration.current;
    const snapshotId = ++snapshotGeneration.current;

    try {
      // `allSettled`, não `all`: sete leituras independentes partilhavam um único
      // resultado. O gate de fixture DEV recusa de propósito rotinas fora do
      // âmbito da sessão (dev-fixture-gate.ts) e o ServiceClient converte essa
      // recusa numa rejeição — com `Promise.all` isso apagava as seis leituras
      // que responderam e mostrava «Não foi possível sincronizar com o serviço»
      // numa sessão onde o pipe está ligado e o scan trabalha. A decisão
      // recusa-deliberada vs falha-real vive em lib/serviceSyncStatus.
      const snapshot = await ipcUnlessShuttingDown(() =>
        Promise.allSettled([
          api.getProtectionState(),
          api.getSecurityEvents({ limit: 100 }),
          api.getThreatEvents(),
          api.getProcesses(),
          api.getConnections(),
          api.getQuarantineFiles(),
          api.getPCState(),
        ]),
      );

      // null = cancelado pelo shutdown (esperado, sem ruído): a UI não é mexida.
      if (!snapshot || generation !== connectionGeneration.current || snapshotId !== snapshotGeneration.current) return;

      const [rProtection, rEvents, rThreats, rProcesses, rConnections, rQuarantine, rPCState] = snapshot;
      const resumo = resumoSync(snapshot.map(classificarLeitura));
      // O estado REFUSED é uma contagem medida deste ciclo, não uma suposição.
      setSyncRecusas(resumo.recusas);

      // Aplica-se só o que respondeu. Uma rotina recusada mantém o último valor
      // confirmado: apagar um facto porque a política de teste o não expõe seria
      // a mentira na direcção contrária.
      if (rProtection.status === "fulfilled") setProtection(rProtection.value);
      if (rEvents.status === "fulfilled") setEvents(rEvents.value);
      if (rThreats.status === "fulfilled") setThreats(rThreats.value);
      if (rProcesses.status === "fulfilled") acceptProcesses(rProcesses.value);
      if (rConnections.status === "fulfilled") setConnections(rConnections.value);
      if (rQuarantine.status === "fulfilled") setQuarantine(rQuarantine.value);
      if (rPCState.status === "fulfilled") setPcState(rPCState.value);

      if (resumo.deveMarcarFalhaSync) {
        // Uma falha REAL continua a custar o que custava: a proteção deixa de
        // poder ser apresentada como confirmada e o ciclo diz que falhou. As
        // recusas do gate nunca chegam aqui.
        console.error(snapshot.find((r) => r.status === "rejected")?.reason);
        setProtection(null);
        setError("Falha ao sincronizar com o serviço.");
      } else {
        setError("");
      }
    } catch (err) {
      if (generation !== connectionGeneration.current || snapshotId !== snapshotGeneration.current) return;
      console.error(err);
      setProtection(null);
      setError("Falha ao sincronizar com o serviço.");
    } finally {
      if (!isAppShuttingDown()) setIsLoading(false);
    }
  }, [acceptProcesses]);

  // Refresh só do estado de proteção — não o snapshot de 7 subsistemas. Um
  // toggle confirmado precisa de refletir o facto novo sem provocar o custo de
  // uma leitura global (regra IPC: nada de snapshot storms por ação do user).
  const refreshProtection = useCallback(async () => {
    const api = window.electronAPI;
    const connectedBefore = serviceConnectionRef.current;
    if (!api || isAppShuttingDown() || connectedBefore === false) return;
    const generation = connectionGeneration.current;
    try {
      const next = await api.getProtectionState();
      // Ler para locais (nunca afunilar `serviceConnectionRef.current` em si):
      // era o TS2367. Depois do await só escreve se ainda estiver ligado e se
      // nenhuma queda/reconexão invalidou a geração.
      const connectedAfter = serviceConnectionRef.current;
      if (isAppShuttingDown() || connectedAfter === false || connectionGeneration.current !== generation) return;
      setProtection(next);
    } catch {
      // Sem leitura nova: mantém-se o último estado confirmado. O erro real já
      // propaga pelo main; a UI nunca inventa um estado em cima do silêncio.
    }
  }, []);

  // Ações do controlo do Painel. Reutilizam o caminho de serviço já usado pela
  // tray (monitor.start/stop e monitor.pause). Nunca disparam offline nem com
  // outra operação em voo; nunca mostram estado antes da confirmação.
  const handleSetProtection = useCallback(async (enabled: boolean) => {
    const api = window.electronAPI;
    if (!api || serviceConnectionRef.current !== true || protectionPending) return;
    setProtectionPending(enabled ? "starting" : "stopping");
    try {
      // GUI-TEST-18/19: o resultado ja traz a causa sanitizada — deixou de
      // existir rollback silencioso para "Desativada".
      const res = await api.setProtection(enabled);
      setProtectionActionError(res?.reason ?? (!res || res.ok === false ? "O serviço não confirmou a mudança de estado." : null));
    } catch (err) {
      setProtectionActionError(err instanceof Error ? err.message.slice(0, 200) : "Falha de comunicação com o serviço.");
    } finally {
      await refreshProtection();
      setProtectionPending(null);
    }
  }, [protectionPending, refreshProtection]);

  const handlePauseProtection = useCallback(async (minutes: number) => {
    const api = window.electronAPI;
    if (!api || serviceConnectionRef.current !== true || protectionPending) return;
    setProtectionPending("pausing");
    try {
      await api.pauseProtection(minutes);
    } finally {
      await refreshProtection();
      setProtectionPending(null);
    }
  }, [protectionPending, refreshProtection]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    let disposed = false;
    let eventsSeen = 0;
    const apply = ({ connected }: { connected: boolean }) => {
      if (disposed || isAppShuttingDown()) return;
      if (serviceConnectionRef.current !== connected) connectionGeneration.current++;
      serviceConnectionRef.current = connected;
      setServiceConnected(connected);
      if (!connected) {
        processHistoryRef.current?.limpar();
        setProcessesObservedAt(null);
        setProtection(null);
        setHardware(null);
        setPcState(null);
        setIsLoading(false);
        setError("Serviço de proteção indisponível.");
      } else {
        // Apenas leitura: reconectar nunca ativa proteção.
        void fetchSnapshot();
      }
    };
    const unsubscribe = api.onServiceConnectionState((state) => { eventsSeen++; apply(state); });
    const initialVersion = eventsSeen;
    void api.getServiceConnectionState().then((state) => {
      if (eventsSeen === initialVersion) apply(state);
    }).catch(() => { if (eventsSeen === initialVersion) apply({ connected: false }); });
    return () => { disposed = true; unsubscribe(); };
  }, [fetchSnapshot]);


  useEffect(() => {
    if (bootPhase !== "booting") return;
    // Orçamento de APRESENTAÇÃO. Ao esgotar-se, o arranque não mente: o estado
    // passa a UNKNOWN e a moldura não abre sozinha. Abrir é um clique explícito,
    // com a limitação escrita — nenhum dado é inventado para "ficar pronto".
    const timer = setTimeout(() => setBootPastDeadline(true), DEFAULT_STARTUP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [bootPhase]);

  // Reabre o onboarding a partir das Configurações.
  useEffect(() => {
    const open = () => setShowOnboarding(true);
    window.addEventListener("cybersafe:open-onboarding", open);
    return () => window.removeEventListener("cybersafe:open-onboarding", open);
  }, []);

  // A tray pede navegação ("Ver estado da proteção", "Quarentena", "Definições").
  // Só entram páginas que existem de facto: um destino inválido é ignorado em
  // vez de deixar o utilizador numa página que não corresponde ao que pediu.
  useEffect(() => {
    if (!window.electronAPI) return;
    const VALID: Page[] = ["dashboard", "pccenter", "threats", "quarantine", "scanner", "monitor",
      "simulator", "reports", "taskmanager", "otimizar", "settings", "business"];
    return window.electronAPI.onNavigateRequest((requested) => {
      if (isAppShuttingDown()) return;
      const next = requested as Page;
      if (VALID.includes(next)) setPage(next);
    });
  }, []);

  useEffect(() => {
    void fetchSnapshot();
    if (!window.electronAPI) return;

    const unsubscribe = window.electronAPI.onSecurityEvent((event) => {
      // Shutdown: nada de refresh (e nenhum dos 7 pedidos) a caminho da saída.
      if (isAppShuttingDown() || serviceConnectionRef.current === false) return;
      setEvents((prev) => [...prev.filter((entry) => entry.sequence !== event.sequence), event].slice(-100));
      if (event.type === "threat.detected" || event.type === "process.blocked") {
        const data = event.data as { artifactPath?: string } | undefined;
        const toastKey = data?.artifactPath || event.summary || event.id;
        const now = Date.now();
        const last = toastDebounceRef.current.get(toastKey) ?? 0;
        if (now - last < TOAST_DEBOUNCE_MS) {
          void fetchSnapshot();
          return;
        }
        toastDebounceRef.current.set(toastKey, now);

        setToasts((prev) => [...prev, { id: event.id, event }].slice(-4));

        const existing = toastDismissTimers.current.get(event.id);
        if (existing) clearTimeout(existing);
        const tid = setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== event.id));
          toastDismissTimers.current.delete(event.id);
        }, TOAST_AUTO_DISMISS_MS);
        toastDismissTimers.current.set(event.id, tid);
      }
      // Uma decisão, um sítio: `resolveEventRefresh` diz o que cada evento
      // obriga a fazer. `scan.progress` não pede nada; um evento de processos
      // pede UM pedido (a lista) e nunca o snapshot completo de 7; o resto
      // mantém o snapshot de sempre.
      const route = resolveEventRefresh(event.type);
      if (route === "none") return;
      if (route === "processes") {
        scheduleProcessesRefresh();
        return;
      }
      void fetchSnapshot();
    });

    // No shutdown cancelamos já a subscrição de eventos e os toasts pendentes.
    const stopOnShutdown = onAppShutdown(() => {
      unsubscribe?.();
      toastDismissTimers.current.forEach((t) => clearTimeout(t));
      toastDismissTimers.current.clear();
      const state = processesRefreshRef.current;
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
    });

    return () => {
      stopOnShutdown();
      unsubscribe?.();
      toastDismissTimers.current.forEach((t) => clearTimeout(t));
      toastDismissTimers.current.clear();
    };
  }, [fetchSnapshot, scheduleProcessesRefresh]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    // Hardware snapshot — CPU/RAM/network every ~2s for real-time feel.
    // Backend already handles different cadences internally (CPU/RAM: 1s, disk/temperatures: 10s).
    // IPC returns latest cached snapshot, so this is cheap.
    const interval = setInterval(async () => {
      if (serviceConnectionRef.current === false) return;
      const generation = connectionGeneration.current;
      if (document.visibilityState !== 'visible') return;
      if (isAppShuttingDown()) return;
      try {
        const snap = await api.getHardwareSnapshot();
        // Snapshot que chega depois do shutdown começar é descartado.
        if (isAppShuttingDown() || generation !== connectionGeneration.current) return;
        lastRealHardwareRef.current = snap;
        setHardware(snap);
        // Telemetria só com medição ATUAL: uma falha de leitura não pode entrar
        // no gráfico como 0% (TP-PAP-CPU-USAGE-TRUTH). 0 real continua válido.
        const cpuUsage = cpuUsageDisplay(snap.cpu);
        if (cpuUsage.state === "available" && cpuUsage.value !== null) {
          addTelemetrySample("cpu", cpuUsage.value);
        }
            const ramUsage = ramUsageDisplay(snap.ram);
      if (ramUsage.state === "available" && ramUsage.value !== null) addTelemetrySample("ram", ramUsage.value);
        if (snap.cpu.temperature != null) addTelemetrySample("cpu-temp", snap.cpu.temperature);
        if (snap.gpu?.temperature != null) addTelemetrySample("gpu-temp", snap.gpu.temperature);
        if (snap.gpu?.usagePercent != null) addTelemetrySample("gpu", snap.gpu.usagePercent);
        // Rede: só uma leitura ATUAL entra nos gráficos (pending/stale/
        // unavailable não são 0 B/s). 0 B/s real continua a entrar.
        const netSample = networkTelemetrySample(snap.network);
        if (netSample) {
          addTelemetrySample("net-rx", netSample.rxSec);
          addTelemetrySample("net-tx", netSample.txSec);
        }
      } catch { /* silencioso por desenho: poller de telemetria */ }
    }, 2_000);

    // Initial fetch
    const initialGeneration = connectionGeneration.current;
    if (document.visibilityState === 'visible' && serviceConnectionRef.current !== false) {
      api.getHardwareSnapshot()
        .then((snap) => { if (!isAppShuttingDown() && initialGeneration === connectionGeneration.current && serviceConnectionRef.current !== false) { lastRealHardwareRef.current = snap; setHardware(snap); } })
        .catch(() => {});
    }

    // O timer pára no instante em que o utilizador confirma a saída.
    const stopOnShutdown = onAppShutdown(() => clearInterval(interval));
    return () => {
      stopOnShutdown();
      clearInterval(interval);
    };
  }, []);

  async function handleClear() {
    setIsClearing(true);
    try {
      if (window.electronAPI) {
        await window.electronAPI.clearThreatEvents();
      }
      await fetchSnapshot();
    } finally {
      setIsClearing(false);
    }
  }

  const dashboard = buildDashboard(protection, threats);
  // G2: os campos factuais do tempo real, lidos do estado do servico. Sem
  // `protection` nao ha nada; o Dashboard so mostra a linha quando o campo
  // existe de facto (nunca "Desativada" por ausencia de leitura).
  const realtimeInfo = serviceConnected === false ? { disponivel: false } : protection
    ? { enabled: protection.protectionEnabled, pausedUntil: protection.protectionPausedUntil }
    : undefined;

  const protectionLevel = serviceConnected === false ? "critical" : protection
    ? deriveProtectionLevel(protection.status, protection.engine, realtimeInfo ?? {})
    : "degraded";

  // Contrato de estados de carregamento (lib/loadingStates): distingue
  // INITIALIZING / READY / DEGRADED / UNAVAILABLE / ERROR a partir dos factos
  // do runtime. Aplica-se aos dois sítios realmente relevantes — o arranque
  // (BootScreen, abaixo) e a ligação ao serviço / proteção (banner de estado).
  // Não substitui a saúde dos motores: quando `protection` já existe, devolve
  // READY/DEGRADED/UNAVAILABLE/ERROR e NUNCA «a carregar».
  const loadingState = deriveLoadingState({
    booting: bootPhase === "booting",
    serviceConnected,
    protection,
    syncError: error,
    syncRecusas,
    elapsedMs: Date.now() - startedAtRef.current,
    timeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
  });

  /**
   * Prontidão do arranque: decide se a moldura pode abrir. O tempo só produz
   * UNKNOWN; READY exige serviço confirmado e as três leituras obrigatórias.
   */
  const bootReadiness = deriveBootReadiness({
    serviceConnected,
    protection,
    pcState,
    hardware,
    loadingState: loadingState.state,
    syncError: error,
    syncRecusas,
    pastDeadline: bootPastDeadline,
  });

  // Um facto confirmado abre a moldura sem esperar pelo relógio; UNKNOWN nunca
  // abre sozinho — a entrada em modo limitado é o clique explícito do ecrã.
  useEffect(() => {
    if (bootPhase !== "booting") return;
    if (bootReadiness.opensShell) setBootPhase("ready");
  }, [bootPhase, bootReadiness.opensShell]);

  /**
   * Rótulos dos passos: apresentação do que já está confirmado, nada mais.
   * Um passo só fica «activo» enquanto houver uma espera a decorrer.
   */
  const bootSteps: BootStep[] = [
    { label: "A verificar estado da proteção", status: bootReadiness.confirmed.protection ? "done" : "active" },
    { label: "A ligar ao serviço", status: bootReadiness.confirmed.service ? "done" : "pending" },
    {
      label: "A verificar estado do computador",
      status: bootReadiness.confirmed.pcState ? "done" : bootReadiness.confirmed.service ? "active" : "pending",
    },
    {
      label: "A carregar sensores",
      status: bootReadiness.confirmed.hardware ? "done" : bootReadiness.confirmed.pcState ? "active" : "pending",
    },
  ];

  // Contexto sanitizado da Matrix: apenas métricas agregadas, sem caminhos,
  // emails ou conteúdo de ficheiros (privacidade em primeiro lugar). A montagem
  // é o helper puro `lib/matrixContext`, que acrescenta o estado FACTUAL do
  // tempo real (on/off/unknown) ao que o modelo vê.
  const matrixContext = useMemo(
    () => buildMatrixContext({ protection, hardware, pcState, threats }),
    [protection, hardware, pcState, threats],
  );

  // Samples are recorded only when an existing process request succeeds.
  // No extra polling or OS enumeration is introduced by this diagnosis.
  const processDiagnostic = useMemo(() => {
    if (processesObservedAt === null || serviceConnected === false) return null;
    return processHistoryRef.current?.diagnosticar(hardware, processes, Date.now()) ?? null;
  }, [processesObservedAt, serviceConnected, hardware, processes]);
  const processContext = useMemo(() => {
    if (!processDiagnostic) return null;
    const selected = processes.find(p => p.pid === processExplanation?.pid && (p.startedAt || null) === (processExplanation?.startedAt ?? null));
    return buildProcessMatrixContext(processDiagnostic, selected?.pid, selected);
  }, [processDiagnostic, processes, processExplanation]);
  /**
   * PACOTE C: identidade CONGELADA no clique. O painel envia pid + instante de
   * início da amostra mostrada; o App não re-resolve por PID simples (o Windows
   * reutiliza PIDs — "processo sumido não vira outro"). O estado derivado
   * (presente/sumido/reutilizado) viaja até à resposta para ela dizer a
   * verdade quando a instância já desapareceu.
   */
  const explicacaoIdentidade = estadoDeIdentidade(processes, processExplanation);
  const explainProcess = (pid?: number, startedAt?: string | null) => {
    if (pid === undefined) {
      setProcessExplanation({ id: Date.now() });
      return;
    }
    setProcessExplanation({ id: Date.now(), pid, startedAt: startedAt ?? null });
  };

  function handleScan(type: string, targetPath?: string) {
    setPendingScan({ type, targetPath });
    setPage("scanner");
  }

  // PC Center: com a ligação caída mostra a última leitura real (CACHED), sem fixtures.
  const pcCenterHardware = hardware ?? (serviceConnected === false ? lastRealHardwareRef.current : null);
  const pcCenterOrigin = pcCenterDataOrigin({ hasSnapshot: pcCenterHardware !== null, serviceConnected });

  function renderPage() {
    switch (page) {
      case "dashboard":
        return <DashboardPage dashboard={dashboard} isLoading={isLoading} hardware={hardware} pcState={pcState} onScan={handleScan} realtime={realtimeInfo} onSetProtection={handleSetProtection} onPauseProtection={handlePauseProtection} protectionPending={protectionPending} protectionError={protectionActionError} onDismissProtectionError={() => setProtectionActionError(null)} serviceConnected={serviceConnected} />;
      case "pccenter":
        // O estado de ligação é lido aqui, no commit do render — não dentro de um `useMemo`
        // sobre um ref. Em produção o prop é `null` e o PC Center não emite atributos.
        return <PCCenterPage hardware={pcCenterHardware} pcState={pcState} dataOrigin={pcCenterOrigin} devTraceConnection={import.meta.env.DEV ? { connected: serviceConnected, generation: connectionGeneration.current } : null} />;
      case "threats":
        return (
          <ThreatsPage
            events={threats}
            onClear={handleClear}
            isClearing={isClearing}
            quarantine={quarantine}
            onQuarantineChanged={() => fetchSnapshot()}
            quarantinePolicy={protection?.stats?.quarantinePolicy}
          />
        );
      case "scanner":
        return <FileScannerPage pendingScan={pendingScan} onScanConsumed={() => setPendingScan(null)} />;

      case "taskmanager":
        return <TaskManagerPage processes={processes} onRefreshProcesses={refreshProcesses} diagnostic={processDiagnostic ?? undefined} onExplainProcess={explainProcess} />;
      case "monitor":
        return <MonitorPage events={events} processes={processes} connections={connections} protection={protection} quarantine={quarantine} />;
      case "quarantine":
        // Rota antiga preservada: o tray (`app:navigate` → "quarantine") e
        // marcadores anteriores aterram na aba Quarentena de Ameaças — mesmo
        // conteudo real, sem entrada isolada no menu.
        return (
          <ThreatsPage
            events={threats}
            onClear={handleClear}
            isClearing={isClearing}
            quarantine={quarantine}
            onQuarantineChanged={() => fetchSnapshot()}
            quarantinePolicy={protection?.stats?.quarantinePolicy}
            initialTab="quarantine"
          />
        );
      case "simulator":
        return <SimulatorPage />;
      case "otimizar":
        return (
          <OtimizarPage
            hardware={hardware}
            protecao={{
              /* A fonte é o motor de proteção, lido pelo servico — o MESMO
                 objeto que alimenta o Painel. Nada aqui é uma nova leitura nem
                 uma segunda opiniao sobre o estado. `aCarregar` é o estado do
                 arranque, para a página poder dizer «a ler» em vez de afirmar
                 disponível à custa de um campo ausente. */
              nivel: protectionLevel,
              estado: protection?.status ?? null,
              motores: protection?.engine,
              pontuacao: dashboard.riskScore,
              tempoReal: realtimeInfo ?? null,
              servicoLigado: serviceConnected,
              aCarregar: isLoading,
            }}
          />
        );
      case "settings":
        return <SettingsPage />;
      case "reports":
        if (!canUserAccess(FEATURES.REPORTS, user)) {
          return <DashboardPage dashboard={dashboard} isLoading={isLoading} hardware={hardware} pcState={pcState} realtime={realtimeInfo} />;
        }
        return <ReportsPage events={events} threats={threats} quarantine={quarantine} protection={protection} pcState={pcState} />;
      case "business":
        if (!canUserAccess(FEATURES.BUSINESS_SECURITY_CENTER, user)) {
          return (
            <div className="p-8">
              <div className="cyber-border rounded-xl p-12 text-center space-y-4">
                <Lock className="w-14 h-14 mx-auto text-primary opacity-80" />
                <h1 className="text-xl font-bold font-mono text-foreground">
                  Business Security Center
                </h1>
                <p className="text-sm text-muted-foreground max-w-md mx-auto">
                  Esta funcionalidade está disponível para contas Business.
                </p>
                <div className="flex justify-center">
                  <button
                    onClick={() => setPage("dashboard")}
                    className="px-5 py-2.5 bg-primary text-primary-foreground font-mono text-sm rounded-lg hover:bg-primary/90 transition-all"
                  >
                    Voltar ao Painel
                  </button>
                </div>
              </div>
            </div>
          );
        }
        return <BusinessSecurityCenter connections={connections} processes={processes} />;
    }
  }

  if (bootPhase === "booting") {
    return (
      <BootScreen
        readiness={bootReadiness}
        steps={bootSteps}
        onEnterLimited={() => setBootPhase("limited")}
      />
    );
  }

  const isLiquid = identity === "cybersafe-liquid";
  const isCore = identity === "cybersafe-core";

  return (
    <div className={cn(
      // `titlebar-offset`: compensa a faixa de janela fixa (42 px) para o
      // conteúdo começar por baixo dela — sem barras nem botões duplicados.
      "titlebar-offset flex h-screen bg-background text-foreground overflow-hidden font-sans selection:bg-primary/30 relative",
      isLiquid && "liquid-bg"
    )}>
      {/* Uma só fonte de realces no Liquid: `.liquid-bg` (index.css) já traz os
          três radiais. As três camadas fixas que aqui existiam duplicavam
          exatamente o mesmo gradiente — duas passadas do mesmo fundo por frame,
          e o desfoque das superficies amostrava camadas em vez de um fundo
          coerente. Saíram. */}
      {isCore && (
        <>
          <div className="fixed top-0 right-[12%] w-[500px] h-[400px] rounded-full blur-[120px] pointer-events-none z-0 opacity-40" style={{ background: "radial-gradient(ellipse, rgba(0,185,215,0.25), transparent 70%)" }} />
          <div className="fixed bottom-[10%] left-[10%] w-[450px] h-[350px] rounded-full blur-[100px] pointer-events-none z-0 opacity-30" style={{ background: "radial-gradient(ellipse, rgba(45,82,187,0.22), transparent 70%)" }} />
        </>
      )}

      {/* Hexágonos: camada própria, não-interativa e a meio da opacidade do
          padrão (que já é 3% de alpha). Antes ficava colada ao contentor com o
          conteúdo por cima, a competir com os cartões. */}
      {!isLiquid && !isCore && (
        <div aria-hidden className="hex-pattern pointer-events-none fixed inset-0 z-0 opacity-50" />
      )}

      <div className={cn(
        "flex w-full h-full relative z-10",
        !isLiquid && !isCore && "scanlines"
      )}>
        <Sidebar
          activePage={page}
          onNavigate={setPage}
          user={user}
          onLogout={logout}
          level={protectionLevel}
        />

        <main ref={mainScrollRef} className={cn("flex-1 overflow-y-auto relative", !isLiquid && "cyber-grid")}>
          {bootPhase === "limited" && (
            <div className="m-4 p-3 bg-secondary/40 border border-border text-muted-foreground text-xs font-mono rounded flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              <div className="flex-1 min-w-0">
                <p className="font-bold">{BOOT_COPY.limitedBannerTitle}</p>
                <p className="mt-0.5 opacity-90 leading-snug">{BOOT_COPY.limitedBannerDetail}</p>
              </div>
            </div>
          )}

          {(loadingState.state === "UNAVAILABLE" || loadingState.state === "ERROR") && (
            <div className="m-4 p-3 bg-destructive/10 border border-destructive/50 text-destructive text-xs font-mono rounded flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-bold">{loadingState.text}</p>
                <p className="mt-0.5 opacity-90 leading-snug">{loadingState.detail}</p>
              </div>
              {loadingState.canRetry && (
                <button
                  type="button"
                  onClick={() => { void fetchSnapshot(); }}
                  className="shrink-0 px-2.5 py-1 rounded border border-destructive/50 hover:bg-destructive/10 transition-colors"
                >
                  Tentar novamente
                </button>
              )}
            </div>
          )}

          {/* REFUSED é o serviço a responder por política, não uma avaria: tom
              neutro, sem spinner, sem vermelho e sem botão «tentar novamente»
              que prometeria o que a sessão não pode dar. */}
          {loadingState.state === "REFUSED" && (
            <div className="m-4 p-3 bg-secondary/40 border border-border text-muted-foreground text-xs font-mono rounded flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-bold">{loadingState.text}</p>
                <p className="mt-0.5 opacity-90 leading-snug">{loadingState.detail}</p>
              </div>
            </div>
          )}

          <AnimatePresence mode="wait">
            <motion.div
              key={page}
              ref={anchorNewPageAtTop}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
              className="min-h-full"
            >
              {renderPage()}
            </motion.div>
          </AnimatePresence>
        </main>

        <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-3 w-80">
          <AnimatePresence>
            {toasts.map(({ id, event }) => (
              <motion.div
                key={id}
                initial={{ opacity: 0, y: 20, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 100 }}
                className="p-4 rounded-xl cyber-border bg-card/90 backdrop-blur-md shadow-2xl flex gap-4 items-start group"
              >
                <div className="w-10 h-10 rounded-lg bg-cyber-red/10 border border-cyber-red/30 flex items-center justify-center shrink-0">
                  <AlertCircle className="w-6 h-6 text-cyber-red animate-pulse" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-start">
                    <span className="text-[10px] font-mono text-cyber-red uppercase tracking-widest font-bold">{toastTypeLabel(event.type)}</span>
                    <button
                      onClick={() => setToasts((prev) => prev.filter((toast) => toast.id !== id))}
                      className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      x
                    </button>
                  </div>
                  <p className="text-xs font-bold text-foreground mt-1 truncate">{event.summary}</p>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{new Date(event.timestamp).toLocaleString("pt-PT")}</p>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
      <AIAssistant currentPage={page} context={matrixContext} processDiagnostic={processDiagnostic} processContext={processContext} explainRequest={processExplanation} explainIdentity={explicacaoIdentidade} />

      {/* Aqui `bootPhase` já não é "booting" (o arranque devolveu acima): o
          onboarding aparece tanto na moldura normal como na de modo limitado. */}
      {showOnboarding && (
        <OnboardingOverlay onDone={() => setShowOnboarding(false)} onSkip={() => setShowOnboarding(false)} />
      )}
    </div>
  );
}

function AuthLoadingScreen() {
  // Mesma moldura do BootScreen (auth-page, logo, título, subtítulo): a
  // verificação de sessão e o arranque lêem-se como um único ecrã, não como
  // dois painéis diferentes em sequência.
  return (
    <div className="auth-page relative overflow-hidden">
      <div className="auth-bg-gradient" />
      <div className="absolute inset-0 cyber-grid opacity-20 pointer-events-none" />
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-primary/8 rounded-full blur-[150px] pointer-events-none" />

      <div className="flex flex-col items-center gap-5 w-full max-w-sm relative z-10">
        <div className="auth-logo-icon animate-pulse">
          <BrandLogo size="md" variant="auto" label="" />
        </div>
        <div className="text-center">
          <h1 className="text-2xl font-bold font-mono tracking-tight text-foreground">CyberSafe</h1>
          <p className="text-[11px] text-muted-foreground font-mono mt-1 tracking-wide">Centro Inteligente de Segurança e Saúde do PC</p>
        </div>
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 text-primary animate-spin" />
          <p className="text-xs text-muted-foreground font-mono">A verificar a sua sessão...</p>
        </div>
      </div>
    </div>
  );
}

function AppContent() {
  const { isAuthenticated, isLoading } = useAuth();
  const [authPage, setAuthPage] = useState<AuthPage>("login");

  if (isLoading) return <AuthLoadingScreen />;
  if (!isAuthenticated) {
    return authPage === "login"
      ? <LoginPage onSwitchToRegister={() => setAuthPage("register")} />
      : <RegisterPage onSwitchToLogin={() => setAuthPage("login")} />;
  }

  return <AuthenticatedApp />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppearanceProvider>
        <AuthProvider>
          {/* Barra de janela única para TODOS os ecrãs (boot, sessão, login):
              dentro dos providers porque lê o tema e a identidade ativos.
              O título da página é derivado dentro de AuthenticatedApp; neste ponto
              ainda não existe `currentPageTitle` no escopo de App. */}
          <AppTitleBar />
          <AppContent />
          {/* Confirmação de saída da tray — funciona em qualquer ecrã (login/boot). */}
          <ExitConfirmHost />
        </AuthProvider>
      </AppearanceProvider>
    </ErrorBoundary>
  );
}
