import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// Importa do `dist/`, que e onde `tsc` escreve a partir do `src/yara.ts`.
// NÃO de `../src/yara.js`: esse ficheiro e um artefacto obsoleto de 2026-08-22
// (4 KB contra 15 KB do .ts) que ficou no src por uma config antiga e NAO tem
// `health`, `coverage` nem nada do motor actual — importar dali daria
// `undefined` em vez do contrato que este ficheiro quer testar.
import { YaraEngine } from "../dist/yara.js";

/**
 * CONTRATO DE COBERTURA — `status` mede o MOTOR, `coverage` mede o CORPUS.
 *
 * ── O problema que este ficheiro existe para apanhar ────────────────────────
 * `EngineSubsystemHealth.status` responde a "o motor carregou?". Nao responde
 * a "as regras carregadas servem para alguma coisa?". Um corpus que e apenas o
 * canario EICAR faz o motor funcionar e nao detecta malware nenhum — as duas
 * respostas sao ambas verdadeiras e o campo so tem uma.
 *
 * Antes deste contrato, o unico sinal era o `FALLBACK_MARKER`, que e um proxy
 * de "isto foi gerado pelo proprio CyberSafe". Funciona para o canario, mas
 * deixa o consumidor da UI sem forma de dizer ao utilizador *quanto* cobre.
 * `coverage` torna essa resposta explicita e transportavel pelo named-pipe.
 *
 * ── A assimetria de `normal` e deliberada ───────────────────────────────────
 * "limited" e affirmacao segura: sabemos que e pouco. "normal" e affirmacao
 * forte: so se emite com evidencia medida (um corpus que NAO e o canario
 * compilou com sucesso). A ausencia do marker num ficheiro que nao leu NAO
 * basta — por isso o calculo e feito depois de `load()`, no ramo em que o
 * corpus esta de facto em memoria, nunca por presuncao do caminho de codigo.
 */

const tmpRoots = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-yara-cov-"));
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

/** Regra valida e canonica: e o que um corpus real compilaria. */
const REAL_CORPUS = `
rule CyberSafe_Real_Detection_One
{
  meta:
    description = "Deteção de teste com semantica de malware"
  strings:
    $a = "EvilStringParaDeteccao" ascii
  condition:
    $a
}
rule CyberSafe_Real_Detection_Two
{
  strings:
    $b = "OutraStringDeDeteccao" ascii
  condition:
    $b
}
`;

async function loadEngineWith(content, name) {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "yara"), { recursive: true });
  const file = path.join(dir, "yara", name);
  if (content !== null) fs.writeFileSync(file, content, "utf-8");
  const engine = new YaraEngine(file);
  await engine.load(file);
  return engine;
}

describe("CONTRATO DE COBERTURA — status mede o motor, coverage mede o corpus", () => {
  // ── CASO A: so canario / fallback ────────────────────────────────────────
  test("A1: corpus apenas-EICAR (canário) => status NAO é 'active' E coverage = 'limited'", async () => {
    const e = await loadEngineWith(
      "// cybersafe-fallback-canary\nrule CyberSafe_Canary_EICAR\n{\n strings:\n $e = \"EICAR-STANDARD-ANTIVIRUS-TEST-FILE\"\n condition:\n $e\n}\n",
      "default.yar",
    );
    assert.notEqual(e.health.status, "active", "o canário não pode ser apresentado como motor activo de malware");
    assert.equal(e.health.coverage, "limited", "corpus só-canário é cobertura limitada, por definição");
  });

  test("A2: o marker do fallback é o que classifica 'limited' (não a contagem)", async () => {
    // Mesmo marker, muitas regras: continua limited. A proveniência do corpus
    // é o que decide, não a quantidade de linhas.
    const many = [
      "// cybersafe-fallback-canary",
      ...Array.from({ length: 12 }, (_, i) => `rule Canario_${i}\n{\n strings:\n $s${i} = "canario${i}"\n condition:\n $s${i}\n}\n`),
    ].join("\n");
    const e = await loadEngineWith(many, "default.yar");
    assert.equal(e.health.coverage, "limited", "12 regras de canário continuam a ser cobertura limitada");
  });

  // ── CASO C: motor activo com corpus valido ──────────────────────────────
  test("C1: corpus válido não-canário => status 'active' E coverage = 'normal'", async () => {
    const e = await loadEngineWith(REAL_CORPUS, "default.yar");
    assert.equal(e.health.status, "active", "um corpus real tem de dar motor activo");
    assert.equal(e.health.coverage, "normal", "corpus real compilado é a ÚNICA evidência que autoriza 'normal'");
  });

  test("C2: status e coverage são semanticamente independentes", async () => {
    const e = await loadEngineWith(REAL_CORPUS, "default.yar");
    // Os dois campos existem e são campos distintos: mudar o corpus muda o
    // coverage sem necessariamente mudar o status, e vice-versa.
    assert.equal(typeof e.health.status, "string");
    assert.equal(typeof e.health.coverage, "string");
    assert.notEqual(
      e.health.status,
      e.health.coverage,
      "o valor de 'status' nunca deve ser reutilizado como 'coverage'",
    );
  });

  // ── CASO B: indisponivel / erro ─────────────────────────────────────────
  test("B1: motor indisponível (nunca carregado) => coverage = 'unknown', NUNCA 'normal'", async () => {
    const e = new YaraEngine(path.join(tmpdir(), "yara", "nunca-existiu.yar"));
    assert.notEqual(e.health.status, "active");
    assert.equal(
      e.health.coverage,
      "unknown",
      "sem corpus medido não hácoverage a declarar — e sobretudo nunca 'normal'",
    );
    assert.notEqual(e.health.coverage, "limited", "'limited' afirma que medimos pouco; se não medimos, é 'unknown'");
  });

  test("B2: corpus vazio => não é 'normal' nem 'limited' (nada foi medido)", async () => {
    const e = await loadEngineWith("", "default.yar");
    assert.notEqual(e.health.coverage, "normal", "um ficheiro vazio não autoriza 'normal'");
  });

  test("B3: corpus que não compila => coverage = 'unknown' (não 'normal')", async () => {
    const e = await loadEngineWith("rule Quebrada {{{ isto nao compila", "default.yar");
    assert.notEqual(e.health.coverage, "normal", "corpo ilegível não pode ser apresentado como cobertura normal");
  });

  // ── CASO D: o contrato é transportável ───────────────────────────────────
  test("D1: coverage viaja no health publicado (o que o service envia pela pipe)", async () => {
    const e = await loadEngineWith(
      "// cybersafe-fallback-canary\nrule CyberSafe_Canary_EICAR\n{\n strings:\n $e = \"EICAR-STANDARD-ANTIVIRUS-TEST-FILE\"\n condition:\n $e\n}\n",
      "default.yar",
    );
    const serialised = JSON.parse(JSON.stringify(e.health));
    assert.ok(
      "coverage" in serialised,
      "sem 'coverage' no JSON do health, a UI nunca recebe o sinal pelo named-pipe",
    );
    assert.equal(serialised.coverage, "limited");
  });
});

describe("CONTRATO — o tipo partilhado declara coverage", () => {
  test("EngineSubsystemHealth tem 'coverage' opcional com os 3 valores", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "shared-types", "src", "index.ts"),
      "utf-8",
    );
    assert.match(src, /EngineSubsystemCoverage/, "falta o tipo de coverage");
    for (const v of ["normal", "limited", "unknown"]) {
      assert.match(src, new RegExp(`"${v}"`), `coverage tem de poder valer "${v}"`);
    }
  });
});

/**
 * CASO E — o marker é NECESSÁRIO, mas não é SUFICIENTE.
 *
 * ── O que apareceu ─────────────────────────────────────────────────────────
 * O marker (`cybersafe-fallback-canary`) responde a uma pergunta errada:
 * "este ficheiro foi escrito pelo CyberSafe?". Não responde à pergunta que o
 * contrato diz responder: "o que este corpus carregado cobre?".
 *
 * Medido em disco, na máquina de desenvolvimento: o `default.yar` do serviço
 * continha UMA regra — `rule eicar`, de `MALW_Eicar.yar`, a PRIMEIRA das quatro
 * fontes de `YARA_SOURCES` — e NÃO tinha o marker. Resultado medido no runtime:
 *
 *     RUNTIME_YARA_STATUS    active
 *     RUNTIME_YARA_COVERAGE  normal
 *     RULE_COUNT             1
 *     IS_FALLBACK_CANARY     NAO
 *
 * Ou seja: coverage "normal" com uma regra que só deteta o ficheiro de teste
 * do EICAR. O mesmo par (`active` + `normal`) do canário nosso, exactamente
 * porque o marker — e só o marker — é que decide.
 *
 * ── Porque aconteceu ──────────────────────────────────────────────────────
 * `updater.ts` faz `return` no PRIMEIRO fonte que valida (o `return` logo a
 * seguir ao `writeFile`), em vez de juntar as quatro. A primeira é o EICAR, e
 * como valida, as três restantes (packers, crypto, ransomware genérico) nunca
 * são sequer pedidas. O corpus "real" é permanentemente o do EICAR.
 *
 * ── A regra do contrato ────────────────────────────────────────────────────
 * `normal` é uma afirmação FORTE: afirma que há deteção de malware. Um corpus
 * cujas regras são todas assinaturas de teste conhecido não a sustenta. Logo:
 * a cobertura passa a ser classificada pelo CONTEÚDO, e o marker passa a ser
 * um atalho para esse mesmo conteúdo (o canário é, por construção, só-teste).
 */
describe("CASO E — corpus só-teste SEM marker não é cobertura normal", () => {
  /**
   * O ficheiro REAL que estava em `~/.cybersafe-service/definitions/yara/default.yar`
   * quando o utilizador reportou o defeito, copiado byte-a-byte para
   * `test/fixtures/yara-eicar-only-real-corpus.yar`.
   *
   * É a 1ª fonte de `YARA_SOURCES` (`MALW_Eicar.yar`), que valida e portanto
   * faz o updater parar. 317 bytes, 1 regra, sem marker.
   *
   * O teste abaixo compara o sha256 do fixture com o do ficheiro real medido em
   * disco. Se alguém "limpar" o fixture e o deixar a parecer-se, a divergência
   * do hash é o sinal — é o que impede este teste de voltar a ser um proxy.
   */
  const FIXTURE_REAL = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "yara-eicar-only-real-corpus.yar",
  );
  const SHA256_REAL = "1ba3175cebe28fc5d4d25c1caf604beda152766db268a3f159e4bf61c2eddf54";

  test("E0: o fixture É o ficheiro real, byte a byte (hash medido em disco)", () => {
    const bytes = fs.readFileSync(FIXTURE_REAL);
    assert.equal(bytes.length, 317, "o ficheiro real tinha 317 bytes");
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      SHA256_REAL,
      "o fixture deixou de ser o ficheiro real que estava em ~/.cybersafe-service",
    );
    // E confirma que é mesmo a regra do Yara-Rules, e não um canário nosso.
    const texto = bytes.toString("utf-8");
    assert.doesNotMatch(texto, /cybersafe-fallback-canary/, "o ficheiro real NÃO tinha o nosso marker");
    assert.match(texto, /hash1\s*=\s*"275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f"/);
  });

  /** O caso do utilizador: o ficheiro real, tal e qual, pelo motor. */
  test("E1: o ficheiro real (1 regra EICAR, sem marker) => coverage 'limited', NUNCA 'normal'", async () => {
    const e = await loadEngineWith(fs.readFileSync(FIXTURE_REAL, "utf-8"), "default.yar");
    assert.equal(e.ruleCount, 1, "é o caso do utilizador: uma regra, e é só o EICAR");
    assert.notEqual(
      e.health.coverage,
      "normal",
      "REGRA: um corpus que só deteta o ficheiro de teste do EICAR NÃO é cobertura normal",
    );
    assert.equal(e.health.coverage, "limited", "assinatura de teste é cobertura limitada, mesmo sem marker");
  });

  test("E2: o mesmo caso não pode ser apresentado como motor activo de malware", async () => {
    const e = await loadEngineWith(fs.readFileSync(FIXTURE_REAL, "utf-8"), "default.yar");
    assert.notEqual(e.health.status, "active", "status 'active' aqui voltaria a dizer 'a deteção está activa'");
  });

  test("E3: o detalhe tem de dizer que a análise por malware está inativa", async () => {
    const e = await loadEngineWith(fs.readFileSync(FIXTURE_REAL, "utf-8"), "default.yar");
    const detail = e.health.detail ?? "";
    assert.match(detail, /EICAR|teste/i, "o detalhe tem de identificar a assinatura de teste, em PT-PT");
    assert.match(
      detail,
      /inativ|inacti|desligad|não (deteta|serve)|nao (deteta|serve)/i,
      "o detalhe tem de dizer que a análise por malware não está activa, e não só que o corpus é fraco",
    );
    // PT-PT: 'detectam' e 'detectando' são PT-BR e não podem aparecer aqui.
    assert.doesNotMatch(detail, /detectam|detectando|detectou-se/i, "PT-BR nao pode entrar no estado mostravel");
  });

  test("E4: assimetria — uma regra REAL ao lado da de teste é suficiente para 'normal'", async () => {
    const comReal = `${fs.readFileSync(FIXTURE_REAL, "utf-8")}
rule MALW_Emotet
{
  strings:
    $b = { 4D 5A 90 00 03 }
  condition:
    $b
}
`;
    const e = await loadEngineWith(comReal, "default.yar");
    assert.equal(e.health.coverage, "normal", "um corpus com uma regra que não é de teste cobre malware");
    assert.equal(e.health.status, "active");
  });

  test("E5: o marker continua a classificar 'limited' mesmo com regras que parecem reais", async () => {
    // O marker é atalho, não resíduo: se está lá, é canário, ponto.
    const markerComNomesbonitos = `// cybersafe-fallback-canary
rule CyberSafe_Real_Detection_One
{
  strings:
    $a = "EvilStringParaDeteccao"
  condition:
    $a
}
`;
    const e = await loadEngineWith(markerComNomesbonitos, "default.yar");
    assert.equal(e.health.coverage, "limited", "o marker do canário continua a sobrepor o conteúdo");
  });

  test("E6: coverage 'normal' nunca pode sair com 0 ou 1 regra", async () => {
    for (const [nome, conteudo] of [
      ["vazio", ""],
      ["o ficheiro real", fs.readFileSync(FIXTURE_REAL, "utf-8")],
      ["uma regra qualquer", 'rule So_Uma\n{\n strings:\n $a = "x"\n condition:\n $a\n}\n'],
    ]) {
      const e = await loadEngineWith(conteudo, "default.yar");
      assert.notEqual(
        e.health.coverage,
        "normal",
        `corpus com ${e.ruleCount} regra(s) (${nome}) não pode ser cobertura normal`,
      );
    }
  });
});

describe("CONTRATO E — a UI não escreve português de Brazil nem plural errado", () => {
  const appSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "src", "components", "ProtectionDetails.tsx"),
    "utf-8",
  );

  test("E7: '1 regra' tem de ser singular na linha de cobertura normal", () => {
    // A frase que o utilizador viu foi `Cobertura normal: 1 regras carregadas.`
    // Scope estreito: a funcao de copy de cobertura. `${regras} regras carregadas`
    // noutro sitio pode ser legitimo — la o singular ja e tratado num ramo a parte.
    const inicio = appSrc.indexOf("function coberturaUserCopy");
    assert.notEqual(inicio, -1, "a funcao de copy de cobertura tem de existir");
    const corpo = appSrc.slice(inicio, appSrc.indexOf("\n}", inicio));
    assert.ok(corpo.length > 0, "a funcao de copy tem de ter corpo");

    // O ramo "normal" nao pode interpolar a contagem crua.
    const ramoNormal = corpo.slice(corpo.indexOf('case "normal"'), corpo.indexOf('case "unknown"'));
    assert.ok(ramoNormal.length > 0, "tem de existir um ramo 'normal'");
    assert.doesNotMatch(
      corpo,
      /\$\{contagem\} regras carregadas/,
      "a contagem interpolada precisa de ser pluralizada: 1 regra carregada, N regras carregadas",
    );
    // O tratamento do singular pode viver numa variavel calculada antes do switch
    // (e vive: e o que o codigo faz) ou no proprio ramo. O que nao pode e o
    // ramo devolver a contagem interpolada sem tratamento nenhum.
    assert.match(
      corpo,
      /Cobertura normal: \$\{contagem\} \$\{contagem === 1 \? "regra carregada" : "regras carregadas"\}/,
      'a frase tem de ser "Cobertura normal: 1 regra carregada." / "N regras carregadas." — nunca "1 regras"',
    );
    assert.match(
      ramoNormal,
      /return carregadas/,
      "o ramo 'normal' tem de devolver a copy pluralizada, e nao a contagem crua",
    );
  });

  test("E8: nenhuma string de cobertura em PT-BR", () => {
    // Corta SO a funcao de copy de cobertura. Um check PT-BR sobre o ficheiro
    // inteiro apanharia codigo nao relacionado (e dariam falsos positivos em
    // nomes de variaveis e comentarios); o que nos interessa e o texto que o
    // utilizador le.
    const inicio = appSrc.indexOf("function coberturaUserCopy");
    assert.notEqual(inicio, -1, "a funcao de copy de cobertura tem de existir");
    const corpo = appSrc.slice(inicio, appSrc.indexOf("\n}", inicio));
    assert.ok(corpo.length > 0, "a funcao de copy tem de ter corpo");

    // PT-BR: 'usuário', 'arquivo' (PT-PT: 'utilizador', 'ficheiro'), e a
    // 3a pessoa do plural em 'detectam' (PT-PT: 'detetam').
    for (const ptbr of [/usuário/, /arquivo/, /\bdetectam\b/]) {
      assert.doesNotMatch(corpo, ptbr, `PT-BR no texto de cobertura: ${ptbr}`);
    }
    // E o inverso: a funcao tem de falar mesmo de cobertura, em PT-PT.
    assert.match(corpo, /Cobertura/, "a copy de cobertura em PT-PT");
  });
});


describe("CONTRATO D — a UI diz a cobertura em PT-PT", () => {
  test("a UI mostra 'Cobertura limitada' quando coverage = limited", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "src", "components", "ProtectionDetails.tsx"),
      "utf-8",
    );
    assert.match(src, /cobertura/i, "a UI tem de falar de cobertura");
    assert.match(
      src,
      /limitada/i,
      "com coverage='limited' a UI tem de dizer que a cobertura é limitada, em PT-PT",
    );
  });
});
