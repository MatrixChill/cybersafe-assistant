import { lazy, Suspense, useCallback, useState } from "react";
import { useOptionalAppearance } from "@/contexts/AppearanceContext";
import { publicAssetUrl } from "@/lib/publicAssetUrl";

const CoreScene = lazy(() => import("@/v2/dashboard/effects/CoreScene"));

/**
 * Núcleo Orbital para superfícies de operação (scanner, verificação).
 *
 * A cena é a MESMA do Painel/updater (`CoreScene`), com nós de motor desligados:
 * aqui o estado real vem do pipeline do scan, não de uma cor no núcleo. O
 * componente não inicia trabalho, não lê IPC e não anuncia progresso; o texto
 * acessível diz exatamente isso.
 */
export function CoreVisual({
  active,
  label = "CYBERSAFE / NÚCLEO",
}: {
  active: boolean;
  label?: string;
}) {
  const appearance = useOptionalAppearance();
  const gpu = appearance?.gpu === true;
  const animate = appearance?.animate === true;
  const systemReduced = appearance?.systemReduced === true;
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  const render3d = gpu && !systemReduced && !failed;

  return (
    <div
      className="cs-core-visual"
      data-renderer={render3d ? "webgl" : "static"}
      data-active={active ? "true" : "false"}
      role="img"
      aria-label="Núcleo visual CyberSafe. A animação é decorativa e não representa progresso da análise."
    >
      {render3d ? (
        <Suspense fallback={<CoreStatic />}>
          <CoreScene
            variant="depth"
            animate={animate && active}
            showEngineNodes={false}
            fpsLimit={30}
            dprLimit={1.25}
            onUnavailable={fail}
          />
        </Suspense>
      ) : (
        <CoreStatic />
      )}
      <span className="cs-core-visual__label">{label}</span>
    </div>
  );
}

function CoreStatic() {
  return (
    <div className="cs-core-visual__static">
      <img src={publicAssetUrl("brand", "symbol.png")} width={112} height={112} alt="" />
      <span>Apresentação estática</span>
    </div>
  );
}
