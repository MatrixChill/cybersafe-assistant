import { useEffect, useState, useCallback, useRef } from "react";
import type {
  ConnectionSnapshot,
  DashboardSummary,
  ProcessSnapshot,
  ProtectionState,
  QuarantineEntry,
  SecurityEvent,
  ThreatEvent,
  HardwareSnapshot,
} from "@cybersafe/shared-types";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { canAccess, FEATURES } from "./lib/featureControl";
import Sidebar, { type AccentMode, type Page, type ThemeMode } from "./components/Sidebar";
import DashboardPage from "./pages/DashboardPage";
import ThreatsPage from "./pages/ThreatsPage";
import FileScannerPage from "./pages/FileScannerPage";
import MonitorPage from "./pages/MonitorPage";
import SimulatorPage from "./pages/SimulatorPage";
import TaskManagerPage from "./pages/TaskManagerPage";
import PCCenterPage from "./pages/PCCenterPage";
import ReportsPage from "./pages/ReportsPage";
import OtimizarPage from "./pages/OtimizarPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import AIAssistant from "./components/AIAssistant";
import { AlertCircle, Loader2, Shield } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

type AuthPage = "login" | "register";

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

function AuthenticatedApp() {
  const { user, logout } = useAuth();
  const [page, setPage] = useState<Page>("dashboard");
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [accent, setAccent] = useState<AccentMode>("blue");
  const [protection, setProtection] = useState<ProtectionState | null>(null);
  const [threats, setThreats] = useState<ThreatEvent[]>([]);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [processes, setProcesses] = useState<ProcessSnapshot[]>([]);
  const [connections, setConnections] = useState<ConnectionSnapshot[]>([]);
  const [quarantine, setQuarantine] = useState<QuarantineEntry[]>([]);
  const [hardware, setHardware] = useState<HardwareSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [isClearing, setIsClearing] = useState(false);
  const [toasts, setToasts] = useState<{ id: string; event: SecurityEvent }[]>([]);
  /** Evita rajadas do mesmo ficheiro/alerta na UI (notificações nativas já têm debounce no Electron). */
  const toastDebounceRef = useRef<Map<string, number>>(new Map());
  const toastDismissTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const TOAST_DEBOUNCE_MS = 12_000;
  const TOAST_AUTO_DISMISS_MS = 10_000;

  useEffect(() => {
    const savedTheme = (localStorage.getItem("theme") as ThemeMode | null) ?? "dark";
    const savedAccent = (localStorage.getItem("accent") as AccentMode | null) ?? "blue";
    setTheme(savedTheme);
    setAccent(savedAccent);
  }, []);

  useEffect(() => {
    document.documentElement.className = theme;
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-accent", accent);
    localStorage.setItem("accent", accent);
  }, [accent]);

  const fetchSnapshot = useCallback(async () => {
    if (!window.electronAPI) {
      setError("Motor de proteção indisponível.");
      setIsLoading(false);
      return;
    }

    try {
      const [nextProtection, nextEvents, nextThreats, nextProcesses, nextConnections, nextQuarantine] = await Promise.all([
        window.electronAPI.getProtectionState(),
        window.electronAPI.getSecurityEvents({ limit: 100 }),
        window.electronAPI.getThreatEvents(),
        window.electronAPI.getProcesses(),
        window.electronAPI.getConnections(),
        window.electronAPI.getQuarantineFiles(),
      ]);

      setProtection(nextProtection);
      setEvents(nextEvents);
      setThreats(nextThreats);
      setProcesses(nextProcesses);
      setConnections(nextConnections);
      setQuarantine(nextQuarantine);
      setError("");
    } catch (err) {
      console.error(err);
      setError("Falha ao sincronizar com o serviço.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSnapshot();
    if (!window.electronAPI) return;

    const unsubscribe = window.electronAPI.onSecurityEvent((event) => {
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
      void fetchSnapshot();
    });

    return () => {
      unsubscribe?.();
      toastDismissTimers.current.forEach((t) => clearTimeout(t));
      toastDismissTimers.current.clear();
    };
  }, [fetchSnapshot]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    // Poll hardware every 10 seconds only if window is visible
    const interval = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const snap = await api.getHardwareSnapshot();
        setHardware(snap);
      } catch (e) {
        console.error("Hardware fetch err", e);
      }
    }, 10_000);

    // Initial fetch
    if (document.visibilityState === 'visible') {
      api.getHardwareSnapshot().then(setHardware).catch(() => {});
    }

    return () => clearInterval(interval);
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

  function renderPage() {
    const accountType = user?.type || "personal";
    const plan = user?.plan || "free";

    switch (page) {
      case "dashboard":
        return <DashboardPage dashboard={dashboard} isLoading={isLoading} hardware={hardware} />;
      case "pccenter":
        return <PCCenterPage hardware={hardware} />;
      case "threats":
        return <ThreatsPage events={threats} onClear={handleClear} isClearing={isClearing} />;
      case "scanner":
        return <FileScannerPage />;
      case "taskmanager":
        return <TaskManagerPage processes={processes} />;
      case "monitor":
        return <MonitorPage events={events} processes={processes} connections={connections} protection={protection} quarantine={quarantine} />;
      case "simulator":
        return <SimulatorPage />;
      case "otimizar":
        return <OtimizarPage hardware={hardware} />;
      case "reports":
        if (!canAccess(FEATURES.REPORTS, accountType, plan)) {
          return <DashboardPage dashboard={dashboard} isLoading={isLoading} hardware={hardware} />;
        }
        return <ReportsPage events={events} threats={threats} quarantine={quarantine} />;
    }
  }

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden font-sans selection:bg-primary/30 relative">
      <div className="fixed top-0 left-1/4 w-96 h-96 bg-primary/5 rounded-full blur-[120px] pointer-events-none z-0" />
      <div className="fixed bottom-0 right-1/4 w-80 h-80 bg-cyber-cyan/5 rounded-full blur-[100px] pointer-events-none z-0" />

      <div className="flex w-full h-full relative z-10 scanlines hex-pattern">
        <Sidebar
          activePage={page}
          onNavigate={setPage}
          theme={theme}
          accent={accent}
          onThemeChange={setTheme}
          onAccentChange={setAccent}
          user={user}
          onLogout={logout}
        />

        <main className="flex-1 overflow-y-auto relative cyber-grid">
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
      <AIAssistant />
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

  useEffect(() => {
    if (!isAuthenticated) {
      const savedTheme = (localStorage.getItem("theme") as ThemeMode | null) ?? "dark";
      document.documentElement.className = savedTheme;
      document.documentElement.setAttribute("data-theme", savedTheme);
    }
  }, [isAuthenticated]);

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
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
