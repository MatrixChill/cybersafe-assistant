/**
 * TP-A1-API-ISOLATION-20261020 — guarda fail-closed do arranque do api.
 *
 * Medido, não teorizado: a importar `src/db.ts` sem nada declarado, um api em DEV criava
 * `%USERPROFILE%\.cybersafe-service\` e abria a base de dados REAL; `index.ts` escrevia o
 * registo de `startup` ao lado dela antes de qualquer validação; e a porta por omissão é 4000,
 * a da instalação.
 *
 * Critério (revisão Codex): produção é DITA (`NODE_ENV=production`, como faz
 * `desktop/src/api-lifecycle.ts:177-184`), nunca inferida de `.js`/`dist`/ausência. Modo não
 * declarado recusa. A compatibilidade dos 16 fixtures antigos não autoriza bypass — o que falta
 * é declararem modo no setup, e isso vai como necessidade exata para o reviewer.
 *
 * Nunca é aberto o_personal: nenhuma prova de resolução de produção corre em processo; só a
 * função pura, com fsLike de leitura.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const { identificarModo, validarArranqueApi, ERRO_ISOLAMENTO, dbPessoalApi } = await import("../dist/dev-isolation.js");

const PESSOAL = dbPessoalApi();
const TMP_REAL = fs.realpathSync(os.tmpdir());
const DIST_ENTRY = path.join("C:", "p", "dist", "index.js");
const SRC_ENTRY = path.join("C:", "p", "src", "index.ts");
const ENV_PRODUCAO = { NODE_ENV: "production" };

/** fsLike que EXPLODE a qualquer escrita: passar um teste que escreve é impossível por construção. */
function fsSoLeitura(overrides = {}) {
  const escritas = [];
  const veneno = (nome) => () => { escritas.push(nome); throw new Error(`ESCRITA_PROIBIDA:${nome}`); };
  return {
    escritas,
    existsSync: () => true,
    lstatSync: () => ({ isSymbolicLink: () => false }),
    realpathSync: (p) => p,
    mkdirSync: veneno("mkdirSync"),
    writeFileSync: veneno("writeFileSync"),
    appendFileSync: veneno("appendFileSync"),
    openSync: veneno("openSync"),
    ...overrides,
  };
}

const RAIZ = path.join(os.tmpdir(), "cs-a1-raiz");
const DB_RAIZ = path.join(RAIZ, "api", "cybersafe-test.db");
const ENV_DEV = { NODE_ENV: "", CYBERSAFE_DEV_ISOLATION: "1", CYBERSAFE_DEV_ROOT: RAIZ, CYBERSAFE_DB_PATH: DB_RAIZ, CYBERSAFE_API_PORT: "4100" };

describe("invariante 1 — o marcador DEV não pode ser desligado", () => {
  test("DEV + NODE_ENV=production é CONFLITO, não produção", () => {
    assert.equal(identificarModo({ entrypoint: SRC_ENTRY, env: { CYBERSAFE_DEV_ISOLATION: "1", NODE_ENV: "production" } }).modo, "conflito");
  });
  test("conflito recusa sem qualquer I/O, mesmo com config DEV perfeita", () => {
    const f = fsSoLeitura();
    assert.throws(
      () => validarArranqueApi({ entrypoint: SRC_ENTRY, env: { ...ENV_DEV, NODE_ENV: "production" }, fsLike: f }),
      (e) => e.code === ERRO_ISOLAMENTO && /conflito|ao mesmo tempo/i.test(e.message),
    );
    assert.deepEqual(f.escritas, []);
  });
  test("NODE_ENV=PRODUCTION em maiúsculas continua a ser produção declarada", () => {
    assert.equal(identificarModo({ entrypoint: DIST_ENTRY, env: { NODE_ENV: "PRODUCTION" } }).modo, "producao");
  });
});

describe("invariante 2 — a raiz DEV tem de ser dedicada dentro do TEMP real", () => {
  const raizesIlegitimas = [
    ["o TEMP inteiro", () => os.tmpdir()],
    ["o HOME do utilizador", () => os.homedir()],
    ["a drive do sistema", () => path.parse(path.resolve(os.tmpdir())).root],
    ["um caminho fora do TEMP", () => path.join(path.parse(path.resolve(os.tmpdir())).root, "cs-a1-fora-do-temp")],
  ];
  for (const [nome, dar] of raizesIlegitimas) {
    test(`recusa raiz = ${nome}`, () => {
      const f = fsSoLeitura();
      const raiz = path.resolve(dar());
      assert.throws(
        () => validarArranqueApi({ entrypoint: SRC_ENTRY, env: { ...ENV_DEV, CYBERSAFE_DEV_ROOT: raiz, CYBERSAFE_DB_PATH: path.join(raiz, "api", "x.db") }, fsLike: f }),
        (e) => e.code === ERRO_ISOLAMENTO,
        `tinha de recusar raiz = ${nome}`,
      );
      assert.deepEqual(f.escritas, [], "recusar não pode escrever nada");
    });
  }
  test("aceita um subdiretório dedicado do TEMP", () => {
    assert.equal(validarArranqueApi({ entrypoint: SRC_ENTRY, env: ENV_DEV, fsLike: fsSoLeitura() }).modo, "dev");
  });
});

describe("invariante 3 — ilegível não é o mesmo que inexistente", () => {
  const comErro = (code) => fsSoLeitura({
    lstatSync: (p) => {
      if (path.normalize(p) === path.normalize(path.join(RAIZ, "api"))) {
        throw Object.assign(new Error(`lstat falhou ${code}`), { code });
      }
      return { isSymbolicLink: () => false };
    },
  });
  for (const code of ["EACCES", "EPERM", "ESTALE", "ERVICIO_X"]) {
    test(`recusa quando lstat da cadeia devolve ${code}`, () => {
      const f = comErro(code);
      assert.throws(() => validarArranqueApi({ entrypoint: SRC_ENTRY, env: ENV_DEV, fsLike: f }), (e) => e.code === ERRO_ISOLAMENTO);
      assert.deepEqual(f.escritas, []);
    });
  }
  test("ENOTDIR é legitimo como nível inexistente (não recusa por isso)", () => {
    const f = fsSoLeitura({
      lstatSync: (p) => {
        if (path.normalize(p) === path.normalize(path.join(RAIZ, "api"))) throw Object.assign(new Error("nope"), { code: "ENOTDIR" });
        return { isSymbolicLink: () => false };
      },
    });
    assert.equal(validarArranqueApi({ entrypoint: SRC_ENTRY, env: ENV_DEV, fsLike: f }).modo, "dev");
  });
  test("recusa quando o PRÓPRIO ficheiro da DB é um link", () => {
    const f = fsSoLeitura({ lstatSync: (p) => ({ isSymbolicLink: () => path.normalize(p) === path.normalize(DB_RAIZ) }) });
    assert.throws(() => validarArranqueApi({ entrypoint: SRC_ENTRY, env: ENV_DEV, fsLike: f }), (e) => e.code === ERRO_ISOLAMENTO);
  });
});

describe("identificarModo — produção é dita, não deduzida", () => {
  test('só NODE_ENV="production" declara produção', () => {
    assert.equal(identificarModo({ entrypoint: DIST_ENTRY, env: ENV_PRODUCAO }).modo, "producao");
  });
  test("node dist/index.js SEM nada declarado NÃO é produção", () => {
    assert.equal(identificarModo({ entrypoint: DIST_ENTRY, env: {} }).modo, "nao_declarado");
  });
  test('NODE_ENV="test" não é produção nem dev', () => {
    assert.equal(identificarModo({ entrypoint: DIST_ENTRY, env: { NODE_ENV: "test" } }).modo, "nao_declarado");
  });
  test("marker de isolamento declara DEV mesmo a correr de dist", () => {
    assert.equal(identificarModo({ entrypoint: DIST_ENTRY, env: { CYBERSAFE_DEV_ISOLATION: "1" } }).modo, "dev");
  });
  test("entrada .ts (tsx/npm run dev) declara DEV", () => {
    assert.equal(identificarModo({ entrypoint: SRC_ENTRY, env: {} }).modo, "dev");
  });
});

describe("validarArranqueApi — DEV recusa antes de qualquer I/O mutável", () => {
  const recusas = [
    ["DEV sem DB_PATH", { CYBERSAFE_DEV_ROOT: RAIZ, CYBERSAFE_API_PORT: "4100" }],
    ["DEV sem DEV_ROOT", { CYBERSAFE_DB_PATH: DB_RAIZ, CYBERSAFE_API_PORT: "4100" }],
    ["DEV sem porta", { CYBERSAFE_DEV_ROOT: RAIZ, CYBERSAFE_DB_PATH: DB_RAIZ }],
    ["DEV na porta 4000 da instalação", { ...ENV_DEV, CYBERSAFE_API_PORT: "4000" }],
    ["DEV em porta abaixo do piso", { ...ENV_DEV, CYBERSAFE_API_PORT: "3000" }],
    ["DEV com porta não numérica", { ...ENV_DEV, CYBERSAFE_API_PORT: "auto" }],
    ["DEV com DB_PATH relativa", { ...ENV_DEV, CYBERSAFE_DB_PATH: "rel/db.sqlite" }],
    ["DEV com DB_PATH fora da raiz", { ...ENV_DEV, CYBERSAFE_DB_PATH: path.join(TMP_REAL, "cs-a1-fora", "x.db") }],
    ["DEV com DB_PATH = DB pessoal", { ...ENV_DEV, CYBERSAFE_DB_PATH: PESSOAL }],
    ["DEV com raiz relativa", { ...ENV_DEV, CYBERSAFE_DEV_ROOT: "rel/raiz" }],
    ["modo não declarado (node dist sem env)", { entrypoint: DIST_ENTRY, env: {} }],
    ["modo não declarado (NODE_ENV=test)", { entrypoint: DIST_ENTRY, env: { NODE_ENV: "test" } }],
  ];
  for (const [nome, extra] of recusas) {
    test(`recusa: ${nome}`, () => {
      const f = fsSoLeitura();
      const env = extra.env ?? { CYBERSAFE_DEV_ISOLATION: "1", ...extra };
      const entrypoint = extra.entrypoint ?? SRC_ENTRY;
      assert.throws(
        () => validarArranqueApi({ entrypoint, env, fsLike: f }),
        (e) => e.code === ERRO_ISOLAMENTO && /^ISOLAMENTO RECUSADO:/.test(e.message),
        `tinha de recusar: ${nome}`,
      );
      assert.deepEqual(f.escritas, [], "uma recusa não pode produzir I/O mutável");
    });
  }

  test("recusa junction nos ancestrais da RAIZ", () => {
    const f = fsSoLeitura({ lstatSync: (p) => ({ isSymbolicLink: () => path.normalize(p) !== path.normalize(RAIZ) }) });
    assert.throws(() => validarArranqueApi({ entrypoint: SRC_ENTRY, env: ENV_DEV, fsLike: f }), (e) => e.code === ERRO_ISOLAMENTO);
  });

  test("recusa junction num ancestral INTERIOR da raiz, entre raiz e ficheiro (o buraco de B2)", () => {
    // `raiz/api` é symlink/junction para fora. A raiz em si está limpa: só a cadeia até ao
    // ficheiro apanha isto. É o caso que a validação só-da-raiz deixava passar.
    const f = fsSoLeitura({
      lstatSync: (p) => ({ isSymbolicLink: () => path.normalize(p) === path.normalize(path.join(RAIZ, "api")) }),
    });
    assert.throws(() => validarArranqueApi({ entrypoint: SRC_ENTRY, env: ENV_DEV, fsLike: f }), (e) => e.code === ERRO_ISOLAMENTO);
    assert.deepEqual(f.escritas, []);
  });

  test("recusa quando o realpath do diretório da DB cai fora da raiz real", () => {
    const f = fsSoLeitura({
      realpathSync: (p) => (String(p).startsWith(path.join(RAIZ, "api")) ? path.join(TMP_REAL, "cs-a1-escapada") : p),
    });
    assert.throws(() => validarArranqueApi({ entrypoint: SRC_ENTRY, env: ENV_DEV, fsLike: f }), (e) => e.code === ERRO_ISOLAMENTO);
  });

  test("recusa raiz cujo realpath difere do léxico", () => {
    const f = fsSoLeitura({ realpathSync: (p) => (path.normalize(p) === path.normalize(RAIZ) ? RAIZ + "-outra" : p) });
    assert.throws(() => validarArranqueApi({ entrypoint: SRC_ENTRY, env: ENV_DEV, fsLike: f }), (e) => e.code === ERRO_ISOLAMENTO);
  });

  test("prefixo textual enganoso não é contenção (`cs-a1-raiz-evil`)", () => {
    assert.throws(
      () => validarArranqueApi({ entrypoint: SRC_ENTRY, env: { ...ENV_DEV, CYBERSAFE_DB_PATH: RAIZ + "-evil/x.db" }, fsLike: fsSoLeitura() }),
      (e) => e.code === ERRO_ISOLAMENTO,
    );
  });

  test("ACEITA DEV legítimo: TEMP dentro do perfil do utilizador não é motivo de recusa", () => {
    const saida = validarArranqueApi({ entrypoint: SRC_ENTRY, env: ENV_DEV, fsLike: fsSoLeitura() });
    assert.equal(saida.modo, "dev");
    assert.equal(saida.dbPath, DB_RAIZ);
    assert.equal(saida.porta, 4100);
    assert.ok(saida.dbPath.startsWith(RAIZ + path.sep));
  });
});

describe("validarArranqueApi — produção EXPLÍCITA preservada (resolução pura, nunca em processo)", () => {
  test('produção explícita sem DB_PATH conserva o default de sempre', () => {
    const f = fsSoLeitura();
    const saida = validarArranqueApi({ entrypoint: DIST_ENTRY, env: ENV_PRODUCAO, fsLike: f });
    assert.equal(saida.modo, "producao");
    assert.equal(saida.dbPath, PESSOAL, "o instalador conta com este caminho; não mudamos a semântica");
    assert.equal(saida.porta, 4000, "a porta de produção não muda");
    assert.deepEqual(f.escritas, [], "resolver não pode tocar no disco");
  });
  test("produção explícita com DB do produto usa exatamente esse caminho", () => {
    const dbProduto = path.join(TMP_REAL, "cs-a1-prod", "cybersafe.db");
    const saida = validarArranqueApi({ entrypoint: DIST_ENTRY, env: { ...ENV_PRODUCAO, CYBERSAFE_DB_PATH: dbProduto }, fsLike: fsSoLeitura() });
    assert.equal(saida.dbPath, dbProduto);
  });
  test("produção explícita com porta do instalador é respeitada", () => {
    assert.equal(validarArranqueApi({ entrypoint: DIST_ENTRY, env: { ...ENV_PRODUCAO, CYBERSAFE_API_PORT: "5312" }, fsLike: fsSoLeitura() }).porta, 5312);
  });
  test("o validador é puro nos dois modos", () => {
    const f = fsSoLeitura();
    validarArranqueApi({ entrypoint: DIST_ENTRY, env: ENV_PRODUCAO, fsLike: f });
    validarArranqueApi({ entrypoint: SRC_ENTRY, env: ENV_DEV, fsLike: f });
    assert.deepEqual(f.escritas, []);
  });
});

/**
 * B3 do review: um fsLike num helper puro não prova que `db.ts`/`index.ts` não escrevem ANTES da
 * guarda. Estas provas correm PROCESSOS REAIS e observam o sistema de ficheiros: é o import que
 * criava a pasta e abria a base de dados, e é o import que tem de rebentar com tudo intacto.
 */
const DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));
function correrFicheiroDist(modulo, env) {
  return spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import('./${modulo}'); if (m.DATABASE_FILE_PATH) process.stdout.write(m.DATABASE_FILE_PATH); process.exit(0);`], {
    cwd: DIST_DIR, env: { ...process.env, ...env }, encoding: "utf8", timeout: 40000,
  });
}

describe("integração real — o import não escreve nada quando recusa", () => {
  test("DEV com DB fora da raiz: exit≠0, raiz VAZIA, ficheiro algum criado", () => {
    const base = fs.mkdtempSync(path.join(TMP_REAL, "cs-a1-wire-"));
    const raiz = path.join(base, "raiz");
    fs.mkdirSync(raiz);
    const r = correrFicheiroDist("db.js", {
      NODE_ENV: "", CYBERSAFE_DEV_ISOLATION: "1", CYBERSAFE_DEV_ROOT: raiz,
      CYBERSAFE_DB_PATH: path.join(base, "fora.db"), CYBERSAFE_API_PORT: "4100",
    });
    assert.notEqual(r.status, 0, "o import tinha de falhar");
    assert.match(r.stderr, /ISOLAMENTO RECUSADO:/, `stderr sem recusa: ${String(r.stderr).slice(0, 240)}`);
    assert.deepEqual(fs.readdirSync(raiz), [], "a recusa não pode criar nada dentro da raiz DEV");
    assert.equal(fs.existsSync(path.join(base, "fora.db")), false);
    fs.rmSync(base, { recursive: true, force: true });
  });

  test("index.js (lifecycle + listen) não escreve nem escuta com DEV incompleto", () => {
    const base = fs.mkdtempSync(path.join(TMP_REAL, "cs-a1-idx-"));
    const raiz = path.join(base, "raiz");
    fs.mkdirSync(raiz);
    const r = spawnSync(process.execPath, ["index.js"], {
      cwd: DIST_DIR, encoding: "utf8", timeout: 40000,
      env: { ...process.env, NODE_ENV: "", JWT_SECRET: "a1-teste-apenas", CYBERSAFE_DEV_ISOLATION: "1", CYBERSAFE_DEV_ROOT: raiz, CYBERSAFE_API_PORT: "4100" },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ISOLAMENTO RECUSADO:/);
    assert.deepEqual(fs.readdirSync(raiz), [], "o registo de startup não pode ser escrito antes da validação");
    assert.doesNotMatch(String(r.stdout), /listening/i, "não pode chegar ao listener");
    fs.rmSync(base, { recursive: true, force: true });
  });

  test("modo não declarado num `node dist/index.js` também recusa (default-deny)", () => {
    const base = fs.mkdtempSync(path.join(TMP_REAL, "cs-a1-nao-"));
    const raiz = path.join(base, "raiz");
    fs.mkdirSync(raiz);
    // Redireciono o perfil do filho para a base temporária: se a guarda falhar, o teste prova
    // isso SEM tocar no `%USERPROFILE%` real desta máquina — o risco que originou o packet.
    const env = {
      ...process.env, HOME: base, USERPROFILE: base, HOMEDRIVE: base, HOMEPATH: base,
      JWT_SECRET: "a1-teste-apenas", NODE_ENV: "", CYBERSAFE_DB_PATH: "", CYBERSAFE_DEV_ROOT: "", CYBERSAFE_API_PORT: "4199",
    };
    const r = spawnSync(process.execPath, ["index.js"], { cwd: DIST_DIR, env, encoding: "utf8", timeout: 40000 });
    assert.notEqual(r.status, 0, String(r.stderr).slice(0, 240));
    assert.match(r.stderr, /ISOLAMENTO RECUSADO:/);
    assert.equal(fs.existsSync(path.join(base, ".cybersafe-service")), false,
      "sem a guarda o processo teria criado o perfil pessoal do serviço");
    fs.rmSync(base, { recursive: true, force: true });
  });

  test("POSITIVO: DEV bem configurado abre a DB DENTRO de diretório temporário dedicado", () => {
    const base = fs.mkdtempSync(path.join(TMP_REAL, "cs-a1-ok-"));
    const raiz = path.join(base, "raiz");
    fs.mkdirSync(raiz);
    const db = path.join(raiz, "api", "cybersafe-test.db");
    const r = correrFicheiroDist("db.js", {
      NODE_ENV: "", CYBERSAFE_DEV_ISOLATION: "1", CYBERSAFE_DEV_ROOT: raiz, CYBERSAFE_DB_PATH: db, CYBERSAFE_API_PORT: "4100",
    });
    assert.equal(r.status, 0, `positivo falhou: ${String(r.stderr).slice(0, 300)}`);
    assert.equal(r.stdout.trim(), db);
    assert.ok(fs.existsSync(db), "a DB do teste tinha de ser criada dentro da raiz");
    fs.rmSync(base, { recursive: true, force: true });
  });
});
