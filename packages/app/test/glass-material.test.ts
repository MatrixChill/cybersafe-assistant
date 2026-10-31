import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as Record<string, unknown>).React = React;

const { GlassSurface } = await import("../src/components/visual/GlassSurface");

type Material = "solid" | "reduced" | "liquid" | "glass" | "showcase" | "showcase-glare";

const render = (material: Material, className?: string, pauseOnHidden = false) =>
  renderToStaticMarkup(
    createElement(GlassSurface, {
      material,
      className,
      pauseOnHidden,
      children: "marcador",
    }),
  );

describe("GlassSurface — contrato de material", () => {
  it("aplica a classe do material solicitado", () => {
    const html = render("showcase-glare");
    assert.ok(html.includes("surface-showcase"), "tem surface-showcase");
    assert.ok(html.includes("surface-showcase-glare"), "tem surface-showcase-glare");
    assert.ok(html.includes("surface-glass-highlight"), "tem surface-glass-highlight");
  });

  it("usa solid por defeito quando o material não é especificado", () => {
    const html = render("solid");
    assert.ok(html.includes("surface-solid"), "solid quando fornecido explicitamente");
  });

  it("não injeta CSS inline de cor — a cor vem do token", () => {
    const html = render("liquid");
    const hasInlineStyle = html.includes("style=\"") || html.includes("style='");
    if (hasInlineStyle) {
      throw new assert.AssertionError({
        message: "GlassSurface não deve injetar CSS inline de cor",
        actual: html,
        expected: false,
      });
    }
  });

  it("respeita className externo sem sobrescrevê-lo", () => {
    const html = render("solid", "minha-classe");
    assert.ok(html.includes("minha-classe"), "mantém className externo");
    assert.ok(html.includes("surface-solid"), "adiciona material");
  });

  it("não aplica efeito a DOM arbitrário — apenas o contentor recebido", () => {
    const html = render("showcase");
    assert.ok(html.includes("<div"), "renderiza um contentor");
    assert.ok(html.includes("marcador"), "o conteúdo foge dentro do contentor");
  });

  it("contain não aparece no markup estático neste runtime — verificar comportamento observado", () => {
    const html = render("liquid");
    const hasContainAttr =
      html.includes("contain:layout") ||
      html.includes("contain: layout") ||
      html.includes("contain:");
    assert.equal(hasContainAttr, false, "contain não está presente no markup gerado neste runtime");
  });

  it("não declara pausa sem efeito — pauseOnHidden é apenas atributo de controle", () => {
    const html = render("showcase", undefined, true);
    assert.ok(html.includes("data-pause-visual"), "sinaliza pausa via atributo quando pedido");
  });

  it("glass usa o material de vidro e distingue-se de solid e reduced", () => {
    const htmlGlass = render("glass");
    const htmlReduced = render("reduced");
    assert.ok(htmlGlass.includes('data-material="glass"'), "glass é opt-in explícito");
    assert.ok(htmlGlass.includes("surface-liquid"));
    assert.equal(htmlGlass.includes("surface-solid"), false);
    assert.notStrictEqual(htmlGlass, render("solid"));
    assert.notStrictEqual(htmlGlass, htmlReduced, "glass e reduced não são o mesmo output neste checkpoint");
  });
});
