import {
  LayoutDashboard,
  AlertTriangle,
  FileSearch,
  Activity,
  Zap,
  ChevronLeft,
  ChevronRight,
  Sun,
  Moon,
  Palette,
  LogOut,
  FileBarChart,
  Sparkles,
  ListTodo,
  Monitor,
  Wrench,
  Settings2,
  Network,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useState } from "react"
import type { AuthUser } from "../contexts/AuthContext"
import { canAccess, FEATURES, type FeatureKey } from "../lib/featureControl"
import { BrandLogo } from "./BrandLogo"
import type { AccentMode, ThemeMode } from "../lib/appearance"
import { levelMeta, type ProtectionLevel } from "../lib/protectionHealth"

export type Page = "dashboard" | "pccenter" | "threats" | "scanner" | "monitor" | "simulator" | "reports" | "taskmanager" | "otimizar" | "settings" | "business";

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  accent: AccentMode;
  onAccentChange: (accent: AccentMode) => void;
  isOpen?: boolean;
  onClose?: () => void;
  user?: AuthUser | null;
  onLogout?: () => void;
  level?: ProtectionLevel;
}

const navItems: { id: Page; label: string; icon: typeof LayoutDashboard; feature: FeatureKey; proOnly: boolean }[] = [
  { id: "dashboard", label: "Painel", icon: LayoutDashboard, feature: FEATURES.DASHBOARD_BASIC, proOnly: false },
  { id: "pccenter", label: "PC Center", icon: Monitor, feature: FEATURES.DASHBOARD_BASIC, proOnly: false },
  { id: "threats", label: "Ameaças", icon: AlertTriangle, feature: FEATURES.THREATS, proOnly: false },
  { id: "scanner", label: "Análise de Segurança", icon: FileSearch, feature: FEATURES.SCANNER, proOnly: false },
  { id: "taskmanager", label: "Gestor de Tarefas", icon: ListTodo, feature: FEATURES.MONITOR_BASIC, proOnly: false },
  { id: "monitor", label: "Monitor de Rede", icon: Activity, feature: FEATURES.MONITOR_BASIC, proOnly: false },
  { id: "simulator", label: "Simulador", icon: Zap, feature: FEATURES.SIMULATOR, proOnly: false },
  { id: "otimizar", label: "Otimizar", icon: Wrench, feature: FEATURES.DASHBOARD_BASIC, proOnly: false },
  { id: "business", label: "Business Center", icon: Network, feature: FEATURES.BUSINESS_SECURITY_CENTER, proOnly: true },
  { id: "reports", label: "Relatórios", icon: FileBarChart, feature: FEATURES.REPORTS, proOnly: true },
  { id: "settings", label: "Configurações", icon: Settings2, feature: FEATURES.DASHBOARD_BASIC, proOnly: false },
];

export default function Sidebar({
  activePage,
  onNavigate,
  theme,
  onThemeChange,
  accent,
  onAccentChange,
  user,
  onLogout,
  level,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false)
  const accountType = user?.type || "personal";
  const plan = user?.plan || "free";
  const statusMeta = level ? levelMeta(level) : null;

  const visibleNavItems = navItems.filter((item) => canAccess(item.feature, accountType, plan));

  return (
    <aside
      className={cn(
        "bg-sidebar border-r border-sidebar-border flex flex-col transition-all duration-300 relative z-50",
        collapsed ? "w-20" : "w-64"
      )}
    >
      {/* Decorative top line */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent" />

      {/* Logo Section */}
      <div className="p-6 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="relative shrink-0">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center cyber-border">
              <BrandLogo size="sm" />
            </div>
            {/* Pulse indicator */}
            <div className="absolute -top-1 -right-1 w-3 h-3 bg-cyber-green rounded-full cyber-pulse">
              <div className="absolute inset-0 bg-cyber-green rounded-full animate-ping opacity-75" />
            </div>
          </div>
          {!collapsed && (
            <div className="flex flex-col min-w-0">
              <span className="font-mono text-lg font-bold tracking-tight text-foreground truncate">
                CYBER<span className="text-primary">SAFE</span>
              </span>
              <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-mono truncate">
                Security Assistant
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-2 overflow-y-auto overflow-x-hidden">
        {visibleNavItems.map((item) => {
          const Icon = item.icon
          const isActive = activePage === item.id

          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 group relative overflow-hidden",
                isActive
                  ? "bg-primary/10 text-primary cyber-border"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              )}
            >
              {/* Active indicator line */}
              {isActive && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full shadow-[0_0_10px_var(--primary)]" />
              )}

              <Icon className={cn(
                "w-5 h-5 shrink-0 transition-all",
                isActive && "cyber-glow-text"
              )} />

              {!collapsed && (
                <>
                  <span className="font-medium text-sm truncate">{item.label}</span>
                  {item.id === "business" ? (
                    <span className="nav-pro-badge">
                      <Network className="w-2.5 h-2.5" />
                      BUSINESS
                    </span>
                  ) : item.proOnly && (
                    <span className="nav-pro-badge">
                      <Sparkles className="w-2.5 h-2.5" />
                      PRO
                    </span>
                  )}
                </>
              )}

              {/* Hover glow effect */}
              <div className={cn(
                "absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none",
                "bg-gradient-to-r from-primary/5 to-transparent"
              )} />
            </button>
          )
        })}
      </nav>

      {/* Theme & Accent Controls */}
      <div className={cn("p-4 space-y-3 border-t border-sidebar-border", collapsed && "items-center")}>
        {!collapsed && <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold px-2">Definições</div>}

        <div className="flex flex-col gap-2">
            {/* Theme Toggle */}
            <button
                onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
                className="flex items-center gap-3 px-4 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-all group"
                title={collapsed ? (theme === 'dark' ? "Modo Claro" : "Modo Escuro") : ""}
            >
                {theme === 'dark' ? <Sun className="w-4 h-4 shrink-0" /> : <Moon className="w-4 h-4 shrink-0" />}
                {!collapsed && <span className="text-sm">{theme === 'dark' ? "Modo Claro" : "Modo Escuro"}</span>}
            </button>

            {/* Accent Selection */}
            <div className={cn("flex items-center gap-3 px-4 py-2", collapsed && "justify-center px-0")}>
                <Palette className="w-4 h-4 text-muted-foreground shrink-0" />
                {!collapsed && (
                    <div className="flex gap-2">
                        {(['cyan', 'pink', 'purple', 'red-wine'] as AccentMode[]).map((c) => (
                            <button
                                key={c}
                                onClick={() => onAccentChange(c)}
                                aria-label={`Tema ${c}`}
                                title={c}
                                className={cn(
                                    "w-4 h-4 rounded-full transition-transform hover:scale-125",
                                    c === 'cyan' && "bg-[var(--color-cyber-cyan)]",
                                    c === 'pink' && "bg-[var(--color-cyber-pink)]",
                                    c === 'purple' && "bg-[var(--color-cyber-purple)]",
                                    c === 'red-wine' && "bg-[#c8324a]",
                                    accent === c && "ring-2 ring-white ring-offset-2 ring-offset-background"
                                )}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
      </div>

      {/* User Area */}
      {user && (
        <div className={cn("p-4 border-t border-sidebar-border", collapsed && "px-2")}>
          <div className="sidebar-user-area">
            <div className="sidebar-user-avatar">
              {user.name.charAt(0).toUpperCase()}
            </div>
            {!collapsed && (
              <>
                <div className="sidebar-user-info">
                  <span className="sidebar-user-name">{user.name}</span>
                  <span className={cn(
                    "sidebar-user-type",
                    user.plan === "premium" && "sidebar-user-type-pro",
                    user.plan === "pro" && "text-cyber-cyan"
                  )}>
                    {user.plan === "premium" ? (user.type === "business" ? "Business Premium" : "Personal Premium") :
                     user.plan === "pro" ? (user.type === "business" ? "Business Pro" : "Personal Pro") : "Free"}
                  </span>
                </div>
                <button
                  onClick={onLogout}
                  className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded"
                  title="Sair"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* System Status — reflete o ProtectionHealth real, nunca afirma "online" sem motores ativos. */}
      <div className={cn("p-4 border-t border-sidebar-border", collapsed && "px-2")}>
        <div className={cn(
          "border rounded-lg p-3",
          collapsed && "p-2",
          statusMeta ? statusMeta.chipClass : "bg-cyber-green/10 border-cyber-green/30",
        )}>
          <div className="flex items-center gap-2">
            <div className={cn("w-2 h-2 rounded-full cyber-pulse", statusMeta ? statusMeta.dotClass : "bg-cyber-green")} />
            {!collapsed && (
              <span className={cn(
                "text-xs font-mono uppercase tracking-wider",
                statusMeta ? statusMeta.textClass : "text-cyber-green",
              )}>
                {statusMeta ? statusMeta.shortLabel : "Sistema Online"}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Collapse Toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 bg-secondary border border-border rounded-full flex items-center justify-center hover:bg-primary/20 hover:border-primary/50 transition-all shadow-lg z-50"
      >
        {collapsed ? (
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronLeft className="w-4 h-4 text-muted-foreground" />
        )}
      </button>

      {/* Version info */}
      {!collapsed && (
        <div className="p-4 pt-0">
          <div className="text-[10px] font-mono text-muted-foreground/50 text-center">
            v2.4.1 • Build 2026.03
          </div>
        </div>
      )}
    </aside>
  )
}
