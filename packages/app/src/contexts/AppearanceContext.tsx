import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  APPARANCE_IDENTITY_KEY,
  DEFAULT_IDENTITY,
  loadAccent,
  loadIdentity,
  loadTheme,
  type AccentMode,
  type AppIdentity,
  type ThemeMode,
} from "../lib/appearance";

interface AppearanceContextValue {
  identity: AppIdentity;
  setIdentity: (identity: AppIdentity) => void;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  accent: AccentMode;
  setAccent: (accent: AccentMode) => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentityState] = useState<AppIdentity>(() => loadIdentity());
  const [theme, setThemeState] = useState<ThemeMode>(() => loadTheme());
  const [accent, setAccentState] = useState<AccentMode>(() => loadAccent());

  // Persiste e aplica no <html> sempre que qualquer parte da aparência mudar.
  useEffect(() => {
    const { documentElement } = document;
    documentElement.className = theme;
    documentElement.setAttribute("data-theme", identity);
    documentElement.setAttribute("data-accent", accent);
    localStorage.setItem("theme", theme);
    localStorage.setItem("accent", accent);
    localStorage.setItem(APPARANCE_IDENTITY_KEY, identity);
  }, [theme, identity, accent]);

  const setIdentity = useCallback((next: AppIdentity) => {
    setIdentityState(next);
  }, []);

  const value = useMemo<AppearanceContextValue>(
    () => ({ identity, setIdentity, theme, setTheme: setThemeState, accent, setAccent: setAccentState }),
    [identity, setIdentity, theme, accent],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error("useAppearance deve ser usado dentro de <AppearanceProvider>");
  return ctx;
}

export { DEFAULT_IDENTITY };