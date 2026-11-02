import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadAccent, writeAppearance, type AccentMode } from "../lib/appearance";
import {
  DEFAULT_V2_PREFERENCES,
  deriveV2Capabilities,
  readV2Preferences,
  systemPrefersReducedMotion,
  v2ToLegacy,
  writeV2Preferences,
  type V2Material,
  type V2Movement,
  type V2Performance,
  type V2Preferences,
  type V2Theme,
  type VisualEffects,
  readVisualEffects,
  readVisualNoticeDismissals,
  writeVisualNoticeDismissals,
} from "../v2/theme";

/**
 * Aparência tem UMA fonte: as preferências V2 (tema, material, movimento,
 * desempenho, WebGL). Os campos `identity`/`theme`/`surface` que ficam cá em
 * baixo são a PROJEÇÃO para o CSS de V1 que ainda não migrou — leituras e
 * pequenos tradutores, não um segundo estado. Quando a última página migrar,
 * desaparecem com `v2ToLegacy`.
 */

/** O mesmo mapa da migração, ao contrário: quem ainda chama `setIdentity` fá-lo
    em nomes de V1 e tem de cair no tema V2 correspondente. */
const LEGACY_IDENTITY_TO_V2: Record<string, V2Theme> = {
  "cybersafe-core": "core",
  "cybersafe-neon": "neon",
  "matrix-terminal": "terminal",
  "cybersafe-liquid": "aurora",
  "cybersafe-red-belbete": "belbete",
};

/** Os mesmos três pares de `v2/theme.SURFACE_TO_MATERIAL`, ao contrário. */
const LEGACY_SURFACE_TO_MATERIAL: Record<string, V2Material> = {
  solid: "solid",
  glass: "liquid",
  reduced: "light",
  liquid: "liquid",
  frosted: "frosted",
  advanced: "advanced",
};

interface AppearanceContextValue {
  /** Preferência V2 — a fonte. */
  prefs: V2Preferences;
  setTheme: (theme: V2Theme) => void;
  setMaterial: (material: V2Material) => void;
  setMovement: (movement: V2Movement) => void;
  setPerformance: (performance: V2Performance) => void;
  setWebgl: (webgl: boolean) => void;
  setEffect: (effect:keyof VisualEffects, enabled:boolean) => void;
  effects: VisualEffects;
  maxFps:number;
  reportWebgl: (available:boolean) => void;
  visualNotice:string|null;
  dismissVisualNotice:()=>void;
  resetPreferences: () => void;
  /** Derivados do eixo de desempenho e do sistema. */
  animate: boolean;
  gpu: boolean;
  lowPower: boolean;
  renderDpr: number;
  systemReduced: boolean;
  /** false = aplicada nesta sessão, mas o armazenamento não guardou. */
  storageError: boolean;

  /* ── projeção para consumidores de V1 ───────────────────────────────────── */
  identity: "cybersafe-core" | "cybersafe-neon" | "matrix-terminal" | "cybersafe-liquid" | "cybersafe-red-belbete";
  setIdentity: (identity: string) => void;
  /** Modo claro/escuro do produto; `light` é um dos oito temas V2. */
  theme: "dark" | "light";
  setThemeMode: (mode: "dark" | "light") => void;
  surface: "solid" | "glass" | "reduced";
  setSurface: (surface: string) => void;
  accent: AccentMode;
  setAccent: (accent: AccentMode) => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<V2Preferences>(() => readV2Preferences());
  const [accent, setAccentState] = useState<AccentMode>(() => loadAccent());
  const [systemReduced, setSystemReduced] = useState(() => systemPrefersReducedMotion());
  const [storageError, setStorageError] = useState(false);
  const [webglAvailable,setWebglAvailable] = useState<boolean|undefined>(undefined);
  const [unstable,setUnstable] = useState(false);
  const [dismissed,setDismissed] = useState<string[]>(readVisualNoticeDismissals);
  // One bounded visible sample per automatic session. No polling or hardware ranking.
  useEffect(()=>{
    if(prefs.performance!=='auto'||systemReduced||unstable)return;
    let raf=0,last=0,count=0,slow=0,finished=false,start=performance.now();
    const tick=(now:number)=>{
      if(document.hidden){last=0;return;}
      if(now-start<1500){raf=requestAnimationFrame(tick);return;}
      if(now-start>12000){finished=true;return;}
      if(last){const dt=now-last;if(dt>0&&dt<250){count++;if(dt>50)slow++;}}
      last=now;
      if(count>=180){finished=true;if(slow/count>.25)setUnstable(true);return;}
      raf=requestAnimationFrame(tick);
    };
    const wake=()=>{cancelAnimationFrame(raf);last=0;start=performance.now();if(!document.hidden&&!finished)raf=requestAnimationFrame(tick);};
    document.addEventListener('visibilitychange',wake);wake();
    return()=>{cancelAnimationFrame(raf);document.removeEventListener('visibilitychange',wake);};
  },[prefs.performance,systemReduced,unstable]);

  // `prefers-reduced-motion` pode mudar sem recarregar a página.
  useEffect(() => {
    const mq = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const sync = () => setSystemReduced(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);

  /**
   * As capacidades dependem TAMBÉM da preferência do sistema. Sem `systemReduced`
   * na lista, uma mudança do sistema alterava o estado visível mas deixava
   * `animate`/`gpu` e os atributos do `<html>` no valor anterior — e o efeito de
   * baixo, que depende de `caps`, nem voltava a correr.
   */
  const caps = useMemo(() => deriveV2Capabilities(prefs, systemReduced,{unstable,webglAvailable}), [prefs, systemReduced,unstable,webglAvailable]);
  const reason = prefs.webgl && (prefs.performance!=='custom'||prefs.effects?.core3d!==false) && prefs.performance!=='economy' && webglAvailable===false ? 'webgl-unavailable' : prefs.performance==='auto'&&unstable ? 'frames-reduced' : null;
  const visualNotice=reason&&!dismissed.includes(reason)?reason:null;
  const reportWebgl=useCallback((available:boolean)=>setWebglAvailable(available),[]);
  const dismissVisualNotice=useCallback(()=>{
    if(!reason)return;
    const next=[...new Set([...dismissed,reason])];setDismissed(next);
    writeVisualNoticeDismissals(next);
  },[reason,dismissed]);

  // Aplicar e persistir num só sítio. Duas escritas, uma por camada: os
  // atributos V2 e a projeção que as folhas de V1 ainda lêem. O resultado é
  // observado: `false` não se disfarça de sucesso, mostra-se como aviso.
  useEffect(() => {
    const guardadoV2 = writeV2Preferences(prefs, systemReduced, caps);
    const guardadoLegado = writeAppearance({ ...v2ToLegacy(prefs, caps), accent });
    setStorageError(!(guardadoV2 && guardadoLegado));
  }, [prefs, accent, caps, systemReduced]);

  const setTheme = useCallback((theme: V2Theme) => setPrefs((p) => ({ ...p, theme })), []);
  const setMaterial = useCallback((material: V2Material) => setPrefs((p) => ({ ...p, material })), []);
  const setMovement = useCallback((movement: V2Movement) => setPrefs((p) => ({ ...p, movement })), []);
  const setPerformance = useCallback((performance: V2Performance) => setPrefs((p) => ({ ...p, performance })), []);
  const setWebgl = useCallback((webgl: boolean) => {if(webgl)setWebglAvailable(undefined);setPrefs((p) => ({ ...p, webgl }));}, []);
  const setEffect=useCallback((effect:keyof VisualEffects,enabled:boolean)=>{if(effect==='core3d'&&enabled)setWebglAvailable(undefined);setPrefs(p=>({...p,effects:{...readVisualEffects(p.effects),[effect]:enabled}}));},[]);
  const resetPreferences = useCallback(() => setPrefs({ ...DEFAULT_V2_PREFERENCES }), []);

  const legacy = useMemo(() => v2ToLegacy(prefs, caps), [prefs, caps]);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      prefs,
      setTheme,
      setMaterial,
      setMovement,
      setPerformance,
      setWebgl,
      setEffect,
      effects:caps.effects,
      maxFps:caps.maxFps,
      reportWebgl,
      visualNotice,
      dismissVisualNotice,
      resetPreferences,
      animate: caps.animate,
      gpu: caps.gpu,
      lowPower: caps.lowPower,
      renderDpr: caps.renderDpr,
      systemReduced: systemReduced || caps.systemReduced,
      storageError,
      identity: legacy.identity as AppearanceContextValue["identity"],
      setIdentity: (identity: string) => {
        const next = LEGACY_IDENTITY_TO_V2[identity];
        if (next) setPrefs((p) => ({ ...p, theme: next }));
      },
      theme: legacy.theme,
      // V1 tinha um seletor de modo separado da identidade. Em V2 o modo É
      // tema: `light` é um dos oito. Voltar a escuro a partir de `light` escolhe
      // Núcleo e não uma memória escondida — não há segundo eixo para lembrar.
      setThemeMode: (mode: "dark" | "light") =>
        setPrefs((p) => (mode === "light" ? { ...p, theme: "light" } : p.theme === "light" ? { ...p, theme: "core" } : p)),
      surface: legacy.surface,
      setSurface: (surface: string) => {
        const next = LEGACY_SURFACE_TO_MATERIAL[surface];
        if (next) setPrefs((p) => ({ ...p, material: next }));
      },
      accent,
      setAccent: setAccentState,
    }),
    [prefs, setTheme, setMaterial, setMovement, setPerformance, setWebgl, setEffect,reportWebgl,visualNotice,dismissVisualNotice,resetPreferences, caps, systemReduced, storageError, legacy, accent],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error("useAppearance deve ser usado dentro de <AppearanceProvider>");
  return ctx;
}
