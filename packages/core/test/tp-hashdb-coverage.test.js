import { describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SignatureDatabase, BUILTIN_HASH_SIGNATURES } from "../dist/signatures.js";
// O buffer canónico do controlo positivo vive em `src/yara.ts` (fora dos
// ficheiros de teste), por isso este teste NÃO carrega a assinatura EICAR no
// seu próprio texto: calcula o SHA-256 a partir do buffer exportado. Nada é
// escrito em disco.
import { CYBERSAFE_EICAR_POSITIVE_CONTROL_BUFFER } from "../dist/yara.js";

/**
 * TP-PAP-FREEBUFF-YARA-HASHDB-P0 — cobertura honesta no load da base de hashes.
 *
 * ── O defeito que este ficheiro existe para apanhar ────────────────────────
 * `load(filePath)` só olhava para "o array tem pelo menos um registo válido?".
 * Uma base truncada — por exemplo um `default.json` com uma única entrada que
 * não é nenhuma das assinaturas offline obrigatórias (EICAR + WannaCry) — era
 * carregada como `active`, com a cobertura offline perdida. A base em memória
 * ficava sem o EICAR e o health dizia que estava tudo bem.
 *
 * O critério de cobertura NÃO é "ter uma base enorme": são exactamente as
 * assinaturas built-in cuja proveniência está provada em `signatures.ts`
 * (`REQUIRED_BUILTIN_HASHES`). Nada aqui inventa hashes: os positivos são o
 * SHA-256 real de bytes que este teste controla (EICAR calculado em memória, e
 * um ficheiro benigno temporário).
 */

const EICAR_SHA256 = crypto
  .createHash("sha256")
  .update(CYBERSAFE_EICAR_POSITIVE_CONTROL_BUFFER)
  .digest("hex");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function tmpdir(prefix = "cybersafe-hashcov-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeDb(dir, records) {
  const file = path.join(dir, "hashes.json");
  await fs.writeFile(file, JSON.stringify(records, null, 2), "utf-8");
  return file;
}

/** Registos built-in completos, como uma base já semeada. */
const COMPLETE_BUILTINS = BUILTIN_HASH_SIGNATURES.map((r) => ({ ...r }));

describe("TP HashDB — base ausente ou inválida: degradada, nunca activa a fingir", () => {
  test("ausente ⇒ built-in, degraded, EICAR (hash real) hit e desconhecido miss", async () => {
    const dir = await tmpdir();
    try {
      assert.equal(
        EICAR_SHA256,
        BUILTIN_HASH_SIGNATURES.find((r) => r.family === "EICAR-Test-File").sha256,
        "o buffer canónico tem de regenerar o SHA-256 built-in (positivo real, não copiado)",
      );

      const db = new SignatureDatabase();
      await db.load(path.join(dir, "nao-existe.json"));
      assert.equal(db.health.status, "degraded");
      assert.equal(db.source, "built-in");
      assert.ok(db.size >= BUILTIN_HASH_SIGNATURES.length);

      const hit = db.match(EICAR_SHA256);
      assert.ok(hit, "a base embutida tem de conter o SHA-256 real do EICAR");
      assert.equal(hit.family, "EICAR-Test-File");

      assert.equal(db.match(sha256("conteudo que nao esta na base")), undefined);
      assert.equal(db.match("nao-e-um-sha256"), undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("JSON inválido ⇒ built-in, degraded e o EICAR continua detetável", async () => {
    const dir = await tmpdir();
    try {
      const file = path.join(dir, "hashes.json");
      await fs.writeFile(file, "{ isto nao e json", "utf-8");
      const db = new SignatureDatabase();
      await db.load(file);
      assert.equal(db.health.status, "degraded");
      assert.equal(db.source, "built-in");
      assert.ok(db.match(EICAR_SHA256));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("TP HashDB — base incompleta não é 'active' e não perde a cobertura offline", () => {
  test("uma única entrada externa válida ⇒ degraded, cobertura built-in reposta EM MEMÓRIA", async () => {
    const dir = await tmpdir();
    try {
      const benign = Buffer.from("TP HashDB — amostra benigna controlada", "utf8");
      const external = {
        sha256: sha256(benign),
        family: "Benign-Fixture",
        severity: "low",
        source: "tp-fixture",
      };
      const file = await writeDb(dir, [external]);
      const before = await fs.readFile(file, "utf-8");

      const db = new SignatureDatabase();
      await db.load(file);

      assert.notEqual(
        db.health.status,
        "active",
        "uma base sem as assinaturas offline obrigatórias NÃO pode ser declarada completa",
      );
      assert.equal(db.health.status, "degraded");
      assert.match(
        db.health.detail ?? "",
        /cobertura|built-in|insuficiente/i,
        "o detalhe tem de dizer que a cobertura é insuficiente (PT-PT)",
      );
      assert.doesNotMatch(db.health.detail ?? "", /detectam|detectando/i, "PT-BR não entra no health");

      // O registo externo não é descartado…
      assert.ok(db.match(external.sha256), "a entrada válida do ficheiro continua consultável");
      assert.equal(db.match(external.sha256).family, "Benign-Fixture");
      // …e a cobertura offline é reposta em memória (não inventada: é a built-in).
      assert.ok(db.match(EICAR_SHA256), "o EICAR real tem de voltar a ser detetável");
      for (const record of BUILTIN_HASH_SIGNATURES) {
        assert.ok(db.match(record.sha256), `falta ${record.family} depois do load`);
      }
      assert.equal(db.size, 1 + BUILTIN_HASH_SIGNATURES.length);

      // `load` não é um escritor: a base em disco fica intacta para o refresh decidir.
      assert.equal(await fs.readFile(file, "utf-8"), before, "load() não pode reescrever a base em disco");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("a base incompleta é corrigida pelo refresh seguinte (o health degraded não fica eterno)", async () => {
    const dir = await tmpdir();
    try {
      const file = await writeDb(dir, [{ ...BUILTIN_HASH_SIGNATURES[0], source: "tp" }]);
      const db = new SignatureDatabase();
      await db.load(file);
      assert.equal(db.health.status, "degraded");

      const changed = await db.refreshBuiltinIfStale(file);
      assert.equal(changed, true, "a cobertura em falta conta como stale");
      assert.equal(db.health.status, "active");
      const onDisk = JSON.parse(await fs.readFile(file, "utf-8"));
      assert.equal(onDisk.length, BUILTIN_HASH_SIGNATURES.length);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("TP HashDB — base válida: active sem exigir base enorme", () => {
  test("built-in completos + 1 externo ⇒ active, hit real e miss real", async () => {
    const dir = await tmpdir();
    try {
      const sample = path.join(dir, "amostra.txt");
      const bytes = Buffer.from("conteudo benigno cujo sha256 e o positivo real", "utf8");
      await fs.writeFile(sample, bytes);
      const external = {
        sha256: sha256(bytes),
        family: "Benign-Fixture",
        severity: "medium",
        source: "tp-fixture",
      };
      const file = await writeDb(dir, [...COMPLETE_BUILTINS, external]);

      const db = new SignatureDatabase();
      await db.load(file);

      assert.equal(db.health.status, "active", "3 built-in + 1 externo é cobertura suficiente");
      assert.equal(db.source, file);
      assert.equal(db.size, BUILTIN_HASH_SIGNATURES.length + 1, "não se exige uma base grande");

      const hit = db.match(sha256(await fs.readFile(sample)));
      assert.ok(hit, "o hash real do ficheiro tem de ser encontrado");
      assert.equal(hit.family, "Benign-Fixture");

      // Miss real: o mesmo ficheiro com 1 byte diferente deixa de casar.
      await fs.writeFile(sample, Buffer.from(bytes.toString("utf8") + "!", "utf8"));
      assert.equal(db.match(sha256(await fs.readFile(sample))), undefined);

      assert.ok(db.match(EICAR_SHA256), "e as assinaturas offline continuam presentes");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
