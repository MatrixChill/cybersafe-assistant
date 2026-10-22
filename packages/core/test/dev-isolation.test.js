import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  resolvePipeName,
  resolveServiceBaseDir,
  devIsolationRequested,
  looksLikePackagedRuntime,
  stripDevIsolationEnv,
  pathIsSameOrUnder,
  DEFAULT_PIPE_NAME,
  DEFAULT_SERVICE_DIRNAME,
  DEV_ISOLATION_FLAG_ENV,
  DEV_SERVICE_DIR_ENV,
  DEV_PIPE_NAME_ENV,
  DevIsolationError,
} from "../dist/dev-isolation.js";

const HOME = process.platform === "win32" ? "C:\\Users\\tester" : "/home/tester";
const GOOD_DIR = process.platform === "win32" ? "C:\\temp\\cs-isolated" : "/tmp/cs-isolated";
const GOOD_PIPE = "\\\\.\\pipe\\cybersafe-dev-iso-1";
const PERSONAL = path.join(HOME, DEFAULT_SERVICE_DIRNAME);
const ENV_OK = { [DEV_ISOLATION_FLAG_ENV]: "1", [DEV_SERVICE_DIR_ENV]: GOOD_DIR, [DEV_PIPE_NAME_ENV]: GOOD_PIPE };

// execPath/plano sem Electron: isElectron=false, defaultApp=false.
const base = { home: HOME, argv: [], execPath: "C:\\Program Files\\nodejs\\node.exe", isElectron: false, defaultApp: false };

test("default sem otim-in: pipe e dir byte-identicos ao historico", () => {
  assert.equal(resolvePipeName(base), "\\\\.\\pipe\\cybersafe-protection-dev-v2");
  assert.equal(resolvePipeName(base), DEFAULT_PIPE_NAME);
  assert.equal(resolveServiceBaseDir(base), path.join(HOME, ".cybersafe-service"));
});

test("otim-in so liga com o valor exato '1'", () => {
  for (const v of ["0", "true", "", "yes", " 1 "]) {
    const probe = { ...base, env: { ...ENV_OK, [DEV_ISOLATION_FLAG_ENV]: v } };
    assert.equal(devIsolationRequested(probe.env), false, `flag=${JSON.stringify(v)}`);
    assert.equal(resolvePipeName(probe), DEFAULT_PIPE_NAME);
    assert.equal(resolveServiceBaseDir(probe), path.join(HOME, DEFAULT_SERVICE_DIRNAME));
  }
});

test("env de dir/pipe SEM a flag sao ignorados (default preservado)", () => {
  const probe = { ...base, env: { [DEV_SERVICE_DIR_ENV]: GOOD_DIR, [DEV_PIPE_NAME_ENV]: GOOD_PIPE } };
  assert.equal(resolvePipeName(probe), DEFAULT_PIPE_NAME);
  assert.equal(resolveServiceBaseDir(probe), path.join(HOME, DEFAULT_SERVICE_DIRNAME));
});

test("otim-in valido: ambos os processos resolvem a MESMA config", () => {
  const probe = { ...base, env: ENV_OK };
  assert.equal(resolvePipeName(probe), GOOD_PIPE);
  assert.equal(resolveServiceBaseDir(probe), path.resolve(GOOD_DIR));
});

test("REGRESSAO: pipe igual ao DEFAULT de producao e recusado com flag on (nao 'isola' p/ o partilhado)", () => {
  const env = { ...ENV_OK, [DEV_PIPE_NAME_ENV]: DEFAULT_PIPE_NAME };
  assert.throws(() => resolvePipeName({ ...base, env }), DevIsolationError);
  assert.throws(() => resolvePipeName({ ...base, env: { ...env, [DEV_PIPE_NAME_ENV]: DEFAULT_PIPE_NAME.toUpperCase() } }), DevIsolationError);
  assert.throws(() => resolveServiceBaseDir({ ...base, env }), DevIsolationError);
});

test("config parcial falha FECHADO (flag on, falta dir OU pipe)", () => {
  assert.throws(() => resolvePipeName({ ...base, env: { [DEV_ISOLATION_FLAG_ENV]: "1", [DEV_PIPE_NAME_ENV]: GOOD_PIPE } }), DevIsolationError);
  assert.throws(() => resolveServiceBaseDir({ ...base, env: { [DEV_ISOLATION_FLAG_ENV]: "1", [DEV_PIPE_NAME_ENV]: GOOD_PIPE } }), DevIsolationError);
  assert.throws(() => resolveServiceBaseDir({ ...base, env: { [DEV_ISOLATION_FLAG_ENV]: "1", [DEV_SERVICE_DIR_ENV]: GOOD_DIR } }), DevIsolationError);
  assert.throws(() => resolvePipeName({ ...base, env: { [DEV_ISOLATION_FLAG_ENV]: "1", [DEV_SERVICE_DIR_ENV]: GOOD_DIR } }), DevIsolationError);
});

test("dir invalido falha fechado: relativo, pessoal, DESCENDENTE do pessoal, home, raiz, UNC, device", () => {
  const desc = path.join(PERSONAL, "sub"); // descendente do pessoal — ANTES aceite, agora recusado
  const badDirs = [
    "relative/dir",
    PERSONAL,
    desc,
    HOME,
    process.platform === "win32" ? "C:\\" : "/",
    "\\\\\\\\server\\\\share\\\\iso", // UNC
    "\\\\?\\C:\\cs\\iso", // device namespace
  ];
  for (const dir of badDirs) {
    const env = { ...ENV_OK, [DEV_SERVICE_DIR_ENV]: dir };
    assert.throws(() => resolveServiceBaseDir({ ...base, env }), DevIsolationError, `dir=${dir}`);
    assert.throws(() => resolvePipeName({ ...base, env }), DevIsolationError, `pipe-with-baddir=${dir}`);
  }
});

test("pipe invalido falha fechado: remoto, traversal, sem leaf, ponto, controlo", () => {
  const badPipes = [
    "\\\\\\\\srv\\\\pipe\\\\x",
    "\\\\.\\pipe\\a\\b",
    "\\\\.\\pipe\\",
    "\\\\.\\pipe\\.",
    "pipe\\sem-prefixo",
    "\\\\.\\pipe\\bad\x01name",
  ];
  for (const pipe of badPipes) {
    const env = { ...ENV_OK, [DEV_PIPE_NAME_ENV]: pipe };
    assert.throws(() => resolvePipeName({ ...base, env }), DevIsolationError, `pipe=${JSON.stringify(pipe)}`);
    assert.throws(() => resolveServiceBaseDir({ ...base, env }), DevIsolationError, `dir-with-badpipe=${JSON.stringify(pipe)}`);
  }
});

test("pathIsSameOrUnder: pessoal e descendentes caem dentro", () => {
  assert.equal(pathIsSameOrUnder(PERSONAL, PERSONAL), true);
  assert.equal(pathIsSameOrUnder(path.join(PERSONAL, "a", "b"), PERSONAL), true);
  assert.equal(pathIsSameOrUnder(GOOD_DIR, PERSONAL), false);
});

test("packaged: heuristica via resources/app OU Electron sem defaultApp", () => {
  const winResApp = "C:\\Program Files\\CyberSafe\\resources\\app\\CyberSafe.exe";
  assert.equal(looksLikePackagedRuntime({ argv: [], execPath: winResApp, isElectron: false, defaultApp: false }), true);
  // Main empacotado: execPath NO resources/app, mas Electron sem defaultApp => packaged.
  const installedExe = "C:\\Users\\x\\AppData\\Local\\Programs\\CyberSafe\\CyberSafe.exe";
  assert.equal(looksLikePackagedRuntime({ argv: [], execPath: installedExe, isElectron: true, defaultApp: false }), true);
  // Dev Electron via `electron .` => defaultApp true => NAO packaged (honora env).
  assert.equal(looksLikePackagedRuntime({ argv: [], execPath: "C:\\...\\electron.exe", isElectron: true, defaultApp: true }), false);
  // resolve com packaged => ignora env valido e volta ao default.
  const probe = { ...base, env: ENV_OK, execPath: installedExe, isElectron: true, defaultApp: false };
  assert.equal(resolvePipeName(probe), DEFAULT_PIPE_NAME);
  assert.equal(resolveServiceBaseDir(probe), path.join(HOME, DEFAULT_SERVICE_DIRNAME));
});

test("stripDevIsolationEnv remove as 3 vars (filho empacotado); dev preserva (nao chamado)", () => {
  const child = { ...ENV_OK, OTHER: "x" };
  stripDevIsolationEnv(child);
  assert.equal(child[DEV_ISOLATION_FLAG_ENV], undefined);
  assert.equal(child[DEV_SERVICE_DIR_ENV], undefined);
  assert.equal(child[DEV_PIPE_NAME_ENV], undefined);
  assert.equal(child.OTHER, "x", "nao deve apagar outras env");
});
