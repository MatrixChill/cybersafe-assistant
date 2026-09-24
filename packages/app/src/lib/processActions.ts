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
 * timeout, reused, failed e already-exited têm mensagens específicas.
 */

import type { ProcessKillResult, ProcessKillStatus } from "@cybersafe/shared-types";

/** Prazo máximo para o serviço responder a um pedido de kill. */
export const KILL_TIMEOUT_MS = 15_000;

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

export const KILL_ALREADY_EXITED_TEXT = "O processo já não estava em execução.";

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
 * real é desconhecido). `protected`/`reused`/`failed` não mexeram no processo.
 */
export function shouldRefetchAfterKill(outcome: KillOutcome): boolean {
  return (
    outcome.status === "killed" ||
    outcome.status === "already-exited" ||
    outcome.status === "timeout"
  );
}
