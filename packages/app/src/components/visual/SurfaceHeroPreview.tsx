import { ShieldCheck } from "lucide-react";
import { GlassSurface } from "./GlassSurface";
import { SurfacePreviewDisk } from "./SurfacePreviewDisk";
import type { SurfaceStyle } from "../../lib/appearance";
import { SURFACE_LABELS } from "../../lib/appearance";

/**
 * SurfaceHeroPreview — miniatura do hero do Dashboard para as Configurações.
 *
 * É uma AMOSTRA da composição com o material escolhido, não um estado do
 * sistema: todos os valores são fixos e rotulados como amostra ("86/100",
 * "4 de 4 motores"). Nunca lê serviço, IPC ou armazenamento.
 *
 * O material entra pelo MESMO contrato do produto (`data-material` no
 * GlassSurface) e `data-surface-preview` impede que o travão universal do eixo
 * apague a diferença entre materiais dentro da amostra.
 */
export interface SurfaceHeroPreviewProps {
  surface: SurfaceStyle;
  className?: string;
}

export function SurfaceHeroPreview({ surface, className }: SurfaceHeroPreviewProps) {
  return (
    <div className={className} data-testid="surface-hero-preview">
      <div className="overflow-hidden rounded-xl border border-border" data-surface-preview="">
        <GlassSurface material={surface} className="p-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10">
              <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-tight text-foreground">O meu computador está bem?</p>
              <p className="copy-human mt-0.5 text-muted-foreground">Sim, com um aviso — amostra, não é o estado real.</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="rounded border border-cyber-yellow/40 bg-cyber-yellow/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-cyber-yellow">
                  Atenção
                </span>
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">86/100 · 4 de 4 motores</span>
              </div>
            </div>
          </div>
        </GlassSurface>
      </div>
      <div className="mt-2 flex items-center justify-center gap-2">
        {(["solid", "reduced", "glass"] as const).map((material) => (
          <div key={material} className="flex flex-col items-center gap-1">
            <SurfacePreviewDisk material={material} active={surface === material} size={26} />
            <span className="font-mono text-[10px] text-muted-foreground">{SURFACE_LABELS[material]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default SurfaceHeroPreview;
