import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import {
  WINDOWS_SERVICE_ID,
  WINDOWS_SERVICE_NAME,
  classifyRegQuery,
  decideInstall,
  decideUninstall,
  legacyMutationPolicy,
  parseWindowsCommandLine,
  serviceIdForName,
  wrapperConfigFor,
  wrapperExecutableFor,
} from "../dist/windows-service-guard.js";

const script = path.resolve(os.tmpdir(), "CyberSafe Assistant", "dist", "index.js");
const wrapper = wrapperExecutableFor(script);

test("R7: id do SCM é derivado do nome como no node-windows", () => {
  assert.equal(WINDOWS_SERVICE_NAME, "CyberSafe Engine");
  assert.equal(serviceIdForName("CyberSafe Engine"), "cybersafeengine");
  assert.equal(WINDOWS_SERVICE_ID, "cybersafeengine");
});

test("R7: wrapper e XML vivem em <scriptDir>/daemon/<id>", () => {
  assert.equal(wrapper, path.join(path.dirname(script), "daemon", "cybersafeengine.exe"));
  assert.equal(wrapperConfigFor(script), path.join(path.dirname(script), "daemon", "cybersafeengine.xml"));
});

test("R7: command line com quotes e argumentos é interpretada", () => {
  const parsed = parseWindowsCommandLine(`"C:\\Program Files\\CyberSafe\\daemon\\cybersafeengine.exe" --start --log "a b"`);
  assert.equal(parsed.executable, "C:\\Program Files\\CyberSafe\\daemon\\cybersafeengine.exe");
  assert.deepEqual(parsed.args, ["--start", "--log", "a b"]);
});

test("R7: command line sem quotes e com %SystemRoot% é expandida", () => {
  const parsed = parseWindowsCommandLine("%SystemRoot%\\System32\\cmd.exe /c echo", { SystemRoot: "C:\\Windows" });
  assert.equal(parsed.executable, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(parsed.args, ["/c", "echo"]);
});

test("R7: reg query com sucesso devolve present + command line", () => {
  const query = classifyRegQuery({
    exitCode: 0,
    stdout: "\r\nHKEY_LOCAL_MACHINE\\...\r\n    ImagePath    REG_EXPAND_SZ    \"C:\\x\\daemon\\cybersafeengine.exe\"\r\n",
    stderr: "",
  });
  assert.equal(query.state, "present");
  assert.match(query.commandLine, /cybersafeengine\.exe/);
});

test("R7: chave inexistente é absent; acesso negado é error (não ausência)", () => {
  const absent = classifyRegQuery({ exitCode: 1, stdout: "", stderr: "ERRO: O sistema não conseguiu localizar a chave ou o valor de registo especificados." });
  assert.equal(absent.state, "absent");
  const denied = classifyRegQuery({ exitCode: 1, stdout: "", stderr: "ERRO: Acesso negado." });
  assert.equal(denied.state, "error");
  assert.match(denied.detail, /Acesso negado/);
});

test("R7: erro de query bloqueia instalação e desinstalação", () => {
  const query = { state: "error", detail: "Acesso negado." };
  assert.equal(decideInstall({ platform: "win32", scriptPath: script, query }).ok, false);
  assert.equal(decideUninstall({ platform: "win32", scriptPath: script, query }).ok, false);
});

test("R7: ausência permite instalar; .ts é recusado", () => {
  const absent = { state: "absent" };
  assert.equal(decideInstall({ platform: "win32", scriptPath: script, query: absent }).ok, true);
  const ts = decideInstall({ platform: "win32", scriptPath: path.join(path.dirname(script), "index.ts"), query: absent });
  assert.equal(ts.ok, false);
  assert.match(ts.reason, /TypeScript/);
});

test("R7: wrapper exacto permite reinstalar; wrapper alheio é conflito", () => {
  const own = decideInstall({
    platform: "win32",
    scriptPath: script,
    query: { state: "present", commandLine: `"${wrapper}" --start` },
  });
  assert.equal(own.ok, true);
  const foreign = decideInstall({
    platform: "win32",
    scriptPath: script,
    query: { state: "present", commandLine: `"C:\\Users\\caioc\\Downloads\\cybersafe-assistant\\packages\\service\\src\\daemon\\cybersafeengine.exe"` },
  });
  assert.equal(foreign.ok, false);
  assert.match(foreign.reason, /outro wrapper/);
});

test("R7: desinstalar exige o wrapper exacto", () => {
  const own = decideUninstall({ platform: "win32", scriptPath: script, query: { state: "present", commandLine: `"${wrapper}"` } });
  assert.equal(own.ok, true);
  const foreign = decideUninstall({ platform: "win32", scriptPath: script, query: { state: "present", commandLine: `"C:\\outro\\cybersafeengine.exe"` } });
  assert.equal(foreign.ok, false);
  assert.match(foreign.reason, /não pertence/);
});

test("R7: ausente é no-op na desinstalação", () => {
  const result = decideUninstall({ platform: "win32", scriptPath: script, query: { state: "absent" } });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyAbsent, true);
});

test("R7: mutações legacy estão desactivadas explicitamente", () => {
  const policy = legacyMutationPolicy();
  assert.equal(policy.allowed, false);
  assert.match(policy.reason, /desactivado/);
});
