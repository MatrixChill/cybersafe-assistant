/**
 * TESTE DO GUARDA «o pacote leva renderer».
 *
 * Contexto medido: até `34e879a` o `package-linux.mjs` correu o
 * `electron-builder` sobre um `packages/desktop/dist` que só tinha o SHELL. O
 * pacote foi escrito com sucesso, o serviço ligou-se ao pipe, a janela abriu — e
 * a sonda CDP leu `{"root":-1,"body":0,"texto":"","scripts":[]}` com zero
 * exceções. Nada no pipeline falhou, porque nada verificava o conteúdo.
 *
 * Este ficheiro prova que o guarda existe e que DISPARA, com o motivo certo,
 * sobre exatamente essa configuração. Um guarda que nunca foi exercido é uma
 * esperança, não uma verificação.
 *
 * Deliberadamente isolado: não compila, não empacota, não toca no `dist`
 * partilhado — escreve só em diretórios temporários próprios.
 *
 * Uso: node --test scripts/test/linux-lite-package-renderer-guard.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { estadoRenderer } from "../linux-lite/package-linux.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const RAIZ = path.resolve(HERE, "..", "..");
const VERSAO = "9.9.9";

/** `__BUILD__` como o Vite o imprime no bundle minificado. */
const buildEmbutido = (versao) => `const B={version:"${versao}",buildId:"b-teste",commit:"0123456"};export default B;\n`;

const HTML_CASCA = fs.readFileSync(path.join(RAIZ, "packages", "desktop", "dist", "index.html"), "utf8");
const HTML_STAGED = `<!doctype html>
<html lang="pt-PT"><head><script type="module" crossorigin src="./assets/index-abc.js"></script></head>
<body><div id="root"></div></body></html>
`;

/** umaRoot temporário com `product-version.json` + o `dist` que o caso pede. */
function bancada({ html, js = {}, pastaJs = {} }) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "cs-renderer-guard-"));
  fs.writeFileSync(path.join(raiz, "product-version.json"), `${JSON.stringify({ version: VERSAO, channel: "teste" }, null, 2)}\n`);
  const dist = path.join(raiz, "dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  if (html !== null) fs.writeFileSync(path.join(dist, "index.html"), html);
  for (const [nome, texto] of Object.entries(js)) fs.writeFileSync(path.join(dist, nome), texto);
  for (const [nome, texto] of Object.entries(pastaJs)) fs.writeFileSync(path.join(dist, "assets", nome), texto);
  return { raiz, dist };
}

describe("estadoRenderer: a casca do shell não é um pacote", () => {
  it("recusa a configuração exata do bug: shell + versão certa no main.js", () => {
    const { raiz, dist } = bancada({ html: HTML_CASCA, js: { "main.js": buildEmbutido(VERSAO) } });
    try {
      const r = estadoRenderer(dist, { root: raiz });
      assert.equal(r.comRenderer, false, `casca vazia foi aceite: ${r.porque}`);
      assert.match(r.porque, /#root/, `motivo deveria nomear o contentor em falta, veio: ${r.porque}`);
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });

  it("recusa um index.html sem index.html no disco", () => {
    const { raiz, dist } = bancada({ html: null, pastaJs: { "index-abc.js": buildEmbutido(VERSAO) } });
    try {
      const r = estadoRenderer(dist, { root: raiz });
      assert.equal(r.comRenderer, false);
      assert.match(r.porque, /sem index.html/);
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });

  it("recusa contentor presente mas bundle com outra versão", () => {
    const { raiz, dist } = bancada({ html: HTML_STAGED, pastaJs: { "index-abc.js": buildEmbutido("9.9.8") } });
    try {
      const r = estadoRenderer(dist, { root: raiz });
      assert.equal(r.comRenderer, false, "renderer de outra versão foi aceite");
      assert.match(r.porque, /9\.9\.9/);
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });

  it("recusa html staged sem qualquer bundle com identidade", () => {
    const { raiz, dist } = bancada({ html: HTML_STAGED, pastaJs: { "index-abc.js": "export default 1;\n" } });
    try {
      const r = estadoRenderer(dist, { root: raiz });
      assert.equal(r.comRenderer, false);
      assert.match(r.porque, /__BUILD__/);
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });

  it("aceita o que o stage-renderer.mjs produz: #root + script src + identidade canónica", () => {
    const { raiz, dist } = bancada({ html: HTML_STAGED, pastaJs: { "index-abc.js": buildEmbutido(VERSAO) } });
    try {
      const r = estadoRenderer(dist, { root: raiz });
      assert.equal(r.comRenderer, true, r.porque);
      assert.match(r.porque, /9\.9\.9/);
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });

  it("o index.html AUTORADO do desktop é a casca, por origem", () => {
    // Propriedade permanente do repositório, não do estado do disco: se algum
    // dia o shell passar a trazer o React, o guarda deixa de ser necessário e
    // este teste diz-nos isso em vez de o calar.
    assert.doesNotMatch(HTML_CASCA, /<div[^>]+\bid="root"/, "o dist do desktop já não é uma casca — reavaliar o guarda");
  });
});
