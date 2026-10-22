import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  API_SECRET_MIN_LENGTH,
  DEFAULT_API_PORT,
  INSTALLATION_SECRET_FILENAME,
  buildApiChildEnv,
  readOrCreateInstallationSecret,
  resolveApiEntryPath,
  startLocalApi,
  stopLocalApi,
  waitForApiHealth,
} from "../src/api-lifecycle.ts";

/**
 * Contrato do ciclo de vida da API local empacotada.
 *
 * O que está a ser protegido: sem segredo próprio da instalação a API aborta
 * (S1); com um segredo substituído em silêncio todas as sessões morrem; sem
 * limpeza de ambiente o processo empacotado herda flags de DEV (sem listener, ou
 * a apontar para a DB de DEV); e uma API que não responde não pode ser reportada
 * como pronta nem pode impedir o arranque da proteção.
 */

let tmpRoot;
before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-api-lifecycle-"));
});
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function secretDir(label) {
  return path.join(tmpRoot, label, "secrets");
}

describe("segredo por instalação", () => {
  it("gera e persiste um segredo novo fora do pacote, com 32+ caracteres", () => {
    const dir = secretDir("novo");
    const result = readOrCreateInstallationSecret(dir);

    assert.equal(result.created, true);
    assert.ok(result.secret.length >= API_SECRET_MIN_LENGTH, "segredo demasiado curto");
    assert.equal(result.secretPath, path.join(dir, INSTALLATION_SECRET_FILENAME));
    assert.ok(fs.existsSync(result.secretPath), "o segredo não ficou em disco");
    assert.equal(fs.readFileSync(result.secretPath, "utf8").trim(), result.secret);

    // Sem temporários para trás: a escrita é atómica.
    assert.deepEqual(fs.readdirSync(dir), [INSTALLATION_SECRET_FILENAME]);
  });

  it("reutiliza o segredo existente (as sessões sobrevivem a um reinício)", () => {
    const dir = secretDir("reutiliza");
    const first = readOrCreateInstallationSecret(dir);
    const second = readOrCreateInstallationSecret(dir);

    assert.equal(first.created, true);
    assert.equal(second.created, false, "um 2.º arranque não pode gerar segredo novo");
    assert.equal(second.secret, first.secret);
  });

  it("recusa um ficheiro de segredo demasiado curto em vez de o substituir em silêncio", () => {
    const dir = secretDir("curto");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, INSTALLATION_SECRET_FILENAME);
    fs.writeFileSync(file, "curto\n");

    assert.throws(() => readOrCreateInstallationSecret(dir), /inválido/i);
    assert.equal(fs.readFileSync(file, "utf8").trim(), "curto", "o ficheiro foi alterado sem autorização");
  });

  it("não aceita um gerador que devolva um valor abaixo do mínimo (nada é escrito)", () => {
    const dir = secretDir("gerador-fraco");
    assert.throws(
      () => readOrCreateInstallationSecret(dir, { generateSecret: () => "1234" }),
      /mínimo/i,
    );
    assert.equal(fs.existsSync(path.join(dir, INSTALLATION_SECRET_FILENAME)), false);
  });

  it("os segredos de duas instalações são diferentes", () => {
    const a = readOrCreateInstallationSecret(secretDir("inst-a"));
    const b = readOrCreateInstallationSecret(secretDir("inst-b"));
    assert.notEqual(a.secret, b.secret);
  });
});

describe("resolução do entry empacotado", () => {
  it("prefere a cópia desempacotada (módulo nativo fora do asar)", () => {
    const appPath = path.join(tmpRoot, "resources", "app.asar");
    const unpackedEntry = path.join(
      tmpRoot,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "api",
      "dist",
      "index.js",
    );
    const asarEntry = path.join(appPath, "node_modules", "api", "dist", "index.js");
    const found = resolveApiEntryPath(appPath, (candidate) => candidate === unpackedEntry || candidate === asarEntry);
    assert.equal(found, unpackedEntry);
  });

  it("usa o caminho dentro do asar quando não há cópia desempacotada", () => {
    const appPath = path.join(tmpRoot, "resources", "app.asar");
    const asarEntry = path.join(appPath, "node_modules", "api", "dist", "index.js");
    assert.equal(resolveApiEntryPath(appPath, (candidate) => candidate === asarEntry), asarEntry);
  });

  it("devolve null quando a API não está no artefacto (falha honesta)", () => {
    assert.equal(resolveApiEntryPath(path.join(tmpRoot, "resources", "app.asar"), () => false), null);
  });
});

describe("ambiente do processo filho", () => {
  it("injeta o segredo e limpa flags de DEV/teste herdadas", () => {
    const env = buildApiChildEnv(
      {
        PATH: "C:\\Windows",
        CYBERSAFE_API_NO_LISTEN: "1",
        CYBERSAFE_DB_PATH: "C:\\dev\\repo\\packages\\api\\prisma\\dev.db",
        CYBERSAFE_API_ALLOWED_ORIGINS: "http://localhost:5173",
      },
      { secret: "s".repeat(40), port: 4010 },
    );

    assert.equal(env.JWT_SECRET, "s".repeat(40));
    assert.equal(env.CYBERSAFE_API_PORT, "4010");
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(env.CYBERSAFE_API_NO_LISTEN, undefined, "a flag de teste deixaria a API sem listener");
    assert.equal(env.CYBERSAFE_DB_PATH, undefined, "os dados do produto não podem apontar para a DB de DEV");
    assert.equal(env.PATH, "C:\\Windows");
  });

  it("só liberta Origin: null com opt-in explícito da instalação", () => {
    const base = buildApiChildEnv({}, { secret: "s".repeat(40), port: DEFAULT_API_PORT });
    assert.equal(base.CYBERSAFE_API_ALLOW_NULL_ORIGIN, undefined);

    const desktop = buildApiChildEnv({}, { secret: "s".repeat(40), port: DEFAULT_API_PORT, allowNullOrigin: true });
    assert.equal(desktop.CYBERSAFE_API_ALLOW_NULL_ORIGIN, "1");
  });

  it("aceita um dbPath explícito sem o herdar do ambiente", () => {
    const env = buildApiChildEnv(
      { CYBERSAFE_DB_PATH: "C:\\dev\\dev.db" },
      { secret: "s".repeat(40), port: 4000, dbPath: "C:\\tmp\\probe.db" },
    );
    assert.equal(env.CYBERSAFE_DB_PATH, "C:\\tmp\\probe.db");
  });
});

describe("readiness por HTTP", () => {
  it("devolve true quando /health responde ok na porta da instalação", async () => {
    const calls = [];
    const ok = await waitForApiHealth(4321, {
      fetchImpl: async (url) => {
        calls.push(url);
        return { ok: true };
      },
    });
    assert.equal(ok, true);
    assert.equal(calls[0], "http://127.0.0.1:4321/health");
  });

  it("devolve false quando expira sem resposta (nunca declara pronto por omissão)", async () => {
    let clock = 0;
    const ok = await waitForApiHealth(4322, {
      timeoutMs: 1000,
      intervalMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    assert.equal(ok, false);
  });
});

describe("arranque da API empacotada", () => {
  function fakeChild() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.exitCode = 0;
      return true;
    };
    return child;
  }

  it("sem entry no artefacto não arranca nenhum processo e reporta skipped", async () => {
    let spawned = 0;
    const result = await startLocalApi({
      appPath: path.join(tmpRoot, "sem-api", "app.asar"),
      userDataDir: path.join(tmpRoot, "sem-api", "userData"),
      electronPath: "electron.exe",
      existsSync: () => false,
      spawnImpl: () => {
        spawned += 1;
        return fakeChild();
      },
      log: () => {},
    });

    assert.equal(result.status, "skipped");
    assert.equal(spawned, 0);
  });

  it("falha de segredo não lança: devolve failed e deixa a proteção seguir", async () => {
    const appPath = path.join(tmpRoot, "segredo-mau", "app.asar");
    const entry = path.join(appPath, "node_modules", "api", "dist", "index.js");
    const userDataDir = path.join(tmpRoot, "segredo-mau", "userData");
    fs.mkdirSync(path.join(userDataDir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, "secrets", INSTALLATION_SECRET_FILENAME), "curto\n");

    const result = await startLocalApi({
      appPath,
      userDataDir,
      electronPath: "electron.exe",
      existsSync: (candidate) => candidate === entry,
      spawnImpl: () => fakeChild(),
      log: () => {},
    });

    assert.equal(result.status, "failed");
    assert.match(result.reason, /segredo/);
  });

  it("arranca com o segredo da instalação e só reporta started após o /health", async () => {
    const appPath = path.join(tmpRoot, "ok", "app.asar");
    const entry = path.join(appPath, "node_modules", "api", "dist", "index.js");
    const userDataDir = path.join(tmpRoot, "ok", "userData");
    let spawnArgs = null;
    let spawnEnv = null;
    let spawnCwd = null;
    const child = fakeChild();

    const result = await startLocalApi({
      appPath,
      userDataDir,
      electronPath: "electron.exe",
      baseEnv: { CYBERSAFE_API_NO_LISTEN: "1", PATH: "C:\\Windows" },
      port: 4444,
      existsSync: (candidate) => candidate === entry,
      spawnImpl: (file, args, options) => {
        spawnArgs = args;
        spawnEnv = options.env;
        spawnCwd = options.cwd;
        return child;
      },
      waitForHealth: async (port) => port === 4444,
      log: () => {},
    });

    assert.equal(result.status, "started");
    assert.deepEqual(spawnArgs, [entry]);
    assert.equal(spawnEnv.JWT_SECRET.length >= API_SECRET_MIN_LENGTH, true);
    assert.equal(spawnEnv.CYBERSAFE_API_PORT, "4444");
    assert.equal(spawnEnv.CYBERSAFE_API_NO_LISTEN, undefined);
    assert.equal(spawnCwd, userDataDir);
    assert.ok(fs.existsSync(result.runtime.secretPath), "o segredo tem de ficar em disco");
    assert.ok(result.runtime.secretPath.startsWith(userDataDir), "o segredo nunca fica dentro do pacote");
  });

  it("API que não responde é terminada e reportada como failed (nunca started)", async () => {
    const appPath = path.join(tmpRoot, "timeout", "app.asar");
    const entry = path.join(appPath, "node_modules", "api", "dist", "index.js");
    const userDataDir = path.join(tmpRoot, "timeout", "userData");
    const child = fakeChild();

    const result = await startLocalApi({
      appPath,
      userDataDir,
      electronPath: "electron.exe",
      existsSync: (candidate) => candidate === entry,
      spawnImpl: () => child,
      waitForHealth: async () => false,
      log: () => {},
    });

    assert.equal(result.status, "failed");
    assert.equal(child.killed, true, "um processo sem listener tem de ser encerrado");
  });

  it("stopLocalApi é idempotente e não falha com processo já encerrado", () => {
    const child = fakeChild();
    stopLocalApi(child);
    assert.equal(child.killed, true);
    stopLocalApi(child);
    stopLocalApi(null);
  });
});
