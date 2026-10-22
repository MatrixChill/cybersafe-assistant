/** Barra lateral recolhida/expandida — sobrevive ao reinício (best-effort). */
export const SIDEBAR_COLLAPSED_KEY = "cybersafe_sidebar_collapsed";

/** Só o valor "1" significa recolhida. Ausente, inválido ou sem leitura => expandida (onde tudo tem rótulo). */
export function loadSidebarCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Abaixo disto a barra expandida (16rem) tira um terço do conteúdo. */
export const SIDEBAR_AUTO_COLLAPSE_QUERY = "(max-width: 1023px)";

/**
 * Estado efetivo: em janela estreita a barra recolhe sozinha, mas o utilizador
 * pode abri-la nesse momento (`narrowOverride`) sem mudar a escolha guardada
 * para janelas largas. Contrato puro; a Sidebar ainda não o liga a matchMedia.
 */
export function effectiveCollapsed(saved: boolean, narrow: boolean, narrowOverride: boolean | null): boolean {
  if (!narrow) return saved;
  return narrowOverride ?? true;
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* sem armazenamento vale só para esta sessão */
  }
}
