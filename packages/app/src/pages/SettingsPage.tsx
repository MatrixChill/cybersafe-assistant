import { Bell, Check, MonitorCog, Power } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppearance } from "../contexts/AppearanceContext";
import type { AppIdentity, AccentMode } from "../lib/appearance";
import { useState, useEffect } from "react";

/** Identidades principais. */
const IDENTITY_OPTIONS: { id: AppIdentity; name: string; description: string; swatch: string[] }[] = [
  {
    id: "cybersafe-core",
    name: "CyberSafe Core",
    description: "Visual profissional e equilibrado. Navy profundo, ciano, cards sólidos e boa densidade.",
    swatch: ["bg-[#16d6c1]", "bg-[#0b3c4d]", "bg-[#111528]"],
  },
  {
    id: "cybersafe-neon",
    name: "CyberSafe Neon",
    description: "Aparência amigável e comercial. Azul/ciano profundo, indicadores suaves e cards modernos.",
    swatch: ["bg-cyber-cyan", "bg-cyber-green", "bg-cyber-purple"],
  },
  {
    id: "matrix-terminal",
    name: "Matrix Terminal",
    description: "Visual técnico de terminal. Preto e verde Matrix, linhas finas e tipografia monospace.",
    swatch: ["bg-cyber-green", "bg-cyber-green/60", "bg-cyber-green/30"],
  },
  {
    id: "cybersafe-liquid",
    name: "CyberSafe Liquid",
    description: "Painéis translúcidos com glass UI, blur suave, profundidade por layers e modernidade.",
    swatch: ["bg-cyan-400", "bg-teal-400", "bg-sky-400"],
  },
  {
    id: "cybersafe-red-belbete",
    name: "Red Belbete",
    description: "Premium vermelho escuro. Vinho, borgonha e cereja escura sobre preto — elegante e sofisticado.",
    swatch: ["bg-[#c8324a]", "bg-[#6f1728]", "bg-[#3b0d17]"],
  },
];

/** Cor de destaque — afeta primary, ring, accent, sidebar. NUNCA altera cores semânticas (success/warning/danger). */
const ACCENT_OPTIONS: { id: AccentMode; name: string; swatch: string[] }[] = [
  { id: "cyan", name: "Cyan", swatch: ["text-cyber-cyan", "border-cyber-cyan"] },
  { id: "matrix-green", name: "Matrix Green", swatch: ["text-cyber-green", "border-cyber-green"] },
  { id: "blue", name: "Blue", swatch: ["text-blue-500", "border-blue-500"] },
  { id: "purple", name: "Purple", swatch: ["text-purple-500", "border-purple-500"] },
  { id: "pink", name: "Pink", swatch: ["text-pink-500", "border-pink-500"] },
  { id: "amber", name: "Amber", swatch: ["text-amber-500", "border-amber-500"] },
  { id: "red-wine", name: "Red Wine", swatch: ["text-[#c8324a]", "border-[#c8324a]"] },
];

export default function SettingsPage() {
  const { identity, setIdentity, accent, setAccent } = useAppearance();
  const [autoStart, setAutoStart] = useState(false);
  const [startMinimized, setStartMinimized] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);

  useEffect(() => {
    if (window.electronAPI?.getAutoStart) {
      window.electronAPI.getAutoStart().then((config) => {
        setAutoStart(config?.enabled ?? false);
        setStartMinimized(config?.startMinimized ?? false);
      }).catch(() => {});
    }
    if (window.electronAPI?.getNotificationsEnabled) {
      window.electronAPI.getNotificationsEnabled().then((config) => {
        setNotificationsEnabled(config?.enabled ?? true);
      }).catch(() => {});
    }
  }, []);

  async function toggleAutoStart(checked: boolean) {
    setAutoStart(checked);
    if (window.electronAPI?.setAutoStart) {
      await window.electronAPI.setAutoStart({ enabled: checked, startMinimized });
    }
  }

  async function toggleStartMinimized(checked: boolean) {
    setStartMinimized(checked);
    if (window.electronAPI?.setAutoStart) {
      await window.electronAPI.setAutoStart({ enabled: autoStart, startMinimized: checked });
    }
  }

  async function toggleNotifications(checked: boolean) {
    setNotificationsEnabled(checked);
    if (window.electronAPI?.setNotificationsEnabled) {
      await window.electronAPI.setNotificationsEnabled(checked);
    }
  }

  return (
    <div className="p-8 max-w-3xl space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tight">
          Configurações
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Preferências da aplicação
        </p>
      </div>

      {/* === APARÊNCIA === */}
      <section className="cyber-border rounded-xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center">
            <MonitorCog className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-mono font-semibold text-foreground">Aparência</h2>
            <p className="text-xs text-muted-foreground">Identidade visual da aplicação</p>
          </div>
        </div>

        <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-3">Tema</div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {IDENTITY_OPTIONS.map((option) => {
            const selected = identity === option.id;
            return (
              <button
                key={option.id}
                onClick={() => setIdentity(option.id)}
                aria-pressed={selected}
                className={cn(
                  "text-left p-5 rounded-xl border transition-all cyber-border",
                  selected
                    ? "border-primary/50 bg-primary/5 shadow-[0_0_20px_color-mix(in_oklch,var(--primary)_15%,transparent)]"
                    : "opacity-80 hover:opacity-100 hover:border-primary/30",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className={cn("font-mono font-semibold text-foreground", selected && "text-primary")}>
                    {option.name}
                  </span>
                  {selected ? (
                    <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
                      <Check className="w-3 h-3" />
                    </span>
                  ) : (
                    <span className="w-5 h-5 rounded-full border border-border shrink-0" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{option.description}</p>
                <div className="flex items-center gap-2 mt-4">
                  {option.swatch.map((cls) => (
                    <div key={cls} className={cn("w-4 h-4 rounded-full border border-white/10", cls)} />
                  ))}
                </div>
              </button>
            );
          })}
        </div>

        <p className="text-[10px] text-muted-foreground mt-4 font-mono">
          A alteração é aplicada imediatamente e fica guardada para o próximo arranque.
        </p>
      </section>

      {/* === COR DE DESTQUE === */}
      <section className="cyber-border rounded-xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center">
            <MonitorCog className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-mono font-semibold text-foreground">Cor de destaque</h2>
            <p className="text-xs text-muted-foreground">Define primary, ring, borders e glow. Cores semânticas (success/warning/danger) permanecem inalteradas.</p>
          </div>
        </div>

        <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-3">Selecionar</div>

        <div className="grid grid-cols-2 gap-3">
          {ACCENT_OPTIONS.map((option) => {
            const selected = accent === option.id;
            return (
              <div
                key={option.id}
                className={cn(
                  "p-3 rounded-lg border transition-all cursor-pointer select-none",
                  selected
                    ? "border-primary/50 bg-primary/5 shadow-[0_0_20px_color-mix(in_oklch,var(--primary)_15%,transparent)]"
                    : "hover:border-primary/30 hover:bg-primary/10",
                )}
                onClick={() => setAccent(option.id)}
                aria-pressed={selected}
                role="button"
                tabIndex={selected ? -1 : 0}
              >
                <div className="w-full h-6 rounded-lg overflow-hidden mb-2">
                  <div
                    className="h-full flex items-center justify-center"
                    style={{
                      background: `color-mix(in oklch, var(${option.swatch[0]}) 80%, transparent)`,
                    }}
                  />
                </div>
                <p className="text-xs font-mono text-foreground text-center">{option.name}</p>
                {selected && (
                  <Check className="w-4 h-4 rounded flex items-center justify-center mt-1 text-primary-absolute" />
                )}
              </div>
            );
          })}
        </div>

        <p className="text-[10px] text-muted-foreground mt-4 font-mono">
          A alteração é aplicada imediatamente e fica guardada para o próximo arranque.
        </p>
      </section>

      {/* === INICIAR COM O WINDOWS === */}
      <section className="cyber-border rounded-xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center">
            <Power className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-mono font-semibold text-foreground">Iniciar com o Windows</h2>
            <p className="text-xs text-muted-foreground">O CyberSafe inicia automaticamente quando o computador arranca</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.03] border border-white/[0.06]">
            <div>
              <p className="text-sm font-mono text-foreground">Iniciar automaticamente</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Abre o CyberSafe quando o Windows inicia</p>
            </div>
            <button
              onClick={() => toggleAutoStart(!autoStart)}
              className={cn(
                "relative w-11 h-6 rounded-full transition-colors",
                autoStart ? "bg-primary" : "bg-secondary",
              )}
            >
              <div className={cn(
                "absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform",
                autoStart ? "translate-x-5.5" : "translate-x-0.5",
              )} />
            </button>
          </div>

          {autoStart && (
            <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.03] border border-white/[0.06] ml-4">
              <div>
                <p className="text-sm font-mono text-foreground">Iniciar minimizado</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">Começa em segundo plano sem mostrar a janela</p>
              </div>
              <button
                onClick={() => toggleStartMinimized(!startMinimized)}
                className={cn(
                  "relative w-11 h-6 rounded-full transition-colors",
                  startMinimized ? "bg-primary" : "bg-secondary",
                )}
              >
                <div className={cn(
                  "absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform",
                  startMinimized ? "translate-x-5.5" : "translate-x-0.5",
                )} />
              </button>
            </div>
          )}
        </div>

        <p className="text-[10px] text-muted-foreground mt-4 font-mono">
          Requer que o CyberSafe esteja instalado no sistema. O registo no Windows é feito de forma segura.
        </p>
      </section>

      {/* === NOTIFICAÇÕES === */}
      <section className="cyber-border rounded-xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center">
            <Bell className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-mono font-semibold text-foreground">Notificações</h2>
            <p className="text-xs text-muted-foreground">Notificações do Windows para alertas de segurança importantes</p>
          </div>
        </div>

        <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.03] border border-white/[0.06]">
          <div>
            <p className="text-sm font-mono text-foreground">Notificações do sistema</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">Avisos do Windows para ameaças detetadas e processos bloqueados</p>
          </div>
          <button
            onClick={() => toggleNotifications(!notificationsEnabled)}
            className={cn(
              "relative w-11 h-6 rounded-full transition-colors",
              notificationsEnabled ? "bg-primary" : "bg-secondary",
            )}
          >
            <div className={cn(
              "absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform",
              notificationsEnabled ? "translate-x-5.5" : "translate-x-0.5",
            )} />
          </button>
        </div>

        <p className="text-[10px] text-muted-foreground mt-4 font-mono">
          Apenas alertas críticos ou elevados geram uma notificação nativa. Alertas de baixa prioridade aparecem apenas dentro da aplicação.
        </p>
      </section>

      {/* === BOAS-VINDAS === */}
      <section className="cyber-border rounded-xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center">
            <Check className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-mono font-semibold text-foreground">Boas-vindas</h2>
            <p className="text-xs text-muted-foreground">Reveja a introdução à aplicação a qualquer momento</p>
          </div>
        </div>

        <button
          onClick={() => window.dispatchEvent(new Event("cybersafe:open-onboarding"))}
          className="px-5 py-2.5 bg-secondary text-foreground border border-border font-mono text-sm rounded-lg hover:border-primary/40 hover:bg-secondary/80 transition-all"
        >
          Reabrir boas-vindas
        </button>

        <p className="text-[10px] text-muted-foreground mt-4 font-mono">
          O ecrã de boas-vindas só é mostrado automaticamente na primeira utilização.
        </p>
      </section>
    </div>
  );
}