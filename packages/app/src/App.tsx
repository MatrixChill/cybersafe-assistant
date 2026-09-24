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
import { canAccess, FEATURES } from "./lib/featureControl";
import Sidebar, { type Page } from "./components/Sidebar";
import DashboardPage from "./pages/DashboardPage";
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
import { hasSeenOnboarding } from "./lib/onboarding";
import { AlertCircle, Loader2, Shield, CheckCircle2, Lock } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { addTelemetrySample } from "@/components/TelemetrySparkline";
import {
  ipcUnlessShuttingDown,
  isAppShuttingDown,
  onAppShutdown,
} from "@/lib/shutdownState";

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
  riskScore: 100,
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
    riskScore: Math.max(0, 100 - protection.stats.riskScore),
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

function BootScreen({ steps }: { steps: { label: string; status: "done" | "active" | "pending" }[] }) {
  return (
    <div className="auth-page relative overflow-hidden">
      <div className="auth-bg-gradient" />
      <div className="absolute inset-0 cyber-grid opacity-20 pointer-events-none" />
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-primary/8 rounded-full blur-[150px] pointer-events-none" />

      <div className="flex flex-col items-center gap-5 w-full max-w-sm relative z-10">
        <div className="relative">
          <div className="auth-logo-icon animate-pulse">
            <Shield className="w-10 h-10 text-primary" />
          </div>
          <div className="absolute -inset-4 rounded-full border border-primary/20 animate-ping opacity-30" />
        </div>

        <div className="text-center">
          <h1 className="text-2xl font-bold font-mono tracking-tight text-foreground">CyberSafe</h1>
          <p className="text-[11px] text-muted-foreground font-mono mt-1 tracking-wide">Centro Inteligente de Segurança e Saúde do PC</p>
        </div>

        <p className="text-xs text-muted-foreground font-mono">A preparar o seu centro de segurança...</p>

        <div className="w-full space-y-3 mt-1">
          {steps.map((step, i) => (
            <div key={i} className="flex items-center gap-3">
              {step.status === "done" ? (
                <CheckCircle2 className="w-4 h-4 text-cyber-green shrink-0" />
              ) : step.status === "active" ? (
                <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
              ) : (
                <div className="w-4 h-4 rounded-full border border-muted-foreground/30 shrink-0" />
              )}
              <span className={`text-xs font-mono transition-colors duration-300 ${
                step.status === "done" ? "text-cyber-green" :
                step.status === "active" ? "text-foreground" :
                "text-muted-foreground/40"
              }`}>
                {step.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AuthenticatedApp() {
  const { user, logout } = useAuth();
  const { theme, setTheme, accent, setAccent, identity } = useAppearance();
  const [page, setPage] = useState<Page>("dashboard");
  const [protection, setProtection] = useState<ProtectionState | null>(null);
  const [threats, setThreats] = useState<ThreatEvent[]>([]);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [processes, setProcesses] = useState<ProcessSnapshot[]>([]);
  const [connections, setConnections] = useState<ConnectionSnapshot[]>([]);
  const [quarantine, setQuarantine] = useState<QuarantineEntry[]>([]);
  const [hardware, setHardware] = useState<HardwareSnapshot | null>(null);
  const [pcState, setPcState] = useState<PcState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [isClearing, setIsClearing] = useState(false);
  const [toasts, setToasts] = useState<{ id: string; event: SecurityEvent }[]>([]);
  /** Scan session that FileScannerPage should auto-start. */
  const [pendingScan, setPendingScan] = useState<{ type: string; targetPath?: string } | null>(null);

  const [bootPhase, setBootPhase] = useState<"booting" | "ready">("booting");
  const [bootSteps, setBootSteps] = useState<{ label: string; status: "done" | "active" | "pending" }[]>([
    { label: "A iniciar proteção", status: "active" },
    { label: "A ligar ao serviço", status: "pending" },
    { label: "A verificar estado do computador", status: "pending" },
    { label: "A carregar sensores", status: "pending" },
  ]);
  const [bootReady, setBootReady] = useState({ protection: false, pcState: false, hardware: false });
  /** Onboarding de boas-vindas: aparece apenas na primeira utilização. */
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => !hasSeenOnboarding());
  /** Evita rajadas do mesmo ficheiro/alerta na UI (notificações nativas já têm debounce no Electron). */
  const toastDebounceRef = useRef<Map<string, number>>(new Map());
  const toastDismissTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const TOAST_DEBOUNCE_MS = 12_000;
  const TOAST_AUTO_DISMISS_MS = 10_000;

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
    if (isAppShuttingDown()) return;

    try {
      const snapshot = await ipcUnlessShuttingDown(() =>
        Promise.all([
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
      if (!snapshot) return;

      const [nextProtection, nextEvents, nextThreats, nextProcesses, nextConnections, nextQuarantine, nextPCState] = snapshot;

      setProtection(nextProtection);
      setEvents(nextEvents);
      setThreats(nextThreats);
      setProcesses(nextProcesses);
      setConnections(nextConnections);
      setQuarantine(nextQuarantine);
      setPcState(nextPCState);
      setError("");
    } catch (err) {
      console.error(err);
      setError("Falha ao sincronizar com o serviço.");
    } finally {
      if (!isAppShuttingDown()) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (protection && !bootReady.protection) {
      setBootReady(prev => ({ ...prev, protection: true }));
      setBootSteps(prev => prev.map((s, i) => i === 0 ? { ...s, status: "done" } : i === 1 ? { ...s, status: "active" } : s));
    }
  }, [protection, bootReady.protection]);

  useEffect(() => {
    if (pcState && !bootReady.pcState) {
      setBootReady(prev => ({ ...prev, pcState: true }));
      setBootSteps(prev => prev.map((s, i) => i === 1 ? { ...s, status: "done" } : i === 2 ? { ...s, status: "active" } : s));
    }
  }, [pcState, bootReady.pcState]);

  useEffect(() => {
    if (hardware && !bootReady.hardware) {
      setBootReady(prev => ({ ...prev, hardware: true }));
      setBootSteps(prev => prev.map((s, i) => i === 2 ? { ...s, status: "done" } : i === 3 ? { ...s, status: "active" } : s));
    }
  }, [hardware, bootReady.hardware]);

  useEffect(() => {
    if (bootReady.protection && bootReady.pcState && bootReady.hardware) {
      setBootSteps(prev => prev.map(s => ({ ...s, status: "done" })));
      setTimeout(() => setBootPhase("ready"), 400);
    }
  }, [bootReady]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (bootPhase === "booting") {
        setBootPhase("ready");
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, [bootPhase]);

  // Reabre o onboarding a partir das Configurações.
  useEffect(() => {
    const open = () => setShowOnboarding(true);
    window.addEventListener("cybersafe:open-onboarding", open);
    return () => window.removeEventListener("cybersafe:open-onboarding", open);
  }, []);

  useEffect(() => {
    void fetchSnapshot();
    if (!window.electronAPI) return;

    const unsubscribe = window.electronAPI.onSecurityEvent((event) => {
      // Shutdown: nada de refresh (e nenhum dos 7 pedidos) a caminho da saída.
      if (isAppShuttingDown()) return;
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
      // scan.progress é um evento de UI de alta frequência (heartbeat do motor):
      // não força um refresh completo do snapshot a cada atualização do scanner.
      if (event.type !== "scan.progress") void fetchSnapshot();
    });

    // No shutdown cancelamos já a subscrição de eventos e os toasts pendentes.
    const stopOnShutdown = onAppShutdown(() => {
      unsubscribe?.();
      toastDismissTimers.current.forEach((t) => clearTimeout(t));
      toastDismissTimers.current.clear();
    });

    return () => {
      stopOnShutdown();
      unsubscribe?.();
      toastDismissTimers.current.forEach((t) => clearTimeout(t));
      toastDismissTimers.current.clear();
    };
  }, [fetchSnapshot]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    // Hardware snapshot — CPU/RAM/network every ~2s for real-time feel.
    // Backend already handles different cadences internally (CPU/RAM: 1s, disk/temperatures: 10s).
    // IPC returns latest cached snapshot, so this is cheap.
    const interval = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      if (isAppShuttingDown()) return;
      try {
        const snap = await api.getHardwareSnapshot();
        // Snapshot que chega depois do shutdown começar é descartado.
        if (isAppShuttingDown()) return;
        setHardware(snap);
        addTelemetrySample("cpu", snap.cpu.usage);
        addTelemetrySample("ram", snap.ram.usagePercent);
        if (snap.cpu.temperature != null) addTelemetrySample("cpu-temp", snap.cpu.temperature);
        if (snap.gpu?.temperature != null) addTelemetrySample("gpu-temp", snap.gpu.temperature);
        if (snap.gpu?.usagePercent != null) addTelemetrySample("gpu", snap.gpu.usagePercent);
        if (snap.network) addTelemetrySample("net-rx", snap.network.rxSec);
        if (snap.network) addTelemetrySample("net-tx", snap.network.txSec);
      } catch (e) { /* silent */ }
    }, 2_000);

    // Initial fetch
    if (document.visibilityState === 'visible') {
      api.getHardwareSnapshot()
        .then((snap) => { if (!isAppShuttingDown()) setHardware(snap); })
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

  const protectionLevel = protection
    ? deriveProtectionLevel(protection.status, protection.engine)
    : "degraded";

  // Contexto sanitizado da Matrix: apenas métricas agregadas, sem caminhos,
  // emails ou conteúdo de ficheiros (privacidade em primeiro lugar).
  const matrixContext = useMemo(() => {
    const parts: string[] = [];
    if (protection) {
      parts.push(`Protection score: ${Math.max(0, 100 - protection.stats.riskScore)}`);
      parts.push(`Protection status: ${protection.status}`);
      parts.push(`Service running: ${protection.engine.serviceRunning}`);
      parts.push(`Security events (total): ${protection.stats.totalEvents}`);
      parts.push(`Quarantined items: ${protection.stats.quarantinedCount}`);
    }
    if (hardware) {
      parts.push(`CPU usage: ${hardware.cpu.usage}%`);
      parts.push(`RAM usage: ${hardware.ram.usagePercent}%`);
      parts.push(`Disk usage: ${hardware.disk.usagePercent}%`);
    }
    if (pcState) {
      parts.push(`PC overall: ${pcState.overall}`);
      parts.push(`Security: ${pcState.security} | Performance: ${pcState.performance} | System: ${pcState.system}`);
      for (const f of pcState.findings.slice(0, 5)) {
        const ev = f.evidence?.evidenceLines?.join("; ");
        parts.push(`- [${f.severity}] ${f.title}${ev ? ` (${ev})` : ""}`);
      }
    }
    parts.push(`Active threats: ${threats.length}`);
    return parts.join("\n");
  }, [protection, hardware, pcState, threats]);

  function handleScan(type: string, targetPath?: string) {
    setPendingScan({ type, targetPath });
    setPage("scanner");
  }

  function renderPage() {
    const accountType = user?.type || "personal";
    const plan = user?.plan || "free";

    switch (page) {
      case "dashboard":
        return <DashboardPage dashboard={dashboard} isLoading={isLoading} hardware={hardware} pcState={pcState} onScan={handleScan} />;
      case "pccenter":
        return <PCCenterPage hardware={hardware} pcState={pcState} />;
      case "threats":
        return <ThreatsPage events={threats} onClear={handleClear} isClearing={isClearing} />;
      case "scanner":
        return <FileScannerPage pendingScan={pendingScan} onScanConsumed={() => setPendingScan(null)} />;
      case "taskmanager":
        return <TaskManagerPage processes={processes} onRefreshProcesses={fetchSnapshot} />;
      case "monitor":
        return <MonitorPage events={events} processes={processes} connections={connections} protection={protection} quarantine={quarantine} />;
      case "simulator":
        return <SimulatorPage />;
      case "otimizar":
        return <OtimizarPage hardware={hardware} />;
      case "settings":
        return <SettingsPage />;
      case "reports":
        if (!canAccess(FEATURES.REPORTS, accountType, plan)) {
          return <DashboardPage dashboard={dashboard} isLoading={isLoading} hardware={hardware} pcState={pcState} />;
        }
        return <ReportsPage events={events} threats={threats} quarantine={quarantine} protection={protection} pcState={pcState} />;
      case "business":
        if (!canAccess(FEATURES.BUSINESS_SECURITY_CENTER, accountType, plan)) {
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
    return <BootScreen steps={bootSteps} />;
  }

  const isLiquid = identity === "cybersafe-liquid";
  const isCore = identity === "cybersafe-core";

  return (
    <div className={cn(
      "flex h-screen bg-background text-foreground overflow-hidden font-sans selection:bg-primary/30 relative",
      isLiquid && "liquid-bg"
    )}>
      {isLiquid && (
        <>
          <div className="fixed top-[10%] left-[15%] w-[400px] h-[400px] rounded-full blur-[180px] pointer-events-none z-0" style={{ background: "color-mix(in oklch, var(--primary) 12%, transparent)" }} />
          <div className="fixed bottom-[15%] right-[10%] w-[350px] h-[350px] rounded-full blur-[160px] pointer-events-none z-0" style={{ background: "color-mix(in oklch, var(--cyber-cyan) 8%, transparent)" }} />
          <div className="fixed top-[60%] left-[55%] w-[300px] h-[300px] rounded-full blur-[150px] pointer-events-none z-0" style={{ background: "color-mix(in oklch, var(--cyber-purple) 6%, transparent)" }} />
        </>
      )}
      {isCore && (
        <>
          <div className="fixed top-0 right-[12%] w-[500px] h-[400px] rounded-full blur-[120px] pointer-events-none z-0 opacity-40" style={{ background: "radial-gradient(ellipse, rgba(0,185,215,0.25), transparent 70%)" }} />
          <div className="fixed bottom-[10%] left-[10%] w-[450px] h-[350px] rounded-full blur-[100px] pointer-events-none z-0 opacity-30" style={{ background: "radial-gradient(ellipse, rgba(45,82,187,0.22), transparent 70%)" }} />
        </>
      )}

      <div className={cn(
        "flex w-full h-full relative z-10",
        !isLiquid && !isCore && "scanlines",
        !isLiquid && !isCore && "hex-pattern"
      )}>
        <Sidebar
          activePage={page}
          onNavigate={setPage}
          theme={theme}
          accent={accent}
          onThemeChange={setTheme}
          onAccentChange={setAccent}
          user={user}
          onLogout={logout}
          level={protectionLevel}
        />

        <main className={cn("flex-1 overflow-y-auto relative", !isLiquid && "cyber-grid")}>
          {error && (
            <div className="m-4 p-3 bg-destructive/10 border border-destructive/50 text-destructive text-xs font-mono rounded flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}

          <AnimatePresence mode="wait">
            <motion.div
              key={page}
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
                    <span className="text-[10px] font-mono text-cyber-red uppercase tracking-widest font-bold">{event.type}</span>
                    <button
                      onClick={() => setToasts((prev) => prev.filter((toast) => toast.id !== id))}
                      className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      x
                    </button>
                  </div>
                  <p className="text-xs font-bold text-foreground mt-1 truncate">{event.summary}</p>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{new Date(event.timestamp).toLocaleString()}</p>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
      <AIAssistant currentPage={page} context={matrixContext} />

      {bootPhase === "ready" && showOnboarding && (
        <OnboardingOverlay onDone={() => setShowOnboarding(false)} onSkip={() => setShowOnboarding(false)} />
      )}
    </div>
  );
}

function AuthLoadingScreen() {
  return (
    <div className="auth-page">
      <div className="auth-bg-gradient" />
      <div className="flex flex-col items-center gap-4">
        <div className="auth-logo-icon">
          <Shield className="w-8 h-8 text-primary animate-pulse" />
        </div>
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
        <span className="text-sm text-muted-foreground font-mono">Carregando...</span>
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
          <AppContent />
          {/* Confirmação de saída da tray — funciona em qualquer ecrã (login/boot). */}
          <ExitConfirmHost />
        </AuthProvider>
      </AppearanceProvider>
    </ErrorBoundary>
  );
}
