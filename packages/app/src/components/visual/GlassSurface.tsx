import type { ReactNode } from "react";

/**
 * GlassSurface - superfície de material reutilizável (TP-UI-AUTO).
 *
 * Escolhe o material pela prop `material`, não por prefs/estado. Por isso o
 * componente é determinístico: quem define a classe de preenchimento é o CSS
 * do eixo de superfície (data-material), não este ficheiro.
 *
 * Mapping explícito do eixo SurfaceStyle para as classes deste componente:
 *  - solid     → [data-material="solid"]        (L0: opaco do tema)
 *  - reduced   → [data-material="reduced"]      (L1: translúcido, sem desfoque)
 *  - glass     → [data-material="glass"]        (L2: vidro/desfoque)
 *  - liquid    → [data-material="liquid"]       (L2: alias coerente para o nome
 *                                                 do product; o CSS resolve para o mesmo
 *                                                 bloco que glass)
 *  - showcase  → [data-material="showcase"]     (L3 opt-in, sem glare)
 *  - showcase-glare → L3 com glare interior (opt-in)
 *
 * L3 é opt-in: nunca é aplicado automaticamente pela preferência guardada.
 * Não chama blur de refração: só iluminação/halflight controlada, se usado.
 *
 * Pause quando escondido é opt-in via props — o componente não começa a observar
 * a interseção por si só.
 *
 * Uso real: Dashboard/Settings não iniciavam com material hardcoded; o hero-banner
 * do Dashboard agora recebe `data-material="reduced"` vindo do material fornecido
 * nesse checkpoint, e a Settings mostra os três materiais ao lado sem usar este
 * componente.
 */
type Material =
  | "solid"
  | "reduced"
  | "liquid"
  | "glass"
  | "showcase"
  | "showcase-glare";

interface GlassSurfaceProps {
  children: ReactNode;
  /** Material de superfície. O padrão é solid porque é o fallback mais barato. */
  material?: Material;
  className?: string;
  /** Quando ficar fora do viewport ou escondido, react-one ou pausa no pai -
   *  nunca iniciar efeito apenas porque o componente existe. */
  pauseOnHidden?: boolean;
}

const MATERIAL_CLASS: Record<Material, string> = {
  solid: "surface-solid",
  reduced: "surface-reduced",
  liquid: "surface-liquid",
  glass: "surface-liquid",
  showcase: "surface-showcase",
  "showcase-glare": "surface-showcase surface-showcase-glare surface-glass-highlight",
};

export function GlassSurface({
  children,
  material = "solid",
  className,
  pauseOnHidden = false,
}: GlassSurfaceProps) {
  // pauseOnHidden é opt-in via props: quem usa o componente decide se o material
  // custoso (glass/liquid) deve desistir do efeito quando o elemento sai do
  // viewport. O componente por si só não lê IntersectionObserver.
  const classes = [
    MATERIAL_CLASS[material],
    pauseOnHidden ? "data-pause-visual" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      data-material={material}
      data-pause-visual={pauseOnHidden ? "" : undefined}
    >
      {children}
    </div>
  );
}
