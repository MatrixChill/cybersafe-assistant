import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Entrega da CSP (R4).
 *
 * O renderer empacotado abre por loadFile(file://), onde `onHeadersReceived`
 * não é aplicado ao documento. A política tem de viajar no HTML, antes de
 * qualquer script. Estes testes prendem essa entrega e impedem que a política
 * de produção e a de DEV divirjam silenciosamente.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(here, "../index.html"), "utf8");
const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
const directives = Object.fromEntries(
  meta.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, ...value] = part.split(/\s+/);
    return [name, value.join(" ")];
  }),
);

test("o meta CSP existe e precede o primeiro script", () => {
  assert.ok(meta, "meta CSP ausente: a entrega em file:// ficaria sem política");
  assert.ok(
    html.indexOf('http-equiv="Content-Security-Policy"') < html.indexOf("<script"),
    "o meta tem de ser analisado antes de qualquer script",
  );
});

test("a política de produção não autoriza eval nem inline em scripts", () => {
  assert.equal(directives["default-src"], "'self'");
  assert.equal(directives["script-src"], "'self'");
  assert.equal(directives["style-src"], "'self' 'unsafe-inline'", "os estilos inline necessários ao React/motion ficam justificados");
  assert.equal(directives["object-src"], "'none'");
  assert.equal(directives["base-uri"], "'none'");
  assert.equal(directives["frame-src"], "'none'");
  assert.equal(directives["form-action"], "'none'");
  assert.doesNotMatch(meta, /unsafe-eval/);
  assert.doesNotMatch(directives["script-src"], /unsafe-inline|\*/);
});

test("só loopback é permitido em connect-src; nenhuma origem remota", () => {
  for (const origin of meta.match(/https?:\/\/[^\s;]+/g) ?? []) {
    assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\*$/, `origem não loopback: ${origin}`);
  }
});

test("app e desktop declaram a MESMA política de produção", () => {
  const desktop = fs.readFileSync(path.resolve(here, "../../desktop/src/navigation-policy.ts"), "utf8");
  const constant = /PRODUCTION_CSP = "([^"]+)"/.exec(desktop)?.[1];
  assert.equal(meta, constant, "as duas políticas divergiram: uma delas deixaria de proteger o build");
});

test("a variante de DEV é derivada do produção e só relaxa o HMR", () => {
  const config = fs.readFileSync(path.resolve(here, "../vite.config.ts"), "utf8");
  assert.match(config, /const productionHtml = fs\.readFileSync\(.*index\.html/, "a CSP de DEV tem de derivar do HTML, não ser uma segunda cópia");
  assert.match(config, /const devCsp = productionCsp/, "a variante de DEV tem de derivar da política de produção");
  assert.match(config, /script-src 'self' 'unsafe-inline'/);
  assert.match(config, /ws:\/\/localhost:5173/);
  assert.doesNotMatch(config, /unsafe-eval/);
});
