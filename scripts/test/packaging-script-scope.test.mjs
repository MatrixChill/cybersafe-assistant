/**
 * TESTE ESTÁTICO DE SCOPE DOS SCRIPTS DE PACKAGING (TP-QA2-PACKAGING R1).
 *
 * Porque existe: o patch R0 calculava `expectedVersions` em `runPipeline` e
 * usava-o dentro de `stageWorkspaces` — fora de scope. Nenhum teste de helper
 * apanha isso: só rebenta quando o caminho de produção corre. O ESLint
 * `no-undef` apanha (RED: `'expectedVersions' is not defined`, linha 1533) e
 * este teste impede a regressão antes de qualquer build.
 *
 * Se o ESLint não estiver instalado na árvore, o teste é SKIP com motivo
 * explícito — nunca PASS silencioso. A verificação autoritativa é o script
 * externo `packaging-no-undef.mjs` do QA2 master, corrido contra este ficheiro.
 *
 * Uso: node --test scripts/test/packaging-script-scope.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const FILES = [
  "scripts/package-windows.mjs",
  "scripts/staging-dependency-pins.mjs",
  "scripts/staging-install-metadata.mjs",
];

const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));
let Linter = null;
let globals = null;
try {
  ({ Linter } = requireFromRepo("eslint"));
  globals = requireFromRepo("globals");
} catch {
  Linter = null;
  globals = null;
}

describe(
  "scope estático dos scripts de packaging",
  { skip: Linter ? false : "eslint/globals ausentes na árvore; usar o script externo packaging-no-undef.mjs" },
  () => {
    it("não há identificadores indefinidos (no-undef)", () => {
      const linter = new Linter();
      const messages = [];
      for (const relative of FILES) {
        const file = path.join(REPO_ROOT, ...relative.split("/"));
        const code = fs.readFileSync(file, "utf8");
        const errors = linter.verify(
          code,
          [
            {
              languageOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
                globals: globals.node,
              },
              rules: { "no-undef": "error" },
            },
          ],
          { filename: path.basename(relative) },
        );
        for (const error of errors) messages.push(`${relative}:${error.line}:${error.column} ${error.message}`);
      }
      assert.deepEqual(messages, []);
    });
  },
);
