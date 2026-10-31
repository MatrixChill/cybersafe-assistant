import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { seedClamavDatabase } from "../dist/clamav-seed.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-seed-denied-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const denied = (result) => {
  assert.equal(result.status, "invalid");
  assert.match(result.reason, /CLAMAV_SEED_NATIVE_BOUNDARY_REQUIRED/);
};
function tree(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    return [name, stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isDirectory() ? tree(file) : fs.readFileSync(file).toString("hex")];
  });
}
function options(name) {
  return { seedDir: path.join(ROOT, `seed-${name}`), definitionsDir: path.join(ROOT, `definitions-${name}`) };
}

test("without a configured seed there is no IO or false publication", async () => {
  const opts = options("absent");
  const result = await seedClamavDatabase({ ...opts, seedDir: "" });
  assert.equal(result.status, "not-provided");
  assert.equal(fs.existsSync(opts.definitionsDir), false);
});

test("configured seed is denied before reading even its manifest or destination", async () => {
  let touched = false;
  const result = await seedClamavDatabase({
    seedDir: path.join(ROOT, "not-present"),
    get definitionsDir() { touched = true; throw new Error("must not inspect the target"); },
    log() { throw new Error("must not emit paths"); },
  });
  denied(result);
  assert.equal(touched, false);
});

test("valid-looking seed cannot create a database until the native boundary exists", async () => {
  const opts = options("clean");
  fs.mkdirSync(opts.seedDir);
  fs.writeFileSync(path.join(opts.seedDir, "SEED-MANIFEST.json"), "{}");
  denied(await seedClamavDatabase(opts));
  assert.equal(fs.existsSync(opts.definitionsDir), false);
});

test("existing, partial, interrupted and freshclam-owned files are byte-for-byte preserved", async () => {
  const opts = options("existing"), dest = path.join(opts.definitionsDir, "clamav");
  fs.mkdirSync(dest, { recursive: true });
  for (const [name, bytes] of Object.entries({ "main.cvd": "USER", "daily.cld": "FRESHCLAM", ".seed.tmp": "INTERRUPTED", "freshclam.dat": "STATE" })) {
    fs.writeFileSync(path.join(dest, name), bytes);
  }
  const before = tree(opts.definitionsDir);
  denied(await seedClamavDatabase(opts));
  denied(await seedClamavDatabase(opts));
  assert.deepEqual(tree(opts.definitionsDir), before);
});

test("unreadable/non-directory destination is never treated as an empty database", async () => {
  const opts = options("not-directory");
  fs.writeFileSync(opts.definitionsDir, "DO NOT TOUCH");
  denied(await seedClamavDatabase(opts));
  assert.equal(fs.readFileSync(opts.definitionsDir, "utf8"), "DO NOT TOUCH");
});

test("junction destination and junction parent do not redirect any seed IO", async () => {
  for (const parent of [false, true]) {
    const opts = options(`junction-${parent}`), outside = path.join(ROOT, `outside-${parent}`);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "main.cvd"), "OUTSIDE");
    if (!parent) fs.mkdirSync(opts.definitionsDir);
    const link = parent ? opts.definitionsDir : path.join(opts.definitionsDir, "clamav");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    const before = tree(outside);
    denied(await seedClamavDatabase(opts));
    assert.deepEqual(tree(outside), before);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
  }
});

async function waitingPublisher(opts) {
  const module = new URL("../dist/clamav-seed.js", import.meta.url).href;
  const source = `import {seedClamavDatabase} from ${JSON.stringify(module)};
    process.send({ready:true}); process.once('message', async () => {
      const result = await seedClamavDatabase(${JSON.stringify(opts)});
      process.send({result}, () => process.disconnect());
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`publisher exit ${code}: ${stderr}`)));
  });
  const ready = new Promise((resolve) => child.once("message", resolve));
  const result = new Promise((resolve) => child.on("message", (message) => { if (message.result) resolve(message.result); }));
  await ready;
  return { child, result, closed };
}

test("two process publishers are denied across a barrier while a simulated updater replaces the base", { timeout: 10000 }, async () => {
  const opts = options("two-processes"), dest = path.join(opts.definitionsDir, "clamav");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "daily.cld"), "BEFORE");
  const publishers = await Promise.all([waitingPublisher(opts), waitingPublisher(opts)]);
  // Deterministic barrier: both publishers are loaded, neither has called seed.
  fs.writeFileSync(path.join(dest, "daily.cld"), "UPDATER-REPLACEMENT");
  fs.writeFileSync(path.join(dest, "main.cvd"), "ARRIVED-BEFORE-COMMIT");
  const before = tree(opts.definitionsDir);
  for (const publisher of publishers) publisher.child.send("continue");
  for (const publisher of publishers) denied(await publisher.result);
  await Promise.all(publishers.map((publisher) => publisher.closed));
  assert.deepEqual(tree(opts.definitionsDir), before);
});
