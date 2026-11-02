// Teste da guarda da API no empacotamento Linux.
//
// Porque existe um teste para isto: sem a API dentro do pacote a aplicação
// ABRE — janela, renderer, ecrã de login — e só depois falha ao autenticar. Um
// artefacto «construído com sucesso» que não autentica é exatamente a classe de
// defeito que a medição do `.deb` de 0.1.11 encontrou (`API local não arrancou
// (skipped): API não encontrada no artefacto`, e depois `ERR_DLOPEN_FAILED` no
// addon). A verificação tem de poder falhar sozinha, sem correr o
// `electron-builder`, e tem de concordar com o caminho que o `api-lifecycle`
// procura — se um dos dois se mover em separado, a guarda deixa de valer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..");
// `import()` de caminho absoluto só aceita URL no Windows; o `fileURLToPath`
// acima é para ler ficheiros, este é para carregar o módulo.
const { estadoApi } = await import(pathToFileURL(path.join(AQUI, "..", "linux-lite", "package-linux.mjs")).href);

function bancada({ comEntrada }) {
  const pasta = mkdtempSync(path.join(tmpdir(), "cs-api-palco-"));
  const entrada = path.join(pasta, "node_modules", "api", "dist", "index.js");
  mkdirSync(path.dirname(entrada), { recursive: true });
  if (comEntrada) writeFileSync(entrada, "// compilado\n");
  return pasta;
}

test("palco sem `api/dist/index.js` é recusado com a razão nomeada", () => {
  const pasta = bancada({ comEntrada: false });
  try {
    const r = estadoApi(pasta);
    assert.equal(r.comApi, false);
    assert.match(r.porque, /api[/\\]dist[/\\]index\.js/);
    assert.match(r.porque, /não autentica/);
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
});

test("palco com a entrada é aceite", () => {
  const pasta = bancada({ comEntrada: true });
  try {
    assert.equal(estadoApi(pasta).comApi, true, estadoApi(pasta).porque);
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
});

test("a guarda e o `api-lifecycle` procuram o mesmo caminho", () => {
  const ciclo = readFileSync(path.join(RAIZ, "packages/desktop/src/api-lifecycle.ts"), "utf8");
  assert.match(ciclo, /"node_modules",\s*"api",\s*"dist",\s*"index\.js"/, "o api-lifecycle mudou de caminho: atualizar a guarda");
  assert.equal(estadoApi(bancada({ comEntrada: true })).comApi, true);
  assert.equal(estadoApi(bancada({ comEntrada: false })).comApi, false);
  assert.ok(existsSync(path.join(RAIZ, "packages/desktop/src/api-lifecycle.ts")));
});
