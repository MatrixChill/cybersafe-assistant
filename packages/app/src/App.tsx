import { SecurityEventMessage } from "./components/SecurityEventMessage";
import { observeRead, singleFlight, exigirLista, exigirPresenca } from "./lib/progressiveRead";
import { useEffect, useState, useCallback, useRef, useMemo, Component, type ReactNode } from "react";
import type {
  ConnectionSnapshot,
  DashboardSummary,
  PcState,
  ProcessEnumerationTruth,
  ProcessListResult,
  ProcessSnapshot,
  ProtectionState,
  QuarantineEntry,
  SecurityEvent,
  ThreatEvent,
  HardwareSnapshot,
} from "@cybersafe/shared-types";
import { normalizeProcessListResult } from "@cybersafe/shared-types";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { AppearanceProvider, useAppearance } from "./contexts/AppearanceContext";
import { deriveProtectionLevel } from "./lib/protectionHealth";
import { deriveLoadingState, DEFAULT_STARTUP_TIMEOUT_MS } from "./lib/loadingStates";
import { deriveBootReadiness, limitedSessionNowReady, BOOT_COPY, mostraAvisoDeModoLimitado, pendingReadings, type BootPhase } from "./lib/bootReadiness";
import { classificarLeitura, resumoSync } from "./lib/serviceSyncStatus";
import { instanteDeLeituraValida } from "./lib/processListState";
import { buildMatrixContext } from "./lib/matrixContext";
import { criarHistoricoProcessos, estadoDeIdentidade } from "./lib/processIntelligence";
import { buildProcessMatrixContext } from "./lib/processMatrix";
import { canUserAccess, FEATURES } from "./lib/featureControl";
import Sidebar from "./v2/LabSidebar";
import type {Page} from "./v2/navigation";
import { setTitlebarPageLabel, type TitlebarPageLabel } from "./components/AppTitleBar";

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
import { AlertCircle, Bell, ChevronRight, Loader2, Lock, ShieldCheck } from "lucide-react";
import { ThemeMenu } from "./v2/theme-menu";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { addTelemetrySample } from "@/components/TelemetrySparkline";
import {
  ipcUnlessShuttingDown,
  isAppShuttingDown,
  onAppShutdown,
} from "@/lib/shutdownState";
import {
  PROCESSES_REFRESH_COALESCE_MS,
  processosPollMs,
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
  const snapshotFlightRef = useRef<{generation:number; promise:Promise<void>; invalidated:boolean} | null>(null);
  /**
   * Instante de montagem, para o contrato de carregamento medir a demora do
   * arranque e conseguir apresentar um motivo (`timeout`) em vez de um
   * «A carregar» sem fim. Só conta a partir do momento em que a app autenticada
   * existe; não é telemetria nem vai a lado nenhum.
   */
  const startedAtRef = useRef<number>(Date.now());
  const [threats, setThreats] = useState<ThreatEvent[]>([]);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [eventsObservation,setEventsObservation] = useState<{phase:"a_consultar"|"pronto"|"erro";generation:number}>({phase:"a_consultar",generation:-1});
  const [processes, setProcesses] = useState<ProcessSnapshot[]>([]);
  const processHistoryRef = useRef<ReturnType<typeof criarHistoricoProcessos> | null>(null);
  if (!processHistoryRef.current) processHistoryRef.current = criarHistoricoProcessos();
  const [processesObservedAt, setProcessesObservedAt] = useState<number | null>(null);
  /**
   * O que o serviço afirma sobre a enumeração (P1-PROCESS-TRUTH). A idade vem
   * daqui, nunca do relógio do cliente: uma falha com `[]` não pode chegar e
   * carimbar-se como «lido agora».
   */
  const [processesTruth, setProcessesTruth] = useState<ProcessEnumerationTruth | null>(null);
  /** Um pedido da lista está em voo — o único observador real de «a enumerar». */
  const [processesInFlight, setProcessesInFlight] = useState(false);
  const [processExplanation, setProcessExplanation] = useState<{id: number; pid?: number; startedAt?: string | null} | null>(null);
  const [connections, setConnections] = useState<ConnectionSnapshot[]>([]);
  const [quarantine, setQuarantine] = useState<QuarantineEntry[]>([]);
  const [quarantineReadState, setQuarantineReadState] = useState<"confirmado" | "a_ler" | "falhou">("a_ler");
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
  const [bootPhase, setBootPhase] = useState<BootPhase>("booting");
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

  const acceptProcesses = useCallback((next: ProcessListResult) => {
    // Normalizar aqui, e não no bridge: um serviço de um boot anterior responde
    // com o array nu, e isso tem de chegar como «linhas sem frescura afirmada»
    // (`unreported`) em vez de a renderer adivinhar pela contagem.
    const { processes: linhas, truth } = normalizeProcessListResult(next);
    const observedAt = instanteDeLeituraValida(truth);
    setProcessesTruth(truth);
    // O histórico regista leituras, não repostas: sem instante de foto não há
    // observação nova a acrescentar (seria o relógio do cliente de novo).
    if (observedAt !== null && linhas.length > 0) processHistoryRef.current?.registar(linhas, observedAt);
    // INCONDICIONAL: uma resposta sem instante válido limpa o anterior. Guardar o
    // `observedAt` de uma sessão passada faria `listaDesactualizada` dizer «nada
    // antigo» sobre linhas cuja idade já ninguém afirma (serviço reiniciado, ou
    // boot anterior sem contrato) — exatamente a mentira que este contrato fecha.
    setProcessesObservedAt(observedAt);
    if (truth.state === "ok" || truth.state === "failed" || truth.state === "unreported") {
      setProcesses(linhas);
    }
  }, []);

  const refreshProcesses = useCallback(async (): Promise<void> => {
    const api = window.electronAPI;
    if (!api || isAppShuttingDown() || serviceConnectionRef.current === false) return;
    const generation = connectionGeneration.current;
    const state = processesRefreshRef.current;
    if (state.inFlight) return; // um pedido em voo: não se deita trabalho fora
    state.inFlight = true;
    setProcessesInFlight(true);
    try {
      const next = await ipcUnlessShuttingDown(() => api.getProcesses());
      if (next && generation === connectionGeneration.current) acceptProcesses(next);
    } catch {
      // Falha isolada: o próximo refresh (evento ou poll) corrige. A lista
      // anterior fica no ecrã — nunca uma lista vazia por causa de um erro.
    } finally {
      state.inFlight = false;
      setProcessesInFlight(false);
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
    // Uma só pergunta por página: `processosPollMs` é o único sítio que sabe que
    // a lista é produto no Gestor de Tarefas/Monitor e só tradução de PID na
    // Segurança Empresarial. O App não escolhe números.
    const cadencia = processosPollMs(page);
    if (cadencia === null || !window.electronAPI) return;
    const interval = setInterval(() => {
      if (serviceConnectionRef.current === false) return;
      if (document.visibilityState !== "visible") return;
      scheduleProcessesRefresh();
    }, cadencia);
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


  const fetchSnapshot = useCallback(async (invalidate = false): Promise<void> => {
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
    if (snapshotFlightRef.current?.generation === generation) {
      if (invalidate) snapshotFlightRef.current.invalidated = true;
      return snapshotFlightRef.current.promise;
    }
    const snapshotId = ++snapshotGeneration.current;
    const isCurrent = () => !isAppShuttingDown() && generation === connectionGeneration.current && snapshotId === snapshotGeneration.current;
    const publish = <T,>(apply:(value:T)=>void) => (value:T) => { if (isCurrent()) apply(value); };
    const flight = (async () => {
    try {
      // Cada leitura publica o seu facto logo que chega. observeRead conserva
      // as rejeições para a classificação final; nenhuma falha inventa dados.
      const snapshot = await ipcUnlessShuttingDown(() =>
        Promise.all([
          observeRead(() => api.getProtectionState(), publish(setProtection)),
          observeRead(async () => {
            try { return exigirLista<SecurityEvent>("security.events", await api.getSecurityEvents({ limit: 100 })); }
            catch(error){ if(isCurrent())setEventsObservation({phase:"erro",generation});throw error; }
          }, publish((entries)=>{setEvents(entries);setEventsObservation({phase:"pronto",generation});})),
          observeRead(async () => exigirLista<ThreatEvent>("threat.events", await api.getThreatEvents()), publish(setThreats)),
          observeRead(async () => exigirPresenca("processes.list", await api.getProcesses()), publish(acceptProcesses)),
          observeRead(async () => exigirLista<ConnectionSnapshot>("connections", await api.getConnections()), publish(setConnections)),
          observeRead(async () => {
            try {
              const entries = await api.getQuarantineFiles();
              if (!Array.isArray(entries)) throw new Error("Leitura da quarentena não confirmada.");
              return entries;
            } catch (err) {
              if (isCurrent()) setQuarantineReadState("falhou");
              throw err;
            }
          }, publish((entries) => {
            setQuarantine(entries);
            setQuarantineReadState("confirmado");
          })),
          observeRead(async () => exigirPresenca("pc.state", await api.getPCState()), publish(setPcState)),
        ]),
      );

      // null = cancelado pelo shutdown (esperado, sem ruído): a UI não é mexida.
      if (!snapshot || generation !== connectionGeneration.current || snapshotId !== snapshotGeneration.current) return;

      const [rProtection] = snapshot;
      const resumo = resumoSync(snapshot.map(classificarLeitura));
      // O estado REFUSED é uma contagem medida deste ciclo, não uma suposição.
      setSyncRecusas(resumo.recusas);

      if (resumo.deveMarcarFalhaSync) {
        // Falha real mantém o aviso global; só uma falha da própria leitura
        // invalida proteção já confirmada. Recusas de política continuam neutras.
        console.error(snapshot.find((r) => r.status === "rejected")?.reason);
        if (rProtection.status === "rejected" && classificarLeitura(rProtection) === "falha") setProtection(null);
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
      if (isCurrent()) setIsLoading(false);
    }
    })();
    snapshotFlightRef.current = {generation, promise:flight, invalidated:false};
    try { await flight; } finally {
      const active = snapshotFlightRef.current;
      if (active?.promise === flight) {
        snapshotFlightRef.current = null;
        // Uma mutação/evento após uma leitura parcial exige UMA leitura posterior.
        if (active.invalidated && isCurrent()) void fetchSnapshot();
      }
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
        setQuarantineReadState("falhou");
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
    void fetchSnapshot(true);
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
          void fetchSnapshot(true);
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
      void fetchSnapshot(true);
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
    const hardwarePoll = { run: singleFlight(async () => {
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
    }) };
    const interval = setInterval(() => { void hardwarePoll.run(); }, 2_000);

    // Initial fetch
    void hardwarePoll.run();

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
      await fetchSnapshot(true);
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
   * Uma avaria REAL de qualquer uma das sete leituras tem de ser visível mesmo
   * quando a proteção respondeu. `deriveLoadingState` decide a partir da leitura
   * confirmada (ramo 2) e só vê `syncError` quando não há leitura nenhuma (ramo
   * 3): sem isto, uma falha em processes/connections/quarantine/pcstate deixava
   * o erro na consola e a UI em READY. A faixa mostra a frase que o próprio
   * ciclo de sync já calculou em `error` — nenhuma cópia nova é inventada aqui.
   */
  const falhaSyncVisivel =
    error.trim() !== "" && loadingState.state !== "ERROR" && loadingState.state !== "UNAVAILABLE";

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
    if (bootPhase === "booting") {
      if (bootReadiness.opensShell) setBootPhase("ready");
      return;
    }
    if (limitedSessionNowReady(bootPhase, bootReadiness)) {
      setBootPhase("ready");
    }
  }, [bootPhase, bootReadiness.opensShell, bootReadiness.claimsReady]);
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
  /**
   * Identificador do pedido de explicação. Um contador, não `Date.now()`: dois
   * cliques no mesmo milissegundo dariam o MESMO id, e o guarda de auto-envio da
   * Matrix (que evita reenviar em cada re-render) comeria o segundo clique — o
   * botão outra vez «não faz nada», que é o defeito que este lote vem fechar.
   */
  const explicacaoSeqRef = useRef(0);
  const explainProcess = (pid?: number, startedAt?: string | null) => {
    const id = ++explicacaoSeqRef.current;
    if (pid === undefined) {
      setProcessExplanation({ id });
      return;
    }
    setProcessExplanation({ id, pid, startedAt: startedAt ?? null });
  };

  function handleScan(type: string, targetPath?: string) {
    setPendingScan({ type, targetPath });
    setPage("scanner");
  }
  function openScanner(){setPendingScan(null);setPage("scanner");}

  // PC Center: com a ligação caída mostra a última leitura real (CACHED), sem fixtures.
  const pcCenterHardware = hardware ?? (serviceConnected === false ? lastRealHardwareRef.current : null);
  const pcCenterOrigin = pcCenterDataOrigin({ hasSnapshot: pcCenterHardware !== null, serviceConnected });

  function renderPage() {
    switch (page) {
      case "dashboard":
        return <DashboardPage dashboard={dashboard} isLoading={isLoading} hardware={hardware} pcState={pcState} onScan={handleScan} onOpenScanner={openScanner} onOpenPC={()=>setPage("pccenter")} events={events} eventsReadPhase={eventsObservation.generation===connectionGeneration.current?eventsObservation.phase:"a_consultar"} realtime={realtimeInfo} onSetProtection={handleSetProtection} onPauseProtection={handlePauseProtection} protectionPending={protectionPending} protectionError={protectionActionError} onDismissProtectionError={() => setProtectionActionError(null)} serviceConnected={serviceConnected} serviceGeneration={connectionGeneration.current} />;
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
            quarantineReadState={quarantineReadState}
            onQuarantineChanged={() => fetchSnapshot(true)}
            quarantinePolicy={protection?.stats?.quarantinePolicy}
          />
        );
      case "scanner":
        return <FileScannerPage pendingScan={pendingScan} onScanConsumed={() => setPendingScan(null)} onOpenThreats={() => setPage("threats")} engineHealth={serviceConnected === true ? protection?.engine : undefined} serviceConnected={serviceConnected} />;

      case "taskmanager":
        return <TaskManagerPage processes={processes} serviceConnected={serviceConnected} processesObservedAt={processesObservedAt} processTruth={processesTruth} aEnumerar={processesInFlight} onRefreshProcesses={refreshProcesses} diagnostic={processDiagnostic ?? undefined} onExplainProcess={explainProcess} />;
      case "monitor":
        return <MonitorPage events={events} processes={processes} processesObservedAt={processesObservedAt} processTruth={processesTruth} serviceConnected={serviceConnected} connections={connections} protection={protection} quarantine={quarantine} />;
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
            quarantineReadState={quarantineReadState}
            onQuarantineChanged={() => fetchSnapshot(true)}
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
          return <DashboardPage dashboard={dashboard} isLoading={isLoading} hardware={hardware} pcState={pcState} realtime={realtimeInfo} serviceConnected={serviceConnected} serviceGeneration={connectionGeneration.current} events={events} eventsReadPhase={eventsObservation.generation===connectionGeneration.current?eventsObservation.phase:"a_consultar"} onOpenScanner={openScanner} onOpenPC={()=>setPage("pccenter")} />;
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
        return <BusinessSecurityCenter connections={connections} processes={processes} processesObservedAt={processesObservedAt} />;
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

  // O shell unificado usa a faixa já implementada em AppTitleBar:
  // ela é o único arrasto Win32 + Windows Controls Overlay + marca por
  // largura. O App.tsx só integra conteúdo + sidebar em layout único e
  // nunca duplica a faixa. O contexto da página é comunicado na faixa quando
  // a rota o permite, nunca pela barra de navegação.
  const activePageTitle: TitlebarPageLabel = (
    page === "dashboard"
      ? "Painel"
      : page === "pccenter"
        ? "PC Center"
        : page === "threats" || page === "quarantine"
          ? "Ameaças"
          : page === "scanner"
            ? "Análise de Segurança"
            : page === "monitor"
              ? "Monitor em Tempo Real"
              : page === "taskmanager"
                ? "Gestor de Tarefas"
                : page === "otimizar"
                  ? "Otimizar"
                  : page === "simulator"
                    ? "Simulador"
                    : page === "reports"
                      ? "Relatórios"
                      : page === "settings"
                        ? "Definições"
                        : page === "business"
                          ? "Business Center"
                          : ""
  ) as TitlebarPageLabel;

  // Sincroniza o contexto da página com a faixa: o rótulo derivado da rota chega
  // à barra sem duplicar marca, arrasto ou IPC. Apenas para o estado atual da faixa;
  // a barra não decide nada sobre o contexto da página.
  setTitlebarPageLabel(activePageTitle);

  /**
   * Faixa de estado do shell V2. No laboratório esta linha diz «DESIGN LAB ·
   * todos os dados são de demonstração». Aqui só pode dizer factos lidos deste
   * runtime, e por isso cada segmento vem de uma variável que já existe acima:
   * a ligação ao serviço, o resumo do último ciclo de leitura e as recusas
   * medidas pelo gate. Sem leitura, diz «ainda não lido» — nunca um estado
   * emprestado de outro sítio.
   */
  // Nomeia as leituras em falta: «leituras incompletas» sem dizer QUAIS deixa
  // o utilizador sem saber se falta o serviço, o PC ou os sensores. Quando o
  // DEGRADED vem de um componente limitado (e não de uma leitura em falta),
  // diz-se isso — nunca se inventa uma leitura ausente.
  const leiturasEmFalta = pendingReadings(bootReadiness.confirmed);
  const faixaSessao =
    serviceConnected === null
      ? "Estado do serviço ainda não lido"
      : serviceConnected === false
        ? "Serviço de proteção indisponível"
        : loadingState.state === "READY"
          ? "Serviço ligado — leituras confirmadas"
          : loadingState.state === "DEGRADED"
            ? leiturasEmFalta === "nenhuma leitura em falta"
              ? "Serviço ligado com componentes limitados"
              : `Serviço ligado com leituras incompletas: ${leiturasEmFalta}`
            : loadingState.state === "REFUSED"
              ? `Leituras recusadas pelo gate: ${syncRecusas}`
              : loadingState.text;

  return (
    <div className={cn(
      "cs-v2 cs-v2-shell titlebar-offset bg-background cs-shell text-foreground overflow-hidden font-sans selection:bg-primary/30 relative"
    )}>
      {/* Conteúdo principal: barra única já montada acima + sidebar + página. */}
        <div className="state-ribbon" role="region" aria-label="Estado da sessão">
          <span>
            <ShieldCheck size={12} aria-hidden />
            CYBERSAFE ASSISTANT
          </span>
          <span>
            {faixaSessao}
            {bootPhase === "limited" ? " · sessão em modo limitado" : ""}
          </span>
        </div>

        {/* Filho 1 do grafo: barra lateral do shell V2. */}
          <Sidebar
            activePage={page}
            onNavigate={setPage}
            user={user}
            onLogout={logout}
            level={protectionLevel}
          />


        {/* Filho 2 do grafo: coluna de conteúdo — faixa, página e avisos. */}
        <div className="main-shell flex min-h-0 flex-1 flex-col relative z-10">
        {/* Faixa V2 do conteúdo: breadcrumbs do que a rota diz, seletor do tema
            real, avisos e o perfil autenticado. O sino conta os avisos ACTIVOS
            desta janela (`toasts`), que expiram sozinhos — não é o histórico de
            ameaças, e diz-lo com essa palavra para ninguém ler «zero» como
            «nunca aconteceu nada». O avatar usa o nome da conta. */}
        <div className="topbar">
          <div className="breadcrumbs">
            Workspace
            <ChevronRight size={12} aria-hidden />
            <strong>{activePageTitle}</strong>
          </div>
          <div className="topbar-actions">
            <ThemeMenu />
            <button
              type="button"
              className="icon-button"
              aria-label={
                toasts.length === 0
                  ? "Sem avisos activos nesta janela"
                  : `Ver os ${toasts.length} ${toasts.length === 1 ? "aviso activo" : "avisos activos"} nesta janela`
              }
              onClick={() => setPage("threats")}
            >
              <Bell size={18} aria-hidden />
              {toasts.length > 0 && <i aria-hidden />}
            </button>
            <span className="user-avatar" title={user?.name ?? "Sem sessão"} aria-hidden>
              {(user?.name ?? "?").trim().charAt(0).toUpperCase()}
            </span>
          </div>
        </div>

        {/* Conteúdo principal: sidebar + pagina em layout único. */}

          <main ref={mainScrollRef} data-cs-main="" className={cn("flex-1 overflow-y-auto relative min-w-0",
                page!=="dashboard" && !isLiquid && !isCore && "cyber-grid"
              )} data-presentation={page==="dashboard"?"lab-v2":"legacy"}
          >
            {mostraAvisoDeModoLimitado(bootPhase, bootReadiness) && (
              <div className="m-4 p-3 bg-secondary/40 border border-border text-muted-foreground text-xs font-mono rounded flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
                <div className="flex-1 min-w-0">
                  <p className="font-bold">{BOOT_COPY.limitedBannerTitle}</p>
                  {/* O texto vem da prontidão: com o serviço ligado mas leituras
                      em falta, dizer «sem confirmação do serviço» seria falso. */}
                  <p className="mt-0.5 opacity-90 leading-snug">
                    {bootReadiness.limitation ?? BOOT_COPY.limitedBannerDetail}
                  </p>
                  <p className="mt-0.5 opacity-80 leading-snug">{bootReadiness.detail}</p>
                </div>
              </div>
            )}

            {(loadingState.state === "UNAVAILABLE" || loadingState.state === "ERROR" || falhaSyncVisivel) && (
              <div role="alert" className="m-4 p-3 bg-destructive/10 border border-destructive/50 text-destructive text-xs font-mono rounded flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="font-bold">{falhaSyncVisivel ? error : loadingState.text}</p>
                  {!falhaSyncVisivel && (
                    <p className="mt-0.5 opacity-90 leading-snug">{loadingState.detail}</p>
                  )}
                </div>
                {(loadingState.canRetry || falhaSyncVisivel) && (
                  <button
                    type="button"
                    onClick={() => { void fetchSnapshot(true); }}
                    className="shrink-0 px-2.5 py-1 rounded border border-destructive/50 hover:bg-destructive/10 transition-colors"
                  >
                    Tentar novamente
                  </button>
                )}
              </div>
            )}

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
                {import.meta.env.DEV&&page!=="dashboard"&&<p className="v2-migration-note" role="note">DEV · Apresentação desta página ainda em migração para o Design Lab V2. Funcionalidades existentes preservadas.</p>}
                {renderPage()}
              </motion.div>
            </AnimatePresence>
          </main>

        {/* Notificações: posicionadas absolutamente em cima do conteúdo, nunca dentro da faixa estrutural. */}
        <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 w-80">
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
                    <span className="text-[10px] font-mono text-cyber-red uppercase tracking-widest font-bold">{event.type === "process.exited" ? "Saída observada" : event.type === "process.killed" ? "Evento de processo" : toastTypeLabel(event.type)}</span>
                    <button
                      onClick={() => setToasts((prev) => prev.filter((toast) => toast.id !== id))}
                      className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      x
                    </button>
                  </div>
                  <SecurityEventMessage event={event} />
                  <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{new Date(event.timestamp).toLocaleString("pt-PT")}</p>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        </div>

      {/* Fundo estrutural do Windows: apartado do frame para cobrir a janela inteira sem entrar na composição do conteúdo. */}
      {page!=="dashboard"&&<div className="cs-shell-backdrop fixed inset-0 z-0 pointer-events-none">
        {isLiquid && <div className="liquid-bg" />}
        {isCore && (
          <>
            <div className="absolute top-0 right-[12%] w-[500px] h-[400px] rounded-full blur-[120px] opacity-40" style={{ background: "radial-gradient(ellipse, rgba(0,185,215,0.25), transparent 70%)" }} />
            <div className="absolute bottom-[10%] left-[10%] w-[450px] h-[350px] rounded-full blur-[100px] opacity-30" style={{ background: "radial-gradient(ellipse, rgba(45,82,187,0.22), transparent 70%)" }} />
          </>
        )}
        {!isLiquid && !isCore && (
          <div aria-hidden className="hex-pattern opacity-50" />
        )}
      </div>}

      <AIAssistant currentPage={page} context={matrixContext} processDiagnostic={processDiagnostic} processContext={processContext} explainRequest={processExplanation} explainIdentity={explicacaoIdentidade} />

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
