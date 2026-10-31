import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { YaraEngine } from "@cybersafe/core";

/**
 * SESSION14-02 — YARA engine integrity (read-only)
 *
 * Fixture: ficheiro texto benigno em TEMP.
 * Regras: canário dev-only (2 regras). YARA deve reportar degraded/limited,
 * nunca active/normal com canário. Não falso positivo em conteúdo limpo.
 *
 * NOTA: scanFile retorna YaraMatch[] directamente (não {matches}).
 */

const tmpDirs = [];
async function tmpDir() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "cs14-yara-"));
  tmpDirs.push(d);
  return d;
}

async function writeFixture(dir, name, content) {
  const file = path.join(dir, name);
  await fsp.writeFile(file, content, "utf8");
  return file;
}

after(async () => {
  for (const d of tmpDirs) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

const CANARY =
  '// cybersafe-fallback-canary\n' +
  'rule CyberSafe_Canary_Marker\n' +
  '{\n' +
  ' strings:\n' +
  ' $e = "CYBERSAFE-CANARY-MARKER-9f3a7b2c"\n' +
  ' condition:\n' +
  ' $e\n' +
  '}\n' +
  'rule CyberSafe_Canary_Generic\n' +
  '{\n' +
  ' strings:\n' +
  ' $g = "EvilStringParaDeteccao"\n' +
  ' condition:\n' +
  ' $g\n' +
  '}\n';

describe("SESSION14-02 YARA engine integrity", () => {
  test("canário dev-only com 2 regras: status degraded, coverage limited", async () => {
    const dir = await tmpDir();
    const rulesFile = path.join(dir, "rules.yar");
    await fsp.writeFile(rulesFile, CANARY, "utf8");

    const yara = new YaraEngine(rulesFile);
    await yara.load(rulesFile);

    assert.equal(yara.health.status, "degraded", "canário → degraded");
    assert.equal(
      yara.health.coverage,
      "limited",
      "canário → coverage limited",
    );
  });

  test("fixture benigna (sem marker) não produz matches", async () => {
    const dir = await tmpDir();
    const file = await writeFixture(dir, "benign.txt", "This is completely benign text.\n");
    const rulesFile = path.join(dir, "rules.yar");
    await fsp.writeFile(rulesFile, CANARY, "utf8");

    const yara = new YaraEngine(rulesFile);
    await yara.load(rulesFile);

    const matches = await yara.scanFile(file);
    assert.equal(matches.length, 0, "sem matches em conteúdo limpo");
  });

  test("marker sintético é detetido pelo canário YARA", async () => {
    const dir = await tmpDir();
    const markerContent = 'CYBERSAFE-CANARY-MARKER-9f3a7b2c';
    const file = await writeFixture(dir, "marker.txt", markerContent);
    const rulesFile = path.join(dir, "rules.yar");

    await fsp.writeFile(rulesFile, CANARY, "utf8");

    const yara = new YaraEngine(rulesFile);
    await yara.load(rulesFile);

    const matches = await yara.scanFile(file);
    assert.ok(matches.length > 0, "marker sintético deve ser detetido pelo canário");
  });

  test("health sem init não é active (estado pre-carregamento)", () => {
    const yara = new YaraEngine("/nonexistent/rules.yar");
    assert.notEqual(
      yara.health.status,
      "active",
      "sem load bem-sucedido, não active",
    );
  });
});
