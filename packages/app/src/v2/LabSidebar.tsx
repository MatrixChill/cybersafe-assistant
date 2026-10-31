/** Original lab sidebar DOM, with production routes, auth and permissions. */
import { useEffect, useState } from "react";
import {
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
} from "lucide-react";
import type { AuthUser } from "@/contexts/AuthContext";
import { canUserAccess } from "@/lib/featureControl";
import { loadSidebarCollapsed, saveSidebarCollapsed } from "@/lib/sidebarState";
import { levelMeta, type ProtectionLevel } from "@/lib/protectionHealth";
import { navGroups, type Page } from "./navigation";
interface Props {
  activePage: Page;
  onNavigate: (page: Page) => void;
  user?: AuthUser | null;
  onLogout?: () => void;
  level?: ProtectionLevel;
  defaultCollapsed?: boolean;
}
export default function LabSidebar({
  activePage,
  onNavigate,
  user,
  onLogout,
  level,
  defaultCollapsed = false,
}: Props) {
  const [collapsed, setCollapsed] = useState(
    () => defaultCollapsed || loadSidebarCollapsed(),
  );
  useEffect(() => saveSidebarCollapsed(collapsed), [collapsed]);
  const groups = navGroups
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => canUserAccess(i.feature, user)),
    }))
    .filter((g) => g.items.length);
  const meta = level ? levelMeta(level) : null;
  return (
    <aside
      className="sidebar lab-sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      data-cs-sidebar="main"
      aria-label="Navegação principal"
      onKeyDown={(e) => {
        if (e.key === "Escape" && collapsed) setCollapsed(false);
      }}
    >
      <button
        className="brand"
        onClick={() => onNavigate("dashboard")}
        aria-label="CyberSafe Assistant · Visão geral"
      >
        <span className="brand-mark">
          <img src="./brand/tile.png" alt="" width={38} height={38} />
        </span>
        <span>
          <strong>
            CyberSafe<span>®</span>
          </strong>
          <small>ASSISTANT</small>
        </span>
      </button>
      <div className="workspace-label">
        <span className="workspace-avatar">
          {user?.name.trim().charAt(0) || "?"}
        </span>
        <div>
          <strong>{user?.name || "Sessão"}</strong>
          <small>Espaço pessoal</small>
        </div>
        <ChevronRight size={14} />
      </div>
      <nav aria-label="Navegação principal">
        {groups.map((g) => (
          <div className="nav-group" key={g.label}>
            <div className="nav-label">
              {g.label.toLocaleUpperCase("pt-PT")}
            </div>
            {g.items.map((i) => {
              const active =
                i.id === activePage ||
                (i.id === "threats" && activePage === "quarantine");
              return (
                <button
                  key={i.id}
                  className={active ? "active" : undefined}
                  aria-current={active ? "page" : undefined}
                  aria-label={i.label}
                  title={collapsed ? i.label : undefined}
                  onClick={() => onNavigate(i.id)}
                >
                  <i.icon size={i.iconSize ?? 18} strokeWidth={i.iconStrokeWidth ?? 1.65} />
                  <span>{i.label}</span>
                  {active && <i className="nav-indicator" />}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="isolation">
          <span className="isolation-dot" />
          <span>
            {meta?.shortLabel || "A verificar"}
            <small>Estado reportado pelo serviço</small>
          </span>
        </div>
        <button
          className="collapse-button"
          aria-label={collapsed ? "Expandir navegação" : "Recolher navegação"}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? (
            <PanelLeftOpen size={17} />
          ) : (
            <PanelLeftClose size={17} />
          )}
          <span>Recolher navegação</span>
        </button>
        {onLogout && (
          <button
            className="collapse-button"
            onClick={onLogout}
            aria-label="Terminar sessão"
          >
            <LogOut size={17} />
            <span>Terminar sessão</span>
          </button>
        )}
      </div>
    </aside>
  );
}
