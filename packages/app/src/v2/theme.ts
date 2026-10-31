/**
 * EIXOS V2 — a identidade do Design Lab V2 como fonte única do aspeto.
 *
 * O lab define seis escolhas independentes (`v2/src/Appearance.tsx`): tema,
 * material, movimento, desempenho e WebGL. A app já tinha quatro eixos próprios
 * (identidade, modo claro/escuro, destaque, superfície). Este módulo não soma
 * eixos: o tema V2 substitui identidade + modo, o material substitui superfície,
 * e a projeção para os atributos antigos existe só enquanto houver CSS de V1
 * vivo. Quando a última página migrar, `applyLegacyProjection` morre.
 *
 * Nada aqui lê armazenamento sem proteção: `localStorage` pode lançar no
 * arranque (política de site, `file://`, quota), e uma exceção antes do React
 * abriria a app em branco.
 */

import {
  APPARANCE_IDENTITY_KEY,
  APPARANCE_SURFACE_KEY,
  APPARANCE_THEME_KEY,
  type AppIdentity,
} from "../lib/appearance";

export type V2Theme =
  | "core"
  | "neon"
  | "terminal"
  | "aurora"
  | "belbete"
  | "glass"
  | "tactical"
  | "light";

export type V2Material = "solid" | "light" | "frosted" | "liquid" | "advanced";
export type V2Movement = "off" | "reduced" | "balanced" | "cinematic";
export type V2Performance = "economy" | "balanced" | "high" | "auto";

export interface V2Preferences {
  theme: V2Theme;
  material: V2Material;
  movement: V2Movement;
  performance: V2Performance;
  webgl: boolean;
}

/** Ordem de apresentação — é também a numeração «01 / IDENTIDADE» das Configurações. */
export const V2_THEME_ORDER: readonly V2Theme[] = [
  "core",
  "neon",
  "terminal",
  "aurora",
  "belbete",
  "glass",
  "tactical",
  "light",
];

export const V2_THEME_META: Record<V2Theme, { name: string; subtitle: string }> = {
  core: { name: "Núcleo", subtitle: "Precisão institucional. Ciano sobre azul profundo." },
  neon: { name: "Neon", subtitle: "Energia violeta, luz ciano e detalhes magenta." },
  terminal: { name: "Terminal", subtitle: "Fósforo, grelha e rigor monoespaçado." },
  aurora: { name: "Líquido / Aurora", subtitle: "Luz difusa, vidro e cores em suspensão." },
  belbete: { name: "Belbete Red Velvet", subtitle: "Bordô aveludado, cacau profundo e camadas de marfim." },
  glass: { name: "Cyber Glass", subtitle: "Profundidade, luz e precisão." },
  tactical: { name: "Cyber Tactical", subtitle: "Informação em primeiro plano." },
  light: { name: "Cyber Light Pro", subtitle: "Clareza em qualquer ambiente." },
};

export const V2_MATERIAL_ORDER: readonly V2Material[] = ["solid", "light", "frosted", "liquid", "advanced"];
export const V2_MATERIAL_LABELS: Record<V2Material, string> = {
  solid: "Sólido",
  light: "Vidro leve",
  frosted: "Frosted Glass",
  liquid: "Liquid Glass",
  advanced: "Liquid Glass avançado",
};

export const V2_MOVEMENT_ORDER: readonly V2Movement[] = ["off", "reduced", "balanced", "cinematic"];
export const V2_MOVEMENT_LABELS: Record<V2Movement, string> = {
  off: "Desativado",
  reduced: "Reduzido",
  balanced: "Equilibrado",
  cinematic: "Cinematográfico",
};

export const V2_PERFORMANCE_ORDER: readonly V2Performance[] = ["economy", "balanced", "high", "auto"];
export const V2_PERFORMANCE_LABELS: Record<V2Performance, string> = {
  economy: "Económico",
  balanced: "Equilibrado",
  high: "Qualidade elevada",
  auto: "Automático",
};

export const V2_PREFERENCES_KEY = "cybersafe_appearance_v2";
export const DEFAULT_V2_PREFERENCES: V2Preferences = {
  theme: "core",
  material: "liquid",
  movement: "balanced",
  performance: "auto",
  webgl: true,
};

/**
 * Migração do registo antigo. A chave `cybersafe_theme` gravava identidade
 * (ex.: «cybersafe-liquid»); `theme` gravava o modo. Um modo claro anterior não
 * pode ser ignorado: quem escolha claro desde sempre não aceita acordar em
 * escuro, por isso `theme="light"` ganha sobre a identidade.
 */
const IDENTITY_TO_V2: Record<string, V2Theme> = {
  "cybersafe-core": "core",
  "cybersafe-neon": "neon",
  "matrix-terminal": "terminal",
  "cybersafe-liquid": "aurora",
  "cybersafe-red-belbete": "belbete",
};

/**
 * Superfície antiga → material. Os três valores de V1 vivem dentro dos cinco de
 * V2 sem inventar nada: `solid` é sólido, `reduced` é o vidro leve (o acabamento
 * sem custo do desfoque forte) e `glass` é o Liquid Glass que a identidade
 * Líquido prometia. O caminho de volta (`v2ToLegacy`) é o inverso exato, por
 * isso uma preferência guardada em V1 volta a marcar o mesmo botão.
 */
const SURFACE_TO_MATERIAL: Record<string, V2Material> = {
  solid: "solid",
  glass: "liquid",
  reduced: "light",
  liquid: "liquid",
  frosted: "frosted",
  advanced: "advanced",
};

export function isV2Theme(value: unknown): value is V2Theme {
  return typeof value === "string" && V2_THEME_ORDER.includes(value as V2Theme);
}
export function isV2Material(value: unknown): value is V2Material {
  return typeof value === "string" && V2_MATERIAL_ORDER.includes(value as V2Material);
}
export function isV2Movement(value: unknown): value is V2Movement {
  return typeof value === "string" && V2_MOVEMENT_ORDER.includes(value as V2Movement);
}
export function isV2Performance(value: unknown): value is V2Performance {
  return typeof value === "string" && V2_PERFORMANCE_ORDER.includes(value as V2Performance);
}

/** Um valor inválido não herda o valor gravado: volta ao por omissão desse eixo. */
function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && allowed.includes(raw as T) ? (raw as T) : fallback;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): StorageLike | null {
  try {
    const s = globalThis.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function readRaw(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** true = ficou gravado. Quem chama não pode afirmar persistência com false. */
function writeRaw(key: string, value: string): boolean {
  // Sem Storage não há escrita possível: `?.` deixaria devolver `true` sobre um
  // `undefined.setItem` nunca chamado. A afirmação de persistência tem de falhar
  // quando não existe onde persistir.
  const alvo = storage();
  if (!alvo) return false;
  try {
    alvo.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export interface LegacyAppearance {
  identity?: unknown;
  mode?: unknown;
  surface?: unknown;
}

/** O registo de V1, lido com a mesma defesa de `lib/appearance`. */
function readLegacyAppearance(): LegacyAppearance {
  return {
    identity: readRaw(APPARANCE_IDENTITY_KEY),
    mode: readRaw(APPARANCE_THEME_KEY),
    surface: readRaw(APPARANCE_SURFACE_KEY),
  };
}

/**
 * Preferências V2. O JSON próprio (`cybersafe_appearance_v2`) manda; na sua
 * ausência reconstrói-se a escolha a partir do registo de V1, para que um
 * utilizador existente não perca o aspeto com que estava habituado.
 */
export function readV2Preferences(legacy: LegacyAppearance = readLegacyAppearance()): V2Preferences {
  const stored = readRaw(V2_PREFERENCES_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<Record<keyof V2Preferences, unknown>>;
      if (parsed && typeof parsed === "object") {
        return {
          theme: pick(parsed.theme, V2_THEME_ORDER, DEFAULT_V2_PREFERENCES.theme),
          material: pick(parsed.material, V2_MATERIAL_ORDER, DEFAULT_V2_PREFERENCES.material),
          movement: pick(parsed.movement, V2_MOVEMENT_ORDER, DEFAULT_V2_PREFERENCES.movement),
          performance: pick(parsed.performance, V2_PERFORMANCE_ORDER, DEFAULT_V2_PREFERENCES.performance),
          webgl: typeof parsed.webgl === "boolean" ? parsed.webgl : DEFAULT_V2_PREFERENCES.webgl,
        };
      }
    } catch {
      /* JSON partido: decide o valor por omissão, nunca um eixo a meio. */
    }
  }

  const legacyIdentity = typeof legacy.identity === "string" ? IDENTITY_TO_V2[legacy.identity] : undefined;
  const legacySurface = typeof legacy.surface === "string" ? SURFACE_TO_MATERIAL[legacy.surface] : undefined;
  return {
    /* V2 tem UM tema claro e sete escuros: «neon + claro» não cabe numa só
       escolha, e alguma coisa se perde. A regra é a da evidência de escolha:
       uma identidade que não é a por omissão foi escolhida, e escolhas
       explícitas conservam-se — o claro fica a um clique da galeria. Quando só
       está guardado o modo claro com a identidade por omissão, não há escolha
       de identidade a respeitar: o modo é a única evidência, e perde-se por
       ele. */
    theme:
      legacyIdentity && !(legacyIdentity === "core" && legacy.mode === "light")
        ? legacyIdentity
        : legacy.mode === "light"
          ? "light"
          : (legacyIdentity ?? DEFAULT_V2_PREFERENCES.theme),
    material: legacySurface ?? DEFAULT_V2_PREFERENCES.material,
    movement: DEFAULT_V2_PREFERENCES.movement,
    performance: DEFAULT_V2_PREFERENCES.performance,
    webgl: DEFAULT_V2_PREFERENCES.webgl,
  };
}

/**
 * O número de processadores lógicos é o que o lab usa para o perfil automático.
 * É uma aproximação declarada, não uma medição: a app tem telemetria real, e a
 * substituição por medição é trabalho pendente, não segredo deste módulo.
 */
export function logicalCpuCount(): number {
  try {
    const n = globalThis.navigator?.hardwareConcurrency;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export interface V2Derived {
  /** true = há movimento contínuo; falsos desligam órbitas, aurora e transições. */
  animate: boolean;
  /** true = o pedido permite WebGL; cada cena confirma ainda a disponibilidade. */
  gpu: boolean;
  /** false com `performance: "auto"` num máquina pequena. */
  lowPower: boolean;
  /** Cap de densidade de píxeis para shaders/partículas. */
  renderDpr: number;
  systemReduced: boolean;
}

export function systemPrefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/**
 * `systemReduced` entra por parâmetro quando o chamador tem o valor em estado
 * (o `AppearanceContext`), e é lido do sistema quando não tem. Sem o parâmetro,
 * um `useMemo` dependente só das preferências recomputava capacidades antigas
 * quando a preferência do sistema mudava — os atributos do `<html>` ficavam a
 * descrever o estado anterior do sistema.
 */
export function deriveV2Capabilities(p: V2Preferences, systemReduced?: boolean): V2Derived {
  const cpus = logicalCpuCount();
  const lowPower = p.performance === "economy" || (p.performance === "auto" && cpus > 0 && cpus <= 4);
  const reduzido = systemReduced ?? systemPrefersReducedMotion();
  return {
    animate: !reduzido && p.movement !== "off" && p.movement !== "reduced" && !lowPower,
    gpu: p.webgl && !lowPower,
    lowPower,
    renderDpr: p.performance === "high" ? 1.5 : 1,
    systemReduced: reduzido,
  };
}

/** Projeção para o CSS de V1 que ainda lê `data-theme`/`data-surface`. */
const V2_TO_LEGACY_IDENTITY: Record<V2Theme, AppIdentity> = {
  core: "cybersafe-core",
  neon: "cybersafe-neon",
  terminal: "matrix-terminal",
  aurora: "cybersafe-liquid",
  belbete: "cybersafe-red-belbete",
  glass: "cybersafe-liquid",
  tactical: "cybersafe-core",
  light: "cybersafe-core",
};

/** O inverso de `SURFACE_TO_MATERIAL`, com o perfil económico por cima. */
function legacySurface(material: V2Material, lowPower: boolean): "solid" | "glass" | "reduced" {
  if (material === "solid") return "solid";
  if (lowPower || material === "light") return "reduced";
  return "glass";
}

/**
 * A projeção que o CSS de V1 ainda lê. Vive num só sítio para que o provider
 * de aparência não tenha de saber mapeamentos: `lib/appearance.writeAppearance`
 * recebe este objeto e escreve `data-theme`/`data-surface`/`dark`.
 */
export interface LegacyProjection {
  theme: "dark" | "light";
  identity: AppIdentity;
  surface: "solid" | "glass" | "reduced";
}

export function v2ToLegacy(p: V2Preferences, caps = deriveV2Capabilities(p), systemReduced?: boolean): LegacyProjection {
  // `lowPower` decide o acabamento legado; vem das capacidades já calculadas.
  void systemReduced;
  return {
    theme: p.theme === "light" ? "light" : "dark",
    identity: V2_TO_LEGACY_IDENTITY[p.theme],
    surface: legacySurface(p.material, caps.lowPower),
  };
}

/**
 * Efeitos de eixo lidos do DOM. `applyV2Appearance` escreve atributos, não
 * decide cores: quem pinta é `src/v2/tokens.css` + `src/v2/bridge.css`.
 */
export function applyV2Appearance(p: V2Preferences = readV2Preferences(), systemReduced?: boolean): void {
  const root = document.documentElement;
  const caps = deriveV2Capabilities(p, systemReduced);
  root.setAttribute("data-v2-theme", p.theme);
  root.setAttribute("data-v2-material", p.material);
  root.setAttribute("data-v2-movement", p.movement);
  root.setAttribute("data-v2-performance", p.performance);
  root.setAttribute("data-v2-webgl", String(caps.gpu));
  /* Os dois travões estruturais que o lab usa no CSS. */
  root.setAttribute("data-reduced", String(!caps.animate));
  root.setAttribute("data-solid", String(p.material === "solid" || caps.lowPower));
}

/** Aplica e tenta guardar. `false` = aplicada nesta sessão, não persistida. */
export function writeV2Preferences(p: V2Preferences, systemReduced?: boolean): boolean {
  applyV2Appearance(p, systemReduced);
  return writeRaw(V2_PREFERENCES_KEY, JSON.stringify(p));
}
