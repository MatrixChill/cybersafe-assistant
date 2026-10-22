import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SignatureDatabase, BUILTIN_HASH_SIGNATURES } from "../dist/index.js";

// SHA-256 real do EICAR de 68 bytes (regenerado abaixo a partir do texto).
const EICAR_CONTENT = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const EICAR_SHA256 = crypto
  .createHash("sha256")
  .update(Buffer.from(EICAR_CONTENT, "binary"))
  .digest("hex");

// O hash fabricado que a base enviou no default.json antigo: os 32 hex
// iniciais coincidem com o MD5 do texto EICAR, mas o valor completo não
// reproduz nenhuma das derivações verificadas (ver RETIRED_HASH_SIGNATURES).
const FABRICATED_EICAR =
  "44d88612fea8a8f36de82e1278abb02f2b8d6f66b0f0455d8f4f0d5dce9d734a";

const USER_RECORD = {
  sha256: "a".repeat(64),
  family: "UserImported-Sample",
  severity: "high",
  source: "user-import",
};

let tmpDir;
let dbPath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-hashdb-"));
  dbPath = path.join(tmpDir, "default.json");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Lê e valida o JSON em disco, garantindo que continua a ser uma base usable. */
async function readDb(file) {
  const raw = await fs.readFile(file, "utf-8");
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed), "default.json tem de ser um array de assinaturas");
  assert.ok(parsed.length > 0, "default.json nunca pode ficar vazio");
  return parsed;
}

function assertRealEicarPresent(records) {
  const hashes = records.map((r) => String(r.sha256).toLowerCase());
  assert.ok(
    hashes.includes(EICAR_SHA256),
    "o EICAR real tem de estar presente na base em disco",
  );
  assert.ok(
    !hashes.includes(FABRICATED_EICAR),
    "o hash fabricado do EICAR nunca pode persistir",
  );
}

describe("hash DB offline — EICAR real é o critério de saúde", () => {
  test("o EICAR de teste é realmente detetado com o built-in", async () => {
    const db = new SignatureDatabase();
    await db.load(path.join(tmpDir, "ausente.json"));
    const hit = db.match(EICAR_SHA256);
    assert.ok(hit, "EICAR real tem de ser detetado");
    assert.equal(hit.family, "EICAR-Test-File");
    assert.equal(hit.severity, "critical");
    assert.equal(EICAR_SHA256, "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f");
  });
});

describe("refreshBuiltinIfStale — re-semeia/preserva a base", () => {
  test("stale: base com hash EICAR fabricado é curada e o EICAR real fica em disco", async () => {
    await fs.writeFile(
      dbPath,
      JSON.stringify(
        [
          {
            sha256: FABRICATED_EICAR,
            family: "EICAR-Test-File",
            severity: "critical",
            source: "built-in",
          },
          USER_RECORD,
        ],
        null,
        2,
      ),
      "utf-8",
    );

    const db = new SignatureDatabase();
    await db.load(dbPath);
    const changed = await db.refreshBuiltinIfStale(dbPath);
    assert.equal(changed, true, "uma base stale tem de ser refrescada");

    const records = await readDb(dbPath);
    assertRealEicarPresent(records);
    assert.ok(
      records.some((r) => r.sha256 === USER_RECORD.sha256),
      "registos válidos do utilizador não podem ser apagados",
    );
  });

  test("vazio: ficheiro em disco vazio volta a ser semeado com o EICAR", async () => {
    await fs.writeFile(dbPath, "", "utf-8");

    const db = new SignatureDatabase();
    await db.load(dbPath);
    assert.equal(db.health.status, "degraded", "base vazia em disco não é 'active'");
    assert.equal(db.size, BUILTIN_HASH_SIGNATURES.length, "fallback offline tem de ter registos");

    const changed = await db.refreshBuiltinIfStale(dbPath);
    assert.equal(changed, true);

    const records = await readDb(dbPath);
    assertRealEicarPresent(records);
    assert.ok(records.length >= BUILTIN_HASH_SIGNATURES.length);
  });

  test("corrompido: JSON inválido em disco é substituído por uma base válida", async () => {
    await fs.writeFile(dbPath, "{not-json", "utf-8");

    const db = new SignatureDatabase();
    await db.load(dbPath);
    assert.equal(db.health.status, "degraded");
    assert.ok(db.match(EICAR_SHA256), "mesmo com o ficheiro corrompido, o EICAR deteta");

    const changed = await db.refreshBuiltinIfStale(dbPath);
    assert.equal(changed, true);

    assertRealEicarPresent(await readDb(dbPath));
  });

  test("parcial: base em disco sem o EICAR é completada sem perder o resto", async () => {
    await fs.writeFile(
      dbPath,
      JSON.stringify([USER_RECORD], null, 2),
      "utf-8",
    );

    const db = new SignatureDatabase();
    await db.load(dbPath);
    const changed = await db.refreshBuiltinIfStale(dbPath);
    assert.equal(changed, true, "cobertura offline em falta conta como stale");

    const records = await readDb(dbPath);
    assertRealEicarPresent(records);
    assert.ok(records.some((r) => r.sha256 === USER_RECORD.sha256));
  });

  test("idempotente: uma base já correta não é reescrita", async () => {
    const db = new SignatureDatabase();
    await db.load(path.join(tmpDir, "ausente.json")); // base embutida em memória
    assert.equal(await db.refreshBuiltinIfStale(dbPath), true); // semeia a primeira vez

    const before = await fs.readFile(dbPath, "utf-8");
    assert.equal(await db.refreshBuiltinIfStale(dbPath), false, "segunda passagem não muda nada");
    assert.equal(await fs.readFile(dbPath, "utf-8"), before, "ficheiro não pode ser reescrito à toa");
  });
});

describe("ensureFile — cria/repara o default.json offline", () => {
  test("cria um default.json válido com o EICAR quando o ficheiro está ausente", async () => {
    const db = new SignatureDatabase();
    await db.load(path.join(tmpDir, "ausente.json"));
    await db.ensureFile(dbPath);

    const records = await readDb(dbPath);
    assertRealEicarPresent(records);
    assert.equal(db.health.status, "active", "base semeada em disco é 'active'");
    assert.equal(db.source, dbPath);
  });

  test("repara um default.json vazio ou corrompido já existente", async () => {
    await fs.writeFile(dbPath, "", "utf-8");
    const db = new SignatureDatabase();
    await db.load(dbPath);
    await db.ensureFile(dbPath);
    assertRealEicarPresent(await readDb(dbPath));

    await fs.writeFile(dbPath, "]]]nao é json[[[", "utf-8");
    const db2 = new SignatureDatabase();
    await db2.load(dbPath);
    await db2.ensureFile(dbPath);
    assertRealEicarPresent(await readDb(dbPath));
  });
});

describe("health honesto — 'active' só com base real em disco", () => {
  test("default.json vazio em disco ⇒ degraded com built-in, nunca active a fingir", async () => {
    await fs.writeFile(dbPath, "[]", "utf-8");
    const db = new SignatureDatabase();
    await db.load(dbPath);

    assert.notEqual(db.health.status, "active", "nunca 'active' sem base real");
    assert.equal(db.health.status, "degraded");
    assert.ok(db.size > 0, "nem sequer pode ficar com a base vazia");
    assert.ok(db.match(EICAR_SHA256));
  });

  test("JSON que não é array ⇒ degraded com built-in, nunca active", async () => {
    await fs.writeFile(dbPath, JSON.stringify({ hashes: [] }), "utf-8");
    const db = new SignatureDatabase();
    await db.load(dbPath);

    assert.notEqual(db.health.status, "active");
    assert.ok(db.match(EICAR_SHA256));
  });

  test("depois do refresh/seed, load() reporta active com a base real em disco", async () => {
    const db = new SignatureDatabase();
    await db.load(path.join(tmpDir, "ausente.json"));
    await db.ensureFile(dbPath);
    await db.refreshBuiltinIfStale(dbPath);

    const reopened = new SignatureDatabase();
    await reopened.load(dbPath);
    assert.equal(reopened.health.status, "active", "base válida em disco ⇒ active");
    assert.equal(reopened.source, dbPath);
    assert.ok(reopened.size >= BUILTIN_HASH_SIGNATURES.length);
    const hit = reopened.match(EICAR_SHA256);
    assert.ok(hit, "EICAR real tem de continuar detetável depois do seed/refresh");
    assert.equal(hit.family, "EICAR-Test-File");
  });

  test("base com registos não é substituída pelo built-in quando já é boa", async () => {
    await fs.writeFile(
      dbPath,
      JSON.stringify(
        [
          ...BUILTIN_HASH_SIGNATURES,
          { sha256: USER_RECORD.sha256, family: "X", severity: "low", source: "feed" },
        ],
        null,
        2,
      ),
      "utf-8",
    );
    const db = new SignatureDatabase();
    await db.load(dbPath);
    assert.equal(db.health.status, "active");
    assert.equal(db.size, BUILTIN_HASH_SIGNATURES.length + 1);
    assert.ok(db.match(USER_RECORD.sha256));
  });
});

describe("fail-safe — nenhum caminho de erro apaga a base offline", () => {
  test("feed remoto vazio/inválido não apaga nem reescreve a base em disco", async () => {
    const db = new SignatureDatabase();
    await db.load(path.join(tmpDir, "ausente.json"));
    await db.ensureFile(dbPath);
    const before = await fs.readFile(dbPath, "utf-8");
    const sizeBefore = db.size;

    for (const feed of [[], null, undefined, "nope", { hashes: [] }, [{}, 42, null]]) {
      const result = await db.applyRemoteRecords(dbPath, feed);
      assert.equal(result.applied, false, `feed ${JSON.stringify(feed)} não pode ser aplicado`);
      assert.equal(result.total, sizeBefore);
    }

    assert.equal(await fs.readFile(dbPath, "utf-8"), before, "ficheiro intacto byte a byte");
    assert.ok(db.match(EICAR_SHA256), "EICAR continua detetável");
  });

  test("feed parcial é fundido e o EICAR offline sobrevive à 'atualização'", async () => {
    const db = new SignatureDatabase();
    await db.load(path.join(tmpDir, "ausente.json"));
    await db.ensureFile(dbPath);

    const result = await db.applyRemoteRecords(dbPath, [
      { sha256: "b".repeat(64), family: "RemoteOnly", severity: "high", source: "feed" },
      // entrada parcialmente corrompida: descartada, não pode estragar nada
      { family: "SemHash", severity: "low" },
    ]);
    assert.equal(result.applied, true);
    assert.ok(db.match("b".repeat(64)), "hash novo do feed entra");
    assert.ok(db.match(EICAR_SHA256), "EICAR real nunca desaparece com um feed parcial");

    const reopened = new SignatureDatabase();
    await reopened.load(dbPath);
    assert.equal(reopened.health.status, "active");
    assertRealEicarPresent(await readDb(dbPath));
  });

  test("falha a gravar o feed reverte tudo e mantém a base existente", async () => {
    const db = new SignatureDatabase();
    await db.load(path.join(tmpDir, "ausente.json"));
    const good = path.join(tmpDir, "default.json");
    await db.ensureFile(good);
    const before = await fs.readFile(good, "utf-8");
    const sizeBefore = db.size;

    // Caminho de escrita inválido: "bloqueio" é um ficheiro, não um diretório.
    const blocker = path.join(tmpDir, "bloqueio");
    await fs.writeFile(blocker, "sou um ficheiro, não um diretório", "utf-8");
    const result = await db.applyRemoteRecords(path.join(blocker, "default.json"), [
      { sha256: "c".repeat(64), family: "RemoteOnly", severity: "high", source: "feed" },
    ]);

    assert.equal(result.applied, false, "feed não aplicado quando a escrita falha");
    assert.equal(result.total, sizeBefore);
    assert.equal(db.size, sizeBefore, "estado em memória tem de ser revertido");
    assert.equal(db.match("c".repeat(64)), undefined, "hash do feed não fica em memória");
    assert.ok(db.match(EICAR_SHA256), "EICAR preservado apesar da falha");
    assert.equal(await fs.readFile(good, "utf-8"), before, "a base em disco fica intacta");
    assert.notEqual(db.health.status, "active", "health não pode mentir após uma falha");
  });

  test("save() recusa gravar uma base vazia e não cria ficheiro", async () => {
    const db = new SignatureDatabase();
    const target = path.join(tmpDir, "vazia.json");
    await assert.rejects(() => db.save(target), /vazia/i);
    assert.equal(
      await fs.access(target).then(() => true, () => false),
      false,
      "nenhum ficheiro pode ser criado a partir de uma base vazia",
    );
  });

  test("refreshBuiltinIfStale com escrita impossível não perde a base nem declara active", async () => {
    const db = new SignatureDatabase();
    await db.load(path.join(tmpDir, "ausente.json"));
    const blocker = path.join(tmpDir, "bloqueio");
    await fs.writeFile(blocker, "bloqueado", "utf-8");

    const changed = await db.refreshBuiltinIfStale(path.join(blocker, "default.json"));
    assert.equal(changed, false, "sem escrita não há refresh");
    assert.ok(db.size >= BUILTIN_HASH_SIGNATURES.length, "base em memória intacta");
    assert.ok(db.match(EICAR_SHA256), "EICAR continua detetável");
    assert.notEqual(db.health.status, "active", "health não pode mentir");
  });

  test("erro de leitura não descarta a base já carregada", async () => {
    const db = new SignatureDatabase();
    await db.load(path.join(tmpDir, "ausente.json"));
    const sizeBefore = db.size;

    // Ler um diretório falha ao nível de I/O (EISDIR/EPERM).
    await db.load(tmpDir);
    assert.equal(db.size, sizeBefore, "a base em memória nunca é apagada por erro de I/O");
    assert.ok(db.match(EICAR_SHA256));
  });
});
