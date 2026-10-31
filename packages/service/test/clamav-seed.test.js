import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLAMAV_SEED_SCHEMA, seedClamavDatabase } from "../dist/clamav-seed.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-clamav-seed-"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

before(() => fs.mkdirSync(ROOT, { recursive: true }));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function makeSeed(name, files = { "main.cvd": "MAIN", "daily.cld": "DAILY", "bytecode.cvd": "BYTE" }) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const entries = Object.entries(files).map(([file, content]) => {
    const bytes = Buffer.from(content);
    fs.writeFileSync(path.join(dir, file), bytes);
    return { name: file, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const license = Buffer.from("GPL-2.0-only test license");
  fs.writeFileSync(path.join(dir, "COPYING.txt"), license);
  fs.writeFileSync(
    path.join(dir, "SEED-MANIFEST.json"),
    `${JSON.stringify({
      schema: CLAMAV_SEED_SCHEMA,
      engine: "ClamAV",
      files: entries,
      license: { name: "GPL-2.0-only", file: "COPYING.txt", sha256: sha256(license) },
    }, null, 2)}\n`,
  );
  return dir;
}

function definitions(name) {
  return path.join(ROOT, `definitions-${name}`);
}

describe("semente ClamAV — copy-if-missing", () => {
  test("copia os três ficheiros quando a base ainda não existe", async () => {
    const seedDir = makeSeed("valid");
    const definitionsDir = definitions("clean");
    const result = await seedClamavDatabase({ seedDir, definitionsDir });
    assert.equal(result.status, "seeded");
    for (const [name, content] of Object.entries({ "main.cvd": "MAIN", "daily.cld": "DAILY", "bytecode.cvd": "BYTE" })) {
      assert.equal(fs.readFileSync(path.join(definitionsDir, "clamav", name), "utf8"), content);
    }
  });

  test("uma base oficial existente é preservada inteira: não há overwrite nem mistura", async () => {
    const seedDir = makeSeed("existing");
    const definitionsDir = definitions("existing");
    const dbDir = path.join(definitionsDir, "clamav");
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, "main.cvd"), "BASE-DO-UTILIZADOR");
    const result = await seedClamavDatabase({ seedDir, definitionsDir });
    assert.equal(result.status, "preserved-existing");
    assert.equal(fs.readFileSync(path.join(dbDir, "main.cvd"), "utf8"), "BASE-DO-UTILIZADOR");
    assert.equal(fs.existsSync(path.join(dbDir, "daily.cld")), false, "não pode completar uma base existente com uma versão diferente");
  });

  test("hash divergente recusa a semente antes de escrever", async () => {
    const seedDir = makeSeed("tampered");
    const definitionsDir = definitions("tampered");
    const manifestPath = path.join(seedDir, "SEED-MANIFEST.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.files[0].sha256 = "0".repeat(64);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = await seedClamavDatabase({ seedDir, definitionsDir });
    assert.equal(result.status, "invalid");
    assert.equal(fs.existsSync(path.join(definitionsDir, "clamav")), false);
  });

  test("sem CYBERSAFE_CLAMAV_SEED_DIR o estado é not-provided, não um falso sucesso", async () => {
    const result = await seedClamavDatabase({ seedDir: "", definitionsDir: definitions("none") });
    assert.equal(result.status, "not-provided");
    assert.match(result.reason, /não definido/);
  });

  test("licença ausente recusa a semente", async () => {
    const seedDir = makeSeed("no-license");
    const definitionsDir = definitions("no-license");
    fs.rmSync(path.join(seedDir, "COPYING.txt"));
    const result = await seedClamavDatabase({ seedDir, definitionsDir });
    assert.equal(result.status, "invalid");
    assert.match(result.reason, /COPYING/);
    assert.equal(fs.existsSync(path.join(definitionsDir, "clamav")), false);
  });
});
