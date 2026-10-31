import { Upload, File, Folder, ShieldAlert, Zap, X, AlertTriangle, RotateCw, Search, Play, FileSearch } from "lucide-react"
import { useState, useCallback, useMemo, useRef, useEffect, useId } from "react"
import { cn } from "@/lib/utils"
import { isAppShuttingDown, onAppShutdown } from "@/lib/shutdownState"
import { ScanPhaseList } from "@/v2/scanner/ScanPhaseList"
import { ScanEngineState } from "@/v2/scanner/ScanEngineState"
import type { EngineHealth, ScanState, ScanType } from "@cybersafe/shared-types"
import { MatrixAvatar } from "../components/MatrixAvatar"
// R7-L3-FOLLOWUP: o histórico passou a viver AQUI dentro — decisão do utilizador
// após teste humano: uma página própria no menu fragmentava a experiência.
// A integração é só leitura do estado que a página já tem: nem a subscrição a
// `scan.progress`, nem a adopção de sessão, nem o ecrã de recuperação mudam.
import { ScanHistoryPanel } from "../components/ScanHistoryPanel"
// R8-USB: o painel do observador USB entra aqui, por cima do arquivo. É só
// montagem: nenhuma linha de decisão de estado do scanner muda com isto.
import { UsbProtectionPanel } from "../components/UsbProtectionPanel"
import {
  NO_DETECTIONS_NOTE,
  SCAN_ACTION_CARDS,
  SCAN_CANCEL_REQUESTED_NOTE,
  SCAN_HYDRATING_DETAIL,
  SCAN_HYDRATING_TITLE,
  SCAN_STALL_MS,
  ZIP_CONTENT_NOTE,
  activeScanDetail,
  cancelButtonState,
  decideScanRecovery,
  decideScanAttachment,
  readScanSnapshot,
  activeScanTitle,
  activeScanTarget,
  conciseResultSummary,
  decideAvisoCancelamento,
  decideCancelamento,
  decideCartaoLargura,
  decideScanEvent,
  formatEta,
  formatScanDurationLabel,
  isActiveUiStatus,
  failureReasonsLabel,
  isTerminalScanStatus,
  isTerminalUiStatus,
  normalizeScanState,
  normalizeScanType,
  resultFollowUpNote,
  scanAnalysisStage,
  scanElapsedSeconds,
  scanEtaSeconds,
  scanPrimaryBar,
  scanProgressReadout,
  scanRateLabel,
  scanResultBreakdown,
  scanResultBreakdownNote,
  scanScopeFor,
  scopeTitle,
  showNoThreatsReassurance,
  shouldShowHydration,
  terminalResultLabels,
  uiStatusForState,
  inconclusiveReasonsLabel,
  PER_FILE_ENGINE_COVERAGE_NOTE,
  PER_FILE_NATIVE_LABELS,
  PER_FILE_PASTA_NOTE,
  PER_FILE_STATE_LABELS,
  createDirectedScanController,
  mesmoCaminho,
  dirigidaContention,
  lancamentoContention,
  normalizeFileScanResponse,
  perFileOutcomeSentence,
  SCAN_CONTENTION_MESSAGES,
  type AvisoCancelamento,
  type CartaoLargura,
  type PerFileFacts,
  type ScanIntentKind,
  type ScanScope,
  type ScanStateExtended,
  type ScanUiStatus,
} from "@/lib/scanSession"

const DEV = import.meta.env?.DEV === true

/** Logs de diagnóstico concisos e apenas em desenvolvimento. */
function devLog(message: string, extra?: unknown) {
  if (!DEV) return
  if (extra === undefined) console.debug(`[ScanUI] ${message}`)
  else console.debug(`[ScanUI] ${message}`, extra)
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

/**
 * Estado da análise dirigida de UM ficheiro (`scan.artifact`), apresentada com
 * os factos que o motor devolve por ficheiro. `inerte` nunca desenha cartão.
 */
export type PerFileCardState =
  | { fase: "inerte" }
  | { fase: "disponivel"; fileName: string }
  | { fase: "a_analisar"; fileName: string }
  | { fase: "sem_ligacao"; fileName: string }
  | { fase: "sem_resposta"; fileName: string; mensagem: string }
  | { fase: "erro"; fileName: string; mensagem: string }
  | { fase: "pronto"; fileName: string; facts: PerFileFacts[] }
  /**
   * UI-D4: o serviço confirmou (`targetKind: "directory"`) que a largura é uma
   * pasta. O cartão por motor é de UM ficheiro (`scan.artifact`), por isso não
   * há análise dirigida a oferecer aqui.
   */
  | { fase: "diretorio"; fileName: string }

export interface PerFileEngineCardProps {
  estado: PerFileCardState
  onAnalisar: () => void
  /**
   * Verdadeiro enquanto existir uma análise de pasta/ficheiro em curso. A
   * análise dirigida é um pedido adicional ao mesmo serviço: lançar os dois em
   * paralelo duplica trabalho e faz competirem pelo mesmo ecrã.
   *
   * Este sinal é o que está PINTADO; entre o clique e o render há um tick em
   * que ainda não se vê nada. A exclusão nesse instante é síncrona e feita na
   * origem de cada pedido (`dirigidaContention`/`lancamentoContention`), não
   * aqui.
   */
  scanAtivo: boolean
}

/**
 * O que os motores disseram sobre ESTE ficheiro.
 *
 * Desenhado a partir do contrato por ficheiro, não dos contadores do scan: um
 * ficheiro que falhou, cujo motor estava indisponível ou cujo estado não foi
 * informado nunca aparece como limpo. Atribuição a YARA/HashDB/ClamAV não é
 * afirmada porque a resposta não a traz.
 */
export function PerFileEngineCard({ estado, onAnalisar, scanAtivo }: PerFileEngineCardProps) {
  if (estado.fase === "inerte") return null

  const ocupado = estado.fase === "a_analisar"
  const bloqueado = ocupado || scanAtivo
  const emPasta = estado.fase === "diretorio"

  return (
    <div className="cs-scanner-perfile cyber-border rounded-xl p-5 mt-4" data-fase={estado.fase}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* UI-D4: a palavra acompanha o que o serviço confirmou. Uma pasta não é
            um «ficheiro analisado» e não tem análise por motor a oferecer. */}
        <h3 className="font-mono text-sm font-semibold text-foreground">
          {emPasta ? "Pasta largada" : "Ficheiro analisado"}
        </h3>
        <span className="font-mono text-sm text-primary break-all">{estado.fileName}</span>
        {!emPasta && (
          <button
            type="button"
            onClick={onAnalisar}
            disabled={bloqueado}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {ocupado ? "A analisar" : scanAtivo ? "Bloqueado durante a análise" : "Analisar com os motores"}
          </button>
        )}
      </div>

      {emPasta && (
        <p className="text-xs text-muted-foreground mt-3" role="status">{PER_FILE_PASTA_NOTE}</p>
      )}

      {scanAtivo && !ocupado && (
        <p className="text-xs text-muted-foreground mt-3" role="status">
          {SCAN_CONTENTION_MESSAGES.analise_em_curso}
        </p>
      )}

      {estado.fase === "sem_ligacao" && (
        <p className="text-xs text-muted-foreground mt-3" role="status">
          Sem ligação ao serviço: não há resultado de motor a mostrar.
        </p>
      )}

      {(estado.fase === "sem_resposta" || estado.fase === "erro") && (
        <p className="text-xs text-cyber-red mt-3" role="alert">{estado.mensagem}</p>
      )}

      {estado.fase === "pronto" && (
        <div className="mt-3 space-y-2">
          {estado.facts.map((fact, index) => (
            <div key={`${fact.fileName || "linha"}-${index}`} className="cs-scanner-facto text-xs space-y-1" data-estado={fact.analysisState}>
              <p className="text-foreground">
                <b className="font-semibold">{PER_FILE_STATE_LABELS[fact.analysisState]}</b>
                <span className="text-muted-foreground"> · {perFileOutcomeSentence(fact)}</span>
              </p>
              <p className="text-muted-foreground">
                {PER_FILE_NATIVE_LABELS[fact.native.status]}
                {fact.native.failure ? ` · motivo: ${fact.native.failure}` : ""}
              </p>
              {fact.verdict && (
                <p className="text-muted-foreground">Veredicto reportado: {fact.verdict}</p>
              )}
              {fact.rulesTriggered.length > 0 && (
                <p className="text-muted-foreground">
                  Regras heurísticas reportadas: {fact.rulesTriggered.join(", ")}
                </p>
              )}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{PER_FILE_ENGINE_COVERAGE_NOTE}</p>
          {estado.facts.length > 0 && estado.facts.every((fact) => fact.canClaimClean) && (
            <p className="text-xs text-muted-foreground">{NO_DETECTIONS_NOTE}</p>
          )}
        </div>
      )}
    </div>
  )
}

interface FileScannerPageProps {
  /** Current service snapshot; never evidence of participation in a scan. */
  engineHealth?: EngineHealth;
  serviceConnected?: boolean | null;
  pendingScan?: { type: string; targetPath?: string } | null;
  onScanConsumed?: () => void;
  /**
   * UI-B (TP-PAP-UI-FUNCTIONAL-20261028): leva o utilizador para Ameaças quando
   * uma análise terminou com deteções. O texto do resultado sempre mandou o
   * utilizador para lá (`scanSession.ts` `resultFollowUpNote`) sem que a página
   * tivesse qualquer affordance — não há router no renderer, quem muda a página
   * é o `App`. Sem este callback o botão simplesmente não existe: nada de
   * promessa vazia.
   */
  onOpenThreats?: () => void;
}

// ── A2 · Confirmação explícita da pasta (TP-A2-SCANNER-CONFIRMATION-20261020) ──
// O diálogo nativo devolve um caminho, e um caminho não é uma ordem. Antes desta
// correção a resposta do diálogo chamava `launchScan` diretamente: bastava o
// diálogo fechar-se com `C:\Users\<nome>\Downloads` para a app começar a ler a
// pasta pessoal sem o utilizador ter escolhido nada. A partir daqui a resposta
// só produz uma SELEÇÃO PENDENTE; a análise só existe depois do clique em
// «Analisar esta pasta». A decisão vive em funções puras exportadas (não num
// efeito) para poder ser exercitada por testes sem DOM.

/** Pasta devolvida pelo diálogo, ainda sem análise associada. */
export interface FolderSelection {
  /** Caminho exatamente como o diálogo o devolveu. É este que se analisa. */
  path: string
  /** Último segmento do caminho, só para o rótulo. */
  name: string
  /** Geração do diálogo que a produziu: liga a confirmação ao que é MOSTRADO. */
  generation: number
}

/** O que uma resposta do diálogo produziu. */
export type FolderDialogResolution =
  /** Resposta atual com caminho utilizável — há seleção pendente. */
  | "pending"
  /** Resposta atual sem caminho (fechar/Esc/cancelado/vazio) — nada pendente. */
  | "cleared"
  /** Resposta de um diálogo que já não é o atual — não toca em nada. */
  | "ignored"

export interface FolderConfirmationGate {
  /** Pede um diálogo novo e devolve a geração que a resposta deve citar. */
  requestDialog(): number
  /** Aceita ou recusa a resposta do diálogo. Nunca inicia análises. */
  resolveDialog(generation: number, rawPath: unknown): FolderDialogResolution
  /**
   * Alvo vindo de fora do diálogo desta página (Dashboard/tray): também ele é
   * uma SELEÇÃO a confirmar, não uma ordem. Substitui a pendente e invalida
   * respostas de diálogo em voo, como um diálogo novo.
   */
  offer(rawPath: unknown): FolderSelection | null
  /**
   * Consome a seleção pendente SÓ se ela for a que está no ecrã. A segunda
   * chamada, ou uma chamada com uma seleção antiga, devolve `null`.
   */
  confirm(shown: FolderSelection | null): FolderSelection | null
  /** Cancelar, fechar ou Esc: limpa a seleção e invalida respostas em voo. */
  cancel(): void
  /** Unmount, troca de sessão ou análise nova: invalida sem interação. */
  invalidate(): void
  pending(): FolderSelection | null
}

/** Caminho → seleção, ou `null` quando não há caminho utilizável. */
export function folderSelectionFromPath(raw: unknown, generation = 0): FolderSelection | null {
  if (typeof raw !== "string") return null
  if (!raw.trim()) return null
  const parts = raw.split(/[/\\]+/).filter(Boolean)
  return { path: raw, name: parts[parts.length - 1] ?? raw, generation }
}

export function createFolderConfirmationGate(): FolderConfirmationGate {
  let generation = 0
  let pending: FolderSelection | null = null
  return {
    requestDialog() {
      generation += 1
      // Um diálogo novo abandona a seleção anterior: o ecrã não pode continuar
      // a mostrar a pasta A enquanto já se escolhe a pasta B.
      pending = null
      return generation
    },
    resolveDialog(requestGeneration, rawPath) {
      // Resposta de um diálogo que já foi substituído (ou invalidado) não muda
      // o que o utilizador está a ver, nem pode sequestrar o alvo confirmado.
      if (requestGeneration !== generation) return "ignored"
      pending = folderSelectionFromPath(rawPath, requestGeneration)
      return pending ? "pending" : "cleared"
    },
    confirm(shown) {
      const selection = pending
      // Só se analisa o que está no ecrã. Se a pendente já não for a mostrada
      // (diálogo novo, ou resposta nova antes do render), não se arranca com um
      // caminho diferente do que o utilizador viu: devolve `null` e nada corre.
      if (!selection || !shown) return null
      if (selection.generation !== shown.generation || selection.path !== shown.path) return null
      pending = null
      // O scan deste caminho arranca já: respostas em voo deixam de valer.
      generation += 1
      return selection
    },
    offer(rawPath) {
      generation += 1
      pending = folderSelectionFromPath(rawPath, generation)
      return pending
    },
    cancel() {
      pending = null
      generation += 1
    },
    invalidate() {
      pending = null
      generation += 1
    },
    pending() {
      return pending
    },
  }
}

/**
 * Confirma a seleção MOSTRADA. `start` corre no máximo uma vez por seleção, e
 * nunca para um caminho que não seja o que `shown` representa.
 */
export function confirmFolderSelection(
  gate: FolderConfirmationGate,
  shown: FolderSelection | null,
  start: (selection: FolderSelection) => void,
): boolean {
  const selection = gate.confirm(shown)
  if (!selection) return false
  start(selection)
  return true
}

/** Teclas que fecham a confirmação sem analisar nada. */
export function folderConfirmationKeyAction(key: string): "cancel" | null {
  return key === "Escape" || key === "Esc" ? "cancel" : null
}

export function FolderConfirmationPanel({ selection, onConfirm, onCancel }: {
  selection: FolderSelection
  onConfirm: () => void
  onCancel: () => void
}) {
  const titleId = useId()
  const detailId = useId()
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  // O painel nasce depois da resposta do diálogo: o foco tem de o seguir, senão
  // quem usa teclado fica no botão anterior e o Esc nunca chega ao painel.
  useEffect(() => {
    confirmRef.current?.focus()
  }, [])
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      aria-describedby={detailId}
      onKeyDown={(e) => {
        if (folderConfirmationKeyAction(e.key) === "cancel") {
          e.preventDefault()
          e.stopPropagation()
          onCancel()
        }
      }}
      className="cyber-border rounded-xl p-6 bg-gradient-to-br from-primary/5 to-transparent"
    >
      <h3 id={titleId} className="font-mono font-semibold text-foreground">Confirmar análise da pasta</h3>
      <p id={detailId} className="text-xs text-muted-foreground mt-1">
        Nada é analisado antes de confirmar. Confirme a pasta que escolheu.
      </p>
      <div className="mt-4 flex items-start gap-3">
        <Folder className="w-4 h-4 text-primary shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-mono font-semibold text-foreground break-all">{selection.name}</p>
          <p className="text-xs font-mono text-muted-foreground break-all mt-1">{selection.path}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3 mt-5">
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          className="px-4 py-2 bg-primary text-primary-foreground font-mono text-xs rounded-lg hover:bg-primary/90 transition-all"
        >
          Analisar esta pasta
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 bg-secondary text-foreground border border-border font-mono text-xs rounded-lg hover:bg-secondary/80 transition-all"
        >
          Cancelar
        </button>
      </div>
    </div>
  )
}

// ── B2 · Barra de progresso com nome, valor e indeterminado honesto ─────────
// A barra dizia o progresso só a quem vê a largura. O valor anunciado vem da
// MESMA fonte que a desenha (`scanPrimaryBar`), por isso não há percentagem
// inventada: sem medição não existe `aria-valuenow`, só `aria-valuetext` com a
// fase real (um 0 ali leria «parado a 0%»).
export interface ScanProgressBarModel {
  /** Percentagem a desenhar: `null` quando não há medição. */
  percent: number | null
  aria: {
    role: "progressbar"
    "aria-label": string
    "aria-valuemin": number
    "aria-valuemax": number
    "aria-valuenow"?: number
    "aria-valuetext"?: string
  }
}

export function scanProgressBarModel(percent: number | null, label: string): ScanProgressBarModel {
  const measured = typeof percent === "number" && Number.isFinite(percent)
    ? Math.min(100, Math.max(0, percent))
    : null
  const aria: ScanProgressBarModel["aria"] = {
    role: "progressbar",
    "aria-label": `Progresso da análise: ${label}`,
    "aria-valuemin": 0,
    "aria-valuemax": 100,
  }
  if (measured === null) aria["aria-valuetext"] = label
  else aria["aria-valuenow"] = Math.round(measured)
  return { percent: measured, aria }
}

/**
 * A única barra do cartão em curso. Recebe a leitura de `scanPrimaryBar` e
 * desenha o valor NORMALIZADO que anuncia — uma fonte só: o mesmo `bar.percent`
 * vale para a largura e para o `aria-valuenow`. Assim 140 vira 100 nos dois, um
 * valor impossível não estica a barra para 140%, e 0% desenha zero (não uma
 * barra cheia a pulsar, que lia «indeterminado»).
 */
export function ScanProgressBar({ bar: reading, label }: { bar: { percent: number | null }; label: string }) {
  const bar = scanProgressBarModel(reading.percent, label)
  return (
    <div {...bar.aria} className="w-full h-2 bg-secondary rounded-full overflow-hidden border border-border">
      {bar.percent !== null ? (
        <div
          className="h-full bg-gradient-to-r from-primary to-cyan-500 transition-all duration-300"
          style={{ width: `${bar.percent}%` }}
        />
      ) : (
        <div className="h-full bg-gradient-to-r from-primary/40 to-cyan-500/40 animate-pulse w-full" />
      )}
    </div>
  )
}

export default function FileScannerPage({ pendingScan, onScanConsumed, onOpenThreats, engineHealth, serviceConnected }: FileScannerPageProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState("")
  /**
   * Fato por ficheiro da última largura válida. O caminho real vive num `ref`:
   * não é desenhado, não é persistido, e serve apenas para pedir a análise
   * dirigida ao serviço quando o utilizador a pede explicitamente.
   */
  const [perFile, setPerFile] = useState<PerFileCardState>({ fase: "inerte" })
  const perFilePathRef = useRef<string | null>(null)
  /**
   * UI-D4: a última largura cujo alvo o serviço ainda não classificou, e o que
   * já foi confirmado dela. Vivem em refs porque não são desenhadas nem
   * adivinhadas: `pasta` só aparece com `targetKind: "directory"` do motor, e a
   * análise dirigida recusa esse caso pela verdade síncrona, não pelo que está
   * pintado.
   */
  const larguraRef = useRef<{ caminho: string; a_confirmar: boolean }>({ caminho: "", a_confirmar: false })
  const larguraTipoRef = useRef<CartaoLargura>("sem_leitura")
  // Trava síncrona + identidade da seleção, na máquina do `scanSession`, para
  // que duplo clique, análise em curso e resposta tardia sejam comportamento
  // testado e não boa intenção dentro do `useCallback`.
  const dirigidaRef = useRef(createDirectedScanController())

  const [uiStatus, setUiStatus] = useState<ScanUiStatus>("idle")
  const [activeScanId, setActiveScanId] = useState<string | null>(null)
  const [scanType, setScanType] = useState<string>("")
  const [scanProgress, setScanProgress] = useState<ScanState | null>(null)
  const [stalled, setStalled] = useState(false)
  /**
   * Pedido de cancelamento já enviado e ainda não confirmado por um evento
   * terminal do motor. Enquanto verdadeiro o botão deixa de oferecer o que
   * já aconteceu — um segundo clique só reenviaria o mesmo cancelamento.
   */
  const [cancelRequested, setCancelRequested] = useState(false)
  /**
   * Resultado de um cancelamento que o serviço não aceitou. Vive FORA do `error`
   * da página porque `applyScanState` limpa o erro a cada evento do motor — e
   * com uma análise em curso há sempre um evento a chegar. Medido no Electron
   * real: escrito no `error`, o aviso durava menos de um segundo.
   */
  const [avisoCancelar, setAvisoCancelar] = useState<AvisoCancelamento | null>(null)
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
  const launchGenerationRef = useRef(0)
  const pendingScanConsumedRef = useRef(false)
  /** A2: pasta devolvida pelo diálogo, à espera de confirmação explícita. */
  const [pendingFolder, setPendingFolder] = useState<FolderSelection | null>(null)
  /** Portão síncrono: gerações e seleção pendente vivem fora do render. */
  const folderGate = useMemo(() => createFolderConfirmationGate(), [])
  const mountedRef = useRef(true)

  // ── Aplica um estado vindo do motor (evento ou snapshot de ressincronização) ──
  const applyScanState = useCallback((next: ScanState, source: "event" | "snapshot") => {
    const current = scanProgressRef.current
    const buffered = earlyEventsRef.current.get(next.id)
    const candidate = buffered ? decideScanAttachment(next, buffered) ?? next : next
    earlyEventsRef.current.delete(next.id)
    const merged = decideScanAttachment(current, candidate)
    if (!merged) {
      // Estado atrasado (revisão inferior) ou reabertura de um scan terminal:
      // ignorado para os contadores nunca recuarem.
      devLog(`ignored stale state expectedRev=${current?.revision ?? "-"} receivedRev=${next.revision ?? "-"} status=${next.status}`)
      return
    }
    if (current?.id !== merged.id) {
      if (expectedScanIdRef.current !== merged.id) intentRef.current = null
      expectedScanIdRef.current = merged.id
      activeScanIdRef.current = merged.id
      setActiveScanId(merged.id)
      setScanType(merged.type)
      setCancelRequested(false)
      setAvisoCancelar(null)
    }
    setError("")
    scanProgressRef.current = merged
    lastMessageAtRef.current = Date.now()
    setStalled(false)
    setScanProgress(merged)

    const nextStatus = uiStatusForState(merged)
    setUiStatus(nextStatus)

    // A transição terminal não escreve nada para um registo: o resultado tem
    // cartão próprio (`isTerminal`), e o que aqui se acumulava num log escuro
    // invisível passa a estar dito onde é lido (resumo + motivos das falhas).
    if (isTerminalScanStatus(merged.status)) return

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

      if (!launchLockRef.current) {
        applyScanState(state, "event")
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

    const unsubscribeTray = api.onScanSession?.((delivery) => {
      if (delivery.error) setError(delivery.error)
      else if (delivery.state && !launchLockRef.current) {
        const state = normalizeScanState(delivery.state)
        if (state) applyScanState(state, "snapshot")
      }
    })

    return () => {
      unsubscribeTray?.()
      mountedRef.current = false
      // A2: ao desmontar, respostas de diálogo ainda em voo deixam de valer.
      folderGate.invalidate()
      devLog("listener cleanup")
      unsubscribe?.()
    }
  }, [applyScanState, folderGate])

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
    const generation = launchGenerationRef.current
    void (async () => {
      try {
        const snapshot = await readScanSnapshot(api)
        if (cancelled || !mountedRef.current || generation !== launchGenerationRef.current || launchLockRef.current) return
        if (!snapshot) return
        const recovery = decideScanRecovery(snapshot)
        setRecovering(recovery)
        setHydrating(!!recovery)
        applyScanState(snapshot, "snapshot")
      } catch (err) {
        if (!cancelled && mountedRef.current && generation === launchGenerationRef.current && !launchLockRef.current) setError("Não foi possível obter o estado da análise. Verifique a ligação ao serviço e tente novamente.")
        devLog("resync failed", err)
      } finally {
        if (!cancelled && mountedRef.current) setHydrating(false)
      }
    })()
    return () => { cancelled = true }
  }, [applyScanState])

  // ── UI-D4: a natureza da largura, ditada pelo serviço, nunca pelo `File` ──
  // O `drop` sabe o caminho; só o motor sabe se é ficheiro ou pasta
  // (`ScanState.targetKind`). Enquanto não disser, o cartão fica como estava —
  // adivinhar pelo nome ou pelo `File` era o defeito que este efeito fecha.
  useEffect(() => {
    const largura = larguraRef.current
    if (!largura.a_confirmar || !scanProgress) return
    const decisao = decideCartaoLargura(scanProgress.targetKind)
    if (decisao === "sem_leitura") return
    if (!mesmoCaminho(scanProgress.targetPath, largura.caminho)) return
    largura.a_confirmar = false
    larguraTipoRef.current = decisao
    if (decisao !== "pasta") return
    if (perFilePathRef.current !== largura.caminho) return
    setPerFile((atual) =>
      atual.fase === "inerte" || atual.fase === "pronto" ? atual : { fase: "diretorio", fileName: atual.fileName },
    )
  }, [scanProgress])

  // ── Watchdog: fallback de UI, nunca a correção principal ──
  const handleVerify = useCallback(async () => {
    const api = window.electronAPI
    const generation = launchGenerationRef.current
    const expected = expectedScanIdRef.current
    try {
      if (!api) throw new Error("Serviço indisponível")
      const snapshot = await readScanSnapshot(api, expected ?? undefined)
      if (!mountedRef.current || generation !== launchGenerationRef.current || expected !== expectedScanIdRef.current) return
      if (snapshot && snapshot.id === expectedScanIdRef.current) {
        applyScanState(snapshot, "snapshot")
        return
      }
      setStalled(true)
      setError("O serviço não confirmou o estado desta análise. Tente verificar novamente.")
    } catch (err) {
      if (!mountedRef.current || generation !== launchGenerationRef.current || expected !== expectedScanIdRef.current) return
      devLog("verify failed", err)
      setError("Não foi possível comunicar com o serviço de análise. Tente novamente.")
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
    /** O que o utilizador pediu, só para o diagnóstico em desenvolvimento. */
    devLabel: string,
    intent: ScanIntentKind,
  ) => {
    // Sentido dirigida → lançada, síncrono. A análise dirigida usa o mesmo
    // serviço; deixá-la arrancar por baixo de um scan novo seria dois trabalhos
    // em simultâneo com um só painel de progresso. Passar por aqui cobre todos
    // os entradas de scan (cartões, drop, confirmar pasta, alvo do Dashboard),
    // e a recusa é mostrada em vez de engolida.
    const recusaLancamento = lancamentoContention(dirigidaRef.current.emCurso)
    if (recusaLancamento) {
      setError(SCAN_CONTENTION_MESSAGES[recusaLancamento])
      return
    }
    if (launchLockRef.current) return
    const api = window.electronAPI
    if (!api) {
      setError("Execute a app a partir do ambiente de trabalho.")
      return
    }

    launchLockRef.current = true
    launchGenerationRef.current += 1
    // A2: uma análise nova (de qualquer cartão) descarta a seleção pendente.
    folderGate.invalidate()
    setPendingFolder(null)
    expectedScanIdRef.current = null
    activeScanIdRef.current = null
    earlyEventsRef.current.clear()
    intentRef.current = intent
    lastMessageAtRef.current = Date.now()
    setUiStatus("preparing")
    setScanType(type)
    setScanProgress(null)
    scanProgressRef.current = null
    setError("")
    setStalled(false)
    setCancelRequested(false)
    setAvisoCancelar(null)
    devLog(`launch requested type=${type} intent=${intent} target=${targetPath ?? ""} label=${devLabel}`)

    try {
      const active = normalizeScanState(await api.getActiveScan())
      if (!mountedRef.current) return
      if (active && (active.status === "running" || active.status === "queued")) {
        applyScanState(active, "snapshot")
        return
      }
      const result = await api.startScan(type as ScanType, targetPath, "scanner-page")
      if (!mountedRef.current) return

      const id = result?.id
      if (!result?.success || !id) {
        devLog("launch rejected", result)
        throw new Error(result?.error || "Não foi possível iniciar a análise.")
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
      try {
        const active = normalizeScanState(await api.getActiveScan())
        if (!mountedRef.current) return
        if (active && (active.status === "running" || active.status === "queued")) {
          applyScanState(active, "snapshot")
          return
        }
      } catch { /* Sem confirmação: explicar a falha, não inventar uma sessão. */ }
      if (!mountedRef.current) return
      setUiStatus("idle")
      setError("Não foi possível iniciar ou confirmar a análise. Verifique a ligação ao serviço e tente novamente.")
    } finally {
      launchLockRef.current = false
    }
  }, [applyScanState])

  // ── Alvo vindo do Dashboard/tray (pendingScan consumido exatamente 1×) ──
  useEffect(() => {
    if (!pendingScan || pendingScanConsumedRef.current) return
    pendingScanConsumedRef.current = true
    onScanConsumed?.()
    if (pendingScan.type === "custom" && pendingScan.targetPath) {
      // O Dashboard só envia `custom` a partir do botão de pasta, e o diálogo
      // nativo corre lá: o caminho que chega daqui é a MESMA resposta que antes
      // arrancava um scan direto, sem passar por esta página. Contornava a
      // confirmação inteira. Passa a ser uma seleção a confirmar aqui.
      setPendingFolder(folderGate.offer(pendingScan.targetPath))
    } else {
      // quick/full continuam a ser ordens explícitas do utilizador: sem alvo
      // pessoal escolhido por um diálogo, mantêm o contrato anterior.
      const kind: ScanIntentKind = pendingScan.type === "full" ? "full" : "quick"
      const card = SCAN_ACTION_CARDS.find(c => c.kind === kind)!
      launchScan(kind, undefined, `${card.title} iniciada`, kind)
    }
  }, [folderGate, pendingScan, launchScan, onScanConsumed])

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
    const request = folderGate.requestDialog()
    // A seleção anterior deixa de estar em cena no mesmo instante em que se
    // pede outro diálogo — nada fica a apontar para uma pasta abandonada.
    setPendingFolder(null)
    try {
      const folderPath = await window.electronAPI.openFolderDialog()
      if (!mountedRef.current) return
      // A resposta só vira seleção pendente. Quem inicia a análise é o botão de
      // confirmar — nunca o diálogo, que pode fechar-se sem escolha do utilizador.
      folderGate.resolveDialog(request, folderPath)
      setPendingFolder(folderGate.pending())
    } catch (err) {
      if (!mountedRef.current) return
      setError("Erro ao abrir diálogo: " + (err instanceof Error ? err.message : String(err)))
    }
  }, [folderGate, uiStatus])

  /**
   * Confirmar analisa o caminho MOSTRADO, uma só vez. `pendingFolder` é a
   * seleção que este render pintou: se o portão já tiver outra, nada arranca.
   */
  const handleConfirmFolder = useCallback(() => {
    if (isActiveUiStatus(uiStatus) || launchLockRef.current) return
    const confirmou = confirmFolderSelection(folderGate, pendingFolder, (selection) => {
      launchScan("custom", selection.path, `Análise da pasta: ${selection.name} (todos os ficheiros dentro da pasta)`, "folder")
    })
    // Só o render que consumiu a seleção a pode tirar do ecrã. Um handler
    // antigo (seleção que já foi substituída) não apaga o que está a ser visto.
    if (confirmou) setPendingFolder(null)
  }, [folderGate, launchScan, pendingFolder, uiStatus])

  /** Cancelar/fechar/Esc: zero análises e nenhuma seleção reaproveitada. */
  const handleCancelFolder = useCallback(() => {
    folderGate.cancel()
    setPendingFolder(null)
  }, [folderGate])

  const handleCancel = useCallback(async () => {
    const id = activeScanIdRef.current
    const api = window.electronAPI
    if (!id || !api) return
    try {
      devLog(`cancel requested id=${id}`)
      // UI-D1: `cancelScan` devolve `{ success }`. Prometer "cancelamento
      // pedido" ao que foi apenas ENVIADO era o defeito — a aceitação é a
      // resposta do serviço, e uma recusa deixa o botão ativo para repetir.
      const resposta = await api.cancelScan(id)
      // Identidade antes de tudo: uma resposta de cancelamento tardia não pode
      // marcar `cancelRequested` nem escrever erro numa sessão que entretanto
      // mudou. `mounted` sozinho não chega — entre o `await` e o regresso pode
      // nascer outro scan.
      if (!mountedRef.current || activeScanIdRef.current !== id) {
        devLog(`cancel response discarded id=${id} current=${activeScanIdRef.current ?? "none"}`)
        return
      }
      const outcome = decideCancelamento(resposta)
      devLog(`cancel outcome=${outcome}`)
      if (outcome === "pedido") {
        setError("")
        setAvisoCancelar(null)
        setCancelRequested(true)
        return
      }
      // Não vai para `error`: com a análise em curso o próximo evento limpá-lo-ia.
      setAvisoCancelar(decideAvisoCancelamento(outcome))
    } catch (err) {
      // A razão técnica fica no diagnóstico; o ecrã não mostra texto interno.
      devLog("cancel request threw", err)
      if (!mountedRef.current || activeScanIdRef.current !== id) return
      setAvisoCancelar(decideAvisoCancelamento("sem_confirmacao"))
    }
  }, [])

  const clear = useCallback(() => {
    devLog("session cleared")
    setScanProgress(null)
    // Mantém o terminal como barreira contra duplicados tardios após limpar a apresentação.
    launchGenerationRef.current += 1
    // A2: uma análise nova (de qualquer cartão) descarta a seleção pendente.
    folderGate.invalidate()
    setPendingFolder(null)
    setActiveScanId(null)
    setUiStatus("idle")
    setHydrating(false)
    setError("")
    setStalled(false)
    setCancelRequested(false)
    setAvisoCancelar(null)
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
    // ENG-07: a largura passa a guardar também o facto de existir um ficheiro
    // concreto, para que a análise dirigida possa mostrar o que os motores
    // disseram DESSE ficheiro. O caminho fica em ref, nunca em estado desenhado.
    // Trocar de ficheiro invalida qualquer resposta dirigida ainda em curso.
    dirigidaRef.current.novaSelecao()
    perFilePathRef.current = filePath
    larguraRef.current = { caminho: filePath, a_confirmar: true }
    larguraTipoRef.current = "sem_leitura"
    setPerFile({ fase: "disponivel", fileName: file.name })
    // Se for uma pasta, o serviço confirma-o e a UI passa a apresentá-la como pasta.
    launchScan("custom", filePath, `Análise de: ${file.name}`, "file")
  }, [launchScan, uiStatus])

  /**
   * Análise dirigida de um ficheiro, pedida pelo utilizador. Quatro travões:
   * (a) não arranca com uma análise de pasta/ficheiro em curso; (b) a trava é
   * síncrona, por isso dois cliques no mesmo tick não enviam dois pedidos;
   * (c) a resposta só é aplicada se pertencer ainda à mesma seleção e à página
   * montada — trocar de ficheiro ou desmontar descarta a resposta tardia;
   * (d) lê `launchLockRef`, não só o estado pintado, porque entre o clique que
   * lança um scan e o render desse estado há sempre um tick — era pela janela
   * que esse pedido passava. Nenhuma recusa fica silenciosa: a razão vai ao ecrã.
   */
  const analisarFicheiroDireto = useCallback(async () => {
    const filePath = perFilePathRef.current
    if (!filePath) return
    // UI-D4: com `targetKind: "directory"` confirmado não há análise de UM
    // ficheiro a oferecer. O cartão já não mostra o botão; esta é a trava
    // síncrona para a janela entre o clique e o render.
    if (larguraTipoRef.current === "pasta") return
    const fileName = perFile.fase === "inerte" ? "" : perFile.fileName
    if (!fileName) return

    const scanFile = window.electronAPI?.scanFile
    if (typeof scanFile !== "function") {
      setPerFile({ fase: "sem_ligacao", fileName })
      return
    }

    // Nem um pedido extra com duplo clique, nem um segundo pedido por cima de
    // uma análise de pasta/ficheiro que já corre no serviço. Os três sinais são
    // lidos no instante do clique: `launchLockRef` é a verdade síncrona do
    // lançada — que `uiStatus` ainda não reflete — e `emCurso` é a do dirigida.
    const recusa = dirigidaContention({
      dirigidaEmCurso: dirigidaRef.current.emCurso,
      lancamentoEmCurso: launchLockRef.current,
      analiseAtiva: isActiveUiStatus(uiStatus),
    })
    if (recusa) {
      setError(SCAN_CONTENTION_MESSAGES[recusa])
      return
    }
    const token = dirigidaRef.current.tentarAbrir(
      launchLockRef.current || isActiveUiStatus(uiStatus),
    )
    if (token === null) return

    setPerFile({ fase: "a_analisar", fileName })
    try {
      const resposta = await scanFile(filePath)
      if (!dirigidaRef.current.pertence(token, mountedRef.current) || perFilePathRef.current !== filePath) return
      const facts = normalizeFileScanResponse(resposta)
      if (!facts || facts.length === 0) {
        setPerFile({
          fase: "sem_resposta",
          fileName,
          mensagem: "O serviço não devolveu um resultado por ficheiro: não há estado de motor para mostrar.",
        })
        return
      }
      setPerFile({ fase: "pronto", fileName, facts })
    } catch (e) {
      if (!dirigidaRef.current.pertence(token, mountedRef.current) || perFilePathRef.current !== filePath) return
      setPerFile({
        fase: "erro",
        fileName,
        mensagem: `A análise dirigida falhou: ${e instanceof Error ? e.message : "sem detalhe do serviço"}`,
      })
    } finally {
      dirigidaRef.current.fechar(token)
    }
  }, [perFile, uiStatus])

  const isActive = isActiveUiStatus(uiStatus)
  const isTerminal = isTerminalUiStatus(uiStatus)
  /**
   * O id do scan que JÁ ATINGIU terminal, derivado do estado que já existe.
   * É o único sinal que o painel recebe para se refrescar quando uma análise acaba
   * — derivado no render: não é efeito, não é temporizador, não escreve nada.
   */
  const sessaoTerminada = isTerminal ? activeScanId : null
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
  // Conclusao do PIPELINE: ficheiros com resultado terminal. NAO e' a cobertura
  // do motor de assinaturas (essa vive em `scanStage`), senao o contador ficava
  // preso em 728/800 durante toda a segunda passagem.
  //
  // NAO e' "ficheiros analisados": inclui os ignorados pelas exclusões. Daí o
  // nome `processed` e o rótulo "Ficheiros processados" — chamar-lhe analisados
  // afirmava verificações que nunca aconteceram.
  const processed = scanProgress?.filesScanned ?? 0
  const currentFile = scanProgress?.currentFile
  const hasFileActivity = processed > 0 || (scanProgress?.progress ?? 0) > 0
  // P0-A (15/10): a FONTE da percentagem da barra é declarada por
  // `scanPrimaryBar` (pipeline com trabalho fechado, etapa de assinaturas
  // enquanto o pipeline não fechou nada, ou nenhuma medição). O renderer só
  // desenha o que essa fonte diz — não decide percentagens por sua conta.
  const bar = scanPrimaryBar(scanProgress)
  // Eixo SEPARADO: o batch do ClamAV e' uma etapa do pipeline, nao o pipeline.
  const scanStage = scanAnalysisStage(scanProgress)
  const etaLabel = formatEta(scanEtaSeconds(scanProgress))
  // DECOMPOSIÇÃO do resultado: considerados = analisados + ignorados + falhados.
  // É o que responde (com números do motor) a "se eram 800, onde ficaram os
  // 137?". Sem estado do motor não há decomposição a afirmar.
  const breakdown = scanResultBreakdown(scanProgress)
  const breakdownNote = breakdown && scanProgress ? scanResultBreakdownNote(breakdown, scanProgress.status) : null
  // Linha do alvo e contador: um so dono da copy (`lib/scanSession.ts`). O
  // contador NUNCA repete a frase de fase do titulo — era essa repeticao que
  // punha «A analisar os ficheiros da pasta...» duas vezes no mesmo cartao.
  const targetLine = activeScanTarget(scope, currentFile, targetName)
  const readout = scanProgressReadout({
    scope,
    ui: uiStatus,
    percent: bar.percent,
    discovered,
    hasFileActivity,
  })

  return (
    <div className="cs-scanner-root v2-scanner p-8 space-y-8 animate-in fade-in duration-500 overflow-y-auto max-h-[calc(100vh-100px)]" data-scanner-v2="ativo">
      {/* Header */}
      <div className="cs-scanner-header">
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
                <div key={i} className="cs-scanner-skeleton h-16" />
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
              {targetLine && (
                <span className="text-sm font-mono text-foreground truncate">{targetLine}</span>
              )}
              <span className="text-sm font-mono font-bold text-primary shrink-0 ml-auto">
                {readout.label}
              </span>
            </div>
            <ScanProgressBar bar={bar} label={readout.label} />
            {/* Fases — composição `.phase-list` do laboratório, mas marcadas pelo
                que o MOTOR comunicou (`ScanState.phase`), nunca pelo relógio da
                demonstração. Sem `phase` recebida diz-se que não foi comunicada. */}
            {scanProgress && (
              <ScanPhaseList
                phase={scanProgress.phase}
                status={scanProgress.status}
                progress={scanProgress.progress}
              />
            )}
            <p className="text-xs text-muted-foreground mt-2">
              {activeScanDetail(
                scope,
                effectiveType,
                uiStatus,
                targetName,
                scanProgress?.filesInEngineBatch ?? 0,
                scanProgress?.filesAnalyzed ?? 0,
              )}
              {etaLabel ? ` ${etaLabel}.` : ""}
            </p>
            {/* Ficheiro a ser verificado AGORA, só quando o motor o reporta
                mesmo (ciclo ficheiro-a-ficheiro). Nunca inventamos um nome. */}
            {scope !== "file" && uiStatus === "scanning" && currentFile && (
              <p className="text-xs font-mono text-primary/80 mt-1 truncate" title={currentFile}>
                A analisar: {currentFile}
              </p>
            )}
            {/* Etapa de assinaturas (batch do ClamAV), no seu proprio eixo. So
                aparece quando o motor diz que ha um batch a correr: o numero e'
                o que o clamscan reportou, nunca uma animacao. */}
            {uiStatus === "scanning" && scanStage.active && (
              <p className="text-xs text-muted-foreground mt-1">
                Motor de assinaturas: {scanStage.done}/{scanStage.total} ficheiros verificados
                {scanStage.percent !== null ? ` (${scanStage.percent}%)` : ""}
              </p>
            )}
          </div>

          {/* Stats — por tipo de alvo, para não mostrar métricas sem sentido */}
          <div className={cn("grid gap-4 mb-6", scope === "file" ? "grid-cols-2 md:grid-cols-3" : "grid-cols-2 md:grid-cols-4")}>
            <div className="cs-scanner-tile">
              <div className="text-xs text-muted-foreground uppercase mb-1">
                {scope === "file"
                  ? "Ficheiro"
                  : uiStatus === "gathering"
                    ? "Ficheiros Encontrados"
                    : "Ficheiros Processados"}
              </div>
              <div className={cn("font-mono font-bold text-foreground tabular-nums", scope === "file" ? "text-sm truncate" : "text-xl")}>
                {scope === "file"
                  ? (currentFile || targetName || "—")
                  : uiStatus === "gathering"
                    ? discovered
                    : totalCandidates > 0 ? `${processed} / ${totalCandidates}` : processed}
              </div>
            </div>
            <div className="cs-scanner-tile">
              <div className="text-xs text-muted-foreground uppercase mb-1">Ameaças Encontradas</div>
              <div className="text-xl font-mono font-bold text-cyber-red tabular-nums">{scanProgress?.threatsFound ?? 0}</div>
            </div>
            {scope !== "file" && (
              <div className="cs-scanner-tile">
                <div className="text-xs text-muted-foreground uppercase mb-1">Velocidade</div>
                <div className="text-xl font-mono font-bold text-foreground tabular-nums">
                  {scanRateLabel(scanProgress)}
                </div>
              </div>
            )}
            <div className="cs-scanner-tile">
              <div className="text-xs text-muted-foreground uppercase mb-1">Tempo Decorrido</div>
              <div className="text-xl font-mono font-bold text-foreground tabular-nums">
                {scanElapsedSeconds(scanProgress)}s
              </div>
            </div>
          </div>

          {/* O «registo» escuro saiu (P0 UX, 15/10): ficava vazio durante toda a
              análise — era o segundo bloco escuro sem função no cartão — e o
              pouco que escrevia (mensagem terminal, motivos de falha) só
              acontecia quando este cartão já não estava em cena. O único facto
              vivo que ali cabia, o cancelamento, passa a ser dito aqui. */}
          {cancelRequested && (
            <p role="status" aria-live="polite" className="text-xs font-mono text-cyber-yellow">
              {SCAN_CANCEL_REQUESTED_NOTE}
            </p>
          )}
          {/* Resultado de um cancelamento que o serviço não aceitou. Estado
              próprio, não `error`: sobrevive aos eventos do motor. */}
          {avisoCancelar && (
            <p role="alert" aria-live="assertive" className="text-xs font-mono text-destructive">
              {avisoCancelar.mensagem}
            </p>
          )}
        </div>
      )}

      {/* ── RESULTADO FINAL ──────────────────────────────────────── */}
      {isTerminal && scanProgress && (() => {
        // "Concluída" ≠ "segura". Com uma ameaça, o terminar da análise é um
        // facto e a ameaça é outro — os dois têm de estar na frase e na cor.
        const { titulo, chip, tom } = terminalResultLabels(uiStatus, scanProgress);
        const concluidaComAmeacas = uiStatus === "completed" && (scanProgress.threatsFound ?? 0) > 0;
        // Os MOTIVOS das falhas, com os contadores do motor: viviam num log
        // escuro que nunca chegava a ser mostrado (este cartão substitui o
        // cartão em curso no instante terminal), por isso passam para junto do
        // resumo — uma vez, onde a pergunta «o que falhou?» é feita.
        const motivosDeFalha = (scanProgress.filesFailed ?? 0) > 0
          ? failureReasonsLabel((scanProgress as ScanStateExtended).failedByReason)
          : null;
        const motivosInconclusivos = (scanProgress.filesInconclusive ?? 0) > 0
          ? inconclusiveReasonsLabel((scanProgress as ScanStateExtended).inconclusiveByReason)
          : null;
        const tomClasse =
          tom === "green" ? "text-cyber-green" : tom === "yellow" ? "text-cyber-yellow" : "text-cyber-red";
        return (
        <div data-ton={tom} className={cn(
          "cs-scanner-result result-box cyber-border rounded-xl p-6",
          tom === "green"
            ? "bg-gradient-to-br from-cyber-green/5 to-transparent"
            : tom === "yellow"
              ? "bg-gradient-to-br from-cyber-yellow/5 to-transparent"
              : "bg-gradient-to-br from-cyber-red/5 to-transparent"
        )}>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className={cn("font-mono font-semibold", tomClasse)}>
                {titulo}
              </h3>
              <p className="text-xs text-muted-foreground">{analysisName}</p>
            </div>
            <span className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-mono uppercase border",
              concluidaComAmeacas
                ? "bg-cyber-red/10 text-cyber-red border-cyber-red/30"
                : tom === "green"
                  ? "bg-cyber-green/10 text-cyber-green border-cyber-green/30"
                  : tom === "yellow"
                    ? "bg-cyber-yellow/10 text-cyber-yellow border-cyber-yellow/30"
                    : "bg-cyber-red/10 text-cyber-red border-cyber-red/30"
            )}>
              {chip}
            </span>
          </div>

          {/* Frase-resumo explícita */}
          <div className={cn(
            "flex items-start gap-4 p-4 rounded-xl mb-4 border",
            tom === "green"
              ? "bg-cyber-green/5 border-cyber-green/20"
              : tom === "yellow"
                ? "bg-cyber-yellow/5 border-cyber-yellow/20"
                : uiStatus === "completed"
                  ? "bg-cyber-red/5 border-cyber-red/20"
                  : "cs-scanner-resumo"
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
                {conciseResultSummary({
                  scope,
                  type: effectiveType,
                  status: scanProgress.status,
                  filesConsidered: breakdown ? breakdown.considered : scanProgress.filesScanned,
                  threatsFound: scanProgress.threatsFound,
                  filesFailed: scanProgress.filesFailed,
                  filesAnalyzed: scanProgress.filesAnalyzed,
                  filesInconclusive: scanProgress.filesInconclusive,
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
              {motivosDeFalha && (
                <p className="text-xs text-muted-foreground mt-2">
                  <span className="font-semibold">Motivos das falhas: </span>
                  {motivosDeFalha}
                </p>
              )}
              {motivosInconclusivos && (
                <p className="text-xs text-muted-foreground mt-2">
                  <span className="font-semibold">Motivos dos inconclusivos: </span>
                  {motivosInconclusivos}
                </p>
              )}
              {showNoThreatsReassurance(uiStatus, scanProgress) && (
                <p className="text-xs text-muted-foreground/80 mt-2">{NO_DETECTIONS_NOTE}</p>
              )}
            </div>
          </div>

          <details className="mb-4 rounded-lg border border-border p-4">
            <summary className="cursor-pointer text-sm font-medium text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">Detalhes técnicos</summary>
            <dl className="mt-4 grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
              <div><dt className="text-muted-foreground">Considerados</dt><dd className="font-mono tabular-nums">{breakdown?.considered ?? "—"}</dd></div>
              <div><dt className="text-muted-foreground">Analisados</dt><dd className="font-mono tabular-nums">{scanProgress.filesAnalyzed ?? "—"}</dd></div>
              <div><dt className="text-muted-foreground">Inconclusivos</dt><dd className="font-mono tabular-nums">{scanProgress.filesInconclusive ?? "—"}</dd></div>
              <div><dt className="text-muted-foreground">Excluídos</dt><dd className="font-mono tabular-nums">{scanProgress.filesExcluded ?? "—"}</dd></div>
              <div><dt className="text-muted-foreground">Não foi possível analisar</dt><dd className="font-mono tabular-nums">{scanProgress.filesFailed ?? "—"}</dd></div>
            </dl>
            {breakdownNote && <p className="mt-4 text-xs text-muted-foreground">{breakdownNote}</p>}
          </details>

          {/* Duração e alvo. Os contadores de ignorados/falhados vivem agora na
              nota de reconciliação acima (uma vez, com o motivo) — repeti-los
              aqui dava duas frases para o mesmo facto. */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-muted-foreground mb-6">
            <span>
              Duração: {formatScanDurationLabel(scanProgress) ?? `${scanElapsedSeconds(scanProgress)}s`}
            </span>
            {targetName && <span className="truncate">Alvo: {targetName}</span>}
          </div>

          {/* UI-B: a nota de resultado sempre mandou o utilizador para Ameaças
              sem lhe dar como lá chegar. Com deteções medidas e um callback do
              App, o caminho existe; sem callback, não se promete nada. */}
          {onOpenThreats && (scanProgress.threatsFound ?? 0) > 0 && (
            <button
              onClick={onOpenThreats}
              className="w-full py-3 mb-3 rounded-lg border border-primary text-primary font-mono text-sm hover:bg-primary/10 transition-all"
            >
              Ver as {scanProgress.threatsFound} deteções em Ameaças
            </button>
          )}

          <button
            onClick={clear}
            className="w-full py-3 bg-primary text-primary-foreground font-mono text-sm rounded-lg hover:bg-primary/90 transition-all"
          >
              Nova análise
            </button>
          </div>
        );
      })()}

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
          <div className={cn("v2-scanner-drop", isDragging && "v2-scanner-drop--arrastando")}>
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

          {pendingFolder && (
            <div className="mb-4">
              <FolderConfirmationPanel
                selection={pendingFolder}
                onConfirm={handleConfirmFolder}
                onCancel={handleCancelFolder}
              />
            </div>
          )}

          {/* `.scan-options` do lab (grelha de cartões), adaptado: aqui os quatro
              cartões são AÇÕES que arrancam análise, não um seletor de modo, por
              isso não levam `.radio-dot` nem `aria-pressed`. */}
          <div className="scan-options grid grid-cols-1 md:grid-cols-2 gap-4">
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
                  className="scan-option cs-scanner-acao text-left p-4 hover:border-primary/50 hover:bg-primary/5 transition-all group"
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

      {/* O que os motores disseram do ficheiro concreto largado aqui. Só
          aparece depois de uma largura válida; nunca desenha resultado sem
          resposta do serviço. */}
      <PerFileEngineCard estado={perFile} scanAtivo={isActive} onAnalisar={() => void analisarFicheiroDireto()} />

      {/* Estado atual do servico; nao prova participacao dos motores na sessao. */}
      <ScanEngineState engineHealth={engineHealth} serviceConnected={serviceConnected} />

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

      {/* Terceiro bloco: o observador USB. Vive aqui, dentro de "Análise de
          Segurança", porque é uma decisão sobre o que a análise faz quando se
          liga uma unidade — não uma página à parte. */}
      <UsbProtectionPanel />

      {/* Quarto bloco da página, por baixo de tudo: o arquivo das análises que
          já terminaram. A ordem pedida é esta — iniciar, em curso, último
          resultado, e só depois o histórico. */}
      <ScanHistoryPanel sessaoTerminada={sessaoTerminada} />
    </div>
  )
}
