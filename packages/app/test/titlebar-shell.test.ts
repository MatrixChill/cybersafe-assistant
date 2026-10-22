import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * TITLEBAR (14/10) — a barra de janela é UMA, em todas as páginas.
 *
 * O que este ficheiro fecha (e o que não fecha):
 *  - a faixa não desenha botões de janela próprios: os controlos continuam a
 *    ser do Windows, por isso não pode existir duplicação nem conflito entre
 *    "minimizar" nativo e um botão caseiro;
 *  - a faixa é montada UMA vez, dentro dos providers, acima do conteúdo — não
 *    por página (era assim que nasciam cinco barras diferentes);
 *  - a altura é um token único (`--shell-titlebar-h`) usado pela faixa E pela
 *    compensação do conteúdo: sem isso o conteúdo passa por baixo da barra;
 *  - o rodapé de autenticação não promete proteção que ainda não foi
 *    confirmada ("Protected by CyberSafe Security" antes do login).
 *
 * NÃO se verifica aqui o que só se vê com olhos: arrasto, minimizar/maximizar/
 * restaurar, DPI e maximização real ficam para o reteste humano.
 */

(globalThis as Record<string, unknown>).React = React;
// AppearanceProvider/AuthProvider leem localStorage nos inicializadores de
// estado, mesmo no render servidor. Sem DOM, é o stub mínimo honesto.
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { AppTitleBar } = await import("../src/components/AppTitleBar");
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { AuthProvider } = await import("../src/contexts/AuthContext");
const LoginPage = (await import("../src/pages/LoginPage")).default;
const RegisterPage = (await import("../src/pages/RegisterPage")).default;
const { contrastRatio, readCssNumber, readableSymbolColor, resolveTitleBarColors, rgbStringToHex } = await import(
  "../src/lib/titlebarColor"
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(HERE, ...parts), "utf8");
const css = read("..", "src", "index.css");
/** O CSS sem comentários: as invariantes abaixo falam de DECLARAÇÕES, e as
    notas do ficheiro citam por nome precisamente o que está proibido. */
const decls = css.replace(/\/\*[\s\S]*?\*\//g, "");

function renderWithProviders(child: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(AppearanceProvider, null, createElement(AuthProvider, null, child)),
  );
}

describe("TITLEBAR — a faixa desenhada pelo produto", () => {
  test("uma faixa, com marca e nome do produto, sem botões de janela próprios", () => {
    const html = renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(AppTitleBar)));

    assert.equal((html.match(/class="app-titlebar"/g) ?? []).length, 1, "mais do que uma faixa desenhada");
    assert.match(html, /class="app-titlebar-brand"/);
    assert.match(html, /class="app-titlebar-name"[^>]*>CyberSafe</);
    assert.match(html, /class="app-titlebar-product"[^>]*>Assistant</);
    // Os controlos de janela são do Windows (Window Controls Overlay): qualquer
    // <button> aqui seria um segundo conjunto a competir com o nativo.
    assert.equal(/<button/.test(html), false, "a faixa tem botões próprios de janela");
    assert.equal(/Minimizar|Maximizar|Fechar/i.test(html), false, "a faixa duplica controlos do sistema");
  });

  test("a faixa é montada uma única vez, dentro dos providers e acima do conteúdo", () => {
    const app = read("..", "src", "App.tsx");
    const mounts = app.match(/<AppTitleBar\s*\/>/g) ?? [];
    assert.equal(mounts.length, 1, `AppTitleBar montado ${mounts.length} vezes em App.tsx`);
    const providers = app.indexOf("<AppearanceProvider>");
    const bar = app.indexOf("<AppTitleBar />");
    const content = app.indexOf("<AppContent />");
    assert.ok(providers < bar && bar < content, "a faixa tem de estar entre os providers e o conteúdo");
  });
});

describe("TITLEBAR — a geometria é um token só", () => {
  test("a altura vive em --shell-titlebar-h e cai na gama pedida (40–44 px)", () => {
    const declared = /--shell-titlebar-h:\s*([^;]+);/.exec(decls)?.[1]?.trim();
    assert.ok(declared, "--shell-titlebar-h não está declarado");
    const px = readCssNumber(declared, 0);
    assert.ok(px >= 40 && px <= 44, `altura fora da gama: ${declared}`);
  });

  test("a faixa e o conteúdo usam o MESMO token (nada passa por baixo da barra)", () => {
    const bar = /\.app-titlebar\s*\{[^}]*\}/.exec(decls)?.[0] ?? "";
    assert.match(bar, /height:\s*var\(--shell-titlebar-h\)/);
    const offset = /\.titlebar-offset\s*\{[^}]*\}/.exec(decls)?.[0] ?? "";
    assert.match(offset, /padding-top:\s*var\(--shell-titlebar-h\)/);
    // O bloco do `.auth-page` com a compensação, não as variantes de tema que
    // redefinem só o fundo (`[data-theme] .auth-page`).
    assert.match(
      decls,
      /\.auth-page\s*\{[^}]*padding:\s*calc\([^)]*var\(--shell-titlebar-h\)[^)]*\)/,
      "o ecrã de autenticação não compensa a faixa",
    );
  });

  test("o shell autenticado compensa a faixa; as páginas de autenticação também", () => {
    const app = read("..", "src", "App.tsx");
    assert.match(app, /"titlebar-offset flex h-screen/);
    for (const page of ["LoginPage", "RegisterPage"]) {
      const html = read("..", "src", "pages", `${page}.tsx`);
      assert.match(html, /className="auth-page"/, page);
    }
  });

  test("a faixa é arrastável e nunca coloca nada na zona dos controlos nativos", () => {
    const bar = /\.app-titlebar\s*\{[^}]*\}/.exec(decls)?.[0] ?? "";
    assert.match(bar, /-webkit-app-region:\s*drag/);
    // Reserva à direita: constante em px lógicos (a zona de legenda do Windows
    // não muda de tamanho com a escala DPI).
    assert.match(bar, /padding-right:\s*150px/);
    // A faixa ACIMA do conteúdo, mas abaixo dos modais (não tapa diálogos).
    const zIndex = Number(/z-index:\s*(\d+)/.exec(bar)?.[1] ?? "0");
    assert.ok(zIndex >= 30 && zIndex <= 60, `z-index inesperado na faixa: ${zIndex}`);
  });

  test("a aresta inferior não rouba altura: o eixo dos controlos é o centro do token", () => {
    const bar = /\.app-titlebar\s*\{[^}]*\}/.exec(decls)?.[0] ?? "";
    // MEDIDO (15/10, dev server, Chrome via CDP, 100/125/150% em janela normal e
    // maximizada): a faixa ocupa 0–42 px (centro 21 px), mas uma `border-bottom`
    // dentro de `box-sizing: border-box` encolhia a caixa de conteúdo para 41 px
    // e o eixo de centragem da marca caía para 20,5 px — meia unidade fora do
    // eixo onde o Windows desenha os botões nativos. A aresta passa a sombra
    // interior: pinta o mesmo traço sem alterar a altura da caixa.
    assert.equal(
      /border-bottom\s*:/.test(bar),
      false,
      "a faixa voltou a roubar altura à caixa de conteúdo com uma borda inferior",
    );
    assert.match(bar, /box-shadow:\s*inset 0 -1px 0/, "falta a aresta inferior da faixa");
  });

  test("as cores da faixa vêm de tokens do tema, não de literais", () => {
    const bar = /\.app-titlebar\s*\{[^}]*\}/.exec(decls)?.[0] ?? "";
    assert.match(bar, /background:\s*color-mix\([^)]*var\(--background\)[^)]*var\(--card\)/);
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(bar), false, "a faixa tem cor fixa: não acompanha os temas");
  });
});

describe("TITLEBAR — cor dos controlos nativos (contraste, não estética)", () => {
  test("a cor de símbolo é a que contrasta com o fundo do tema", () => {
    const onDark = readableSymbolColor("#0b0f14");
    const onLight = readableSymbolColor("#fbfcfd");
    assert.notEqual(onDark, onLight, "o mesmo símbolo em fundo claro e escuro");
    assert.ok(contrastRatio("#0b0f14", onDark) >= 4.5, "símbolo ilegível no escuro");
    assert.ok(contrastRatio("#fbfcfd", onLight) >= 4.5, "símbolo ilegível no claro");
  });

  test("lê `rgb()`/`rgba()` do computado e recusa tudo o resto", () => {
    assert.equal(rgbStringToHex("rgb(12, 15, 20)"), "#0c0f14");
    assert.equal(rgbStringToHex("rgba(255, 255, 255, 0.5)"), "#ffffff");
    assert.equal(rgbStringToHex("rgb(12 15 20 / 40%)"), "#0c0f14");
    for (const value of ["", "oklch(0.2 0 0)", "color-mix(in oklch, red, blue)", "transparent", null, undefined]) {
      assert.equal(rgbStringToHex(value as string), null, String(value));
    }
  });

  test("transparência total não é preto: é ausência de superfície", () => {
    // O que um `<body>` sem fundo devolve — nunca pode virar a cor da barra.
    assert.equal(rgbStringToHex("rgba(0, 0, 0, 0)"), null);
    assert.equal(rgbStringToHex("rgb(0 0 0 / 0%)"), null);
    assert.equal(resolveTitleBarColors("rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)").color, "#090b12");
  });

  test("sem token utilizável, cai na reserva do shell e mantém-se legível", () => {
    const colors = resolveTitleBarColors(undefined, null);
    assert.equal(colors.color, "#090b12");
    assert.ok(contrastRatio(colors.color, colors.symbolColor) >= 4.5);
  });

  test("a cor medida da faixa ganha; o fundo do documento é a reserva", () => {
    assert.deepEqual(resolveTitleBarColors("rgb(247, 249, 251)", "rgb(0, 0, 0)").color, "#f7f9fb");
    assert.deepEqual(resolveTitleBarColors(null, "rgb(20, 24, 30)").color, "#14181e");
  });

  test("readCssNumber só aceita px positivos", () => {
    assert.equal(readCssNumber("42px", 10), 42);
    assert.equal(readCssNumber(" 44.5px ", 10), 44.5);
    for (const value of ["auto", "", "0px", "-4px", "42", null, undefined]) {
      assert.equal(readCssNumber(value as string, 10), 10, String(value));
    }
  });
});

describe("LOGIN — detalhes visuais honestos", () => {
  test("não promete proteção ativa antes de ser confirmada", () => {
    const login = renderWithProviders(createElement(LoginPage, { onSwitchToRegister: () => {} }));
    const register = renderWithProviders(createElement(RegisterPage, { onSwitchToLogin: () => {} }));

    for (const html of [login, register]) {
      assert.equal(/Protected by/i.test(html), false, "voltou o rodapé que promete proteção");
      assert.match(html, /Proteção local — o estado real aparece no Painel/);
    }
  });

  test("o formulário continua exatamente o mesmo produto", () => {
    const html = renderWithProviders(createElement(LoginPage, { onSwitchToRegister: () => {} }));
    assert.match(html, /Inicie sessão na sua conta/);
    assert.match(html, /Lembrar-me/);
    assert.match(html, />Entrar</);
    assert.match(html, /Não tem uma conta\?/);
    assert.match(html, /Criar conta/);
  });

  test("o erro é apresentado com ícone e texto (não só cor)", () => {
    const login = read("..", "src", "pages", "LoginPage.tsx");
    assert.match(login, /<AlertCircle/);
    const errorBlock = /\.auth-error\s*\{[^}]*\}/.exec(decls)?.[0] ?? "";
    assert.match(errorBlock, /display:\s*flex/);
    assert.match(errorBlock, /gap:/);
  });

  test("os campos mantêm foco visível e contraste acima do cartão", () => {
    const input = /\.auth-input\s*\{[^}]*\}/.exec(decls)?.[0] ?? "";
    assert.match(input, /background:\s*color-mix\([^)]*var\(--input\)\s*85%/);
    assert.match(input, /border:\s*1px solid color-mix\(in oklch, var\(--border\)\s*85%/);
    const focus = /\.auth-input:focus\s*\{[^}]*\}/.exec(decls)?.[0] ?? "";
    assert.match(focus, /box-shadow:/);
    assert.match(css, /\.auth-submit:focus-visible,\s*\n\s*\.auth-link:focus-visible/, "faltam anéis de foco nos alvos de teclado");
  });
});
