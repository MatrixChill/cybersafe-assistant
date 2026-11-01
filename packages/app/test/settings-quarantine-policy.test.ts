import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const store: Record<string, string> = {};
(globalThis as any).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } };
(globalThis as any).React = React;
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { default: SettingsPage } = await import("../src/pages/SettingsPage");

const html = () => renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(SettingsPage)));

describe("Configurações → quarentena automática", () => {
  test("a opção existe desligada e sem afirmar estado que o serviço não confirmou", () => {
    const markup = html();
    assert.match(markup, /data-settings-quarantine-policy/);
    assert.match(markup, /Isolar automaticamente ameaças confirmadas/);
    assert.match(markup, /aria-checked="false"/);
    assert.match(markup, /A ler a política efetiva do serviço/);
    assert.doesNotMatch(markup, /Ativa\. Só atua/);
  });

  test("os critérios e o gate de consentimento estão visíveis", () => {
    const markup = html();
    for (const text of ["Severidade crítica", "Confiança igual ou superior a 99%", "known_bad_hash", "Inconclusivos nunca são isolados automaticamente"])
      assert.ok(markup.includes(text), text);
    // O dialogo so nasce depois do clique; o SSR prova o estado inicial seguro.
    assert.doesNotMatch(markup, /Ativar com consentimento/);
    assert.doesNotMatch(markup, /automatic-high-confidence.*aria-checked="true"/);
    const source = readFileSync(new URL("../src/pages/SettingsPage.tsx", import.meta.url), "utf8");
    assert.match(source, /aplicarPoliticaQuarentena\("automatic-high-confidence", true\)/);
    assert.match(source, /consent\s*\}/);
  });
});
