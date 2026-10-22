/**
 * Barra de janela premium (P1 — titlebar, 2026-10-14).
 *
 * Uma única barra para TODOS os ecrãs (boot, sessão, login, dashboard, scanner,
 * MATRIX, gestor de tarefas): desenhada uma vez, acima do conteúdo, e alinhada
 * com a Window Controls Overlay nativa do Windows — os botões de janela
 * continuam a ser do sistema, esta faixa apenas lhes dá fundo, marca e contexto
 * coerentes com o tema ativo.
 *
 * Contrato com o shell Electron:
 *  - a faixa tem exactamente `--shell-titlebar-h` (42 px) e reserva à direita o
 *    espaço dos botões nativos (`env(titlebar-area-*)`), para nunca os tapar;
 *  - trazer a faixa viva com `titleBarStyle: "hidden"` não muda a área útil: o
 *    conteúdo compensa a altura (`.titlebar-offset`, `.auth-page`), por isso não
 *    há barras nem botões duplicados;
 *  - o arrasto é do Windows (`-webkit-app-region: drag`) e a faixa não tem
 *    botões próprios, logo não colide com minimizar/maximizar/fechar nem com
 *    atalhos/gestos do sistema;
 *  - sem bridge (browser/dev sem preload) a faixa continua a existir e a cor dos
 *    botões nativos fica na reserva do shell: nada bloqueia, nada rebenta.
 *
 * Custo: um `useEffect` por mudança de identidade/tema que lê a cor JÁ PINTADA
 * da própria faixa e envia uma mensagem IPC. Sem animações, sem re-render por
 * frame, sem leitura de DOM durante o render.
 */

import { useEffect, useRef, useState } from "react";
import { useAppearance } from "../contexts/AppearanceContext";
import { BrandLogo } from "./BrandLogo";
import { paintedCssColorToHex, readCssNumber, resolveTitleBarColors } from "../lib/titlebarColor";

/** Nome do produto mostrado na barra (a marca é a palavra anterior). */
const PRODUCT_NAME = "Assistant";

/**
 * Reserva horizontal dos controlos nativos do Windows, à direita. Espelha o
 * `padding-right: 150px` da faixa (index.css, Freebuff): é o espaço onde o SO
 * desenha minimizar/maximizar/fechar. A marca nunca o deve invadir, por isso a
 * compactação abaixo é medida sobre o que sobra, não sobre a janela toda.
 */
const WCO_RESERVE_PX = 150;
/** Largura mínima de marca completa (logo + "CyberSafe" + "Assistant"). */
const BRAND_FULL_MIN_PX = 220;
/** Largura mínima para manter "CyberSafe" (abaixo disto, só o símbolo). */
const BRAND_NAME_MIN_PX = 130;
/** Preenchimento esquerdo da faixa (`padding: 0 0.75rem` = 12 px). */
const BAR_PADDING_PX = 12;

/** Altura da faixa quando nem o token nem a caixa pintada estão disponíveis. */
const TITLEBAR_FALLBACK_HEIGHT = 42;

/**
 * Quantos elementos de marca cabem na barra dada a sua largura total. Com largura
 * desconhecida (primeiro paint) mostramos a marca inteira — falhar a abrir para o
 * completo nunca tapa nada, enquanto falhar para o compacto esconderia a marca.
 */
function brandLevelForWidth(totalWidth: number): "full" | "name" | "mark" {
  if (totalWidth <= 0) return "full";
  const available = totalWidth - BAR_PADDING_PX - WCO_RESERVE_PX;
  if (available >= BRAND_FULL_MIN_PX) return "full";
  if (available >= BRAND_NAME_MIN_PX) return "name";
  return "mark";
}

export function AppTitleBar() {
  const { identity, theme } = useAppearance();
  const barRef = useRef<HTMLElement>(null);
  const [level, setLevel] = useState<"full" | "name" | "mark">("full");

  // Compactação por largura: numa janela pequena a marca recolhe (primeiro o
  // "Assistant", depois "CyberSafe") em vez de competir com os botões nativos.
  // Não escreve CSS global — só decide o que é renderizado neste componente.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const measure = () => setLevel(brandLevelForWidth(Math.round(bar.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;

    // O tema é aplicado em `data-*` pelo AppearanceProvider; efeitos de filhos
    // correm antes dos do pai, por isso esperamos um tick para medir a faixa com
    // o tema NOVO em vez do que acabou de ser substituído.
    const timer = setTimeout(() => {
      const bridge = window.electronAPI;
      const bar = barRef.current;
      if (!bridge?.setTitleBarOverlay || !bar) return;

      // Mede-se a COR PINTADA, não o token: `getPropertyValue("--background")`
      // devolve `oklch(...)` por resolver, o que nunca daria um `rgb()` válido
      // para os botões nativos (ficariam sempre na reserva escura, com emenda
      // visível nos temas claros). O fundo do documento é o segundo candidato.
      const computed = getComputedStyle(bar);
      const colors = resolveTitleBarColors(
        computed.backgroundColor,
        getComputedStyle(document.body).backgroundColor,
        undefined,
        paintedCssColorToHex,
      );

      // Altura real da caixa PINTADA, com o token e por fim uma reserva como
      // degraus. Os botões nativos centram-se nesta altura: medir a caixa em vez
      // de confiar só no token garante o alinhamento mesmo se o CSS alguma vez
      // divergir do valor declarado.
      const paintedHeight = bar.getBoundingClientRect().height;
      const tokenHeight = readCssNumber(computed.getPropertyValue("--shell-titlebar-h"), 0);
      const height =
        Number.isFinite(paintedHeight) && paintedHeight > 0
          ? paintedHeight
          : tokenHeight > 0
            ? tokenHeight
            : TITLEBAR_FALLBACK_HEIGHT;

      void bridge.setTitleBarOverlay({ ...colors, height });
    }, 0);

    return () => clearTimeout(timer);
  }, [identity, theme, level]);

  return (
    <header ref={barRef} className="app-titlebar" data-testid="app-titlebar" data-brand-level={level}>
      <span className="app-titlebar-brand">
        <BrandLogo size="sm" variant="auto" label="" />
        {level !== "mark" && <span className="app-titlebar-name">CyberSafe</span>}
        {level === "full" && <span className="app-titlebar-product">{PRODUCT_NAME}</span>}
      </span>
    </header>
  );
}
