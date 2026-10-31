import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  YaraEngine,
  YaraScanError,
  enforceDeadline,
  MAX_YARA_SCAN_FILE_BYTES,
} from "../dist/yara.js";
import { MalwareAnalyzer, SignatureDatabase, TrustEngine } from "../dist/index.js";

/**
 * RESULTADO DE LEITURA YARA-X — `status` separa "não avaliado" de "sem
 * deteções". Histórico: um prazo não existia e um erro era indistinguível de
 * uma lista vazia de matches; o pipeline compensava com um try/catch que não
 * sabia dizer *porquê*. Aqui provam-se os quatro desfechos e o factor que o
 * pipeline publica quando o prazo vence.
 */

const tmpDirs = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-yara-outcome-"));
  tmpDirs.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

/**
 * Agulha SINTÉTICA, não a assinatura EICAR canónica.
 *
 * Este ficheiro escreve o corpus e o ficheiro em disco em cada execução por
 * omissão (`engineWithCorpus` + fixture), e é isso que o guard
 * `eicar-manual-opt-in.test.js` proíbe fora do gate CYBERSAFE_EICAR_MANUAL=1 —
 * o Defender já bloqueou duas suites deste projecto por exactamente este padrão.
 * O que está sob contrato aqui é o DESFECHO da leitura (ok, zero medido, error,
 * too-large, cancelled), não os bytes do EICAR: a regra mantém o nome `eicar` e
 * o `hash1`, por isso o match e a classificação de evidência forte percorrem o
 * mesmo caminho de código.
 */
const NEEDLE = "CybersafeSyntheticScanOutcomeNeedle";

const TEST_CORPUS = `rule eicar
{
  meta:
    description = "Rule to detect Eicar pattern"
    hash1 = "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f"
  strings:
    $s1 = "${NEEDLE}" fullword ascii
  condition:
    all of them
}
`;

async function engineWithCorpus() {
  const dir = tmpdir();
  const yaraDir = path.join(dir, "yara");
  await fsp.mkdir(yaraDir, { recursive: true });
  const rulesPath = path.join(yaraDir, "default.yar");
  await fsp.writeFile(rulesPath, TEST_CORPUS, "utf-8");
  const engine = new YaraEngine(rulesPath);
  await engine.load(rulesPath);
  return engine;
}

describe("enforceDeadline — prazo e cancelamento sem inventar aborto nativo", () => {
  test("trabalho que termina a tempo devolve 'ok'", async () => {
    const outcome = await enforceDeadline(Promise.resolve(42), { timeoutMs: 50 });
    assert.deepEqual(outcome, { status: "ok", value: 42 });
  });

  test("trabalho pendente vence o prazo => 'timeout'", async () => {
    const pending = new Promise(() => {});
    const outcome = await enforceDeadline(pending, { timeoutMs: 5 });
    assert.equal(outcome.status, "timeout");
  });

  test("sinal abortado antes de começar => 'cancelled' sem esperar pelo trabalho", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await enforceDeadline(new Promise(() => {}), {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    assert.equal(outcome.status, "cancelled");
  });

  test("sinal abortado durante o trabalho => 'cancelled'", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const outcome = await enforceDeadline(new Promise(() => {}), {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    assert.equal(outcome.status, "cancelled");
  });

  test("rejeição tardia depois do prazo não vira unhandledRejection", async () => {
    let rejectWork;
    const work = new Promise((_, reject) => {
      rejectWork = reject;
    });
    const outcome = await enforceDeadline(work, { timeoutMs: 1 });
    assert.equal(outcome.status, "timeout");
    rejectWork(new Error("tarde demais"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

describe("YaraEngine.scanFileOutcome — desfechos reais", () => {
  test("fixture com a agulha sintética de teste => ok com 1 match e duração", async () => {
    const engine = await engineWithCorpus();
    const dir = tmpdir();
    const file = path.join(dir, "assinatura-sintetica.txt");
    await fsp.writeFile(file, `prefixo\n${NEEDLE}\nsufixo`, "utf-8");

    const outcome = await engine.scanFileOutcome(file);
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.matches.length, 1);
    assert.equal(outcome.matches[0].ruleId, "eicar");
    assert.ok(outcome.durationMs >= 0);
  });

  test("ficheiro benigno => ok com zero matches (zero é um resultado medido)", async () => {
    const engine = await engineWithCorpus();
    const dir = tmpdir();
    const file = path.join(dir, "benigno.txt");
    await fsp.writeFile(file, "conteúdo perfeitamente benigno, sem assinaturas", "utf-8");

    const outcome = await engine.scanFileOutcome(file);
    assert.equal(outcome.status, "ok");
    assert.deepEqual(outcome.matches, []);
  });

  test("ficheiro inexistente => 'error', nunca 'ok' com lista vazia", async () => {
    const engine = await engineWithCorpus();
    const outcome = await engine.scanFileOutcome(path.join(tmpdir(), "nao-existe.bin"));
    assert.equal(outcome.status, "error");
    assert.deepEqual(outcome.matches, []);
  });

  test("acima de 100 MiB => 'too-large' sem ler o conteúdo", async () => {
    const engine = await engineWithCorpus();
    const dir = tmpdir();
    const file = path.join(dir, "grande.bin");
    // Ficheiro esparso: o tamanho conta, os blocos não são escritos.
    fs.writeFileSync(file, Buffer.alloc(0));
    fs.truncateSync(file, MAX_YARA_SCAN_FILE_BYTES + 1);

    const outcome = await engine.scanFileOutcome(file);
    assert.equal(outcome.status, "too-large");
    assert.deepEqual(outcome.matches, []);
  });

  test("sinal já abortado => 'cancelled' e nenhum veredicto", async () => {
    const engine = await engineWithCorpus();
    const dir = tmpdir();
    const file = path.join(dir, "cancelado.txt");
    fs.writeFileSync(file, "conteúdo", "utf-8");
    const controller = new AbortController();
    controller.abort();

    const outcome = await engine.scanFileOutcome(file, { signal: controller.signal });
    assert.equal(outcome.status, "cancelled");
  });

  test("scanFile mantém o contrato antigo: lança YaraScanError com código", async () => {
    const engine = await engineWithCorpus();
    const dir = tmpdir();
    const file = path.join(dir, "grande.bin");
    fs.writeFileSync(file, Buffer.alloc(0));
    fs.truncateSync(file, MAX_YARA_SCAN_FILE_BYTES + 1);

    await assert.rejects(
      () => engine.scanFile(file),
      (error) => error instanceof YaraScanError && error.code === "too-large",
    );
  });
});

describe("pipeline — prazo do YARA chega ao resultado como lacuna, não como 'safe'", () => {
  function analyzerWith(yara) {
    return new MalwareAnalyzer({
      signatures: new SignatureDatabase(),
      trust: new TrustEngine(),
      yara,
    });
  }

  test("timeout do motor => verdict inconclusive e factor yara-timeout", async () => {
    const dir = tmpdir();
    const file = path.join(dir, "lento.bin");
    fs.writeFileSync(file, "conteúdo de teste", "utf-8");
    const analyzer = analyzerWith({
      async scanFile() {
        throw new YaraScanError("timeout", "YARA-X exceeded the scan deadline.");
      },
    });

    const result = await analyzer.analyze(file);
    assert.equal(result.verdict, "inconclusive");
    assert.ok(result.rulesTriggered.includes("scan_inconclusive"));
    assert.ok(result.factors.some((factor) => factor.id === "yara-timeout"));
    assert.ok(!result.factors.some((factor) => factor.id === "yara-inconclusive"));
  });

  test("erro genérico do motor continua a publicar yara-inconclusive", async () => {
    const dir = tmpdir();
    const file = path.join(dir, "erro.bin");
    fs.writeFileSync(file, "conteúdo de teste", "utf-8");
    const analyzer = analyzerWith({
      async scanFile() {
        throw new Error("falha de leitura");
      },
    });

    const result = await analyzer.analyze(file);
    assert.equal(result.verdict, "inconclusive");
    assert.ok(result.factors.some((factor) => factor.id === "yara-inconclusive"));
  });

  test("o sinal de cancelamento é entregue ao motor", async () => {
    const dir = tmpdir();
    const file = path.join(dir, "sinal.bin");
    fs.writeFileSync(file, "conteúdo de teste", "utf-8");
    const controller = new AbortController();
    let received;
    const analyzer = analyzerWith({
      async scanFile(_file, options) {
        received = options?.signal;
        return [];
      },
    });

    await analyzer.analyze(file, undefined, undefined, { signal: controller.signal });
    assert.equal(received, controller.signal);
  });
});
