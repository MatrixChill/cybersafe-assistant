// TP-REUSE-ROOT-TEST-SUPPORT (writer: OpenCode)
// Contrato validarRaizReutilizavel + integração dry-run do runner dev-isolated-run.mjs.
// NÃO arranca pilha: unit-tests com deps explícitas + 2 integrações em modo dry-run
// (sem --start => nada criado, nenhum filho arrancado). Fonte real, sem mocks do validador.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validarRaizReutilizavel, buildPlan, run } from "./dev-isolated-run.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(REPO, "scripts", "dev-isolated-run.mjs");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "reuse-root-test-"));
const MANIFESTO = ".cybersafe-dev-owner.json";

// Deps explícitas do contrato (as MESMAS que o runner devia injectar via realDeps):
// tmpdir, homedir, existsSync, realpathSync, readFileSync, isAlive.
const deps = {
  tmpdir: () => os.tmpdir(),
  homedir: () => os.homedir(),
  existsSync: (p) => fs.existsSync(p),
  realpathSync: (p) => fs.realpathSync(p),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
};

const novaRaiz = () => fs.mkdtempSync(path.join(BASE, "raiz-"));

test.after(() => { fs.rmSync(BASE, { recursive: true, force: true }); });

// ---------------------------------------------------------------- contrato

test("raiz nova dentro de %TEMP% é aceite", () => {
  const dir = novaRaiz();
  const r = validarRaizReutilizavel(dir, deps);
  assert.equal(r.ok, true);
  assert.equal(r.root.toLowerCase(), fs.realpathSync(dir).toLowerCase());
  assert.equal(r.manifesto, path.join(r.root, MANIFESTO));
});

test("mesma raiz é revalidada no 2.º ciclo (reuso entre ciclos)", () => {
  const dir = novaRaiz();
  assert.equal(validarRaizReutilizavel(dir, deps).ok, true);
  assert.equal(validarRaizReutilizavel(dir, deps).ok, true);
});

test("recusa sem candidato ou relativa", () => {
  assert.equal(validarRaizReutilizavel("", deps).motivo, "sem candidato");
  assert.equal(validarRaizReutilizavel("relativa", deps).motivo, "raiz tem de ser absoluta");
});

test("recusa a base temporária em geral", () => {
  const r = validarRaizReutilizavel(os.tmpdir(), deps);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /fora da base temporária|base temporária em geral/);
});

test("recusa caminho fora de %TEMP%", () => {
  const r = validarRaizReutilizavel(REPO, deps);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /fora da base temporária/);
});

test("recusa raiz inexistente", () => {
  const r = validarRaizReutilizavel(path.join(BASE, "nao-existe-" + Date.now()), deps);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "não existe");
});

test("recusa ancestral com junction (realpath difere do lexical)", () => {
  const alvo = path.join(BASE, "alvo-real");
  fs.mkdirSync(path.join(alvo, "sub"), { recursive: true });
  const link = path.join(BASE, "passa-por-junction");
  fs.symlinkSync(alvo, link, "junction");

  const r1 = validarRaizReutilizavel(link, deps);
  assert.equal(r1.ok, false);
  assert.match(r1.motivo, /reparse/);

  const r2 = validarRaizReutilizavel(path.join(link, "sub"), deps);
  assert.equal(r2.ok, false);
  assert.match(r2.motivo, /reparse/);
});

test("recusa raiz alheia com PID vivo no manifesto", () => {
  const dir = novaRaiz();
  fs.writeFileSync(path.join(dir, MANIFESTO), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const r = validarRaizReutilizavel(dir, deps);
  assert.equal(r.ok, false);
  assert.match(r.motivo, /outro run vivo/);
  assert.match(r.motivo, new RegExp(String(process.pid)));
});

test("PID morto no manifesto é re-adoptado (ciclo 2 legítimo)", () => {
  const morto = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.equal(morto.status, 0);
  const dir = novaRaiz();
  fs.writeFileSync(path.join(dir, MANIFESTO), JSON.stringify({ pid: morto.pid, startedAt: new Date().toISOString() }));
  const r = validarRaizReutilizavel(dir, deps);
  assert.equal(r.ok, true);
});

test("manifesto ilegível é ignorado (re-adoptado)", () => {
  const dir = novaRaiz();
  fs.writeFileSync(path.join(dir, MANIFESTO), "{ isto não é json");
  assert.equal(validarRaizReutilizavel(dir, deps).ok, true);
});

// ------------------------------------------------- integração dry-run real

function correrDryRun(runRoot) {
  return spawnSync(process.execPath, [RUNNER], {
    cwd: REPO,
    env: { ...process.env, CYBERSAFE_DEV_RUN_ROOT: runRoot },
    encoding: "utf8",
    timeout: 120_000,
  });
}

test("dry-run com raiz válida via CYBERSAFE_DEV_RUN_ROOT não bloqueia nem rebenta", () => {
  const dir = novaRaiz();
  const proc = correrDryRun(dir);
  const out = `${proc.stdout}\n${proc.stderr}`;
  assert.doesNotMatch(out, /TypeError/);
  assert.doesNotMatch(out, /run-root-invalida/);
  assert.match(proc.stdout, new RegExp(`raiz de teste: ${fs.realpathSync(dir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  assert.equal(proc.status, 0);
});

test("dry-run com raiz inválida reporta run-root-invalida sem crash", () => {
  const proc = correrDryRun(REPO); // fora de %TEMP% => recusada pelo validador
  const out = `${proc.stdout}\n${proc.stderr}`;
  assert.doesNotMatch(out, /TypeError/);
  assert.match(out, /run-root-invalida/);
  assert.ok(proc.status === 0 || proc.status === 2, `exit inesperado: ${proc.status}`);
});

// --------------------------- P0 (achado Codex): dry-run não muta; START bloqueado devolve a causa

// Deps isoladas com contadores: tudo o que escreve/spawna é contado; spawn/spawnSync
// LANÇAM se o fluxo lá chegar — nenhuma asserção depende de "não aconteceu por sorte".
function depsIsoladas() {
  const calls = { write: [], mkdir: [], spawn: [], spawnSync: [] };
  const deps = {
    tmpdir: () => os.tmpdir(),
    homedir: () => os.homedir(),
    pid: process.pid,
    execPath: process.execPath,
    mkdtempSync: (p) => fs.mkdtempSync(p),
    existsSync: (p) => fs.existsSync(p),
    realpathSync: (p) => fs.realpathSync(p),
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
    writeFileSync: (p, c, enc) => { calls.write.push(p); fs.writeFileSync(p, c, enc); },
    mkdirSync: (p, o) => { calls.mkdir.push(p); fs.mkdirSync(p, o); },
    rmSync: (p, o) => fs.rmSync(p, o),
    isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    requireElectron: () => { throw new Error("sem electron (teste isolado)"); },
    log: () => {},
    sleep: () => Promise.resolve(),
    probeTcp: async () => false,
    spawn: () => { calls.spawn.push(1); throw new Error("spawn inesperado em teste"); },
    spawnSync: () => { calls.spawnSync.push(1); return { status: 0, stdout: "" }; },
    killTree: async () => ({ ok: true }),
    installSignalHandlers: () => ({ promise: new Promise(() => {}), dispose: () => {} }),
    readinessAttempts: 1, readinessDelayMs: 1, exitTimeoutMs: 1, killTimeoutMs: 1,
  };
  return { deps, calls };
}

const envRaiz = (dir) => ({ CYBERSAFE_DEV_RUN_ROOT: dir });

test("buildPlan dry-run com raiz válida: zero escritas e manifesto NÃO criado", () => {
  const dir = novaRaiz();
  const { deps, calls } = depsIsoladas();
  const plan = buildPlan({ env: envRaiz(dir), dryRun: true, deps });
  assert.equal(plan.blocked, undefined);
  assert.equal(calls.write.length, 0);
  assert.equal(fs.existsSync(path.join(dir, MANIFESTO)), false);
});

test("buildPlan dry-run com manifesto de PID morto: bytes intactos, zero escritas", () => {
  const morto = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const dir = novaRaiz();
  const mPath = path.join(dir, MANIFESTO);
  const original = JSON.stringify({ pid: morto.pid, startedAt: "2026-10-19T00:00:00.000Z" });
  fs.writeFileSync(mPath, original);
  const { deps, calls } = depsIsoladas();
  const plan = buildPlan({ env: envRaiz(dir), dryRun: true, deps });
  assert.equal(plan.blocked, undefined);
  assert.equal(calls.write.length, 0);
  assert.equal(fs.readFileSync(mPath, "utf8"), original);
});

test("run dry-run com raiz válida: devolve plano e não escreve nada", async () => {
  const dir = novaRaiz();
  const { deps, calls } = depsIsoladas();
  const r = await run({ argv: [], env: envRaiz(dir), deps });
  assert.equal(r.action, "dry-run");
  assert.equal(r.plan.blocked, undefined);
  assert.equal(r.plan.root.toLowerCase(), fs.realpathSync(dir).toLowerCase());
  assert.equal(calls.write.length, 0);
  assert.equal(fs.existsSync(path.join(dir, MANIFESTO)), false);
});

test("run dry-run com manifesto de PID vivo: bloqueia com o motivo e não toca nos bytes", async () => {
  const dir = novaRaiz();
  const mPath = path.join(dir, MANIFESTO);
  const original = JSON.stringify({ pid: process.pid, startedAt: "2026-10-19T00:00:00.000Z" });
  fs.writeFileSync(mPath, original);
  const { deps, calls } = depsIsoladas();
  const r = await run({ argv: [], env: envRaiz(dir), deps });
  assert.match(r.plan.blocked, /^run-root-invalida:raiz pertence a outro run vivo \(pid \d+\)$/);
  assert.equal(calls.write.length, 0);
  assert.equal(fs.readFileSync(mPath, "utf8"), original);
});

test("buildPlan START com raiz inválida: plano parcial bloqueado, zero escritas", () => {
  const { deps, calls } = depsIsoladas();
  const plan = buildPlan({ env: envRaiz(REPO), dryRun: false, deps });
  assert.match(plan.blocked, /^run-root-invalida:fora da base temporária$/);
  assert.equal(plan.root, null);
  assert.deepEqual(plan.addedKeys, []);
  assert.equal(calls.write.length, 0);
  assert.equal(calls.mkdir.length, 0);
});

test("run START com raiz inválida: blocked run-root-invalida (não port-invalid), zero spawn/escrita", async () => {
  const { deps, calls } = depsIsoladas();
  const r = await run({ argv: ["--start"], env: envRaiz(REPO), deps });
  assert.match(r.blocked, /^run-root-invalida:fora da base temporária$/);
  assert.doesNotMatch(String(r.blocked), /port-invalid/);
  assert.equal(r.spawned.length, 0);
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.spawnSync.length, 0);
  assert.equal(calls.write.length, 0);
  assert.equal(calls.mkdir.length, 0);
});

test("controlo positivo: buildPlan START com raiz válida escreve o manifesto 1× com pid real", () => {
  const dir = novaRaiz();
  const { deps, calls } = depsIsoladas();
  const plan = buildPlan({ env: envRaiz(dir), dryRun: false, deps });
  assert.equal(plan.blocked, undefined);
  assert.equal(calls.write.length, 1);
  assert.equal(calls.write[0], path.join(fs.realpathSync(dir), MANIFESTO));
  const dono = JSON.parse(fs.readFileSync(path.join(dir, MANIFESTO), "utf8"));
  assert.equal(dono.pid, process.pid);
  assert.ok(typeof dono.desde === "string" && dono.desde.length > 0);
});
