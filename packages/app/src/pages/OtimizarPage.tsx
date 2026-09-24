import { useState } from "react"
import { motion } from "framer-motion"
import {
  ShieldCheck, Download, HardDrive, RefreshCw,
  AlertTriangle, CheckCircle, Info, Trash2, Globe,
  Cpu, Lock, Eye, Loader2
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { HardwareSnapshot } from "@cybersafe/shared-types"

type Priority = "high" | "medium" | "low"
// "action" executa uma operação real; "tip" apenas marca como feita (dica manual).
type ActionKind = "action" | "tip"

interface Recommendation {
  id: string
  title: string
  description: string
  priority: Priority
  category: string
  icon: React.ElementType
  action?: string
  kind: ActionKind
  done?: boolean
}

interface OtimizarPageProps {
  hardware?: HardwareSnapshot | null
}

const baseRecommendations: Omit<Recommendation, "done">[] = [
  {
    id: "firewall",
    title: "Firewall Windows Ativo",
    description: "Garante que o firewall do Windows está ativo e bloqueia conexões não autorizadas.",
    priority: "high",
    category: "Segurança",
    icon: ShieldCheck,
    action: "Verificar",
    kind: "action",
  },
  {
    id: "update",
    title: "Atualizar Definições de Ameaças",
    description: "Descarrega as últimas definições de ameaças para detetar malwares recentes.",
    priority: "high",
    category: "Sistema",
    icon: RefreshCw,
    action: "Atualizar",
    kind: "action",
  },
  {
    id: "disk-cleanup",
    title: "Análise Profunda do Computador",
    description: "Executa uma verificação mais abrangente e detalhada do sistema para detetar ameaças ocultas.",
    priority: "medium",
    category: "Performance",
    icon: HardDrive,
    action: "Iniciar",
    kind: "action",
  },
  {
    id: "browser-update",
    title: "Atualizar Navegador",
    description: "Navegadores desatualizados são vetores comuns de ataques drive-by download.",
    priority: "high",
    category: "Segurança",
    icon: Globe,
    action: "Verificar",
    kind: "tip",
  },
  {
    id: "passwords",
    title: "Revisar Senhas",
    description: "Use senhas únicas e fortes para cada conta. Ative autenticação 2FA sempre que possível.",
    priority: "medium",
    category: "Segurança",
    icon: Lock,
    action: "Gerar",
    kind: "tip",
  },
  {
    id: "extensions",
    title: "Revisar Extensões do Navegador",
    description: "Extensões maliciosas ou obsoletas podem comprometer sua privacidade e segurança.",
    priority: "medium",
    category: "Segurança",
    icon: Eye,
    action: "Revisar",
    kind: "tip",
  },
  {
    id: "startup",
    title: "Otimizar Programas de Inicialização",
    description: "Programas desnecessários na inicialização deixam o sistema lento e mais vulnerável.",
    priority: "low",
    category: "Performance",
    icon: Cpu,
    action: "Revisar",
    kind: "tip",
  },
  {
    id: "backup",
    title: "Backup dos Dados Importantes",
    description: "Mantenha cópias de segurança dos seus dados em local externo ou na nuvem.",
    priority: "medium",
    category: "Dados",
    icon: Download,
    action: "Configurar",
    kind: "tip",
  },
  {
    id: "scanner-run",
    title: "Atualizar a Base de Dados de Segurança",
    description: "Verifica e atualiza as definições de ameaças usadas na Análise de Segurança e no monitor.",
    priority: "high",
    category: "Segurança",
    icon: AlertTriangle,
    action: "Atualizar",
    kind: "action",
  },
  {
    id: "temp-files",
    title: "Verificar Saúde do Windows",
    description: "Consulta o estado das atualizações e da proteção do Windows a partir do serviço.",
    priority: "low",
    category: "Performance",
    icon: Trash2,
    action: "Verificar",
    kind: "action",
  },
]

export default function OtimizarPage({ hardware }: OtimizarPageProps) {
  const [recommendations, setRecommendations] = useState(() =>
    baseRecommendations.map((r) => ({ ...r, done: false }))
  )
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const toggleDone = (id: string) => {
    setRecommendations((prev) =>
      prev.map((r) => (r.id === id ? { ...r, done: !r.done } : r))
    )
  }

  const highCount = recommendations.filter((r) => r.priority === "high" && !r.done).length
  const mediumCount = recommendations.filter((r) => r.priority === "medium" && !r.done).length
  const lowCount = recommendations.filter((r) => r.priority === "low" && !r.done).length
  const total = recommendations.length
  const doneCount = recommendations.filter((r) => r.done).length
  const progressPct = total > 0 ? Math.round((doneCount / total) * 100) : 0

  const notify = (msg: string, isError = false) => {
    if (isError) {
      setErrorMessage(msg)
      setTimeout(() => setErrorMessage(null), 4000)
    } else {
      setActionMessage(msg)
      setTimeout(() => setActionMessage(null), 4000)
    }
  }

  const handleAction = async (id: string) => {
    const r = recommendations.find((r) => r.id === id)
    if (!r || busyId) return

    // Ações manuais: apenas marcar como resolvida após confirmação.
    if (r.kind === "tip") {
      toggleDone(id)
      notify(`"${r.title}" — guarda esta dica antes de continuar.`)
      return
    }

    if (!window.electronAPI) {
      notify("Motor de proteção indisponível — execute a app a partir do ambiente de trabalho.", true)
      return
    }

    setBusyId(id)
    try {
      switch (id) {
        case "firewall": {
          const health = await window.electronAPI.getWindowsHealth()
          const firewall = health?.firewall
          if (firewall?.enabled) {
            toggleDone(id)
            notify("Firewall do Windows ativo. Nenhuma ação necessária.")
          } else if (firewall && firewall.enabled === false) {
            notify("O firewall do Windows está desativado. Ativa-o em Definições → Privacidade e Segurança → Segurança do Windows.", true)
          } else {
            notify("Não foi possível consultar o estado do firewall a partir do serviço.", true)
          }
          break
        }
        case "update":
        case "scanner-run": {
          const res = await window.electronAPI.updateDefinitions()
          if (res?.success) {
            toggleDone(id)
            notify("Definições de ameaças atualizadas com sucesso.")
          } else {
            notify("Falha ao atualizar definições.", true)
          }
          break
        }
        case "disk-cleanup": {
          const res = await window.electronAPI.startScan("full")
          if (res?.success) {
            notify("Análise Profunda do Computador iniciada. Acompanha o progresso em Análise de Segurança.")
          } else {
            notify("Não foi possível iniciar a Análise Profunda do Computador. Pode já existir uma análise em curso.", true)
          }
          break
        }
        case "temp-files": {
          const health = await window.electronAPI.getWindowsHealth()
          if (health) {
            toggleDone(id)
            notify(`Saúde do Windows: ${health.overallStatus} (score ${health.score}). ${health.recommendations.length} recomendação(ões).`)
          } else {
            notify("Não foi possível consultar a saúde do Windows.", true)
          }
          break
        }
        default:
          toggleDone(id)
          notify(`"${r.title}" concluído.`)
      }
    } catch (err: unknown) {
      notify("Erro ao executar: " + (err instanceof Error ? err.message : String(err)), true)
    } finally {
      setBusyId(null)
    }
  }

  const priorityColor: Record<Priority, string> = {
    high: "text-red-400 bg-red-500/10 border-red-500/20",
    medium: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    low: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  }

  const priorityLabel: Record<Priority, string> = {
    high: "Crítico",
    medium: "Importante",
    low: "Sugestão",
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground font-mono uppercase tracking-tight">
            Otimizar Sistema
          </h1>
          <p className="text-xs text-muted-foreground font-mono mt-1">
            Recomendações de segurança e performance para o seu computador
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold font-mono text-primary">
            {progressPct}%
          </div>
          <p className="text-[10px] text-muted-foreground font-mono">
            {doneCount} de {total} concluídos
          </p>
        </div>
      </div>

      {actionMessage && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="flex items-center gap-2 p-3 rounded-xl bg-cyber-green/10 border border-cyber-green/30 text-cyber-green text-xs font-mono"
        >
          <CheckCircle className="w-4 h-4" />
          {actionMessage}
        </motion.div>
      )}

      {errorMessage && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="flex items-center gap-2 p-3 rounded-xl bg-cyber-red/10 border border-cyber-red/30 text-cyber-red text-xs font-mono"
        >
          <AlertTriangle className="w-4 h-4" />
          {errorMessage}
        </motion.div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Críticos", value: highCount, color: "text-red-400", bg: "bg-red-500/10" },
          { label: "Importantes", value: mediumCount, color: "text-amber-400", bg: "bg-amber-500/10" },
          { label: "Sugestões", value: lowCount, color: "text-emerald-400", bg: "bg-emerald-500/10" },
          { label: "Progresso", value: `${progressPct}%`, color: "text-primary", bg: "bg-primary/10" },
        ].map((s) => (
          <div
            key={s.label}
            className={cn("p-3 rounded-xl border border-white/5", s.bg)}
          >
            <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
              {s.label}
            </p>
            <p className={cn("text-lg font-bold font-mono mt-1", s.color)}>
              {s.value}
            </p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {recommendations.map((rec) => {
          const Icon = rec.icon
          return (
            <motion.div
              key={rec.id}
              whileHover={{ scale: 1.01 }}
              className={cn(
                "p-4 rounded-2xl border transition-all duration-300",
                rec.done
                  ? "bg-cyber-green/5 border-cyber-green/20 opacity-70"
                  : "bg-card/60 border-white/5 hover:border-primary/30 cyber-border"
              )}
            >
              <div className="flex items-start gap-3">
                <div
                  className={cn(
                    "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0",
                    rec.done
                      ? "bg-cyber-green/20 text-cyber-green"
                      : "bg-primary/10 text-primary"
                  )}
                >
                  {rec.done ? (
                    <CheckCircle className="w-5 h-5" />
                  ) : (
                    <Icon className="w-5 h-5" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3
                      className={cn(
                        "text-sm font-bold font-mono",
                        rec.done ? "line-through text-muted-foreground" : "text-foreground"
                      )}
                    >
                      {rec.title}
                    </h3>
                    <span
                      className={cn(
                        "text-[9px] font-mono px-1.5 py-0.5 rounded-full border",
                        priorityColor[rec.priority]
                      )}
                    >
                      {priorityLabel[rec.priority]}
                    </span>
                    <span className="text-[9px] font-mono text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded-full">
                      {rec.category}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed mt-1">
                    {rec.description}
                  </p>
                </div>
                {!rec.done && (
                  <button
                    onClick={() => handleAction(rec.id)}
                    disabled={busyId !== null}
                    className="flex-shrink-0 px-3 py-1.5 text-[10px] font-mono font-bold uppercase tracking-wider text-primary bg-primary/10 border border-primary/20 rounded-lg hover:bg-primary/20 transition-all disabled:opacity-50 flex items-center gap-1"
                  >
                    {busyId === rec.id ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        A executar...
                      </>
                    ) : (
                      rec.action || "Concluir"
                    )}
                  </button>
                )}
              </div>
            </motion.div>
          )
        })}
      </div>

      {hardware && (
        <div className="p-4 rounded-2xl border border-white/5 bg-card/40">
          <div className="flex items-center gap-2 mb-3">
            <Info className="w-4 h-4 text-primary" />
            <h3 className="text-xs font-bold font-mono text-foreground uppercase tracking-wider">
              Estado do Sistema
            </h3>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-[10px] text-muted-foreground font-mono">CPU</p>
              <p className="text-sm font-bold font-mono text-foreground">
                {hardware.cpu.usage != null ? `${hardware.cpu.usage.toFixed(1)}%` : "N/A"}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground font-mono">RAM</p>
              <p className="text-sm font-bold font-mono text-foreground">
                {hardware.ram.usagePercent != null ? `${hardware.ram.usagePercent.toFixed(1)}%` : "N/A"}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground font-mono">Disco</p>
              <p className="text-sm font-bold font-mono text-foreground">
                {hardware.disk.usagePercent != null ? `${hardware.disk.usagePercent.toFixed(1)}%` : "N/A"}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}