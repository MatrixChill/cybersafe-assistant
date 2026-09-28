/**
 * Fluxo de "terminar processo" (kill) do Gestor de Tarefas.
 *
 * Bug manual: ao excluir uma tarefa a página ficava preta/vazia (overlay escuro
 * preso) e a tarefa reaparecia ao voltar. Causas estruturais no renderer:
 *  - não havia timeout: se a `invoke` nunca resolvia, `isKilling` ficava `true`
 *    para sempre e o overlay `bg-background/80` nunca fechava;
 *  - não havia refetch autoritativo depois do kill: o desaparecimento da linha
 *    dependia só do evento `process.killed` + snapshot em cache.
 *
 * Este módulo isola essa lógica em funções puras/testáveis. Não remove itens da
 * lista localmente (sem remoção otimista): quem manda é o snapshot do serviço.
 * O resultado do backend é agora `ProcessKillResult` estruturado — protected,
 * timeout, reused, access-denied, alias-stub, failed e already-exited têm
 * mensagens específicas (o erro real do taskkill quando o backend o propaga).
 * Cada desfecho que mexeu no cache do serviço (killed/already-exited/timeout/
 * alias-stub/reused) obriga a um refetch: quem manda na lista é o Windows.
 */

import type { ProcessKillResult, ProcessKillStatus } from "@cybersafe/shared-types";

/**
 * Prazo máximo para o serviço responder a um pedido de kill.
 *
 * DERIVADO do orçamento do serviço (packages/service/src/engine.ts), não um
 * número solto: cada `await` do `killProcess` recebe `remaining()`, logo o
 * serviço nunca passa do orçamento — a única excepção é o reap, cuja probe pode
 * transbordar `remaining()` até ao piso (é o que lhe permite confirmar a morte
 * em vez de fabricar `still-running`). Pior caso do serviço:
 * 12 000 + 2 000 = 14 000 ms. A margem final é o que o renderer gasta ANTES do
 * relógio do serviço arrancar (invoke + pipe + fila do handler).
 *
 * Se mexeres numa destas parcelas, o contrato é verificado por
 * packages/service/test/kill-budget.test.js, que lê este ficheiro — não deixe
 * os dois lados divergir em silêncio.
 */
const KILL_SERVICE_TOTAL_BUDGET_MS = 12_000;
const KILL_REAP_FLOOR_MS = 2_000;
const KILL_PIPE_MARGIN_MS = 2_000;

export const KILL_TIMEOUT_MS = KILL_SERVICE_TOTAL_BUDGET_MS + KILL_REAP_FLOOR_MS + KILL_PIPE_MARGIN_MS;

export const KILL_UNAVAILABLE_ERROR =
  "Gestão de processos indisponível: execute a app a partir do ambiente de trabalho.";

export const KILL_FAILED_ERROR =
  "Falha ao terminar processo. Pode ser um serviço protegido do sistema.";

export const KILL_TIMEOUT_ERROR =
  "O serviço de proteção não respondeu ao pedido. O processo pode não ter sido terminado.";

export const KILL_ERROR_ERROR = "Erro ao terminar processo.";

export const KILL_PROTECTED_ERROR =
  "Processo protegido do CyberSafe/sistema: não pode ser terminado.";

export const KILL_REUSED_ERROR =
  "O PID mudou de dono (reutilizado). A terminação não foi confirmada.";

export const KILL_ACCESS_DENIED_ERROR =
  "O Windows recusou o término (acesso negado). Pode ser um processo protegido do sistema ou exigir privilégios elevados.";

export const KILL_ALREADY_EXITED_TEXT = "O processo já não estava em execução.";

/**
 * O serviço disse-nos que o PID que matámos era um stub/App Execution Alias
 * (MSIX — o Notepad do Windows 11, por exemplo) e que o processo REAL continua
 * vivo noutro PID. A mensagem do backend traz esse PID; esta constante é só a
 * rede quando ele vier sem texto.
 */
export const KILL_ALIAS_STUB_ERROR =
  "O PID terminado era apenas o lançador da app; o processo real continua vivo noutro PID.";

/** Estados do renderer: os do backend + "unavailable" (sem bridge Electron). */
export type KillStatus = ProcessKillStatus | "unavailable";

export interface KillOutcome {
  status: KillStatus;
  pid: number;
  /** `true` quando o objetivo (o processo não existir mais) foi atingido. */
  success: boolean;
  /** Mensagem pronta a mostrar (sucesso informativo ou erro); `null` se silencioso. */
  message: string | null;
}

/**
 * Converte o resultado estruturado do serviço no desfecho que a UI mostra.
 * Cada `status` tem uma mensagem própria — nada de erros genéricos.
 */
export function mapKillResult(result: ProcessKillResult | null | undefined): KillOutcome {
  if (!result || typeof result !== "object") {
    return { status: "failed", pid: 0, success: false, message: KILL_FAILED_ERROR };
  }

  const pid = typeof result.pid === "number" ? result.pid : 0;
  const backendError = typeof result.error === "string" && result.error ? result.error : null;

  switch (result.status) {
    case "killed":
      return { status: "killed", pid, success: true, message: null };
    case "already-exited":
      return { status: "already-exited", pid, success: true, message: KILL_ALREADY_EXITED_TEXT };
    case "protected":
      return { status: "protected", pid, success: false, message: KILL_PROTECTED_ERROR };
    case "timeout":
      return { status: "timeout", pid, success: false, message: backendError ?? KILL_TIMEOUT_ERROR };
    case "reused":
      return { status: "reused", pid, success: false, message: backendError ?? KILL_REUSED_ERROR };
    case "access-denied":
      return { status: "access-denied", pid, success: false, message: backendError ?? KILL_ACCESS_DENIED_ERROR };
    case "alias-stub":
      // O serviço diz que o PID que a UI mostrava morreu (ou já tinha morrido)
      // e que o processo REAL está noutro PID — a mensagem dele traz esse PID,
      // por isso é ela que se mostra, nunca um "falha genérica".
      return { status: "alias-stub", pid, success: false, message: backendError ?? KILL_ALIAS_STUB_ERROR };
    case "failed":
    default:
      return { status: "failed", pid, success: false, message: backendError ?? KILL_FAILED_ERROR };
  }
}

export interface RunKillProcessOptions {
  pid: number;
  kill: (pid: number) => Promise<ProcessKillResult>;
  /** Prazo antes de desistir e fechar o overlay. Default: {@link KILL_TIMEOUT_MS}. */
  timeoutMs?: number;
}

const TIMEOUT_SENTINEL = { timedOut: true } as const;

/**
 * Corre o kill com prazo máximo. **Nunca rejeita**: devolve sempre um
 * {@link KillOutcome}, para que quem chama possa fechar o overlay no `finally`.
 */
export async function runKillProcess({
  pid,
  kill,
  timeoutMs = KILL_TIMEOUT_MS,
}: RunKillProcessOptions): Promise<KillOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    });

    const raced = await Promise.race<unknown>([
      kill(pid).then((result) => result as unknown),
      timeout,
    ]);

    if (raced === TIMEOUT_SENTINEL) {
      return { status: "timeout", pid, success: false, message: KILL_TIMEOUT_ERROR };
    }

    return mapKillResult(raced as ProcessKillResult);
  } catch {
    return { status: "failed", pid, success: false, message: KILL_ERROR_ERROR };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Snapshot autoritativo nos desfechos em que o processo pode ter mudado:
 * `killed`/`already-exited` (a linha deve sair da lista) e `timeout` (o estado
 * real é desconhecido). `alias-stub` também: o serviço já tirou o PID morto do
 * cache e o processo REAL (outro PID) tem de aparecer. `reused`: o serviço
 * tirou a entrada do dono antigo — sem refetch a linha ficaria a mostrar um
 * processo que já não é aquele.
 * `protected`/`failed` não mexeram no processo que a UI mostrou.
 */
export function shouldRefetchAfterKill(outcome: KillOutcome): boolean {
  return (
    outcome.status === "killed" ||
    outcome.status === "already-exited" ||
    outcome.status === "timeout" ||
    outcome.status === "alias-stub" ||
    outcome.status === "reused"
  );
}

// ── Actualização da LISTA de processos (medido, não chutado) ────────────────
// Números medidos nesta máquina (Node 24, 390 processos, PowerShell + CIM):
//   · enumeração completa (topic processes.list) = 720–1085 ms, ~800 ms
//   · poll do ProcessMonitor do serviço = 648–747 ms, de 10 em 10 s
//   · evento `process.started` no arranque = 177 eventos num único poll
//
// Duas consequências, uma por constante:
// · o poll do renderer NÃO pode ser mais rápido que o do serviço: aos 5 s
//   custaria 2 enumerações por ciclo do monitor (15,6% de um core) para
//   mostrar a MESMA verdade. 10 s é a cadência a que o SO dá nova informação.
// · a janela de rajada tem de ser pequena ao ponto de ser invisível ao
//   utilizador e pequena face a uma enumeração: 250 ms é 0,3× de uma
//   enumeração (800 ms). Agrupa a rajada inteira (que cabe num poll de ~750 ms)
//   em UM pedido, sem acrescentar latência que se note.

/** Cadência do poll da lista enquanto a página de processos está aberta. */
export const PROCESSES_POLL_MS = 10_000;

/** Janela de agrupamento: uma rajada de eventos dá UM pedido de processos. */
export const PROCESSES_REFRESH_COALESCE_MS = 250;

/**
 * Eventos cujo tema é a LISTA de processos. Pedem UM pedido (processes), nunca
 * o snapshot completo de 7: um `process.started` não tem nada a dizer sobre
 * ameaças, ligações, quarentena ou PC state.
 */
export function isProcessesEvent(type: string): boolean {
  return type.startsWith("process.");
}

/** O que um evento obriga o renderer a fazer. Uma decisão, um sítio. */
export type EventRefreshRoute = "processes" | "snapshot" | "none";

/**
 * Tabela de rota de um evento de segurança. A regra é por PREFIXO, não por
 * enumeração: assim nenhum evento `process.*` pode cair em `snapshot` por
 * esquecimento de uma linha, e o invariant é verificável sem DOM.
 *
 * Porquê o prefixo: o poll inicial do serviço emite ~180 `process.started` de
 * uma vez (medido), e cada um custava um snapshot completo de 7 pedidos IPC.
 * `process.blocked` também cai aqui — passa a pedir a lista, não o snapshot
 * completo; o aviso de "bloqueado" é mostramdo na mesma, porque o toast vive
 * antes desta rota.
 */
export function resolveEventRefresh(eventType: string): EventRefreshRoute {
  if (eventType === "scan.progress") return "none";
  if (isProcessesEvent(eventType)) return "processes";
  return "snapshot";
}

export interface ProcessesRefreshGate {
  /** Já há um `getProcesses` em voo: sobrepor seria trabalho deitar fora. */
  inFlight: boolean;
  /** Janela visível: com a aba escondida não há enumeração para fazer. */
  visible: boolean;
  /** A app está a encerrar: o bridge já pode estar desligado. */
  shuttingDown: boolean;
  /** Quando foi pedido o último refresh (coalescing). */
  lastRequestedAt: number;
  now: number;
  /** `@default` PROCESSES_REFRESH_COALESCE_MS */
  coalesceMs?: number;
}

/**
 * Decide se vale a pena pedir a lista agora. Três guardas e a janela: in-flight
 * (não duplica trabalho), aba escondida, shutdown, e a janela de rajada (a
 * segunda e a terceira ondas de uma rajada esperam pela primeira).
 */
export function shouldRefreshProcessesNow(gate: ProcessesRefreshGate): boolean {
  if (gate.inFlight || !gate.visible || gate.shuttingDown) return false;
  const window = gate.coalesceMs ?? PROCESSES_REFRESH_COALESCE_MS;
  return gate.now - gate.lastRequestedAt >= window;
}

/** Tira da lista os PIDs já decididos localmente (a linha some no instante). */
export function withoutPids<T extends { pid: number }>(rows: readonly T[], pids: readonly number[]): T[] {
  if (pids.length === 0) return rows as T[];
  return rows.filter((row) => !pids.includes(row.pid));
}

/**
 * Quais das remoções locais já foram confirmadas pelo snapshot autoritativo.
 * Quando o serviço devolve a lista e o PID já lá não está, a verdade chegou:
 * a remoção local pode ser esquecida e deixa de ser um filtro permanente.
 */
export function pidsConfirmedGone(rows: readonly { pid: number }[], removed: readonly number[]): number[] {
  const present = new Set(rows.map((row) => row.pid));
  return removed.filter((pid) => !present.has(pid));
}

/**
 * O kill ficou TERMINAL para o processo? Só nestas duas a linha pode sair já:
 * `killed` (o Windows confirmou a morte) e `already-exited` (o objetivo — não
 * estar em execução — está atingido). `timeout` é desconhecido, `reused` é
 * outro processo: em nenhum dos dois se pode apagar a linha.
 */
export function isTerminalKillOutcome(outcome: KillOutcome): boolean {
  return outcome.status === "killed" || outcome.status === "already-exited";
}
