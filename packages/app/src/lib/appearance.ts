export type AppIdentity = "cybersafe-core" | "cybersafe-neon" | "matrix-terminal" | "cybersafe-liquid" | "cybersafe-red-belbete";
export type ThemeMode = "dark" | "light";
export type AccentMode = "cyan" | "matrix-green" | "blue" | "purple" | "pink" | "amber" | "red-wine";

export const APPARANCE_IDENTITY_KEY = "cybersafe_theme";
export const APPARANCE_THEME_KEY = "theme";
export const DEFAULT_IDENTITY: AppIdentity = "cybersafe-core";

function isAppIdentity(value: unknown): value is AppIdentity {
  return typeof value === "string" && IDENTITY_ORDER.includes(value as AppIdentity);
}

export function isAccent(value: unknown): value is AccentMode {
  return (
    value === "cyan" ||
    value === "matrix-green" ||
    value === "blue" ||
    value === "purple" ||
    value === "pink" ||
    value === "amber" ||
    value === "red-wine"
  );
}

/* ── Acesso defensivo ao Storage ───────────────────────────────────────────
   `localStorage` pode lançar: política de site, sessão inPrivate, origem
   `file://` com armazenamento bloqueado, quota cheia. Isto corre no arranque,
   ANTES do React — um `getItem` que lança sem apanho aborta a árvore e a app
   abre em branco. Todo o leitura/escrita de aparência passa por aqui. */
function readStoredItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // sem leitura decide o valor por omissão, nunca um vazio
  }
}

/** true = ficou gravado. Quem chama não pode afirmar persistência com false. */
function writeStoredItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/* Chave do destaque com nome do produto, como a da identidade. A chave antiga
   ("accent") fica só para leitura de migração: gravava "blue" com o MEU valor
   de migração, e a partir daqui já se distingue herança de escolha atual. */
export const APPARANCE_ACCENT_KEY = "cybersafe_accent";
export const LEGACY_ACCENT_KEY = "accent";

/**
 * "blue" gravado ANTES dos tokens CYAN/PINK/PURPLE migrava para "cyan". Isso
 * tornava a opção Azul impossível de escolher: escolha-se o que se escolher,
 * o arranque seguinte devolvia Ciano. Agora a migração só se aplica ao registo
 * Agora a migração só se aplica ao registo legado; uma escolha atual em
 * "blue" é respeitada.
 */
export function loadAccent(): AccentMode {
  const current = readStoredItem(APPARANCE_ACCENT_KEY);
  if (isAccent(current)) return current;
  const legacy = readStoredItem(LEGACY_ACCENT_KEY);
  if (legacy && legacy !== "blue" && isAccent(legacy)) return legacy;
  return "cyan";
}

export function loadTheme(): ThemeMode {
  return readStoredItem(APPARANCE_THEME_KEY) === "light" ? "light" : "dark";
}

/** Identidades na ordem em que são oferecidas (Sidebar e Configurações). */
export const IDENTITY_ORDER: readonly AppIdentity[] = [
  "cybersafe-core",
  "cybersafe-neon",
  "matrix-terminal",
  "cybersafe-liquid",
  "cybersafe-red-belbete",
];

/** Rótulos curtos PT-PT — o valor interno (o id) nunca é mostrado ao utilizador.
    "Neon" e "Terminal" são nomes de produto, não tradução; "Neão" ler-se-ia
    como o negativo, por isso não se usa. */
export const IDENTITY_LABELS: Record<AppIdentity, string> = {
  "cybersafe-core": "Núcleo",
  "cybersafe-neon": "Neon",
  "matrix-terminal": "Terminal",
  "cybersafe-liquid": "Líquido",
  "cybersafe-red-belbete": "Belbete",
};

export function loadIdentity(): AppIdentity {
  const raw = readStoredItem(APPARANCE_IDENTITY_KEY);
  return isAppIdentity(raw) ? raw : DEFAULT_IDENTITY;
}

/* ═══ EIXO DE SUPERFÍCIE ═══════════════════════════════════════════════════
   Segundo eixo, ortogonal à identidade e ao modo claro/escuro: como ficam as
   superfícies elevadas. Não é um tema — é o acabamento do tema, e funciona em
   qualquer identidade.

     solid   → sem desfoque, superfície opaca (nada transparece)
     glass   → desfoque do fundo por trás + tinta translúcida (o efeito de vidro)
     reduced → sem desfoque, mantém transparência e borda (modo desempenho)

   O `glass` é o valor por omissão porque é o aspeto que o produto promete na
   identidade Líquido; os outros dois são a saída para máquinas onde o
   `backdrop-filter` foi medido como caro. ═══ */
export type SurfaceStyle = "solid" | "glass" | "reduced";

export const APPARANCE_SURFACE_KEY = "cybersafe_surface";
export const DEFAULT_SURFACE: SurfaceStyle = "glass";

const SURFACE_STYLES: readonly SurfaceStyle[] = ["solid", "glass", "reduced"];

export function isSurfaceStyle(value: unknown): value is SurfaceStyle {
  return typeof value === "string" && SURFACE_STYLES.includes(value as SurfaceStyle);
}

/** Valor inválido ou ausente resolve para o valor por omissão, como `loadIdentity`. */
export function loadSurface(): SurfaceStyle {
  const raw = readStoredItem(APPARANCE_SURFACE_KEY);
  return isSurfaceStyle(raw) ? raw : DEFAULT_SURFACE;
}

/**
 * Alias léxico do eixo de superfície para os contextos onde a UI/os stores
 * usam a palavra "liquid" em vez de "glass". O CSS resolve ambos para o mesmo
 * bloco, e o componente GlassSurface também; esta função só evita que um valor
 * guardado com um nome legítimo (ou vindo de uma migração interna) seja
 * rejeitado como inválido e volte ao padrão.
 *
 * Não expande o conjunto de valores válidos publicamente: para lá de solid/
 * reduced/glass, só reconhece "liquid" como alias de "glass", e ignora resto.
 */
export function normalizeSurface(raw: unknown): SurfaceStyle {
  if (isSurfaceStyle(raw)) return raw;
  if (raw === "liquid") return "glass";
  return DEFAULT_SURFACE;
}

export const SURFACE_LABELS: Record<SurfaceStyle, string> = {
  glass: "Vidro",
  reduced: "Reduzido",
  solid: "Sólido",
};

export interface AppearanceState {
  theme: ThemeMode;
  identity: AppIdentity;
  accent: AccentMode;
  surface: SurfaceStyle;
}

/** O estado completo, lido do Storage com os mesmos valores por omissão. */
export function readAppearance(): AppearanceState {
  return { theme: loadTheme(), identity: loadIdentity(), accent: loadAccent(), surface: loadSurface() };
}

/**
 * Escreve os quatro atributos do <html>. O modo entra por `classList` e NAO por
 * `className = theme`: a atribuição direta apaga qualquer classe que outra parte
 * tenha posto no mesmo elemento. Só `dark` e `light` são tocadas — as duas que
 * este módulo controla.
 */
export function applyAppearance(state: AppearanceState = readAppearance()): void {
  const { documentElement } = document;
  documentElement.classList.toggle("dark", state.theme === "dark");
  documentElement.classList.toggle("light", state.theme === "light");
  documentElement.setAttribute("data-theme", state.identity);
  documentElement.setAttribute("data-accent", state.accent);
  documentElement.setAttribute("data-surface", state.surface);
}

/**
 * Aplica já e tenta guardar para o próximo arranque. Devolve se FICOU
 * guardado: com `false` a app continua a funcionar nesta sessão, mas o
 * próximo arranque volta aos valores do Storage — por isso o resultado é
 * devolvido em vez de ser ignorado, e nunca se afirma persistência por cima
 * de uma escrita que falhou.
 */
export function writeAppearance(state: AppearanceState): boolean {
  applyAppearance(state);
  const writes = [
    writeStoredItem(APPARANCE_THEME_KEY, state.theme),
    writeStoredItem(APPARANCE_IDENTITY_KEY, state.identity),
    writeStoredItem(APPARANCE_ACCENT_KEY, state.accent),
    writeStoredItem(APPARANCE_SURFACE_KEY, state.surface),
  ];
  return writes.every(Boolean);
}