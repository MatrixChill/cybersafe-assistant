/**
 * P0 — CLAMAV_INCONCLUSIVE_VERDICT: um ERROR nunca pode virar "safe".
 *
 * Achado no security review (TASK B, pergunta 14: "nenhum caminho
 * interpreta ERROR como SAFE?"). A resposta era SIM, em dois sítios:
 *
 *  1. `core/analysis.ts` — `scan_inconclusive` foi declarado com peso 0
 *     (decisão correcta: um motor que não leu o ficheiro não é uma ameaça).
 *     Mas peso 0 significa que `hasStrongEvidence` fica falso e o bloco de
 *     `scoring.ts` cai no `else` que devolve `verdict: "safe"`.
 *     O ficheiro nunca foi examinado e o veredicto diz "safe".
 *
 *  2. `service/engine.ts#analyzeProcess` — `recommendation` parte de "safe"
 *     e só sobe com severidade alta/crítica ou VirusTotal. Um `error` do
 *     ClamAV não é nenhum dos dois, portanto a app renderiza um badge VERDE
 *     com um escudo e a palavra "Seguro" por cima de um ficheiro que ninguém
 *     examinou.
 *
 * A correcção NÃO é "subir o score" (isso seria fabricar uma ameaça) e NÃO é
 * "dizer que o ficheiro é suspeito" (seria fabricar uma deteção). É: quando o
 * motor não conseguiu avaliar, o veredicto é inconclusivo — um quarto estado
 * que existe para dizer exactamente "não sei", e que a UI tem de saber
 * desenhar.
 *
 * Estes testes fixam o contrato. São puros: nenhum clamscan, nenhum disco.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { MalwareAnalyzer, SignatureDatabase, TrustEngine, YaraEngine } from "../dist/index.js";

/** Ficheiros temporários usados pelos testes (isolamento: nunca a home real). */
const tempDirs = [];
async function tmpFile(name, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-verdict-"));
  tempDirs.push(dir);
  const p = path.join(dir, name);
  await fs.writeFile(p, content, "utf8");
  return p;
}

/**
 * ClamAV que nunca conseguiu avaliar nada — o caso medido: o Defender remove
 * o ficheiro no instante em que o clamscan o abre, e o clamscan sai com 2.
 */
const failingClamav = {
  async scanFile() {
    return {
      detected: false,
      verdict: "error",
      detail: "O ficheiro deixou de existir durante a análise",
    };
  },
  async scanFiles(files) {
    return {
      files: files.map((f) => ({ file: f, verdict: "error", detail: "removido durante a análise" })),
      detected: false,
      errorCount: files.length,
      status: { status: "degraded", detail: "erro" },
    };
  },
  async isAvailable() {
    return true;
  },
};

const yaraRulesPath = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-verdict-yar-"));
  tempDirs.push(dir);
  return path.join(dir, "analyzer.yar");
};

function makeAnalyzer(clamav, yara = new YaraEngine()) {
  return new MalwareAnalyzer({
    signatures: new SignatureDatabase(),
    trust: new TrustEngine(),
    yara,
    clamav,
  });
}

process.on("exit", () => {
  for (const d of tempDirs) {
    try {
      require("node:fs").rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("P0 — ERROR nunca é publicado como SAFE (core/analysis.ts)", () => {
  it("um veredicto ClamAV 'error' NÃO produz verdict 'safe'", async () => {
    const file = await tmpFile("benign.txt", "isto é um ficheiro perfeitamente benigno");
    const analyzer = makeAnalyzer(failingClamav);
    const result = await analyzer.analyze(file, undefined, undefined, {
      clamavOutcome: { file, verdict: "error", detail: "removido durante a análise" },
    });

    assert.notEqual(
      result.verdict,
      "safe",
      "um ficheiro que o motor não examinou não pode ser 'safe'",
    );
  });

  it("a regra scan_inconclusive fica registada para o ficheiro ficar visível", async () => {
    const file = await tmpFile("benign2.txt", "outro ficheiro benigno");
    const analyzer = makeAnalyzer(failingClamav);
    const result = await analyzer.analyze(file, undefined, undefined, {
      clamavOutcome: { file, verdict: "error", detail: "removido durante a análise" },
    });

    assert.ok(
      result.rulesTriggered.includes("scan_inconclusive"),
      "a lacuna tem de ser nomeada, não escondida",
    );
  });

  it("a confidence de um erro é baixa (≤0,3), nunca a confidence de um 'safe'", async () => {
    const file = await tmpFile("benign3.txt", "mais um benigno");
    const analyzer = makeAnalyzer(failingClamav);
    const result = await analyzer.analyze(file, undefined, undefined, {
      clamavOutcome: { file, verdict: "error", detail: "removido durante a análise" },
    });

    assert.ok(
      result.confidence <= 0.3,
      `confidence de um erro deve ser ≤0,3 (foi ${result.confidence})`,
    );
  });

  it("o factor de inconclusividade diz o que aconteceu, em PT-PT", async () => {
    const file = await tmpFile("benign4.txt", "e outro");
    const analyzer = makeAnalyzer(failingClamav);
    const result = await analyzer.analyze(file, undefined, undefined, {
      clamavOutcome: { file, verdict: "error", detail: "O ficheiro deixou de existir durante a análise" },
    });

    const factor = result.factors.find((f) => f.id === "clamav-inconclusive");
    assert.ok(factor, "tem de existir um factor que explique a inconclusividade");
    assert.match(
      factor.label,
      /deixou de existir/i,
      `o factor tem de repetir o detalhe real (veio: ${factor.label})`,
    );
  });

  it("YARA-X sem scanner não representa um buffer não avaliado como sem deteções", () => {
    assert.throws(() => new YaraEngine().match(Buffer.from("fixture")), /not evaluated/i);
  });

  it("ClamAV clean e YARA avaliado sem matches continuam safe", async () => {
    const file = await tmpFile("limpo.txt", "totalmente limpo, nada a ver aqui");
    const analyzer = makeAnalyzer({
      async scanFile() {
        return { detected: false, verdict: "clean" };
      },
      async isAvailable() {
        return true;
      },
    }, { async scanFile() { return []; } });
    // Both required engines evaluated this control; an uninitialised YARA
    // engine is not a successful negative scan.
    const result = await analyzer.analyze(file, undefined, undefined, {
      clamavOutcome: { file, verdict: "clean" },
    });

    assert.equal(result.verdict, "safe", "um clean verdadeiro continua safe");
    assert.ok(!result.rulesTriggered.includes("scan_inconclusive"));
  });

  it("uma falha real de YARA-X nunca é convertida em resultado sem deteções", async () => {
    const file = await tmpFile("yara-race.txt", "conteúdo benigno de teste");
    const rulesPath = await yaraRulesPath();
    await fs.writeFile(
      rulesPath,
      'rule benign_probe { strings: $a = "never matches" condition: $a }',
      "utf8",
    );
    const yaraEngine = new YaraEngine(rulesPath);
    await yaraEngine.load(rulesPath);
    const analyzer = new MalwareAnalyzer({
      signatures: new SignatureDatabase(),
      trust: new TrustEngine(),
      yara: {
        async scanFile(filePath) {
          await fs.unlink(filePath);
          return yaraEngine.scanFile(filePath);
        },
      },
    });

    const result = await analyzer.analyze(file, undefined, undefined, {
      clamavOutcome: { file, verdict: "clean" },
    });

    assert.equal(result.verdict, "inconclusive");
    assert.ok(result.rulesTriggered.includes("scan_inconclusive"));
    assert.ok(result.factors.some((factor) => factor.id === "yara-inconclusive"));
  });

  it("um 'detected' real continua a ser malicioso (o patch não atenua deteções)", async () => {
    const file = await tmpFile("mau.txt", "conteúdo qualquer");
    const analyzer = makeAnalyzer({
      async scanFile() {
        return { detected: true, verdict: "detected", signature: "Test.Sig" };
      },
      async isAvailable() {
        return true;
      },
    });
    const result = await analyzer.analyze(file, undefined, undefined, {
      clamavOutcome: { file, verdict: "detected", signature: "Test.Sig" },
    });

    assert.equal(
      result.verdict,
      "malicious",
      "uma deteção continua maliciosa mesmo com o patch de inconclusividade",
    );
  });
});
