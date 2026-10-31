import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/release-sign.yml"];

/**
 * Extrai blocos `run: |` sem depender de um parser YAML. O objetivo é impedir
 * expressões GitHub (`${{ ... }}`) dentro de shell: inputs do workflow nunca
 * podem ser interpolados no corpo do comando.
 */
function runBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i].match(/^(\s*)run:\s*\|\s*$/);
    if (!header) {
      const inline = lines[i].match(/^(\s*)run:\s*(?!\|)(.+)$/);
      if (inline) blocks.push(inline[2]);
      continue;
    }
    const baseIndent = header[1].length;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === "") {
        body.push("");
        continue;
      }
      const indent = line.match(/^\s*/)[0].length;
      if (indent <= baseIndent) break;
      body.push(line);
    }
    blocks.push(body.join("\n"));
    i = j - 1;
  }
  return blocks;
}

describe("workflows — segurança de shell", () => {
  for (const workflow of WORKFLOWS) {
    it(`${workflow}: nenhum run interpola expressões GitHub`, () => {
      const text = fs.readFileSync(path.join(REPO_ROOT, workflow), "utf8");
      const blocks = runBlocks(text);
      assert.ok(blocks.length > 0, "workflow sem run blocks inesperado");
      for (const block of blocks) {
        assert.ok(
          !block.includes("${{"),
          `expressão interpolada dentro de run em ${workflow}:\n${block}`,
        );
      }
    });
  }

  it("release-sign recebe o input por env, cita-o e entrega manifesto assinado", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/release-sign.yml"), "utf8");
    assert.match(text, /MANIFEST_PATH: \$\{\{ inputs\.manifest_path \}\}/);
    assert.match(text, /--sign-manifest "\$MANIFEST_PATH"/);
    assert.match(text, /--verify-embedded "\$SIGNED_MANIFEST"/);
    assert.match(text, /update-manifest\.signed\.json/);
    assert.ok(!/run:\s*\|\s*[\s\S]*?\$\{\{\s*inputs\.manifest_path\s*\}\}/.test(text));
  });

  it("release-sign não usa assinatura destacada como artefacto principal", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/release-sign.yml"), "utf8");
    assert.ok(!/path:\s*\$\{\{ runner\.temp \}\}\/update-manifest\.sig(?!ned)/.test(text));
    assert.ok(!/--sign "\$\{\{/.test(text));
  });
});
