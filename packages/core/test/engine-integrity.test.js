import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ClamavBridge,
  classifyClamavHealth,
  MalwareAnalyzer,
  BUILTIN_HASH_SIGNATURES,
  SignatureDatabase,
  TrustEngine,
  YaraEngine,
  effectiveRiskScore,
  engineIsDegraded,
  scoreToStatus,
} from "../dist/index.js";

// Marker benigno, sem assinatura conhecida pelo Windows Defender.
// O teste prova o carregamento e a execucao de regras YARA, nao uma deteccao
// de malware real: escrever aqui a assinatura EICAR fez o Defender bloquear
// ficheiros de teste na maquina do utilizador a cada npm test.
const PROBE_MARKER = "CYBERSAFE-INTEGRITY-PROBE-OMEGA";
const PROBE_BUFFER = Buffer.from(PROBE_MARKER, "utf8");

// SHA-256 real do EICAR de 68 bytes. E um hash hexadecimal, nao uma assinatura:
// nao e detetado pelo Antivirus e nao e escrito em disco como conteudo de
// ficheiro. Serve so para afirmar o invariante do produto (a base embutida
// contem o hash real do EICAR).
const EICAR_HASH = "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f";

const PROBE_RULE = `
rule cs_probe_omega
{
  strings:
    $s1 = "${PROBE_MARKER}" ascii
  condition:
    all of them
}
`;

/**
 * Segunda regra, que NÃO casa com o buffer de sonda.
 *
 * Porque existe: `PROBE_RULE` sozinho é uma regra de sonda, não evidência de
 * cobertura contra ameaças. O estado `active` comprova que o motor compilou;
 * a cobertura permanece `unknown` até haver proveniência e eficácia validadas.
 *
 * Este teste quer provar outra coisa — que o motor carrega e que a regra deteta
 * — e essa prova é feita por `scanFile` e `match`, não por `status`. Assim o
 * corpus que alimenta o teste justifica `active` apenas pela compilação. A
 * regra que não casa garante que
 * `matches.length === 1` continua a ser uma afirmação sobre a sonda.
 */
const PROBE_RULE_SECUNDARIA = `
rule cs_probe_beta
{
  strings:
    $s2 = "CyberSafeSondaSigmaQueNaoEstaNoBuffer" ascii
  condition:
    all of them
}
`;

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-integrity-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("YARA engine integrity", () => {
  test("carrega um ficheiro de regras válido como ativo e deteta o marker de teste", async () => {
    const rulesPath = path.join(tmpDir, "valid.yar");
    await fs.writeFile(rulesPath, PROBE_RULE + PROBE_RULE_SECUNDARIA, "utf-8");
    const probePath = path.join(tmpDir, "probe.bin");
    await fs.writeFile(probePath, PROBE_BUFFER, "utf-8");

    const engine = new YaraEngine(rulesPath);
    await engine.load(rulesPath);

    assert.equal(engine.health.status, "active");
    assert.equal(
      engine.health.coverage,
      "unknown",
      "duas regras de sonda comprovam execução do motor, não cobertura de ameaças",
    );
    assert.equal(engine.isAvailable, true);
    // Mecanismo, não contagem exacta: interessa que o corpus foi contado como
    // tendo regras, não quantas. O scan abaixo é o que prova que a regra
    // carregou e está a funcionar.
    assert.ok(engine.ruleCount >= 1, `ruleCount esperado >= 1, veio ${engine.ruleCount}`);

    const matches = await engine.scanFile(probePath);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].ruleId, "cs_probe_omega");

    const bufferMatches = engine.match(PROBE_BUFFER);
    assert.equal(bufferMatches.length, 1);
    assert.equal(bufferMatches[0].ruleId, "cs_probe_omega");
  });

  test("recusa um ficheiro acima do limite de recursos antes do scan YARA", async () => {
    const rulesPath = path.join(tmpDir, "bounded.yar");
    await fs.writeFile(rulesPath, PROBE_RULE, "utf-8");
    const oversizedPath = path.join(tmpDir, "oversized.bin");
    const file = await fs.open(oversizedPath, "w");
    try {
      await file.truncate(100 * 1024 * 1024 + 1);
    } finally {
      await file.close();
    }

    const engine = new YaraEngine(rulesPath);
    await engine.load(rulesPath);
    await assert.rejects(
      engine.scanFile(oversizedPath),
      /exceeds the 100 MiB scan limit/,
    );
  });

  test("ficheiro corrompido (JSON) reporta degradado e usou fallback, nunca falha em silêncio", async () => {
    const badPath = path.join(tmpDir, "corrupt.json");
    await fs.writeFile(badPath, '[{"sha256":"404-not-found"}]', "utf-8");

    const engine = new YaraEngine(badPath);
    await engine.load(badPath);

    assert.equal(engine.health.status, "degraded");
    assert.equal(engine.isAvailable, true, "fallback mantém scanner funcional");

    // Contrato do fallback, por comportamento e não pelo nome de uma regra:
    // um teste acoplado ao nome parte assim que alguém corrige a regra, e quem
    // a corrigir vai concluir que o motor se avariou.
    const onDisk = await fs.readFile(badPath, "utf-8");
    assert.ok(onDisk.includes("rule "), "fallback deve ser escrito em disco");
    assert.ok(
      /^\s*rule\s+[A-Za-z_]/m.test(onDisk),
      "o fallback tem de conter pelo menos uma declaração de regra válida"
    );
    // Contagem por intervalo, não por valor: o contrato é "o canário carrega e
    // é sintaticamente válido", não "o canário tem este número de regras".
    assert.ok(
      engine.ruleCount >= 1,
      `o fallback tem de carregar pelo menos uma regra; carregou ${engine.ruleCount}`
    );
    assert.match(
      engine.health.detail ?? "",
      /inativ|inactive/i,
      "o detalhe tem de dizer que a análise por regras de malware está inativa"
    );

    // O fallback não pode disparar sobre material legítimo: é uma regra de teste.
    const benign = engine.match(
      Buffer.from('powershell.exe -enc SQBFAFgA cmd.exe /c dir')
    );
    assert.equal(
      benign.length,
      0,
      `o fallback não pode sinalizar ficheiros legítimos; matchou: ${benign.map((m) => m.ruleId).join(", ")}`
    );

    // ...mas tem de continuar funcional sobre o que realmente deve detectar.
    const eicarFile = Buffer.from(
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
    );
    assert.equal(engine.match(eicarFile).length, 1, "o scanner tem de funcionar sobre o canário");

    // E o detalhe tem de dizer que está em modo canário, para que "a analisar
    // com regras de teste" nunca seja lido como "a analisar com regras de malware".
    //
    // O restart é a parte que faltava. O fallback é gravado no path do corpus
    // real, por isso no arranque seguinte o motor lê um ficheiro YARA válido e
    // reporta "active" — o canário apresentado como corpus de produção. Este
    // teste falha se isso voltar a acontecer.
    const afterRestart = new YaraEngine(badPath);
    await afterRestart.load(badPath);
    assert.equal(
      afterRestart.health.status,
      "degraded",
      "após um restart, o canário escrito no path do corpus não pode ser apresentado como corpus de produção"
    );
    assert.ok(
      afterRestart.ruleCount >= 1,
      `após um restart o canário tem de continuar carregado; carregou ${afterRestart.ruleCount}`
    );
    // O scanner tem de continuar a funcionar depois do restart, não apenas
    // reportar um estado. Um motor degradado que deixou de analisar não é
    // "degradado", é avariado com uma etiqueta mais simpática.
    assert.equal(afterRestart.match(eicarFile).length, 1, "o scanner tem de funcionar após o restart");
    assert.equal(
      afterRestart.match(Buffer.from("powershell.exe -enc SQBFAFgA cmd.exe /c dir")).length,
      0,
      "após o restart o canário continua a não sinalizar material legítimo"
    );
    assert.match(
      afterRestart.health.detail ?? "",
      /inativ|inactive/i,
      "após um restart o detalhe tem de continuar a dizer que a análise por regras está inativa"
    );
    assert.equal(typeof engine.health.detail, "string");
    assert.match(engine.health.detail ?? "", /canário|canarios/i);
    assert.match(engine.health.detail ?? "", /inativ|inactive/i);
  });

  test("YARA sintaticamente inválido mas contendo 'rule' cai para o canário em vez de error", async () => {
    // Passa a verificação textual ("contém 'rule '") mas não compila. O
    // comportamento antigo aceitava-o como corpus de produção e só descobria o
    // problema ao compilar, deixando o motor em "error" — sem corpus e sem
    // canário. Um motor morto é pior do que um canário declarado.
    const invalidPath = path.join(tmpDir, "invalid-syntax.yar");
    await fs.writeFile(
      invalidPath,
      [
        "rule cs_broken {",
        "  strings:",
        "    $a = ", // condição truncada: sintaxe inválida, mas "rule " presente
        "",
      ].join("\n"),
      "utf-8"
    );

    const engine = new YaraEngine(invalidPath);
    await engine.load(invalidPath);

    assert.notEqual(
      engine.health.status,
      "error",
      "YARA inválido não pode deixar o motor em error; deve degradar com o canário"
    );
    assert.equal(engine.health.status, "degraded", "YARA inválido tem de degradar");
    assert.equal(engine.isAvailable, true, "o canário tem de manter o scanner funcional");
    assert.ok(engine.ruleCount >= 1, "o canário tem de ser carregado");

    const rewritten = await fs.readFile(invalidPath, "utf-8");
    assert.ok(
      /^\s*rule\s+[A-Za-z_]/m.test(rewritten),
      "o corpus inválido tem de ser substituído em disco por um fallback válido"
    );

    assert.equal(
      engine.match(Buffer.from("powershell.exe -enc SQBFAFgA cmd.exe /c dir")).length,
      0,
      "o canário não pode sinalizar material legítimo"
    );
    assert.match(
      engine.health.detail ?? "",
      /inativ|inactive/i,
      "o detalhe tem de dizer que a análise por regras de malware está inativa"
    );
  });

  test("canário persistido com marker e sintaxe corrompida recupera do canário canónico", async () => {
    // O caso que faltava. Num arranque anterior o motor escreveu o canário em
    // disco. O utilizador, um sincronizador, ou um disco com sectores maus
    // corrompem esse ficheiro: o marker do canário sobrevive, a sintaxe não.
    //
    // O comportamento antigo classificava marker + conteúdo inválido como se o
    // canário fosse bom, tentava compilá-lo, falhava, e devolvia error com
    // isAvailable=false — ou seja, um ficheiro de teste corrompido matava a
    // análise por regras do utilizador. O motor tem de reconstruir a partir da
    // constante canónica, que se sabe que compila, e continuar degradado.
    const persisted = path.join(tmpDir, "persisted-canary.yar");
    await fs.writeFile(
      persisted,
      "// cybersafe-fallback-canary\nrule Persisted_Canary {\n  strings:\n    $a = \"x\"\n}\n",
      "utf-8"
    );

    const engine = new YaraEngine(persisted);
    await engine.load(persisted);

    assert.equal(
      engine.health.status,
      "degraded",
      "um canário corrompido continua a ser canário: tem de ficar degradado"
    );
    assert.equal(engine.isAvailable, true, "um canário corrompido não pode matar o scanner");
    assert.ok(
      engine.ruleCount >= 1,
      `o canário reconstruído tem de carregar pelo menos uma regra; carregou ${engine.ruleCount}`
    );
    assert.match(
      engine.health.detail ?? "",
      /inativ|inactive/i,
      "o detalhe tem de continuar a dizer que a análise por regras de malware está inativa"
    );

    // Recuperou para o canónico, logo tem de funcionar — e continuar cego ao
    // material legítimo, que era o defeito do fallback genérico anterior.
    const eicarFile = Buffer.from(
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
    );
    assert.equal(engine.match(eicarFile).length, 1, "o canário reconstruído tem de funcionar");
    assert.equal(
      engine.match(Buffer.from("powershell.exe -enc SQBFAFgA cmd.exe /c dir")).length,
      0,
      "o canário reconstruído não pode sinalizar material legítimo"
    );

    // E o arranque seguinte tem de ficar degradado outra vez: o ficheiro
    // reescrito é válido, e um válido sem Cormarker de canário seria lido como
    // corpus de produção.
    const afterRestart = new YaraEngine(persisted);
    await afterRestart.load(persisted);
    assert.equal(
      afterRestart.health.status,
      "degraded",
      "depois de reconstruir o canário, o restart não pode promovê-lo a corpus de produção"
    );
    assert.equal(afterRestart.isAvailable, true);
  });

  test("pseudo-regra dentro de comentário de bloco não promove o canário a corpus de produção", async () => {
    // A proveniência nunca pode depender de contar texto "rule". Um bloco de
    // comentário com uma declaração de regra ao início da linha contava como
    // regra, e o canário passava aActive — o canário de teste apresentado como
    // corpus real, que é exactamente o que este mecanismo existe para impedir.
    const commented = path.join(tmpDir, "comment-pseudo.yar");
    await fs.writeFile(
      commented,
      [
        "// cybersafe-fallback-canary",
        "/*",
        "rule Real_Looking_Rule_Name",
        "*/",
        "rule Test_Only_Corpus_Rule",
        "{",
        "  strings:",
        '    $probe = "PROBE-MARKER-TEXT-ONLY" ascii',
        "  condition:",
        "    $probe",
        "}",
        ""
      ].join("\n"),
      "utf-8"
    );

    const engine = new YaraEngine(commented);
    await engine.load(commented);

    assert.equal(
      engine.health.status,
      "degraded",
      "um marker de canário tem de continuar degradado, mesmo com texto que parece regra real"
    );
    assert.match(
      engine.health.detail ?? "",
      /inativ|inactive/i,
      "o detalhe tem de dizer que a análise por regras de malware está inativa"
    );

    const afterRestart = new YaraEngine(commented);
    await afterRestart.load(commented);
    assert.equal(
      afterRestart.health.status,
      "degraded",
      "a pseudo-regra em comentário não pode ser promovida a corpus pelo restart"
    );
  });

  test("conteúdo HTML corrupto também é tratado como degradado", async () => {
    const htmlPath = path.join(tmpDir, "html.yar");
    await fs.writeFile(htmlPath, "<!DOCTYPE html><html><body>404: Not Found</body></html>", "utf-8");

    const engine = new YaraEngine(htmlPath);
    await engine.load(htmlPath);

    assert.equal(engine.health.status, "degraded");
    assert.equal(engine.isAvailable, true);
  });

  test("ficheiro de regras inexistente recupera com built-in (degraded, não error)", async () => {
    const missingPath = path.join(tmpDir, "definitely-missing.yar");
    const engine = new YaraEngine(missingPath);
    await engine.load(missingPath);

    assert.equal(engine.health.status, "degraded");
    assert.equal(engine.isAvailable, true);
    const exists = await fs.access(missingPath).then(() => true, () => false);
    assert.equal(exists, true);
  });

  test("scan de conteúdo limpo não produz falsos positivos", async () => {
    const rulesPath = path.join(tmpDir, "probe-only.yar");
    await fs.writeFile(rulesPath, PROBE_RULE, "utf-8");

    const cleanPath = path.join(tmpDir, "clean.txt");
    await fs.writeFile(cleanPath, "hello world, nothing suspicious here", "utf-8");

    const engine = new YaraEngine(rulesPath);
    await engine.load(rulesPath);
    const matches = await engine.scanFile(cleanPath);

    assert.equal(matches.length, 0);
  });
});

describe("Hash DB integrity", () => {
  test("base local encontra um hash de teste carregado de ficheiro", async () => {
    const dbPath = path.join(tmpDir, "hashes.json");
    await fs.writeFile(
      dbPath,
      JSON.stringify([
        { sha256: "abcdef", family: "TestFamily", severity: "high", source: "test" },
        { sha256: EICAR_HASH, family: "EICAR-Test-File", severity: "critical", source: "test" },
      ]),
      "utf-8",
    );

    const db = new SignatureDatabase();
    await db.load(dbPath);

    // TP-PAP-FREEBUFF-YARA-HASHDB-P0: este ficheiro tem UMA entrada válida
    // (`abcdef` não é SHA-256 e é descartado). Não cobre as assinaturas
    // built-in obrigatórias, por isso não pode ser declarado `active`; a
    // cobertura offline é reposta em memória para não perder deteção.
    assert.equal(db.health.status, "degraded");
    // A entrada do ficheiro é o próprio EICAR: repor os built-in em memória
    // deixa exactamente a base embutida completa (sem duplicar esse hash).
    assert.equal(db.size, BUILTIN_HASH_SIGNATURES.length);
    assert.equal(db.match("abcdef"), undefined, "um valor que não é SHA-256 não entra na base");
    const hit = db.match(EICAR_HASH);
    assert.ok(hit);
    assert.equal(hit.family, "EICAR-Test-File");
  });

  test("feed remoto indisponível não quebra proteção local (built-in offline)", async () => {
    const db = new SignatureDatabase();
    await db.load(path.join(tmpDir, "no-such-feed", "default.json"));

    assert.equal(db.health.status, "degraded");
    // Conta derivada do conjunto embutido, e nao um literal: a base muda
    // quando a proveniencia e revista, e um 4 fixo aqui passava a mentir
    // sobre o produto sem nada ter mudado no motor.
    assert.equal(
      db.size,
      BUILTIN_HASH_SIGNATURES.length,
      "a base offline tem de trazer exatamente o conjunto embutido",
    );
    for (const record of BUILTIN_HASH_SIGNATURES) {
      assert.ok(
        db.match(record.sha256),
        `a base offline perdeu a assinatura ${record.family}`,
      );
    }
    const eicar = db.match(EICAR_HASH);
    assert.ok(eicar);
    assert.equal(eicar.family, "EICAR-Test-File");
  });

  test("ficheiro de hashes corrompido recorre à base embutida", async () => {
    const dbPath = path.join(tmpDir, "corrupt-hashes.json");
    await fs.writeFile(dbPath, "{not-json", "utf-8");

    const db = new SignatureDatabase();
    await db.load(dbPath);

    assert.equal(db.health.status, "degraded");
    assert.ok(db.match(EICAR_HASH));
  });

  test("ensureFile sementeia a base embutida e passa a ativa", async () => {
    const db = new SignatureDatabase();
    await db.load(path.join(tmpDir, "empty-ish.json"));
    const target = path.join(tmpDir, "seeded.json");
    await db.ensureFile(target);

    const exists = await fs.access(target).then(() => true, () => false);
    assert.equal(exists, true);
    assert.equal(db.health.status, "active");
  });
});

describe("ClamAV integrity", () => {
  test("ClamAV não-disponível ⇒ unavailable/degraded com diagnóstico, nunca ativo", async () => {
    const bridge = new ClamavBridge();
    const available = await bridge.isAvailable();

    if (available) {
      assert.equal(bridge.health.status, "active");
      assert.notEqual(bridge.health.detail, "Not checked", "o probe tem de correr de facto");
    } else {
      // unavailable = binário ausente; degraded = binário OK SEM base de
      // assinaturas (Workstream C: sem .cvd/.cld não há deteção real).
      assert.ok(
        ["unavailable", "degraded"].includes(bridge.health.status),
        `estado inesperado: ${bridge.health.status}`,
      );
      assert.notEqual(bridge.health.detail, "Not checked");
      const res = await bridge.scanFile(import.meta.filename);
      assert.equal(res.detected, false, "motor indisponível nunca simula proteção");
      assert.equal(res.status.status, bridge.health.status);
    }
  });

  test("classifyClamavHealth — binário sem definições NUNCA é active", () => {
    const versionOk = "ClamAV 1.5.2\n";
    assert.equal(classifyClamavHealth({ versionOutput: null, versionError: "not found", dbDir: null, dbFiles: null }).health.status, "unavailable");
    assert.equal(classifyClamavHealth({ versionOutput: "outra coisa", dbDir: null, dbFiles: null }).health.status, "unavailable");
    assert.equal(classifyClamavHealth({ versionOutput: versionOk, dbDir: null, dbFiles: null }).health.status, "degraded");
    assert.equal(classifyClamavHealth({ versionOutput: versionOk, dbDir: "C:\\db", dbFiles: null }).health.status, "degraded");
    const semBase = classifyClamavHealth({ versionOutput: versionOk, dbDir: "C:\\db", dbFiles: ["readme.txt"] });
    assert.equal(semBase.available, false);
    assert.match(semBase.health.detail, /sem base de assinaturas.*freshclam/i);
    const comBase = classifyClamavHealth({ versionOutput: versionOk, dbDir: "C:\\db", dbFiles: ["main.cvd", "daily.cld", "notas.txt"] });
    assert.equal(comBase.available, true);
    assert.equal(comBase.health.status, "active");
    assert.match(comBase.health.detail, /2 signature database file/);
  });
});

describe("Score e degradação segura", () => {
  const mk = (yara, hashDb, clamav, nativeEngine, firewall) => ({
    serviceRunning: true,
    osLayerHealthy: true,
    degradedReasons: [],
    monitoredPaths: [],
    yara,
    hashDb,
    clamav,
    nativeEngine,
    firewall,
  });

  test("sem motores ativos o piso de risco sobre para 75", () => {
    const engine = mk(
      { status: "unavailable" },
      { status: "unavailable" },
      { status: "unavailable" },
      { status: "unavailable" },
      { status: "active" },
    );
    assert.equal(effectiveRiskScore(0, engine), 75);
    assert.equal(engineIsDegraded(engine), true);
    assert.equal(scoreToStatus(effectiveRiskScore(0, engine), engineIsDegraded(engine)), "degraded");
  });

  test("poucos motores ativos ⇒ piso 45, status degradado", () => {
    const engine = mk(
      { status: "active" },
      { status: "active" },
      { status: "unavailable" },
      { status: "unavailable" },
      { status: "active" },
    );
    assert.equal(effectiveRiskScore(0, engine), 45);
    assert.equal(scoreToStatus(effectiveRiskScore(0, engine), engineIsDegraded(engine)), "degraded");
  });

  test("drift degradado com maioria ativa ⇒ piso 20", () => {
    const engine = mk(
      { status: "active" },
      { status: "active" },
      { status: "active" },
      { status: "degraded", detail: "native timeout" },
      { status: "active" },
    );
    assert.equal(effectiveRiskScore(0, engine), 20);
    assert.equal(engineIsDegraded(engine), true);
  });

  test("score real já alto é preservado quando proteção completa", () => {
    const engine = mk(
      { status: "active" },
      { status: "active" },
      { status: "active" },
      { status: "active" },
      { status: "active" },
    );
    assert.equal(effectiveRiskScore(92, engine), 92);
    assert.equal(engineIsDegraded(engine), false);
    assert.equal(scoreToStatus(92, false), "critical");
  });

  test("scoreToStatus nunca mostra safe quando degradado", () => {
    assert.equal(scoreToStatus(0, true), "degraded");
    assert.equal(scoreToStatus(20, false), "safe");
    assert.equal(scoreToStatus(50, false), "attention");
  });
});

describe("Sem regressões na análise", () => {
  test("análise limpa concluída produz veredicto seguro sem exceções", async () => {
    const cleanPath = path.join(tmpDir, "notes.txt");
    await fs.writeFile(cleanPath, "nothing to see here", "utf-8");

    const deps = {
      signatures: new SignatureDatabase(),
      trust: new TrustEngine(),
      yara: new YaraEngine(path.join(tmpDir, "analyzer.yar")),
      clamav: { scanFile: async () => ({ detected: false, verdict: "clean" }) },
    };
    const analyzer = new MalwareAnalyzer(deps);

    const result = await analyzer.analyze(cleanPath);
    assert.ok(result);
    assert.equal(result.verdict, "safe");
    assert.equal(typeof result.riskScore, "number");
  });
});
