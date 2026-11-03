import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { ProtectionEngineService } from "../dist/engine.js";
import { formatKillBlockedLine } from "../dist/logging.js";

/**
 * A7 — a recusa fica registada no `actions.log`.
 *
 * Antes deste packet, uma recusa NUNCA chegava ao actions.log: o
 * `logKillAttempt` corre depois de `runTaskkill`, e a recusa acontece antes.
 * Entre o `console.warn` e o primeiro taskkill nao havia nada escrito. Foi
 * exatamente por isso que o diagnostico do falso positivo `internal` obrigou a
 * ir ao processo enquanto vivia.
 *
 * Estes testes assertam SOBRE A LINHA ESCRITA, nao sobre a existencia de um
 * metodo: o que interessa e que o registo fique legivel por quem chegar
 * depois, e isso so se prova lendo o ficheiro.
 */

function processEntry(overrides = {}) {
  return {
    pid: 4000,
    ppid: 1000,
    name: "alvo.exe",
    path: "C:\\Temp\\alvo.exe",
    commandLine: "C:\\Temp\\alvo.exe",
    cpu: 0,
    memoryMb: 0,
    startedAt: new Date().toISOString(),
    trusted: "unknown",
    ...overrides,
  };
}

let engine;
let logsDir;
let base;

before(async () => {
  base = await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), "kgi-log-"));
  // ISOLAMENTO P0 pela via OFICIAL: o `baseDir` passou a ser injetavel no
  // construtor, por isso este teste nao escreve no `~/.cybersafe-service` real
  // do utilizador sem precisar de reescrever um field `private`. A guarda e a
  // mesma de sempre (logs temporarios), so que agora pela porta certa.
  engine = new ProtectionEngineService(base);
  logsDir = path.join(base, "logs");
  await fs.mkdir(logsDir, { recursive: true });
});

after(async () => {
  try {
    if (engine?.dispose) await engine.dispose();
  } finally {
    if (base) await fs.rm(base, { recursive: true, force: true });
  }
});

async function lerAccoes() {
  try {
    return await fs.readFile(path.join(logsDir, "actions.log"), "utf-8");
  } catch {
    return "";
  }
}

describe("A7 — a recusa manual fica registada no actions.log", () => {
  it("a recusa global é auditada sem inventar classificação do PID", async () => {
    const antes = await lerAccoes();
    const result = await engine.killProcess(4);
    assert.equal(result.success, false);
    assert.equal(result.status, "failed", "a recusa global não classifica o processo");
    assert.match(result.error, /nenhuma ação foi executada/);

    const depois = await lerAccoes();
    assert.notEqual(depois, antes, "a recusa tem de ficar persistida antes da resposta");
    const linhas = depois.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(linhas.length, 1);
    const linha = linhas[0];
    assert.equal(linha.action, "process.termination.refused");
    assert.equal(linha.reason, "legacy-disabled");
    assert.equal(linha.request, "manual");
    assert.match(linha.requestId, /^k[0-9]+-4$/);
    assert.equal(linha.pid, 4);
    assert.equal(linha.executed, false);
    assert.equal(Number.isNaN(Date.parse(linha.timestamp)), false);
    assert.deepEqual(Object.keys(linha).sort(), ["action", "executed", "pid", "reason", "request", "requestId", "timestamp"]);
  });

  it("a linha NAO escreve a linha de comando (privacidade)", () => {
    const linha = formatKillBlockedLine({
      timestamp: "2026-09-30T12:00:00.000Z",
      request: "manual",
      requestId: "k1-10",
      subject: { pid: 10, name: "alvo.exe", path: "C:\\Temp\\alvo.exe", ppid: 5 },
      reason: "internal",
    });
    assert.ok(!linha.includes("commandLine"), "a command line nao entra no registo");
    // O campo Path e o que sobra, e e o que o diagnostico precisa.
    assert.match(linha, /Path=C:\\Temp\\alvo\.exe/);
  });

  it("o formato e o mesmo para as cinco razoes (comparaveis entre si)", () => {
    const razoes = ["self", "ancestor", "internal", "system-pid", "fallback-name"];
    const linhas = razoes.map((reason) => formatKillBlockedLine({
      timestamp: "2026-09-30T12:00:00.000Z",
      request: "manual",
      requestId: "k1-10",
      subject: { pid: 1, name: "n.exe", path: "C:\\n.exe", ppid: 2 },
      requestId: "k3-1",
      reason,
    }));
    // Mesma forma: 11 campos separados por " | ".
    for (const linha of linhas) {
      const campos = linha.split(" | ");
      assert.equal(campos.length, 11, `forma inalterada: ${linha}`);
      assert.equal(campos[1], "[KILL-BLOCKED]");
      assert.match(campos[2], /^Req=k\d+-\d+$/, `Req tem de ser o id: ${linha}`);
    }
    assert.equal(new Set(linhas.map((l) => l.split(" | ")[9])).size, 5, "cada razao fica legivel na sua linha");
  });

  it("A6/DIAG — quatro pedidos reais dao quatro Req diferentes", async () => {
    // A pergunta das 4 repetições, tornada respondível pelo registo: se cada
    // pedido tem o seu `Req=`, quatro linhas com quatro ids são quatro pedidos,
    // e quatro linhas com o MESMO id seriam um pedido escrito quatro vezes.
    const antes = (await lerAccoes()).trim().split("\n").filter(Boolean).length;
    for (let i = 0; i < 4; i += 1) {
      const result = await engine.killProcess(4);
      assert.equal(result.success, false);
      assert.equal(result.status, "failed");
    }
    const linhas = (await lerAccoes()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const novas = linhas.slice(antes);
    assert.equal(novas.length, 4, `esperava 4 linhas novas, obtive ${novas.length}`);
    for (const linha of novas) {
      assert.equal(linha.action, "process.termination.refused");
      assert.equal(linha.reason, "legacy-disabled");
      assert.equal(linha.executed, false);
    }
    const reqs = novas.map((linha) => linha.requestId);
    assert.equal(new Set(reqs).size, 4, `quatro pedidos reais = quatro Req diferentes: ${JSON.stringify(reqs)}`);
  });

  it("Request=auto fica disponivel para o auto-kill", () => {
    const linha = formatKillBlockedLine({
      timestamp: "2026-09-30T12:00:00.000Z",
      request: "auto",
      requestId: "k2-20",
      subject: { pid: 20, name: "x.exe", path: "C:\\x.exe", ppid: 0 },
      reason: "internal",
    });
    assert.match(linha, /Request=auto/);
  });

  it("campos ausentes ficam n/a, nao vazios (o registo tem de ser parseavel)", () => {
    const linha = formatKillBlockedLine({
      timestamp: "2026-09-30T12:00:00.000Z",
      request: "manual",
      requestId: "k1-10",
      subject: { pid: 30 },
      reason: "self",
    });
    assert.match(linha, /Name=n\/a/);
    assert.match(linha, /Path=n\/a/);
    assert.match(linha, /PPID=n\/a/);
  });
});
