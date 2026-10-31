import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { SignatureDatabase, sha256File, BUILTIN_HASH_SIGNATURES, DEV_CANARY_SIGNATURE } from "@cybersafe/core";

/**
 * SESSION14-04 — HashDB3 / Native signatures integrity (read-only)
 *
 * Fixture: marker sintético (DEV_CANARY_SIGNATURE). HashDB built-in offline
 * sempre ativo (3 registos). Testa: lookup de hash known, lookup de hash
 * desconhecido, seed via ensureFile faz built-in passar a active.
 */

const tmpDirs = [];
async function tmpDir() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "cs14-hashdb-"));
  tmpDirs.push(d);
  return d;
}

after(async () => {
  for (const d of tmpDirs) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

describe("SESSION14-04 HashDB3 / Native signatures integrity", () => {
  test("DEV_CANARY: hash conhecido pelo built-in offline (sem escrever conteúdo real)", async () => {
    const db = new SignatureDatabase();
    await db.load("/nonexistent/hashes.json");

    // db.match(hashhex) basta — sem fixture em disco, sem literal EICAR.
    const hit = db.match(DEV_CANARY_SIGNATURE.sha256);
    assert.ok(hit, "canário deve ser conhecido pelo built-in offline");
    assert.equal(hit.family, "CyberSafe-Test-File", "família correcta no canário");
  });

  test("fixture benigna: hash desconhecido (não falso positivo)", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "benign.txt");
    await fsp.writeFile(file, "This is completely benign text with a unique marker.\r\n", "utf8");

    const hash = await sha256File(file);
    const db = new SignatureDatabase();
    await db.load("/nonexistent/hashes.json");

    const hit = db.match(hash);
    assert.equal(hit, undefined, "hash benigno não deve estar na base");
  });

  test("SignatureDatabase health: built-in offline nunca unavailable/error", async () => {
    const db = new SignatureDatabase();
    await db.load("/nonexistent/hashes.json");

    assert.equal(db.size, BUILTIN_HASH_SIGNATURES.length, "built-in de 3 registos");
    assert.notEqual(
      db.health.status,
      "unavailable",
      "built-in offline nunca unavailable",
    );
    assert.notEqual(db.health.status, "error", "built-in offline não error");
    assert.equal(
      db.health.status,
      "degraded",
      "built-in via fallback carrega como degraded (não active sem seed em disco)",
    );
    assert.ok(
      db.health.detail.toLowerCase().includes("offline"),
      "detail menciona base offline",
    );
  });

  test("ensureFile sementeia built-in e passa a active", async () => {
    const db = new SignatureDatabase();
    await db.load("/nonexistent/hashes.json");

    const dir = await tmpDir();
    const seedFile = path.join(dir, "hashes.json");
    await db.ensureFile(seedFile);

    assert.equal(
      db.health.status,
      "active",
      "após ensureFile, SignatureDatabase deve ser active",
    );
    assert.equal(db.size, BUILTIN_HASH_SIGNATURES.length, "mantém 3 built-in");
  });
});
