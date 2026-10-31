import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  INSTALLATION_SECRET_FILENAME,
  startLocalApi,
  stopLocalApi,
} from "../src/api-lifecycle.ts";

/**
 * TP-P0-015-API-DIAG — contrato do callback de diagnóstico.
 *
 * O callback é opcional, best-effort e nunca pode alterar o ciclo de vida:
 * - um callback que lança não muda o resultado nem impede o arranque;
 * - nenhum segredo, env, caminho de segredo, mensagem raw ou chunk raw entra
 *   nos detalhes;
 * - stderr é classificado apenas por padrões estáveis e mede bytes;
 * - error/exit são reportados sem a mensagem do erro.
 */

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cybersafe-api-diag-${label}-`));
  roots.push(root);
  return root;
}

function pathsFor(root) {
  const appPath = path.join(root, "app.asar");
  return {
    appPath,
    entry: path.join(appPath, "node_modules", "api", "dist", "index.js"),
    userDataDir: path.join(root, "userData"),
  };
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.killed = false;
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    return true;
  };
  return child;
}

function capture() {
  const events = [];
  return {
    events,
    diagnostic: (event, details) => events.push({ event, details }),
  };
}

describe("diagnóstico do arranque da API", () => {
  it("entry ausente: emite attempt/entry/unavailable e não spawna", async () => {
    const root = tempRoot("missing");
    const { appPath, userDataDir } = pathsFor(root);
    const { events, diagnostic } = capture();
    let spawns = 0;

    const result = await startLocalApi({
      appPath,
      userDataDir,
      electronPath: "electron.exe",
      existsSync: () => false,
      spawnImpl: () => {
        spawns += 1;
        throw new Error("não podia spawnar");
      },
      diagnostic,
      log: () => {},
    });

    assert.equal(result.status, "skipped");
    assert.equal(spawns, 0);
    assert.deepEqual(events.map((item) => item.event), [
      "api-attempt",
      "api-entry",
      "api-unavailable",
    ]);
    assert.deepEqual(events[1].details, { found: false });
    assert.deepEqual(events[2].details, { reason: "entry-missing" });
  });

  it("um callback que lança nunca altera o resultado do arranque", async () => {
    const root = tempRoot("throwing");
    const { appPath, entry, userDataDir } = pathsFor(root);
    const child = fakeChild(4101);
    let calls = 0;

    const result = await startLocalApi({
      appPath,
      userDataDir,
      electronPath: "electron.exe",
      existsSync: (candidate) => candidate === entry,
      spawnImpl: () => child,
      waitForHealth: async () => true,
      diagnostic: () => {
        calls += 1;
        throw new Error("falha do logger");
      },
      log: () => {},
    });

    assert.equal(result.status, "started");
    assert.ok(calls >= 5, `esperava pelo menos 5 eventos, veio ${calls}`);
    stopLocalApi(result.runtime.child, { escalateMs: 0 });
  });

  it("segredo inválido: available=false, sem valor nem caminho, e não spawna", async () => {
    const root = tempRoot("bad-secret");
    const { appPath, entry, userDataDir } = pathsFor(root);
    const secrets = path.join(userDataDir, "secrets");
    fs.mkdirSync(secrets, { recursive: true });
    fs.writeFileSync(path.join(secrets, INSTALLATION_SECRET_FILENAME), "curto\n");
    const { events, diagnostic } = capture();
    let spawns = 0;

    const result = await startLocalApi({
      appPath,
      userDataDir,
      electronPath: "electron.exe",
      existsSync: (candidate) => candidate === entry,
      spawnImpl: () => {
        spawns += 1;
        throw new Error("não podia spawnar");
      },
      diagnostic,
      log: () => {},
    });

    assert.equal(result.status, "failed");
    assert.match(result.reason, /segredo/);
    assert.equal(spawns, 0);
    assert.deepEqual(events.map((item) => item.event), [
      "api-attempt",
      "api-entry",
      "api-secret",
      "api-unavailable",
    ]);
    assert.deepEqual(events[1].details, { found: true });
    assert.deepEqual(events[2].details, { available: false });
    assert.deepEqual(events[3].details, { reason: "secret-unavailable" });

    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("curto"), false, "o valor do segredo não pode entrar no diagnóstico");
    assert.equal(serialized.includes(userDataDir), false, "o caminho do segredo não pode entrar no diagnóstico");
  });

  it("sucesso: attempt/entry/secret/spawn/ready, com pid e porta, sem segredo", async () => {
    const root = tempRoot("ok");
    const { appPath, entry, userDataDir } = pathsFor(root);
    const child = fakeChild(4321);
    const { events, diagnostic } = capture();

    const result = await startLocalApi({
      appPath,
      userDataDir,
      electronPath: "electron.exe",
      port: 4567,
      existsSync: (candidate) => candidate === entry,
      spawnImpl: () => child,
      waitForHealth: async (port) => port === 4567,
      diagnostic,
      log: () => {},
    });

    assert.equal(result.status, "started");
    assert.deepEqual(events.map((item) => item.event), [
      "api-attempt",
      "api-entry",
      "api-secret",
      "api-child-spawn",
      "api-ready",
    ]);
    assert.deepEqual(events[0].details, { port: 4567 });
    assert.deepEqual(events[1].details, { found: true });
    assert.deepEqual(events[2].details, { available: true });
    assert.deepEqual(events[3].details, { pid: 4321 });
    assert.deepEqual(events[4].details, { port: 4567 });

    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes(result.runtime.secretPath), false);
    assert.equal(serialized.includes("JWT_SECRET"), false);
    stopLocalApi(result.runtime.child, { escalateMs: 0 });
  });

  it("stderr é classificado e medido; error/exit não expõem mensagem raw", async () => {
    const root = tempRoot("classify");
    const { appPath, entry, userDataDir } = pathsFor(root);
    const child = fakeChild(4322);
    const { events, diagnostic } = capture();
    const rawError = Object.assign(new Error("raw message C:\\secret\\token"), { code: "ENOENT" });
    const chunks = [
      "NODE_MODULE_VERSION 127",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module",
      "SQLITE_CANTOPEN: unable to open database",
      "listen EADDRINUSE: address already in use",
      "EACCES: permission denied",
      "plain raw stderr text",
    ];

    const result = await startLocalApi({
      appPath,
      userDataDir,
      electronPath: "electron.exe",
      existsSync: (candidate) => candidate === entry,
      spawnImpl: () => child,
      waitForHealth: async () => {
        child.emit("error", rawError);
        for (const chunk of chunks) child.stderr.emit("data", Buffer.from(chunk));
        child.emit("exit", 1, null);
        return false;
      },
      diagnostic,
      log: () => {},
    });

    assert.equal(result.status, "failed");
    assert.deepEqual(events.map((item) => item.event), [
      "api-attempt",
      "api-entry",
      "api-secret",
      "api-child-spawn",
      "api-child-error",
      ...chunks.map(() => "api-child-stderr"),
      "api-child-exit",
      "api-unavailable",
    ]);

    assert.deepEqual(events[4].details, { classification: "SPAWN_ERROR", code: "ENOENT" });

    const stderr = events.filter((item) => item.event === "api-child-stderr");
    assert.deepEqual(stderr.map((item) => item.details), [
      { classification: "NATIVE_ABI_MISMATCH", bytes: Buffer.byteLength(chunks[0]) },
      { classification: "MODULE_NOT_FOUND", bytes: Buffer.byteLength(chunks[1]) },
      { classification: "SQLITE", bytes: Buffer.byteLength(chunks[2]) },
      { classification: "EADDRINUSE", bytes: Buffer.byteLength(chunks[3]) },
      { classification: "EPERM_EACCES", bytes: Buffer.byteLength(chunks[4]) },
      { classification: "UNKNOWN", bytes: Buffer.byteLength(chunks[5]) },
    ]);
    for (const item of stderr) {
      assert.deepEqual(Object.keys(item.details).sort(), ["bytes", "classification"]);
    }

    const exit = events.find((item) => item.event === "api-child-exit");
    assert.deepEqual(exit.details, { pid: 4322, exitCode: 1, signal: null });
    const unavailable = events.find((item) => item.event === "api-unavailable");
    assert.deepEqual(unavailable.details, { reason: "child-exit" });

    const serialized = JSON.stringify(events);
    for (const raw of [
      "raw message",
      "C:\\secret",
      "token",
      "NODE_MODULE_VERSION 127",
      "ERR_MODULE_NOT_FOUND",
      "SQLITE_CANTOPEN",
      "listen EADDRINUSE: address already in use",
      "EACCES: permission denied",
      "plain raw stderr text",
    ]) {
      assert.equal(serialized.includes(raw), false, `chunk/mensagem raw escapou: ${raw}`);
    }
  });
});
