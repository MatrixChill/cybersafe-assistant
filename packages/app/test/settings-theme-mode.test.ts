import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * CLARO/ESCURO em Configurações → Aparência.
 *
 * O estado não é lido do texto do ficheiro: a página é RENDERIZADA a sério,
 * com o AppearanceProvider real e um localStorage semeado. O que se verifica é
 * o markup que sai — um botão por modo, e `aria-pressed` a marcar exatamente
 * aquele que a preferência guardada escolheu.
 *
 * Limitação declarada: este pacote não tem harness de DOM (nem jsdom, nem
 * Vitest), por isso o ciclo clique→setTheme→re-render NÃO é exercitado por um
 * evento real. Fica como verificação manual pendente. O que aqui fica provado
 * é o mapeamento estado→botão premiado, os rótulos e os atributos de
 * acessibilidade; a ligação handler→contexto tem um guard estático no fim.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

function seedStore(theme: "light" | "dark"): void {
  const store: Record<string, string> = {
    theme,
    cybersafe_theme: "cybersafe-core",
    cybersafe_surface: "glass",
    cybersafe_accent: "cyan",
  };
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
  };
  (globalThis as Record<string, unknown>).React = React;
}

const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: SettingsPage } = await import("../src/pages/SettingsPage");

function renderSettings(theme: "light" | "dark"): string {
  seedStore(theme);
  return renderToStaticMarkup(
    createElement(AppearanceProvider, null, createElement(SettingsPage)),
  );
}

type ModeButton = { label: string; pressed: boolean; type: string };

/** Os dois botões do grupo do modo, lidos do markup renderizado. */
function modeButtons(markup: string): ModeButton[] {
  const groupAt = markup.indexOf('aria-label="Mudar entre modo claro e modo escuro"');
  assert.ok(groupAt >= 0, "o grupo do modo não tem nome acessível");

  const after = markup.slice(groupAt);
  const matches = [...after.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].slice(0, 2);

  return matches.map((match) => {
    const markup = match[0];
    const opening = markup.slice(0, markup.indexOf(">") + 1);
    const text = markup.replace(/<[^>]*>/g, " ");
    return {
      label: text.includes("Claro") ? "Claro" : text.includes("Escuro") ? "Escuro" : "",
      pressed: /aria-pressed="true"/.test(opening),
      type: (/type="([^"]*)"/.exec(opening) ?? [])[1] ?? "",
    };
  });
}

describe("Claro/Escuro em Configurações → Aparência", () => {
  test("o grupo do modo existe, tem nome acessível e dois botões", () => {
    const buttons = modeButtons(renderSettings("dark"));

    assert.equal(buttons.length, 2, "o modo tem de ter exatamente dois botões");
    assert.deepEqual(
      buttons.map((button) => button.label).sort(),
      ["Claro", "Escuro"],
      "os dois modos têm de estar visíveis, cada um com o seu rótulo",
    );

    for (const button of buttons) {
      assert.equal(button.type, "button", `o botão ${button.label} tem de ser type="button"`);
    }
  });

  test("a preferência guardada marca UM só botão, e é o certo", () => {
    const light = modeButtons(renderSettings("light"));
    assert.equal(light.filter((button) => button.pressed).length, 1, "um só modo pode estar marcado");
    assert.equal(light.find((button) => button.pressed)?.label, "Claro", "guardado light: Claro marcado");

    const dark = modeButtons(renderSettings("dark"));
    assert.equal(dark.filter((button) => button.pressed).length, 1, "um só modo pode estar marcado");
    assert.equal(dark.find((button) => button.pressed)?.label, "Escuro", "guardado dark: Escuro marcado");
  });

  test("o botão premiado vem do estado do contexto, não de um valor fixo", () => {
    // Se o aria-pressed fosse constante, os dois renders davam o mesmo botão.
    const light = modeButtons(renderSettings("light")).find((button) => button.pressed)?.label;
    const dark = modeButtons(renderSettings("dark")).find((button) => button.pressed)?.label;
    assert.ok(light && dark, "cada render tem de marcar um dos dois modos");
    assert.notEqual(light, dark, "o modo premiado tem de seguir a preferência guardada");
  });

  test("a copy do modo não fala de chaves nem de persistência interna", () => {
    const settings = readFileSync(path.resolve(HERE, "..", "src", "pages", "SettingsPage.tsx"), "utf8");
    const paragraph = settings.slice(settings.indexOf("Alterna entre o aspeto"), settings.indexOf("Alterna entre o aspeto") + 220);
    assert.ok(paragraph.length > 0, "o texto do modo desapareceu");
    assert.doesNotMatch(paragraph, /chave|localStorage|persist[êe]ncia/i, "o texto do modo expõe mecanismo interno");
  });

  test("guarda estática: cada botão entrega o seu próprio id ao setTheme", () => {
    // Sem DOM, esta é a única ligação verificável entre o botão e o contexto:
    // o handler passa o id DA opção, e as opções são tipadas por ThemeMode.
    const settings = readFileSync(path.resolve(HERE, "..", "src", "pages", "SettingsPage.tsx"), "utf8");
    // V2: `setTheme` escolhe tema (oito valores); o modo claro/escuro de V1 é o
    // tradutor `setThemeMode`. A asserção continua a fixar o mesmo: o handler
    // passa o id DA opção, não um valor fixo.
    assert.match(settings, /onClick=\{\(\) => setThemeMode\(option\.id\)\}/, "o botão do modo não chama setThemeMode com o id da opção");
    assert.match(settings, /const THEME_MODE_OPTIONS: \{ id: ThemeMode; label: string \}\[\]/, "as opções do modo têm de ser tipadas por ThemeMode");
  });
});
