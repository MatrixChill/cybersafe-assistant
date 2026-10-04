import { Upload, File, Folder, ShieldAlert, Zap, X, Clock, Activity, AlertTriangle, RotateCw, Search, Play, FileSearch } from "lucide-react"
import { useState, useCallback, useRef, useEffect } from "react"
import { cn } from "@/lib/utils"
import { isAppShuttingDown, onAppShutdown } from "@/lib/shutdownState"
import type { ScanState, ScanType } from "@cybersafe/shared-types"
import { MatrixAvatar } from "../components/MatrixAvatar"
import {
  NO_DETECTIONS_NOTE,
  SCAN_ACTION_CARDS,
  SCAN_HYDRATING_DETAIL,
  SCAN_HYDRATING_TITLE,
  SCAN_RESULT_LABELS,
  SCAN_STALL_MS,
  ZIP_CONTENT_NOTE,
  activeScanDetail,
  cancelButtonState,
  decideScanRecovery,
  activeScanTitle,
  buildResultSummary,
  decideScanEvent,
  filesExcludedFooterLabel,
  filesFailedFooterLabel,
  formatEta,
  formatScanDurationLabel,
  isActiveUiStatus,
  isTerminalScanStatus,
  isTerminalUiStatus,
  mergeScanState,
  noDetectionsTone,
  normalizeScanState,
  normalizeScanType,
  resultFilesWithoutDetections,
  resultFilesWithoutDetectionsNote,
  resultFollowUpNote,
  scanElapsedSeconds,
  scanEtaSeconds,
  scanProgressPercent,
  scanRateLabel,
  scanScopeFor,
  scopeTitle,
  showNoThreatsReassurance,
  shouldAcceptScanState,
  shouldShowHydration,
  terminalScanLogMessage,
  uiStatusForState,
  type ScanIntentKind,
  type ScanScope,
  type ScanUiStatus,
} from "@/lib/scanSession"

const DEV = import.meta.env?.DEV === true

/** Logs de diagnóstico concisos e apenas em desenvolvimento. */
function devLog(message: string, extra?: unknown) {
  if (!DEV) return
  if (extra === undefined) console.debug(`[ScanUI] ${message}`)
  else console.debug(`[ScanUI] ${message}`, extra)
}

function logStamp(): string {
  return `[${new Date().toLocaleTimeString()}]`
}

function targetNameOf(state: ScanState | null): string | undefined {
  if (!state?.targetPath) return undefined
  const parts = state.targetPath.split(/[/\\]/)
  return parts[parts.length - 1] || undefined
}

const ACTION_ICON: Record<ScanIntentKind, typeof Search> = {
  quick: Search,
  full: Play,
  file: File,
  folder: Folder,
}

const ACTION_COLOR: Record<ScanIntentKind, string> = {
  quick: "bg-cyber-cyan/10 text-cyber-cyan border-cyber-cyan/30",
  full: "bg-cyber-magenta/10 text-cyber-magenta border-cyber-magenta/30",
  file: "bg-primary/10 text-primary border-primary/30",
  folder: "bg-primary/10 text-primary border-primary/30",
}

interface FileScannerPageProps {
  pendingScan?: { type: string; targetPath?: string } | null;
  onScanConsumed?: () => void;
}

export default function FileScannerPage({ pendingScan, onScanConsumed }: FileScannerPageProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState("")

  const [uiStatus, setUiStatus] = useState<ScanUiStatus>("idle")
  const [activeScanId, setActiveScanId] = useState<string | null>(null)
  const [scanType, setScanType] = useState<string>("")
  const [scanProgress, setScanProgress] = useState<ScanState | null>(null)
  const [scanLog, setScanLog] = useState<string[]>([])
  const [stalled, setStalled] = useState(false)
  /**
   * Pedido de cancelamento já enviado e ainda não confirmado por um evento
   * terminal do motor. Enquanto verdadeiro o botão deixa de oferecer o que
   * já aconteceu — um segundo clique só reenviaria o mesmo cancelamento.
   */
  const [cancelRequested, setCancelRequested] = useState(false)
  /**
   * Só é verdadeiro depois de uma sessão VIVA ter sido comprovada, nunca por
   * omissão. Antes vinha `true` desde o mount, e isso prometia no ecrã
   * "A recuperar análise em curso" em cada abertura do CyberSafe — sem análise
   * nenhuma para recuperar, durante todo o tempo que o `getActiveScan`
   * demorasse a responder. Sem prova, o scanner abre em IDLE.
   */
  const [hydrating, setHydrating] = useState(false)
  /** Sessão comprovada a recuperar, ou null enquanto não houver prova. */
  const [recovering, setRecovering] = useState<ScanState | null>(null)

  /** Ref = verdade síncrona usada pelos callbacks (nunca espera por render). */
  const expectedScanIdRef = useRef<string | null>(null)
  const activeScanIdRef = useRef<string | null>(null)
  /** Estado mais recente aplicado — verdade síncrona para monotonicidade. */
  const scanProgressRef = useRef<ScanState | null>(null)
  /** O que o utilizador escolheu (usado só até o serviço confirmar o alvo). */
  const intentRef = useRef<ScanIntentKind | null>(null)
  /** Eventos que chegam antes da resposta de `startScan` (start → evento → resposta). */
  const earlyEventsRef = useRef<Map<string, ScanState>>(new Map())
  /** Última mensagem aceite do motor — base do watchdog. */
  const lastMessageAtRef = useRef(0)
  const launchLockRef = useRef(false)
  const pendingScanConsumedRef = useRef(false)
  const mountedRef = useRef(true)

  // ── Aplica um estado vindo do motor (evento ou snapshot de ressincronização) ──
  const applyScanState = useCallback((next: ScanState, source: "event" | "snapshot") => {
    const current = scanProgressRef.current
    if (!shouldAcceptScanState(current, next)) {
      // Estado atrasado (revisão inferior) ou reabertura de um scan terminal:
      // ignorado para os contadores nunca recuarem.
      devLog(`ignored stale state expectedRev=${current?.revision ?? "-"} receivedRev=${next.revision ?? "-"} status=${next.status}`)
      return
    }
    const merged = mergeScanState(current, next)
    scanProgressRef.current = merged
    lastMessageAtRef.current = Date.now()
    setStalled(false)
    setScanProgress(merged)

    const nextStatus = uiStatusForState(merged)
    setUiStatus(prev => {
      // Um evento atrasado nunca reabre um scan já terminado.
      if (isTerminalUiStatus(prev) && !isTerminalUiStatus(nextStatus)) return prev
      return nextStatus
    })

    if (isTerminalScanStatus(merged.status)) {
      setScanLog(prev => [...prev, `${logStamp()} ${terminalScanLogMessage(merged)}`])
      return
    }

    if (source === "snapshot") {
      devLog("state resynced from snapshot", { id: merged.id, status: merged.status, phase: merged.phase })
    }
  }, [])

  // ── Subscrição global: registada UMA vez, antes de qualquer scan existir ──
  useEffect(() => {
    mountedRef.current = true
    lastMessageAtRef.current = Date.now()

    const api = window.electronAPI
    if (!api) return

    const unsubscribe = api.onScanProgress((raw: unknown) => {
      const state = normalizeScanState(raw)
      if (!state) {
        devLog("ignored malformed event", raw)
        return
      }

      const decision = decideScanEvent(state, expectedScanIdRef.current)
      if (decision === "buffer") {
        const buffer = earlyEventsRef.current
        buffer.set(state.id, state)
        if (buffer.size > 4) {
          const oldest = buffer.keys().next().value
          if (oldest) buffer.delete(oldest)
        }
        devLog(`buffered early event expected=none received=${state.id} status=${state.status} phase=${state.phase}`)
        return
      }
      if (decision === "ignore") {
        devLog(`ignored event expected=${expectedScanIdRef.current} received=${state.id}`)
        return
      }

      devLog(`accepted event id=${state.id} status=${state.status} phase=${state.phase} progress=${state.progress} files=${state.filesScanned}`)
      applyScanState(state, "event")
    })

    return () => {
      mountedRef.current = false
      devLog("listener cleanup")
      unsubscribe?.()
    }
  }, [applyScanState])

  // ── Ressincronização ao montar (voltar à página a meio de um scan) ──
  useEffect(() => {
    const api = window.electronAPI
    if (!api || typeof api.getActiveScan !== "function") {
      devLog("snapshot API unavailable — resync disabled")
      // Sem API não há nada a recuperar: mostra o estado inicial de imediato.
      setHydrating(false)
      return
    }

    let cancelled = false
    void (async () => {
      try {
        // A DECISÃO é de uma só porta: terminal, `idle`, sem id ou sem dados
        // devolvem null e o scanner fica em IDLE. Só uma sessão viva e
        // comprovada abre a recuperação.
        const recovery = decideScanRecovery(await api.getActiveScan())
        if (cancelled || !mountedRef.current) return
        if (!recovery) {
          devLog("resync: no resumable scan — staying idle")
          return
        }
        if (expectedScanIdRef.current) {
          devLog("resync skipped: a launch is already in flight")
          return
        }

        devLog(`resync: attached to running scan id=${recovery.id} phase=${recovery.phase}`)
        setRecovering(recovery)
        setHydrating(true)
        expectedScanIdRef.current = recovery.id
        activeScanIdRef.current = recovery.id
        setActiveScanId(recovery.id)
        setScanType(recovery.type)
        setScanLog([`${logStamp()} Análise em curso retomada do motor`])
        applyScanState(recovery, "snapshot")
      } catch (err) {
        devLog("resync failed", err)
      } finally {
        // Sem sessão comprovada nunca houve o que recuperar: o estado inicial
        // está livre desde o início e este caminho não volta a escondê-lo.
        if (!cancelled && mountedRef.current) setHydrating(false)
      }
    })()

    return () => { cancelled = true }
  }, [applyScanState])

  // ── Watchdog: fallback de UI, nunca a correção principal ──
  const handleVerify = useCallback(async () => {
    const api = window.electronAPI
    try {
      const snapshot = normalizeScanState(await api?.getActiveScan?.())
      if (snapshot && snapshot.id === expectedScanIdRef.current) {
        applyScanState(snapshot, "snapshot")
        return
      }
      devLog("verify: engine no longer reports this scan", { id: expectedScanIdRef.current })
      setStalled(false)
      const engineGoneError = "O motor de análise deixou de responder. Tente novamente."
      const failedState: ScanState = scanProgressRef.current
        ? { ...scanProgressRef.current, status: "failed", error: engineGoneError }
        : {
            id: expectedScanIdRef.current ?? "unknown",
            type: normalizeScanType(scanType),
            status: "failed",
            progress: 0,
            filesScanned: 0,
            threatsFound: 0,
            error: engineGoneError,
          }
      scanProgressRef.current = failedState
      setScanProgress(failedState)
      setUiStatus("failed")
    } catch (err) {
      devLog("verify failed", err)
      setStalled(true)
    }
  }, [applyScanState, scanType])

  useEffect(() => {
    if (!isActiveUiStatus(uiStatus)) return
    const interval = setInterval(() => {
      // No shutdown o resync deixa de fazer sentido (o serviço já está a sair).
      if (isAppShuttingDown()) return
      if (launchLockRef.current) return
      if (Date.now() - lastMessageAtRef.current < SCAN_STALL_MS) return
      devLog("watchdog: no messages from engine, attempting resync")
      void handleVerify()
    }, 5000)
    const stopOnShutdown = onAppShutdown(() => clearInterval(interval))
    return () => {
      stopOnShutdown()
      clearInterval(interval)
    }
  }, [uiStatus, handleVerify])

  // ── Lançamento de scan (usado por todos os botões e pelo drag&drop) ──
  const launchScan = useCallback(async (
    type: string,
    targetPath: string | undefined,
    label: string,
    intent: ScanIntentKind,
  ) => {
    if (launchLockRef.current) return
    const api = window.electronAPI
    if (!api) {
      setError("Execute a app a partir do ambiente de trabalho.")
      return
    }

    launchLockRef.current = true
    intentRef.current = intent
    lastMessageAtRef.current = Date.now()
    setUiStatus("preparing")
    setScanType(type)
    setScanLog([`${logStamp()} ${label}`])
    setScanProgress(null)
    scanProgressRef.current = null
    setError("")
    setStalled(false)
    setCancelRequested(false)
    devLog(`launch requested type=${type} intent=${intent} target=${targetPath ?? ""}`)

    try {
      const result = await api.startScan(type as ScanType, targetPath)
      if (!mountedRef.current) return

      const id = result?.id
      if (!result?.success || !id) {
        devLog("launch rejected", result)
        setUiStatus("idle")
        setError(result?.error || "Não foi possível iniciar a análise.")
        return
      }

      devLog(`start response id=${id}`)
      expectedScanIdRef.current = id
      activeScanIdRef.current = id
      setActiveScanId(id)

      // O motor pode ter emitido progresso antes desta resposta — aplica-o já.
      const early = earlyEventsRef.current.get(id)
      earlyEventsRef.current.clear()
      if (early) {
        devLog(`applying buffered event id=${id} phase=${early.phase} targetKind=${early.targetKind}`)
        applyScanState(early, "event")
      } else {
        // Não temos ainda progresso, mas o scan existe: nunca ficar num spinner mudo.
        setUiStatus("gathering")
      }
    } catch (err) {
      if (!mountedRef.current) return
      devLog("start failed", err)
      setUiStatus("idle")
      setError("Erro ao iniciar análise: " + (err instanceof Error ? err.message : String(err)))
    } finally {
      launchLockRef.current = false
    }
  }, [applyScanState])

  // ── Auto-start a partir do Dashboard (pendingScan consumido exatamente 1×) ──
  useEffect(() => {
    if (!pendingScan || pendingScanConsumedRef.current) return
    pendingScanConsumedRef.current = true
    onScanConsumed?.()
    if (pendingScan.type === "custom" && pendingScan.targetPath) {
      // O Dashboard só envia `custom` a partir do botão de pasta.
      const name = pendingScan.targetPath.split(/[/\\]/).pop() || pendingScan.targetPath
      launchScan("custom", pendingScan.targetPath, `Análise da pasta: ${name}`, "folder")
    } else {
      const kind: ScanIntentKind = pendingScan.type === "full" ? "full" : "quick"
      const card = SCAN_ACTION_CARDS.find(c => c.kind === kind)!
      launchScan(kind, undefined, `${card.title} iniciada`, kind)
    }
  }, [pendingScan, launchScan, onScanConsumed])

  // ── Handlers ──
  const handleQuickScan = useCallback(() => {
    if (isActiveUiStatus(uiStatus)) return
    launchScan("quick", undefined, "Análise Rápida do Computador iniciada (Downloads, Desktop, Documentos, Arranque)", "quick")
  }, [launchScan, uiStatus])

  const handleFullScan = useCallback(() => {
    if (isActiveUiStatus(uiStatus)) return
    launchScan("full", undefined, "Análise Profunda do Computador iniciada (diretório do utilizador + ProgramData)", "full")
  }, [launchScan, uiStatus])

  const handleFileScan = useCallback(async () => {
    if (isActiveUiStatus(uiStatus)) return
    if (!window.electronAPI) {
      setError("Execute a app a partir do ambiente de trabalho.")
      return
    }
    try {
      const filePath = await window.electronAPI.openFileDialog()
      if (!filePath) return
      const name = filePath.split(/[/\\]/).pop() || filePath
      launchScan("custom", filePath, `Análise do ficheiro: ${name}`, "file")
    } catch (err) {
      setError("Erro ao abrir diálogo: " + (err instanceof Error ? err.message : String(err)))
    }
  }, [launchScan, uiStatus])

  const handleFolderScan = useCallback(async () => {
    if (isActiveUiStatus(uiStatus)) return
    if (!window.electronAPI) {
      setError("Execute a app a partir do ambiente de trabalho.")
      return
    }
    try {
      const folderPath = await window.electronAPI.openFolderDialog()
      if (!folderPath) return
      const name = folderPath.split(/[/\\]/).pop() || folderPath
      launchScan("custom", folderPath, `Análise da pasta: ${name} (todos os ficheiros dentro da pasta)`, "folder")
    } catch (err) {
      setError("Erro ao abrir diálogo: " + (err instanceof Error ? err.message : String(err)))
    }
  }, [launchScan, uiStatus])

  const handleCancel = useCallback(async () => {
    const id = activeScanIdRef.current
    const api = window.electronAPI
    if (!id || !api) return
    try {
      devLog(`cancel requested id=${id}`)
      await api.cancelScan(id)
      // O pedido foi aceite; o estado terminal só é assumido quando o backend
      // confirma (evento cancelled). Até lá o botão mostra o que aconteceu.
      setCancelRequested(true)
      setScanLog(prev => [...prev, `${logStamp()} Cancelamento pedido ao motor`])
    } catch (err) {
      setError("Erro ao cancelar: " + (err instanceof Error ? err.message : String(err)))
    }
  }, [])

  const clear = useCallback(() => {
    devLog("session cleared")
    setScanLog([])
    setScanProgress(null)
    scanProgressRef.current = null
    setActiveScanId(null)
    setUiStatus("idle")
    setHydrating(false)
    setError("")
    setStalled(false)
    setCancelRequested(false)
    expectedScanIdRef.current = null
    activeScanIdRef.current = null
    intentRef.current = null
    earlyEventsRef.current.clear()
    pendingScanConsumedRef.current = false
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (isActiveUiStatus(uiStatus)) return
    const files = e.dataTransfer.files
    if (!files || files.length === 0) return
    const file = files[0]
    // Electron 32+ removeu `File.path`: o caminho real só existe no preload.
    const filePath = window.electronAPI?.getPathForFile?.(file) || (file as File & { path?: string }).path
    if (!filePath) {
      setError("Não foi possível obter o caminho do ficheiro largado.")
      return
    }
    // Se for uma pasta, o serviço confirma-o e a UI passa a apresentá-la como pasta.
    launchScan("custom", filePath, `Análise de: ${file.name}`, "file")
  }, [launchScan, uiStatus])

  const isActive = isActiveUiStatus(uiStatus)
  const isTerminal = isTerminalUiStatus(uiStatus)
  const cancel = cancelButtonState(uiStatus, !!activeScanId, cancelRequested)

  const effectiveType = normalizeScanType(scanProgress?.type ?? scanType)
  const scope: ScanScope = scanScopeFor(
    { type: effectiveType, targetKind: scanProgress?.targetKind },
    intentRef.current ?? undefined,
  )
  const targetName = targetNameOf(scanProgress)
  const analysisName = scopeTitle(scope, effectiveType)

  const discovered = scanProgress?.filesDiscovered ?? scanProgress?.filesScanned ?? 0
  const totalCandidates = scanProgress?.filesTotal ?? scanProgress?.filesDiscovered ?? 0
  const analyzed = scanProgress?.filesScanned ?? 0
  const currentFile = scanProgress?.currentFile
  const hasFileActivity = analyzed > 0 || (scanProgress?.progress ?? 0) > 0
  const progressPercent = scanProgressPercent(scanProgress)
  const etaLabel = formatEta(scanEtaSeconds(scanProgress))
  const noDetectionsCount = scanProgress ? resultFilesWithoutDetections(scanProgress) : null

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500 overflow-y-auto max-h-[calc(100vh-100px)]">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tight">
          Análise de <span className="text-primary">Segurança</span>
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Verifica as zonas prioritárias do computador, as suas pastas de forma abrangente, um ficheiro ou uma pasta.
        </p>
      </div>

      {/* ── Watchdog: sem atualizações do motor ──────────────────── */}
      {stalled && isActive && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-cyber-yellow/40 bg-cyber-yellow/5">
          <AlertTriangle className="w-5 h-5 text-cyber-yellow shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-mono text-foreground">Não foi possível obter atualizações do motor de análise.</p>
            <p className="text-xs text-muted-foreground mt-1">
              A análise pode estar bloqueada num ficheiro grande ou o serviço perdeu a ligação.
            </p>
          </div>
          <button
            onClick={handleVerify}
            className="px-3 py-2 bg-cyber-yellow/20 text-cyber-yellow border border-cyber-yellow/50 font-mono text-xs rounded-lg hover:bg-cyber-yellow/30 transition-all flex items-center gap-2"
          >
            <RotateCw className="w-3.5 h-3.5" />
            Tentar novamente
          </button>
        </div>
      )}

      {/* ── RECUPERAÇÃO: só com uma sessão viva já comprovada ── */}
      {shouldShowHydration(hydrating, uiStatus, recovering !== null) && (
        <div className="cyber-border rounded-xl p-8 bg-gradient-to-br from-primary/5 to-transparent">
          <div className="flex items-center gap-3">
            <MatrixAvatar mood="defender" size="sm" />
            <div>
              <h3 className="font-mono font-semibold text-foreground">{SCAN_HYDRATING_TITLE}</h3>
              <p className="text-xs text-muted-foreground">{SCAN_HYDRATING_DETAIL}</p>
            </div>
          </div>

          <div className="mt-6 space-y-3 animate-pulse">
            <div className="h-2 w-full rounded-full bg-secondary" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-16 rounded-lg bg-black/20 border border-white/5" />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── ANÁLISE EM CURSO ─────────────────────────────────────── */}
      {isActive && (
        <div className="cyber-border rounded-xl p-6 bg-gradient-to-br from-primary/5 to-transparent">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <MatrixAvatar mood="defender" size="sm" />
              <div>
                <h3 className="font-mono font-semibold text-foreground">{activeScanTitle(scope, uiStatus)}</h3>
                <p className="text-xs text-muted-foreground">{analysisName}</p>
              </div>
            </div>
            <button
              onClick={handleCancel}
              disabled={!cancel.enabled}
              className="px-4 py-2 bg-cyber-red/20 text-cyber-red border border-cyber-red/50 font-mono text-xs rounded-lg hover:bg-cyber-red/30 transition-all flex items-center gap-2 disabled:opacity-50"
            >
              <X className="w-4 h-4" />
              {cancel.label}
            </button>
          </div>

          {/* Alvo + o que está a acontecer (todas as fases têm feedback) */}
          <div className="mb-6">
            <div className="flex items-center justify-between gap-4 mb-2">
              <span className="text-sm font-mono text-foreground truncate">
                {scope === "file" && (currentFile || targetName)
                  ? `Ficheiro: ${currentFile || targetName}`
                  : scope === "folder" && targetName
                    ? `Pasta: ${targetName}`
                    : activeScanTitle(scope, uiStatus)}
              </span>
              <span className="text-sm font-mono font-bold text-primary shrink-0">
                {scope === "computer" && uiStatus === "scanning"
                  ? progressPercent !== null
                    ? `${progressPercent}%`
                    : "a analisar"
                  : uiStatus === "gathering"
                    ? `${discovered} ${scope === "file" ? "ficheiro" : "ficheiros"}`
                    : scope === "file"
                      ? hasFileActivity ? "100%" : "a verificar"
                      : uiStatus === "finalizing" ? "a concluir" : "…"}
              </span>
            </div>
            <div className="w-full h-2 bg-secondary rounded-full overflow-hidden border border-border">
              {scope === "computer" && uiStatus === "scanning" && progressPercent !== null && progressPercent > 0 ? (
                <div
                  className="h-full bg-gradient-to-r from-primary to-cyan-500 transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              ) : scope === "file" && hasFileActivity ? (
                <div className="h-full bg-gradient-to-r from-primary to-cyan-500 w-full" />
              ) : (
                <div className="h-full bg-gradient-to-r from-primary/40 to-cyan-500/40 animate-pulse w-full" />
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {activeScanDetail(scope, effectiveType, uiStatus, targetName, scanProgress?.filesInEngineBatch ?? 0)}
              {etaLabel ? ` ${etaLabel}.` : ""}
            </p>
          </div>

          {/* Stats — por tipo de alvo, para não mostrar métricas sem sentido */}
          <div className={cn("grid gap-4 mb-6", scope === "file" ? "grid-cols-2 md:grid-cols-3" : "grid-cols-2 md:grid-cols-4")}>
            <div className="bg-black/20 rounded-lg p-3 border border-white/5">
              <div className="text-xs text-muted-foreground uppercase mb-1">
                {scope === "file"
                  ? "Ficheiro"
                  : uiStatus === "gathering"
                    ? "Ficheiros Encontrados"
                    : "Ficheiros Analisados"}
              </div>
              <div className={cn("font-mono font-bold text-foreground", scope === "file" ? "text-sm truncate" : "text-xl")}>
                {scope === "file"
                  ? (currentFile || targetName || "—")
                  : uiStatus === "gathering"
                    ? discovered
                    : totalCandidates > 0 ? `${analyzed} / ${totalCandidates}` : analyzed}
              </div>
            </div>
            <div className="bg-black/20 rounded-lg p-3 border border-white/5">
              <div className="text-xs text-muted-foreground uppercase mb-1">Ameaças Encontradas</div>
              <div className="text-xl font-mono font-bold text-cyber-red">{scanProgress?.threatsFound ?? 0}</div>
            </div>
            {scope !== "file" && (
              <div className="bg-black/20 rounded-lg p-3 border border-white/5">
                <div className="text-xs text-muted-foreground uppercase mb-1">Velocidade</div>
                <div className="text-xl font-mono font-bold text-foreground flex items-center gap-1">
                  <Activity className="w-4 h-4 text-primary" />
                  {scanRateLabel(scanProgress)}
                </div>
              </div>
            )}
            <div className="bg-black/20 rounded-lg p-3 border border-white/5">
              <div className="text-xs text-muted-foreground uppercase mb-1">Tempo Decorrido</div>
              <div className="text-xl font-mono font-bold text-foreground flex items-center gap-1">
                <Clock className="w-4 h-4 text-primary" />
                {scanElapsedSeconds(scanProgress)}s
              </div>
            </div>
          </div>

          {/* Scan Log */}
          <div className="bg-black/40 rounded-lg border border-white/5 p-4 max-h-48 overflow-y-auto">
            <div className="text-xs font-mono space-y-1 text-muted-foreground">
              {scanLog.map((log, idx) => (
                <div key={idx}>{log}</div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── RESULTADO FINAL ──────────────────────────────────────── */}
      {isTerminal && scanProgress && (
        <div className={cn(
          "cyber-border rounded-xl p-6",
          uiStatus === "completed"
            ? "bg-gradient-to-br from-cyber-green/5 to-transparent"
            : "bg-gradient-to-br from-cyber-red/5 to-transparent"
        )}>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className={cn("font-mono font-semibold", uiStatus === "completed" ? "text-cyber-green" : uiStatus === "cancelled" ? "text-cyber-yellow" : "text-cyber-red")}>
                {uiStatus === "completed" ? "Análise concluída" : uiStatus === "cancelled" ? "Análise cancelada" : "Análise falhada"}
              </h3>
              <p className="text-xs text-muted-foreground">{analysisName}</p>
            </div>
            <span className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-mono uppercase border",
              uiStatus === "completed"
                ? "bg-cyber-green/10 text-cyber-green border-cyber-green/30"
                : uiStatus === "cancelled"
                  ? "bg-cyber-yellow/10 text-cyber-yellow border-cyber-yellow/30"
                  : "bg-cyber-red/10 text-cyber-red border-cyber-red/30"
            )}>
              {uiStatus === "completed" ? "Concluída" : uiStatus === "cancelled" ? "Cancelada" : "Falhada"}
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div className="bg-black/20 rounded-lg p-4 border border-white/5">
              <div className="text-xs text-muted-foreground uppercase mb-2">{SCAN_RESULT_LABELS.analysisType}</div>
              <div className="text-sm font-mono font-bold text-foreground">{analysisName}</div>
            </div>
            <div className="bg-black/20 rounded-lg p-4 border border-white/5 text-center">
              <div className="text-xs text-muted-foreground uppercase mb-2">{SCAN_RESULT_LABELS.filesChecked}</div>
              <div className="text-3xl font-mono font-bold text-foreground">{scanProgress.filesScanned}</div>
            </div>
            <div className="bg-black/20 rounded-lg p-4 border border-white/5 text-center">
              <div className="text-xs text-muted-foreground uppercase mb-2">{SCAN_RESULT_LABELS.filesWithoutDetections}</div>
              <div className={cn("text-3xl font-mono font-bold", scanProgress && noDetectionsTone(scanProgress) === "green" ? "text-cyber-green" : "text-muted-foreground")}>
                {noDetectionsCount ?? "—"}
              </div>
              <div className="text-[10px] text-muted-foreground mt-1">{scanProgress ? resultFilesWithoutDetectionsNote(scanProgress) : ""}</div>
            </div>
            <div className="bg-black/20 rounded-lg p-4 border border-white/5 text-center">
              <div className="text-xs text-muted-foreground uppercase mb-2">{SCAN_RESULT_LABELS.threatsFound}</div>
              <div className="text-3xl font-mono font-bold text-cyber-red">{scanProgress.threatsFound}</div>
            </div>
          </div>

          {/* Frase-resumo explícita */}
          <div className={cn(
            "flex items-start gap-4 p-4 rounded-xl mb-4 border",
            showNoThreatsReassurance(uiStatus, scanProgress)
              ? "bg-cyber-green/5 border-cyber-green/20"
              : uiStatus === "completed"
                ? "bg-cyber-red/5 border-cyber-red/20"
                : "bg-black/20 border-white/5"
          )}>
            {showNoThreatsReassurance(uiStatus, scanProgress) ? (
              <MatrixAvatar mood="success" size="sm" />
            ) : uiStatus === "failed" || scanProgress.threatsFound > 0 ? (
              <MatrixAvatar mood="alert" size="sm" />
            ) : (
              <MatrixAvatar mood="defender" size="sm" />
            )}
            <div>
              <p className="text-sm text-foreground font-sans">
                {buildResultSummary({
                  scope,
                  type: effectiveType,
                  status: scanProgress.status,
                  filesScanned: scanProgress.filesScanned,
                  threatsFound: scanProgress.threatsFound,
                  filesFailed: scanProgress.filesFailed,
                  filesAnalyzed: scanProgress.filesAnalyzed,
                  filesExcluded: scanProgress.filesExcluded,
                  targetName,
                  error: scanProgress.error,
                })}
              </p>
              {resultFollowUpNote(uiStatus, scanProgress.threatsFound) && (
                <p className="text-xs text-muted-foreground mt-2">
                  {resultFollowUpNote(uiStatus, scanProgress.threatsFound)}
                </p>
              )}
              {showNoThreatsReassurance(uiStatus, scanProgress) && (
                <p className="text-xs text-muted-foreground/80 mt-2">{NO_DETECTIONS_NOTE}</p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-muted-foreground mb-6">
            <span>
              Duração: {formatScanDurationLabel(scanProgress) ?? `${scanElapsedSeconds(scanProgress)}s`}
            </span>
            {(scanProgress.filesFailed ?? 0) > 0 && (
              <span>{filesFailedFooterLabel(scanProgress.filesFailed ?? 0)}.</span>
            )}
            {(scanProgress.filesExcluded ?? 0) > 0 && (
              <span>{filesExcludedFooterLabel(scanProgress.filesExcluded ?? 0)}.</span>
            )}
            {targetName && <span className="truncate">Alvo: {targetName}</span>}
          </div>

          <button
            onClick={clear}
            className="w-full py-3 bg-primary text-primary-foreground font-mono text-sm rounded-lg hover:bg-primary/90 transition-all"
          >
            Nova análise
          </button>
        </div>
      )}

      {/* ── IDLE: escolher o que analisar (aberto de imediato sem sessão) ── */}
      {uiStatus === "idle" && (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            "cyber-border rounded-xl p-8 transition-all",
            isDragging ? "border-primary bg-primary/5 scale-[1.01]" : "hover:border-primary/50"
          )}
        >
          <div className="flex flex-col items-center text-center mb-6">
            <div className={cn(
              "w-16 h-16 rounded-2xl flex items-center justify-center mb-4 transition-all border",
              isDragging ? "bg-primary/20 border-primary" : "bg-primary/10 border-primary/30"
            )}>
              {isDragging ? (
                <Upload className="w-8 h-8 text-primary animate-bounce" />
              ) : (
                <FileSearch className="w-8 h-8 text-primary" />
              )}
            </div>
            <h3 className="text-lg font-mono font-semibold text-foreground">
              {isDragging ? "Solte o ficheiro ou a pasta aqui" : "O que pretende analisar?"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-xl mt-1">
              Escolha uma das análises abaixo. Também pode arrastar um ficheiro para esta área.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {SCAN_ACTION_CARDS.map((card) => {
              const Icon = ACTION_ICON[card.kind]
              const onClick = card.kind === "quick"
                ? handleQuickScan
                : card.kind === "full"
                  ? handleFullScan
                  : card.kind === "file"
                    ? handleFileScan
                    : handleFolderScan
              return (
                <button
                  key={card.kind}
                  onClick={onClick}
                  className="text-left p-4 rounded-xl border border-border bg-black/20 hover:border-primary/50 hover:bg-primary/5 transition-all group"
                >
                  <div className="flex items-start gap-4">
                    <div className={cn("w-10 h-10 rounded-lg border flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform", ACTION_COLOR[card.kind])}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <span className="font-mono text-sm font-semibold text-foreground block">{card.title}</span>
                      <span className="text-xs text-muted-foreground block mt-1 leading-relaxed">{card.description}</span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          <p className="text-xs text-muted-foreground mt-4 text-center">{ZIP_CONTENT_NOTE}</p>
        </div>
      )}

      {error && (
        <div className="text-cyber-red text-xs font-mono p-4 cyber-border bg-cyber-red/5 rounded-lg">{error}</div>
      )}

      {/* Tips */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="cyber-border rounded-xl p-6 hover:border-primary/50 transition-all group">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
              <ShieldAlert className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h3 className="font-mono font-semibold text-foreground">Dica de Segurança</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Analise ficheiros descarregados de fontes desconhecidas ou executáveis inesperados.
              </p>
            </div>
          </div>
        </div>

        <div className="cyber-border rounded-xl p-6 hover:border-primary/50 transition-all group">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-cyber-cyan/10 border border-cyber-cyan/30 flex items-center justify-center group-hover:bg-cyber-cyan/20 transition-colors">
              <Zap className="w-6 h-6 text-cyber-cyan" />
            </div>
            <div>
              <h3 className="font-mono font-semibold text-foreground">Análise em Segundo Plano</h3>
              <p className="text-xs text-muted-foreground mt-1">
                O motor continua a analisar mesmo que mude de página. Ao voltar a esta secção, o progresso é retomado automaticamente. Isto
                descreve a análise, não uma proteção em tempo real: os ficheiros só são vigiados dentro de uma análise.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
