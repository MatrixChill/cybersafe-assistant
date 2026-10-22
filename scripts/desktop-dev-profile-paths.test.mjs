// Regressão de isolamento de caminhos do desktop (Qoder, 2026-10-19).
// Motivo real: duas corridas "isoladas" partilharam %TEMP%\cybersafe-dev\userData
// porque o runner passava CYBERSAFE_DEV_USER_DATA_DIR que nada lia, e o main fazia
// app.setPath("userData", perfil.userDataDir) por cima do --user-data-dir. O token
// gravado pela corrida das 19:22 apareceu lido às 20:45 como "sessão restaurada".
// Correr: node --import tsx scripts/desktop-dev-profile-paths.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { resolveDevProfile, afirmarCaminhoIsolado, DEV_API_PORT_FLOOR } from "../packages/desktop/src/dev-isolation.ts";
import { buildPlan } from "./dev-isolated-run.mjs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.sep + "tmp-unittest" + path.sep + "cybersafe-run-ABC");
const base = (extra = {}) => ({
  isPackaged: false,
  env: { CYBERSAFE_DEV_ROOT: RAIZ, ...extra },
  portasOcupadas: new Set(),
});

test("dev sem overrides deriva userData/session da raiz declarada", () => {
  const p = resolveDevProfile(base());
  assert.equal(p.userDataDir, path.join(RAIZ, "userData"));
  assert.equal(p.sessionDir, path.join(RAIZ, "session"));
  assert.equal(p.raizDev, RAIZ);
});

test("override DENTRO da raiz é usado verbatim", () => {
  const alvo = path.join(RAIZ, "electron-user-data");
  const p = resolveDevProfile(base({ CYBERSAFE_DEV_USER_DATA_DIR: alvo }));
  assert.equal(p.userDataDir, alvo);
});

test("override FORA da raiz é recusa, nunca fallback silencioso", () => {
  assert.throws(
    () => resolveDevProfile(base({ CYBERSAFE_DEV_USER_DATA_DIR: path.resolve("C:\\outra\\coisa\\userData") })),
    /FORA de CYBERSAFE_DEV_ROOT/,
  );
});

test("override que aponta para o perfil real do utilizador é recusado", () => {
  const real = path.resolve(process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Roaming"), "CyberSafe Assistant", "userData");
  assert.throws(
    () => resolveDevProfile({ isPackaged: false, env: { CYBERSAFE_DEV_ROOT: path.resolve("C:\\tmp-unidade\\raiz"), CYBERSAFE_DEV_USER_DATA_DIR: real }, portasOcupadas: new Set() }),
    /perfil real do utilizador/,
  );
});

test("empacotado ignora o ambiente de dev por completo", () => {
  const p = resolveDevProfile({ isPackaged: true, env: { CYBERSAFE_DEV_ROOT: RAIZ, CYBERSAFE_DEV_USER_DATA_DIR: path.join(RAIZ, "x"), CYBERSAFE_DEV_PORT: "5999" }, portasOcupadas: new Set() });
  assert.equal(p.userDataDir, undefined);
  assert.equal(p.raizDev, undefined);
  assert.equal(p.apiPort, 4000);
});

test("o que o runner produz é aceite pelo perfil do desktop (coerência fim-a-fim)", () => {
  const deps = {
    mkdtempSync: () => { throw new Error("dry-run não deve criar nada"); },
    existsSync: () => true,
    readdirSync: () => [],
    statSync: () => ({ isDirectory: () => true }),
    spawn: () => { throw new Error("dry-run não spawn"); },
    execFileSync: () => "",
    execPath: process.execPath,
    platform: "win32",
    tmpdir: () => path.resolve("C:\\tmp-unidade"),
  };
  const plan = buildPlan({ env: { CYBERSAFE_DEV_ROOT: RAIZ, CYBERSAFE_API_PORT: String(DEV_API_PORT_FLOOR) }, dryRun: true, deps });
  assert.ok(plan.isolationEnv, "dry-run produziu plano sem isolationEnv");
  assert.equal(plan.isolationEnv.CYBERSAFE_DEV_ROOT, plan.root, "runner tem de passar a SUA raiz ao desktop");
  assert.ok(plan.isolationEnv.CYBERSAFE_DEV_USER_DATA_DIR.startsWith(plan.root + path.sep));
  // A peça que faltava em 19/10: alimentar o perfil do desktop com o env do runner.
  const p = resolveDevProfile({ isPackaged: false, env: plan.isolationEnv, portasOcupadas: new Set() });
  assert.equal(p.userDataDir, path.resolve(plan.isolationEnv.CYBERSAFE_DEV_USER_DATA_DIR));
});

test("afirmarCaminhoIsolado: aceita apenas caminho efectivo igual ao esperado E dentro da raiz", () => {
  const dentro = path.join(RAIZ, "electron-user-data");
  assert.equal(afirmarCaminhoIsolado("userData", dentro, dentro, RAIZ), path.resolve(dentro));
  assert.throws(() => afirmarCaminhoIsolado("userData", path.join(RAIZ, "outro"), dentro, RAIZ), /efectivo é/);
  assert.throws(() => afirmarCaminhoIsolado("sessionData", "C:\\Windows\\Temp\\sessao", "C:\\Windows\\Temp\\sessao", RAIZ), /não está dentro da raiz/);
  assert.throws(() => afirmarCaminhoIsolado("userData", dentro, dentro, undefined), /sem raiz de teste/);
});

test("main.ts aplica e confirma os DOIS caminhos, antes do lock (âncora de fonte)", () => {
  const fonte = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "desktop", "src", "main.ts"), "utf8");
  for (const obrigatorio of [
    'app.setPath("userData"',
    'app.setPath("sessionData"',
    'afirmarCaminhoIsolado("userData", app.getPath("userData")',
    'afirmarCaminhoIsolado("sessionData", app.getPath("sessionData")',
  ]) {
    assert.ok(fonte.includes(obrigatorio), `main.ts perdeu a asserção de isolamento: ${obrigatorio}`);
  }
  const inicioBloco = fonte.indexOf("const dirDadosDev");
  const lock = fonte.indexOf("app.requestSingleInstanceLock()");
  assert.ok(inicioBloco > 0 && lock > inicioBloco, "a asserção de caminhos tem de correr ANTES do lock de instância única");
  // Empacotado não pode ser apanhado por este caminho: sem asserção, sem desvio.
  assert.ok(fonte.includes("if (!app.isPackaged)"), "bloco de isolamento tem de continuar condicionado a !isPackaged");
});

test("regressão do mecanismo exacto: o env de 19/10 é agora recusado, não silencioso", () => {
  // Reconstrói o env de 19/10: override presente mas CYBERSAFE_DEV_ROOT ausente
  // => o desktop derivava para %TEMP%\cybersafe-dev\userData, partilhado entre corridas.
  const envAntigo = { CYBERSAFE_DEV_USER_DATA_DIR: path.join(RAIZ, "electron-user-data"), CYBERSAFE_API_PORT: "4100" };
  assert.throws(
    () => resolveDevProfile({ isPackaged: false, env: envAntigo, portasOcupadas: new Set() }),
    /FORA de CYBERSAFE_DEV_ROOT/,
    "o caso que contaminou o teste de sessão tinha de passar a ser recusa explícita",
  );
  assert.throws(() => resolveDevProfile({ isPackaged: false, env: { ...envAntigo, CYBERSAFE_DEV_ROOT: path.join(RAIZ, "raiz-diferente") }, portasOcupadas: new Set() }), /FORA de CYBERSAFE_DEV_ROOT/);
});
