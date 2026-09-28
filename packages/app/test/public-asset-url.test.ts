import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { publicAssetUrl } from "../src/lib/publicAssetUrl";

/**
 * O renderer é servido em http:// no dev e em file:// no Electron empacotado
 * (base "./"). Um path absoluto "/branding/..." funciona no primeiro e resolve
 * para a raiz do sistema no segundo. Estes testes fixam a regra de resolução.
 */
describe("publicAssetUrl — mesma resolução em dev e em file://", () => {
  const doc = globalThis.document;
  const loc = globalThis.location;

  function withBase(baseURI: string, fn: () => void) {
    Object.defineProperty(globalThis, "document", { value: { baseURI }, configurable: true, writable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(globalThis, "document", { value: doc, configurable: true, writable: true });
      Object.defineProperty(globalThis, "location", { value: loc, configurable: true, writable: true });
    }
  }

  test("dev: resolve contra a raiz do servidor", () => {
    withBase("http://localhost:5173/", () => {
      assert.equal(
        publicAssetUrl("branding", "cybersafe", "symbol-flat-40.png"),
        "http://localhost:5173/branding/cybersafe/symbol-flat-40.png",
      );
    });
  });

  test("file://: resolve contra a pasta do index.html, nao contra a raiz do sistema", () => {
    withBase("file:///C:/Program Files/CyberSafe/resources/app/dist/index.html", () => {
      const url = publicAssetUrl("branding", "matrix", "matrix-safe-bust-96.png");
      assert.ok(url.endsWith("/resources/app/dist/branding/matrix/matrix-safe-bust-96.png"), url);
      assert.ok(!url.startsWith("file:///branding/"), "nao pode cair na raiz do volume");
    });
  });

  test("nao emite caminho absoluto (barra inicial) — isso e o bug", () => {
    withBase("http://localhost:5173/", () => {
      assert.doesNotMatch(publicAssetUrl("branding", "favicon.png"), /^\/branding/);
    });
  });

  test("sem document (ambiente de teste puro) devolve o relativo, sem rebentar", () => {
    Object.defineProperty(globalThis, "document", { value: undefined, configurable: true, writable: true });
    try {
      assert.equal(publicAssetUrl("branding", "cybersafe", "tile-32.png"), "branding/cybersafe/tile-32.png");
    } finally {
      Object.defineProperty(globalThis, "document", { value: doc, configurable: true, writable: true });
    }
  });
});
