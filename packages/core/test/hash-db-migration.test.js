import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SignatureDatabase,
  BUILTIN_HASH_SIGNATURES,
  sanitizeSignatureRecords,
} from "../dist/index.js";

// Suite da MIGRACAO da base de hashes (2026-09-30/10-01). Prova tres coisas
// sobre as duas bases de hash que o repo envia ao utilizador:
//   1) o estado migrado esta correto e normalizado (nada fabricado, nada sem
//      proveniencia, familia certa, cobertura built-in completa);
//   2) a migracao e IDEMPOTENTE: correr 2x da delta zero a partir da 2a vez, e
//      uma base ja migrada nao e sequer reescrita na 1a;
//   3) entradas externas (source=malwarebazaar e afins) e a sua proveniencia
//      sobrevivem intactas a passagem da migracao.
//
// REGRA P0 (utilizador, 2026-09-28): NENHUM teste escreve a assinatura EICAR
// real em disco. O texto abaixo serve APENAS para calcular o SHA-256 em
// memoria e provar que a base o contem; nunca e gravado. Todas as escritas
// desta suite vao para copies em os.tmpdir(), nunca para os ficheiros do repo.
const EICAR_CONTENT = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const EICAR_SHA256 = crypto
  .createHash("sha256")
  .update(Buffer.from(EICAR_CONTENT, "binary"))
  .digest("hex");

// Hash fabricado que a base já enviou: os 32 hex iniciais coincidem com o MD5
// do texto EICAR, mas o valor completo não reproduz nenhuma das derivações
// verificadas. O motivo completo está em RETIRED_HASH_SIGNATURES.
const FABRICATED_EICAR =
  "44d88612fea8a8f36de82e1278abb02f2b8d6f66b0f0455d8f4f0d5dce9d734a";

// Hash removido em 2026-09-30: rotulado "TrickBot", sem qualquer registo publico.
const UNPROVEN_TRICKBOT =
  "71b6a493388e7d0b40c83ce903bc6b04d1b59f386d5ebbf117a4c7e6c43310ce";

const WANNACRY_MSSECSVC =
  "24d004a104d4d54034dbcffc2a4b19a11f39008a575aa614ea04703480b1022c";
const WANNACRY_TASKSCHE =
  "ed01ebfbc9eb5bbea545af4d01bf5f1071661840480439c6e5babe8e080e41aa";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/** As duas bases de hash que o repo envia. O service tem a sua propria copia. */
const SHIPPED_DBS = [
  { label: "definitions/hashes/default.json", rel: path.join("definitions", "hashes", "default.json") },
  {
    label: "packages/service/definitions/hashes/default.json",
    rel: path.join("packages", "service", "definitions", "hashes", "default.json"),
  },
];

/** Entrada externa real: familia que a base embutida nao possui. */
const EXTERNAL_RECORD = {
  sha256: "e".repeat(64),
  family: "Emotet-Trojan",
  severity: "high",
  source: "malwarebazaar",
};

let tmpDir;

/** Copia uma base do repo para o tmp: os testes nunca escrevem no repo. */
async function copyShipped(rel) {
  const src = path.join(REPO_ROOT, rel);
  const dst = path.join(tmpDir, path.basename(path.dirname(src)) + "-" + path.basename(src));
  await fs.copyFile(src, dst);
  return { src, dst };
}

/** Passa a migracao uma vez, com uma instancia nova (como o arranque real). */
async function migrateOnce(dbPath) {
  const db = new SignatureDatabase();
  await db.load(dbPath);
  const changed = await db.refreshBuiltinIfStale(dbPath);
  return { db, changed };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-hashmig-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("migracao — estado das bases enviadas no repo", () => {
  for (const { label, rel } of SHIPPED_DBS) {
    test(`${label}: base valida, sem hash fabricado e sem entrada sem prova`, async () => {
      const raw = await fs.readFile(path.join(REPO_ROOT, rel), "utf-8");
      const records = JSON.parse(raw);
      assert.ok(Array.isArray(records) && records.length > 0, "tem de ser um array nao vazio");

      const hashes = records.map((r) => String(r.sha256).toLowerCase());
      for (const [i, record] of records.entries()) {
        assert.match(
          record.sha256,
          /^[0-9a-f]{64}$/,
          `entrada ${i} (${record.family}) tem de ser um SHA-256 de 64 hex`,
        );
        assert.ok(record.family, `entrada ${i} tem de ter familia`);
        assert.ok(record.source, `entrada ${i} tem de ter source (proveniencia)`);
      }

      assert.ok(
        hashes.includes(EICAR_SHA256),
        "a base tem de conter o EICAR real (detecao provavel sem feeds)",
      );
      assert.ok(!hashes.includes(FABRICATED_EICAR), "o hash fabricado do EICAR nao pode persistir");
      assert.ok(!hashes.includes(UNPROVEN_TRICKBOT), "o hash sem proveniencia (TrickBot) nao pode voltar");
      assert.ok(
        records.every((r) => !/emotet/i.test(r.family) || hashes.includes(EXTERNAL_RECORD.sha256)),
        "so pode existir Emotet com um hash de proveniencia externa, nunca com hash inventado",
      );
    });

    test(`${label}: familia e provenance estao corretas apos a migracao`, async () => {
      const records = JSON.parse(await fs.readFile(path.join(REPO_ROOT, rel), "utf-8"));
      const byHash = new Map(records.map((r) => [r.sha256.toLowerCase(), r]));

      // tasksche.exe estava rotulado "Emotet-Trojan": duas fontes publicas
      // identificam a amostra como WannaCry, logo o rotulo tem de ser esse.
      assert.equal(
        byHash.get(WANNACRY_TASKSCHE)?.family,
        "WannaCry-Ransomware",
        "tasksche.exe (ed01...) e WannaCry, nunca Emotet",
      );
      assert.equal(byHash.get(WANNACRY_MSSECSVC)?.family, "WannaCry-Ransomware");
      assert.equal(byHash.get(EICAR_SHA256)?.family, "EICAR-Test-File");
    });

    test(`${label}: conteudo ja normalizado (a migracao nao tem trabalho a fazer)`, async () => {
      const raw = await fs.readFile(path.join(REPO_ROOT, rel), "utf-8");
      const normalized = JSON.stringify(sanitizeSignatureRecords(JSON.parse(raw)), null, 2);
      assert.equal(
        raw,
        normalized,
        "a base enviada tem de estar exatamente na forma que save() escreve",
      );
    });

    test(`${label}: cobre todos os hashes da base embutida`, async () => {
      const records = JSON.parse(await fs.readFile(path.join(REPO_ROOT, rel), "utf-8"));
      const hashes = new Set(records.map((r) => r.sha256.toLowerCase()));
      for (const record of BUILTIN_HASH_SIGNATURES) {
        assert.ok(
          hashes.has(record.sha256.toLowerCase()),
          `falta o hash built-in ${record.family} ${record.sha256.slice(0, 8)}`,
        );
      }
    });
  }
});

describe("migracao — idempotencia", () => {
  for (const { label, rel } of SHIPPED_DBS) {
    test(`${label}: uma base ja migrada nao e reescrita (delta zero na 1a e na 2a)`, async () => {
      const { src, dst } = await copyShipped(rel);
      const shippedBytes = await fs.readFile(src);

      const first = await migrateOnce(dst);
      assert.equal(
        first.changed,
        false,
        "uma base ja migrada nao pode ser reescrita: mudanca de bytes sem ganho e perda de proveniencia",
      );
      assert.deepEqual(
        await fs.readFile(dst),
        shippedBytes,
        "os bytes da base tem de ficar exatamente iguais aos enviados no repo",
      );

      const second = await migrateOnce(dst);
      assert.equal(second.changed, false, "segunda passagem tambem tem de ser delta zero");
      assert.deepEqual(await fs.readFile(dst), shippedBytes);
    });
  }

  test("base pre-migracao e reparada em 1 passada e estabiliza a seguir", async () => {
    const dbPath = path.join(tmpDir, "default.json");
    // Estado ANTES da migracao: EICAR fabricado, entrada TrickBot sem prova,
    // e o tasksche.exe rotulado com a familia errada.
    await fs.writeFile(
      dbPath,
      JSON.stringify(
        [
          { sha256: FABRICATED_EICAR, family: "EICAR-Test-File", severity: "critical", source: "built-in" },
          { sha256: UNPROVEN_TRICKBOT, family: "TrickBot", severity: "high", source: "built-in" },
          {
            sha256: WANNACRY_TASKSCHE,
            family: "Emotet-Trojan",
            severity: "critical",
            source: "malwarebazaar",
          },
        ],
        null,
        2,
      ),
      "utf-8",
    );

    const first = await migrateOnce(dbPath);
    assert.equal(first.changed, true, "a base pre-migracao tem de ser reparada");
    const afterFirst = await fs.readFile(dbPath, "utf-8");
    const records = JSON.parse(afterFirst);
    const hashes = records.map((r) => String(r.sha256).toLowerCase());

    assert.ok(hashes.includes(EICAR_SHA256), "EICAR real tem de substituir o hash fabricado");
    assert.ok(!hashes.includes(FABRICATED_EICAR), "o hash fabricado desaparece");
    assert.equal(
      records.find((r) => r.sha256 === WANNACRY_TASKSCHE)?.family,
      "WannaCry-Ransomware",
      "o rotulo errado tem de ser corrigido para a familia provada",
    );

    // Delta zero a partir da 2a passada: nem o return value nem os bytes mudam.
    const second = await migrateOnce(dbPath);
    assert.equal(second.changed, false, "2a passada tem de ser delta zero");
    assert.equal(await fs.readFile(dbPath, "utf-8"), afterFirst, "bytes inalterados na 2a passada");

    const third = await migrateOnce(dbPath);
    assert.equal(third.changed, false, "3a passada tem de continuar delta zero");
    assert.equal(await fs.readFile(dbPath, "utf-8"), afterFirst);
  });

  test("tres passagens seguidas sobre a base migrada do repo nao produzem delta", async () => {
    const { src, dst } = await copyShipped(SHIPPED_DBS[0].rel);
    const shippedBytes = await fs.readFile(src);
    for (let pass = 1; pass <= 3; pass += 1) {
      const { changed } = await migrateOnce(dst);
      assert.equal(changed, false, `passagem ${pass} nao devia mexer na base`);
      assert.deepEqual(await fs.readFile(dst), shippedBytes, `passagem ${pass} alterou os bytes`);
    }
  });

  test.todo("NUNCA escrever a assinatura EICAR real em disco");
});

describe("migracao — SHA-256 e a identidade primaria (family e metadata)", () => {
  /** Amostra externa real de WannaCry: hash legitimo, familia igual a uma built-in. */
  const EXTERNAL_WANNACRY = {
    sha256: "7".repeat(64),
    family: "WannaCry-Ransomware",
    severity: "high",
    source: "malwarebazaar",
  };

  /** Grava uma base de teste a partir de uma lista de registos. */
  async function writeDb(records) {
    const dbPath = path.join(tmpDir, "default.json");
    await fs.writeFile(dbPath, JSON.stringify(records, null, 2), "utf-8");
    return dbPath;
  }

  function readDb(dbPath) {
    return fs.readFile(dbPath, "utf-8").then((raw) => ({ raw, records: JSON.parse(raw) }));
  }

  test("entrada EXTERNA com SHA desconhecido e family de uma built-in => PRESERVADA", async () => {
    // A family coincide com a de uma amostra nossa, mas o SHA e outro ficheiro
    // legitimo. SHA-256 e a identidade: a family nao tem autoridade para apagar.
    // A base ja vem com a cobertura built-in toda, para o unico delta posible
    // ser a entrada externa (uma base sem cobertura e re-semeada, de proposito).
    const dbPath = await writeDb([...BUILTIN_HASH_SIGNATURES, EXTERNAL_WANNACRY]);
    const before = await readDb(dbPath);

    const { changed } = await migrateOnce(dbPath);
    const after = await readDb(dbPath);

    assert.equal(changed, false, "nao ha o que migrar: nada ficou obsoleto");
    assert.deepEqual(after.raw, before.raw, "uma entrada externa nunca e reescrita ou apagada");
    assert.ok(
      after.records.some((r) => r.sha256 === EXTERNAL_WANNACRY.sha256),
      "a amostra externa foi apagada so porque a family coincidia com uma built-in",
    );
  });

  test("SHA built-in conhecido com metadata antiga => CORRIGIDO, nunca apagado", async () => {
    const dbPath = await writeDb([
      { sha256: WANNACRY_TASKSCHE, family: "Emotet-Trojan", severity: "critical", source: "malwarebazaar" },
    ]);

    const { changed } = await migrateOnce(dbPath);
    assert.equal(changed, true, "a metadata errada tem de ser reconciliada");

    const { records } = await readDb(dbPath);
    const record = records.find((r) => r.sha256 === WANNACRY_TASKSCHE);
    assert.ok(record, "um hash built-in nunca e apagado por ter metadata desatualizada");
    assert.equal(record.family, "WannaCry-Ransomware", "a family provada tem de substituir a errada");
    assert.equal(record.source, "malwarebazaar", "a proveniencia externa nao e rebaixada");
  });

  test("SHA retired (71b6/TrickBot) => REMOVIDO por lista explicita, nunca por family", async () => {
    const dbPath = await writeDb([
      {
        sha256: UNPROVEN_TRICKBOT,
        family: "TrickBot",
        severity: "high",
        source: "built-in",
      },
      ...BUILTIN_HASH_SIGNATURES,
    ]);

    const { changed } = await migrateOnce(dbPath);
    assert.equal(changed, true, "um hash retired tem de sair da base");

    const { records } = await readDb(dbPath);
    assert.ok(
      !records.some((r) => r.sha256 === UNPROVEN_TRICKBOT),
      "o hash sem proveniencia continua a identificar uma amostra como TrickBot",
    );
    assert.ok(records.some((r) => r.sha256 === EICAR_SHA256), "a cobertura offline sobrevive");
  });

  test("a base real de runtime com 71b6/TrickBot fica limpa e estavel a 2a passagem", async () => {
    // Forma exata do default.json de um utilizador com a base antiga: 4
    // entradas, uma delas o TrickBot sem proveniencia.
    const dbPath = await writeDb([
      { sha256: WANNACRY_TASKSCHE, family: "WannaCry-Ransomware", severity: "critical", source: "built-in" },
      { sha256: UNPROVEN_TRICKBOT, family: "TrickBot", severity: "high", source: "built-in" },
      { sha256: EICAR_SHA256, family: "EICAR-Test-File", severity: "critical", source: "built-in" },
      { sha256: WANNACRY_MSSECSVC, family: "WannaCry-Ransomware", severity: "critical", source: "built-in" },
    ]);

    const first = await migrateOnce(dbPath);
    assert.equal(first.changed, true, "a 1a passagem tem de limpar a base antiga");
    const afterFirst = await readDb(dbPath);
    assert.ok(
      !afterFirst.records.some((r) => r.sha256 === UNPROVEN_TRICKBOT),
      "o falso positivo TrickBot tem de desaparecer da base de runtime",
    );

    const second = await migrateOnce(dbPath);
    assert.equal(second.changed, false, "2a execucao tem de ser delta zero");
    assert.equal((await readDb(dbPath)).raw, afterFirst.raw, "os bytes nao podem mudar na 2a passagem");
  });

  test("duas entradas da mesma family coexistem (uma built-in, uma externa)", async () => {
    const dbPath = await writeDb([
      { sha256: WANNACRY_MSSECSVC, family: "WannaCry-Ransomware", severity: "critical", source: "malwarebazaar" },
      EXTERNAL_WANNACRY,
      ...BUILTIN_HASH_SIGNATURES.filter((r) => r.sha256 !== WANNACRY_MSSECSVC),
    ]);
    const sourcesBefore = new Map(
      (await readDb(dbPath)).records.map((r) => [r.sha256, r.source]),
    );

    const { changed } = await migrateOnce(dbPath);
    assert.equal(changed, false, "coexistencia nao e conflito: nada a migrar");

    const { records } = await readDb(dbPath);
    const wannacry = records.filter((r) => r.family === "WannaCry-Ransomware");
    // A base embutida tem DOIS hashes WannaCry confirmados por fonte publica
    // (mssecsvc.exe e tasksche.exe), portanto a familia tem de poder ter os dois
    // mais a amostra externa: tres registos, sem colisao entre eles.
    assert.equal(wannacry.length, 3, "as tres amostras da mesma family tem de coexistir");
    assert.deepEqual(
      wannacry.map((r) => r.sha256).sort(),
      [WANNACRY_MSSECSVC, WANNACRY_TASKSCHE, EXTERNAL_WANNACRY.sha256].sort(),
      "nenhum dos hashes da familia pode desaparecer",
    );
    for (const record of wannacry) {
      assert.equal(
        record.source,
        sourcesBefore.get(record.sha256),
        `proveniencia de ${record.sha256.slice(0, 8)} foi alterada`,
      );
    }
    assert.equal(
      sourcesBefore.get(EXTERNAL_WANNACRY.sha256),
      "malwarebazaar",
      "o teste tem de ter uma entrada externa com proveniencia para valer a pena",
    );
  });
});

describe("migracao — preservacao de entradas externas", () => {
  test("source=malwarebazaar das bases enviadas sobrevive a migracao", async () => {
    for (const { label, rel } of SHIPPED_DBS) {
      const shipped = JSON.parse(await fs.readFile(path.join(REPO_ROOT, rel), "utf-8"));
      const { src, dst } = await copyShipped(rel);
      const shippedBytes = await fs.readFile(src);

      const { changed } = await migrateOnce(dst);
      assert.equal(changed, false, `${label}: nada para migrar`);

      const after = JSON.parse(await fs.readFile(dst, "utf-8"));
      assert.deepEqual(after, shipped, `${label}: a base tem de ficar identica`);
      assert.deepEqual(await fs.readFile(dst), shippedBytes);
      for (const record of shipped.filter((r) => r.source === "malwarebazaar")) {
        const kept = after.find((r) => r.sha256 === record.sha256);
        assert.ok(kept, `${label}: entrada externa ${record.family} desapareceu`);
        assert.equal(
          kept.source,
          "malwarebazaar",
          `${label}: proveniencia de ${record.sha256.slice(0, 8)} foi alterada para ${kept.source}`,
        );
      }
    }
  });

  test("a base da raiz mantem malwarebazaar nos dois hashes WannaCry provados", async () => {
    const shipped = JSON.parse(
      await fs.readFile(path.join(REPO_ROOT, SHIPPED_DBS[0].rel), "utf-8"),
    );
    const byHash = new Map(shipped.map((r) => [r.sha256, r.source]));
    for (const hash of [WANNACRY_MSSECSVC, WANNACRY_TASKSCHE]) {
      assert.equal(
        byHash.get(hash),
        "malwarebazaar",
        `${hash.slice(0, 8)} foiconfirmado em fonte publica: a proveniencia fica registada`,
      );
    }
  });

  test("F3: as DUAS bases enviadas agree na proveniencia do MESMO hash", async () => {
    // ── O que este teste existe para apanhar ────────────────────────────────
    // `definitions/hashes/default.json` (canonica) marca os dois hashes WannaCry
    // como `malwarebazaar`, porque a proveniencia foi provada em fonte publica
    // (VMRay / Mandiant / NJCCIC). `packages/service/definitions/hashes/default.json`
    // — a base que o serviço SEMEIA no arranque — marcava-os `built-in`.
    //
    // Isso e um REBAIXAMENTO DE PROVENIENCIA: o mesmo SHA-256, provado na mesma
    // base, aparece com uma origem mais fraca noutro ficheiro. E o principio que
    // o produto ja honra em `healLegacyRecords` ("a proveniencia nunca se rebaixa")
    // ficava com uma excepcao silenciosa, exactamente do tipo que nao se ve.
    //
    // SHA-256 = identidade. `source` = proveniencia. Duas bases com o mesmo
    // hash tem de contar a mesma historia sobre esse hash.
    const [canonical, packaged] = await Promise.all(
      SHIPPED_DBS.map(({ rel }) =>
        fs.readFile(path.join(REPO_ROOT, rel), "utf-8").then((raw) => JSON.parse(raw)),
      ),
    );
    const src = (records) => new Map(records.map((r) => [r.sha256, r.source]));

    const a = src(canonical);
    const b = src(packaged);
    assert.equal(b.size, a.size, "as duas bases enviadas tem de ter o mesmo numero de entradas");

    for (const [hash, source] of a) {
      assert.ok(
        b.has(hash),
        `${hash.slice(0, 8)} esta na base canonica e nao na que o serviço semeia`,
      );
      assert.equal(
        b.get(hash),
        source,
        `${hash.slice(0, 8)}: a base canonica diz "${source}" e a que o serviço semeia diz ` +
          `"${b.get(hash)}" — a proveniencia do mesmo hash nao pode diferir entre bases`,
      );
    }
  });

  test("entrada externa de outra familia sobrevive intacta a migracao", async () => {
    const { dst } = await copyShipped(SHIPPED_DBS[0].rel);
    const withExternal = JSON.parse(await fs.readFile(dst, "utf-8"));
    withExternal.push(EXTERNAL_RECORD);
    await fs.writeFile(dst, JSON.stringify(withExternal, null, 2), "utf-8");
    const before = await fs.readFile(dst, "utf-8");

    const { changed } = await migrateOnce(dst);
    assert.equal(changed, false, "uma entrada externa valida nao obriga a reescrever a base");
    assert.equal(await fs.readFile(dst, "utf-8"), before, "a proveniencia externa fica byte a byte");

    const records = JSON.parse(await fs.readFile(dst, "utf-8"));
    const kept = records.find((r) => r.sha256 === EXTERNAL_RECORD.sha256);
    assert.ok(kept, "a entrada externa nao pode ser apagada");
    assert.equal(kept.source, "malwarebazaar");
    assert.equal(kept.family, EXTERNAL_RECORD.family);
    assert.equal(kept.severity, EXTERNAL_RECORD.severity);
  });

  test("a proveniencia externa nao e reescrita para built-in ao semear cobertura", async () => {
    // Base com as entradas externas E sem a cobertura built-in: a migracao tem
    // de escrever, mas so de acrescentar o que falta — nunca de rebaixar o
    // source do que o utilizador ja tem.
    const dbPath = path.join(tmpDir, "default.json");
    await fs.writeFile(
      dbPath,
      JSON.stringify(
        [
          { sha256: WANNACRY_MSSECSVC, family: "WannaCry-Ransomware", severity: "critical", source: "malwarebazaar" },
          EXTERNAL_RECORD,
        ],
        null,
        2,
      ),
      "utf-8",
    );

    const { changed } = await migrateOnce(dbPath);
    assert.equal(changed, true, "falta o EICAR real, logo ha o que escrever");

    const records = JSON.parse(await fs.readFile(dbPath, "utf-8"));
    const byHash = new Map(records.map((r) => [r.sha256, r]));
    assert.equal(
      byHash.get(WANNACRY_MSSECSVC)?.source,
      "malwarebazaar",
      "o source externo nao pode ser rebaixado a built-in ao semear a cobertura",
    );
    assert.equal(byHash.get(EXTERNAL_RECORD.sha256)?.source, "malwarebazaar");
    assert.ok(byHash.has(EICAR_SHA256), "EICAR real acrescentado");
    assert.equal(byHash.get(EICAR_SHA256)?.source, "built-in");

    const second = await migrateOnce(dbPath);
    assert.equal(second.changed, false, "a base reescrita tem de estabilizar na 2a passada");
  });
});

describe("migracao — os ficheiros do repo nunca sao escritos pelos testes", () => {
  test("checksums das 2 bases enviadas iguais antes e depois da suite", async () => {
    const before = new Map();
    for (const { rel } of SHIPPED_DBS) {
      before.set(rel, crypto.createHash("sha256").update(await fs.readFile(path.join(REPO_ROOT, rel))).digest("hex"));
    }

    for (const { rel } of SHIPPED_DBS) {
      const { dst } = await copyShipped(rel);
      await migrateOnce(dst);
    }

    for (const [rel, digest] of before) {
      const now = crypto
        .createHash("sha256")
        .update(await fs.readFile(path.join(REPO_ROOT, rel)))
        .digest("hex");
      assert.equal(now, digest, `${rel} foi modificado por uma passagem de teste`);
    }
  });
});
