/**
 * Regressao do SHA-256 do motor nativo.
 *
 * Contrato: para qualquer ficheiro, o campo sha256 do JSON devolvido por
 * scan-engine.exe tem de ser igual a crypto.createHash(sha256) do MESMO buffer.
 *
 * Bug coberto: o padding final em src/hash.cpp contava `total` (todos os bytes
 * lidos) em vez dos bytes efetivamente transformados. Com isso o tamanho do
 * bloco final saia errado, o loop `for (i = 0; i + 64 <= last.size(); ...)`
 * processava zero blocos, e o hash passava a ser o de um prefixo do ficheiro.
 * Sintoma medido: o hash so estava certo quando size % 64 == 0.
 *
 * Os tamanhos abaixo cobrem as tres frontiers criticas: bloco exacto (64),
 * padding so com 0x80 (55..57, 119..121) e fronteira do buffer de 64 KB
 * (8191..8193, 65535..65537).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "..", "build", "Release", "scan-engine.exe");

// 86096984 % 65536 == 48216: o resto do ficheiro real (bun.exe) que gerou o bug.
const SIZES = [
  0, 1, 2, 3, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129,
  8191, 8192, 8193, 65535, 65536, 65537, 131072, 48216,
];

let tmpDir = null;

/** Conteudo deterministico, sem EICAR e sem rede. */
function makeBuffer(size) {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 37 + 11) & 0xff;
  return buf;
}

function nativeSha256(filePath) {
  const out = execFileSync(BIN, [filePath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  assert.equal(typeof parsed.sha256, "string", "o JSON tem de expor sha256");
  return parsed.sha256;
}

before(async () => {
  if (!fs.existsSync(BIN)) return;
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cybersafe-hash-vec-"));
});

after(async () => {
  if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("SHA-256 do motor nativo", () => {
  it("binario ausente: SKIP explicito, nunca verde por nao ter executado", (t) => {
    if (!fs.existsSync(BIN)) {
      t.skip(`scan-engine.exe nao encontrado em ${BIN} — correr npm run build:native`);
      return;
    }
    assert.ok(fs.existsSync(BIN), "binario presente neste ramo");
  });

  for (const size of SIZES) {
    it(`size ${size} (${size % 64} mod 64) coincide com crypto.sha256`, (t) => {
      if (!fs.existsSync(BIN)) {
        t.skip(`scan-engine.exe nao encontrado em ${BIN}`);
        return;
      }
      const buf = makeBuffer(size);
      const file = path.join(tmpDir, `vec-${size}.bin`);
      fs.writeFileSync(file, buf);

      const expected = crypto.createHash("sha256").update(buf).digest("hex");
      const actual = nativeSha256(file);

      assert.equal(
        actual,
        expected,
        `size ${size}: motor=${actual} crypto=${expected}`,
      );
    });
  }
});
