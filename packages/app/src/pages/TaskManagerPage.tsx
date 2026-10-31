import { prepareIndividualTermination, confirmIndividualTermination } from "../lib/individualProcessTermination";
import SelectedProcessExplanations from "@/components/pccenter/SelectedProcessExplanations";
import { Fragment, useCallback, useEffect, useReducer, useRef, useState } from "react";
import ProcessIntelligencePanel from "../components/ProcessIntelligencePanel";
import type { ProcessDiagnostic } from "../lib/processIntelligence";
import { Activity, Shield, CircleStop, Cpu, HardDrive, AlertTriangle, AlertCircle, HelpCircle, Search, RefreshCw, X } from "lucide-react";
import type { ProcessSnapshot, ProcessAnalysisResult, ProcessKillResult, ProcessEnumerationTruth } from "@cybersafe/shared-types";
// WS-4: a orientação do processo é pura e vive em shared-types, porque o app
// só pode importar de lá.
import { buildProcessGuidance, isProtectedProcess } from "@cybersafe/shared-types";
// HORA 2: os factos do painel de detalhe (pai/filhos por ppid da lista atual,
// join de conexoes por processPid, falta de dado escrita por extenso).
import {
  buildProcessDetailFacts,
  connectionsForPid,
  formatConnectionLine,
  sameInstance,
  type DetailConnections,
  type ProcessInstance,
} from "../lib/processDetail";
// Import relativo de propósito: o alias `@/lib` só existe no Vite, e sem isto a
// página não é carregável por `tsx --test` — foi por isso que nenhum teste deste
// ficheiro conseguiu jamais renderizar o modal (o defeito de identificação vive
// aqui desde a primeira versão).
import { cn } from "../lib/utils";
import {
  avisoDeEnumeracao,
  estadoDaListaDeProcessos,
  listaDesactualizada,
  rotuloDaLinhaAntiga,
  rotuloDoEstadoDaLista,
} from "../lib/processListState";
import {
  KILL_UNAVAILABLE_ERROR,
  pidsConfirmedGone,
  PROCESSES_POLL_MS,
  processRecommendationMeta,
  runKillRequest,
  type KillRequestGate,
  withoutPids,
  type KillOutcome,
} from "../lib/processActions";

type SortKey = "cpu" | "mem" | "name";

/**
 * Ordem estável. Comparar apenas pela métrica deixava a lista saltar sob o
 * cursor a cada refresh: dois processos com o mesmo CPU (ou 0, o caso normal
 * quando a enumeração ainda não mediu) ficavam empatados e a ordem do empate
 * dependia da ordem de entrada do snapshot. Nome + PID desempateiam de forma
 * determinística — o desenho não muda, o salto é que acaba.
 */
export function sortProcesses(list: ProcessSnapshot[], sortBy: SortKey): ProcessSnapshot[] {
  return [...list].sort((a, b) => {
    if (sortBy === "cpu" && a.cpu !== b.cpu) return b.cpu - a.cpu;
    if (sortBy === "mem" && a.memoryMb !== b.memoryMb) return b.memoryMb - a.memoryMb;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.pid - b.pid;
  });
}

export interface KillSequenceDeps {
  pid: number;
  kill: (pid: number) => Promise<ProcessKillResult>;
  /** Snapshot autoritativo do App. Já é tolerante a falha por si — não se engole aqui nada. */
  refresh: () => Promise<unknown> | void;
  /** Entrega o desfecho ao ecrã (aviso). */
  onOutcome: (outcome: KillOutcome) => void;
  /** Fecha o overlay/isKilling. */
  onFinish: () => void;
  timeoutMs?: number;
  /**
   * Guarda síncrona do fluxo. Obrigatória em produção (é o que garante
   * 1 confirmação = 1 request); opcional aqui só para os testes antigos
   * puderem chamar sem a montar.
   */
  gate?: KillRequestGate;
}

/**
 * Sequência do kill. A ordem é o bug: o overlay escuro (que cobre e escurece
 * toda a área principal) fechava no `finally`, **depois** de `await` do
 * refetch — e esse refetch é o `fetchSnapshot` completo do App, com
 * `getProcesses` a enumerar o SO outra vez. Resultado: ecrã preto durante o
 * kill (até 15 s de prazo) MAIS uma enumeração por cima, com o processo já
 * morto.
 *
 * Aqui o overlay fecha assim que o kill é terminal e o refetch autoritativo
 * continua em segundo plano: a UI resolve cedo, os dados corrigem-se a seguir.
 *
 * É agora uma delegação fina a `runKillRequest`, que é onde vive a guarda de
 * duplo envio. Houve um momento em que esta função ficava fora do caminho real
 * (a página chamava `runKillProcess` direto) e os testes continuavam a cobri-la
 * — ou seja, testes a cobrir código morto. Delegar deixa UM caminho só, e os
 * testes existentes continuam a cobrir o que a página faz.
 */
export async function runKillSequence(deps: KillSequenceDeps): Promise<KillOutcome> {
  return runKillRequest({
    pid: deps.pid,
    kill: deps.kill,
    refresh: deps.refresh,
    onOutcome: deps.onOutcome,
    onFinish: deps.onFinish,
    timeoutMs: deps.timeoutMs,
    // Guarda por defeito para as chamadas sem `gate` (testes antigos). É
    // descartada a cada chamada, logo não barra chamadas seguidas — é o
    // `killRequestGate` partilhado da página que garante 1 = 1.
    gate: deps.gate ?? { inFlight: false },
  });
}

/** Legacy tree termination remains denied; only the pinned individual protocol is used. */
export const QUERY_MODE_BADGE = "Terminação individual limitada — aplicações comuns elegíveis; sujeita a confirmação";

interface TaskManagerPageProps {
  processes: ProcessSnapshot[];
  diagnostic?: ProcessDiagnostic;
  onExplainProcess?: (pid?: number, startedAt?: string | null) => void;
  /**
   * Refetch autoritativo da LISTA (dono do estado é o App). É o caminho
   * só-processos: um `getProcesses`, nunca o snapshot completo de 7 tópicos —
   * que mede 720–1085 ms contra os 0–1 ms dos outros seis.
   */
  onRefreshProcesses?: () => Promise<void> | void;
  /**
   * Estado da ligação ao serviço. `null` = ainda desconhecido.
   * Sem isto a página não consegue distinguir "não há processos" de
   * "não houve resposta" — e dizia a primeira quando só tinha a segunda.
   */
  serviceConnected?: boolean | null;
  /** Instante da última leitura VÁLIDA do snapshot; `null` = nunca houve. */
  processesObservedAt?: number | null;
  /**
   * O que o serviço afirma sobre a enumeração (P1-PROCESS-TRUTH). Sem isto a
   * página tem de adivinhar pela contagem de linhas — e uma enumeração que
   * rebentou chega com zero linhas, exatamente como «não há processos».
   */
  processTruth?: ProcessEnumerationTruth | null;
  /** Um pedido da lista está em voo agora. */
  aEnumerar?: boolean;
}

/**
 * HOTFIX P0 — o alvo do kill é CONGELADO no clique.
 *
 * Bug reproduzido: o modal derivava o alvo da lista viva
 * (`processes.find(p => p.pid === killingPid)`). O Notepad moderno é um MSIX
 * App Execution Alias (stub + processo real com o mesmo timestamp); quando o
 * stub morria, o serviço tombstoneava esse PID e a lista deixava de o conter →
 * `killTarget` passava a `null`, o modal desaparecia em silêncio com
 * `killingPid` definido, e o clique seguinte no mesmo PID fazia `setKillingPid`
 * com o mesmo número → bailout por Object.is, sem re-render, sem kill enviado.
 * A ordem/refresh passa a ser IRRELEVANTE para o alvo: o alvo é um valor.
 */
export interface KillTarget {
  pid: number;
  name: string;
  user?: string;
  memoryMb: number;
  startedAt?: string;
}

export type KillSource = "filtered" | "unfiltered";

export interface KillState {
  target: KillTarget | null;
  /** Incrementado pelo reducer a cada seleção; identidade da ação para o trace. */
  actionId: number;
  source: KillSource;
}

export const initialKillState: KillState = { target: null, actionId: 0, source: "unfiltered" };

export type KillEvent =
  | { type: "select"; target: KillTarget; source: KillSource }
  | { type: "clear" }
  /** Limpa só se a seleção corrente for a desta ação (kills concorrentes). */
  | { type: "clearStale"; actionId: number };

/** Reducer puro: é a única coisa que decide quem é o alvo, e é testável sem DOM. */
export function killReducer(state: KillState, event: KillEvent): KillState {
  switch (event.type) {
    case "select":
      return { target: event.target, actionId: state.actionId + 1, source: event.source };
    case "clear":
      return { target: null, actionId: state.actionId, source: state.source };
    case "clearStale":
      return state.actionId === event.actionId ? { ...state, target: null } : state;
  }
}

/**
 * Normaliza no boundary. `ProcessSnapshot` declara `memoryMb: number`, mas o
 * valor atravessa JSON e o tipo não vale nada no runtime — e o JSX do modal
 * chamava `target.memoryMb.toFixed(0)`, que com `undefined` é um TypeError em
 * render. Aqui o alvo passa a ser sempre dados seguros; o modal deixa de ter de
 * confiar em quem o chamou.
 */
export function freezeKillTarget(p: ProcessSnapshot): KillTarget {
  const pid = Number.isFinite(Number(p?.pid)) ? Number(p.pid) : 0;
  return {
    pid,
    name: p?.name == null ? "" : String(p.name),
    user: typeof p?.user === "string" && p.user.length > 0 ? p.user : undefined,
    memoryMb: Number.isFinite(p?.memoryMb) ? Number(p.memoryMb) : 0,
  };
}

/**
 * Formatação segura: nunca chamar métodos sobre um valor que pode não ser
 * número. `null`/`undefined`/`NaN` são "sem leitura" (`n/d`) e não zero — zero
 * MB seria uma leitura falsa. A normalização do alvo (freezeKillTarget) é que
 * decide o valor canónico; isto é só a última linha de defesa do JSX.
 */
export function formatMemoryMb(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(0) : "n/d";
}

/** Mesma razão para o CPU — a ROW também chamava .toFixed(1) direto no snapshot. */
export function formatCpu(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "n/d";
}

/**
 * Limpa o alvo só se a seleção corrente ainda for a deste kill. Sem isto, um
 * kill em curso (até 12 s) que termine depois de o utilizador ter escolhido
 * outra linha apagava a escolha nova — o modal sumia sem aviso nem IPC.
 */
export function killStaleGuard(state: KillState, startedActionId: number): KillState {
  return state.actionId === startedActionId ? killReducer(state, { type: "clear" }) : state;
}

/** De onde veio o pedido — só para o trace, nunca para decidir o alvo. */
export function killSourceFor(searchTerm: string): KillSource {
  return searchTerm.trim().length > 0 ? "filtered" : "unfiltered";
}

/**
 * Traço de diagnóstico TEMPORÁRIO do hotfix. `DEV_TRACE` é falso em produção
 * (o Vite define `import.meta.env.PROD` no build) e também falso fora do Vite,
 * por ex. em `tsx --test`. Não escreve em ficheiro nem fala com o serviço; um
 * `console.log` por EVENTO (nunca por render). Para remover: apagar esta
 * constante, o `trace()` e as suas quatro chamadas.
 */
const DEV_TRACE = !(import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD;
export const TM_KILL_TRACE_ENABLED = DEV_TRACE;

interface KillTraceFields {
  actionId: number;
  source: KillSource;
  rowPid?: number;
  rowName?: string;
  /** Valor BRUTO e tipo do que veio do serviço — foi isto que rebentou o render. */
  rowMemoryMb?: unknown;
  rowMemoryMbType?: string;
  selectedPid?: number;
  selectedName?: string;
  modalPid?: number | null;
  handlerPid?: number | null;
  isKilling?: boolean;
  ok?: boolean;
  status?: string;
  message?: string | null;
  listContainsPidAfter?: boolean;
}

export function traceKill(event: string, fields: KillTraceFields): void {
  if (!DEV_TRACE) return;
  console.log("[TM-KILL]", { event, ...fields });
}

export default function TaskManagerPage({
  processes,
  onRefreshProcesses,
  diagnostic,
  onExplainProcess,
  serviceConnected = null,
  processesObservedAt = null,
  processTruth = null,
  aEnumerar = false,
}: TaskManagerPageProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<"cpu" | "mem" | "name">("cpu");
  const [analyzingPid, setAnalyzingPid] = useState<number | null>(null);
  const [analysisResult, setAnalysisResult] = useState<ProcessAnalysisResult | null>(null);
  // Fonte única do badge (ver `processActions.ts`): "inconclusivo" nunca pode
  // cair no ramo verde do "safe".
  const recommendationMeta = processRecommendationMeta(analysisResult?.recommendation);
  const [isKilling, setIsKilling] = useState(false);
  /**
   * Guarda SÍNCRONA do pedido de kill, à parte do `isKilling` acima.
   *
   * `isKilling` vive no estado do React, e o estado só chega ao botão no
   * re-render seguinte. Dois cliques no MESMO turno passam ambos pelo botão
   * ainda habilitado e cada um despacha um pedido de kill. O `ref` não tem
   * essa latência: escreve-se e lê-se no mesmo instante.
   *
   * `isKilling` continua a existir e o `disabled` continua no botão: são a
   * segunda camada e o que o utilizador VÊ. Este ref é o que garante.
   */
  const killRequestGate = useRef<KillRequestGate>({ inFlight: false });
  /** Aviso da última tentativa de kill — mostrado fora do overlay (que fecha sempre). */
  const [killNotice, setKillNotice] = useState<{ message: string; ok: boolean } | null>(null);
  /** Aviso da última análise de processo — mesmo padrão que o killNotice. */
  const [analyzeNotice, setAnalyzeNotice] = useState<{ message: string; ok: boolean } | null>(null);

  /** Alvo congelado no clique + ação corrente. Nada disto vem da lista. */
  const [kill, setKill] = useReducer(killReducer, initialKillState);
  const { target: killTarget, actionId: killActionId, source: killSource } = kill;
  const terminationTicket = useRef<string | null>(null);
  const preparingTermination = useRef(false);
  const terminationMounted = useRef(true);
  const [isPreparingTermination, setIsPreparingTermination] = useState(false);
  useEffect(() => { terminationMounted.current=true; return () => {
    terminationMounted.current=false;
    const ticket=terminationTicket.current;
    terminationTicket.current=null;
    if(ticket) void window.electronAPI?.cancelProcessTermination(ticket).catch(()=>{});
  }; }, []);

  /**
   * Linhas que o serviço JÁ confirmou mortas (`killed`) ou que já não estavam
   * em execução (`already-exited`): saem no instante, sem esperar pela ida e
   * volta. O refetch autoritativo continua a correr e, quando chega, a verdade
   * substitui o filtro — se o snapshot ainda trouxer o PID (o SO ainda não
   *Actualizou, ou o serviço confirmou por outro caminho) a linha volta, que é
   * o comportamento honesto: só se apaga o que se sabe que já não existe.
   */
  const [removedPids, setRemovedPids] = useState<number[]>([]);
  // WS-4: painel de detalhe por processo (expander na propria linha).
  // F1: a identidade e a INSTANCIA (pid + startedAt), nunca o PID sozinho —
  // o Windows empresta números e um PID reutilizado é outro processo.
  const [detail, setDetail] = useState<ProcessInstance | null>(null);
  /** Índice da linha removida: onde o foco tem de ir quando ela desaparece. */
  const pendingFocusIndex = useRef<number | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  /**
   * HORA 2: ligacoes do processo em detalhe. Le-se do serviço UMA vez por
   * selecao (topico `connections` ja existe no IPC; o join por processPid e
   * cliente-side). F1/F2: o resultado guarda a INSTANCIA a que pertence e a
   * HORA da leitura — um resultado velho de uma selecao anterior, ou de uma
   * vida anterior do mesmo PID, nunca se cola ao painel do processo novo.
   */
  const [detailConnections, setDetailConnections] = useState<{ instance: ProcessInstance; data: DetailConnections } | null>(null);

  // O painel abre-se para uma instancia; se ela sai da lista (terminada) OU o
  // mesmo PID aparece com outro startedAt (PID reutilizado = processo novo), o
  // detalhe FECHA-se — nunca se re-aponta em silencio nem herda factos alheios.
  useEffect(() => {
    if (detail && !processes.some((p) => sameInstance(p, detail))) {
      setDetail(null);
    }
  }, [detail, processes]);

  useEffect(() => {
    if (!detail) {
      setDetailConnections(null);
      return;
    }
    const api = window.electronAPI;
    if (!api) {
      setDetailConnections({ instance: detail, data: { status: "unavailable" } });
      return;
    }
    let cancelled = false;
    setDetailConnections({ instance: detail, data: { status: "loading" } });
    api.getConnections()
      .then((conns) => {
        if (cancelled) return;
        setDetailConnections({
          instance: detail,
          data: {
            status: "ready",
            connections: connectionsForPid(conns, detail.pid),
            // F2: a lista e um snapshot. Diz-se a hora em que foi lida.
            readAt: new Date().toLocaleTimeString("pt-PT"),
          },
        });
      })
      .catch(() => {
        if (!cancelled) setDetailConnections({ instance: detail, data: { status: "unavailable" } });
      });
    return () => {
      cancelled = true;
    };
  }, [detail]);

  /**
   * Selecionar uma linha congela o alvo inteiro. Se o PID sair da lista a seguir
   * (foi exatamente o que o stub do Notepad fazia), o modal fica igual e o
   * terminal continua a apontar para o PID que o utilizador escolheu.
   */
  const selectKillTarget = useCallback(async (row: ProcessSnapshot) => {
    if(preparingTermination.current || terminationTicket.current || killRequestGate.current.inFlight) return;
    const api=window.electronAPI;
    if(!api?.prepareProcessTermination || !row.startedAt) {
      setKillNotice({message:"Terminação indisponível: falta ligação ou instante de criação confirmado.",ok:false});return;
    }
    preparingTermination.current=true;setIsPreparingTermination(true);setKillNotice(null);
    try {
      const prepared=await prepareIndividualTermination(api,{pid:row.pid,startedAt:row.startedAt});
      if(!terminationMounted.current) {if(prepared?.ok)void api.cancelProcessTermination(prepared.ticket).catch(()=>{});return;}
      if(!prepared?.ok) {setKillNotice({message:prepared?.error??"Não foi possível validar o processo.",ok:false});return;}
      terminationTicket.current=prepared.ticket;
      setKill({type:"select",target:{...freezeKillTarget(row),...prepared.target},source:killSourceFor(searchTerm)});
    } catch {
      setKillNotice({message:"Falha de ligação ao serviço; nenhuma confirmação foi enviada.",ok:false});
    } finally {preparingTermination.current=false;setIsPreparingTermination(false);}
  }, [searchTerm]);

  const clearKillTarget = useCallback(() => {
    const ticket=terminationTicket.current;terminationTicket.current=null;
    if(ticket) void window.electronAPI?.cancelProcessTermination(ticket).catch(()=>{});
    setKill({type:"clear"});
  }, []);

  // HOTFIX (DEV only): uma linha por render com o modal montado. Se o sintoma
  // voltar, uma única reprodução diz se o render do card chegou a acontecer e
  // se o PID ainda estava na lista — o que separa estado perdido de crash.
  if (DEV_TRACE && killTarget) {
    traceKill("render", {
      actionId: killActionId,
      source: killSource,
      modalPid: killTarget.pid,
      isKilling,
      listContainsPidAfter: processes.some((p) => p.pid === killTarget.pid),
    });
  }

  // Filter and sort processes
  const visibleProcesses = withoutPids(processes, removedPids);
  const filteredProcesses = sortProcesses(
    visibleProcesses.filter(
      (p) => p.name.toLowerCase().includes(searchTerm.toLowerCase()) || p.pid.toString().includes(searchTerm),
    ),
    sortBy,
  );
  /**
   * O que a lista PODE dizer. Só uma resposta válida com zero processos
   * autoriza "Nenhum processo encontrado"; serviço desligado, primeira leitura
   * pendente, filtro sem resultados e leitura antiga têm textos próprios.
   */
  const estadoDaLista = estadoDaListaDeProcessos({
    total: processes.length,
    visiveis: filteredProcesses.length,
    pesquisa: searchTerm,
    servicoLigado: serviceConnected,
    observadoEm: processesObservedAt,
    verdade: processTruth,
    aEnumerar,
  });
  const rotuloDaLista = rotuloDoEstadoDaLista(estadoDaLista);
  const listaAntiga = listaDesactualizada({
    total: processes.length,
    servicoLigado: serviceConnected,
    observadoEm: processesObservedAt,
  });
  /**
   * A falha de enumeração é um aviso SOBRE a tabela, não o conteúdo da área
   * vazia: com linhas antigas em ecrã, `estadoDaLista` é `ok` e a falha
   * desapareceria sem o segundo eixo.
   */
  const avisoEnum = avisoDeEnumeracao(processTruth, processes.length);

  /**
   * A verdade chegou: os PIDs que o snapshot autoritativo já não traz podem ser
   * esquecidos, e o filtro local deixa de ser um estado próprio.
   */
  useEffect(() => {
    const confirmed = pidsConfirmedGone(processes, removedPids);
    if (confirmed.length === 0) return;
    setRemovedPids((prev) => prev.filter((pid) => !confirmed.includes(pid)));
  }, [processes, removedPids]);

  /**
   * Acessibilidade: quando a linha que tinha o foco desaparece, o browser deixa
   * o foco no `body` e o teclado perde-se a meio de uma sessão de kill de
   * processos. Passa o foco ao botão de ação da linha seguinte (ou à anterior,
   * se for a última; e ao campo de pesquisa se a lista ficar vazia).
   */
  useEffect(() => {
    const index = pendingFocusIndex.current;
    if (index === null) return;
    pendingFocusIndex.current = null;
    const active = typeof document !== "undefined" ? document.activeElement : null;
    // O utilizador já mudou de foco entretanto: não se mexe.
    if (active && active !== document.body) return;
    const actions = Array.from(
      rowsRef.current?.querySelectorAll<HTMLElement>("[data-row-action]") ?? [],
    );
    const target = actions[Math.min(index, actions.length - 1)] ?? searchRef.current;
    target?.focus();
  });

const handleAnalyze = async (pid: number) => {
    setAnalyzingPid(pid);
    setAnalysisResult(null);
    setAnalyzeNotice(null);
    try {
      const api = window.electronAPI;
      if (!api) {
        setAnalyzeNotice({ message: "Análise de processos indisponível: a API do ambiente de trabalho não está disponível.", ok: false });
        return;
      }
      const result = await api.analyzeProcess(pid);
      setAnalysisResult(result);
    } catch (e) {
      console.error(e);
      setAnalyzeNotice({ message: "Falha ao analisar processo: verifique a ligação ao serviço.", ok: false });
    } finally {
      setAnalyzingPid(null);
    }
  };

  /** Refetch autoritativo (ignora falhas: o snapshot seguinte corrige). */
  const refreshProcesses = useCallback(async () => {
    if (!onRefreshProcesses) return;
    try {
      await onRefreshProcesses();
    } catch (e) {
      console.error(e);
    }
  }, [onRefreshProcesses]);

  const handleKill = async () => {
    // O PID é o que foi congelado no clique. Não volta a ser derivado da lista —
    // era aí que o modal desaparecia quando o stub do Notepad saía do snapshot.
    const target = killTarget;
    if (!target || !terminationTicket.current) return;
    const actionId = killActionId;
    const listContainsPid = () => processes.some((p) => p.pid === target.pid);

    const api = window.electronAPI;
    if (!api) {
      setKillNotice({ message: KILL_UNAVAILABLE_ERROR, ok: false });
      setIsKilling(false);
      setKill({ type: "clearStale", actionId });
      traceKill("result", {
        actionId,
        source: killSource,
        handlerPid: target.pid,
        modalPid: target.pid,
        ok: false,
        status: "unavailable",
        message: KILL_UNAVAILABLE_ERROR,
        listContainsPidAfter: listContainsPid(),
      });
      return;
    }

    setIsKilling(true);
    setKillNotice(null);
    traceKill("confirm", {
      actionId,
      source: killSource,
      selectedPid: target.pid,
      selectedName: target.name,
      modalPid: target.pid,
      handlerPid: target.pid,
    });

    try {
      // O overlay fecha no instante em que o kill passa a terminal; o refetch
      // autoritativo corre em segundo plano (ver runKillSequence).
      const outcome = await runKillSequence({
        pid: target.pid,
        gate: killRequestGate.current,
        kill: async () => {
          const ticket=terminationTicket.current;
          terminationTicket.current=null; // No retry after IPC uncertainty.
          if(!ticket) return {success:false,status:"failed",pid:target.pid,error:"Confirmação ausente."};
          return confirmIndividualTermination(api,ticket,target.pid);
        },
        refresh: refreshProcesses,
        onOutcome: (o) => {
          if (o.message) setKillNotice({ message: o.status === "killed" ? "Processo terminado pelo CyberSafe; saída confirmada." : o.message, ok: o.success });
          // Refetch the authoritative list. Never hide by PID alone: a new
          // process may already have reused it after the confirmed object exited.
        },
        onFinish: () => {
          setIsKilling(false);
          // Só limpa ESTA seleção: se o utilizador escolheu outra linha entretanto
          // (kill demora até 12 s), apagar-lhe a escolha era o modal a sumir sózinho.
          setKill({ type: "clearStale", actionId });
        },
      });
      // `listContainsPidAfter` lê o snapshot desta render — o refresh de
      // background ainda não cá chegou; serve para comparar select vs result.
      traceKill("result", {
        actionId,
        source: killSource,
        handlerPid: target.pid,
        modalPid: target.pid,
        ok: outcome.success,
        status: outcome.status,
        message: outcome.message,
        listContainsPidAfter: listContainsPid(),
      });
    } finally {
      // Rede de segurança, não máscara: se a entrega do desfecho falhar pelo
      // meio, o overlay continua garantido que fecha (nunca fica preso).
      setIsKilling(false);
      setKill({ type: "clearStale", actionId });
    }
  };

  return (
    <div className="p-8 h-full flex flex-col space-y-6 animate-in fade-in duration-500 relative">
      <div className="flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">
            Gestor de <span className="text-primary">Tarefas</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Gestão avançada de processos e análise
          </p>
          {/* Eligibility is confirmed by the service, not inferred from a row. */}
          <p
            data-query-mode-badge
            className="mt-2 inline-flex items-center gap-2 rounded bg-secondary/60 px-2 py-1 text-xs font-mono text-muted-foreground"
          >
            <CircleStop className="w-3.5 h-3.5" />
            {QUERY_MODE_BADGE}
          </p>
          {isPreparingTermination && <p role="status" aria-live="polite" className="mt-2 text-xs text-muted-foreground">A validar a identidade e as permissões do processo… nenhuma terminação foi solicitada.</p>}
          {/* Honestidade: isto é uma actualização automática com temporizador,
              não "tempo real" — o serviço é que descobre as mudanças, de 10 em
              10 s. Dizer "tempo real" seria uma promessa que o código não cumpre. */}
          <p className="text-muted-foreground/70 text-xs font-mono mt-1">
            Actualização automática a cada {PROCESSES_POLL_MS / 1000} s
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Pesquisar processo..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 pr-4 py-2 bg-secondary/50 border border-border rounded-lg text-sm font-mono focus:outline-none focus:border-primary/50 text-foreground w-64 transition-all"
            />
          </div>
          <div className="bg-secondary/50 rounded-lg p-1 flex">
            <button
              onClick={() => setSortBy("cpu")}
              className={cn("px-3 py-1.5 text-xs font-mono rounded", sortBy === "cpu" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/50")}
            >
              CPU
            </button>
            <button
              onClick={() => setSortBy("mem")}
              className={cn("px-3 py-1.5 text-xs font-mono rounded", sortBy === "mem" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary/50")}
            >
              RAM
            </button>
          </div>
        </div>
      </div>

      {avisoEnum && (
        <div role="alert" className="shrink-0 flex items-start gap-3 rounded-xl border border-cyber-red/40 bg-cyber-red/10 px-4 py-3">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-cyber-red" />
          <p className="text-sm font-mono text-foreground">
            <span className="font-semibold">{avisoEnum.titulo}. </span>
            {avisoEnum.detalhe}
          </p>
        </div>
      )}

      {listaAntiga && (
        <div className="shrink-0 flex items-start gap-3 rounded-xl border border-cyber-yellow/40 bg-cyber-yellow/10 px-4 py-3">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-cyber-yellow" />
          <p className="text-sm font-mono text-foreground">
            {rotuloDaLinhaAntiga({ servicoLigado: serviceConnected })}
          </p>
        </div>
      )}

      <ProcessIntelligencePanel diagnostic={diagnostic} onExplain={onExplainProcess} />

      {killNotice && (
        <div className={cn(
          "shrink-0 flex items-start gap-3 rounded-xl border px-4 py-3",
          killNotice.ok ? "border-cyber-green/40 bg-cyber-green/10" : "border-cyber-red/40 bg-cyber-red/10",
        )}>
          <AlertCircle className={cn("w-5 h-5 shrink-0 mt-0.5", killNotice.ok ? "text-cyber-green" : "text-cyber-red")} />
          <p className="flex-1 text-sm font-mono text-foreground">{killNotice.message}</p>
          <button
            onClick={() => setKillNotice(null)}
            className="text-muted-foreground hover:text-foreground shrink-0"
            title="Fechar aviso"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {analyzeNotice && (
        <div className={cn(
          "shrink-0 flex items-start gap-3 rounded-xl border px-4 py-3",
          analyzeNotice.ok ? "border-cyber-green/40 bg-cyber-green/10" : "border-cyber-red/40 bg-cyber-red/10",
        )}>
          <AlertCircle className={cn("w-5 h-5 shrink-0 mt-0.5", analyzeNotice.ok ? "text-cyber-green" : "text-cyber-red")} />
          <p className="flex-1 text-sm font-mono text-foreground">{analyzeNotice.message}</p>
          <button
            onClick={() => setAnalyzeNotice(null)}
            className="text-muted-foreground hover:text-foreground shrink-0"
            title="Fechar aviso"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="cyber-border rounded-xl flex-1 overflow-hidden flex flex-col">
        <div className="grid grid-cols-12 gap-4 items-center p-4 border-b border-border/50 bg-sidebar/50 text-xs font-mono font-semibold text-muted-foreground uppercase tracking-wider shrink-0">
          <div className="col-span-4">Nome do Processo</div>
          <div className="col-span-2 text-center">PID</div>
          <div className="col-span-2 text-center flex items-center justify-center gap-1"><Cpu className="w-3 h-3" /> CPU</div>
          <div className="col-span-2 text-center flex items-center justify-center gap-1"><HardDrive className="w-3 h-3" /> Memória</div>
          <div className="col-span-2 text-right">Ações</div>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-hide" ref={rowsRef}>
          {filteredProcesses.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground space-y-3 px-8 text-center">
              {rotuloDaLista?.carregando ? (
                <RefreshCw className="w-10 h-10 opacity-40 animate-spin" aria-hidden="true" />
              ) : estadoDaLista.kind === "sem-resposta" ? (
                <AlertTriangle className="w-10 h-10 opacity-40 text-cyber-yellow" aria-hidden="true" />
              ) : (
                <Activity className="w-12 h-12 opacity-20" aria-hidden="true" />
              )}
              <p className="font-mono text-sm">{rotuloDaLista?.titulo ?? "Nenhum processo encontrado"}</p>
              {rotuloDaLista && <p className="font-mono text-xs opacity-70 max-w-md">{rotuloDaLista.detalhe}</p>}
            </div>
          ) : (
            <div className="flex flex-col p-2 space-y-1">
              {filteredProcesses.map((process) => {
                // R7: isto significa "protegido", nao "critico". O nome antigo
                // dizia uma coisa que o codigo nao fazia.
                const isProtected = isProtectedProcess(process);
                // WS-4: a cor e o pulso vem da PRIORIDADE calculada, nunca do
                // numero de CPU. CPU alta sozinha e trabalho normal.
                const guidance = buildProcessGuidance(process);
                const isDetailOpen = sameInstance(process, detail);

                return (
                  <Fragment key={process.pid}>
                  <div className="grid grid-cols-12 gap-4 items-center p-3 rounded-lg hover:bg-secondary/50 border border-transparent hover:border-border transition-all group">
                    <div className="col-span-4 flex items-center gap-3 min-w-0">
                      <button
                        onClick={() => setDetail(isDetailOpen ? null : { pid: process.pid, startedAt: process.startedAt })}
                        aria-expanded={isDetailOpen}
                        data-row-detail={process.pid}
                        title="Ver detalhe do processo"
                        className="shrink-0"
                      >
                        <span className={cn("w-2 h-2 rounded-full block",
                          guidance.priority === "urgent" ? "bg-cyber-red animate-pulse" :
                          guidance.priority === "worth-noting" ? "bg-cyber-yellow" : "bg-cyber-cyan"
                        )} />
                      </button>
                      <div className="truncate flex flex-col min-w-0">
                        <span className="font-mono text-sm text-foreground truncate">{process.name}</span>
                        {process.user && <span className="text-[10px] text-muted-foreground truncate">{process.user}</span>}
                        {onExplainProcess && <button type="button"
                          onClick={() => onExplainProcess(process.pid, process.startedAt)}
                          aria-label={`Explicar ${process.name} na MATRIX`}
                          className="self-start text-xs text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                          Explicar na MATRIX
                        </button>}
                      </div>
                    </div>
                    <div className="col-span-2 text-center text-xs font-mono text-muted-foreground">{process.pid}</div>
                    <div className="col-span-2 text-center">
                      <span
                        title={guidance.meaning}
                        className={cn("text-xs font-mono px-2 py-1 rounded bg-black/20",
                          guidance.priority === "urgent" ? "text-cyber-red" : "text-foreground")}
                      >
                        {formatCpu(process.cpu)}%
                      </span>
                    </div>
                    <div className="col-span-2 text-center text-xs font-mono text-muted-foreground">
                      {formatMemoryMb(process.memoryMb)} MB
                    </div>
                    <div className="col-span-2 flex justify-end gap-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleAnalyze(process.pid)}
                        disabled={analyzingPid === process.pid}
                        className="p-2 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
                        title="Investigar Processo"
                      >
                        {analyzingPid === process.pid ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => selectKillTarget(process)}
                        disabled={isProtected || isPreparingTermination || isKilling || !process.startedAt}
                        data-row-action={process.pid}
                        className={cn("p-2 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed",
                          "bg-secondary/60 text-muted-foreground hover:bg-secondary")}
                        aria-label={isProtected
                          ? "Processo protegido: o Windows precisa dele"
                          : "Verificar elegibilidade e terminar este processo"}
                        title={isProtected ? "Processo protegido: o Windows precisa dele" : "Verificar elegibilidade e terminar este processo"}
                      >
                        <CircleStop className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  {isDetailOpen && (
                    <ProcessDetailPanel
                      process={process}
                      allProcesses={processes}
                      connections={
                        detailConnections && sameInstance(detailConnections.instance, detail) && sameInstance(detail, process)
                          ? detailConnections.data
                          : { status: "loading" }
                      }
                    />
                  )}
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Analysis Modal — `fixed` como todos os overlays do projeto */}
      {analysisResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-2xl cyber-border border-primary/50 bg-card rounded-2xl shadow-2xl flex flex-col overflow-hidden">
            <div className="p-4 border-b border-border/50 flex justify-between items-center bg-secondary/50">
              <div className="flex items-center gap-3">
                <Shield className="w-5 h-5 text-primary" />
                <h2 className="font-mono font-bold">Relatório de Análise</h2>
              </div>
              <button onClick={() => setAnalysisResult(null)} className="text-muted-foreground hover:text-foreground">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 space-y-6 overflow-y-auto max-h-[70vh]">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xl font-mono font-bold text-primary">{analysisResult.process.name}</h3>
                  <p className="text-xs font-mono text-muted-foreground mt-1">PID: {analysisResult.process.pid} | Caminho: {analysisResult.process.path}</p>
                </div>
                <div className={cn("px-4 py-2 rounded-lg border font-mono uppercase text-sm flex items-center gap-2",
                  recommendationMeta.tone === "danger" ? "bg-cyber-red/10 border-cyber-red/30 text-cyber-red" :
                  recommendationMeta.tone === "warn" ? "bg-cyber-yellow/10 border-cyber-yellow/30 text-cyber-yellow" :
                  recommendationMeta.tone === "safe" ? "bg-cyber-green/10 border-cyber-green/30 text-cyber-green" :
                  "bg-muted/10 border-border text-muted-foreground"
                )}>
                  {recommendationMeta.tone === "danger" && <AlertTriangle className="w-4 h-4" />}
                  {recommendationMeta.tone === "warn" && <AlertCircle className="w-4 h-4" />}
                  {recommendationMeta.tone === "safe" && <Shield className="w-4 h-4" />}
                  {recommendationMeta.tone === "unknown" && <HelpCircle className="w-4 h-4" />}
                  {recommendationMeta.label}
                </div>
              </div>

              {analysisResult.fileScan && (
                <div className="space-y-2">
                  <h4 className="text-sm font-mono text-muted-foreground uppercase tracking-wider">Heurística Local</h4>
                  <div className="p-4 rounded-lg bg-secondary/30 border border-border space-y-3">
                     <div className="flex justify-between items-center text-sm font-mono">
                        <span className="text-muted-foreground">Severidade</span>
                        <span className={analysisResult.fileScan.overallSeverity === "low" ? "text-cyber-green" : "text-cyber-red"}>{analysisResult.fileScan.overallSeverity.toUpperCase()}</span>
                     </div>
                     <div className="flex justify-between items-center text-sm font-mono">
                        <span className="text-muted-foreground">Pontuação de Risco</span>
                        <span>{analysisResult.fileScan.riskScore}/100</span>
                     </div>
                     {analysisResult.fileScan.rulesTriggered.length > 0 && (
                        <div className="text-xs font-mono mt-2 flex flex-wrap gap-2">
                          {analysisResult.fileScan.rulesTriggered.map((r: string) => (
                             <span key={r} className="px-2 py-1 bg-secondary/50 rounded border border-border">{r}</span>
                          ))}
                        </div>
                     )}
                  </div>
                </div>
              )}

              {analysisResult.virusTotal && (
                <div className="space-y-2">
                  <h4 className="text-sm font-mono text-muted-foreground uppercase tracking-wider border-t border-border pt-4 flex justify-between items-center">
                    <span>Inteligência VirusTotal</span>
                    <span className="text-xs normal-case">{new Date(analysisResult.virusTotal.scanDate).toLocaleString()}</span>
                  </h4>
                  <div className="p-4 rounded-lg bg-[#0e1adb]/10 border border-[#0e1adb]/30 space-y-4">
                     <div className="flex justify-between items-center text-sm font-mono">
                        <span className="text-muted-foreground">Detecções</span>
                        <span className={analysisResult.virusTotal.positives > 0 ? "text-cyber-red font-bold" : "text-cyber-green"}>
                          {analysisResult.virusTotal.positives} / {analysisResult.virusTotal.total} motores
                        </span>
                     </div>
                     
                     {analysisResult.virusTotal.positives > 0 && (
                       <div className="space-y-2">
                         <p className="text-[10px] text-muted-foreground uppercase">Principais Motores:</p>
                         <div className="grid grid-cols-2 gap-2">
                           {analysisResult.virusTotal.engines.slice(0, 6).map((engine: import("@cybersafe/shared-types").VirusTotalEngine) => (
                             <div key={engine.name} className="p-2 rounded bg-black/40 border border-cyber-red/20 text-xs font-mono flex flex-col">
                               <span className="text-muted-foreground">{engine.name}</span>
                               <span className="text-cyber-red truncate">{engine.result}</span>
                             </div>
                           ))}
                         </div>
                       </div>
                     )}
                     <div className="flex justify-end pt-2">
                        <a href={analysisResult.virusTotal.permalink} target="_blank" rel="noreferrer" 
                           className="text-xs font-mono text-primary hover:underline flex items-center gap-1">
                           Ver relatório completo ↗
                        </a>
                     </div>
                  </div>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-border/50 bg-secondary/30 flex justify-end gap-3">
              <button 
                onClick={() => setAnalysisResult(null)}
                className="px-4 py-2 font-mono text-sm rounded bg-secondary/50 hover:bg-secondary transition-colors"
              >
                Fechar
              </button>
              {analysisResult.recommendation !== "safe" && !analysisResult.isCritical && (
                 <span
                   className="px-4 py-2 font-mono text-xs rounded bg-secondary/40 text-muted-foreground"
                   data-query-mode={analysisResult.process.pid}
                 >
                   {QUERY_MODE_BADGE}
                 </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Kill Confirmation Modal — o alvo vem do estado congelado, nunca da lista */}
      {killTarget && (
        <KillConfirmModal
          target={killTarget}
          isKilling={isKilling}
          onCancel={() => {
            traceKill("cancel", {
              actionId: killActionId,
              source: killSource,
              selectedPid: killTarget.pid,
              selectedName: killTarget.name,
              modalPid: killTarget.pid,
              handlerPid: null,
            });
            clearKillTarget();
          }}
          onConfirm={handleKill}
        />
      )}
    </div>
  );
}

interface ProcessDetailPanelProps {
  process: ProcessSnapshot;
  /** Lista atual do cliente — fonte dos filhos e do pai derivados por `ppid`. */
  allProcesses: ProcessSnapshot[];
  connections: DetailConnections;
}

/**
 * HORA 2 — painel de detalhe: DADO → SIGNIFICADO → PRIORIDADE → AÇÃO, sem IA
 * inventada. Exportado para renderizar em teste sem jsdom (mesmo padrão do
 * `KillConfirmModal`). Não lê `signer`/`hash`/`trusted`: em produção esses
 * campos nunca vêm ou são sempre "neutral", e mostrá-los seria dar valor a
 * dado que não existe.
 */
export function ProcessDetailPanel({ process, allProcesses, connections }: ProcessDetailPanelProps) {
  const guidance = buildProcessGuidance(process);
  const facts = buildProcessDetailFacts(process, allProcesses);
  return (
    <div
      data-row-detail-panel={process.pid}
      className="mt-2 mb-3 ml-5 p-4 rounded-lg border border-border bg-black/20 flex flex-col gap-3 text-xs"
    >
      <div className="flex flex-col gap-1">
        <span className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground">Dados do processo</span>
        <span className="font-mono text-muted-foreground">Nome: <span className="text-foreground">{process.name}</span></span>
        <span className="font-mono text-muted-foreground">PID: <span className="text-foreground">{process.pid}</span></span>
        <span className="font-mono text-muted-foreground">Caminho: <span className="text-foreground">{facts.pathText}</span></span>
        <span className="font-mono text-muted-foreground">CPU: <span className="text-foreground">{formatCpu(process.cpu)}%</span> · Memória: <span className="text-foreground">{formatMemoryMb(process.memoryMb)} MB</span></span>
        <span className="font-mono text-muted-foreground">Processo pai: <span className="text-foreground">{facts.parentText}</span></span>
        <span className="font-mono text-muted-foreground">Filhos: <span className="text-foreground">{facts.childrenText}</span></span>
        <span className="font-mono text-muted-foreground">Estado: <span className={facts.protectionText.startsWith("Protegido") ? "text-cyber-yellow" : "text-foreground"}>{facts.protectionText}</span></span>
        {connections.status === "loading" && (
          <span className="font-mono text-muted-foreground">Ligações: <span className="text-foreground">a ler…</span></span>
        )}
        {connections.status === "unavailable" && (
          <span className="font-mono text-muted-foreground">Ligações: <span className="text-foreground">indisponíveis (sem leitura do serviço)</span></span>
        )}
        {connections.status === "ready" && connections.connections.length === 0 && (
          <span className="font-mono text-muted-foreground">
            Ligações: <span className="text-foreground">sem ligações TCP associadas{connections.readAt ? ` (leitura das ${connections.readAt})` : ""}</span>
          </span>
        )}
        {connections.status === "ready" && connections.connections.length > 0 && (
          <>
            <span className="font-mono text-muted-foreground">
              Ligações: <span className="text-foreground">{connections.connections.length} associada{connections.connections.length === 1 ? "" : "s"}{connections.readAt ? ` (leitura das ${connections.readAt})` : ""}</span>
            </span>
            {connections.connections.slice(0, 8).map((c, i) => (
              <span key={`${c.remoteAddress}-${c.remotePort ?? "na"}-${c.direction}-${i}`} className="font-mono text-muted-foreground pl-2">{formatConnectionLine(c)}</span>
            ))}
          </>
        )}
      </div>

      <SelectedProcessExplanations processo={process} protegido={isProtectedProcess(process)} />

      <div className="flex flex-col gap-1">
        <span className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground">O que é</span>
        <span className="text-foreground">{guidance.what}</span>
        <span className="text-muted-foreground">{guidance.role}</span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground">Dado</span>
        {guidance.evidence.map((linha) => (
          <span key={linha} className="font-mono text-muted-foreground">{linha}</span>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground">Significado</span>
        <span className="text-muted-foreground">{guidance.meaning}</span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground">Prioridade</span>
        <span className={cn(
          "font-mono font-bold uppercase",
          guidance.priority === "urgent" ? "text-cyber-red"
            : guidance.priority === "worth-noting" ? "text-cyber-yellow"
            : "text-cyber-green",
        )}>
          {guidance.priority === "urgent" ? "Atenção — sinal a rever"
            : guidance.priority === "worth-noting" ? "Vale a pena ver"
            : "Nada a assinalar"}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground">Pode fechar</span>
        <span className="text-muted-foreground">{guidance.safeToCloseReason}</span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground">Orientação</span>
        <span className="text-foreground">{guidance.guidance}</span>
      </div>
    </div>
  );
}

interface KillConfirmModalProps {
  /** Alvo congelado. O modal não sabe nem precisa de saber o que a lista contém. */
  target: KillTarget;
  isKilling: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Exportado para poder ser renderizado em teste sem jsdom: a pagina inteira nao
 * abre o modal (e estado interno), e foi exatamente por isso que o defeito de
 * identificacao sobreviveu a todas as revisoes anteriores.
 */
export function KillConfirmModal({ target, isKilling, onCancel, onConfirm }: KillConfirmModalProps) {
  // Nenhum acesso abaixo pode chamar métodos sobre valor possivelmente ausente:
  // o nome é lido como string, a memória passa por formatMemoryMb.
  const name = typeof target.name === "string" ? target.name : "";
  const memoryText = formatMemoryMb(target.memoryMb);
  return (
    // Overlay `fixed`, não `absolute`: este modal vive dentro do contentor
    // scrollável da página (`p-8 h-full ... relative`). Com `absolute inset-0`
    // ficava preso à caixa do conteúdo — quando a lista ultrapassava o ecrã, o
    // card era centrado fora da área visível: o clique registava-se, o estado
    // comitava, o escuro pintava a página e o card nunca aparecia, sem crash e
    // sem IPC (e a sidebar, irmã deste contentor, ficava normal). Os outros
    // três modais do projeto usam `fixed inset-0`; este era o único exceção.
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in">
      <div onKeyDown={event => {
        if(event.key==="Escape" && !isKilling){event.preventDefault();onCancel();}
        if(event.key==="Tab") {
          const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const first=buttons[0],last=buttons.at(-1);
          if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
          else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
        }
      }} role="alertdialog" aria-modal="true" aria-label="Confirmar terminação individual" className="w-full max-w-sm cyber-border border-cyber-red/50 bg-card rounded-2xl shadow-lg p-6 text-center space-y-6">
        <div className="w-16 h-16 rounded-full bg-cyber-red/10 border border-cyber-red/30 mx-auto flex items-center justify-center">
          <AlertTriangle className="w-8 h-8 text-cyber-red animate-pulse" />
        </div>
        <div>
          <h2 className="text-lg font-mono font-bold text-foreground">Terminar este processo?</h2>
          {/* O processo identificado é o dado mais importante deste ecrã: sem
              nome nem PID, confirmar era um voto cego — e a lista reordena. */}
          <div
            data-testid="kill-target"
            className="mt-3 rounded-lg border border-cyber-red/30 bg-cyber-red/5 px-3 py-2 text-left"
          >
            <span className="block text-sm font-mono font-bold text-foreground truncate" title={name}>
              {name || "(sem nome)"}
            </span>
            <span className="block text-[11px] font-mono text-muted-foreground">
              PID {target.pid}
              {target.startedAt ? ` · criado em ${target.startedAt}` : ""}
              {target.user ? ` · ${target.user}` : ""}
              {` · ${memoryText} MB`}
            </span>
          </div>
          <p className="text-sm font-mono text-muted-foreground mt-2">
            Só este processo será terminado. Os processos filhos não serão terminados. Pode perder dados não guardados; guarde o trabalho antes de confirmar.
          </p>
        </div>
        {isKilling && (
          <p className="text-xs font-mono text-muted-foreground" data-testid="kill-progress">
            A terminar processo… a lista atualiza-se sozinha a seguir; o aviso diz o que aconteceu.
          </p>
        )}
        <div className="flex gap-3 justify-center">
          <button
            disabled={isKilling}
            autoFocus
            onClick={onCancel}
            className="flex-1 px-4 py-2 font-mono text-sm rounded bg-secondary/50 hover:bg-secondary transition-colors"
          >
            Cancelar
          </button>
          <button
            disabled={isKilling}
            onClick={onConfirm}
            className="flex-1 px-4 py-2 font-mono text-sm rounded bg-cyber-red text-white hover:bg-cyber-red/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isKilling ? <RefreshCw className="w-4 h-4 animate-spin" /> : "Sim, Terminar"}
          </button>
        </div>
      </div>
    </div>
  );
}

