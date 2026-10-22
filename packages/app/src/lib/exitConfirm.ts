/**
 * Copy e lógica pura do modal de confirmação de saída (testável sem React).
 *
 * O utilizador nunca vê detalhes internos (watcher/serviço/pipe/engine): esses
 * ficam só nos logs. Cancelar nunca encerra; ESC cancela.
 */

export const EXIT_CONFIRM_TITLE = "Sair do CyberSafe?";
export const EXIT_CONFIRM_DESCRIPTION =
  "A proteção em tempo real será encerrada neste computador.";
export const EXIT_CONFIRM_CANCEL_LABEL = "Cancelar";
export const EXIT_CONFIRM_CONFIRM_LABEL = "Sair";

/** Termos técnicos que nunca podem aparecer na copy apresentada ao utilizador. */
export const EXIT_CONFIRM_INTERNAL_TERMS = [
  "watcher",
  "updater",
  "named pipe",
  "pipe",
  "service",
  "engine",
] as const;

export type ExitConfirmAction = "cancel" | "confirm" | "none";

/**
 * Teclas do modal. ESC cancela sempre (nunca encerra); o Enter é tratado pelo
 * botão focado, e o Tab é gerido pelo focus trap.
 */
export function exitConfirmKeyAction(key: string): ExitConfirmAction {
  return key === "Escape" || key === "Esc" ? "cancel" : "none";
}

/**
 * Resposta a enviar ao processo principal: true = encerrar, false = cancelar,
 * null = nada a enviar (tecla sem efeito).
 */
export function exitConfirmResponse(action: ExitConfirmAction): boolean | null {
  if (action === "confirm") return true;
  if (action === "cancel") return false;
  return null;
}

/** Focus trap circular (Tab avança, Shift+Tab recua, sempre com wrap). */
export function nextFocusIndex(current: number, count: number, shiftKey = false): number {
  if (!Number.isInteger(count) || count <= 0) return -1;
  const known = Number.isInteger(current) && current >= 0 && current < count;
  // Sem foco conhecido, cai no primeiro botão ("Cancelar" — opção segura).
  if (!known) return 0;
  return ((shiftKey ? current - 1 : current + 1) + count) % count;
}

/** true se o texto contiver algum detalhe técnico interno. */
export function hasInternalTerms(text: string): boolean {
  const normalized = String(text ?? "").toLowerCase();
  return EXIT_CONFIRM_INTERNAL_TERMS.some((term) => normalized.includes(term));
}
