/**
 * Decisões puras do «CyberSafe Visual Core» (logo hexagonal + órbitas).
 *
 * O componente (`components/visual/CyberSafeVisualCore.tsx`) é partilhado por
 * Windows e Linux: Dashboard, ecrã de arranque e superfícies de operação. Aqui
 * vive só a regra, sem React nem DOM, para ser testável:
 *
 *  - WebGL (`CoreScene`) só com GPU permitida, sem `prefers-reduced-motion`,
 *    sem falha observada e quando o chamador não pediu a versão leve;
 *  - a versão CSS é sempre a alternativa honesta — o mesmo logo e as mesmas
 *    órbitas, com transformações compostas (sem layout nem pintura por frame);
 *  - movimento só quando o chamador o pede E o sistema não pede menos
 *    movimento. Com reduced-motion o núcleo fica parado, nunca escondido.
 */

export type VisualCoreTone = "protected" | "attention" | "degraded" | "critical" | "loading" | "neutral";
export type VisualCoreRendererPreference = "auto" | "css";

export interface VisualCoreModeInput {
  gpu: boolean;
  systemReduced: boolean;
  failed: boolean;
  /** Preferência do chamador; `css` evita WebGL (ex.: arranque). */
  renderer?: VisualCoreRendererPreference;
  /** O chamador quer animação (ex.: estado ativo). */
  animate: boolean;
  /** A preferência de animação do produto (Aparência). Ausente = permitido. */
  productAnimate?: boolean;
}

export interface VisualCoreMode {
  renderer: "webgl" | "css";
  motion: boolean;
}

export function visualCoreMode(input: VisualCoreModeInput): VisualCoreMode {
  const motionAllowed = !input.systemReduced && input.productAnimate !== false;
  const webgl = (input.renderer ?? "auto") === "auto" && input.gpu && !input.systemReduced && !input.failed;
  return { renderer: webgl ? "webgl" : "css", motion: motionAllowed && input.animate };
}

/** Texto acessível por tom: descreve o estado reportado, não o inventa. */
export function visualCoreAriaLabel(tone: VisualCoreTone): string {
  switch (tone) {
    case "protected": return "Núcleo visual CyberSafe — proteção reportada como ativa.";
    case "attention": return "Núcleo visual CyberSafe — há pontos que pedem atenção.";
    case "degraded": return "Núcleo visual CyberSafe — proteção com limitações reportadas.";
    case "critical": return "Núcleo visual CyberSafe — estado crítico reportado.";
    case "loading": return "Núcleo visual CyberSafe — a iniciar.";
    default: return "Núcleo visual CyberSafe. A animação é decorativa.";
  }
}
