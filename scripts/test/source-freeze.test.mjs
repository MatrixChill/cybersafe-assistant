/**
 * TESTES DO CONGELAMENTO DE FONTES (scripts/source-freeze.mjs).
 *
 * Isolados: tudo corre em fixtures em %TEMP%, sem compilar, instalar ou
 * empacotar nada. Provam o contrato fail-closed:
 *   1. manifesto ausente/digest adulterado/duplicados/colisões/traversal ⇒ bloqueia;
 *   2. adicionado/removido/modificado ⇒ bloqueia, com contagem e amostra;
 *   3. ilegível/leitura curta/mutação durante a leitura ⇒ bloqueia (retry máx. 1);
 *   4. junction ⇒ bloqueia; manifesto dentro da árvore não se auto-hasha;
 *   5. roots divergentes ⇒ bloqueia (o manifesto não pode encolher o contrato);
 *   6. --write sem approval válido ⇒ recusa (nunca há aprovação automática);
 *   7. o pipeline chama o gate PRE antes de compilar e o POS depois do builder;
 *   8. verify nunca escreve nada;
 *   9. assets/** entra no contrato; recursos obrigatórios ausentes/vazios
 *      bloqueiam, tal como segredos/perfis/dados de runtime em assets/.
 *
 * Uso: node --test scripts/test/source-freeze.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

import {
  APPROVER,
  buildManifest,
  digestEntries,
  validateApproval,
  validateEntryPath,
  verifySourceFreeze,
} from "../source-freeze.mjs";
import { runFreezeGatedPipeline } from "../package-windows.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const APPROVAL = { approvedBy: APPROVER, candidateId: "cand25-test", approvedAt: "2026-10-25T00:00:00.000Z" };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-freeze-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, content) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  put("package.json", "{}\n");
  put("package-lock.json", "{}\n");
  put("scripts/a.mjs", "export const a = 1;\n");
  put("packages/core/src/index.ts", "export const b = 2;\n");
  put("packages/native-engine/build/Release/scan-engine.exe", "MZ\n");
  put("vendor/clamav/VENDOR.json", "{}\n");
  put("assets/branding/logo.svg", "<svg/>\n");
  put("assets/licenses/THIRD-PARTY-NOTICES.txt", "Avisos de terceiros (fixture).\n");
  put("assets/licenses/PROVENANCE.json", '{"schema":1,"obrigacaoPorResolver":{"bloqueador":false,"evidencia":["fixture"]}}\n');
  put("assets/licenses/rust/textos/SPDX-MIT.txt", "MIT (fixture)\n");
  const manifestPath = path.join(root, "scripts", "source-freeze.approved.json");
  const writeManifest = () => {
    const manifest = buildManifest({ root, approval: APPROVAL, manifestPath });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  };
  return { root, put, manifestPath, writeManifest };
}

const kinds = (report) => report.problems.map((problem) => problem.kind);

/** Cria um link de ficheiro; se o Windows não deixar, cai para uma junction. */
function makeLink(root, target, link) {
  try {
    fs.symlinkSync(target, link, "file");
    return true;
  } catch {
    try {
      fs.symlinkSync(path.join(root, "packages"), link, "junction");
      return true;
    } catch {
      return false;
    }
  }
}

describe("source-freeze (manifesto aprovado, fail-closed)", () => {
  it("manifesto ausente bloqueia (não é aviso)", (t) => {
    const { root, manifestPath } = fixture(t);
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.equal(report.manifestPresent, false);
    assert.ok(kinds(report).includes("manifest-missing"));
  });

  it("árvore conforme passa e o manifesto não se auto-hasha", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.ok(report.counts.tree >= 6);
    assert.ok(!report.samples.added.some((item) => item.path.endsWith("source-freeze.approved.json")));
  });

  it("ficheiro adicionado bloqueia com contagem", (t) => {
    const { root, manifestPath, writeManifest, put } = fixture(t);
    writeManifest();
    put("packages/core/src/extra.ts", "export const c = 3;\n");
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.equal(report.counts.added, 1);
    assert.equal(report.samples.added[0].path, "packages/core/src/extra.ts");
  });

  it("ficheiro removido bloqueia", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    fs.rmSync(path.join(root, "scripts", "a.mjs"));
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.equal(report.counts.removed, 1);
  });

  it("conteúdo modificado bloqueia", (t) => {
    const { root, manifestPath, writeManifest, put } = fixture(t);
    writeManifest();
    put("packages/core/src/index.ts", "export const b = 999;\n");
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.equal(report.counts.modified, 1);
  });

  it("ilegível (EACCES) bloqueia depois de 1 retry", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    let attempts = 0;
    const deps = {
      readFileSync: (file, encoding) => {
        if (String(file).endsWith("index.ts")) {
          attempts += 1;
          const error = new Error("locked");
          error.code = "EACCES";
          throw error;
        }
        return fs.readFileSync(file, encoding);
      },
    };
    const report = verifySourceFreeze({ root, manifestPath, deps });
    assert.equal(report.ok, false);
    assert.ok(kinds(report).includes("unreadable"));
    assert.equal(attempts, 2, "retry máximo 1 (duas tentativas)");
  });

  it("leitura curta bloqueia", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    const deps = {
      readFileSync: (file, encoding) => {
        const buffer = fs.readFileSync(file, encoding);
        return String(file).endsWith("index.ts") ? buffer.subarray(0, 2) : buffer;
      },
    };
    const report = verifySourceFreeze({ root, manifestPath, deps });
    assert.equal(report.ok, false);
    assert.ok(kinds(report).includes("short-read"));
  });

  it("mutação durante a leitura bloqueia", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    let calls = 0;
    const deps = {
      statSync: (file) => {
        const real = fs.statSync(file);
        if (String(file).endsWith("index.ts")) {
          calls += 1;
          if (calls === 2) return { isFile: () => true, size: real.size, mtimeMs: real.mtimeMs + 1000 };
        }
        return real;
      },
    };
    const report = verifySourceFreeze({ root, manifestPath, deps });
    assert.equal(report.ok, false);
    assert.ok(kinds(report).includes("mutated"));
  });

  it("digest adulterado bloqueia", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    const manifest = writeManifest();
    manifest.entries[0].sha256 = "0".repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.detail === "digest não corresponde às entries"));
  });

  it("duplicados e colisões de maiúsculas bloqueiam", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    const manifest = writeManifest();
    manifest.entries.push({ ...manifest.entries[0] });
    manifest.entries.push({ path: "scripts/A.MJS", bytes: 1, sha256: "a".repeat(64) });
    manifest.entries.push({ path: "scripts/a.mjs", bytes: 1, sha256: "b".repeat(64) });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.detail === "duplicado"));
    assert.ok(report.problems.some((problem) => String(problem.detail).startsWith("colisão de maiúsculas")));
  });

  it("path traversal e absolutos bloqueiam", (t) => {
    const { root } = fixture(t);
    assert.equal(validateEntryPath("../fora.txt"), "traversal");
    assert.equal(validateEntryPath("/abs.txt"), "absolute");
    assert.equal(validateEntryPath("C:/abs.txt"), "absolute");
    assert.equal(validateEntryPath("a\\b.txt"), "backslash");
    assert.equal(validateEntryPath("a/b.txt"), null);
    void root;
  });

  it("roots divergentes bloqueiam (manifesto não encolhe o contrato)", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    const manifest = writeManifest();
    manifest.roots = manifest.roots.filter((entry) => entry !== "scripts");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.ok(kinds(report).includes("roots-divergentes"));
  });

  it("junction dentro da árvore bloqueia", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    const target = path.join(root, "packages", "core", "src");
    const link = path.join(root, "packages", "core", "src-link");
    try {
      fs.symlinkSync(target, link, "junction");
    } catch (error) {
      t.skip(`junction indisponível: ${error?.code}`);
      return;
    }
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.ok(kinds(report).includes("link"));
  });

  it("--write sem approval autorizado é recusado", () => {
    assert.ok(validateApproval({ approvedBy: "outro", candidateId: "x", approvedAt: APPROVAL.approvedAt }).length > 0);
    assert.ok(validateApproval({ approvedBy: APPROVER, candidateId: "", approvedAt: APPROVAL.approvedAt }).length > 0);
    assert.ok(validateApproval({ approvedBy: APPROVER, candidateId: "x", approvedAt: "nao-e-data" }).length > 0);
    assert.deepEqual(validateApproval(APPROVAL), []);
  });

  it("approval dentro da raiz é recusado (não há auto-aprovação)", (t) => {
    const { root } = fixture(t);
    const problems = validateApproval(APPROVAL, { root, approvalPath: path.join(root, "approval.json") });
    assert.ok(problems.some((problem) => problem.detail === "approval dentro da raiz"));
  });

  it("o digest é determinístico entre construções", (t) => {
    const { root, manifestPath } = fixture(t);
    const first = buildManifest({ root, approval: APPROVAL, manifestPath });
    const second = buildManifest({ root, approval: APPROVAL, manifestPath });
    assert.equal(first.digest, second.digest);
    assert.equal(first.digest, digestEntries(first.entries));
  });

  it("verify nunca escreve nada", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    const snapshot = () =>
      fs
        .readdirSync(root, { recursive: true })
        .map(String)
        .sort();
    const before = snapshot();
    verifySourceFreeze({ root, manifestPath });
    assert.deepEqual(snapshot(), before);
  });

  it("raiz ilegível (EACCES) bloqueia — o contrato não pode encolher em silêncio", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    const denied = (dir) => {
      if (path.resolve(String(dir)) === path.resolve(root)) {
        const error = new Error("denied");
        error.code = "EACCES";
        throw error;
      }
      return fs.readdirSync(dir, { withFileTypes: true });
    };
    const report = verifySourceFreeze({ root, manifestPath, deps: { readdirSync: denied } });
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.kind === "unreadable"));
    assert.throws(
      () => buildManifest({ root, approval: APPROVAL, manifestPath, deps: { readdirSync: denied } }),
      /raiz ilegível/,
    );
  });

  it("cache de build e saídas geradas não alteram o freeze; fonte/config altera", (t) => {
    const { root, manifestPath, writeManifest, put } = fixture(t);
    const before = writeManifest();
    // Outputs do tsc e do pipeline: nunca entram no manifesto.
    put("packages/shared-types/tsconfig.tsbuildinfo", '{"program":{}}\n');
    put("packages/core/dist/index.js", "module.exports = {};\n");
    put("packages/desktop/release/out.txt", "x\n");
    put("packages/core/node_modules/dep/index.js", "x\n");
    put("packages/core/logs/run.log", "x\n");
    put("packages/core/coverage/lcov.info", "x\n");
    put("packages/core/build/obj.o", "x\n");
    const cached = verifySourceFreeze({ root, manifestPath });
    assert.equal(cached.ok, true, JSON.stringify(cached.problems));
    assert.equal(cached.treeDigest, before.digest, "cache/saídas geradas não podem mudar o digest");

    // Uma fonte muda → bloqueia.
    put("packages/core/src/index.ts", "export const b = 0;\n");
    const source = verifySourceFreeze({ root, manifestPath });
    assert.equal(source.ok, false);
    assert.equal(source.counts.modified, 1);

    // Um config muda → bloqueia.
    put("packages/core/src/index.ts", "export const b = 2;\n");
    put("package.json", '{"name":"x"}\n');
    const config = verifySourceFreeze({ root, manifestPath });
    assert.equal(config.ok, false);
    assert.ok(config.counts.modified >= 1);
  });

  it("o pipeline usa o driver com os três gates (PRE, PRE-builder, POS)", () => {
    const source = fs.readFileSync(path.join(HERE, "..", "package-windows.mjs"), "utf8");
    assert.ok(source.includes("runFreezeGatedPipeline({"), "o pipeline tem de usar o driver injectável");
    const driver = source.slice(source.indexOf("export function runFreezeGatedPipeline"));
    const order = [
      'gate("PRE")',
      "stages.workspaces()",
      'gate("PRE-builder")',
      "stages.builder()",
      'gate("POS")',
      "stages.promote()",
    ].map((token) => driver.indexOf(token));
    assert.ok(order.every((index) => index > 0), "os três gates e os três passos têm de estar no driver");
    assert.deepEqual([...order].sort((a, b) => a - b), order, "ordem: PRE → workspaces → PRE-builder → builder → POS → promote");
    assert.ok(source.includes("SOURCE-FREEZE-FAILED.json"), "a falha POS marca a candidata como não entregável");
    assert.ok(!source.includes("--write"), "o pipeline nunca escreve o manifesto (sem auto-repin)");
  });
});

describe("driver de gates (spies, sem build real)", () => {
  const fail = (phase) => ({
    ok: false,
    phase,
    manifestPath: "X",
    manifestPresent: true,
    counts: { added: 0, removed: 0, modified: 0, unreadable: 0, links: 0, mutated: 0 },
    problems: [{ kind: "manifest-missing", path: "X", detail: "sem manifesto" }],
    samples: {},
  });
  const pass = { ok: true, counts: { tree: 3 }, treeDigest: "digest", problems: [], samples: {} };

  const spies = (calls) => ({
    workspaces: () => calls.push("workspaces"),
    builder: () => calls.push("builder"),
    promote: () => calls.push("promote"),
  });

  it("PRE falhado: zero build calls (workspaces/builder/promote não correm)", () => {
    const calls = [];
    const failed = [];
    assert.throws(
      () =>
        runFreezeGatedPipeline({
          verify: (phase) => {
            calls.push(`verify:${phase}`);
            return fail(phase);
          },
          stages: spies(calls),
          onGateFail: (phase) => failed.push(phase),
        }),
      (error) => error.name === "SourceFreezeError" && error.phase === "PRE",
    );
    assert.deepEqual(calls, ["verify:PRE"], "nada pode correr antes do gate PRE passar");
    assert.deepEqual(failed, ["PRE"]);
  });

  it("PRE-builder falhado: compilou mas não empacotou", () => {
    const calls = [];
    assert.throws(
      () =>
        runFreezeGatedPipeline({
          verify: (phase) => {
            calls.push(`verify:${phase}`);
            return phase === "PRE-builder" ? fail(phase) : pass;
          },
          stages: spies(calls),
        }),
      (error) => error.phase === "PRE-builder" && error.phasesDone.includes("gate:PRE"),
    );
    assert.deepEqual(calls, ["verify:PRE", "workspaces", "verify:PRE-builder"]);
  });

  it("POS falhado: construiu mas não promoveu (zero promotion)", () => {
    const calls = [];
    const failed = [];
    assert.throws(
      () =>
        runFreezeGatedPipeline({
          verify: (phase) => {
            calls.push(`verify:${phase}`);
            return phase === "POS" ? fail(phase) : pass;
          },
          stages: spies(calls),
          onGateFail: (phase) => failed.push(phase),
        }),
      (error) => error.phase === "POS",
    );
    assert.deepEqual(calls, ["verify:PRE", "workspaces", "verify:PRE-builder", "builder", "verify:POS"]);
    assert.deepEqual(failed, ["POS"], "o POS é o único gate que marca a candidata como não entregável");
  });

  it("três gates verdes: promove uma única vez", () => {
    const calls = [];
    const done = runFreezeGatedPipeline({ verify: () => pass, stages: spies(calls) });
    assert.deepEqual(calls, ["workspaces", "builder", "promote"]);
    assert.deepEqual(done, ["gate:PRE", "gate:PRE-builder", "gate:POS"]);
  });
});

describe("configs de raiz (tipo não importa: link/pasta nunca passam)", () => {
  it("uma pasta chamada tsconfig.json bloqueia (root de ficheiro é pasta)", (t) => {
    const { root, manifestPath } = fixture(t);
    fs.mkdirSync(path.join(root, "tsconfig.json"));
    assert.throws(
      () => buildManifest({ root, approval: APPROVAL, manifestPath }),
      (error) => error.name === "FreezeError" && error.report.problems.some((problem) => problem.kind === "not-file" && problem.path === "tsconfig.json"),
    );
  });

  it("um .npmrc que é link bloqueia (não é ignorado por não ser ficheiro)", (t) => {
    const { root, manifestPath } = fixture(t);
    const link = path.join(root, ".npmrc");
    if (!makeLink(root, path.join(root, "package.json"), link)) {
      t.skip("sem privilégio para criar link nesta máquina");
      return;
    }
    assert.throws(
      () => buildManifest({ root, approval: APPROVAL, manifestPath }),
      (error) => error.name === "FreezeError" && error.report.problems.some((problem) => problem.kind === "link" && problem.path === ".npmrc"),
    );
  });

  it("um link de config que aparece depois da aprovação muda os roots e bloqueia", (t) => {
    const { root, manifestPath, writeManifest } = fixture(t);
    writeManifest();
    const link = path.join(root, "vite.config.ts");
    if (!makeLink(root, path.join(root, "package.json"), link)) {
      t.skip("sem privilégio para criar link nesta máquina");
      return;
    }
    const report = verifySourceFreeze({ root, manifestPath });
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.kind === "roots-divergentes"));
  });
});
