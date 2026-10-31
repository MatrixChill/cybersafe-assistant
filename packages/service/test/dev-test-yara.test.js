/**
 * TP-A4-FINAL-20261020 — resolutor do corpus YARA de TESTE (dev-test-yara.ts).
 *
 * Fronteira: a deteção positiva tinha de deixar de depender da cadeia EICAR, que o
 * antivírus do host remove da raiz de teste de forma intermitente (medido a 20/10).
 * Só é seguro se um corpus de ferramenta NUNCA puder ser lido como corpus de produção
 * por engano — por isso não é um `if (env)` direto: cada recusa abaixo tem de ser provada
 * com um CÓDIGO próprio. Uma asserção que aceite «qualquer throw» não testa nada: foi
 * exatamente assim que este ficheiro apanhou o stub a passar verde.
 *
 * Reutilização da validação REAL que já existe no produto (não reinventada):
 *  - `installDevFixtureGate` / `fixtureRootFromEnv` / `estaContido` de `dev-fixture-gate.js`
 *    — a mesma contenção por `path.relative`, o mesmo `realpath`, a mesma proibição de
 *    reparse em ancestrais, e o mesmo `readOnly` FORÇADO no ScanManager.
 *  - a prova de gate montado é a IDENTIDADE do wrapper registado pelo próprio módulo de
 *    instalação (`gateDeFixtureMontadoPara`). Um booleano vindo do renderer não prova nada, e
 *    o texto da função também não: `scanManagerComWrapper()` abaixo é exatamente o wrapper
 *    artesanal que a prova antiga aceitava e que hoje tem de ser recusado.
 *  - o corpus é o canónico byte a byte (`DEV_TEST_YARA_CANONICO`), para além da forma.
 *
 * Não precisa de Electron nem de GUI.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  resolverCorpusYara,
  DEV_TEST_YARA_ENV,
  DEV_TEST_YARA_CODE,
  DEV_TEST_YARA_CANONICO,
  DEV_TEST_YARA_CANONICO_SHA256,
  DEV_TEST_YARA_REGRA,
  DEV_TEST_YARA_MARCA,
  RECUSA,
} from "../dist/dev-test-yara.js";
import { installDevFixtureGate, FIXTURE_SCAN_FLAG, FIXTURE_ROOT_ENV } from "../dist/dev-fixture-gate.js";

const BASE = "C:/base-de-producao";
const DEFINICOES = path.join(BASE, "definitions");
const CORPUS_PRODUCAO = path.join(DEFINICOES, "yara", "default.yar");
const NOME_REGRA = DEV_TEST_YARA_REGRA;
const MARCA = DEV_TEST_YARA_MARCA;
/** Como a regra canónica é escrita em disco: byte a byte a constante do módulo. */
const CANONICO = DEV_TEST_YARA_CANONICO;
/** O corpus de ferramenta que a sessão de fixture usa (fora do repositório de produto). */
const YAR_FERRAMENTA =
  process.env.CYBERSAFE_A4_TOOLING_YAR ||
  "C:/Users/caioc/.cybersafe-integration/realdev-qoder-20261019/runner/definitions/dev-canary.yar";

/** `fs` espionado: conta acessos e permite injetar falhas, sem tocar no disco. */
function fsEspiao(override = {}) {
  const acessos = [];
  const embrulho = (nome, fn) => (...args) => {
    acessos.push(`${nome}:${args[0]}`);
    if (override && nome in override) return override[nome](...args);
    return fn(...args);
  };
  const rp = (p) => (realFs.realpathSync.native ? realFs.realpathSync.native(p) : realFs.realpathSync(p));
  return {
    acessos,
    existsSync: embrulho("existsSync", realFs.existsSync),
    lstatSync: embrulho("lstatSync", realFs.lstatSync),
    statSync: embrulho("statSync", realFs.statSync),
    readFileSync: embrulho("readFileSync", realFs.readFileSync),
    realpathSync: Object.assign(embrulho("realpathSync", rp), { native: embrulho("realpathSync.native", rp) }),
  };
}

/**
 * Variantes de corpus. O caso válido é o canónico; os negativos de FORMA continuam a ser
 * escritos à mão (é a forma que testam). O negativo de IDENTIDADE é o `literal_trocado`:
 * tem a forma certa — uma regra, o nome certo, sem `include` — e só difere nos bytes, que é
 * exatamente o que a validação de forma sozinha não apanhava.
 */
function corpusYara(variante) {
  const regra = (nome) => `rule ${nome}\n{\n  strings:\n    $c = "${MARCA}" ascii\n  condition:\n    $c\n}\n`;
  if (variante === "vazio") return "// sem regra nenhuma\n";
  if (variante === "duas") return CANONICO + regra("CyberSafe_Segunda_Regra");
  if (variante === "nome_errado") return regra("Outra_Coisa_Qualquer");
  if (variante === "include") return `include "outro.yar"\n` + CANONICO;
  if (variante === "syntax_erro") return `rule ${NOME_REGRA}\n{\n  strings:\n    $c = "x" ascii\n  condition:\n    $c &&& \n}\n`;
  if (variante === "literal_trocado") return CANONICO.replace(MARCA, "OUTRO-LITERAL-DE-OUTRA-COISA");
  if (variante === "espaco_a_mais") return CANONICO + "\n";
  if (variante === "escondida_em_comentario") return CANONICO + "/* rule CyberSafe_Escondida { condition: true } */\n";
  return CANONICO;
}

/** Raiz de DEV + raiz de fixture reais em TEMP, construídas por este teste (nunca perfil pessoal). */
function montarPiso(opts = {}) {
  const semente = crypto.randomBytes(6).toString("hex");
  const tmp = realFs.realpathSync(os.tmpdir());
  const devRoot = path.join(tmp, `a4-dev-${semente}`);
  const fixtureRoot = path.join(tmp, `a4-fix-${semente}`);
  for (const p of ["service", "electron-user-data", path.join("yara")]) realFs.mkdirSync(path.join(devRoot, p), { recursive: true });
  realFs.mkdirSync(fixtureRoot, { recursive: true });
  const corpus = path.join(devRoot, "yara", "dev-canary.yar");
  realFs.writeFileSync(corpus, corpusYara(opts.corpus || "valido"));

  const env = {
    NODE_ENV: "development",
    CYBERSAFE_DEV_ISOLATION: "1",
    [FIXTURE_SCAN_FLAG]: "1",
    [FIXTURE_ROOT_ENV]: fixtureRoot,
    CYBERSAFE_DEV_ROOT: devRoot,
    CYBERSAFE_DEV_SERVICE_DIR: path.join(devRoot, "service"),
    CYBERSAFE_DEV_USER_DATA_DIR: path.join(devRoot, "electron-user-data"),
    CYBERSAFE_DEV_PIPE_NAME: `\\\\.\\pipe\\cybersafe-dev-run-${semente}`,
    [DEV_TEST_YARA_ENV]: corpus,
  };
  for (const k of opts.envOff || []) delete env[k];
  if (opts.nodeEnv !== undefined) env.NODE_ENV = opts.nodeEnv;
  if (opts.devRootFora) env.CYBERSAFE_DEV_ROOT = path.join(tmp, "nao_existe_" + semente);
  const cleanup = () => { for (const p of [devRoot, fixtureRoot]) { try { realFs.rmSync(p, { recursive: true, force: true }); } catch {} } };
  return { env, devRoot, fixtureRoot, corpus, cleanup };
}

/**
 * ScanManager com o gate de fixture REALMENTE montado por `dev-fixture-gate`.
 *
 * É o único piso que autoriza: a prova passou a ser a identidade do wrapper registado pelo
 * módulo de instalação, não o texto da função. Por isso os casos positivos têm de instalar.
 */
function servicoComGate(piso) {
  class SM { async startScan() { return "scan"; } }
  const scanManager = new SM();
  const service = { handleRequest: async () => ({ ok: true }), scanManager, quarantinePolicy: "warn" };
  const montado = installDevFixtureGate(service, piso.env, () => {});
  return { scanManager, montado };
}

/** Wrapper com `readOnly` no texto mas NÃO instalado pelo módulo: hoje é o negativo, não o piso. */
function scanManagerComWrapper() {
  class SM { async startScan() { return "scan"; } }
  const sm = new SM();
  const original = sm.startScan.bind(sm);
  sm.startScan = (type, target, options) => original(type, target, { ...(options || {}), readOnly: true });
  return sm;
}

function optsDe(piso, fs_, scanManager) {
  const sm = scanManager || servicoComGate(piso).scanManager;
  return { env: piso.env, definitionsDir: DEFINICOES, scanManager: sm, fsLike: fs_ || fsEspiao() };
}

/** Exige o CÓDIGO de recusa exato — não «qualquer throw». */
const recusa = (opts, codigo, detalhe) => assert.rejects(
  () => resolverCorpusYara(opts),
  (e) => {
    assert.ok(
      String(e.message).includes(`${DEV_TEST_YARA_CODE}:${codigo}`),
      `esperava ${DEV_TEST_YARA_CODE}:${codigo}, obtive: ${e.message}`,
    );
    if (detalhe) {
      // Distingue QUEM recusou. Sem isto, um guarda removido passa a Verde porque uma
      // defesa redundante mais á frente recusa o mesmo caso com outro motivo.
      assert.ok(String(e.message).includes(detalhe), `esperava o motivo «${detalhe}», obtive: ${e.message}`);
    }
    return true;
  },
);

// ————— 1) env ausente = produção, byte a byte, e ZERO I/O novo —————
test("env ausente devolve exatamente o caminho de produção usado hoje, sem tocar no disco", async () => {
  const piso = montarPiso();
  try {
    const fs_ = fsEspiao();
    const semEnv = { ...piso.env };
    delete semEnv[DEV_TEST_YARA_ENV];
    const decisao = await resolverCorpusYara({ env: semEnv, definitionsDir: DEFINICOES, scanManager: {}, fsLike: fs_ });
    assert.equal(decisao.path, CORPUS_PRODUCAO, "produção não pode apontar para outro ficheiro");
    assert.equal(decisao.origem, "producao");
    assert.deepEqual(fs_.acessos, [], `env ausente não pode aceder ao disco: ${JSON.stringify(fs_.acessos)}`);
  } finally { piso.cleanup(); }
});

test("env vazio conta como ausente (produção inalterada)", async () => {
  const piso = montarPiso();
  try {
    const fs_ = fsEspiao();
    piso.env[DEV_TEST_YARA_ENV] = "";
    const decisao = await resolverCorpusYara({ ...optsDe(piso, fs_), scanManager: {} });
    assert.equal(decisao.path, CORPUS_PRODUCAO);
    assert.deepEqual(fs_.acessos, []);
  } finally { piso.cleanup(); }
});

// ————— 2) env sozinho NÃO autoriza —————
test("sem NODE_ENV=development explícito é recusado", async () => {
  const piso = montarPiso({ envOff: ["NODE_ENV"] });
  try { recusa(optsDe(piso), RECUSA.MODO); } finally { piso.cleanup(); }
});

test("NODE_ENV=production é recusado MESMO com todas as outras flags e wrapper instalado", async () => {
  const piso = montarPiso({ nodeEnv: "production" });
  try {
    const fs_ = fsEspiao();
    await recusa(optsDe(piso, fs_, scanManagerComWrapper()), RECUSA.PRODUCAO);
    assert.ok(!fs_.acessos.some((a) => String(a).includes(piso.corpus)), "production não pode ler o corpus de teste");
  } finally { piso.cleanup(); }
});

test("sem CYBERSAFE_DEV_ISOLATION=1 é recusado", async () => {
  const piso = montarPiso({ envOff: ["CYBERSAFE_DEV_ISOLATION"] });
  try { recusa(optsDe(piso), RECUSA.ISOLAMENTO); } finally { piso.cleanup(); }
});

test("raiz de DEV declarada mas inexistente é recusada (isolamento verificado, não afirmado)", async () => {
  const piso = montarPiso({ devRootFora: true });
  try { recusa(optsDe(piso), RECUSA.ISOLAMENTO); } finally { piso.cleanup(); }
});

test("perfis fora da raiz de DEV são recusados (service dir e userData têm de estar contidos)", async () => {
  const piso = montarPiso();
  try {
    piso.env.CYBERSAFE_DEV_USER_DATA_DIR = path.join(realFs.realpathSync(os.tmpdir()), "outro_sitio");
    await recusa(optsDe(piso), RECUSA.PERFIS);
  } finally { piso.cleanup(); }
});

test("pipe que não é do run isolado é recusado", async () => {
  const piso = montarPiso();
  try {
    piso.env.CYBERSAFE_DEV_PIPE_NAME = "\\\\.\\pipe\\cybersafe-service";
    await recusa(optsDe(piso), RECUSA.PIPE);
  } finally { piso.cleanup(); }
});

// ————— 3) gate de fixture EFETIVAMENTE montado, com a validação real —————
test("gate de fixture não montado é recusado (sem wrapper readOnly no ScanManager)", async () => {
  const piso = montarPiso();
  try {
    const fs_ = fsEspiao();
    await recusa(optsDe(piso, fs_, new (class { async startScan() { return "scan"; } })()), RECUSA.GATE);
    assert.ok(!fs_.acessos.some((a) => String(a).includes(piso.corpus)), "gate ausente não pode ler o corpus");
  } finally { piso.cleanup(); }
});

test("wrapper artesanal com readOnly no texto NÃO é o gate: recusado com o código do gate", async () => {
  const piso = montarPiso();
  try {
    const fs_ = fsEspiao();
    // Esta é a função que a prova antiga (ler o texto à procura de «readOnly») aceitava.
    assert.ok(String(scanManagerComWrapper().startScan).includes("readOnly"), "o piso tem de conter a palavra");
    await recusa(optsDe(piso, fs_, scanManagerComWrapper()), RECUSA.GATE);
    assert.ok(!fs_.acessos.some((a) => String(a).includes(piso.corpus)), "gate falso não pode ler o corpus");
  } finally { piso.cleanup(); }
});

test("com o gate REAL montado e o isolamento provado, aceita o corpus de teste", async () => {
  const piso = montarPiso();
  try {
    const { scanManager, montado } = servicoComGate(piso);
    assert.equal(montado, true, "o gate tem de se montar neste piso para o caso positivo fazer sentido");
    const decisao = await resolverCorpusYara(optsDe(piso, fsEspiao(), scanManager));
    assert.equal(decisao.origem, "dev-test");
    assert.equal(decisao.path, piso.corpus);
    assert.match(decisao.motivo, /gate/, `motivo tem de declarar a prova do gate: ${decisao.motivo}`);
  } finally { piso.cleanup(); }
});

test("config de fixture inválida é recusada pela validação REAL do gate, antes de qualquer leitura", async () => {
  const piso = montarPiso();
  try {
    // O gate recusa montar com root pessoal fora do TEMP (isso é `fixtureRootFromEnv` a fazer
    // o seu trabalho); o resolutor tem de recusar o MESMO cenário sem tocar no corpus.
    class SM { async startScan() { return "scan"; } }
    const service = { handleRequest: async () => ({}), scanManager: new SM(), quarantinePolicy: "warn" };
    const envMau = { ...piso.env, [FIXTURE_ROOT_ENV]: path.join(os.homedir(), "Downloads") };
    assert.throws(() => installDevFixtureGate(service, envMau, () => {}), /realdev_fixture_gate/);

    const fs_ = fsEspiao();
    piso.env[FIXTURE_ROOT_ENV] = path.join(os.homedir(), "Downloads");
    await recusa(optsDe(piso, fs_, scanManagerComWrapper()), RECUSA.FIXTURE);
    assert.ok(!fs_.acessos.some((a) => String(a).includes(piso.corpus)), "fixture inválida não pode ler o corpus");
  } finally { piso.cleanup(); }
});

test("sem CYBERSAFE_REALDEV_FIXTURE_SCAN=1 é recusado", async () => {
  const piso = montarPiso({ envOff: [FIXTURE_SCAN_FLAG] });
  try { recusa(optsDe(piso), RECUSA.FIXTURE); } finally { piso.cleanup(); }
});

// ————— 4) validação do CAMINHO, antes de qualquer load —————
test("recusa caminho relativo", async () => {
  const piso = montarPiso();
  try {
    const o = optsDe(piso); o.env[DEV_TEST_YARA_ENV] = "yara/dev-canary.yar";
    await recusa(o, RECUSA.CAMINHO);
  } finally { piso.cleanup(); }
});

test("recusa caminho fora da raiz de DEV aprovada", async () => {
  const piso = montarPiso();
  try {
    const fora = path.join(realFs.realpathSync(os.tmpdir()), `a4_fora_${Date.now()}.yar`);
    realFs.writeFileSync(fora, corpusYara("valido"));
    const o = optsDe(piso); o.env[DEV_TEST_YARA_ENV] = fora;
    const fs_ = o.fsLike;
    await recusa(o, RECUSA.CAMINHO);
    realFs.rmSync(fora, { force: true });
  } finally { piso.cleanup(); }
});

test("recusa caminho dentro do diretório de definições de produção", async () => {
  const piso = montarPiso();
  try {
    const dentro = path.join(DEFINICOES, "yara", "dev-canary.yar");
    const o = optsDe(piso, fsEspiao());
    o.env[DEV_TEST_YARA_ENV] = dentro;
    await recusa(o, RECUSA.CORPUS_PRODUCAO);
    assert.ok(!o.fsLike.acessos.some((a) => String(a).includes(dentro)), `nunca pode ler dentro do corpus de produção: ${JSON.stringify(o.fsLike.acessos)}`);
  } finally { piso.cleanup(); }
});

test("recusa symlink no próprio ficheiro", async (t) => {
  const piso = montarPiso();
  try {
    // Determinístico: um `lstat` que declara link tem de ser recusado como reparse, que o
    // host permita criar links reais ou não — um `return` silencioso seria um verde falso.
    const fs_ = fsEspiao({
      lstatSync: (q) => (String(q) === piso.corpus
        ? { isSymbolicLink: () => true, isFile: () => false, size: 100 }
        : realFs.lstatSync(q)),
    });
    await recusa(optsDe(piso, fs_), RECUSA.REPARSE);

    const link = path.join(piso.devRoot, "yara", "link.yar");
    try { realFs.symlinkSync(piso.corpus, link, "file"); } catch (e) { t.skip(`symlink real indisponível neste host: ${e.code}`); return; }
    const o = optsDe(piso); o.env[DEV_TEST_YARA_ENV] = link;
    await recusa(o, RECUSA.REPARSE);
  } finally { piso.cleanup(); }
});

test("recusa ficheiro ilegível (EACCES) antes do load", async () => {
  const piso = montarPiso();
  try {
    const fs_ = fsEspiao({
      readFileSync: () => { const e = new Error("permission denied"); e.code = "EACCES"; throw e; },
    });
    const o = optsDe(piso, fs_);
    await recusa(o, RECUSA.CAMINHO);
  } finally { piso.cleanup(); }
});

test("recusa ficheiro inexistente", async () => {
  const piso = montarPiso();
  try {
    const o = optsDe(piso);
    o.env[DEV_TEST_YARA_ENV] = path.join(piso.devRoot, "yara", "nao_existe.yar");
    await recusa(o, RECUSA.CAMINHO);
  } finally { piso.cleanup(); }
});

test("recusa corpus maior que o limite (é uma regra de teste, não uma base de assinaturas)", async () => {
  const piso = montarPiso();
  try {
    const gordo = path.join(piso.devRoot, "yara", "gordo.yar");
    realFs.writeFileSync(gordo, corpusYara("valido") + "\n//" + "x".repeat(64 * 1024));
    const o = optsDe(piso); o.env[DEV_TEST_YARA_ENV] = gordo;
    await recusa(o, RECUSA.TAMANHO);
  } finally { piso.cleanup(); }
});

// ————— 5) validação do CONTEÚDO: uma regra, o nome certo, sem include, compila —————
function varianteComRecusa(variante, codigo, detalhe) {
  test(`recusa corpus na variante «${variante}»`, async () => {
    const piso = montarPiso({ corpus: variante });
    try { await recusa(optsDe(piso), codigo, detalhe); } finally { piso.cleanup(); }
  });
}
varianteComRecusa("vazio", RECUSA.CONTEUDO, "regras=0");
varianteComRecusa("duas", RECUSA.CONTEUDO, "regras=2");
varianteComRecusa("nome_errado", RECUSA.CONTEUDO, "nome de regra");
varianteComRecusa("include", RECUSA.CONTEUDO, "contem include");
// A sintaxe so e apanhada pelo compilador: aqui o motivo TEM de vir da sonda, nao da estrutura.
varianteComRecusa("syntax_erro", RECUSA.CONTEUDO, "compilacao/sonda");
// ————— forma certa não é identidade: o pin canónico —————
// `espaco_a_mais` e `escondida_em_comentario` compilam e detetam 1 (a sonda passa), pelo que
// SÓ o pin os recusa — é o que o achado pedia. `literal_trocado` mantém a forma mas sonda 0
// deteções: aqui é a sonda a apanhá-lo, e o pin continua a ser a segunda porta.
varianteComRecusa("literal_trocado", RECUSA.CONTEUDO, "compilacao/sonda");
varianteComRecusa("espaco_a_mais", RECUSA.CONTEUDO, "canonico");
varianteComRecusa("escondida_em_comentario", RECUSA.CONTEUDO, "canonico");

test("a recusa canonica cita o digest observado e o esperado (prova, nao prosa)", async () => {
  const piso = montarPiso({ corpus: "espaco_a_mais" });
  try {
    await assert.rejects(() => resolverCorpusYara(optsDe(piso)), (e) => {
      const observado = crypto.createHash("sha256").update(Buffer.from(corpusYara("espaco_a_mais"), "utf8")).digest("hex").slice(0, 16);
      assert.ok(String(e.message).includes(observado), `digest observado em falta: ${e.message}`);
      assert.ok(String(e.message).includes(DEV_TEST_YARA_CANONICO_SHA256.slice(0, 16)), `digest esperado em falta: ${e.message}`);
      return true;
    });
  } finally { piso.cleanup(); }
});

test("um corpus que compila mas não é o canónico não chega ao motor, ainda que a sonda passe", async () => {
  const piso = montarPiso({ corpus: "escondida_em_comentario" });
  try {
    await assert.rejects(() => resolverCorpusYara(optsDe(piso)), (e) => {
      assert.ok(String(e.message).includes("canonico"), e.message);
      assert.ok(!String(e.message).includes("compilacao/sonda"), "a sonda passou: a recusa tem de vir do pin");
      return true;
    });
  } finally { piso.cleanup(); }
});

test("corpus alterado entre a leitura validada e a decisao e recusado (mudou durante a sonda)", async () => {
  const piso = montarPiso();
  try {
    let leituras = 0;
    const fs_ = fsEspiao({
      readFileSync: () => {
        leituras += 1;
        // A primeira leitura é a que é validada e sondada; a segunda é a re-verificação do
        // caminho antes de entregar ao motor. Trocar o conteúdo nesse meio-tempo tem de doer.
        return leituras === 1 ? CANONICO : CANONICO.replace(MARCA, "LITERAL-INJETADO-ADEPIS");
      },
    });
    await recusa(optsDe(piso, fs_), RECUSA.CONTEUDO, "mudou durante a sonda");
    assert.equal(leituras, 2, "o resolutor tem de reler o caminho depois da sonda");
  } finally { piso.cleanup(); }
});

test("a sonda consome os bytes lidos pelo resolutor, nao uma re-leitura do caminho", async () => {
  // O `fs` injetado reporta o canónico; o ficheiro em disco é outro (não compila). Só faz
  // sentido como prova de origem dos bytes: se a sonda re-lesse `alvo` em vez de usar os
  // bytes que foram validados, este piso morria com `corpus_invalido: compilacao/sonda` — e
  // é exatamente assim que o mutante é apanhado. Em produção `fsLike` É o `node:fs`, pelo
  // que o acesso injetado e o disco são a mesma coisa; o que aqui se testa é a origem.
  const piso = montarPiso({ corpus: "syntax_erro" });
  try {
    const fs_ = fsEspiao({ readFileSync: () => CANONICO });
    const decisao = await resolverCorpusYara(optsDe(piso, fs_));
    assert.equal(decisao.origem, "dev-test", `a sonda tem de usar os bytes validados: ${decisao.motivo}`);
    assert.ok(!/compilacao\/sonda/.test(decisao.motivo));
  } finally { piso.cleanup(); }
});

test("o corpus de ferramenta em disco e o canario canonico, byte a byte", () => {
  // Fixa o ficheiro que a GUI de fixture vai usar: se alguém lhe mexer, o resolutor recusa-o
  // e este teste diz porquê, em vez de deixar um corpus diferente parecer o aprovado.
  assert.ok(realFs.existsSync(YAR_FERRAMENTA), `corpus de ferramenta ausente: ${YAR_FERRAMENTA}`);
  const bytes = realFs.readFileSync(YAR_FERRAMENTA);
  assert.equal(bytes.toString("utf8"), DEV_TEST_YARA_CANONICO, "o corpus de ferramenta nao e o canonico");
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), DEV_TEST_YARA_CANONICO_SHA256);
});

// ————— 6) YARA REAL: o corpus de ferramenta compila e deteta 1 positivo, 0 falsos —————
test("o corpus de ferramenta compila por YARA real e produz exatamente 1 positivo em 3 ficheiros", async () => {
  assert.ok(realFs.existsSync(YAR_FERRAMENTA), `corpus de ferramenta ausente: ${YAR_FERRAMENTA}`);
  const { YaraEngine } = await import("@cybersafe/core");
  const motor = new YaraEngine();
  await motor.load(YAR_FERRAMENTA);
  assert.equal(motor.isAvailable, true, "motor YARA indisponível");

  const piso = montarPiso();
  const raiz = path.join(piso.devRoot, "scan");
  try {
    realFs.mkdirSync(raiz, { recursive: true });
    const positivo = path.join(raiz, "canario.txt");
    const benignoA = path.join(raiz, "benigno-a.txt");
    const benignoB = path.join(raiz, "benigno-b.txt");
    realFs.writeFileSync(positivo, `cabecalho\n${MARCA}\nrodape\n`);
    realFs.writeFileSync(benignoA, "apenas texto benigno de teste\n");
    realFs.writeFileSync(benignoB, "outro conteudo benigno, sem padrao\n");
    for (const p of [benignoA, benignoB]) {
      const m = await motor.scanFile(p);
      assert.equal(m.length, 0, `falso positivo em ${path.basename(p)}: ${JSON.stringify(m)}`);
    }
    const m = await motor.scanFile(positivo);
    assert.equal(m.length, 1, `esperava 1 deteção, obtive ${JSON.stringify(m)}`);
    assert.equal(String(m[0].ruleId), NOME_REGRA, `a deteção tem de vir da regra canária revista: ${JSON.stringify(m[0])}`);
  } finally { piso.cleanup(); }
});

// ————— 7) privacidade: a recusa não ecoa caminhos do perfil nem o valor do env —————
test("mensagem de recusa não inclui caminho do perfil nem o valor do env", async () => {
  const piso = montarPiso({ envOff: ["CYBERSAFE_DEV_ISOLATION"] });
  try {
    await assert.rejects(() => resolverCorpusYara(optsDe(piso)), (e) => {
      const m = String(e.message);
      assert.ok(!m.includes(os.homedir()), `eco do perfil pessoal em: ${m}`);
      assert.ok(!m.includes(piso.corpus), `eco do caminho do corpus em: ${m}`);
      assert.ok(!m.includes(piso.fixtureRoot), `eco do caminho da fixture em: ${m}`);
      return true;
    });
  } finally { piso.cleanup(); }
});

// ————— 8) FIO no engine: o load do arranque passa pelo resolutor e não pode ignorá-lo —————
test("engine.ts do arranque usa o resolutor e não mantém o literal de produção à partida", () => {
  const engine = realFs.readFileSync(new URL("../dist/engine.js", import.meta.url), "utf8");
  assert.match(engine, /resolverCorpusYara/, "o engine tem de chamar o resolutor");
  assert.ok(engine.includes('from "./dev-test-yara.js"'), "o import tem de vir do modulo novo");
  assert.doesNotMatch(
    engine,
    /await this.yara.load(path.join(this.definitionsDir, "yara", "default.yar"))/,
    "o load do arranque não pode continuar a apontar direto ao literal antigo",
  );
  // Ha DOIS load de yara no ficheiro (o reload do updater e o do arranque). A assercao e
  // sobre o sitio do arranque: so ele pode receber o caminho decidido pelo resolutor.
  assert.ok(engine.includes("await this.yara.load(corpusYara.path)"), "o load do arranque tem de usar o caminho decidido pelo resolutor");
  assert.equal(engine.split("await this.yara.load(").length - 1, 2, "esperava exatamente 2 sitios de load (updater + arranque)");
});

test("a decisão de produção é exatamente o caminho que o engine usava antes", async () => {
  const piso = montarPiso();
  try {
    const decisao = await resolverCorpusYara({ env: (() => { const e = { ...piso.env }; delete e[DEV_TEST_YARA_ENV]; return e; })(), definitionsDir: DEFINICOES, scanManager: {}, fsLike: fsEspiao() });
    const engine = realFs.readFileSync(new URL("../dist/engine.js", import.meta.url), "utf8");
    assert.ok(decisao.path.endsWith(path.join("definitions", "yara", "default.yar")));
    assert.equal(decisao.path, path.join(DEFINICOES, "yara", "default.yar"));
    // O caminho que o engine teria hoje, com o mesmo definitionsDir, é o mesmo literal.
  assert.ok(engine.includes('definitionsDir, "yara", "default.yar"'), "a construcao do caminho de producao continua presente para o reload do updater");
  } finally { piso.cleanup(); }
});
