import { AlertTriangle, Shield, Search, ChevronDown, Clock, Trash2, XCircle, AlertCircle, Globe, FileCode, Archive } from "lucide-react"
import { useState } from "react"
import type { QuarantineEntry, ThreatEvent } from "@cybersafe/shared-types"
import { cn } from "@/lib/utils"
import { classifyThreatOrigin } from "@/lib/threatOrigins"
import { withDeadline } from "@/lib/deadline"
import QuarantinePage from "./QuarantinePage"

interface ThreatsPageProps {
  events: ThreatEvent[]
  onClear: () => void
  isClearing: boolean
  /**
   * Quarentena dentro de Ameaças (Fase A): a lista real de entradas isoladas
   * entra por aqui e ganha a segunda aba. Omitida, a pagina comporta-se como
   * antes — apenas Deteções, sem barra de abas. A Quarentena NAO e mais uma
   * entrada no menu nem uma rota propria: e um estado deste dominio.
   */
  quarantine?: QuarantineEntry[]
  /** Recarrega as entradas apos uma acao confirmada pelo servico. */
  onQuarantineChanged?: () => void | Promise<void>
  /** Deep links antigos (tray `quarantine`) aterravam na aba de quarentena. */
  initialTab?: "detecoes" | "quarantine"
  /** Politica EFETIVA de quarentena reportada pelo servico (P0-3, 15/10). */
  quarantinePolicy?: unknown
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i

/**
 * RECOVERY-SECURITY-20261014 (manual quarantine): so uma detecao com alvo no
 * disco e digest verificavel pode ser isolada a mao. Sem digest nao ha
 * identidade — e o backend rejeita o legado pedindo reanalise; a UI nao
 * oferece o botao a quem nao o pode usar. Nada aqui age automaticamente.
 */
export function canQuarantineManually(threat: ThreatEvent): boolean {
  return !!threat.filePath
    && typeof threat.sha256 === "string"
    && SHA256_PATTERN.test(threat.sha256)
    && threat.action !== "quarantined"
}

export function buildQuarantineConfirmation(threat: ThreatEvent): { fileName: string; sha256: string; filePath: string } {
  const filePath = threat.filePath ?? ""
  return {
    fileName: filePath.split(/[\\/]/).pop() || filePath,
    sha256: threat.sha256 ?? "",
    filePath,
  }
}

// Guarda de voo partilhada: dois cliques rapidos (ou duas paginas vivas) nao
// disparam dois submits do mesmo pedido manual.
let quarantineInFlight = false

/**
 * Rede de seguranca do bridge: `ipcRenderer.invoke` nao tem deadline proprio e
 * o service-client reconecta ate 30 vezes sem tempo maximo por pedido — a
 * promessa pode nunca resolver. 30 s e o teto documentado do pedido manual:
 * depois dele a unica frase honesta e "ainda nao confirmado"; NUNCA se infere
 * sucesso nem falha fisica. Um sucesso tardio e ignorado de proposito — o
 * estado real ve-se na propria lista da quarentena apos recarregar.
 */
export const MANUAL_QUARANTINE_DEADLINE_MS = 30_000

export function requestManualQuarantine(opts: {
  threat: ThreatEvent
  /**
   * Identidade confirmada (RECOVERY-SECURITY): o digest da deteção clicada
   * segue no pedido; o backend recusa se os bytes atuais no caminho forem
   * outros. Nao ha quarentena por path cego.
   */
  call: (id: string, action: "quarantine", expectedSha256: string) => Promise<{ success: boolean; error?: string }>
  onAlert?: (message: string) => void
  onReload?: () => void
  onSettled?: () => void
  timeoutMs?: number
}): boolean {
  if (!canQuarantineManually(opts.threat)) return false
  if (quarantineInFlight) return false
  quarantineInFlight = true
  const release = () => {
    quarantineInFlight = false
    opts.onSettled?.()
  }
  let pending: Promise<{ kind: "result"; result: { success: boolean; error?: string } } | { kind: "bridgeError"; error: unknown }>
  try {
    pending = opts.call(opts.threat.filePath ?? "", "quarantine", opts.threat.sha256 ?? "").then(
      (result) => ({ kind: "result" as const, result }),
      (error) => ({ kind: "bridgeError" as const, error }),
    )
  } catch (err) {
    release()
    opts.onAlert?.(`Falha de comunicação com o serviço: ${err instanceof Error ? err.message : String(err)}; isolamento não confirmado.`)
    return true
  }
  void withDeadline(pending, opts.timeoutMs ?? MANUAL_QUARANTINE_DEADLINE_MS).then((outcome) => {
    release()
    if (outcome.kind === "timeout") {
      opts.onAlert?.("Operação ainda não confirmada; consulte a quarentena e o histórico antes de repetir.")
      return
    }
    if (outcome.kind === "error") {
      opts.onAlert?.(`Falha de comunicação com o serviço; isolamento não confirmado.`)
      return
    }
    const settledPromise = outcome.value
    if (settledPromise.kind === "bridgeError") {
      const err = settledPromise.error
      opts.onAlert?.(`Falha de comunicação com o serviço: ${err instanceof Error ? err.message : String(err)}; isolamento não confirmado.`)
      return
    }
    const result = settledPromise.result
    if (result?.success === true) {
      // So o sucesso do servico recarrega; nunca o "vamos ver".
      opts.onReload?.()
    } else {
      const reason = typeof result?.error === "string" && result.error.length > 0
        ? result.error
        : "O serviço não devolveu confirmação"
      opts.onAlert?.(`${reason}; isolamento não confirmado.`)
    }
  })
  return true
}

export default function ThreatsPage({ events, onClear, isClearing, quarantine, onQuarantineChanged, initialTab, quarantinePolicy }: ThreatsPageProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [filterSeverity, setFilterSeverity] = useState("all")
  const [showConfirmClear, setShowConfirmClear] = useState(false)
  const [tab, setTab] = useState<"detecoes" | "quarantine">(initialTab ?? "detecoes")
  const hasQuarantineTab = quarantine !== undefined
  const [quarantineConfirm, setQuarantineConfirm] = useState<ThreatEvent | null>(null)
  const [quarantineAlert, setQuarantineAlert] = useState<string | null>(null)
  const [quarantineNotice, setQuarantineNotice] = useState<string | null>(null)
  const [quarantineBusy, setQuarantineBusy] = useState(false)

  const filteredThreats = events.filter(threat => {
    const matchesSearch = threat.domain.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          threat.url.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesSeverity = filterSeverity === "all" || threat.severity === filterSeverity
    return matchesSearch && matchesSeverity
  })

  const formatTime = (iso: string) => {
    try {
        return new Date(iso).toLocaleString("pt-PT", {
            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
        })
    } catch { return iso }
  }

  const getSeverityColor = (severity: string) => {
    // Verde está reservado a "verificado limpo": nenhuma ameaça, nem "Baixa",
    // se pinta de cyber-green. Baixa = neutra; Média = âmbar; Alta/ Crítica = vermelho.
    switch (severity) {
      case "critical": return "text-cyber-red bg-cyber-red/10 border-cyber-red/30"
      case "high": return "text-cyber-red bg-cyber-red/10 border-cyber-red/30"
      case "medium": return "text-cyber-yellow bg-cyber-yellow/10 border-cyber-yellow/30"
      default: return "text-muted-foreground bg-muted/40 border-border"
    }
  }

  const getStatusIcon = (severity: string) => {
    switch (severity) {
      case "critical": return <XCircle className="w-5 h-5 text-cyber-red" />
      case "high": return <AlertCircle className="w-5 h-5 text-cyber-red" />
      case "medium": return <AlertCircle className="w-5 h-5 text-cyber-yellow" />
      default: return <AlertCircle className="w-5 h-5 text-muted-foreground" />
    }
  }

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">
            Ameaças <span className="text-primary">{tab === "quarantine" ? "— Quarentena" : "Detetadas"}</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {tab === "quarantine"
              ? "Registos da quarentena. O isolamento só é afirmado quando confirmado; restaurar ou eliminar é permanente."
              : "Histórico de ameaças identificadas e bloqueadas"}
          </p>
        </div>
        
        {tab === "detecoes" && (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-4 py-2 bg-secondary rounded-lg">
            <span className="text-sm font-mono text-muted-foreground">Total:</span>
            <span className="text-sm font-mono text-foreground font-bold">{events.length}</span>          </div>
          <button 
            onClick={() => setShowConfirmClear(true)}
            disabled={isClearing || events.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-destructive/10 border border-destructive/30 text-destructive font-mono text-xs rounded-lg hover:bg-destructive/20 transition-all disabled:opacity-50"
          >
            <Trash2 className="w-3 h-3" />
            {isClearing ? "LIMPANDO..." : "LIMPAR LOGS"}
          </button>
        </div>
        )}
      </div>

      {/* Abas do dominio: Detecoes e Quarentena sao dois factos separados —
          uma quarentena que termina nao e uma deteccao nova, e os contadores
          nunca se somam. */}
      {hasQuarantineTab && (
        <div role="tablist" aria-label="Secções de Ameaças" className="flex gap-1 border-b border-border">
          <button
            role="tab"
            aria-selected={tab === "detecoes"}
            onClick={() => setTab("detecoes")}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-mono border-b-2 -mb-px transition-colors",
              tab === "detecoes"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <AlertTriangle className="w-4 h-4" />
            Deteções
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{events.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === "quarantine"}
            onClick={() => setTab("quarantine")}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-mono border-b-2 -mb-px transition-colors",
              tab === "quarantine"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Archive className="w-4 h-4" />
            Quarentena
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{quarantine.length}</span>
          </button>
        </div>
      )}

      {tab === "quarantine" && hasQuarantineTab ? (
        <QuarantinePage
          embedded
          entries={quarantine}
          onChanged={onQuarantineChanged ?? (async () => {})}
          quarantinePolicy={quarantinePolicy}
        />
      ) : (
      <>
      {/* Confirmacao visivel SO com resultado true do servico. Nao apaga o
          alerta anterior — as duas verdades ficam na tela ate ao proximo
          pedido. */}
      {quarantineNotice && (
        <div className="cyber-border rounded-xl border-cyber-green/40 bg-cyber-green/10 px-4 py-3 flex items-start gap-2 text-xs font-mono text-cyber-green">
          <Shield className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">{quarantineNotice}</span>
          <button
            onClick={() => setQuarantineNotice(null)}
            className="text-cyber-green/80 hover:text-cyber-green underline underline-offset-2"
          >
            Fechar
          </button>
        </div>
      )}

      {/* Alerta de acao manual NAO confirmada: mantem-se ate a proxima acao —
          o oposto de fingir sucesso. */}
      {quarantineAlert && (
        <div className="cyber-border rounded-xl border-destructive/40 bg-destructive/10 px-4 py-3 flex items-start gap-2 text-xs font-mono text-destructive">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">{quarantineAlert}</span>
          <button
            onClick={() => setQuarantineAlert(null)}
            className="text-destructive/80 hover:text-destructive underline underline-offset-2"
          >
            Fechar
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-4">
        <div className="flex-1 relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Pesquisar ameaças..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-secondary border border-border rounded-lg pl-11 pr-4 py-3 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all"
          />
        </div>
        
        <div className="relative">
          <select
            value={filterSeverity}
            onChange={(e) => setFilterSeverity(e.target.value)}
            className="appearance-none bg-secondary border border-border rounded-lg px-4 py-3 pr-10 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary cursor-pointer"
          >
            <option value="all">Todas</option>
            <option value="critical">Crítica</option>
            <option value="high">Alta</option>
            <option value="medium">Média</option>
            <option value="low">Baixa</option>
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        </div>
      </div>

      {/* Threats List */}
      <div className="space-y-4">
        {filteredThreats.length > 0 ? (
          filteredThreats.map((threat, idx) => (
            <div
              key={idx}
              className="cyber-border rounded-xl p-6 hover:border-primary/50 transition-all group"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className={cn(
                      "w-10 h-10 rounded-lg flex items-center justify-center border",
                      threat.severity === 'critical' || threat.severity === 'high' ? "bg-cyber-red/10 border-cyber-red/30" :
                      threat.severity === 'medium' ? "bg-cyber-yellow/10 border-cyber-yellow/30" :
                      "bg-muted/40 border-border"
                  )}>
                    {getStatusIcon(threat.severity)}
                  </div>
                  
                  <div>
                    <h3 className="font-mono font-semibold text-foreground group-hover:text-primary transition-colors">
                        {threat.domain}
                    </h3>
                    <p className="text-xs font-mono text-muted-foreground mt-1 truncate max-w-md">
                      {threat.url}
                    </p>
                    
                    <div className="flex items-center gap-3 mt-3">
                      <span className={`px-2 py-1 rounded text-xs font-mono border ${getSeverityColor(threat.severity)}`}>
                        {threat.severity === "critical" ? "Crítica" : threat.severity === "high" ? "Alta" : threat.severity === "medium" ? "Média" : "Baixa"}
                      </span>
                      {threat.rulesTriggered.map(rule => (
                        <span key={rule} className="px-2 py-1 rounded text-xs font-mono bg-secondary text-muted-foreground">
                           {rule}
                        </span>
                      ))}
                      {threat.rulesTriggered.length === 0 && (
                          <span className="px-2 py-1 rounded text-xs font-mono bg-cyber-green/5 text-cyber-green border border-cyber-green/20">
                            Aprovação Procedural
                          </span>
                      )}
                    </div>
                  </div>
                </div>
                
                <div className="flex flex-col items-end gap-2">
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <span className="text-muted-foreground">Confiança:</span>
                    <span className="text-foreground font-bold">{Math.round(threat.confidence * 100)}%</span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground font-mono">
                    <Clock className="w-3 h-3" />
                    <span>{formatTime(threat.createdAt)}</span>
                  </div>
                  {canQuarantineManually(threat) ? (
                    <button
                      onClick={() => { setQuarantineAlert(null); setQuarantineConfirm(threat) }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono rounded-lg border border-border hover:border-primary hover:text-primary transition-colors"
                    >
                      <Archive className="w-3.5 h-3.5" /> Colocar em quarentena…
                    </button>
                  ) : threat.action === "quarantined" ? (
                    <span className="text-xs font-mono text-muted-foreground border border-border rounded px-2 py-1">Em quarentena</span>
                  ) : null}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="cyber-border rounded-xl p-12 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center mb-4">
              <Shield className="w-8 h-8 text-primary" />
            </div>
            <p className="text-muted-foreground text-sm">
              Nenhuma ameaça encontrada com os filtros atuais.
            </p>
          </div>
        )}
      </div>

      {/* Stats Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
        <div className="cyber-border rounded-xl p-6 text-center">
          <div className="flex items-center justify-center mb-3">
            <Shield className="w-5 h-5 text-primary" />
          </div>
          <div className="text-3xl font-bold font-mono text-foreground mb-2">
            {events.length}
          </div>
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            Ameaças Totais
          </div>
        </div>

        <div className="cyber-border rounded-xl p-6 text-center">
          <div className="flex items-center justify-center mb-3">
            <AlertTriangle className="w-5 h-5 text-cyber-red" />
          </div>
          <div className="text-3xl font-bold font-mono text-cyber-red mb-2">
            {events.filter(e => e.severity === 'high' || e.severity === 'critical').length}
          </div>
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            Alta Severidade
          </div>
        </div>

        <div className="cyber-border rounded-xl p-6 text-center">
          <div className="flex items-center justify-center mb-3">
            <Globe className="w-5 h-5 text-cyber-cyan" />
          </div>
          <div className="text-3xl font-bold font-mono text-cyber-cyan mb-2">
            {events.filter(e => classifyThreatOrigin(e.source) === 'web').length}
          </div>
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            Origens Web
          </div>
        </div>

        <div className="cyber-border rounded-xl p-6 text-center">
          <div className="flex items-center justify-center mb-3">
            <FileCode className="w-5 h-5 text-cyber-yellow" />
          </div>
          <div className="text-3xl font-bold font-mono text-cyber-yellow mb-2">
            {events.filter(e => classifyThreatOrigin(e.source) === 'local').length}
          </div>
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            Origens Locais
          </div>
        </div>
      </div>
      </>
      )}

      {/* Confirmacao de quarentena manual: nome, digest e caminho antes de
          UM unico submit; sem acao automatica. */}
      {quarantineConfirm && (() => {
        const c = buildQuarantineConfirmation(quarantineConfirm)
        return (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Confirmar quarentena">
          <div className="w-full max-w-md cyber-border border-cyber-red/40 bg-card rounded-2xl shadow-lg p-6 relative overflow-hidden">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-cyber-red/15 border border-cyber-red/30 flex items-center justify-center flex-shrink-0">
                <Archive className="w-6 h-6 text-cyber-red" />
              </div>
              <div>
                <h2 className="text-sm font-bold font-mono text-foreground uppercase tracking-wide">Confirmar quarentena</h2>
                <p className="text-xs text-muted-foreground mt-1">O ficheiro sai do local atual para a quarentena do CyberSafe. Nada acontece até confirmares.</p>
              </div>
            </div>
            <dl className="mt-4 space-y-2 text-[11px] font-mono">
              <div>
                <dt className="text-muted-foreground">Ficheiro</dt>
                <dd className="text-foreground break-all">{c.fileName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Caminho</dt>
                <dd className="text-foreground break-all">{c.filePath}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">SHA-256</dt>
                <dd className="text-foreground break-all">{c.sha256}</dd>
              </div>
            </dl>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setQuarantineConfirm(null)}
                className="flex-1 px-4 py-2.5 text-xs font-mono font-bold text-muted-foreground bg-secondary border border-border rounded-lg hover:text-foreground transition-all"
              >
                Cancelar
              </button>
              <button
                disabled={quarantineBusy}
                onClick={() => {
                  setQuarantineBusy(true)
                  requestManualQuarantine({
                    threat: quarantineConfirm,
                    call: (id, action, expectedSha256) => window.electronAPI!.threatAction(id, action, expectedSha256),
                    onAlert: (m) => { setQuarantineAlert(m); setQuarantineConfirm(null) },
                    onReload: () => {
                      setQuarantineConfirm(null)
                      setQuarantineNotice("Quarentena confirmada pelo serviço.")
                      void onQuarantineChanged?.()
                    },
                    onSettled: () => setQuarantineBusy(false),
                  })
                }}
                className="flex-1 px-4 py-2.5 text-xs font-mono font-bold text-white bg-cyber-red rounded-lg hover:bg-cyber-red/80 transition-all disabled:opacity-50"
              >
                {quarantineBusy ? "A ISOLAR..." : "Confirmar"}
              </button>
            </div>
          </div>
        </div>
        )
      })()}

      {/* Clear Confirmation Modal */}
      {showConfirmClear && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
          <div className="w-full max-w-sm cyber-border border-destructive/40 bg-card rounded-2xl shadow-lg p-6 relative overflow-hidden">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-destructive/15 border border-destructive/30 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-6 h-6 text-destructive" />
              </div>
              <div>
                <h2 className="text-sm font-bold font-mono text-foreground uppercase tracking-wide">
                  Limpar Logs?
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Esta ação irá apagar permanentemente o histórico de {events.length} ameaça(s) registadas.
                </p>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowConfirmClear(false)}
                className="flex-1 px-4 py-2.5 text-xs font-mono font-bold text-muted-foreground bg-secondary border border-border rounded-lg hover:text-foreground transition-all"
              >
                Cancelar
              </button>
              <button
                onClick={() => { setShowConfirmClear(false); onClear() }}
                disabled={isClearing}
                className="flex-1 px-4 py-2.5 text-xs font-mono font-bold text-white bg-destructive rounded-lg hover:bg-destructive/80 transition-all disabled:opacity-50"
              >
                {isClearing ? "A LIMPAR..." : "Sim, Limpar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
