import {
  LayoutDashboard,
  AlertTriangle,
  FileSearch,
  Activity,
  Zap,
  ChevronLeft,
  ChevronRight,
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
import { useCallback, useEffect, useState } from "react"
import type { KeyboardEvent } from "react"
import { motion, useReducedMotion } from "framer-motion"
import type { HTMLMotionProps } from "framer-motion"
import type { AuthUser } from "../contexts/AuthContext"
import { canUserAccess, FEATURES, type FeatureKey } from "../lib/featureControl"
import { BrandLogo } from "./BrandLogo"
import { levelMeta, type ProtectionLevel } from "../lib/protectionHealth"
import { loadSidebarCollapsed, saveSidebarCollapsed } from "../lib/sidebarState"

export type Page = "dashboard" | "pccenter" | "threats" | "quarantine" | "scanner" | "monitor" | "simulator" | "reports" | "taskmanager" | "otimizar" | "settings" | "business";

interface SidebarProps {
  activePage: Page;
  onNavigate: (page: Page) => void;
  isOpen?: boolean;
  onClose?: () => void;
  user?: AuthUser | null;
  onLogout?: () => void;
  level?: ProtectionLevel;
  /** Estado inicial do colapso. Só para harness/SSR — o App não o usa (o
      utilizador comanda pelo botão). Permite testar as duas composições. */
  defaultCollapsed?: boolean;
}

const navGroups: { label: string; items: { id: Page; label: string; icon: typeof LayoutDashboard; feature: FeatureKey; proOnly: boolean }[] }[] = [
  {
    label: "Painel",
    items: [
      { id: "dashboard", label: "Painel", icon: LayoutDashboard, feature: FEATURES.DASHBOARD_BASIC, proOnly: false },
    ],
  },
  {
    label: "Segurança",
    items: [
      { id: "scanner", label: "Análise de Segurança", icon: FileSearch, feature: FEATURES.SCANNER, proOnly: false },
      // A Quarentena passou a aba dentro de Ameaças: "Deteções" e "Quarentena"
      // são dois factos separados do mesmo domínio, não duas páginas do menu.
      // A rota "quarantine" continua a existir em App.tsx para os deep links
      // antigos (tray incluído) — cai na aba certa.
      { id: "threats", label: "Ameaças", icon: AlertTriangle, feature: FEATURES.THREATS, proOnly: false },
      // A página abre como "Monitor em Tempo Real". Id interno inalterado ("monitor"),
      // rota/deep link e storage inalterados (comportamento, nome de rota e chaves
      // de estado ficam onde estão). Só o rótulo do menu sai do ecrã.
      { id: "monitor", label: "Monitor em Tempo Real", icon: Activity, feature: FEATURES.MONITOR_BASIC, proOnly: false },
    ],
  },
  {
    label: "Computador",
    items: [
      { id: "pccenter", label: "PC Center", icon: Monitor, feature: FEATURES.DASHBOARD_BASIC, proOnly: false },
      { id: "taskmanager", label: "Gestor de Tarefas", icon: ListTodo, feature: FEATURES.MONITOR_BASIC, proOnly: false },
    ],
  },
  {
    label: "Ferramentas",
    items: [
      { id: "otimizar", label: "Otimizar", icon: Wrench, feature: FEATURES.DASHBOARD_BASIC, proOnly: false },
      { id: "simulator", label: "Simulador", icon: Zap, feature: FEATURES.SIMULATOR, proOnly: false },
    ],
  },
  {
    label: "Definições",
    items: [
      { id: "settings", label: "Configurações", icon: Settings2, feature: FEATURES.DASHBOARD_BASIC, proOnly: false },
    ],
  },
  {
    label: "Experimental",
    items: [
      { id: "business", label: "Business Center", icon: Network, feature: FEATURES.BUSINESS_SECURITY_CENTER, proOnly: true },
      // Sem placa «PRO»: Relatórios deixou de depender do plano (é isolamento de
      // conta, `featureControl.canAccess`),
      // não há neste produto nenhum caminho para comprar `pro`/`premium`. Uma placa de tier
      // seria anunciar uma venda que não existe. A placa BUSINESS do item de cima descreve
      // a conta, não um preço, e fica.
      { id: "reports", label: "Relatórios", icon: FileBarChart, feature: FEATURES.REPORTS, proOnly: false },
    ],
  },
];




/** Foco visível consistente em todos os controlos da Sidebar. */
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar";

const SPRING = { type: "spring" as const, stiffness: 420, damping: 34, mass: 0.9 };
const ICON_SPRING = { type: "spring" as const, stiffness: 500, damping: 30 };

/** Container animado: a largura final segue o estado do parent — é ele que
    manda no colapso. O spring de largura é interruptível: inverter a meio do
    movimento troca de destino sem salto. Movimento reduzido → salto imediato. */
type AnimatedAsideProps = HTMLMotionProps<"aside"> & { collapsed?: boolean }

function AnimatedAside({ collapsed = false, className, children, ...props }: AnimatedAsideProps) {
  const reduceMotion = useReducedMotion() === true
  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? "var(--shell-sidebar-w-collapsed)" : "var(--shell-sidebar-w)" }}
      transition={reduceMotion ? { duration: 0 } : SPRING}
      className={cn(
        "sidebar-surface bg-sidebar border-r border-sidebar-border text-sidebar-foreground flex flex-col transition-colors duration-300 relative z-50",
        className,
      )}
      {...props}
    >
      {children}
    </motion.aside>
  )
}

export default function Sidebar({
  activePage,
  onNavigate,
  user,
  onLogout,
  level,
  defaultCollapsed = false,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(() => defaultCollapsed || loadSidebarCollapsed())
  // Estado recolhido sobrevive ao reinício (best-effort, ver lib/sidebarState).
  useEffect(() => { saveSidebarCollapsed(collapsed) }, [collapsed])
  // Movimento reduzido: os springs de JS (pulso, indicador, ícones) desligam-se.
  // O CSS global já corta as transições; um spring do framer não é CSS.
  const reduceMotion = useReducedMotion() === true
  const statusMeta = level ? levelMeta(level) : null;

  // Rotas intactas: o estado "quarantine" (deep link antigo) pertence ao item
  // Ameaças; a selecao activa segue a rota real, nao o nome do menu.
  const isItemActive = (id: Page) =>
    activePage === id || (id === "threats" && activePage === "quarantine");

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && collapsed) {
      event.preventDefault()
      setCollapsed(false)
    }
  }, [collapsed])

  const handleToggle = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canUserAccess(item.feature, user)),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <AnimatedAside
      collapsed={collapsed}
      aria-label="Navegação principal"
      onKeyDown={handleKeyDown}
      data-collapsed={collapsed ? "true" : "false"}
      data-cs-sidebar="main"
    >
      {/* Fio decorativo do topo */}
      <div aria-hidden className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent" />

      {/* Cabeçalho: marca + estado do motor (o mesmo chip de baixo). É também a
          âncora do toggle de colapso: o botão vive aqui, centrado na linha da
          marca, e não mais num `top-[88px]` mágico que caía sobre o rótulo do
          primeiro grupo ("PAINEL") e colidia com a sua divisória. */}
      <div className={cn("relative border-b border-sidebar-border/80", collapsed ? "px-3 py-4" : "px-5 py-5")}>
        <div className={cn("flex items-center gap-3", collapsed && "justify-center")}>
          <div className="relative shrink-0">
            {/* Sem placa por trás: o monograma flat já traz a sua margem de ar
                livre e, no modo claro, o tile traz a sua própria placa. */}
            <BrandLogo size="md" label="" />
            {statusMeta && (
              <div
                className={cn(
                  "absolute -top-1 -right-1 w-3 h-3 rounded-full ring-2 ring-sidebar",
                  statusMeta.dotClass,
                )}
              >
                <motion.span
                  className="absolute inset-0 rounded-full"
                  animate={collapsed || reduceMotion ? false : { opacity: [0.3, 0.8, 0.3] }}
                  transition={{ duration: 1.4, repeat: collapsed || reduceMotion ? 0 : Infinity, ease: "easeInOut" }}
                />
              </div>
            )}
          </div>
          {!collapsed && (
            <div className="flex min-w-0 flex-col">
              <span className="font-mono text-lg font-bold leading-tight tracking-tight text-foreground truncate">
                CYBER<span className="text-primary">SAFE</span>
              </span>
              <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-mono truncate">
                Assistente de segurança
              </span>
            </div>
          )}
        </div>

        {/* Collapse Toggle — ancorado à linha da marca, centrado verticalmente.
            Assim nunca cai sobre o rótulo do primeiro grupo nem sobre a sua
            divisória; continua a sair pela margem direita do aside. */}
        <button
          type="button"
          onClick={handleToggle}
          aria-label={collapsed ? "Expandir menu de navegação" : "Fechar menu de navegação"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expandir menu" : "Fechar menu"}
          className={cn(
            "absolute -right-3 top-1/2 z-50 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-secondary shadow-lg transition-colors hover:border-primary/50 hover:bg-primary/20",
            FOCUS_RING,
          )}
        >
          {collapsed ? (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronLeft className="w-4 h-4 text-muted-foreground" />
          )}
        </button>
      </div>

      {/* Navegação: secções com rótulo e fio; colapsada, fio curto e ícones */}
      <nav className={cn("flex-1 min-h-0 overflow-y-auto overflow-x-hidden focus:outline-none", collapsed ? "px-2 py-3" : "px-3 py-3")}>
        {visibleGroups.map((group, groupIdx) => (
          <section
            key={group.label}
            aria-label={group.label}
            className={cn(groupIdx > 0 && (collapsed ? "mt-2" : "mt-1"))}
          >
            {groupIdx > 0 && (
              <div aria-hidden className={cn("h-px bg-sidebar-border/60", collapsed ? "my-2 mx-1" : "my-2 mx-2")} />
            )}
            {!collapsed && (
              <div className="flex items-center gap-2 px-2 pb-1">
                <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-mono">
                  {group.label}
                </span>
                <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-sidebar-border to-transparent" />
              </div>
            )}
            <div className="space-y-1">
              {group.items.map((item) => {
                const Icon = item.icon
                const isActive = isItemActive(item.id)

                return (
                  // O tema pinta o estado ativo via `.nav-item.active` (wash +
                  // barra inset). A barra inset é estática; a v2 acrescenta uma
                  // barra ANIMADA (layoutId). Desligar só a box-shadow evita
                  // duas barras sem mexer no CSS de tema (owners diferentes).
                  <button
                    key={item.id}
                    onClick={() => onNavigate(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        onNavigate(item.id)
                      }
                    }}
                    aria-label={collapsed ? item.label : undefined}
                    aria-current={isActive ? "page" : undefined}
                    title={collapsed ? item.label : undefined}
                    style={isActive ? { boxShadow: "none" } : undefined}
                    className={cn(
                      "nav-item w-full relative flex items-center gap-3 overflow-hidden rounded-xl px-2.5 py-1.5 text-left",
                      FOCUS_RING,
                      collapsed && "justify-center px-2",
                      isActive && "active",
                    )}
                  >
                    {/* Fundo da rota ativa: um só elemento partilhado por
                        layoutId — desliza entre itens com spring e pode ser
                        interrompido a meio (é isso que o torna "premium" em
                        vez de um fade de 150ms). */}
                    {isActive && (
                      <motion.span
                        aria-hidden="true"
                        data-active-bg="true"
                        layoutId="sidebar-active-bg"
                        transition={reduceMotion ? { duration: 0 } : SPRING}
                        className="absolute inset-0 rounded-xl bg-gradient-to-r from-primary/20 via-primary/[0.07] to-transparent ring-1 ring-primary/25"
                      />
                    )}

                    {/* Ícone em tile: dá profundidade sem custar contraste do
                        rótulo. Colapsado, o tile é o próprio item. */}
                    <motion.span
                      className={cn(
                        "relative z-10 flex shrink-0 items-center justify-center rounded-lg border transition-colors",
                        collapsed ? "h-10 w-10" : "h-9 w-9",
                        isActive
                          ? "border-primary/40 bg-primary/15 text-primary"
                          : "border-sidebar-border/70 bg-secondary/30 text-muted-foreground",
                      )}
                      animate={collapsed || reduceMotion ? false : { scale: isActive ? 1.04 : 1 }}
                      transition={ICON_SPRING}
                    >
                      <Icon className="h-[18px] w-[18px] shrink-0" />
                    </motion.span>

                    {!collapsed && (
                      <span className={cn("relative z-10 flex min-w-0 flex-1 items-center gap-2", isActive && "text-sidebar-foreground")}>
                        <span className="font-medium text-sm truncate">
                          {item.label}
                        </span>
                        {item.id === "business" ? (
                          <span className="nav-pro-badge ml-auto shrink-0">
                            <Network className="w-2.5 h-2.5" />
                            BUSINESS
                          </span>
                        ) : item.proOnly && (
                          <span className="nav-pro-badge ml-auto shrink-0">
                            <Sparkles className="w-2.5 h-2.5" />
                            PRO
                          </span>
                        )}
                      </span>
                    )}

                    {/* Barra da rota ativa: segunda pista, também partilhada por
                        layoutId (as duas transições deslizam juntas). */}
                    {isActive && !collapsed && (
                      <motion.span
                        aria-hidden="true"
                        data-active-bar="true"
                        layoutId="sidebar-nav-indicator"
                        transition={reduceMotion ? { duration: 0 } : SPRING}
                        className="absolute left-0 inset-y-2 my-auto h-6 w-[3px] rounded-full bg-primary"
                      />
                    )}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </nav>

      {/* Utilizador — `data-cs-reserve` é o expositor de geometria que o launcher
          da Matrix mede para não tapar conta, status nem toggle (TP-MATRIX-DRAG). */}
      {user && (
        <div className={cn("border-t border-sidebar-border/80", collapsed ? "p-2" : "p-3")} data-cs-reserve="matrix">
          <div className={cn("sidebar-user-area", collapsed && "justify-center")}>
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
              </>
            )}
            {/* Sair fica sempre acessível, também com a barra recolhida. */}
            <button
              onClick={onLogout}
              aria-label="Terminar sessão"
              title="Terminar sessão"
              className={cn("rounded p-1 text-muted-foreground transition-colors hover:text-destructive", FOCUS_RING)}
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Estado do sistema — reflete o ProtectionHealth real, nunca afirma
          "online" sem motores ativos. */}
      <div className={cn("border-t border-sidebar-border/80", collapsed ? "p-2" : "p-3")}>
        <div className={cn(
          "rounded-xl border p-2.5",
          statusMeta ? statusMeta.chipClass : "border-border bg-secondary/40",
        )}>
          <div className="flex items-center justify-center gap-2">
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

    </AnimatedAside>
  )
}
