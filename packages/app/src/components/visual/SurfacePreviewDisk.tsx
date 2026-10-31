import type { CSSProperties } from "react";
import { cn } from "../../lib/utils";
import type { SurfaceStyle } from "../../lib/appearance";
import { SURFACE_LABELS } from "../../lib/appearance";

/**
 * SurfacePreviewDisk — amostra CIRCULAR de um material do eixo de superfície.
 *
 * Existe para as Configurações: o mesmo fundo por trás, três discos, três
 * materiais. O material é aplicado por `data-material` (o contrato real que o
 * CSS do eixo lê); o disco não inventa cores nem valores: usa o pano
 * translúcido do tema e o aro do eixo.
 *
 * `data-surface-preview` é o escape documentado do travão universal do eixo:
 * em Reduzido/Sólido, a app inteira perde o desfoque, mas a AMOSTRA tem de
 * continuar a mostrar o que cada material faz — senão os três discos ficam
 * iguais e a comparação mente.
 *
 * Decorativo por natureza: `aria-hidden`; o rótulo vive ao lado, em texto.
 */
export interface SurfacePreviewDiskProps {
  material: SurfaceStyle;
  size?: number;
  /** Marca o material ativo com um anel de foco do tema. */
  active?: boolean;
  className?: string;
}

export function SurfacePreviewDisk({ material, size = 56, active = false, className }: SurfacePreviewDiskProps) {
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    borderColor: active ? "var(--primary)" : "color-mix(in oklch, var(--border) 78%, transparent)",
    borderWidth: active ? 2 : 1,
    borderStyle: "solid",
    background: material === "solid" ? "var(--background)" : "var(--surface-translucent)",
    boxShadow: active ? "0 0 0 3px color-mix(in oklch, var(--primary) 22%, transparent)" : undefined,
  };

  return (
    <div
      data-surface-preview=""
      data-material={material}
      data-active={active ? "true" : "false"}
      role="img"
      aria-label={`Amostra do material ${SURFACE_LABELS[material]}`}
      className={cn("shrink-0", className)}
      style={style}
    >
      <span
        aria-hidden
        className="block h-full w-full rounded-full"
        style={{
          background:
            material === "glass"
              ? "linear-gradient(145deg, color-mix(in oklch, oklch(1 0 0) 20%, transparent) 0%, transparent 46%, color-mix(in oklch, var(--primary) 14%, transparent) 100%)"
              : material === "reduced"
                ? "linear-gradient(145deg, color-mix(in oklch, oklch(1 0 0) 9%, transparent) 0%, transparent 60%)"
                : "none",
        }}
      />
    </div>
  );
}

export default SurfacePreviewDisk;
