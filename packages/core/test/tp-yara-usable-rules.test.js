import { describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  YaraEngine,
  YaraScanError,
  CYBERSAFE_EICAR_POSITIVE_CONTROL_BUFFER,
  CYBERSAFE_EICAR_POSITIVE_CONTROL_RULE,
} from "../dist/yara.js";
import { positiveControlMatchOrSkip } from "./fixtures/yara-av-denial.js";

/**
 * TP-PAP-FREEBUFF-YARA-HASHDB-P0 — regras utilizáveis.
 *
 * ── O defeito que este ficheiro existe para apanhar ────────────────────────
 * `ensureRules()` aceita qualquer texto que contenha `rule ` (verificação
 * textual) e, se o YARA-X compilar, declara `status: "active"`. Mas há corpora
 * que compilam e NÃO têm uma única regra reportável:
 *
 *   - só comentários que mencionam `rule`;
 *   - só regras `private` (o YARA não as inclui nos matches).
 *
 * Nesses casos `ruleCount === 0`, todos os scans devolvem zero matches, e o
 * health dizia `active` — ou seja, "a análise por regras está a correr e não
 * encontrou nada" quando a verdade é "não há regra nenhuma que possa encontrar
 * alguma coisa". É o mesmo defeito de honestidade que o contrato de cobertura
 * já corrigiu para o canário; aqui é o caso degenerado.
 *
 * ── Regra do contrato ──────────────────────────────────────────────────────
 * `active` exige pelo menos uma regra UTILIZÁVEL (reportável). Sem nenhuma, o
 * motor não pode declarar-se activo nem devolver `ok` para um scan — zero
 * regras não é evidência de ficheiro limpo.
 *
 * Nada aqui escreve EICAR em disco: o positivo de controlo é avaliado em
 * memória (`match(buffer)`), e as regras sintéticas usam um token benigno.
 */

const tmpRoots = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-yara-usable-"));
  tmpRoots.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpRoots) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

async function loadEngineWith(content, name = "default.yar", rel = "yara") {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, rel), { recursive: true });
  const file = path.join(dir, rel, name);
  if (content !== null) fs.writeFileSync(file, content, "utf-8");
  const engine = new YaraEngine(file);
  await engine.load(file);
  return { engine, file, dir };
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * `load()` NUNCA reescreve o corpus. Mede o hash do ficheiro antes e depois de
 * `engine.load()`: um corpus sem regras reportáveis (só comentários, só
 * `private`, texto) tem de sair byte-idêntico, mesmo quando o health degrada.
 */
async function loadEngineWithProof(content, name = "default.yar") {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "yara"), { recursive: true });
  const file = path.join(dir, "yara", name);
  if (content !== null) fs.writeFileSync(file, content, "utf-8");
  const before = fs.existsSync(file) ? sha256File(file) : null;
  const engine = new YaraEngine(file);
  await engine.load(file);
  const after = fs.existsSync(file) ? sha256File(file) : null;
  return { engine, file, before, after, dir };
}

/** Regra privada: compila, mas nunca aparece nos resultados do scanner. */
const PRIVATE_ONLY = `
private rule CyberSafe_Interna_Nunca_Reportada
{
  strings:
    $a = "TP_PRIVATE_TOKEN" ascii
  condition:
    $a
}
`;

/** Comentário a mencionar `rule` — passa a verificação textual, não é regra. */
const COMMENT_ONLY = `
// rule CyberSafe_Nao_Existe_So_Comentario
// Este corpus nao declara nenhuma regra.
`;

const SYNTHETIC_CORPUS = `
rule CyberSafe_TP_Synthetic_One
{
  meta:
    description = "Regra sintetica benigna do TP-PAP-FREEBUFF-YARA-HASHDB-P0"
  strings:
    $a = "CYBERSAFE_TP_SYNTHETIC_TOKEN_ONE" ascii
  condition:
    $a
}
`;

/**
 * Zero regras reportáveis não é "scan limpo" nem "motor activo" — e TAMBÉM
 * não autoriza reescrever o corpus. O ficheiro pode conter regras `private`
 * legítimas (helpers), documentação ou trabalho do utilizador: preserva-se
 * byte a byte (hash antes = depois), o health degrada e o scanner fica
 * indisponível — zero regras não é evidência de ficheiro limpo.
 */
describe("TP YARA — zero regras utilizáveis: nunca 'active', nunca reescreve", () => {
  test("corpo só com comentários ⇒ degraded/unknown, ficheiro preservado, sem scanner", async () => {
    const { engine, before, after } = await loadEngineWithProof(COMMENT_ONLY);
    assert.equal(after, before, "load() não pode reescrever o corpus (hash antes = depois)");
    assert.equal(engine.ruleCount, 0, "um comentário não é uma regra");
    assert.equal(engine.health.status, "degraded");
    assert.equal(engine.health.coverage, "unknown", "sem regras não há cobertura a medir");
    assert.equal(engine.isAvailable, false, "sem regra reportável não há scanner utilizável");

    const clean = path.join(tmpdir(), "limpo.txt");
    fs.writeFileSync(clean, "texto benigno sem nada de especial", "utf-8");
    const outcome = await engine.scanFileOutcome(clean);
    assert.notEqual(outcome.status, "ok", "zero regras não pode devolver 'ok' (= limpo)");
    assert.throws(() => engine.match(Buffer.from("texto")), /unavailable/i);
  });

  test("só regras 'private' ⇒ degraded/unknown, ficheiro PRESERVADO (não vira canário)", async () => {
    const { engine, before, after } = await loadEngineWithProof(PRIVATE_ONLY);
    assert.equal(after, before, "um corpus private-only legítimo não pode ser substituído no disco");
    assert.equal(engine.ruleCount, 0, "uma regra private não é reportável");
    assert.equal(engine.health.status, "degraded");
    assert.equal(engine.health.coverage, "unknown");
    assert.match(
      engine.health.detail ?? "",
      /regra|private|utiliz/i,
      "o detalhe tem de explicar que não há regras utilizáveis",
    );
    assert.match(engine.health.detail ?? "", /preserv|não foi alterado/i);
    assert.doesNotMatch(engine.health.detail ?? "", /detectam|detectando/i, "PT-BR não entra no detalhe");
  });
});

/**
 * Corpus REAL do reporte do Codex Lead: um comentário de bloco com uma linha
 * que começa por `rule`. A verificação textual antiga (`content.includes`)
 * aceita-o como corpus de regras; o YARA-X compila-o (0 regras). A contagem
 * por regex `^rule\s+\w+` via `m` também o conta, porque a linha do comentário
 * começa em `rule` — daí o falso ACTIVE mesmo depois do primeiro patch.
 */
const COMMENT_BLOCK_RULE_LINE = `
/*
rule Phantom
*/
`;

const CORPUS_COMENTARIO_E_REGRA = `${COMMENT_BLOCK_RULE_LINE}
rule CyberSafe_TP_Synthetic_Real
{
  strings:
    $a = "CYBERSAFE_TP_SYNTHETIC_REAL" ascii
  condition:
    $a
}
`;

/** Regra publica a usar uma regra private: uso legitimo, corpus valido. */
const CORPUS_PRIVATE_MAIS_PUBLICA = `
private rule CyberSafe_TP_Helper_Private
{
  strings:
    $a = "CYBERSAFE_TP_PRIVATE_HELPER" ascii
  condition:
    $a
}

rule CyberSafe_TP_Public_Using_Private
{
  condition:
    CyberSafe_TP_Helper_Private
}
`;

/** Regra global valida ao lado de uma regra publica. */
const CORPUS_GLOBAL_MAIS_PUBLICA = `
import "pe"

global rule CyberSafe_TP_Global_Gate
{
  condition:
    true
}

rule CyberSafe_TP_Public_With_Global
{
  strings:
    $a = "CYBERSAFE_TP_GLOBAL_TOKEN" ascii
  condition:
    $a
}
`;

/** Regex que CONTÉM a palavra `rule` num literal: não é declaração. */
const CORPUS_REGEX_COM_RULE = `
rule CyberSafe_TP_Regex_Mention
{
  strings:
    $r = /rule Phantom/ ascii
  condition:
    $r
}
`;

/** Metadata que menciona `rule` numa string: não é declaração. */
const CORPUS_META_COM_RULE = `
rule CyberSafe_TP_Meta_Mention
{
  meta:
    description = "rule Phantom em texto"
  strings:
    $a = "CYBERSAFE_TP_META_TOKEN" ascii
  condition:
    $a
}
`;

describe("TP YARA — contagem lexical: só regras reais e reportáveis", () => {
  test("comentário de bloco com linha 'rule Phantom' ⇒ 0 regras, ficheiro intacto, NUNCA active", async () => {
    const { engine, before, after } = await loadEngineWithProof(COMMENT_BLOCK_RULE_LINE);
    assert.equal(after, before, "o corpus do comentário não é reescrito (hash antes = depois)");
    assert.notEqual(engine.health.status, "active", "falso ACTIVE reproduzido pelo Codex Lead");
    assert.equal(engine.health.status, "degraded");
    assert.equal(engine.health.coverage, "unknown");
    assert.equal(engine.ruleCount, 0, "a linha do comentário não é uma regra");
    assert.throws(() => engine.match(Buffer.from("rule Phantom")), /unavailable/i);
  });

  test("comentário de bloco ao lado de uma regra real ⇒ active com 1 regra e deteção real", async () => {
    const { engine } = await loadEngineWith(CORPUS_COMENTARIO_E_REGRA);
    assert.equal(engine.ruleCount, 1, "o comentário não conta; a regra real conta");
    assert.equal(engine.health.status, "active");

    const hitPath = path.join(tmpdir(), "amostra-real.txt");
    fs.writeFileSync(hitPath, "... CYBERSAFE_TP_SYNTHETIC_REAL ...", "utf-8");
    const matches = await engine.scanFile(hitPath);
    assert.deepEqual(matches.map((m) => m.ruleId), ["CyberSafe_TP_Synthetic_Real"]);
  });

  test("private usada por uma pública ⇒ corpus válido, active com 1 reportável", async () => {
    const { engine } = await loadEngineWith(CORPUS_PRIVATE_MAIS_PUBLICA);
    assert.equal(engine.ruleCount, 1, "a private não é reportável; a pública é");
    assert.equal(engine.health.status, "active", "não se bloqueia um corpus válido com helpers private");

    const hitPath = path.join(tmpdir(), "amostra-private.txt");
    fs.writeFileSync(hitPath, "CYBERSAFE_TP_PRIVATE_HELPER", "utf-8");
    const matches = await engine.scanFile(hitPath);
    assert.deepEqual(matches.map((m) => m.ruleId), ["CyberSafe_TP_Public_Using_Private"]);
  });

  test("regra global é reportável (o YARA-X inclui-a nos matches) e não se perde", async () => {
    const both = await loadEngineWith(CORPUS_GLOBAL_MAIS_PUBLICA);
    assert.equal(both.engine.ruleCount, 2, "global + pública são duas regras reportáveis");
    assert.equal(both.engine.health.status, "active");

    const onlyGlobal = await loadEngineWith(
      'import "pe"\n\nglobal rule CyberSafe_TP_Global_Only\n{\n  condition:\n    true\n}\n',
    );
    assert.equal(onlyGlobal.engine.ruleCount, 1);
    assert.equal(
      onlyGlobal.engine.health.status,
      "active",
      "o scanner reporta a global; rejeitá-la seria bloquear um corpus válido",
    );
    const control = onlyGlobal.engine.match(Buffer.from("qualquer bytes"));
    assert.deepEqual(control.map((m) => m.ruleId), ["CyberSafe_TP_Global_Only"]);
  });

  test("literal de regex e string de metadata com 'rule' não contam como regras", async () => {
    const regex = await loadEngineWith(CORPUS_REGEX_COM_RULE);
    assert.equal(regex.engine.ruleCount, 1, "o /rule Phantom/ é um literal, não uma declaração");
    assert.equal(regex.engine.health.status, "active");

    const meta = await loadEngineWith(CORPUS_META_COM_RULE);
    assert.equal(meta.engine.ruleCount, 1, "a string da metadata não é uma declaração");
    assert.equal(meta.engine.health.status, "active");
  });

  test("regex como operando de `matches` não é declaração (nem quando diz 'rule Phantom')", async () => {
    // Repro do Codex Lead: só existe uma regra private; o regex do `matches`
    // contém `rule Phantom`. Um lexer que só salta regex depois de `=` conta
    // essa linha como regra pública e devolve ACTIVE.
    const { engine, before, after } = await loadEngineWithProof(`
private rule CyberSafe_TP_Hidden
{
  strings:
    $a = "CYBERSAFE_TP_HIDDEN" ascii
  condition:
    $a and "x" matches /rule Phantom/
}
`);
    assert.equal(after, before, "o corpus private-only não pode ser reescrito");
    assert.equal(engine.ruleCount, 0, "o regex não declara nenhuma regra");
    assert.notEqual(engine.health.status, "active", "falso ACTIVE reproduzido no v3");
    assert.equal(engine.health.status, "degraded");
    assert.equal(engine.health.coverage, "unknown");
    assert.equal(engine.isAvailable, false);
  });

  test("regex via `matches` numa regra reportável real ⇒ conta 1 e deteta", async () => {
    const { engine } = await loadEngineWith(`
rule CyberSafe_TP_Match_Regex
{
  strings:
    $a = "CYBERSAFE_TP_MATCH_REGEX" ascii
  condition:
    $a and "rule Phantom" matches /rule Phantom/
}
`);
    assert.equal(engine.ruleCount, 1, "a regra real conta uma vez; o regex não acrescenta nenhuma");
    assert.equal(engine.health.status, "active");

    const hitPath = path.join(tmpdir(), "amostra-matches.txt");
    fs.writeFileSync(hitPath, "CYBERSAFE_TP_MATCH_REGEX", "utf-8");
    const matches = await engine.scanFile(hitPath);
    assert.deepEqual(matches.map((m) => m.ruleId), ["CyberSafe_TP_Match_Regex"]);
  });

  test("modificador private com comentário pelo meio, e `rule<TAB>`, continuam a ser código", async () => {
    const between = await loadEngineWith(`
private /* helper de teste */ rule CyberSafe_TP_Helper_Comment
{
  strings:
    $a = "CYBERSAFE_TP_HELPER_COMMENT" ascii
  condition:
    $a
}

rule CyberSafe_TP_Public_After_Comment
{
  condition:
    CyberSafe_TP_Helper_Comment
}
`);
    assert.equal(between.engine.ruleCount, 1, "private não conta; a pública conta");
    assert.equal(between.engine.health.status, "active");

    const tabbed = await loadEngineWith(
      'rule\tCyberSafe_TP_Tabbed\n{\n  strings:\n    $a = "CYBERSAFE_TP_TAB" ascii\n  condition:\n    $a\n}\n',
    );
    assert.equal(tabbed.engine.ruleCount, 1, "rule<TAB>Nome é YARA válido (antes era substituído pelo canário)");
    assert.equal(tabbed.engine.health.status, "active");

    const lineComment = await loadEngineWith(
      "// rule Phantom em comentário de linha\nrule CyberSafe_TP_After_Line_Comment\n{\n  condition:\n    true\n}\n",
    );
    assert.equal(lineComment.engine.ruleCount, 1, "o comentário de linha não é uma regra");
    assert.equal(lineComment.engine.health.status, "active");
  });
});

describe("TP YARA — corpus inválido e falha de carga caem fechado", () => {
  test("corpus que não compila ⇒ canário, degraded/limited, e o pipeline ainda deteta em memória", async (t) => {
    const { engine, file } = await loadEngineWith("rule Quebrada {{{ isto nao compila");
    assert.notEqual(engine.health.status, "active");
    assert.equal(engine.health.status, "degraded");
    assert.equal(engine.health.coverage, "limited", "canário é cobertura limitada, não unknown nem normal");
    assert.equal(engine.ruleCount, 1);

    const rewritten = fs.readFileSync(file, "utf-8");
    assert.match(rewritten, /cybersafe-fallback-canary/, "o corpus inválido é substituído pelo canário conhecido");

    // Positivo de controlo em MEMÓRIA: nada de EICAR em disco (Defender).
    // Onde o antivírus da máquina nega a leitura do alvo temporário, o harness
    // mede a causa e salta; salta SÓ com essa causa e com o motor a avaliar um
    // buffer benigno — sem isso continua a ser FAIL.
    const matches = positiveControlMatchOrSkip(t, engine, CYBERSAFE_EICAR_POSITIVE_CONTROL_BUFFER);
    if (matches === null) return;
    assert.equal(matches.length, 1, "o caminho regra→match funciona mesmo em modo canário");
    assert.equal(matches[0].ruleId, "CyberSafe_Canary_EICAR");
    // A classificação de evidência fica fora deste packet (ver handoff): a regra
    // canário tem `hash1` mas não se chama `eicar`, e hoje sai `generic`.
    assert.ok(["generic", "strong"].includes(matches[0].evidence));
    assert.ok(["high", "critical"].includes(matches[0].severity));
  });

  test("falha de carga real (path de regras é um diretório) ⇒ error/unavailable, load() não rebenta", async () => {
    const dir = tmpdir();
    const rulesPath = path.join(dir, "regras-como-diretorio");
    fs.mkdirSync(rulesPath, { recursive: true });

    const engine = new YaraEngine(rulesPath);
    await engine.load(rulesPath); // não pode lançar

    assert.equal(engine.health.status, "error");
    assert.equal(engine.health.coverage, "unknown");
    assert.equal(engine.isAvailable, false);
    assert.equal(engine.ruleCount, 0);

    const probe = path.join(dir, "probe.txt");
    fs.writeFileSync(probe, "nada", "utf-8");
    await assert.rejects(
      () => engine.scanFile(probe),
      (error) => error instanceof YaraScanError && error.code === "unavailable",
      "sem scanner o ficheiro NÃO foi avaliado e isso tem de ser visível",
    );
    const outcome = await engine.scanFileOutcome(probe);
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.matches.length, 0);
  });
});

describe("TP YARA — regras válidas e match real (sintético, seguro)", () => {
  test("corpus sintético válido ⇒ active/unknown, com 1 regra utilizável", async () => {
    const { engine } = await loadEngineWith(SYNTHETIC_CORPUS);
    assert.equal(engine.health.status, "active", "compilou e tem uma regra reportável");
    assert.equal(engine.health.coverage, "unknown", "regra sintética não prova proveniência nem eficácia");
    assert.equal(engine.ruleCount, 1);
    assert.equal(engine.isAvailable, true);
  });

  test("match real: dispara na amostra sintética e fica em silêncio num ficheiro limpo", async () => {
    const { engine } = await loadEngineWith(SYNTHETIC_CORPUS);
    const dir = tmpdir();
    const hitPath = path.join(dir, "amostra-sintetica.txt");
    fs.writeFileSync(hitPath, "prefixo CYBERSAFE_TP_SYNTHETIC_TOKEN_ONE sufixo", "utf-8");
    const missPath = path.join(dir, "ficheiro-limpo.txt");
    fs.writeFileSync(missPath, "apenas notas benignas", "utf-8");

    const hit = await engine.scanFile(hitPath);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].ruleId, "CyberSafe_TP_Synthetic_One");
    assert.equal(hit[0].evidence, "generic", "regra sintética não tem evidência forte");
    assert.equal(hit[0].severity, "high");

    const hitOutcome = await engine.scanFileOutcome(hitPath);
    assert.equal(hitOutcome.status, "ok");
    assert.equal(hitOutcome.matches.length, 1);

    const missOutcome = await engine.scanFileOutcome(missPath);
    assert.equal(missOutcome.status, "ok");
    assert.equal(missOutcome.matches.length, 0, "o positivo é real: um ficheiro limpo não dispara");
  });

  test("o controlo positivo canónico em memória continua a disparar ao lado de regras reais", async (t) => {
    const { engine } = await loadEngineWith(`${SYNTHETIC_CORPUS}\n${CYBERSAFE_EICAR_POSITIVE_CONTROL_RULE}`);
    assert.equal(engine.ruleCount, 2);
    assert.equal(engine.health.status, "active");

    // Ordem trocada de propósito, sem tocar em nenhuma asserção: o match
    // sintético não precisa do conteúdo EICAR e é a prova de que a regra→match
    // funciona mesmo onde o antivírus da máquina nega o alvo do controlo.
    const synth = engine.match(Buffer.from("...CYBERSAFE_TP_SYNTHETIC_TOKEN_ONE..."));
    assert.deepEqual(synth.map((m) => m.ruleId), ["CyberSafe_TP_Synthetic_One"]);

    const control = positiveControlMatchOrSkip(t, engine, CYBERSAFE_EICAR_POSITIVE_CONTROL_BUFFER);
    if (control === null) return;
    assert.equal(control.length, 1);
    assert.equal(control[0].ruleId, "CyberSafe_Canary_EICAR");
  });
});
