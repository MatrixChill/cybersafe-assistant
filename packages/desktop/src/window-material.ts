/**
 * Fundo nativo da janela (DWM backdrop — Mica/Acrylic) no Windows 11
 * (TP-WIN-01, 2026-10-17).
 *
 * O que é e o que NÃO é:
 *  - É o fundo desenhado pelo SISTEMA (`backgroundMaterial`, Electron 33.4.11,
 *    `@platform win32`), que o DWM compõe atrás da janela — inclusive atrás da
 *    área de legenda/Window Controls Overlay. Não confundir com o blur em CSS
 *    (`.liquid-bg`, `backdrop-blur`) que é responsabilidade do renderer e do
 *    Freebuff; este módulo não toca em CSS.
 *  - NÃO é `transparent: true`. Ativar transparência indiscriminadamente
 *    rebenta a composição, o clique e a acessibilidade, e expõe o desktop por
 *    baixo de superfícies por pintar. Por isso este módulo NUNCA emite
 *    `transparent`: ou aplica um material suportado, ou devolve o fundo SÓLIDO
 *    de sempre (a cor de fundo do produto), exatamente como hoje.
 *
 * Compatibilidade (fonte: `electron.d.ts`, `setBackgroundMaterial` — "supported
 * only on Windows 11 22H2 and up"). O floor NÃO é o lançamento do Windows 11
 * (21H2 = build 22000); é o 22H2 = build 22621. Por baixo disso o material é
 * ignorado pelo SO, por isso caímos no sólido.
 *
 * `applied` não é prova de runtime. Significa "pedido + SO capaz", não "o
 * utilizador vê o backdrop". O CyberSafe pinta superfícies opacas (`bg-background`
 * e a faixa da barra); uma camada opaca por cima da janela pode ocultar
 * completamente o material do DWM. Verificar que o backdrop é REALMENTE visível
 * exige observação GUI, que está fora do alcance deste módulo — nunca afirmamos
 * esse efeito a partir daqui.
 *
 * Regra de ouro: o material só é ligado quando é (a) suportado — Windows 11 22H2
 * ou mais recente — e (b) explicitamente pedido por preferência. Sem preferência,
 * ou fora dessa condição, o resultado é o fallback sólido. A correção não muda o
 * comportamento observado de ninguém sem um pedido explícito.
 *
 * Funções puras: sem Electron em runtime (apenas o tipo), sem DOM, sem chamadas
 * ao SO. Quem lê `os.release()` é o `main.ts`, para o teste correr sem abrir uma
 * janela.
 */

/** Materiais aceites pelo `BrowserWindow.backgroundMaterial` no Electron 33. */
export type BackgroundMaterial = "auto" | "none" | "mica" | "acrylic" | "tabbed";

/** Os cinco valores que o Electron aceita; nada fora disto é aplicado. */
export const VALID_BACKGROUND_MATERIALS: readonly BackgroundMaterial[] = [
  "auto",
  "none",
  "mica",
  "acrylic",
  "tabbed",
];

/** Fundo sólido do produto — a reserva quando não há (ou não se pede) material. */
export const SOLID_FALLBACK_BACKGROUND = "#090b12";

/**
 * Build mínima do Windows com suporte ao backdrop do DWM: Windows 11 22H2 =
 * 22621 (documentado pelo Electron). NÃO é 22000 (21H2), onde a API é ignorada.
 */
export const MIN_BACKDROP_MATERIAL_BUILD = 22621;

export interface WindowMaterialInput {
  /** `process.platform` (ex.: "win32"). */
  platform: string;
  /** `os.release()` (ex.: "10.0.26100"); pode faltar ou vir malformada. */
  osRelease?: string | null;
  /** Preferência explícita do utilizador; `null`/`undefined` = sem pedido. */
  requested?: BackgroundMaterial | null;
}

export type WindowMaterialReason =
  | "applied"
  | "not-win32"
  | "no-preference"
  | "explicitly-none"
  | "invalid-request"
  | "unsupported-build";

export interface WindowMaterialDecision {
  /**
   * Opções a espalhar no `new BrowserWindow(...)`. Contém SEMPRE um
   * `backgroundColor` sólido; contém `backgroundMaterial` apenas quando é
   * suportado e pedido. Nunca contém `transparent`.
   */
  options: { backgroundColor: string; backgroundMaterial?: BackgroundMaterial };
  /**
   * O material que vamos PEDIR ao SO, ou `null` (fallback sólido). Não prova
   * que o backdrop fica visível (ver cabeçalho).
   */
  applied: BackgroundMaterial | null;
  /** Build numérica extraída de `os.release()` (`null` se ilegível). */
  build: number | null;
  /** `true` quando a build tem suporte ao backdrop (>= 22621). */
  backdropSupported: boolean;
  reason: WindowMaterialReason;
}

/**
 * Extrai o build numérico de uma `os.release()` do Windows.
 * Formato real: "<major>.<minor>.<build>" (ex.: "10.0.22631"). Devolve `null`
 * para texto ilegível — a decisão de segurança é "não é suportado".
 * Um major < 10 (Windows 8/7) nunca tem material do DWM: devolve `null`.
 */
export function parseWindowsBuild(osRelease?: string | null): number | null {
  if (typeof osRelease !== "string") return null;
  const match = /^\D*(\d+)\.(\d+)\.(\d+)/.exec(osRelease.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const build = Number(match[3]);
  if (!Number.isFinite(build) || major < 10) return null;
  return build;
}

/** A build tem suporte ao backdrop do DWM? (>= 22621; ilegível conta como NÃO). */
export function isBackdropSupportedBuild(build: number | null): boolean {
  return build !== null && build >= MIN_BACKDROP_MATERIAL_BUILD;
}

function solidDecision(
  reason: WindowMaterialReason,
  build: number | null = null,
  backdropSupported = false,
): WindowMaterialDecision {
  return {
    options: { backgroundColor: SOLID_FALLBACK_BACKGROUND },
    applied: null,
    build,
    backdropSupported,
    reason,
  };
}

/**
 * Decide o fundo nativo da janela. Ver o cabeçalho: só aplica material quando
 * `win32` + Windows 11 22H2 ou mais recente + preferência explícita; caso
 * contrário, fundo sólido. `applied` é "pedido + SO capaz", nunca prova visual.
 */
export function resolveWindowMaterial(input: WindowMaterialInput): WindowMaterialDecision {
  if (input.platform !== "win32") return solidDecision("not-win32");

  const build = parseWindowsBuild(input.osRelease);
  const backdropSupported = isBackdropSupportedBuild(build);
  const requested = input.requested ?? null;

  // Sem pedido, ou pedido fora da lista: nunca inventamos um material.
  if (requested === null) return solidDecision("no-preference", build, backdropSupported);
  if (!VALID_BACKGROUND_MATERIALS.includes(requested)) {
    return solidDecision("invalid-request", build, backdropSupported);
  }
  if (requested === "none") return solidDecision("explicitly-none", build, backdropSupported);

  // Material pedido mas o sistema não o suporta: fallback sólido seguro.
  if (!backdropSupported) return solidDecision("unsupported-build", build, false);

  return {
    options: { backgroundColor: SOLID_FALLBACK_BACKGROUND, backgroundMaterial: requested },
    applied: requested,
    build,
    backdropSupported: true,
    reason: "applied",
  };
}
