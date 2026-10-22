import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TP-QA-02 (17/10) — design evolution no desktop: a janela-chrome do produto.
 *
 * Substitui o ficheiro QA-smoke que estava CORROMPIDO (linha 1 com aspas
 * partidas e um objeto `sidebar` dummy que só afirmava que `{width,collapsed}`
 * tinha aquelas chaves — não importava produto nenhum). Aqui o teste lê o
 * `main.ts` REAL e fixa os contratos da janela que a onda de design introduziu,
 * por texto-fonte (mesma técnica de `boot-flow.test.mjs`), porque correr o
 * Electron/GUI é reteste humano, não este harness.
 *
 * O que NÃO afirma: que a janela aparece, que o Mica/Acrylic se vê, ou que os
 * botões nativos estão alinhados — isso é GUI. Aqui só se prova que o código
 * que liga essas coisas continua ligado.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = fs.readFileSync(path.join(HERE, "..", "src", "main.ts"), "utf8");

// Só o `createWindow`, até ao carregamento do conteúdo.
const createWindow = MAIN.slice(
  MAIN.indexOf("function createWindow()"),
  MAIN.indexOf("if (app.isPackaged)", MAIN.indexOf("function createWindow()")),
);

describe("desktop design-evolution — importação única do material", () => {
  it("main.ts importa resolveWindowMaterial de ./window-material.js, uma vez", () => {
    const imports = MAIN.match(/from "\.\/window-material\.js"/g) ?? [];
    assert.equal(imports.length, 1, `importes de window-material: ${imports.length}`);
    assert.match(MAIN, /resolveWindowMaterial/);
    assert.match(MAIN, /VALID_BACKGROUND_MATERIALS/);
  });
});

describe("desktop design-evolution — janela-chrome real", () => {
  it("janela pequena: a janela principal tem piso mínimo", () => {
    assert.match(createWindow, /minWidth:\s*820/);
    assert.match(createWindow, /minHeight:\s*600/);
  });

  it("fundo base sólido e material do SO só quando suportado/pedido", () => {
    assert.match(createWindow, /backgroundColor:\s*"#090b12"/);
    // O backgroundMaterial vem do resolversolo quando existe, nunca `transparent`.
    assert.match(createWindow, /resolveWindowMaterial\(\{/);
    assert.match(createWindow, /backgroundMaterial:\s*windowMaterial\.options\.backgroundMaterial/);
    assert.equal(/transparent:\s*true/.test(createWindow), false, "a janela principal não pode ser transparent:true");
  });

  it("a barra de janela continua no overlay nativo do Windows (WCO), uma vez", () => {
    assert.match(createWindow, /titleBarOverlayWindowOptions\(process\.platform\)/);
  });

  it("a fronteira main/preload mantém isolation ligada e node off", () => {
    assert.match(createWindow, /contextIsolation:\s*true/);
    assert.match(createWindow, /nodeIntegration:\s*false/);
  });
});
