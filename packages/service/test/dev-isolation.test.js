import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { serviceBaseDir } from "../dist/log-writer.js";
import { PIPE_NAME } from "@cybersafe/core";

const FLAG = "CYBERSAFE_DEV_ISOLATION";
const DIR = "CYBERSAFE_DEV_SERVICE_DIR";
const PIPE = "CYBERSAFE_DEV_PIPE_NAME";

function withEnv(extra, fn) {
  const keys = [FLAG, DIR, PIPE];
  const saved = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  }
}

const IS_DIR = process.platform === "win32" ? "C:\\temp\\cs-isolated-svc" : "/tmp/cs-isolated-svc";
const IS_PIPE = "\\\\.\\pipe\\cybersafe-dev-iso-svc";

test("default intacto: serviceBaseDir e PIPE_NAME identicos ao historico", () => {
  assert.equal(PIPE_NAME, "\\\\.\\pipe\\cybersafe-protection-dev-v2");
  withEnv({}, () => {
    assert.equal(serviceBaseDir(), path.join(os.homedir(), ".cybersafe-service"));
  });
});

test("otim-in valido: serviceBaseDir aponta para a raiz dedicada", () => {
  withEnv({ [FLAG]: "1", [DIR]: IS_DIR, [PIPE]: IS_PIPE }, () => {
    assert.equal(serviceBaseDir(), path.resolve(IS_DIR));
  });
});

test("config parcial/invalida falha FECHADO no serviceBaseDir (antes do mkdir)", () => {
  // falta pipe
  withEnv({ [FLAG]: "1", [DIR]: IS_DIR }, () => {
    assert.throws(() => serviceBaseDir());
  });
  // dir e o pessoal
  withEnv({ [FLAG]: "1", [DIR]: path.join(os.homedir(), ".cybersafe-service"), [PIPE]: IS_PIPE }, () => {
    assert.throws(() => serviceBaseDir());
  });
  // dir e DESCENDENTE do pessoal
  withEnv({ [FLAG]: "1", [DIR]: path.join(os.homedir(), ".cybersafe-service", "sub"), [PIPE]: IS_PIPE }, () => {
    assert.throws(() => serviceBaseDir());
  });
  // pipe igual ao DEFAULT de producao (nao isola) — recusa mesmo com dir valido
  withEnv({ [FLAG]: "1", [DIR]: IS_DIR, [PIPE]: "\\\\.\\pipe\\cybersafe-protection-dev-v2" }, () => {
    assert.throws(() => serviceBaseDir());
  });
  // pipe remoto
  withEnv({ [FLAG]: "1", [DIR]: IS_DIR, [PIPE]: "\\\\\\\\srv\\\\pipe\\\\x" }, () => {
    assert.throws(() => serviceBaseDir());
  });
});
