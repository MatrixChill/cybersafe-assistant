import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import ts from "typescript";

// Execute the current implementation, not a possibly stale dist build.
// Only synthetic files under one freshly created temporary root are touched.
const reproduceOld = process.env.CYBERSAFE_R6_L14_REPRODUCE_OLD === "1";
const sourceUrl = reproduceOld
  ? new URL("../../../.maestri/backups/response.ts.20261012T133052Z.bak", import.meta.url)
  : new URL("../../core/src/response.ts", import.meta.url);
const source = await fs.readFile(sourceUrl, "utf8");
if (reproduceOld) {
  assert.equal(crypto.createHash("sha256").update(source).digest("hex"),
    "a4c62f570c6685249689179c12602440bb25e3690bc71d23818801eacd3b72d4",
    "opt-in reproduction uses the Maestro's preserved implementation only");
}
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { QuarantineManager } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const hash = content => crypto.createHash("sha256").update(content).digest("hex");
const exists = async file => fs.access(file).then(() => true, () => false);
const secureExpectation = !reproduceOld || process.env.CYBERSAFE_R6_L14_EXPECT_SAFE === "1";

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-r6-l14-"));
  const base = path.join(root, "service-data");
  const directory = path.join(base, "quarantine");
  const destination = path.join(root, "destination");
  await fs.mkdir(directory, {recursive:true});
  await fs.mkdir(destination, {recursive:true});
  const original = path.join(destination, "fixture.txt");
  const quarantined = path.join(directory, "fixture.quarantine");
  const manifest = path.join(directory, "manifest.json");
  const content = "BENIGN_R6_L14_FIXTURE_ONLY";
  const entry = {
    id:"fixture-id", originalPath:original, quarantinePath:quarantined,
    fileName:"fixture.txt", sha256:hash(content), verdict:"malicious", riskScore:90,
    detectionReason:"synthetic test metadata, no malware", quarantinedAt:"2026-10-12T00:00:00.000Z",
  };
  // The verdict is synthetic fixture metadata; no malware or EICAR is used.
  async function manager(entries = [entry]) {
    await fs.writeFile(manifest, JSON.stringify(entries));
    const instance = new QuarantineManager(base);
    await instance.init();
    return instance;
  }
  try { await run({root,base,directory,destination,original,quarantined,manifest,content,entry,manager}); }
  finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("cybersafe-r6-l14-"));
    await fs.rm(root, {recursive:true,force:true});
  }
}

test("controlo: restore recusa origem fora da quarentena, sem mover ficheiros", async () => fixture(async f => {
  const outside = path.join(f.root, "outside-quarantine.txt");
  await fs.writeFile(outside, f.content);
  const manager = await f.manager([{...f.entry, quarantinePath:outside}]);
  const result = await manager.restore(f.entry.id);
  assert.equal(result.success, false);
  assert.match(result.error, /Caminho de quarentena invalido/);
  assert.equal(await fs.readFile(outside,"utf8"), f.content);
  assert.equal(await exists(f.original), false);
}));

test("segurança: delete recusa traversal fora da quarentena", async () => fixture(async f => {
  const outside = path.join(f.root, "outside-quarantine.txt");
  await fs.writeFile(outside, f.content);
  const traversed = f.directory + path.sep + ".." + path.sep + ".." + path.sep + "outside-quarantine.txt";
  assert.equal(path.resolve(traversed), outside);
  const manager = await f.manager([{...f.entry, quarantinePath:traversed}]);
  const result = await manager.delete(f.entry.id);
  if (secureExpectation) {
    assert.equal(result.success, false, "delete must reject traversal before filesystem effects");
    assert.equal(await exists(outside), true);
    await fixture(async g => {
      const target = path.join(g.root, "benign-hardlink-target.txt");
      await fs.writeFile(target, g.content);
      await fs.link(target, g.quarantined);
      const instance = await g.manager();
      assert.equal((await instance.delete(g.entry.id)).success, false);
      assert.equal((await instance.restore(g.entry.id)).success, false);
      assert.equal(await fs.readFile(target,"utf8"), g.content);
      assert.equal(await exists(g.quarantined), true);
    });
  } else {
    // Explicit defect characterisation; passing does not mean security is fixed.
    assert.equal(result.success, true);
    assert.equal(await exists(outside), false, "actual fixture outside quarantine was deleted");
    assert.equal(manager.list().length, 0);
  }
}));

test("controlo: restore não substitui destino já existente e mantém metadados", async () => fixture(async f => {
  await fs.writeFile(f.quarantined, f.content);
  await fs.writeFile(f.original, "EXISTING_BENIGN_FIXTURE");
  const manager = await f.manager();
  const result = await manager.restore(f.entry.id);
  assert.equal(result.success, false);
  assert.match(result.error, /Ja existe/);
  assert.equal(await fs.readFile(f.original,"utf8"), "EXISTING_BENIGN_FIXTURE");
  assert.equal(await fs.readFile(f.quarantined,"utf8"), f.content);
  assert.equal(manager.list().length, 1);
  const restarted = new QuarantineManager(f.base);
  await restarted.init();
  assert.equal(restarted.list().length, 1);
}));

test("segurança: restore recusa conteúdo cujo digest difere dos metadados", async () => fixture(async f => {
  const changed = "CHANGED_BENIGN_R6_L14_FIXTURE";
  await fs.writeFile(f.quarantined, changed);
  const manager = await f.manager();
  const result = await manager.restore(f.entry.id);
  if (secureExpectation) {
    assert.equal(result.success, false, "integrity mismatch must be refused before restoration");
    assert.equal(await exists(f.original), false);
  } else {
    assert.equal(result.success, true);
    const restored = await fs.readFile(f.original,"utf8");
    assert.equal(restored, changed);
    assert.notEqual(hash(restored), f.entry.sha256);
  }
}));

test("segurança: falha do manifesto recusa restauro antes de efeitos", async () => fixture(async f => {
  await fs.writeFile(f.quarantined, f.content);
  const manager = await f.manager();
  // An actual EISDIR failure in this fixture, not a fake restore result.
  await fs.unlink(f.manifest);
  await fs.mkdir(f.manifest);
  const result = await manager.restore(f.entry.id);
  assert.equal(result.success, false);
  assert.ok(result.error);
  if (secureExpectation) {
    assert.equal(await exists(f.original), false, "failed restoration must not leave an unreported restored file");
    assert.equal(manager.list().length, 1);
    // A later commit failure cannot honestly claim that restoration/deletion had no effect.
    for (const operation of ["restore", "delete"]) {
      await fixture(async g => {
        await fs.writeFile(g.quarantined, g.content);
        const instance = await g.manager();
        const rename = fs.rename;
        let commits = 0;
        let outcome;
        try {
          fs.rename = async (...args) => {
            if (path.resolve(args[1]) === g.manifest && ++commits === 2) {
              throw Object.assign(new Error("SYNTHETIC_FINAL_MANIFEST_FAILURE"), {code:"EIO"});
            }
            return rename(...args);
          };
          outcome = await instance[operation](g.entry.id);
        } finally { fs.rename = rename; }
        assert.equal(outcome.success, true);
        assert.match(outcome.error, /metadados pendentes/);
        assert.equal(instance.list().length, 1, "recovery entry is not lost on final persistence failure");
        const restarted = new QuarantineManager(g.base);
        await restarted.init();
        assert.equal(restarted.list().length, 1);
        assert.equal(await exists(g.quarantined), false);
        if (operation === "restore") assert.equal(await fs.readFile(g.original,"utf8"), g.content);
      });
    }
  } else {
    assert.equal(await fs.readFile(f.original,"utf8"), f.content);
    assert.equal(await exists(f.quarantined), false);
    assert.equal(manager.list().length, 0, "entry already removed despite reported failure");
  }
}));

test("controlo: caminho original relativo recusado sem efeitos", async () => fixture(async f => {
  await fs.writeFile(f.quarantined, f.content);
  const manager = await f.manager([{...f.entry, originalPath:"../fixture.txt"}]);
  const result = await manager.restore(f.entry.id);
  assert.equal(result.success, false);
  assert.match(result.error, /nao e absoluto/);
  assert.equal(await exists(f.quarantined), true);
}));

test("controlo: entrada ausente e ficheiro em falta não anunciam sucesso", async () => fixture(async f => {
  const manager = await f.manager();
  assert.equal((await manager.restore("missing-id")).success, false);
  assert.equal((await manager.delete("missing-id")).success, false);
  const result = await manager.restore(f.entry.id);
  assert.equal(result.success, false);
  assert.match(result.error, /em falta/);
  assert.equal(manager.list().length, 1);
}));

test("controlo: roundtrip fictício mantém bytes e campos de deteção até ao restauro", async () => fixture(async f => {
  await fs.writeFile(f.original, f.content);
  const manager = await f.manager([]);
  const entry = await manager.quarantine({
    artifactPath:f.original, fileName:"fixture.txt", sha256:hash(f.content),
    verdict:"malicious", riskScore:90, rulesTriggered:["SYNTHETIC_FIXTURE_RULE"],
  });
  assert.ok(entry);
  assert.equal(entry.detectionReason, "SYNTHETIC_FIXTURE_RULE");
  assert.equal(await exists(f.original), false);
  const restarted = new QuarantineManager(f.base);
  await restarted.init();
  assert.equal(restarted.list()[0].sha256, hash(f.content));
  assert.equal(restarted.list()[0].originalPath, f.original);
  assert.equal(restarted.list()[0].detectionReason, "SYNTHETIC_FIXTURE_RULE");
  assert.equal((await restarted.restore(entry.id)).success, true);
  assert.equal(await fs.readFile(f.original,"utf8"), f.content);
  assert.deepEqual(JSON.parse(await fs.readFile(f.manifest,"utf8")), []);
  if (secureExpectation) await fixture(async g => {
    await fs.writeFile(g.quarantined, g.content);
    const instance = await g.manager();
    const [restored, deleted] = await Promise.all([instance.restore(g.entry.id), instance.delete(g.entry.id)]);
    assert.equal(restored.success, true);
    assert.equal(deleted.success, false, "serialized commands cannot both consume the same entry");
    assert.equal(await fs.readFile(g.original,"utf8"), g.content);
  });
}));
test("segurança: destino criado durante restauro nunca é substituído", async () => fixture(async f => {
  await fs.writeFile(f.quarantined, f.content);
  const manager = await f.manager();
  const originalMkdir = fs.mkdir;
  let interleaved = false;
  let result;
  try {
    // Deterministic concurrent writer interleaving, only in this temporary fixture.
    // The final rename and replacement are real filesystem operations.
    fs.mkdir = async (...args) => {
      const output = await originalMkdir(...args);
      if (path.resolve(args[0]) === f.destination && !interleaved) {
        interleaved = true;
        await fs.writeFile(f.original, "CONCURRENT_BENIGN_DESTINATION");
      }
      return output;
    };
    result = await manager.restore(f.entry.id);
  } finally { fs.mkdir = originalMkdir; }
  assert.equal(interleaved, true);
  if (secureExpectation) {
    assert.equal(result.success, false, "no-overwrite must be atomic, not access-then-rename");
    assert.equal(await fs.readFile(f.original,"utf8"), "CONCURRENT_BENIGN_DESTINATION");
  } else {
    assert.equal(result.success, true);
    assert.equal(await fs.readFile(f.original,"utf8"), f.content, "concurrent destination was overwritten");
  }
}));

test("segurança: roundtrip recupera permissão de escrita original", async () => fixture(async f => {
  await fs.writeFile(f.original, f.content);
  await fs.chmod(f.original, 0o600);
  const before = (await fs.stat(f.original)).mode & 0o200;
  assert.equal(before, 0o200);
  const manager = await f.manager([]);
  const entry = await manager.quarantine({artifactPath:f.original,fileName:"fixture.txt",sha256:hash(f.content),verdict:"malicious",riskScore:90,rulesTriggered:[]});
  assert.ok(entry);
  assert.equal((await manager.restore(entry.id)).success, true);
  const after = (await fs.stat(f.original)).mode & 0o200;
  if (secureExpectation) assert.equal(after, before, "original write permission must be recoverable");
  else assert.equal(after, 0, "quarantine chmod is retained after restoration");
  if (secureExpectation) {
    await fixture(async g => {
      await fs.writeFile(g.original, g.content);
      await fs.chmod(g.original, 0o400);
      const instance = await g.manager([]);
      const stored = await instance.quarantine({artifactPath:g.original,fileName:"fixture.txt",sha256:hash(g.content),verdict:"malicious",riskScore:90,rulesTriggered:[]});
      assert.ok(stored);
      assert.equal(stored.sha256, hash(g.content), "stored digest measures actual bytes");
      assert.equal((await instance.restore(stored.id)).success, true);
      assert.equal((await fs.stat(g.original)).mode & 0o200, 0, "read-only original stays read-only");
    });
    await fixture(async g => {
      await fs.writeFile(g.quarantined, g.content);
      const instance = await g.manager();
      const open = fs.open;
      const chmod = fs.chmod;
      let refusedOpen = false;
      let outcome;
      try {
        fs.open = async (...args) => {
          if (path.resolve(args[0]) === g.quarantined && !refusedOpen) {
            refusedOpen = true;
            throw Object.assign(new Error("SYNTHETIC_READ_PERMISSION"), {code:"EACCES"});
          }
          return open(...args);
        };
        fs.chmod = async (...args) => {
          if (path.resolve(args[0]) === g.quarantined && args[1] === 0) {
            throw Object.assign(new Error("SYNTHETIC_ISOLATION_RESET_FAILURE"), {code:"EPERM"});
          }
          return chmod(...args);
        };
        outcome = await instance.restore(g.entry.id);
      } finally { fs.open = open; fs.chmod = chmod; }
      assert.equal(outcome.success, false);
      assert.match(outcome.error, /Falha ao repor isolamento/);
      assert.equal(await exists(g.original), false);
      assert.equal(instance.list().length, 1);
      assert.equal(await fs.readFile(g.quarantined,"utf8"), g.content);
    });
  }
}));
// The original ten cases remain the gate. Additional failure paths are exercised
// inside them so both the default and EXPECT_SAFE command retain ten top-level tests.
