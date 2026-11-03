import { lazy, Suspense, useCallback, useState } from "react";
import { useAppearance } from "../../contexts/AppearanceContext";
import { publicAssetUrl } from "../../lib/publicAssetUrl";
import { updaterScenePolicy } from "./updaterScenePolicy";
import type { UpdaterPhase } from "./updaterWindowModel";

const CoreScene = lazy(() => import("../../v2/dashboard/effects/CoreScene"));

/** Same depth geometry, materials and trajectories as Dashboard B. No engine indicators. */
export function UpdaterScene({ phase, forceStatic = false }: {
  phase: UpdaterPhase;
  forceStatic?: boolean;
}) {
  const { gpu, animate, systemReduced } = useAppearance();
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  const policy = updaterScenePolicy({ gpu, animate, systemReduced, forceStatic: forceStatic || failed });
  const fallbackReason = failed ? "3D indisponível nesta sessão"
    : forceStatic ? "Modo estático de ensaio"
    : systemReduced ? "Movimento reduzido" : "Apresentação estática";
  const fallback = (
    <div className="updater-static-scene">
      <img src={publicAssetUrl("brand", "symbol.png")} width="144" height="144" alt="" />
      <span>{fallbackReason}</span>
    </div>
  );
  return (
    <div className="updater-original-scene" data-orbital-variant="depth"
      data-renderer={policy.render3d ? "webgl" : "static"} role="img"
      aria-label="Núcleo CyberSafe — apresentação visual, sem indicação de proteção">
      {policy.render3d ? (
        <Suspense fallback={fallback}>
          <CoreScene variant="depth" animate={policy.animate && phase !== "error"}
            showEngineNodes={false} fpsLimit={policy.maxFps} dprLimit={policy.dpr} onUnavailable={fail} />
        </Suspense>
      ) : fallback}
      <span className="updater-art-label">CYBERSAFE / ORBITAL B</span>
    </div>
  );
}
