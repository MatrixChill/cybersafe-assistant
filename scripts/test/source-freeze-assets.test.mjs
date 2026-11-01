/**
 * TESTES DIRIGIDOS — `assets/**` dentro do source-freeze (FREEZE-ASSETS).
 *
 * Provam o contrato que faltava, sem build, sem instalar e sem tocar em U:
 *   A. assets revistos (branding + corpus de licenças) passam a fazer parte
 *      do manifesto, com SHA-256 por ficheiro;
 *   B. recurso obrigatório removido (ou a pasta inteira) ⇒ FAIL;
 *   C. recurso protegido alterado ⇒ FAIL;
 *   D. manifesto de proveniência adulterado e digest do manifesto adulterado ⇒ FAIL;
 *   E. segredo/perfil/runtime-data introduzido em `assets/` ⇒ FAIL (e nunca
 *      entra no manifesto);
 *   G. `verify` não escreve e o gate do pipeline não corre passos quando falha;
 *      uma aprovação que não seja do integrador autorizado nunca passa.
 *
 * `APPROVAL` é um fixture de teste (como em `source-freeze.test.mjs`): não é,
 * e nunca pode ser usado como, aprovação de candidata.
 *
 * Uso: node --test scripts/test/source-freeze-assets.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  APPROVER,
  FreezeError,
  buildManifest,
  digestEntries,
  requiredAssetProblems,
  verifySourceFreeze,
} from "../source-freeze.mjs";
import { runFreezeGatedPipeline } from "../package-windows.mjs";

const APPROVAL = { approvedBy: APPROVER, candidateId: "lane-freeze-assets-fixture", approvedAt: "2026-10-25T00:00:00.000Z" };
const NOTICES = "assets/licenses/THIRD-PARTY-NOTICES.txt";
const PROVENANCE = "assets/licenses/PROVENANCE.json";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-freeze-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, content) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  put("package.json", "{}\n");
  put("package-lock.json", "{}\n");
  put("product-version.json", '{"version":"0.1.11","channel":"internal","codename":"fixture"}\n');
  put("scripts/a.mjs", "export const a = 1;\n");
  put("packages/core/src/index.ts", "export const b = 2;\n");
  put("packages/native-engine/build/Release/scan-engine.exe", "MZ\n");
  put("vendor/clamav/VENDOR.json", "{}\n");
  put("assets/branding/logo.svg", "<svg/>\n");
  put("assets/licenses/rust/textos/SPDX-MIT.txt", "MIT (fixture)\n");
  put(NOTICES, "Avisos de terceiros (fixture).\n");
  put(PROVENANCE, '{"schema":1,"obrigacaoPorResolver":{"bloqueador":false,"evidencia":["fixture"]}}\n');
  const manifestPath = path.join(root, "scripts", "source-freeze.approved.json");
  const writeManifest = (approval = APPROVAL) => {
    const manifest = buildManifest({ root, approval, manifestPath });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  };
  return { root, put, manifestPath, writeManifest };
}

const snapshot = (dir) => {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, entry.name);
      const rel = path.relative(dir, abs).split(path.sep).join("/");
      if (entry.isDirectory()) walk(abs);
      else {
        const stat = fs.statSync(abs);
        out.push(`${rel}|${stat.size}|${stat.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.join("\n");
};

describe("source-freeze: assets publicados", () => {
  it("A. assets revistos entram no contrato e verificam", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    const manifest = writeManifest();
    const paths = manifest.entries.map((entry) => entry.path);
    assert.ok(paths.includes(NOTICES), "notices obrigatórios no manifesto");
    assert.ok(paths.includes(PROVENANCE), "proveniência obrigatória no manifesto");
    assert.ok(paths.includes("assets/branding/logo.svg"), "branding distribuído no manifesto");
    assert.ok(manifest.roots.includes("assets"), "assets é root do contrato");
    assert.equal(manifest.digest, digestEntries(manifest.entries));

    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.ok(report.counts.tree >= 10);
    assert.ok(report.treeDigest);
  });

  it("B. recurso obrigatório removido bloqueia como required-missing", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    fs.rmSync(path.join(root, PROVENANCE));
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.kind === "required-missing" && problem.path === PROVENANCE));
    assert.equal(report.counts.required, 1);
    assert.equal(report.counts.removed, 0, "a ausência é reportada como recurso obrigatório, não como remoção");
  });

  it("B. recurso obrigatório vazio bloqueia como required-empty", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    fs.writeFileSync(path.join(root, NOTICES), "");
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.kind === "required-empty" && problem.path === NOTICES));
  });

  it("B. pasta assets inteira removida bloqueia como missing-root", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    fs.rmSync(path.join(root, "assets"), { recursive: true, force: true });
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.kind === "missing-root" && problem.path === "assets"));
  });

  it("C. recurso protegido alterado bloqueia como modified", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    fs.writeFileSync(path.join(root, NOTICES), "Avisos de terceiros (ALTERADO).\n");
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.equal(report.counts.modified, 1);
    assert.equal(report.samples.modified[0].path, NOTICES);
  });

  it("D. manifesto de proveniência adulterado bloqueia", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    fs.writeFileSync(path.join(root, PROVENANCE), '{"schema":1,"obrigacaoPorResolver":{"bloqueador":false}}\n');
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.equal(report.counts.modified, 1);
    assert.equal(report.samples.modified[0].path, PROVENANCE);
  });

  it("D. digest do manifesto aprovado adulterado bloqueia", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    const tampered = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    tampered.digest = "0".repeat(64);
    fs.writeFileSync(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.kind === "manifest-invalid" && /digest/.test(problem.detail)));
  });

  it("E. ficheiro privado introduzido em assets bloqueia e não é congelado", (t) => {
    const { root, manifestPath, writeManifest, put } = fixture(t);
    writeManifest();
    put("assets/licenses/runtime-data/perfil.json", '{"token":"NAO-E-UM-SEGREDO-REAL"}\n');
    put("assets/licenses/.env", "FAKE=1\n");
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    const forbidden = report.problems.filter((problem) => problem.kind === "forbidden-asset").map((problem) => problem.path);
    assert.ok(forbidden.includes("assets/licenses/runtime-data/perfil.json"));
    assert.ok(forbidden.includes("assets/licenses/.env"));

    assert.throws(
      () => buildManifest({ root, approval: APPROVAL, manifestPath }),
      (error) => error instanceof FreezeError && error.report.problems.some((problem) => problem.kind === "forbidden-asset"),
    );
  });

  it("E. regressão Codex: .env-private, logs/ e ficheiros gerados dentro de assets nunca passam", (t) => {
    const { root, manifestPath, writeManifest, put } = fixture(t);
    writeManifest();
    put("assets/licenses/.env-private", "FAKE=1\n");
    put("assets/licenses/.env.production.local", "FAKE=1\n");
    put("assets/licenses/logs/private.json", "NAO-E-UM-SEGREDO-REAL\n");
    put("assets/licenses/dist/bundle.js", "export const fixture = true;\n");
    put("assets/licenses/notes.log", "fixture\n");
    put("assets/licenses/server.key.bak", "NAO-E-UMA-CHAVE-REAL\n");
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    const forbidden = report.problems.filter((problem) => problem.kind === "forbidden-asset").map((problem) => problem.path);
    for (const rel of [
      "assets/licenses/.env-private",
      "assets/licenses/.env.production.local",
      "assets/licenses/logs",
      "assets/licenses/dist",
      "assets/licenses/notes.log",
      "assets/licenses/server.key.bak",
    ]) {
      assert.ok(forbidden.includes(rel), `não bloqueou ${rel}: ${JSON.stringify(forbidden)}`);
    }
    assert.throws(
      () => buildManifest({ root, approval: APPROVAL, manifestPath }),
      (error) => error instanceof FreezeError && error.report.problems.some((problem) => problem.kind === "forbidden-asset"),
    );
  });

  it("G. verify nunca escreve (árvore e manifesto byte-idênticos)", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    const before = snapshot(root);
    verifySourceFreeze({ root, manifestPath });
    assert.equal(snapshot(root), before);
  });

  it("G. pipeline não corre passos quando o gate falha", () => {
    const calls = [];
    const failed = { ok: false, problems: [{ kind: "required-missing", path: NOTICES }], samples: {} };
    assert.throws(
      () =>
        runFreezeGatedPipeline({
          stages: { workspaces: () => calls.push("workspaces"), builder: () => calls.push("builder"), promote: () => calls.push("promote") },
          verify: () => failed,
          onGateFail: () => calls.push("gate-fail"),
        }),
      /source-freeze: fontes divergentes/,
    );
    assert.deepEqual(calls, ["gate-fail"]);
  });

  it("G. aprovação que não seja o integrador autorizado nunca passa", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest({ ...APPROVAL, approvedBy: "Outro Agente" });
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.kind === "manifest-invalid" && /approvedBy/.test(problem.detail)));
  });

  it("os dois recursos obrigatórios são exatamente os que o pipeline exige", () => {
    const problems = requiredAssetProblems([{ path: NOTICES, bytes: 10 }, { path: PROVENANCE, bytes: 10 }]);
    assert.deepEqual(problems, []);
    assert.equal(requiredAssetProblems([]).length, 2);
  });
});
