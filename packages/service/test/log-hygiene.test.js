import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  LogWriter,
  SyncLogWriter,
  RateLimitedLogger,
  reclaimOversizedLog,
  shouldPersistEvent,
  scanIdFromContext,
  formatScanLog,
  createServiceLogWriters,
  errorLogPath,
  bootDebugLogPath,
  ERROR_LOG_BUDGET,
  BOOT_DEBUG_LOG_BUDGET,
} from "../dist/log-writer.js";

/**
 * Higiene de logs do serviço (Workstream F).
 *
 * Regressão real: `error.log` e `boot-debug.log` em `~/.cybersafe-service`
 * atingiram 3.3 GB e 3.1 GB. Causa raiz: escrita com `fs.appendFileSync` cru,
 * sem rotação nem retenção, alimentada por um ciclo de realimentação EPIPE.
 * Estes testes fixam o orçamento por log, a retenção real (o ficheiro mais
 * antigo é removido), o dedupe com contador e o filtro de eventos persistidos.
 *
 * Sem benchmarks de disco: tudo é determinístico sobre ficheiros pequenos.
 */

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-loghygiene-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const readAll = (dir, name) => {
  const p = path.join(dir, name);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
};

const listLogFiles = (dir, name) =>
  fs
    .readdirSync(dir)
    .filter((f) => f === name || f.startsWith(name + "."))
    .filter((f) => !f.endsWith(".trim"))
    .sort();

describe("rotação e retenção (SyncLogWriter)", () => {
  it("rota quando o ficheiro atinge maxBytes e mantém o histórico em .1", () => {
    // Linhas de ~31 B com orçamento de 200 B ⇒ a 7.ª linha dispara a rotação.
    const w = new SyncLogWriter(tmpDir, "error.log", { maxBytes: 200, maxFiles: 3, dedupeWindowMs: 0 });
    for (let i = 0; i < 10; i++) w.write(`linha ${i} — ${"x".repeat(20)}`);

    const files = listLogFiles(tmpDir, "error.log");
    assert.ok(files.includes("error.log.1"), "deve existir a rotação .1");
    const rotated = readAll(tmpDir, "error.log.1");
    assert.match(rotated, /linha 0/, "o histórico não pode ser perdido na rotação");
    const current = readAll(tmpDir, "error.log");
    assert.match(current, /linha 9/, "a linha mais recente tem de estar no ficheiro activo");
  });

  it("aplica retenção: nunca mantém mais do que maxFiles ficheiros", () => {
    const maxFiles = 2;
    const w = new SyncLogWriter(tmpDir, "error.log", { maxBytes: 100, maxFiles, dedupeWindowMs: 0 });
    for (let i = 0; i < 200; i++) w.write(`linha ${i} — ${"y".repeat(30)}`);

    const files = listLogFiles(tmpDir, "error.log");
    const rotated = files.filter((f) => f !== "error.log");
    assert.ok(
      rotated.length <= maxFiles,
      `retenção falhou: ${rotated.length} ficheiros rotacionados para maxFiles=${maxFiles} (${files.join(", ")})`,
    );
  });

  it("o total em disco fica limitado por maxBytes * (1 + maxFiles)", () => {
    const maxBytes = 200;
    const maxFiles = 3;
    const w = new SyncLogWriter(tmpDir, "error.log", { maxBytes, maxFiles, dedupeWindowMs: 0 });
    for (let i = 0; i < 300; i++) w.write(`linha ${i} — ${"z".repeat(40)}`);

    const total = listLogFiles(tmpDir, "error.log").reduce(
      (sum, f) => sum + fs.statSync(path.join(tmpDir, f)).size,
      0,
    );
    const ceiling = maxBytes * (1 + maxFiles) + 200; // folga para a linha que ultrapassa o limiar
    assert.ok(total <= ceiling, `disco ${total} B acima do orçamento ${ceiling} B`);
  });

  it("nunca lança se o directório não existir / não tiver permissão", () => {
    const w = new SyncLogWriter(path.join(tmpDir, "criado-a-tras"), "error.log", { maxBytes: 1024 });
    assert.doesNotThrow(() => w.write("primeira"));
    assert.match(readAll(path.join(tmpDir, "criado-a-tras"), "error.log"), /primeira/);
  });
});

describe("rotação e retenção (LogWriter assíncrono)", () => {
  it("rota e retém, como o escritor síncrono", async () => {
    const maxFiles = 2;
    const w = new LogWriter(tmpDir, "actions.log", { maxBytes: 150, maxFiles, dedupeWindowMs: 0 });
    for (let i = 0; i < 150; i++) await w.write(`acao ${i} — ${"q".repeat(30)}`);

    const files = listLogFiles(tmpDir, "actions.log");
    const rotated = files.filter((f) => f !== "actions.log");
    assert.ok(rotated.length <= maxFiles, `retenção falhou: ${files.join(", ")}`);
    assert.ok(files.includes("actions.log.1"));
  });

  it("a fila de escritas serializa: writes concorrentes não perdem linhas", async () => {
    const w = new LogWriter(tmpDir, "concurrent.log", { maxBytes: 1024 * 1024, dedupeWindowMs: 0 });
    await Promise.all(Array.from({ length: 50 }, (_, i) => w.write(`linha ${i}`)));
    const content = readAll(tmpDir, "concurrent.log");
    for (let i = 0; i < 50; i++) {
      assert.match(content, new RegExp(`linha ${i}\\b`), `linha ${i} perdida`);
    }
  });
});

describe("dedupe", () => {
  it("suprime linhas consecutivas idênticas dentro da janela", () => {
    const w = new SyncLogWriter(tmpDir, "error.log", { maxBytes: 1024 * 1024, dedupeWindowMs: 60_000 });
    w.write("boom repetido");
    w.write("boom repetido");
    w.write("boom repetido");
    const content = readAll(tmpDir, "error.log");
    const occurrences = content.split("boom repetido").length - 1;
    assert.equal(occurrences, 1, "as repetições dentro da janela devem ser suprimidas");
  });

  it("não perde a informação: fecha o bloco com um contador (xN)", () => {
    const w = new SyncLogWriter(tmpDir, "dup2.log", { maxBytes: 1024 * 1024, dedupeWindowMs: 60_000 });
    w.write("EPIPE: broken pipe");
    w.write("EPIPE: broken pipe");
    w.write("EPIPE: broken pipe");
    w.write("outra coisa");
    const content = readAll(tmpDir, "dup2.log");
    assert.match(content, /EPIPE: broken pipe \(x3\)/, "o bloco repetido deve ser fechado com contador");
    assert.match(content, /outra coisa/);
  });

  it("linhas diferentes nunca são suprimidas", () => {
    const w = new SyncLogWriter(tmpDir, "error.log", { maxBytes: 1024 * 1024, dedupeWindowMs: 60_000 });
    w.write("a");
    w.write("b");
    w.write("c");
    const lines = readAll(tmpDir, "error.log").trim().split("\n");
    assert.equal(lines.length, 3);
  });
});

describe("reclaim de ficheiros giganticamente acima do orçamento", () => {
  it("trunca para maxBytes e rotaciona quando excede maxBytes * maxFiles", () => {
    const p = path.join(tmpDir, "error.log");
    const line = "EPIPE: broken pipe — ".repeat(20) + "\n";
    fs.writeFileSync(p, line.repeat(200), "utf-8");
    const before = fs.statSync(p).size;
    assert.ok(before > 1000);

    reclaimOversizedLog(p, 500, 3);

    const total = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("error.log"))
      .reduce((sum, f) => sum + fs.statSync(path.join(tmpDir, f)).size, 0);
    assert.ok(total <= 500 * (1 + 3) + 200, `reclaim não limitou o disco: ${total} B`);
    assert.ok(!fs.existsSync(path.join(tmpDir, "error.log.trim")), "não deve deixar ficheiros temporários");
  });

  it("abaixo do limite de truncar, apenas rotaciona (nada é apagado)", () => {
    const p = path.join(tmpDir, "small.log");
    const payload = "a".repeat(900);
    fs.writeFileSync(p, payload, "utf-8");
    reclaimOversizedLog(p, 500, 3);
    // Rotacionar move o base para .1 — o conteúdo tem de estar lá, não
    // truncado. O próximo write recria o base.
    assert.ok(fs.existsSync(`${p}.1`), "deve ter sido rotacionado");
    assert.equal(fs.readFileSync(`${p}.1`, "utf-8"), payload, "o conteúdo não pode ser truncado neste regime");
  });

  it("não faz nada se o ficheiro não existir", () => {
    assert.doesNotThrow(() => reclaimOversizedLog(path.join(tmpDir, "nao-existe.log"), 100, 2));
  });
});

describe("orçamento dos logs do serviço", () => {
  it("error.log e boot-debug.log têm orçamento explícito e limitado", () => {
    for (const budget of [ERROR_LOG_BUDGET, BOOT_DEBUG_LOG_BUDGET]) {
      assert.ok(budget.maxBytes > 0, "maxBytes tem de ser positivo");
      assert.ok(budget.maxFiles > 0, "maxFiles tem de ser positivo");
      const totalMb = (budget.maxBytes * (1 + budget.maxFiles)) / (1024 * 1024);
      assert.ok(totalMb <= 64, `orçamento de ${totalMb} MB é demasiado alto para um log local`);
    }
  });

  it("os caminhos dos logs ficam em ~/.cybersafe-service", () => {
    const base = path.join("C:", "Users", "tester", ".cybersafe-service");
    assert.equal(path.basename(errorLogPath(base)), "error.log");
    assert.equal(path.basename(bootDebugLogPath(base)), "boot-debug.log");
  });

  it("createServiceLogWriters aponta para <base>/logs com rotação activa", () => {
    const base = path.join(tmpDir, "svc");
    const { events, actions, logsDir } = createServiceLogWriters(base);
    assert.equal(logsDir, path.join(base, "logs"));
    assert.match(events.filePath, /security-events\.log$/);
    assert.match(actions.filePath, /actions\.log$/);
  });
});

describe("persistência apenas de eventos úteis", () => {
  it("persiste eventos de ameaça/acção", () => {
    for (const type of [
      "process.blocked",
      "process.killed",
      "threat.detected",
      "quarantine.added",
      "quarantine.restored",
      "quarantine.deleted",
      "persistence.detected",
      "engine.health",
    ]) {
      assert.equal(shouldPersistEvent({ type }), true, `${type} deve ser persistido`);
    }
  });

  it("descarta o ruído de alta frequência que inchava security-events.log", () => {
    for (const type of ["file.created", "file.modified", "process.started", "process.exited", "scan.progress"]) {
      assert.equal(shouldPersistEvent({ type }), false, `${type} não deve ser persistido em disco`);
    }
  });

  it("descarta eventos malformados sem launchar", () => {
    for (const bad of [null, undefined, {}, { type: 42 }, "scan.progress"]) {
      assert.equal(shouldPersistEvent(bad), false);
    }
  });
});

describe("correlação de scanId", () => {
  it("extrai o scanId de várias formas de contexto", () => {
    assert.equal(scanIdFromContext({ scanId: "abc" }), "abc");
    assert.equal(scanIdFromContext({ data: { scanId: "def" } }), "def");
    assert.equal(scanIdFromContext({ data: { id: "scan-123" } }), "scan-123");
    assert.equal(scanIdFromContext({ id: "ghi" }), "ghi");
  });

  it("devolve undefined quando não há scanId, sem inventar", () => {
    assert.equal(scanIdFromContext(undefined), undefined);
    assert.equal(scanIdFromContext({}), undefined);
    assert.equal(scanIdFromContext({ data: { id: "nao-e-um-scan" } }), undefined);
  });

  it("formata a linha de log com o scanId apenas quando existe", () => {
    assert.equal(formatScanLog("s1", "scan.start"), "[scan s1] scan.start");
    assert.equal(formatScanLog(undefined, "scan.start"), "scan.start");
  });
});

describe("limitador de taxa de log", () => {
  it("suprime repetições dentro do intervalo e volta a deixar passar depois", () => {
    const rl = new RateLimitedLogger(1000, true);
    assert.equal(rl.admit("scan.excluded", 0), true);
    assert.equal(rl.admit("scan.excluded", 500), false);
    assert.equal(rl.admit("scan.excluded", 900), false);
    assert.equal(rl.suppressedCount("scan.excluded"), 2);
    assert.equal(rl.admit("scan.excluded", 2000), true);
  });

  it("não faz limitação quando desativado", () => {
    const rl = new RateLimitedLogger(1000, false);
    assert.equal(rl.admit("k", 0), false);
    assert.equal(rl.admit("k", 0), false);
  });

  it("mantém chaves independentes", () => {
    const rl = new RateLimitedLogger(1000, true);
    assert.equal(rl.admit("a", 0), true);
    assert.equal(rl.admit("b", 0), true);
    assert.equal(rl.admit("a", 10), false);
    assert.equal(rl.admit("b", 10), false);
  });
});
