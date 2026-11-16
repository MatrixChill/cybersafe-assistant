import { lazy, Suspense, useCallback, useState, type ReactNode } from "react";
import { useOptionalAppearance } from "@/contexts/AppearanceContext";
import { publicAssetUrl } from "@/lib/publicAssetUrl";
import {
  visualCoreAriaLabel,
  visualCoreMode,
  type VisualCoreRendererPreference,
  type VisualCoreTone,
} from "@/lib/visualCore";

const CoreScene = lazy(() => import("@/v2/dashboard/effects/CoreScene"));

export interface CyberSafeVisualCoreProps {
  /** Estado reportado (cor das órbitas). Nunca deduzido aqui. */
  tone?: VisualCoreTone;
  size?: "sm" | "md" | "lg";
  /** O chamador quer movimento (ex.: análise a correr, arranque). */
  animate?: boolean;
  /** `css` força a versão leve (sem WebGL), p. ex. no ecrã de arranque. */
  renderer?: VisualCoreRendererPreference;
  label?: string;
  ariaLabel?: string;
  className?: string;
  /** Centro da versão CSS (ex.: `BrandLogo` oficial). Omissão: símbolo da marca. */
  center?: ReactNode;
}

/**
 * CyberSafe Visual Core — o núcleo hexagonal com órbitas, igual em Windows e
 * Linux. Reaproveita a `CoreScene` 3D do Dashboard quando a GPU é permitida;
 * caso contrário (ou com `prefers-reduced-motion`, ou WebGL perdido) desenha a
 * versão CSS com o mesmo logo e as mesmas órbitas. Não lê IPC nem estado do
 * serviço: só apresenta o `tone` recebido.
 */
export function CyberSafeVisualCore({
  tone = "neutral",
  size = "md",
  animate = true,
  renderer = "auto",
  label,
  ariaLabel,
  className,
  center,
}: CyberSafeVisualCoreProps) {
  const appearance = useOptionalAppearance();
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  const mode = visualCoreMode({
    gpu: appearance?.gpu === true,
    systemReduced: appearance?.systemReduced === true || systemPrefersReduced(),
    failed,
    renderer,
    animate,
    productAnimate: appearance ? appearance.animate : undefined,
  });

  return (
    <div
      className={["cs-visual-core", `cs-visual-core--${size}`, className].filter(Boolean).join(" ")}
      data-tone={tone}
      data-renderer={mode.renderer}
      data-motion={mode.motion ? "on" : "off"}
      role="img"
      aria-label={ariaLabel ?? visualCoreAriaLabel(tone)}
    >
      {mode.renderer === "webgl" ? (
        <Suspense fallback={<CssCore center={center} />}>
          <CoreScene
            variant="depth"
            animate={mode.motion}
            showEngineNodes={false}
            fpsLimit={30}
            dprLimit={1.25}
            onUnavailable={fail}
          />
        </Suspense>
      ) : (
        <CssCore center={center} />
      )}
      {label && <span className="cs-visual-core__label">{label}</span>}
    </div>
  );
}

function systemPrefersReduced(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/** Versão leve: hexágono + duas órbitas em SVG; só `transform` anima. */
function CssCore({ center }: { center?: ReactNode }) {
  return (
    <div className="cs-visual-core__css" aria-hidden="true">
      <svg className="cs-visual-core__orbit cs-visual-core__orbit--a" viewBox="0 0 100 100">
        <ellipse cx="50" cy="50" rx="47" ry="20" />
        <circle cx="97" cy="50" r="2.2" />
      </svg>
      <svg className="cs-visual-core__orbit cs-visual-core__orbit--b" viewBox="0 0 100 100">
        <ellipse cx="50" cy="50" rx="40" ry="16" />
        <circle cx="10" cy="50" r="1.8" />
      </svg>
      <svg className="cs-visual-core__hex" viewBox="0 0 100 100">
        <polygon points="50,6 88,28 88,72 50,94 12,72 12,28" />
      </svg>
      {center ? (
        <span className="cs-visual-core__center">{center}</span>
      ) : (
        <img className="cs-visual-core__logo" src={publicAssetUrl("brand", "symbol.png")} alt="" draggable={false} />
      )}
    </div>
  );
}
