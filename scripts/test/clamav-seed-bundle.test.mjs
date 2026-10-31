import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { CLAMAV_SEED_SCHEMA, verifyClamavSeedBundle } from "../clamav-seed-bundle.mjs";
import { buildAppManifest } from "../package-windows.mjs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-seed-gate-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const sha = (value) => createHash("sha256").update(value).digest("hex");

function fixture(name, { extra = null } = {}) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    "main.cvd": Buffer.from("MAIN"),
    "daily.cld": Buffer.from("DAILY"),
    "bytecode.cvd": Buffer.from("BYTE"),
    "COPYING.txt": Buffer.from("GPL"),
  };
  const expected = {};
  for (const [file, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), bytes);
    expected[file] = { bytes: bytes.length, sha256: sha(bytes) };
  }
  fs.writeFileSync(
    path.join(dir, "SEED-MANIFEST.json"),
    `${JSON.stringify({
      schema: CLAMAV_SEED_SCHEMA,
      engine: "ClamAV",
      binaryVersion: "1.5.4",
      license: { name: "GPL-2.0-only", file: "COPYING.txt", sha256: expected["COPYING.txt"].sha256 },
      files: Object.entries(expected)
        .filter(([file]) => file !== "COPYING.txt")
        .map(([file, entry]) => ({ name: file, ...entry })),
    }, null, 2)}\n`,
  );
  if (extra) fs.writeFileSync(path.join(dir, extra), "EXTRA");
  return { dir, expected };
}

test("packaging includes a verified read-only resource separately from mutable definitions", () => {
  const input = {
    clamavSeedDir: ROOT, productVersion: "0.1.10-internal.pap-r6.20261031",
    desktopManifest: { name: "desktop", build: { productName: "CyberSafe", directories: {}, win: {} } },
    tarballs: { "@cybersafe/core": "core.tgz", "@cybersafe/service": "service.tgz", "@cybersafe/shared-types": "shared.tgz", api: "api.tgz" }, desktopDir: ROOT, outDir: ROOT,
  };
  const manifest = buildAppManifest(input);
  assert.deepEqual(manifest.build.extraResources.find(entry => entry.to === "clamav-seed"), { from: ROOT, to: "clamav-seed" });
});

test("build preparer rejects unpinned input before creating output", () => {
  const out = path.join(ROOT, "must-not-be-created");
  const result = spawnSync(process.execPath, [new URL("../prepare-clamav-seed.mjs", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""), "--source", ROOT, "--out", out], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT|CLAMAV_SEED_INVALID/);
  assert.equal(fs.existsSync(out), false);
});

describe("gate da semente ClamAV", () => {
  test("aceita exactamente os três ficheiros e a licença com hashes fixados", () => {
    const { dir, expected } = fixture("valid");
    const result = verifyClamavSeedBundle(dir, { expected });
    assert.equal(result.ok, true, result.problems.join("; "));
    assert.equal(result.filesChecked, 4);
  });

  test("recusa um ficheiro extra não listado", () => {
    const { dir, expected } = fixture("extra", { extra: "unexpected.cvd" });
    const result = verifyClamavSeedBundle(dir, { expected });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => /extra não listado/.test(problem)));
  });

  test("recusa hash divergente mesmo com o manifesto a declarar o mesmo valor errado", () => {
    const { dir, expected } = fixture("wrong-hash");
    fs.writeFileSync(path.join(dir, "main.cvd"), "ALTERADO");
    const result = verifyClamavSeedBundle(dir, { expected });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => /sha256 divergente/.test(problem)));
  });
});
