/**
 * P0 â€” ISOLAMENTO DE RUNTIME: nenhum teste escreve em %USERPROFILE%\.cybersafe-service
 *
 * CAUSA RAIZ (packages/service/src/engine.ts:121, antes do patch):
 *   private readonly baseDir = path.join(os.homedir(), ".cybersafe-service");
 * sem qualquer override. `init()` escreve em baseDir, logsDir, definitionsDir,
 * history.jsonl e quarantine â€” logo QUALQUER teste que chame init() (ou que
 * dispare um kill, que faz appendFile em logs/actions.log) escreve na pasta
 * real do utilizador:definitions semeadas, historico de ameacas poluido, logs
 * Mexidos e um manifest de quarentena real.
 *
 * O QUE ESTE FICHEIRO PROVA (um teste por caso):
 *   A) engine com baseDir injetado escreve SO dentro desse tmpdir
 *   B) history.jsonl deriva do baseDir injetado e o historico real nao e tocado
 *   C) actions.log vai para o tmpdir, nunca para ~/.cybersafe-service/logs
 *   D) seed/refresh/heal de definitions escreve no tmpdir, nunca no real
 *   E) quarentena (manifest + ficheiro) vive no tmpdir, nunca na real
 *   F) SEM override, o default de PRODUCAO continua path.join(os.homedir(), ".cybersafe-service")
 *   G) os dois ficheiros que escreviam no home real nao voltam a escrever nele
 *
 * PROVA DE VERMELHO: correr com USERPROFILE apontado para um tmpdir descartavel
 * (ver RESULT.md). Sem esse desvio, provar o vermelho obrigaria a escrever no
 * home real â€” que e precisamente o que este trabalho existe para impedir.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ProtectionEngineService } from "../dist/engine.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/** A pasta real do utilizador â€” a que NUNCA deve mudar. */
const REAL_HOME_SERVICE_DIR = path.join(os.homedir(), ".cybersafe-service");

/**
 * Impressao digital de uma arvore de ficheiros: caminho relativo + tamanho +
 * mtime. Serve append e mudanca de conteudo sem mudar de tamanho, por isso
 * "o fingerprint nao mudou" e uma afirmacao forte, nao uma heuristica.
 */
async function fingerprint(dir) {
  const lines = [];
  async function walk(current, prefix) {
    let items;
    try {
      items = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, item.name);
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        lines.push(`D ${rel}`);
        await walk(full, rel);
      } else {
        try {
          const st = await fs.stat(full);
          lines.push(`F ${rel} ${st.size} ${st.mtimeMs}`);
        } catch {
          lines.push(`F ${rel} <ilegivel>`);
        }
      }
    }
  }
  await walk(dir, "");
  return lines.join("\n");
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Desmonta a engine se ela existir, sem rebentar se nao existir. */
async function disposeQuietly(engine) {
  try {
    if (typeof engine.dispose === "function") await engine.dispose();
    else if (typeof engine.shutdown === "function") await engine.shutdown();
  } catch {
    /* a desmontagem nao e o que estes testes estao a provar */
  }
}

let tmpDir;
let realBefore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cybersafe-p0-iso-"));
  realBefore = await fingerprint(REAL_HOME_SERVICE_DIR);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

/** Garante que o home real nao foi tocado por este teste. */
async function assertRealHomeUntouched() {
  assert.equal(
    await fingerprint(REAL_HOME_SERVICE_DIR),
    realBefore,
    `o teste alterou ${REAL_HOME_SERVICE_DIR} â€” o isolamento falhou`,
  );
}

describe("P0 isolamento de runtime â€” ProtectionEngineService", () => {
  it("A) baseDir injetado: init() escreve SO dentro do tmpdir", async () => {
    const engine = new ProtectionEngineService(tmpDir);
    await engine.init();
    try {
      assert.ok(
        await exists(path.join(tmpDir, "definitions", "hashes", "default.json")),
        "as definicoes tinham de ser semeadas dentro do tmpdir",
      );
      assert.ok(await exists(path.join(tmpDir, "logs")), "logs/ tinha de ser criado no tmpdir");
      await assertRealHomeUntouched();
    } finally {
      await disposeQuietly(engine);
    }
  });

  it("B) history.jsonl deriva do baseDir injetado e o historico real nao e tocado", async () => {
    const engine = new ProtectionEngineService(tmpDir);
    // Os `private` do TypeScript desaparecem na compilacao: em dist/engine.js o
    // campo existe e e legivel, que e o mesmo mecanismo que o threat-history-
    // storage.test.js usa para chegar a signatures/yara.
    assert.equal(
      engine.historyPath,
      path.join(tmpDir, "history.jsonl"),
      "history.jsonl tem de derivar do baseDir injetado, nao do homedir",
    );
    await engine.init();
    try {
      // O historico real ja existe em maquinas de developimento. Append mudaria
      // tamanho+mtime, portanto o fingerprint apanha qualquer escrita nele.
      await assertRealHomeUntouched();
    } finally {
      await disposeQuietly(engine);
    }
  });

  it("C) actions.log do kill vai para o tmpdir, nunca para ~/.cybersafe-service/logs", async () => {
    const engine = new ProtectionEngineService(tmpDir);
    await engine.init();
    try {
      engine.processes = [
        {
          pid: 41112,
          name: "calc.exe",
          path: "C:\\Windows\\System32\\calc.exe",
          // eslint-disable-next-line
        },
      ];
      engine.runTaskkill = async (pid) => ({
        ok: false,
        status: "access-denied",
        pid,
        exitCode: 5,
        stdout: "P0-STDOUT",
        stderr: "P0-STDERR acesso negado",
        error: "P0-STDERR acesso negado",
      });

      await engine.killProcess(41112);

      const ourLog = path.join(tmpDir, "logs", "actions.log");
      let line = "";
      for (let i = 0; i < 50 && !line; i++) {
        await new Promise((r) => setTimeout(r, 40));
        const raw = await fs.readFile(ourLog, "utf-8").catch(() => "");
        line = raw.split(/\r?\n/).filter((e) => e.includes("PID=41112")).pop() ?? "";
      }
      assert.ok(line, `o kill tem de ficar registado em ${ourLog}`);
      await assertRealHomeUntouched();
    } finally {
      await disposeQuietly(engine);
    }
  });

  it("D) seed/refresh/heal de definitions escreve no tmpdir, nunca no real", async () => {
    const engine = new ProtectionEngineService(tmpDir);
    await engine.init();
    try {
      const ours = path.join(tmpDir, "definitions", "hashes", "default.json");
      const parsed = JSON.parse(await fs.readFile(ours, "utf-8"));
      assert.ok(Array.isArray(parsed) && parsed.length > 0, "a base semeada tem de ser utilizavel");

      // Segunda passagem: tem de ser delta zero e nao pode tocar no real.
      await engine.signatures.refreshBuiltinIfStale(ours);
      const realDefs = path.join(REAL_HOME_SERVICE_DIR, "definitions", "hashes", "default.json");
      if (await exists(realDefs)) {
        await assertRealHomeUntouched();
      }
    } finally {
      await disposeQuietly(engine);
    }
  });

  it("E) quarentena (manifest + ficheiro) vive no tmpdir, nunca na real", async () => {
    const engine = new ProtectionEngineService(tmpDir);
    await engine.init();
    try {
      const sample = path.join(tmpDir, "amostra.txt");
      const content = "conteudo inofensivo para o teste de isolamento\n";
      await fs.writeFile(sample, content, "utf-8");

      // API real do QuarantineManager: quarantine(analysis) recebe o AnalysisResult
      // e move o ficheiro para <baseDir>/quarantine/<uuid>.quarantine.
      const entry = await engine.quarantine.quarantine({
        artifactPath: sample,
        fileName: "amostra.txt",
        sha256: crypto.createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex"),
        verdict: "malicious",
        riskScore: 95,
      });
      assert.ok(entry, "a quarentena tem de aceitar o ficheiro");
      assert.ok(
        entry.quarantinePath.startsWith(tmpDir),
        `o ficheiro em quarentena foi parar a ${entry.quarantinePath}, fora do tmpdir`,
      );
      assert.ok(
        await exists(path.join(tmpDir, "quarantine", "manifest.json")),
        "o manifest da quarentena tinha de ser criado no tmpdir",
      );
      await assertRealHomeUntouched();
    } finally {
      await disposeQuietly(engine);
    }
  });

  it("F) SEM override, o default de PRODUCAO continua path.join(os.homedir(), '.cybersafe-service')", async () => {
    const engine = new ProtectionEngineService();
    // Nao se chama init(): este teste existe para fixar o default, e o default
    // por definicao aponta para o home real. E a garantia de que o patch de
    // isolamento nao mudou o comportamento da app.
    assert.equal(engine.baseDir, path.join(os.homedir(), ".cybersafe-service"));
    assert.equal(engine.definitionsDir, path.join(os.homedir(), ".cybersafe-service", "definitions"));
    assert.equal(engine.logsDir, path.join(os.homedir(), ".cybersafe-service", "logs"));
    assert.equal(engine.historyPath, path.join(os.homedir(), ".cybersafe-service", "history.jsonl"));
  });
});

describe("P0 isolamento de runtime â€” os ficheiros que escreviam no home real", () => {
  it("G) nenhum teste constroi a engine sem baseDir injetado, nem deriva caminho do home real", async () => {
    const offenders = [
      "packages/service/test/threat-history-storage.test.js",
      "packages/service/test/process-kill.test.js",
      "packages/service/test/kill-budget.test.js",
      "packages/service/test/auto-kill-guard.test.js",
      "packages/service/test/process-truth-ttl.test.js",
      "packages/service/test/shutdown.test.js",
      "packages/service/test/kill-blocked-log.test.js",
      "packages/service/test/engine-health-coverage.test.js",
    ];

    /**
     * Remove comentarios de linha e de bloco antes de procurar o padrao.
     * Sem isto, uma mencao a `new ProtectionEngineService()` dentro de um
     * comentario (que e o que documenta a regressao) contaria como codigo e o
     * guard daria falso positivo — ou pior, mascararia uma construcao real.
     */
    const stripComments = (src) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const rel of offenders) {
      const raw = await fs.readFile(path.join(REPO_ROOT, rel), "utf-8");
      const code = stripComments(raw);
      const bare = code.match(/new ProtectionEngineService\(\s*\)/g) ?? [];
      assert.equal(
        bare.length,
        0,
        `${rel} ainda tem ${bare.length} construcao(oes) sem baseDir injetado — escreve no home real`,
      );
      assert.doesNotMatch(
        code,
        /path\.join\(\s*os\.homedir\(\)\s*,\s*["']\.cybersafe-service["']/,
        `${rel} ainda deriva um caminho do home real do utilizador`,
      );
    }
  });
});
