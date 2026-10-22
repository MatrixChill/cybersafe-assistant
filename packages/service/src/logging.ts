/**
 * Registo duravel das RECUSAS de kill.
 *
 * Porque este ficheiro existe: uma recusa nunca chegava ao `actions.log`. O
 * `logKillAttempt` do engine corre DEPOIS de `runTaskkill`, e a recusa acontece
 * ANTES — entre o `console.warn` e o primeiro taskkill nao havia nada escrito.
 * Quando um utilizador clica "Terminar" e o processo nao morre, a unica prova
 * vivia num `console.warn` efemero. Foi por isso que o diagnostico do falso
 * positive `internal` so foi possivel indo ao processo enquanto vivia.
 *
 * Nao se escreveu um debounce, um contador nem um debgger: escreve-se a linha
 * de cada recusa, com o mesmo formato para as cinco razoes, para se poderem
 * comparar e agregar.
 *
 * PRIVACIDADE: a linha de comando NAO e escrita. O caminho chega (precisa para
 * diagnosticar qual executavel era); a command line pode conter argumentos com
 * segredos, tokens ou caminhos de utilizador que nao servem para nada aqui.
 */
import type { ProcessKillProtectionReason } from "@cybersafe/shared-types";

/** Quem pediu o kill. O auto-kill nao passa pelo `killProcess`, mas o campo
 *  existe desde ja para que os registos antigos e novos se comparem. */
export type KillRequestKind = "manual" | "auto";

/** O minimo do alvo necessario para identificar uma recusa sem dados a mais. */
export interface KillBlockedSubject {
  pid: number;
  name?: string;
  path?: string;
  ppid?: number;
}

function campo(valor: string | number | undefined): string {
  // `n/a` e mais honesto do que um campo vazio: o registo fica legivel e
  // Grep/parse nao tem de adivinhar o que faltava.
  if (valor === undefined || valor === null || valor === "") return "n/a";
  return String(valor);
}

/**
 * Formato unico, SAME para as cinco razoes:
 *
 *   <timestamp> | [KILL-BLOCKED] | Req=<id> | Request=manual | PID=... |
 *   Name=... | Path=... | PPID=... | Classification=<classifyKillTarget devolveu
 *   isto> | ProtectedReason=... | Result=blocked
 *
 * `Classification` e a MESMA coisa que `ProtectedReason` aqui, e fica porque o
 * registo tem de ser legivel por quem nao sabe a arvore do codigo: um so
 * campo diria "algo o bloqueou" sem dizer o que.
 */
export function formatKillBlockedLine(options: {
  timestamp: string;
  request: KillRequestKind;
  /**
   * Id de correlação: identifica UM pedido de kill.
   *
   * É a peça que separa "quatro pedidos reais" de "o mesmo pedido registado
   * quatro vezes". Quatro linhas com quatro `Req=` diferentes são quatro
   * pedidos; quatro linhas com o mesmo `Req=` são um pedido escrito quatro
   * vezes. Sem isto, a pergunta das 4 repetições é um palpite.
   */
  requestId: string;
  subject: KillBlockedSubject;
  reason: ProcessKillProtectionReason;
}): string {
  const { timestamp, request, requestId, subject, reason } = options;
  return [
    timestamp,
    "[KILL-BLOCKED]",
    `Req=${campo(requestId)}`,
    `Request=${request}`,
    `PID=${campo(subject.pid)}`,
    `Name=${campo(subject.name)}`,
    `Path=${campo(subject.path)}`,
    `PPID=${campo(subject.ppid)}`,
    `Classification=${reason}`,
    `ProtectedReason=${reason}`,
    "Result=blocked",
  ].join(" | ");
}
