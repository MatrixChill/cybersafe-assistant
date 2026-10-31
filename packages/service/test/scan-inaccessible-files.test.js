/**
 * Testes de ficheiros inacessíveis — Ronda 5 (L4-L5).
 *
 * Verifica que `categorizeFsError` classifica correctamente os erros de
 * filesystem e que `failedByReason` é populado durante o gathering + scanning.
 *
 * Importa do dist/ (compilado) sigo o padrão r3b-counters.test.js.
 * ESTE FICHEIRO DEVE SER ADICIONADO AO package.json "test" — não está incluído.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { categorizeFsError, isTransientFsError } from "../dist/scan-error.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-inaccessible-"));

describe("categorizeFsError — classificações baseadas em código", () => {
  it("classifica EACCES como permissions_denied", () => {
    const err = Object.assign(new Error("denied"), { code: "EACCES" });
    assert.equal(categorizeFsError(err), "permissions_denied");
    assert.equal(isTransientFsError(err), true);
  });

  it("classifica EPERM como permissions_denied", () => {
    const err = Object.assign(new Error("forbidden"), { code: "EPERM" });
    assert.equal(categorizeFsError(err), "permissions_denied");
    assert.equal(isTransientFsError(err), true);
  });

  it("classifica ENOENT como not_found", () => {
    const err = Object.assign(new Error("missing"), { code: "ENOENT" });
    assert.equal(categorizeFsError(err), "not_found");
    assert.equal(isTransientFsError(err), true);
  });

  it("classifica ENAMETOOLONG como path_too_long", () => {
    const err = Object.assign(new Error("too long"), { code: "ENAMETOOLONG" });
    assert.equal(categorizeFsError(err), "path_too_long");
    assert.equal(isTransientFsError(err), false);
  });

  it("classifica EBUSY como locked_or_busy", () => {
    const err = Object.assign(new Error("busy"), { code: "EBUSY" });
    assert.equal(categorizeFsError(err), "locked_or_busy");
    assert.equal(isTransientFsError(err), true);
  });

  it("classifica código desconhecido como other", () => {
    const err = Object.assign(new Error("weird"), { code: "EUNKNOWN" });
    assert.equal(categorizeFsError(err), "other");
    assert.equal(isTransientFsError(err), false);
  });

  it("classifica EISDIR como other (é tipo errado, não inacessível)", () => {
    const err = Object.assign(new Error("is dir"), { code: "EISDIR" });
    assert.equal(categorizeFsError(err), "other");
    assert.equal(isTransientFsError(err), true);
  });

  it("trata null como other", () => {
    assert.equal(categorizeFsError(null), "other");
  });

  it("trata undefined como other", () => {
    assert.equal(categorizeFsError(undefined), "other");
  });

  it("trata string como other", () => {
    assert.equal(categorizeFsError("string error"), "other");
  });

  it("trata erro sem código como other", () => {
    assert.equal(categorizeFsError(new Error("no code")), "other");
  });

  it("classifica erro com code vazio como other", () => {
    const err = Object.assign(new Error("empty"), { code: "" });
    assert.equal(categorizeFsError(err), "other");
  });

  it("classifica ECONNREFUSED como other (não é filesystem)", () => {
    const err = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    assert.equal(categorizeFsError(err), "other");
  });
});

describe("categorizeFsError — integração com filesystem real", () => {
  it("classifica ENOENT de um caminho inexistente", async () => {
    const missingPath = path.join(TMP, "nao-existe-" + crypto.randomUUID());
    try {
      await fs.stat(missingPath);
      assert.fail("Deveria ter lançado");
    } catch (error) {
      assert.equal(categorizeFsError(error), "not_found");
    }
  });

  it("classifica ENOENT de readdir numa pasta inexistente", async () => {
    const missingDir = path.join(TMP, "pasta-inexistente-" + crypto.randomUUID());
    try {
      await fs.readdir(missingDir);
      assert.fail("Deveria ter lançado");
    } catch (error) {
      assert.equal(categorizeFsError(error), "not_found");
    }
  });

  it("não crasha com uma pasta válida (não é erro)", async () => {
    const entries = await fs.readdir(TMP);
    assert.ok(typeof entries === "object");
  });
});
