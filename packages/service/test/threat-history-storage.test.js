/**
 * Regressao do Historio de Ameacas (P0).
 *
 * Diagnostico: o gate de armazenamento em engine.ts:912 so guardava
 * high/critical, mas a emissao de threat.detected em :937 e o ScanState.threatsFound
 * em scan-manager.ts:292 contavam medium tambem. Resultado: o Scanner mostrava 1
 * ameaca e a pagina Ameacas mostrava 0.
 *
 * Este teste executa o REAL ProtectionEngineService.scanArtifact (nenhum adaptador
 * artificial), porque os testes existentes (dev-canary.test.js, scan-manager.test.js)
 * usam doubles que guardam em array local quando severity != low, replicando o
 * comportamento pretendido e nunca exercitando o gate verdadeiro.
 *
 * ISOLAMENTO DO ANTIVIRUS DO HOST (P0, 2026-09-28): nenhuma fixture deste ficheiro
 * escreve a assinatura EICAR. A versao anterior escrevia-a em dois casos, e o Windows
 * Defender bloqueou os ficheiros e encheu o historico do utilizador com entradas
 * Ameaca bloqueada a cada npm test. Alem do ruido, tornava o teste nao determinista:
 * o Defender removia o ficheiro a meio da execucao.
 * As fixtures sao agora deterministas e inofensivas:
 *   - medium  : o canario dev (DEV_CANARY_CONTENT), que ja existia.
 *   - critical: um ficheiro benigno cujo sha256 registamos numa base de hashes de
 *               teste, carregada com engine.signatures.load (o pipeline real
 *               continua a correr; so a origem do veredicto e uma fixture nossa).
 *   - high    : um marker benigno com uma regra YARA de teste, carregada com
 *               engine.yara.load.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { ProtectionEngineService } from "../dist/engine.js";
import { DEV_CANARY_CONTENT, installDevCanary } from "./fixtures/dev-canary.js";

// Regista o conteudo do canario no core para a deteccao por conteudo.
installDevCanary();

// Conteudo benigno que o Defender nunca classifica. A severidade critical vem
// do facto de o seu sha256 estar registado, nao do conteudo.
const KNOWN_BAD_CONTENT = "CYBERSAFE-TEST-KNOWNBAD-ab12cd\n";
// Marker benigno para a regra YARA de teste.
const YARA_MARKER = "CYBERSAFE-YARA-PROBE-ALPHA";

const tempDirs = [];
const engines = [];

async function makeTempDir(prefix) {
  // Dentro de \Temp\ a regra suspicious_location soma +15 ao score do canario
  // (dev_canary_signature=55 + suspicious_location=15 = 70), levando-o a medium.
  // Fora de \Temp\ o canario fica so com 55 = low, e a deteccao medium do
  // cenario real do utilizador NAO se reproduz. O contracto do canario e medium
  // em localizacoes suspeitas (Temp/Downloads) — ver probe-loc.mjs.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `cybersafe-th-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const engine of engines) {
    await engine.dispose().catch(() => {});
  }
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * Cria uma engine real e captura os eventos publicados no eventBus.
 *
 * ISOLAMENTO DE RUNTIME (P0): o `baseDir` e INJETADO num tmpdir deste teste.
 * Antes, `new ProtectionEngineService()` sem argumentos escrevia em
 * `%USERPROFILE%\.cybersafe-service` — e sao quatro `init()` neste ficheiro,
 * cada um a semear definicoes e a tocar em history.jsonl/logs do home real.
 * Ver test/p0-runtime-isolation.test.js.
 *
 * O `dispose()` no `after()` não é cosmético: sem ele o `init()` deixa os
 * temporizadores do ciclo de assinaturas ativos, o event loop nunca seca e o
 * `node --test` não escreve o resumo — a suíte fica sem total mensurável.
 */
async function createEngine() {
  const baseDir = await makeTempDir("engine");
  const engine = new ProtectionEngineService(baseDir);
  engines.push(engine);
  const emitted = [];
  const origPublish = engine.eventBus.publish.bind(engine.eventBus);
  engine.eventBus.publish = (type, severity, summary, data) => {
    emitted.push({ type, severity, summary, data });
    return origPublish(type, severity, summary, data);
  };
  return { engine, emitted };
}

describe("Historio de Ameacas — gate real de armazenamento em this.threats", () => {
  it("medium (canario dev) entra em this.threats, gera threat.detected e e devolvido por threats.list", async () => {
    const dir = await makeTempDir("medium");
    const canaryPath = path.join(dir, "cybersafe-e2e-canary.txt");
    await fs.writeFile(canaryPath, DEV_CANARY_CONTENT, "utf8");

    const { engine, emitted } = await createEngine();
    await engine.init();

    const result = await engine.scanArtifact(canaryPath, "system-scanner");

    // Caso 3: overallSeverity e medium
    assert.equal(result.overallSeverity, "medium");
    // Caso 4: threat.detected foi emitido
    const threatEvents = emitted.filter((e) => e.type === "threat.detected");
    assert.equal(threatEvents.length, 1, "exatamente um threat.detected para o canario");
    // Caso 5: this.threats contem exatamente 1 entrada
    assert.equal(engine.threats.length, 1, "this.threats deve conter o canario medium");
    // Caso 6: entrada coerente — nome, caminho e severidade
    const t = engine.threats[0];
    assert.ok(t.domain.includes("cybersafe-e2e-canary"), `domain inesperado: ${t.domain}`);
    assert.equal(t.filePath, canaryPath, `filePath inesperado: ${t.filePath}`);
    assert.equal(t.severity, "medium");
    assert.ok(t.rulesTriggered.includes("dev_canary_signature"));

    // Caso 7: o handler real da pagina Ameacas devolve o MESMO item. E o que
    // fecha a divergencia Scanner (1) vs Ameacas (0): o gate tem de estar a
    // alimentar o array que o handler serve.
    const list = await engine.dispatch("threats.list", undefined);
    assert.ok(Array.isArray(list), "threats.list tem de devolver um array");
    assert.equal(list.length, 1, "threats.list tem de devolver exatamente a entrada guardada");
    assert.equal(list[0].domain, t.domain, "threats.list devolve o mesmo domain");
    assert.equal(list[0].filePath, canaryPath, "threats.list devolve o mesmo filePath");
    assert.equal(list[0].severity, "medium", "threats.list devolve a mesma severidade");
    assert.deepEqual(list[0].rulesTriggered, t.rulesTriggered, "threats.list devolve as mesmas regras");
  });

  it("critical (hash registado numa base de teste) entra em this.threats", async () => {
    const dir = await makeTempDir("critical");
    const filePath = path.join(dir, "knownbad.txt");
    await fs.writeFile(filePath, KNOWN_BAD_CONTENT, "utf8");

    // Base de hashes de teste: o sha256 do ficheiro benigno de cima e declarado
    // conhecido/malicioso. Substitui a base embutida, por isso o verdict critical
    // vem desta fixture e nao de qualquer assinatura real.
    const sha256 = crypto.createHash("sha256").update(Buffer.from(KNOWN_BAD_CONTENT, "utf8")).digest("hex");
    const dbPath = path.join(dir, "hashes.json");
    await fs.writeFile(
      dbPath,
      JSON.stringify([
        { sha256, family: "CyberSafe-Test-File", severity: "critical", source: "test" },
      ]),
      "utf8",
    );

    const { engine, emitted } = await createEngine();
    await engine.init();

    // signatures e yara sao class fields normais em dist/engine.js (o private do
    // TypeScript desaparece na compilacao), por isso sao alcancaveis aqui. E o
    // mesmo objeto que o MalwareAnalyzer recebe, logo o resto do pipeline e real.
    await engine.signatures.load(dbPath);
    assert.equal(engine.signatures.size, 1, "a base de teste tem de substituir a base embutida");

    const result = await engine.scanArtifact(filePath, "system-scanner");

    assert.equal(result.overallSeverity, "critical");
    assert.equal(engine.threats.length, 1, "this.threats deve conter a deteccao critical");
    assert.equal(engine.threats[0].severity, "critical");
    assert.ok(
      engine.threats[0].rulesTriggered.includes("known_bad_hash"),
      `esperado known_bad_hash, obteve ${JSON.stringify(engine.threats[0].rulesTriggered)}`,
    );
  });

  it("high (regra YARA de teste sobre marker benigno) entra em this.threats", async () => {
    const dir = await makeTempDir("high");
    const filePath = path.join(dir, "yara-probe.txt");
    await fs.writeFile(filePath, `${YARA_MARKER}\n`, "utf8");

    // Regra YARA de teste sobre o marker benigno. Sem assinatura do Defender.
    const rulePath = path.join(dir, "probe.yar");
    await fs.writeFile(
      rulePath,
      [
        "rule cs_probe_alpha",
        "{",
        "  meta:",
        '    cybersafe_evidence = "strong"',
        "  strings:",
        `    $s1 = "${YARA_MARKER}" ascii`,
        "  condition:",
        "    all of them",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const { engine, emitted } = await createEngine();
    await engine.init();

    await engine.yara.load(rulePath);
    assert.equal(engine.yara.ruleCount, 1, "a regra de teste tem de substituir as regras embutidas");

    const result = await engine.scanArtifact(filePath, "system-scanner");

    // O motor nativo pode reforçar o score; o que interessa e que a deteccao
    // entra em this.threats com severidade high ou critical (nunca low).
    assert.ok(
      result.overallSeverity === "high" || result.overallSeverity === "critical",
      `esperado high ou critical, obteve ${result.overallSeverity} regras=${JSON.stringify(result.results[0].rulesTriggered)}`,
    );
    assert.equal(engine.threats.length, 1, "this.threats deve conter a deteccao");
    const stored = engine.threats[0];
    assert.ok(
      stored.severity === "high" || stored.severity === "critical",
      `severidade da entrada inesperada: ${stored.severity}`,
    );
    // O vocabulario de rulesTriggered e o HeuristicRuleId, nao o nome da regra
    // YARA: o match da regra de teste aparece como yara_match.
    assert.ok(
      stored.rulesTriggered.includes("yara_match"),
      `esperado yara_match, obteve ${JSON.stringify(stored.rulesTriggered)}`,
    );

    // Atribuicao: com a MESMA regra carregada, um ficheiro sem o marker nao da
    // yara_match. Prova que o match veio da nossa regra e nao de outra coisa.
    const otherPath = path.join(dir, "sem-marker.txt");
    await fs.writeFile(otherPath, "apenas texto sem qualquer marker\n", "utf8");
    const other = await engine.scanArtifact(otherPath, "system-scanner");
    assert.ok(
      !other.results[0].rulesTriggered.includes("yara_match"),
      `a regra de teste nao pode dar match sem o marker: ${JSON.stringify(other.results[0].rulesTriggered)}`,
    );
  });

  it("low (ficheiro limpo) NAO entra em this.threats", async () => {
    const dir = await makeTempDir("low");
    const cleanPath = path.join(dir, "notas.txt");
    await fs.writeFile(cleanPath, "apenas um ficheiro de notas comum", "utf8");

    const { engine, emitted } = await createEngine();
    await engine.init();

    const result = await engine.scanArtifact(cleanPath, "system-scanner");

    assert.equal(result.overallSeverity, "low");
    assert.equal(engine.threats.length, 0, "this.threats nao deve conter ficheiros low");
    const threatEvents = emitted.filter((e) => e.type === "threat.detected");
    assert.equal(threatEvents.length, 0, "nenhum threat.detected para ficheiro low");

    const list = await engine.dispatch("threats.list", undefined);
    assert.equal(list.length, 0, "threats.list tambem nao devolve ficheiros low");
  });
});
