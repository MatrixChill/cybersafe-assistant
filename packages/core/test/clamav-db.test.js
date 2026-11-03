import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

import {
  ClamavBridge,
  classifyClamavHealth,
  selectDatabaseCandidate,
  probeDatabaseDir,
  appClamavDatabaseDir,
  platformClamavDatabaseDir,
  SIGNATURE_MAX_AGE_MS,
  spawnClamav,
} from "../dist/index.js";
import { isLoadProof, makeLoadProofHandle } from "./fixtures/clamav-load-proof.js";

/**
 * P0-B1 — ClamAV signature database.
 *
 * Regressão real (probe de 2026-09-25): `clamav=de degraded` numa máquina com
 * o ClamAV 1.5.2 instalado via Chocolatey. Duas causas distintas, ambas de
 * código:
 *
 *  1. PATH RESOLUTION. O `freshclam` da CyberSafe descarrega as definições
 *     para `<definitions>/clamav` (ver service/src/updater.ts), que não é
 *     necessariamente o directório que o `clamconf` reporta. A implementação
 *     anterior resolvia a base **exclusivamente** por `clamconf -n`, por isso
 *     um ClamAV correctamente populado na base da app era reportado como
 *     degradado para sempre.
 *  2. SCAN SEM --datadir. `scanFile` chamava `clamscan` sem `--datadir`, e o
 *     clamscar carregava o directório compilado do pacote — que não existe
 *     (`LibClamAV Error: cl_load ... database`, exit 2) — mesmo com a base da
 *     app correcta. Não havia deteção nenhuma.
 *
 * Contrato que estes testes fixam: `active` **exige** ficheiros de assinaturas
 * reais; directório ausente, vazio, ilegível ou com definições envelhecidas dá
 * `degraded`/`unavailable` com diagnóstico accionável. Nunca `active` por
 * omissão.
 */

const DAY = 24 * 60 * 60 * 1000;
const VERSION_OK = "ClamAV 1.5.2\n";
const run = promisify(execFile);

/**
 * Detecção síncrona do binário: os testes que dependem do clamscan real são
 * `skip`ped quando não existe, em vez de passarem a fingir cobertura.
 */
const CLAMSCAN_AVAILABLE = (() => {
  try {
    const r = spawnSync("clamscan", ["--version"], { timeout: 5000, windowsHide: true, encoding: "utf-8" });
    return r.status === 0 && String(r.stdout ?? "").includes("ClamAV");
  } catch {
    return false;
  }
})();

/**
 * O spawner de PRODUÇÃO, com a PROVA DE CARGA respondida pelo harness.
 *
 * Os dois casos abaixo querem provar outra coisa: que uma base de ficheiros
 * FALSOS (`main.cvd` com 1 byte) que o clamscan real recusa carregar (exit 2,
 * `cl_load`) faz o motor descer a `degraded` com diagnóstico. Desde 3a95692 o
 * `active` exige uma corrida de carga positiva, e essa corrida spawna pelo
 * mesmo seam — com a base falsa, a prova falha ANTES do scan e `active` fica
 * inalcançável, o que tornaria o caso impossível de exercitar.
 *
 * A resposta à prova é o único atalho: o SCAN continua real (mesmo
 * `spawnClamav`, mesma base falsa, mesmo exit 2, mesma degradação observada).
 * Não se afrouxa nenhuma asserção — só se deixa de medir a prova no lugar do
 * scan.
 */
function scanRealComProvaRespondida() {
  return (file, args, request) => (isLoadProof(request) ? makeLoadProofHandle() : spawnClamav(file, args, request));
}

let tmp;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cs-clamav-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/** Directório com ficheiros de assinatura de mtime controlada. */
async function makeDb(dir, files, { ageDays = 0 } = {}) {
  await fs.mkdir(dir, { recursive: true });
  for (const name of files) {
    const file = path.join(dir, name);
    await fs.writeFile(file, "x");
    if (ageDays > 0) {
      const when = new Date(Date.now() - ageDays * DAY);
      await fs.utimes(file, when, when);
    }
  }
  return dir;
}

const cand = (over) => ({
  dir: "C:\\db",
  source: "clamconf",
  state: "ready",
  signatureFiles: ["main.cvd"],
  newestMtimeMs: Date.now(),
  ...over,
});

const classify = (candidates, extra = {}) =>
  classifyClamavHealth({ versionOutput: VERSION_OK, dbDir: null, dbFiles: null, candidates, ...extra });

describe("probeDatabaseDir — estados reais do directório", () => {
  it("directório inexistente ⇒ missing", async () => {
    const r = await probeDatabaseDir(path.join(tmp, "nao-existe"), "clamconf");
    assert.equal(r.state, "missing");
    assert.deepEqual(r.signatureFiles, []);
    assert.equal(r.newestMtimeMs, 0);
  });

  it("directório vazio ⇒ empty (existe, sem assinaturas)", async () => {
    const dir = path.join(tmp, "vazia");
    await fs.mkdir(dir, { recursive: true });
    const r = await probeDatabaseDir(dir, "app-definitions");
    assert.equal(r.state, "empty");
  });

  it("só ficheiros que não são assinaturas ⇒ empty", async () => {
    const dir = await makeDb(path.join(tmp, "lixo"), ["readme.txt", "notas.md", "daily.cld.tmp"]);
    const r = await probeDatabaseDir(dir, "clamconf");
    assert.equal(r.state, "empty", "só .cvd/.cld/.cuv/.cud contam");
  });

  it("assinaturas presentes ⇒ ready, com o mtime mais recente", async () => {
    const dir = await makeDb(path.join(tmp, "boa"), ["main.cvd", "daily.cld", "notas.txt"]);
    const r = await probeDatabaseDir(dir, "app-definitions");
    assert.equal(r.state, "ready");
    assert.deepEqual(r.signatureFiles.sort(), ["daily.cld", "main.cvd"]);
    assert.ok(r.newestMtimeMs > 0, "tem de apanhar a frescura a partir do disco");
  });

  it("reconhece as quatro extensões de assinatura", async () => {
    for (const name of ["a.cvd", "b.cld", "c.cuv", "d.cud", "E.CVD"]) {
      const dir = await makeDb(path.join(tmp, `e-${name}`), [name]);
      const r = await probeDatabaseDir(dir, "clamconf");
      assert.equal(r.state, "ready", `${name} devia contar como assinatura`);
    }
  });

  it("uma directória chamada *.cvd NÃO conta como base de assinaturas", async () => {
    const dir = path.join(tmp, "com-subdir");
    await fs.mkdir(path.join(dir, "daily.cld"), { recursive: true });
    const r = await probeDatabaseDir(dir, "clamconf");
    assert.equal(r.state, "empty", "subdirectórios não são ficheiros de assinatura");
  });

  it("falha de I/O que não é ENOENT/ENOTDIR ⇒ unreadable (nunca active)", async () => {
    // Um caminho inválido produz um erro que não é "não existe": tem de cair
    // no ramo unreadable em vez de ser silenciosamente tratado como ausente.
    const r = await probeDatabaseDir("C:\\invalido\0path", "clamconf");
    assert.equal(r.state, "unreadable");
    assert.ok(r.error, "o erro tem de ser diagnosticado");
  });

  it("nunca lança, whatever o caminho", async () => {
    for (const bad of ["", "C:\\", "\\\\?\\Z:\\nope", "relative/path"]) {
      await assert.doesNotReject(() => probeDatabaseDir(bad, "clamconf"));
    }
  });
});

describe("selectDatabaseCandidate — prioridade e diagnóstico", () => {
  it("ready ganha a qualquer outro estado", () => {
    const chosen = selectDatabaseCandidate([
      cand({ state: "missing", signatureFiles: [] }),
      cand({ state: "ready" }),
      cand({ state: "empty", signatureFiles: [] }),
    ]);
    assert.equal(chosen.state, "ready");
  });

  it("sem ready, prefere unreadable (permissões) para o diagnóstico", () => {
    const chosen = selectDatabaseCandidate([
      cand({ state: "missing", signatureFiles: [] }),
      cand({ state: "unreadable", error: "EACCES" }),
      cand({ state: "empty", signatureFiles: [] }),
    ]);
    assert.equal(chosen.state, "unreadable");
  });

  it("sem ready nem unreadable, prefere empty sobre missing", () => {
    const chosen = selectDatabaseCandidate([
      cand({ state: "missing", signatureFiles: [] }),
      cand({ state: "empty", signatureFiles: [] }),
    ]);
    assert.equal(chosen.state, "empty");
  });

  it("lista vazia ⇒ null", () => {
    assert.equal(selectDatabaseCandidate([]), null);
  });
});

describe("classifyClamavHealth — active exige assinaturas reais", () => {
  it("binário em falta ⇒ unavailable, mesmo com base pronta", () => {
    const r = classifyClamavHealth({
      versionOutput: null,
      versionError: "not found",
      dbDir: null,
      dbFiles: null,
      candidates: [cand({ state: "ready" })],
    });
    assert.equal(r.health.status, "unavailable");
    assert.equal(r.available, false);
  });

  it("binário que não é ClamAV ⇒ unavailable", () => {
    const r = classifyClamavHealth({
      versionOutput: "GNU bash 5.1",
      dbDir: null,
      dbFiles: null,
      candidates: [cand({ state: "ready" })],
    });
    assert.equal(r.health.status, "unavailable");
  });

  it("ClamAV com base pronta e frescos ⇒ active (o objectivo do fix)", () => {
    const r = classify([
      cand({ state: "missing", signatureFiles: [] }),
      cand({ dir: "C:\\app\\definitions\\clamav", source: "app-definitions", state: "ready", signatureFiles: ["main.cvd", "daily.cld"] }),
    ]);
    assert.equal(r.available, true);
    assert.equal(r.health.status, "active");
    assert.match(r.health.detail, /2 signature database file/);
  });

  it("REGRESSÃO: base da app pronta sobrepõe-se a um clamconf que aponta para o vazio", () => {
    // Este é o defeito reportado: o clamconf diz <pacote choco>\database (que
    // não existe) e a base real é a da app. Antes ⇒ degraded para sempre.
    const r = classify([
      cand({ dir: "C:\\app\\definitions\\clamav", source: "app-definitions", state: "ready", signatureFiles: ["main.cvd", "daily.cld"] }),
      cand({ dir: "C:\\choco\\database", source: "clamconf", state: "missing", signatureFiles: [] }),
    ]);
    assert.equal(r.health.status, "active");
    assert.equal(r.available, true);
  });

  it("nenhum candidato ⇒ degraded, nunca active", () => {
    const r = classify([]);
    assert.equal(r.health.status, "degraded");
    assert.equal(r.available, false);
  });

  it("todos missing ⇒ degraded com os caminhos verificados + freshclam", () => {
    const r = classify([
      cand({ dir: "C:\\a", state: "missing", signatureFiles: [] }),
      cand({ dir: "C:\\b", source: "platform-default", state: "missing", signatureFiles: [] }),
    ]);
    assert.equal(r.health.status, "degraded");
    assert.equal(r.available, false);
    assert.match(r.health.detail, /C:\\a/);
    assert.match(r.health.detail, /C:\\b/);
    assert.match(r.health.detail, /freshclam/i);
  });

  it("directório vazio (caso real desta máquina) ⇒ degraded, diz que está vazio", () => {
    const r = classify([
      cand({ dir: "C:\\app\\definitions\\clamav", source: "app-definitions", state: "empty", signatureFiles: [] }),
      cand({ dir: "C:\\choco\\database", state: "missing", signatureFiles: [] }),
    ]);
    assert.equal(r.health.status, "degraded");
    assert.equal(r.available, false);
    assert.match(r.health.detail, /vazio/);
    assert.match(r.health.detail, /freshclam/i);
  });

  it("base ilegível ⇒ degraded com a causa, não active", () => {
    const r = classify([cand({ state: "unreadable", signatureFiles: [], error: "EACCES" })]);
    assert.equal(r.health.status, "degraded");
    assert.equal(r.available, false);
    assert.match(r.health.detail, /EACCES/);
  });

  it("assinaturas envelhecidas ⇒ degraded com a idade, nunca active", () => {
    const r = classify([cand({ newestMtimeMs: Date.now() - 30 * DAY })]);
    assert.equal(r.health.status, "degraded");
    assert.equal(r.available, false);
    assert.match(r.health.detail, /30 dia\(s\)/);
    assert.match(r.health.detail, /freshclam/i);
  });

  it("assinaturas dentro do limite ⇒ active", () => {
    const r = classify([cand({ signatureFiles: ["main.cvd", "daily.cld"], newestMtimeMs: Date.now() - 2 * DAY })]);
    assert.equal(r.health.status, "active");
  });

  it("mtime desconhecido (0) não penaliza: frescura não é avaliável", () => {
    const r = classify([cand({ signatureFiles: ["main.cvd", "daily.cld"], newestMtimeMs: 0 })]);
    assert.equal(r.health.status, "active");
  });

  it("o limite de idade é configurável", () => {
    const facts = { versionOutput: VERSION_OK, dbDir: null, dbFiles: null };
    const r = classifyClamavHealth({
      ...facts,
      candidates: [cand({ newestMtimeMs: Date.now() - 3 * DAY })],
      maxSignatureAgeMs: DAY,
    });
    assert.equal(r.health.status, "degraded");
  });

  it("now é determinístico (sem Date.now() implícito)", () => {
    const now = Date.UTC(2026, 0, 31);
    const r = classifyClamavHealth({
      versionOutput: VERSION_OK,
      dbDir: null,
      dbFiles: null,
      candidates: [cand({ newestMtimeMs: now - 10 * DAY })],
      now,
    });
    assert.equal(r.health.status, "degraded");
    assert.match(r.health.detail, /10 dia\(s\)/);
  });

  it("active exige ficheiros .cvd/.cld: ready sem assinaturas ⇒ degraded", () => {
    // O que este caso sempre protegeu: `ready` sem NENHUM ficheiro de assinatura
    // não pode dar `active`, e existir um arquivo oficial é o que separa «base
    // oficial» de «assinaturas locais». A completude do CONJUNTO é uma asserção
    // diferente, e passou a ser exigida em 2026-11-01: uma descarga de freshclam
    // interrompida deixa `main.cvd` intacto e perde o `daily`, e esse estado já
    // não é cobertura — não pode ler-se como `active`.
    for (const name of ["main.cvd", "daily.cld", "bytecode.cuv", "bytecode.cud"]) {
      const r = classify([cand({ signatureFiles: [name] })]);
      assert.equal(r.available, true, name);
      assert.notEqual(r.health.status, "unavailable", name);
      assert.ok(!/não tem ficheiros \.cvd\/\.cld/.test(r.health.detail), `${name}: ${r.health.detail}`);
    }
    const completa = classify([cand({ signatureFiles: ["main.cvd", "daily.cld"] })]);
    assert.equal(completa.health.status, "active");
    assert.match(completa.health.detail, /2 signature database file/);
    const semDiaria = classify([cand({ signatureFiles: ["main.cvd"] })]);
    assert.equal(semDiaria.health.status, "degraded", "main sem daily não é conjunto completo");
    assert.match(semDiaria.health.detail, /falta a base diária/);
    // `ready` sem nenhum ficheiro de assinatura não pode dar active.
    const vazio = classify([cand({ signatureFiles: [] })]);
    assert.equal(vazio.available, false);
    assert.equal(vazio.health.status, "degraded");
    assert.match(vazio.health.detail, /freshclam/i);
    // Nem ficheiros que não são assinaturas.
    const lixo = classify([cand({ signatureFiles: ["main.cvd.gz", "config.yaml"] })]);
    assert.equal(lixo.available, false);
    assert.equal(lixo.health.status, "degraded");
  });
});

describe("caminhos de convenção", () => {
  it("a base da app é <definitionsDir>/clamav — igual ao --datadir do updater", () => {
    assert.equal(appClamavDatabaseDir("C:\\svc\\definitions"), path.join("C:\\svc\\definitions", "clamav"));
  });

  it("sem override, aponta para ~/.cybersafe-service/definitions/clamav", () => {
    const expected = path.join(os.homedir(), ".cybersafe-service", "definitions", "clamav");
    assert.equal(appClamavDatabaseDir(), expected);
  });

  it("a localização padrão da plataforma é plausível", () => {
    const dir = platformClamavDatabaseDir();
    assert.ok(dir === null || path.isAbsolute(dir));
  });
});

describe("ClamavBridge — integração com o disco real", () => {
  it("nunca reporta active sem ficheiros de assinatura reais", async () => {
    const bridge = new ClamavBridge({ definitionsDir: path.join(tmp, "definitions") });
    const available = await bridge.isAvailable();
    const h = bridge.health;
    assert.notEqual(h.detail, "Not checked", "o probe tem de correr");
    if (available) {
      assert.equal(h.status, "active");
      assert.ok(bridge.datadir, "active exige um directório de assinaturas escolhido");
    } else {
      assert.ok(["unavailable", "degraded"].includes(h.status), `estado inesperado: ${h.status}`);
      // Motor indisponível nunca simula proteção.
      const res = await bridge.scanFile(import.meta.filename);
      assert.equal(res.detected, false);
    }
  });

  it("usa a base resolvida e reporta o erro de carga (exit 2) sem mentir", { skip: !CLAMSCAN_AVAILABLE }, async () => {
    // Base "pronta" por arquivo mas que o clamscan real não carrega (é o
    // estado real antes do freshclam funcionar). O que interessa: o estado
    // tem de descer a degraded com o diagnóstico, e nunca dizer "active".
    const dir = await makeDb(path.join(tmp, "definitions", "clamav"), ["main.cvd", "daily.cld"]);
    const bridge = new ClamavBridge({
      definitionsDir: path.join(tmp, "definitions"),
      datadir: dir,
      spawn: scanRealComProvaRespondida(),
    });
    await bridge.isAvailable();
    assert.equal(bridge.datadir, dir, "a base explícita tem prioridade máxima");
    assert.equal(bridge.health.status, "active", "assinaturas presentes e frescas no disco ⇒ active");

    const res = await bridge.scanFile(import.meta.filename);
    assert.equal(res.detected, false, "base que não carrega não detecta nada");
    assert.equal(res.status.status, "degraded", "depois de o scan falhar não pode continuar active");
    assert.match(res.status.detail, /clamav/i);
    assert.match(res.status.detail, /cl_load|carregar a base/i);
  });

  it("o resultado do probe é cacheado; force re-executa", async () => {
    const bridge = new ClamavBridge({ definitionsDir: path.join(tmp, "definitions") });
    const a = await bridge.isAvailable();
    const b = await bridge.isAvailable();
    assert.equal(a, b, "sem force o resultado é o mesmo");
    const c = await bridge.isAvailable(true);
    assert.equal(typeof c, "boolean");
  });

  it("scanFile nunca inventa deteção quando não há assinaturas", async () => {
    const dir = path.join(tmp, "definitions", "clamav");
    await fs.mkdir(dir, { recursive: true }); // vazio
    const bridge = new ClamavBridge({ definitionsDir: path.join(tmp, "definitions") });
    const res = await bridge.scanFile(import.meta.filename);
    assert.equal(res.detected, false);
    assert.equal(res.status.status, "degraded");
    assert.equal(res.status.status, bridge.health.status);
  });
});

describe("regressão de compatibilidade do formato legado", () => {  it("o contrato dbDir/dbFiles continua igual (engine-integrity dependia dele)", () => {
    assert.equal(classifyClamavHealth({ versionOutput: null, versionError: "x", dbDir: null, dbFiles: null }).health.status, "unavailable");
    assert.equal(classifyClamavHealth({ versionOutput: VERSION_OK, dbDir: null, dbFiles: null }).health.status, "degraded");
    assert.equal(classifyClamavHealth({ versionOutput: VERSION_OK, dbDir: "C:\\db", dbFiles: null }).health.status, "degraded");

    const semBase = classifyClamavHealth({ versionOutput: VERSION_OK, dbDir: "C:\\db", dbFiles: ["readme.txt"] });
    assert.equal(semBase.available, false);
    assert.match(semBase.health.detail, /sem base de assinaturas.*freshclam/i);

    const comBase = classifyClamavHealth({ versionOutput: VERSION_OK, dbDir: "C:\\db", dbFiles: ["main.cvd", "daily.cld"] });
    assert.equal(comBase.available, true);
    assert.equal(comBase.health.status, "active");
    assert.match(comBase.health.detail, /2 signature database file/);
  });

  it("candidates tem precedência sobre o par legado", () => {
    const r = classifyClamavHealth({
      versionOutput: VERSION_OK,
      dbDir: "C:\\db",
      dbFiles: ["main.cvd"],
      candidates: [cand({ state: "empty", signatureFiles: [] })],
    });
    assert.equal(r.health.status, "degraded", "o par legado diz active, mas a sonda real diz vazio");
  });

  it("o limite por omissão é 7 dias", () => {
    assert.equal(SIGNATURE_MAX_AGE_MS, 7 * DAY);
  });
});

describe("regressão do clamscan — flag e código de saída", () => {
  /**
   * Regressões apanhadas pela sondagem real, não por leitura de código:
   *
   *  1. `--datadir` é opção do FRESHCLAM. O `clamscan` responde
   *     "unrecognized option `--datadir='" e sai com 2 — passá-la fazia o
   *     scan falhar sempre. A opção correcta é `--database=DIR`, que o
   *     clamscan documenta como "Load virus database from FILE or load all
   *     supported db files from DIR".
   *  2. O `promisify(execFile)` rejeita com o exit code em `error.code`;
   *     `error.status` é `undefined`. O código antigo comparava
   *     `error.status === 1`, que nunca era verdade ⇒ uma infeção real
   *     (clamscan exit 1) era reportada como `detected: false`.
   *
   * Estes testes cor clamscan de verdade; se o binário não estiver instalado
   * não há nada a provar, por isso são marcados como skipped — nunca passam
   * a fingir cobertura.
   */
  it("o clamscan rejeita --datadir (opção do freshclam) — daí usarmos --database", { skip: !CLAMSCAN_AVAILABLE }, async () => {
    const file = path.join(tmp, "alvo.txt");
    await fs.writeFile(file, "conteudo");

    let datadirCode;
    try {
      await run("clamscan", ["--no-summary", `--datadir=${tmp}`, file], { timeout: 10000, windowsHide: true });
      datadirCode = 0;
    } catch (e) {
      datadirCode = Number(e?.code ?? e?.status);
    }
    assert.notEqual(datadirCode, 0, "--datadir tem de ser rejeitado pelo clamscan");

    // --database é reconhecido: nunca pode dar "unrecognized option".
    let databaseCode = 0;
    try {
      await run("clamscan", ["--no-summary", `--database=${tmp}`, file], { timeout: 10000, windowsHide: true });
    } catch (e) {
      databaseCode = Number(e?.code ?? e?.status);
      const stderr = String(e?.stderr ?? "");
      assert.doesNotMatch(stderr, /unrecognized option/i, "--database tem de ser uma opção reconhecida");
    }
    assert.notEqual(databaseCode, null);
  });

  it("o exit code chega em error.code — é isso que decide `detected`", { skip: !CLAMSCAN_AVAILABLE }, async () => {
    const file = path.join(tmp, "alvo2.txt");
    await fs.writeFile(file, "conteudo");

    let observed;
    try {
      await run("clamscan", ["--no-summary", `--database=${path.join(tmp, "vazia")}`, file], { timeout: 10000, windowsHide: true });
      observed = { code: 0, status: undefined };
    } catch (e) {
      observed = { code: e?.code, status: e?.status };
    }
    // Se o clamscan falhou, tem de ter sido por `code`. Um `status` undefined
    // é exactamente a razão do falso negativo histórico: `status === 1`
    // nunca era verdadeiro, logo uma infeção real devolvia detected:false.
    if (observed.code !== 0) {
      assert.equal(observed.status, undefined, "se status estivesse definido, a comparação antiga não falhava");
    }
    assert.ok(observed.code !== undefined && observed.code !== null, "o exit tem de ser observável");
  });

  it("scanFile passa --database e o health degrada honestamente se a base não carregar", { skip: !CLAMSCAN_AVAILABLE }, async () => {
    const defs = path.join(tmp, "defs");
    const dir = await makeDb(path.join(defs, "clamav"), ["main.cvd", "daily.cld"]);
    const bridge = new ClamavBridge({
      definitionsDir: defs,
      datadir: dir,
      spawn: scanRealComProvaRespondida(),
    });
    await bridge.isAvailable(true);
    assert.equal(bridge.health.status, "active", "base com assinaturas frescas é active");
    assert.equal(bridge.datadir, dir);

    const res = await bridge.scanFile(path.join(tmp, "inexistente.txt"));
    // Uma base de assinatura falsa não carrega: o estado tem de descer a
    // degraded com diagnóstico, nunca continuar a anunciar "active".
    assert.notEqual(res.status.status, "active", "não pode anunciar active depois de o scan falhar");
    assert.equal(res.detected, false, "base que não carrega não detecta nada");
    assert.ok(res.status.detail && res.status.detail.length > 0, "tem de haver diagnóstico");
  });
});
