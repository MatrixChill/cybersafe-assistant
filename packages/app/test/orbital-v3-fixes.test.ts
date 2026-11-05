import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppearanceProvider } from "../src/contexts/AppearanceContext";
import { CoreVisual } from "../src/components/visual/CoreVisual";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(HERE, ...parts), "utf8");

(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

test("núcleo da verificação: identidade CyberSafe com fallback estático acessível", () => {
  const html = renderToStaticMarkup(
    createElement(AppearanceProvider, null, createElement(CoreVisual, { active: true })),
  );
  assert.match(html, /class="cs-core-visual"/);
  assert.match(html, /Núcleo visual CyberSafe/);
  assert.match(html, /Apresentação estática|data-renderer="webgl"/);
  assert.equal(html.includes("progresso real"), false, "o núcleo não pode prometer progresso");
});

test("o scanner não usa o núcleo no cabeçalho e o updater mantém a mesma cena", () => {
  assert.doesNotMatch(read("..", "src", "pages", "FileScannerPage.tsx"), /<CoreVisual/);
  const core = read("..", "src", "components", "visual", "CoreVisual.tsx");
  assert.match(core, /dashboard\/effects\/CoreScene/);
  assert.match(core, /fpsLimit=\{30\}/);
  assert.match(core, /dprLimit=\{1\.25\}/);
  const updater = read("..", "src", "components", "updates", "UpdaterScene.tsx");
  assert.match(updater, /CoreScene/);
  assert.match(updater, /showEngineNodes=\{false\}/);
});

test("sidebar: o estado ativo ocupa o item, não apenas um ponto de 5 px", () => {
  const css = read("..", "src", "v2", "lab-sidebar.css");
  assert.match(css, /\.lab-sidebar \.nav-group button\.active \{/);
  assert.match(css, /inset 3px 0 0 var\(--v2-accent\)/);
  assert.match(css, /\.nav-group button\.active > svg/);
  assert.match(css, /\.nav-group button:focus-visible/);
  assert.match(read("..", "src", "v2", "LabSidebar.tsx"), /className=\{active \? "active" : undefined\}/);
});
