import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  loadAccent,
  loadIdentity,
  loadSurface,
  loadTheme,
  normalizeSurface,
  writeAppearance,
  type AccentMode,
  type AppIdentity,
  type SurfaceStyle,
  type ThemeMode,
} from "../lib/appearance";

interface AppearanceContextValue {
  identity: AppIdentity;
  setIdentity: (identity: AppIdentity) => void;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  accent: AccentMode;
  setAccent: (accent: AccentMode) => void;
  /** Eixo de superfície: acabamento das superfícies elevadas, em qualquer identidade. */
  surface: SurfaceStyle;
  setSurface: (surface: SurfaceStyle) => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentityState] = useState<AppIdentity>(() => loadIdentity());
  const [theme, setThemeState] = useState<ThemeMode>(() => loadTheme());
  const [accent, setAccentState] = useState<AccentMode>(() => loadAccent());
  const [surface, setSurfaceState] = useState<SurfaceStyle>(() => normalizeSurface(loadSurface()));

  // Aplica no <html> e persiste, num só sítio (lib/appearance.ts): leitura e
  // escrita defensivas, e o modo entra por classList para não apagar classes
  // que outra parte tenha posto no elemento.
  useEffect(() => {
    if (!writeAppearance({ theme, identity, accent, surface })) {
      console.warn(
        "[CyberSafe] Aparência aplicada nesta sessão, mas o armazenamento não a conseguiu guardar.",
      );
    }
  }, [theme, identity, accent, surface]);

  const setIdentity = useCallback((next: AppIdentity) => {
    setIdentityState(next);
  }, []);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      identity,
      setIdentity,
      theme,
      setTheme: setThemeState,
      accent,
      setAccent: setAccentState,
      surface,
      setSurface: setSurfaceState,
    }),
    [identity, setIdentity, theme, accent, surface],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error("useAppearance deve ser usado dentro de <AppearanceProvider>");
  return ctx;
}