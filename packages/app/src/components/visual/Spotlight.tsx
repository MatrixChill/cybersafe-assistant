import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useReducedMotion } from "framer-motion";

/**
 * Spotlight (TP-PAP-DESIGN-V2-PHASE1, fase 1) — luz que segue o ponteiro num
 * cartão de APRESENTAÇÃO.
 *
 * Porque é um hook + um elemento e não um wrapper: o hero do Dashboard já é
 * dono do seu fundo (`hero-banner`, `.hero-gradient`) e já declara a camada do
 * conteúdo com `relative z-10`. Um wrapper próprio não ganharia nada — o feixe
 * teria de pintar ENTRE o fundo do cartão e o conteúdo, e essa camada só existe
 * dentro do cartão. Então o host é a página, e este ficheiro só sabe medir o
 * ponteiro e acender/apagar.
 *
 * Honestade do efeito:
 *  - é tinta, não material: não há canvas, WebGL, refração nem rAF;
 *  - não comunica estado, saúde, cobertura nem resultado de motor — por isso
 *    nunca deve aparecer em tabelas, listas de processos, relatórios ou texto
 *    crítico de diagnóstico;
 *  - movimento reduzido → `ativo=false`, o feixe não se acende e o
 *    `SpotlightBeam` fica com `data-cs-spot="off"` (opacity 0 no CSS). O efeito
 *    desaparece por inteiro, porque um feixe que segue o rato é precisamente o
 *    que a preferência recusa;
 *  - sem `--cs-spot-x/y` escritos (rato nunca entrou) o gradiente fica fora do
 *    cartão visível, não havendo flash num canto por omissão.
 *
 * Custo: `getBoundingClientRect()` uma vez por entrada do ponteiro (não por
 * movimento); o estado React muda 2× por hover, não por frame.
 */
export interface Spotlight<T extends HTMLElement> {
  /** Pôr no elemento host (o cartão). */
  ref: RefObject<T | null>;
  /** Acender o feixe. Falso com movimento reduzido ou `enabled={false}`. */
  aceso: boolean;
  /** O efeito está de todo disponível. */
  ativo: boolean;
  onPointerEnter: (evento: ReactPointerEvent<T>) => void;
  onPointerMove: (evento: ReactPointerEvent<T>) => void;
  onPointerLeave: () => void;
}

export function useSpotlight<T extends HTMLElement>(enabled = true): Spotlight<T> {
  const reduzir = useReducedMotion() === true;
  const ativo = enabled && !reduzir;
  const ref = useRef<T | null>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const [aceso, setAceso] = useState(false);

  const marcar = (el: T | null, x: number, y: number) => {
    if (!el) return;
    el.style.setProperty("--cs-spot-x", `${x}px`);
    el.style.setProperty("--cs-spot-y", `${y}px`);
  };

  const onPointerEnter = useCallback(
    (evento: ReactPointerEvent<T>) => {
      if (!ativo) return;
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      rectRef.current = rect;
      marcar(el, evento.clientX - rect.left, evento.clientY - rect.top);
      setAceso(true);
    },
    [ativo],
  );

  const onPointerMove = useCallback(
    (evento: ReactPointerEvent<T>) => {
      if (!ativo) return;
      const rect = rectRef.current;
      if (!rect) return;
      marcar(ref.current, evento.clientX - rect.left, evento.clientY - rect.top);
    },
    [ativo],
  );

  const onPointerLeave = useCallback(() => {
    if (!ativo) return;
    rectRef.current = null;
    setAceso(false);
  }, [ativo]);

  return { ref, aceso: ativo && aceso, ativo, onPointerEnter, onPointerMove, onPointerLeave };
}

/**
 * O feixe em si. Entra como filho do cartão, na camada entre o fundo e o
 * conteúdo. `aria-hidden`: é decoração, um leitor de ecrã não tem nada a
 * procurar aqui.
 */
export function SpotlightBeam({ on }: { on: boolean }) {
  return <span aria-hidden="true" data-cs-spot={on ? "on" : "off"} className="cs-spotlight-beam" />;
}
