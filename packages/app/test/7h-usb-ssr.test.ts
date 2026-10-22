import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsbProtectionPanel } from "../src/components/UsbProtectionPanel";

/**
 * 7H — RED verdadeiro do `UsbProtectionPanel` em render sem DOM.
 *
 * Escrita reservada e autorizada pelo Codex Lead nesta janela (13/10): este
 * ficheiro + `packages/app/src/components/UsbProtectionPanel.tsx` (só o guard de
 * `window`). Nada de Scanner, nada de `lib/usbProtection`, service, preload ou
 * `electron.d.ts`.
 *
 * A falha medida: `const bridge = window.electronAPI;` no corpo do componente
 * (`UsbProtectionPanel.tsx:59`) rebenta em Node sem DOM. Em
 * `test/scanner-page-render.test.ts` isso mata o ficheiro ANTES dos 3 testes, e
 * o runner ainda devolve `exit 0 / tests 0 / fail 0` — a máscara. Aqui o render
 * acontece DENTRO de `test()`, por isso um throw é contado como falha e o exit
 * passa a 1.
 *
 * Não é instalado nenhum `window` falso: se a «correção» for um fake global em
 * vez do guard, o teste 1 deixa de ser verdade e isto volta a ficar vermelho.
 */

(globalThis as Record<string, unknown>).React = React;

const fonte = readFileSync(
  new URL("../src/components/UsbProtectionPanel.tsx", import.meta.url),
  "utf8",
);
/** Só o corpo do render: a zona que `renderToStaticMarkup` executa. */
const doRenderAoEfeito = fonte
  .slice(fonte.indexOf("export function UsbProtectionPanel"))
  .split("useEffect")[0];

describe("7H — o painel USB tem de renderizar sem DOM", () => {
  test("não há window neste processo: é isso que se quer provar", () => {
    assert.equal(typeof (globalThis as Record<string, unknown>).window, "undefined",
      "apareceu um window global — este ficheiro passou a testar outra coisa");
  });

  test("renderToStaticMarkup não rebenta por falta de window", () => {
    let html = "";
    assert.doesNotThrow(() => {
      html = renderToStaticMarkup(createElement(UsbProtectionPanel));
    }, "o painel não renderiza sem window");
    assert.ok(html.length > 0, "render vazio não é render");
  });

  test("sem leitura não se inventa estado: «a consultar», nunca proteção", () => {
    const html = renderToStaticMarkup(createElement(UsbProtectionPanel));
    // Copy re-pinada a 13/10 (POSTHUMAN13): o painel diz 「Monitorização USB」,
    // não 「Observador」/「Opt-in」. A asserção continua a provar o mesmo: sem
    // leitura não se inventa estado nem se afirma proteção.
    assert.match(html, /A consultar a monitorização USB ao serviço/, "perdeu o estado de arranque");
    assert.match(html, /Monitorização USB:\s*<b[^>]*>desconhecida<\/b>/,
      "estado de monitorização afirmado sem leitura");
    assert.equal(/protegido/i.test(html), false, "afirmação de proteção sem fonte");
    assert.equal(/row-list/.test(html), false, "lista de unidades mostrada sem snapshot");
  });

  test("a correção é o guard, não um fake: o render não lê window cru", () => {
    assert.equal(/const bridge = window\.electronAPI;/.test(doRenderAoEfeito), false,
      "voltou a leitura crua de window no corpo do componente");
    assert.match(doRenderAoEfeito, /typeof window !== "undefined"/,
      "o corpo do render não tem guard de ambiente");
    assert.match(fonte, /window\.electronAPI\?\.onScanProgress/,
      "a subscrição do progresso em browser desapareceu");
  });
});
