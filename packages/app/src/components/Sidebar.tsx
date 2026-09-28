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
import { canUserAccess, FEATURES, type FeatureKey } from "../lib/featureControl"
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

/** Rótulos PT-PT dos acentos — o valor interno fica interno. */
const ACCENT_LABELS: Record<string, string> = {
  cyan: "Ciano",
  pink: "Rosa",
  purple: "Roxo",
  "red-wine": "Vinho",
};

const ACCENT_SWATCH: Record<string, string> = {
  cyan: "bg-cyber-cyan",
  pink: "bg-cyber-pink",
  purple: "bg-cyber-purple",
  "red-wine": "bg-accent-wine",
};

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
  const statusMeta = level ? levelMeta(level) : null;

  const visibleNavItems = navItems.filter((item) => canUserAccess(item.feature, user));

  return (
    <aside
      aria-label="Navegação principal"
      className={cn(
        // Superfície e borda vêm dos tokens (bg-sidebar / border-sidebar-border),
        // que é a correção real. A classe `.sidebar` NÃO é posta de volta: as
        // regras por tema dela (blur de 24px de backdrop-filter em toda a
        // altura do sidebar, gradiente vinho) nunca estiveram ativas antes desta
        // ronda porque ninguém punha a classe no elemento — ligá-las era um
        // efeito de pintura novo, não pedido, e é exatamente o género de coisa
        // que se paga num switch de tema. Ficam dormentes até haver medição.
        "bg-sidebar border-r border-sidebar-border text-sidebar-foreground flex flex-col transition-all duration-300 relative z-50",
        collapsed ? "w-[var(--shell-sidebar-w-collapsed)]" : "w-[var(--shell-sidebar-w)]"
      )}
    >
      {/* Decorative top line */}
      <div aria-hidden className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent" />

      {/* Logo Section */}
      <div className="p-6 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="relative shrink-0">
            {/* Sem placa por trás: o monograma flat já traz a sua margem de ar
                livre e, no modo claro, o tile traz a sua própria placa. Uma
                moldura em cima de outra era só ruído. */}
            <BrandLogo size="md" label="" />
            {/* Indicador de atividade do motor: usa o MESMO estado do chip de
                baixo. Antes era verde permanente, o que anunciava "tudo bem"
                mesmo com o motor em falha. */}
            {statusMeta && (
              <div className={cn("absolute -top-1 -right-1 w-3 h-3 rounded-full cyber-pulse", statusMeta.dotClass)}>
                <div className={cn("absolute inset-0 rounded-full animate-ping opacity-75", statusMeta.dotClass)} />
              </div>
            )}
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
              aria-label={collapsed ? item.label : undefined}
              aria-current={isActive ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              className={cn(
                "nav-item w-full flex items-center gap-3 px-4 py-3 overflow-hidden",
                isActive && "active",
              )}
            >
              <Icon className="w-5 h-5 shrink-0" />

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
                aria-label={theme === 'dark' ? "Ativar modo claro" : "Ativar modo escuro"}
                className="nav-item flex items-center gap-3 px-4 py-2 text-muted-foreground"
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
                                aria-label={`Cor de destaque: ${ACCENT_LABELS[c] ?? c}`}
                                aria-pressed={accent === c}
                                title={ACCENT_LABELS[c] ?? c}
                                className={cn(
                                    "w-4 h-4 rounded-full border border-border transition-transform hover:scale-125",
                                    ACCENT_SWATCH[c],
                                    // O estado selecionado não é só cor: anel
                                    // duplo com contraste nos dois modos.
                                    accent === c && "ring-2 ring-foreground/70 ring-offset-2 ring-offset-sidebar",
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
                  aria-label="Terminar sessão"
                  title="Terminar sessão"
                  className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded"
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
          statusMeta ? statusMeta.chipClass : "border-border bg-secondary/40",
        )}>
          <div className="flex items-center gap-2 justify-center">
            <div className={cn("w-2 h-2 rounded-full cyber-pulse", statusMeta ? statusMeta.dotClass : "bg-muted-foreground")} />
            {!collapsed ? (
              <span className={cn(
                "text-xs font-mono uppercase tracking-wider",
                statusMeta ? statusMeta.textClass : "text-muted-foreground",
              )}>
                {statusMeta ? statusMeta.shortLabel : "A verificar"}
              </span>
            ) : (
              /* Colapsado: o ponto colorido sozinho não é um sinal acessível. */
              <span className="sr-only">
                {statusMeta ? `Estado do sistema: ${statusMeta.shortLabel}` : "Estado do sistema por verificar"}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Collapse Toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        aria-label={collapsed ? "Expandir menu de navegação" : "Fechar menu de navegação"}
        aria-expanded={!collapsed}
        title={collapsed ? "Expandir menu" : "Fechar menu"}
        className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 bg-secondary border border-border rounded-full flex items-center justify-center hover:bg-primary/20 hover:border-primary/50 transition-all shadow-lg z-50"
      >
        {collapsed ? (
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronLeft className="w-4 h-4 text-muted-foreground" />
        )}
      </button>
    </aside>
  )
}
