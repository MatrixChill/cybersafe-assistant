import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  LIFECYCLE_LOG_FILENAME,
  LIFECYCLE_MAX_FILE_BYTES,
  LIFECYCLE_MAX_TEXT,
  buildLifecycleRecord,
  classifyLifecycleRecords,
  createLifecycleRecorder,
  installProcessDiagnostics,
  resolveLifecycleLogPath,
  sanitizeText,
} from "../dist/lifecycle.js";

const NOW = Date.UTC(2026, 9, 20, 15, 0, 0);

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-lifecycle-"));
  return { dir, file: path.join(dir, name) };
}

describe("diagnóstico de ciclo de vida — sanitização", () => {
  test("remove emails, Bearer e sequências que pareçam tokens", () => {
    const texto = sanitizeText(
      "falhou para aluno.exemplo+dev@cybersafe.invalid com Authorization: Bearer abc.def-123 e chave " +
        "A".repeat(48),
    );
    assert.ok(texto);
    assert.doesNotMatch(texto, /aluno\.exemplo/);
    assert.match(texto, /<email>/);
    assert.doesNotMatch(texto, /abc\.def-123/);
    assert.doesNotMatch(texto, /A{40}/);
    assert.match(texto, /<redacted>/);
  });

  test("colapsa para uma linha e corta ao tecto", () => {
    const texto = sanitizeText(`linha1\r\nlinha2\tfim ${"palavra ".repeat(80)}`);
    assert.ok(texto);
    assert.doesNotMatch(texto, /[\r\n\t]/);
    assert.ok(texto.length <= LIFECYCLE_MAX_TEXT + 1, String(texto.length));
    assert.ok(texto.endsWith("…"));
    assert.ok(texto.startsWith("linha1 linha2 fim"));
  });

  test("uma sequência longa alfanumérica é redigida, não truncada", () => {
    const texto = sanitizeText(`chave ${"A".repeat(48)}`);
    assert.ok(texto);
    assert.equal(texto, "chave <redacted>");
  });

  test("entradas vazias não produzem campo", () => {
    assert.equal(sanitizeText(""), undefined);
    assert.equal(sanitizeText("   \r\n "), undefined);
    assert.equal(sanitizeText(undefined), undefined);
    assert.equal(sanitizeText(null), undefined);
  });
});

describe("diagnóstico de ciclo de vida — registo puro", () => {
  test("forma do registo com relógio e pid injectados", () => {
    const rec = buildLifecycleRecord("listening", { port: 4100 }, { now: () => NOW, pid: 4242, startedAt: NOW - 1500 });
    assert.deepEqual(rec, {
      at: "2026-10-20T15:00:00.000Z",
      kind: "listening",
      pid: 4242,
      uptimeMs: 1500,
      port: 4100,
    });
  });

  test("erro vira name/code/message/stack sem stack completa nem segredo", () => {
    const err = Object.assign(new Error("falhou a ligação para utilizador@exemplo.pt"), {
      code: "ECONNREFUSED",
      stack: "Error: x\n  at a\n  at b\n  at c\n  at d",
    });
    const rec = buildLifecycleRecord("uncaught-exception", { error: err }, { now: () => NOW, pid: 1 });
    assert.equal(rec.name, "Error");
    assert.equal(rec.code, "ECONNREFUSED");
    assert.match(rec.message ?? "", /<email>/);
    assert.doesNotMatch(rec.message ?? "", /utilizador@/);
    assert.ok((rec.stack ?? "").includes("at b"));
    assert.doesNotMatch(rec.stack ?? "", /at d/);
  });

  test("erro que não é Error nem string continua serializável", () => {
    const rec = buildLifecycleRecord("unhandled-rejection", { error: { code: 42 } }, { now: () => NOW, pid: 1 });
    assert.equal(rec.message, '{"code":42}');
    const circular = {};
    circular.self = circular;
    const rec2 = buildLifecycleRecord("unhandled-rejection", { error: circular }, { now: () => NOW, pid: 1 });
    assert.equal(rec2.message, "<valor não serializável>");
  });
});

describe("diagnóstico de ciclo de vida — caminho do ficheiro", () => {
  test("por omissão fica ao lado da DB", () => {
    const p = resolveLifecycleLogPath({}, path.join("C:", "dados", "cybersafe.db"));
    assert.equal(path.basename(p), LIFECYCLE_LOG_FILENAME);
    assert.equal(path.dirname(p), path.join("C:", "dados"));
  });

  test("CYBERSAFE_API_DIAG_LOG explícito ganha", () => {
    const p = resolveLifecycleLogPath({ CYBERSAFE_API_DIAG_LOG: path.join("C:", "t", "x.jsonl") }, "C:\\d\\a.db");
    assert.equal(p, path.resolve(path.join("C:", "t", "x.jsonl")));
  });

  test("DB em memória não escreve na raiz do disco", () => {
    const p = resolveLifecycleLogPath({}, ":memory:");
    assert.equal(path.dirname(p), process.cwd());
  });
});

describe("diagnóstico de ciclo de vida — escritor best-effort", () => {
  test("acrescenta uma linha JSON por registo", () => {
    const { dir, file } = tempFile("l.jsonl");
    const rec = createLifecycleRecorder({ file, now: () => NOW, pid: 7, startedAt: NOW });
    rec.record("startup", { reason: "module-evaluated" });
    rec.record("listening", { port: 4100 });
    const linhas = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(linhas.length, 2);
    assert.equal(JSON.parse(linhas[0]).kind, "startup");
    assert.equal(JSON.parse(linhas[1]).port, 4100);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("cria o directório em falta", () => {
    const { dir } = tempFile("x");
    const file = path.join(dir, "a", "b", "l.jsonl");
    createLifecycleRecorder({ file, now: () => NOW }).record("startup");
    assert.ok(fs.existsSync(file));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("o ficheiro roda para .1 em vez de crescer sem limite", () => {
    const { dir, file } = tempFile("grande.jsonl");
    fs.writeFileSync(file, "x".repeat(LIFECYCLE_MAX_FILE_BYTES));
    createLifecycleRecorder({ file, now: () => NOW, pid: 1 }).record("startup");
    assert.ok(fs.existsSync(`${file}.1`), "devia existir o historico .1");
    assert.ok(fs.statSync(file).size < 1024, String(fs.statSync(file).size));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("falha de escrita não lança nem derruba o serviço", () => {    const avisos = [];
    const rec = createLifecycleRecorder({
      file: "Z:\\nao\\existe\\l.jsonl",
      appendFile: () => {
        throw new Error("disco cheio");
      },
      onError: (m) => avisos.push(m),
    });
    assert.equal(rec.record("startup"), null);
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], /indisponível/);
  });
});

describe("diagnóstico de ciclo de vida — handlers de processo", () => {
  function harness(overrides = {}) {
    const proc = new EventEmitter();
    const escritos = [];
    const saidas = [];
    const mensagens = [];
    const recorder = createLifecycleRecorder({
      file: "mem.jsonl",
      appendFile: (_f, line) => escritos.push(JSON.parse(line)),
      now: () => NOW,
      pid: 99,
    });
    installProcessDiagnostics(recorder, {
      process: proc,
      exit: (code) => saidas.push(code),
      log: (m) => mensagens.push(m),
      env: {},
      ...overrides,
    });
    return { proc, escritos, saidas, mensagens };
  }

  test("excepção não apanhada: regista e sai com 1", () => {
    const { proc, escritos, saidas } = harness();
    proc.emit("uncaughtException", new Error("boom"));
    assert.equal(escritos.length, 1);
    assert.equal(escritos[0].kind, "uncaught-exception");
    assert.equal(escritos[0].message, "boom");
    assert.deepEqual(saidas, [1]);
  });

  test("rejeição sem handler: regista e o serviço continua", () => {
    const { proc, escritos, saidas } = harness();
    proc.emit("unhandledRejection", new Error("promessa esquecida"));
    assert.equal(escritos[0].kind, "unhandled-rejection");
    assert.deepEqual(saidas, []);
  });

  test("modo estrito por env termina com 1", () => {
    const { proc, saidas } = harness({ env: { CYBERSAFE_API_STRICT_REJECTIONS: "1" } });
    proc.emit("unhandledRejection", new Error("x"));
    assert.deepEqual(saidas, [1]);
  });

  test("o registo nunca leva o segredo JWT nem o corpo de um pedido", () => {
    const { proc, escritos } = harness();
    const err = new Error("upstream recusou Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def");
    proc.emit("uncaughtException", err);
    const linha = JSON.stringify(escritos[0]);
    assert.doesNotMatch(linha, /eyJhbGciOiJIUzI1NiJ9/);
    assert.doesNotMatch(linha, /password/i);
  });
});

describe("diagnóstico de ciclo de vida — veredicto a partir dos registos", () => {
  const kinds = (...k) => k.map((kind) => ({ kind }));

  test("encerramento com sinal é limpo", () => {
    const r = classifyLifecycleRecords(kinds("startup", "listening", "signal", "shutdown"));
    assert.equal(r.verdict, "clean-shutdown");
    assert.match(r.reason, /sinal/);
  });

  test("excepção não apanhada é crash JS, mesmo com escuta registada", () => {
    const r = classifyLifecycleRecords(kinds("listening", "uncaught-exception"));
    assert.equal(r.verdict, "js-crash");
  });

  test("escuta sem sinal, encerramento ou excepção é morte externa (0xC000013A / taskkill)", () => {
    const r = classifyLifecycleRecords(kinds("startup", "listening"));
    assert.equal(r.verdict, "external-kill");
    assert.match(r.reason, /por fora/);
  });

  test("sem escuta é falha antes do listener (ex.: JWT ausente)", () => {
    const r = classifyLifecycleRecords(kinds("startup", "shutdown"));
    assert.equal(r.verdict, "clean-shutdown");
    assert.equal(classifyLifecycleRecords(kinds("startup")).verdict, "never-started");
    assert.equal(classifyLifecycleRecords([]).verdict, "never-started");
    assert.equal(classifyLifecycleRecords([null, "lixo", 42]).verdict, "never-started");
  });
});
