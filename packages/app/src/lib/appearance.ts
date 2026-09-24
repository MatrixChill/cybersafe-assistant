export type AppIdentity = "cybersafe-core" | "cybersafe-neon" | "matrix-terminal" | "cybersafe-liquid" | "cybersafe-red-belbete";
export type ThemeMode = "dark" | "light";
export type AccentMode = "cyan" | "matrix-green" | "blue" | "purple" | "pink" | "amber" | "red-wine";

export const APPARANCE_IDENTITY_KEY = "cybersafe_theme";
export const DEFAULT_IDENTITY: AppIdentity = "cybersafe-core";

const IDENTITIES: readonly AppIdentity[] = ["cybersafe-core", "cybersafe-neon", "matrix-terminal", "cybersafe-liquid", "cybersafe-red-belbete"];

function isAppIdentity(value: unknown): value is AppIdentity {
  return typeof value === "string" && IDENTITIES.includes(value as AppIdentity);
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

/** Migra "blue" gravado antes da introdução dos tokens CYAN/PINK/PURPLE. */
export function loadAccent(): AccentMode {
  const raw = localStorage.getItem("accent") || "cyan";
  if (raw === "blue") return "cyan";
  return isAccent(raw) ? raw : "cyan";
}

export function loadTheme(): ThemeMode {
  const raw = localStorage.getItem("theme");
  return raw === "light" ? "light" : "dark";
}

export function loadIdentity(): AppIdentity {
  const raw = localStorage.getItem(APPARANCE_IDENTITY_KEY);
  return isAppIdentity(raw) ? raw : DEFAULT_IDENTITY;
}

/** Aplica a aparência persistida no <html> (class dark/light + data-theme + data-accent). */
export function applyAppearance(): void {
  const { documentElement } = document;
  documentElement.className = loadTheme();
  documentElement.setAttribute("data-theme", loadIdentity());
  documentElement.setAttribute("data-accent", loadAccent());
}