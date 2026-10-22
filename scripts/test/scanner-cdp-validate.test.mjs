import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFixtureEmail, isInsideTemp, isTerminalStatus, parseArgs, summarizeSamples } from "../scanner-cdp-validate.mjs";

describe("validação do Scanner por CDP — argumentos", () => {
  test("lê --chave=valor e --chave", () => {
    const args = parseArgs(["--fixture=C:\\t\\x", "--api=http://127.0.0.1:4100", "--verbose", "ignorar"]);
    assert.deepEqual(args, { fixture: "C:\\t\\x", api: "http://127.0.0.1:4100", verbose: "true" });
  });

  test("valor com '=' não é cortado a meio", () => {
    const args = parseArgs(["--out=C:\\t\\a=b.json"]);
    assert.equal(args.out, "C:\\t\\a=b.json");
  });

  test("sem argumentos devolve objecto vazio", () => {
    assert.deepEqual(parseArgs([]), {});
  });
});

describe("validação do Scanner por CDP — fixture", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cs-cdp-fixture-"));
  const dentro = fs.mkdtempSync(path.join(base, "dentro-"));

  test("aceita pasta real sob %TEMP%", () => {
    assert.equal(isInsideTemp(dentro), true);
  });

  test("recusa a própria base temporária", () => {
    assert.equal(isInsideTemp(os.tmpdir()), false);
  });

  test("recusa caminho fora da base", () => {
    assert.equal(isInsideTemp(path.dirname(fs.realpathSync(os.tmpdir()))), false);
  });

  test("recusa caminho relativo, vazio ou inexistente fora da base", () => {
    assert.equal(isInsideTemp("pastas\\relativas"), false);
    assert.equal(isInsideTemp(""), false);
    assert.equal(isInsideTemp("C:\\Windows\\System32"), false);
  });

  test("fixture temporária removida no fim", () => {
    fs.rmSync(dentro, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
    assert.equal(fs.existsSync(base), false);
  });
});

describe("validação do Scanner por CDP — resumo de amostras", () => {
  test("estado terminal reconhecido, running não é terminal", () => {
    assert.equal(isTerminalStatus("completed"), true);
    assert.equal(isTerminalStatus("cancelled"), true);
    assert.equal(isTerminalStatus("failed"), true);
    assert.equal(isTerminalStatus("running"), false);
    assert.equal(isTerminalStatus(undefined), false);
  });

  test("primeiro/último, máximo e contador que recua", () => {
    const resumo = summarizeSamples([
      { status: "running", progress: 5, filesScanned: 10 },
      { status: "running", progress: 40, filesScanned: 25 },
      { status: "running", progress: 30, filesScanned: 12 },
      { status: "completed", progress: 100, filesScanned: 30 },
    ]);
    assert.equal(resumo.count, 4);
    assert.equal(resumo.first.status, "running");
    assert.equal(resumo.last.status, "completed");
    assert.equal(resumo.maxProgress, 100);
    assert.equal(resumo.filesRegressed, true);
  });

  test("amostras vazias ou inválidas não inventam estado", () => {
    assert.deepEqual(summarizeSamples([]), { count: 0, first: null, last: null, maxProgress: null, filesRegressed: false });
    assert.deepEqual(summarizeSamples([null, "x"]), { count: 0, first: null, last: null, maxProgress: null, filesRegressed: false });
  });
});

describe("validação do Scanner por CDP — conta sintética", () => {
  test("email sempre em .invalid e determinístico com relógio injectado", () => {
    const email = buildFixtureEmail("CDP Run #1", 1792510000000);
    assert.equal(email, "cdp-run-1+1792510000000@cybersafe.invalid");
    assert.match(email, /@cybersafe\.invalid$/);
  });

  test("label vazio continua a produzir um email válido", () => {
    assert.match(buildFixtureEmail("", 1), /^cdp\+1@cybersafe\.invalid$/);
  });
});
