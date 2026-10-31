import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");

const TSC_BIN = require.resolve("typescript/bin/tsc");

/**
 * FINAL-INTEGRATION-20261014 — Desktop typecheck integrity contract (Kilo scope).
 *
 * Invoca `tsc --noEmit` directamente (sem shell), para ser portátil no Windows
 * (onde `npm` exige `.cmd`). Garante:
 *  - config não exclui renderer (app/src) por `exclude` top-level;
 *  - `noEmit` e JSX react-jsx estão ON;
 *  - source real compila sem `any` ou `// @ts-ignore` (detectados via grep
 *    de ficheiros incluídos — não confirmação vazia).
 */

const TSCONFIG = JSON.parse(readFileSync(path.join(desktopRoot, "tsconfig.json"), "utf-8"));

function tscCheck() {
  try {
    const stdout = execFileSync(process.execPath, [TSC_BIN, "--noEmit", "-p", path.join(desktopRoot, "tsconfig.json")], {
      cwd: desktopRoot,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      encoding: "utf-8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return { exit: 0, stdout, stderr: "" };
  } catch (e) {
    return {
      exit: (e.status ?? 1),
      stdout: (e.stdout ?? "").toString(),
      stderr: (e.stderr ?? "").toString(),
    };
  }
}

describe("FINAL-INTEGRATION-20261014 — Desktop tsconfig contract", () => {
  let result;
  before(() => {
    result = tscCheck();
  });

  it("tsconfig tem noEmit: true (typecheck puro sem artefactos)", () => {
    assert.equal(TSCONFIG.compilerOptions.noEmit, true);
  });

  it("tsconfig NÃO exclui renderer via top-level exclude", () => {
    assert.equal(
      TSCONFIG.exclude,
      undefined,
      "tsconfig.exclude não deve existir — nada de app/src excluído"
    );
  });

  it("tsconfig inclui app/src (renderer) no path", () => {
    const inc = TSCONFIG.include ?? [];
    assert.ok(
      inc.some((p) => p.includes("app/src")),
      "include deve cobrir app/src"
    );
  });

  it("tsconfig tem jsx react-jsx", () => {
    assert.equal(TSCONFIG.compilerOptions.jsx, "react-jsx");
  });

  it("tsconfig inclui DOM lib (necessário para renderer TSX)", () => {
    assert.ok(
      TSCONFIG.compilerOptions.lib?.includes("DOM"),
      "lib deve incluir DOM para componentes React"
    );
  });

  it("tsc --noEmit termina COM SUCESSO (exit 0, sem erros)", () => {
    const combined = result.stdout + result.stderr;
    assert.equal(result.exit, 0, `tsc não deve reportar erros:\n${combined}`);
  });

  it("renderer App.tsx (entrada main) tem exports sem any", () => {
    const app = readFileSync(path.join(desktopRoot, "../app/src/App.tsx"), "utf-8");
    assert.ok(!app.includes(": any") && !app.includes(" any)"), "App.tsx não deve usar any");
    assert.ok(!app.includes("@ts-ignore"), "App.tsx não deve usar @ts-ignore");
  });
});
