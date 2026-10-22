/**
 * Marca CyberSafe — arte final do produto, derivada dos mestres em
 * `assets/branding/source/` (ver `scripts/generate-branding-derivatives.py`).
 * Nada aqui é desenhado: só se escolhe o ficheiro certo para o fundo certo.
 *
 * Derivados reais em `public/branding/cybersafe/`, todos quadrados com a margem
 * de ar livre do próprio mestre, nas escadas 16/20/24/32/40/48/64/96/128/256:
 *   symbol-flat-*.png  <- 03_CyberSafe_monograma_flat.png (monograma, flat, sem glow)
 *   tile-*.png         <- 06_CyberSafe_tray_icon_squircle.png (mesmo monograma
 *                         em placa escura própria)
 *
 * Regra de escolha, medida contra os 10 painéis dos temas:
 *   - `symbol-flat` é branco + ciano: no painel escuro separa 18.6:1; no painel
 *     claro o "C" branco desaparece (1.62:1, 79% dos pixéis abaixo de 1.5:1).
 *     Logo: só em fundo escuro.
 *   - `tile` traz a sua própria placa escura: 18.2-18.6:1 nos painéis claros e
 *     ~14:1 nos escuros. É o único dos dois que se lê nos dois — por isso é o
 *     fallback do modo claro, do favicon e do ícone de janela.
 *   - Nenhum dos dois é reamostrado para cima: o tamanho do asset é sempre o
 *     tamanho exato pedido, e a escada vai até 256.
 *   - Recolorir o PNG por tema está fora de questão: quando o fundo muda,
 *     muda o ficheiro.
 */

import { cn } from "@/lib/utils";
import { publicAssetUrl } from "../lib/publicAssetUrl";
import { useAppearance } from "../contexts/AppearanceContext";

const SQUARE_PX = { sm: 32, md: 40, lg: 48 } as const;
const SIZE_CLASS = { sm: "w-8 h-8", md: "w-10 h-10", lg: "w-12 h-12" } as const;

/** Variante -> nome do ficheiro em public/branding/cybersafe/. O mapa existe
 * porque o nome da variante ("symbol") não é o stem do ficheiro
 * ("symbol-flat"): a diferença de uma string dava 404 silencioso no escuro. */
const VARIANT_STEM = { symbol: "symbol-flat", tile: "tile" } as const;

export type BrandLogoSize = keyof typeof SQUARE_PX;
export type BrandLogoVariant = "auto" | "symbol" | "tile";

interface BrandLogoProps {
  size?: BrandLogoSize;
  /** "auto" segue o tema: monograma em fundo escuro, placa em fundo claro. */
  variant?: BrandLogoVariant;
  /** Nome lido por leitores de ecrã. "" quando já há texto ao lado a dizer CyberSafe. */
  label?: string;
  className?: string;
}

function brandLogoSrc(size: BrandLogoSize, variant: "symbol" | "tile") {
  return publicAssetUrl("branding", "cybersafe", `${VARIANT_STEM[variant]}-${SQUARE_PX[size]}.png`);
}

/**
 * Os dois ramos (escuro/claro) vivem em ficheiros diferentes. Sem isto, a
 * primeira troca de tema pintava o logo vazio enquanto o browser ia buscar o
 * variante do tema novo. São 6 ficheiros, ~12 KB no total, e só correm uma vez
 * por carregamento de módulo.
 */
if (typeof document !== "undefined" && typeof Image !== "undefined") {
  for (const size of Object.keys(SQUARE_PX) as BrandLogoSize[]) {
    for (const variant of ["symbol", "tile"] as const) {
      const img = new Image();
      img.src = brandLogoSrc(size, variant);
    }
  }
}

export function BrandLogo({ size = "md", variant = "auto", label = "CyberSafe", className }: BrandLogoProps) {
  const { theme } = useAppearance();
  const resolved = variant === "auto" ? (theme === "dark" ? "symbol" : "tile") : variant;
  const px = SQUARE_PX[size];

  return (
    <img
      src={brandLogoSrc(size, resolved)}
      width={px}
      height={px}
      alt={label}
      className={cn("object-contain shrink-0", SIZE_CLASS[size], className)}
      draggable={false}
    />
  );
}
