import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { SignatureDatabase, BUILTIN_HASH_SIGNATURES } from "../dist/signatures.js";

/**
 * RC22 — HASH DATABASE: consulta real, e o que a base NÃO é.
 *
 * Verifica, contra a base realmente instalada (`~/.cybersafe-service/
 * definitions/hashes/default.json`) e contra ficheiros de teste:
 *  - consulta por SHA-256 devolve o registo certo (positivo) e nada para um
 *    sha256 que não está na base (negativo);
 *  - base parcial é reconhecida e re-semeada com a cobertura built-in;
 *  - base corrompida/vazia cai na base embutida e NUNCA fica `active` vazia.
 *
 * Não descarrega nada, não escreve fora do tmp, não usa malware: o positivo é
 * um hash built-in cujo conteúdo nem é preciso ter.
 */

const WANNACRY_SHA = "24d004a104d4d54034dbcffc2a4b19a11f39008a575aa614ea04703480b1022c";

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc22-hash-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf8");
  return { dir, file };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

describe("RC22 HashDB — consulta real", () => {
  it("base instalada: positivo devolve o registo, negativo não devolve nada", async () => {
    const installed = path.join(
      os.homedir(),
      ".cybersafe-service",
      "definitions",
      "hashes",
      "default.json",
    );
    if (!fs.existsSync(installed)) return; // anfitrião sem base: nada a afirmar

    const db = new SignatureDatabase();
    await db.load(installed);
    assert.equal(db.health.status, "active");
    assert.ok(db.size >= 1);

    const hit = db.match(WANNACRY_SHA);
    assert.ok(hit, "o hash built-in tem de estar consultável na base instalada");
    assert.match(hit.family, /WannaCry/i);

    assert.equal(db.match(sha256("CyberSafe RC22 benigno")), undefined);
    assert.equal(db.match("nao-e-um-sha256"), undefined);
  });

  it("base parcial (só 1 registo) é corrigida, não declarada completa", async () => {
    const partial = BUILTIN_HASH_SIGNATURES.slice(0, 1).map((r) => ({ ...r }));
    const { dir, file } = tmpFile("default.json", JSON.stringify(partial, null, 2));
    try {
      const db = new SignatureDatabase();
      await db.load(file);
      const rewritten = await db.refreshBuiltinIfStale(file);
      assert.equal(rewritten, true, "uma base sem a cobertura built-in tem de ser re-semeada");
      for (const record of BUILTIN_HASH_SIGNATURES) {
        assert.ok(db.match(record.sha256), `falta ${record.family} depois do refresh`);
      }
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(onDisk.length, BUILTIN_HASH_SIGNATURES.length);
      assert.equal(db.health.status, "active");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON corrompido cai na base embutida e não fica active-com-nada", async () => {
    const { dir, file } = tmpFile("default.json", "{ isto nao e json");
    try {
      const db = new SignatureDatabase();
      await db.load(file);
      assert.equal(db.health.status, "degraded");
      assert.equal(db.size, BUILTIN_HASH_SIGNATURES.length);
      assert.equal(db.source, "built-in");
      assert.ok(db.match(WANNACRY_SHA));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("array vazio também não vira cobertura", async () => {
    const { dir, file } = tmpFile("default.json", "[]");
    try {
      const db = new SignatureDatabase();
      await db.load(file);
      assert.equal(db.health.status, "degraded");
      assert.ok(db.size > 0, "a base embutida garante deteção offline");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("base ausente: embutida, degradada, consultável", async () => {
    const missing = path.join(os.tmpdir(), `rc22-hash-ausente-${Date.now()}.json`);
    const db = new SignatureDatabase();
    await db.load(missing);
    assert.equal(db.health.status, "degraded");
    assert.equal(db.source, "built-in");
    assert.ok(db.match(WANNACRY_SHA));
  });
});
