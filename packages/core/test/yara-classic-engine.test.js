import { describe, it } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  YARA_BINARY_ENV,
  YARA_CLASSIC_VERSION,
  createYaraClassicScanner,
  parseRuleMeta,
  parseYaraScanOutput,
  resolveYaraClassicBinaries,
  validateYaraFile,
  validateYaraSource,
} from "../dist/yara-classic.js";
import { YaraEngine, YaraScanError } from "../dist/yara.js";

/**
 * MOTOR YARA CLÁSSICO OFICIAL — contrato de execução e desfechos.
 *
 * TP-PAP-FREEBUFF-YARA-CLASSIC-REPLACEMENT-20261027.
 *
 * ── O que mudou ────────────────────────────────────────────────────────────
 * O motor de regras deixou de ser um binding Node-API cuja cadeia de parsing
 * bloqueava a distribuição (o aviso de copyright do último componente não era
 * recuperável de fonte versionada) e passou a ser o executável OFICIAL da
 * VirusTotal, vendorizado em `vendor/yara` com o `COPYING.txt` publicado ao
 * lado (BSD-3-Clause, com o aviso de copyright do upstream). `yara.ts` mantém a
 * API pública, a saúde e a cobertura; `yara-classic.ts` é o adapter que fala
 * com os dois executáveis (`yara64.exe`, `yarac64.exe`).
 *
 * ── O que este ficheiro fixa ───────────────────────────────────────────────
 *  1. PROVENIÊNCIA — os binários resolvidos batem byte a byte (bytes + sha256)
 *     com o `VENDOR.json`, a versão respondida é a versão vendorizada, o aviso
 *     BSD-3-Clause viaja com o binário e o override por ambiente é
 *     AUTORITATIVO: sem binários no directório indicado o motor fica
 *     indisponível em vez de carregar outro executável encontrado por acaso.
 *  2. COMPILAÇÃO — o exit code manda: sintaxe inválida, módulo desconhecido,
 *     regra duplicada e string não referenciada são ERRO. As duas últimas são
 *     diferenças MEDIDAS face ao binding anterior (que avisava em vez de
 *     falhar); ficam aqui fixadas para não serem redescobertas por acidente.
 *     Sem compilador, nada é aceite — nem uma fonte que compile bem noutro
 *     motor.
 *  3. SCAN — positivo casa e traz os metadados lidos do próprio corpus;
 *     negativo é `[]` com exit 0; um alvo inexistente é ERRO, nunca "ficheiro
 *     limpo" (lista vazia só existe com exit 0).
 *  4. PRAZO — um scan que não termina a tempo é morto e classificado como
 *     `timeout`; um prazo vencido NUNCA vale uma lista vazia.
 *  5. INDISPONIBILIDADE — sem binários, `match`/`scanFile` recusam-se a
 *     avaliar (`unavailable`) em vez de devolverem zero matches.
 *
 * Fixtures SINTÉTICAS e inofensivas, todas em `%TEMP%`: nada aqui contém nem
 * escreve a assinatura EICAR em disco (ver o guard `eicar-manual-opt-in`).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_RULES = path.resolve(HERE, "..", "definitions", "yara", "default.yar");
const SERVICE_RULES = path.resolve(HERE, "..", "..", "service", "definitions", "yara", "default.yar");
const REAL_CORPUS_FIXTURE = path.resolve(HERE, "fixtures", "yara-eicar-only-real-corpus.yar");

/** Agulha própria: não é material de antivírus, não dispara o Defender. */
const NEEDLE = "CYBERSAFE-CLASSIC-LANE-NEEDLE-A7";
const OTHER = "CYBERSAFE-CLASSIC-LANE-NEEDLE-B8";

const POSITIVE_RULE = `
rule cybersafe_classic_lane_positive
{
  meta:
    description = "Regra sintetica da lane; nao e cobertura de malware"
    cybersafe_evidence = "strong"

  strings:
    $needle = "${NEEDLE}"

  condition:
    $needle
}
`;

/**
 * Regra com retrocesso catastrofico (`((a|aa)+)+`). Medido nesta lane: sobre
 * 50 000 bytes de `a` o `yara64` 4.6.0 não termina em 60 s. É o que permite
 * provar o prazo sem inventar um binário falso.
 */
const SLOW_RULE = `
rule cybersafe_classic_lane_slow
{
  strings:
    $a = /((a|aa)+)+/
  condition:
    $a
}
`;
const SLOW_TARGET_BYTES = 50_000;
const SLOW_SCAN_TIMEOUT_MS = 900;

const tmpRoots = [];
function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-yara-classic-"));
  tmpRoots.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function write(dir, name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const binaries = resolveYaraClassicBinaries();
const vendorManifestPath = binaries ? path.join(binaries.dir, "VENDOR.json") : null;
const vendorManifest = vendorManifestPath && fs.existsSync(vendorManifestPath)
  ? JSON.parse(fs.readFileSync(vendorManifestPath, "utf-8"))
  : null;

describe("binários oficiais — resolução e proveniência", () => {
  it("resolve os dois executáveis oficiais", () => {
    assert.ok(
      binaries,
      "o motor YARA clássico não resolve: sem `vendor/yara` (ou `resources/yara` empacotado) " +
        "não existe análise por regras — e um motor ausente não pode passar como motor testado.",
    );
    assert.equal(path.basename(binaries.yara), "yara64.exe");
    assert.equal(path.basename(binaries.yarac), "yarac64.exe");
    assert.equal(path.basename(binaries.dir), "yara");
  });

  it("o VENDOR.json bate byte a byte com o que está no disco e declara a licença", () => {
    assert.ok(vendorManifest, `manifesto de proveniência ausente: ${vendorManifestPath}`);
    assert.equal(vendorManifest.engine, "yara-classic");
    assert.equal(vendorManifest.license, "BSD-3-Clause");
    assert.equal(vendorManifest.version, YARA_CLASSIC_VERSION);
    assert.equal(vendorManifest.repository, "https://github.com/VirusTotal/yara");
    assert.match(vendorManifest.archive.url, /^https:\/\/github\.com\/VirusTotal\/yara\/releases\/download\/v/);

    const listed = new Map(vendorManifest.files.map((entry) => [entry.path, entry]));
    for (const name of ["yara64.exe", "yarac64.exe"]) {
      const entry = listed.get(name);
      assert.ok(entry, `${name} não está no manifesto de proveniência`);
      const file = path.join(binaries.dir, name);
      assert.ok(fs.existsSync(file), `${name} está no manifesto mas não existe em ${binaries.dir}`);
      assert.equal(fs.statSync(file).size, entry.bytes, `${name}: bytes medidos != bytes declarados`);
      assert.equal(sha256(file), entry.sha256, `${name}: sha256 medido != sha256 declarado`);
    }

    // O COPYING é texto: um checkout Windows pode convertê-lo para CRLF. O
    // manifesto publica os bytes canónicos (LF), por isso o hash é medido
    // sobre o conteúdo normalizado, não sobre o estado local do checkout.
    const copyingEntry = listed.get("COPYING.txt");
    assert.ok(copyingEntry, "COPYING.txt não está no manifesto de proveniência");
    const copyingText = fs.readFileSync(path.join(binaries.dir, "COPYING.txt"), "utf8").replace(/\r\n/g, "\n");
    assert.equal(Buffer.byteLength(copyingText, "utf8"), copyingEntry.bytes, "COPYING.txt: bytes canónicos != declarados");
    assert.equal(
      crypto.createHash("sha256").update(copyingText, "utf8").digest("hex"),
      copyingEntry.sha256,
      "COPYING.txt: sha256 canónico != declarado",
    );

    // O aviso de copyright tem de acompanhar o binário: sem ele não há
    // distribuição legítima, mesmo com o motor a funcionar.
    const license = fs.readFileSync(path.join(binaries.dir, "COPYING.txt"), "utf-8");
    assert.match(license, /Copyright \(c\) 2007-2016\. The YARA Authors\. All Rights Reserved\./);
    assert.match(license, /Redistributions of source code must retain the above copyright notice/);
    assert.match(license, /Redistributions in binary form must reproduce the above copyright notice/);
    assert.match(license, /Neither the name of the copyright holder/);
  });

  it("o binário responde com a versão vendorizada (sem shell, argumentos separados)", () => {
    const result = spawnSync(binaries.yara, ["--version"], { encoding: "utf-8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || String(result.error?.message));
    assert.equal(result.stdout.trim(), YARA_CLASSIC_VERSION);
    assert.equal(binaries.yara.includes(" "), false, "o caminho do binário não pode exigir shell");
  });

  it("o override por ambiente é autoritativo: sem binários não há motor, sem recurso a outro executável", () => {
    const empty = tmpdir();
    assert.equal(
      resolveYaraClassicBinaries({ [YARA_BINARY_ENV]: empty }),
      null,
      "um directório indicado sem binários tem de ser indisponibilidade declarada, não licença para carregar outro",
    );
    const pinned = resolveYaraClassicBinaries({ [YARA_BINARY_ENV]: binaries.dir });
    assert.equal(pinned?.yarac, path.join(path.resolve(binaries.dir), "yarac64.exe"));
  });
});

describe("compilação — o exit code é a verdade", () => {
  it("fonte válida compila sem diagnóstico de erro", () => {
    const diagnostics = validateYaraSource(POSITIVE_RULE, { binaries });
    assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), []);
  });

  it("erro de sintaxe é ERRO nomeado, nunca aceite em silêncio", () => {
    const diagnostics = validateYaraSource('rule quebrada { strings: $a = "AB" condition: }', { binaries });
    const errors = diagnostics.filter((d) => d.severity === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "syntax-error");
    assert.equal(typeof errors[0].line, "number");
  });

  it("módulo desconhecido é ERRO nomeado", () => {
    const diagnostics = validateYaraSource('import "modulo_que_nao_existe"\nrule usa_modulo { condition: true }', { binaries });
    assert.deepEqual(
      diagnostics.filter((d) => d.severity === "error").map((d) => d.code),
      ["unknown-module"],
    );
  });

  it("regra duplicada é ERRO (o compilador clássico não publica códigos E0xx: a categoria é derivada)", () => {
    const diagnostics = validateYaraSource("rule a { condition: true }\nrule a { condition: false }", { binaries });
    assert.deepEqual(
      diagnostics.filter((d) => d.severity === "error").map((d) => d.code),
      ["duplicate-rule"],
    );
  });

  it("string não referenciada é ERRO (diferença medida face ao binding anterior, que avisava)", () => {
    const diagnostics = validateYaraSource('rule com_sobra { strings: $a = "AAA" $b = "BBB" condition: $a }', { binaries });
    assert.deepEqual(
      diagnostics.filter((d) => d.severity === "error").map((d) => d.code),
      ["unreferenced-string"],
    );
  });

  it("sem compilador, nada é aceite — nem uma fonte que compilaria noutro motor", () => {
    const empty = tmpdir();
    const previous = process.env[YARA_BINARY_ENV];
    process.env[YARA_BINARY_ENV] = empty;
    try {
      const diagnostics = validateYaraSource(POSITIVE_RULE);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].severity, "error");
      assert.equal(diagnostics[0].code, "io-error");
      assert.match(diagnostics[0].message, /não encontrado/);
    } finally {
      if (previous === undefined) delete process.env[YARA_BINARY_ENV];
      else process.env[YARA_BINARY_ENV] = previous;
    }
  });

  it("os corpora reais do produto compilam no motor clássico", () => {
    for (const corpus of [CORE_RULES, SERVICE_RULES, REAL_CORPUS_FIXTURE]) {
      assert.ok(fs.existsSync(corpus), `corpus ausente: ${corpus}`);
      const errors = validateYaraFile(corpus, { binaries }).filter((d) => d.severity === "error");
      assert.deepEqual(errors, [], `${path.basename(corpus)} não compila no YARA clássico`);
    }
  });
});

describe("adapter fix — bytes, lifecycle e output", () => {
  function scannerFor(source, options = {}) {
    const dir = tmpdir();
    const rulesPath = write(dir, "regras.yar", source);
    return { dir, scanner: createYaraClassicScanner({ rulesPath, binaries, ...options }) };
  }

  it("buffer usa tamanho, offsets e bytes exatos, incluindo NUL e buffer vazio", () => {
    const { scanner } = scannerFor(`
rule exact_bytes { condition: filesize == 5 and uint8(0) == 0 and uint8(1) == 255 and uint8(4) == 42 }
rule empty_bytes { condition: filesize == 0 }
`);
    assert.deepEqual(scanner.scan(Buffer.from([0, 255, 7, 8, 42])).map(m => m.ruleIdentifier), ["exact_bytes"]);
    assert.deepEqual(scanner.scan(Buffer.from([0, 255, 7, 8, 41])), []);
    assert.deepEqual(scanner.scan(Buffer.alloc(0)).map(m => m.ruleIdentifier), ["empty_bytes"]);
  });

  it("buffer nao inclui bytes do runtime Node", () => {
    const { scanner } = scannerFor('rule node_runtime { strings: $x = "node:child_process" condition: $x }');
    assert.deepEqual(scanner.scan(Buffer.from("BENIGN-ONLY-ADAPTER-FIX")), []);
  });

  it("parser recusa linhas malformadas, identificadores invalidos e alvo errado", () => {
    for (const text of ["garbage", "\n", "bad-rule target\n", "r\n", "r other.txt\n"]) {
      assert.throws(() => parseYaraScanOutput(text, undefined, "expected.txt"), /output|saída|parser|alvo/i);
    }
    assert.deepEqual(parseYaraScanOutput("", undefined, "expected.txt"), []);
    assert.equal(parseYaraScanOutput("good expected.txt\n", undefined, "expected.txt")[0].ruleIdentifier, "good");
  });

  it("output acima do limite e erro, nao lista vazia nem resultados truncados", async () => {
    const { dir, scanner } = scannerFor(Array.from({length: 40}, (_, i) => `rule hit_${i} { condition: true }`).join("\n"), { maxOutputBytes: 64 });
    const file = write(dir, "benigno.txt", "BENIGN-OUTPUT-FIX");
    await assert.rejects(() => scanner.scanFileAsync(file), /output|saída/i);
    assert.throws(() => scanner.scan(Buffer.from("BENIGN-OUTPUT-FIX")), /output|saída/i);
  });

  it("console.log do motor real nao pode ser interpretado como regra ou alvo", async () => {
    const { dir, scanner } = scannerFor('import "console"\nrule log_only { condition: console.log("BAD-PARSER-LINE") and false }');
    const file = write(dir, "benigno.txt", "BENIGN-CONSOLE-FIX");
    await assert.rejects(() => scanner.scanFileAsync(file), /output|saída|parser/i);
  });

  it("cancelamento externo termina com erro e PID terminado ou morte explicitamente nao confirmada", async () => {
    const { dir, scanner } = scannerFor(SLOW_RULE);
    const file = write(dir, "lento.txt", "a".repeat(SLOW_TARGET_BYTES));
    const controller = new AbortController();
    const work = scanner.scanFileAsync(file, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 80);
    try {
      await assert.rejects(() => work, error => {
        assert.equal(error.code, "cancelled");
        assert.equal(typeof error.terminationConfirmed, "boolean");
        assert.equal(typeof error.pid, "number");
        if (error.terminationConfirmed) assert.throws(() => process.kill(error.pid, 0), { code: "ESRCH" });
        else assert.match(error.message, /não confirmada/);
        return true;
      });
    } finally { clearTimeout(timer); }
  });

  it("prazo por chamada aguarda close ou declara morte nao confirmada", async () => {
    const { dir, scanner } = scannerFor(SLOW_RULE);
    const file = write(dir, "lento.txt", "a".repeat(SLOW_TARGET_BYTES));
    const started = Date.now();
    await assert.rejects(() => scanner.scanFileAsync(file, { timeoutMs: 80 }), error => {
      assert.equal(error.code, "timeout");
      assert.equal(typeof error.terminationConfirmed, "boolean");
      if(error.terminationConfirmed) assert.throws(() => process.kill(error.pid, 0), { code: "ESRCH" });
      return true;
    });
    assert.ok(Date.now() - started < 3000, "o prazo externo foi ignorado");
  });

  it("sinal pre-abortado nao arranca processo", async () => {
    const { dir, scanner } = scannerFor(POSITIVE_RULE);
    const file = write(dir, "alvo.txt", NEEDLE);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => scanner.scanFileAsync(file, { signal: controller.signal }), error => error.code === "cancelled" && error.pid === undefined && error.terminationConfirmed === true);
  });
});

describe("scan — positivo, negativo e erro", () => {
  function scannerFor(rulesSource, options = {}) {
    const dir = tmpdir();
    const rulesPath = write(dir, "corpus.yar", rulesSource);
    return {
      dir,
      scanner: createYaraClassicScanner({
        rulesPath,
        binaries,
        meta: parseRuleMeta(rulesSource),
        ...options,
      }),
    };
  }

  it("positivo casa a regra e traz os metadados lidos do corpus", async () => {
    const { dir, scanner } = scannerFor(POSITIVE_RULE);
    const target = write(dir, "positivo.txt", `inicio ${NEEDLE} fim`);
    const matches = await scanner.scanFileAsync(target);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].ruleIdentifier, "cybersafe_classic_lane_positive");
    assert.equal(matches[0].meta.cybersafe_evidence, "strong");
  });

  it("negativo é lista vazia com exit 0 (vazio medido ≠ vazio por falha)", async () => {
    const { dir, scanner } = scannerFor(POSITIVE_RULE);
    const target = write(dir, "negativo.txt", `sem agulha nenhuma (${OTHER})`);
    assert.deepEqual(await scanner.scanFileAsync(target), []);
  });

  it("alvo inexistente é ERRO, nunca ficheiro limpo", async () => {
    const { dir, scanner } = scannerFor(POSITIVE_RULE);
    await assert.rejects(
      () => scanner.scanFileAsync(path.join(dir, "nao-existe.txt")),
      /NÃO avaliado/,
    );
  });

  it("prazo vencido mata o processo e recusa o resultado", async () => {
    const { dir, scanner } = scannerFor(SLOW_RULE, { timeoutMs: SLOW_SCAN_TIMEOUT_MS });
    const target = write(dir, "lento.txt", "a".repeat(SLOW_TARGET_BYTES));
    await assert.rejects(() => scanner.scanFileAsync(target), /prazo/);
  });
});

describe("YaraEngine e2e — lifecycle real", () => {
  async function engineFor(source) {
    const dir = tmpdir();
    const corpus = write(dir, "corpus.yar", source);
    const engine = new YaraEngine(corpus);
    await engine.load(corpus);
    return { engine, dir };
  }

  // Interceta apenas a referencia do subprocesso REAL criado pelo adaptador.
  // Nao simula resultados YARA nem enumera/termina processos alheios.
  async function observe(run, failKill = false) {
    const originalSpawn = childProcess.spawn;
    const children = [];
    childProcess.spawn = (...args) => {
      const child = originalSpawn(...args);
      const record = { child, closed: false, originalKill: child.kill.bind(child) };
      child.once("close", () => { record.closed = true; });
      if (failKill) child.kill = () => false;
      children.push(record);
      return child;
    };
    syncBuiltinESMExports();
    try { await run(children); }
    finally {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      for (const record of children) {
        if (!record.closed) {
          const closed = new Promise(resolve => record.child.once("close", resolve));
          record.originalKill("SIGKILL");
          await closed;
        }
        if (record.child.pid) assert.throws(() => process.kill(record.child.pid, 0), { code: "ESRCH" });
      }
    }
  }

  it("positivo e negativo reais so terminam depois de close, sem orfaos", async () => {
    const { engine, dir } = await engineFor(POSITIVE_RULE);
    for (const [text, count] of [[NEEDLE, 1], [OTHER, 0]]) {
      const file = write(dir, "alvo.txt", text);
      await observe(async children => {
        const outcome = await engine.scanFileOutcome(file);
        assert.equal(outcome.status, "ok");
        assert.equal(outcome.matches.length, count);
        assert.equal(children.length, 1);
        assert.equal(children[0].closed, true);
      });
    }
  });

  it("buffer por YaraEngine tem filesize/offsets exatos e nao memoria Node", async () => {
    const { engine } = await engineFor('rule bytes { condition: filesize == 3 and uint8(0) == 0 and uint8(2) == 255 }');
    assert.equal(engine.match(Buffer.from([0, 42, 255]))[0].ruleId, "bytes");
    assert.deepEqual(engine.match(Buffer.from([0, 42, 254])), []);
  });

  it("cancelamento durante execucao aguarda encerramento confirmado", async () => {
    const { engine, dir } = await engineFor(SLOW_RULE);
    const file = write(dir, "lento.txt", "a".repeat(SLOW_TARGET_BYTES));
    await observe(async children => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 80);
      try {
        const outcome = await engine.scanFileOutcome(file, { signal: controller.signal, timeoutMs: 5000 });
        assert.equal(outcome.status, "cancelled");
        assert.deepEqual(outcome.matches, []);
        assert.equal(outcome.subprocess.terminationConfirmed, true);
        assert.equal(outcome.subprocess.pid, children[0].child.pid);
        assert.equal(children[0].closed, true);
      } finally { clearTimeout(timer); }
    });
  });

  it("timeout real por YaraEngine aguarda close e mantem codigo timeout", async () => {
    const { engine, dir } = await engineFor(SLOW_RULE);
    const file = write(dir, "lento.txt", "a".repeat(SLOW_TARGET_BYTES));
    await observe(async children => {
      const outcome = await engine.scanFileOutcome(file, { timeoutMs: 80 });
      assert.equal(outcome.status, "timeout");
      assert.equal(outcome.subprocess.terminationConfirmed, true);
      assert.equal(children[0].closed, true);
    });
    await assert.rejects(() => engine.scanFile(file, { timeoutMs: 80 }), error => error.code === "timeout" && error.cause.subprocess.terminationConfirmed === true);
  });

  it("kill recusado e morte nao confirmada sao erro explicito, nunca cancelled limpo", async () => {
    const { engine, dir } = await engineFor(SLOW_RULE);
    const file = write(dir, "lento.txt", "a".repeat(SLOW_TARGET_BYTES));
    await observe(async children => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 80);
      try {
        const outcome = await engine.scanFileOutcome(file, { signal: controller.signal, timeoutMs: 5000 });
        assert.equal(outcome.status, "error");
        assert.deepEqual(outcome.matches, []);
        assert.equal(outcome.subprocess.terminationConfirmed, false);
        assert.equal(outcome.subprocess.reason, "cancelled");
        assert.equal(outcome.subprocess.pid, children[0].child.pid);
        assert.match(outcome.detail, /não confirmada/);
      } finally { clearTimeout(timer); }
    }, true);
  });

  it("output invalido e overflow atravessam engine como error, nao ok vazio", async () => {
    const source = 'import "console"\nrule logs { condition: console.log("INVALID-E2E") and false }';
    const { engine, dir } = await engineFor(source);
    const file = write(dir, "alvo.txt", OTHER);
    assert.equal((await engine.scanFileOutcome(file)).status, "error");
    const many = Array.from({ length: 30 }, (_, i) => `rule r${i} { condition: true }`).join("\n");
    const corpus = write(dir, "many.yar", many);
    engine.scanner = createYaraClassicScanner({ rulesPath: corpus, binaries, maxOutputBytes: 64 });
    const outcome = await engine.scanFileOutcome(file);
    assert.equal(outcome.status, "error");
    assert.deepEqual(outcome.matches, []);
    assert.equal(outcome.subprocess.reason, "output-limit");
    assert.equal(outcome.subprocess.terminationConfirmed, true);
  });
});

describe("motor (YaraEngine) sobre o YARA clássico", () => {
  it("carrega o corpus, fica activo e separa positivo de negativo", async () => {
    const dir = tmpdir();
    const corpus = write(dir, "corpus.yar", POSITIVE_RULE);
    const engine = new YaraEngine(corpus);
    await engine.load(corpus);

    assert.equal(engine.isAvailable, true);
    assert.equal(engine.ruleCount, 1);
    assert.equal(engine.health.status, "active");

    const hits = engine.match(Buffer.from(`lixo antes ${NEEDLE} lixo depois`));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].ruleId, "cybersafe_classic_lane_positive");
    assert.equal(hits[0].evidence, "strong");
    assert.equal(hits[0].severity, "critical");

    assert.deepEqual(engine.match(Buffer.from(`sem agulha (${OTHER})`)), []);
  });

  it("o scan de buffer não reescreve o corpus em disco", async () => {
    const dir = tmpdir();
    const corpus = write(dir, "corpus.yar", POSITIVE_RULE);
    const engine = new YaraEngine(corpus);
    await engine.load(corpus);

    const before = sha256(corpus);
    engine.match(Buffer.from(`x ${NEEDLE} y`));
    assert.equal(sha256(corpus), before, "o corpus em disco mudou durante um scan em memória");
  });

  it("motor indisponível recusa avaliar: match lança, outcome é `unavailable`, scanFile lança YaraScanError", async () => {
    const dir = tmpdir();
    const corpus = write(dir, "corpus.yar", POSITIVE_RULE);
    const target = write(dir, "alvo.txt", `x ${NEEDLE} y`);
    const engine = new YaraEngine(corpus);
    await engine.load(corpus);
    engine.markUnavailable("binários do motor removidos neste teste");

    assert.equal(engine.isAvailable, false);
    assert.throws(() => engine.match(Buffer.from(NEEDLE)), /unavailable/);

    // `scanFileOutcome` tenta recarregar o corpus antes de desistir. Nesta
    // prova o recarregamento é neutralizado de propósito: sem ele, o caminho de
    // recuperação do motor grava o canário no corpus, e o canário contém a
    // assinatura EICAR em disco — o guard `eicar-manual-opt-in` proíbe isso fora
    // do gate manual. O que está sob contrato aqui é o desfecho SEM motor.
    engine.ensureRules = async () => {};

    const outcome = await engine.scanFileOutcome(target);
    assert.equal(outcome.status, "unavailable");
    assert.deepEqual(outcome.matches, []);

    await assert.rejects(
      () => engine.scanFile(target),
      (error) => error instanceof YaraScanError && error.code === "unavailable",
    );
  });

  it("prazo vencido no pipeline é `timeout`, nunca `ok` com zero matches", async () => {
    const dir = tmpdir();
    const corpus = write(dir, "corpus.yar", SLOW_RULE);
    const target = write(dir, "lento.txt", "a".repeat(SLOW_TARGET_BYTES));
    const engine = new YaraEngine(corpus);
    await engine.load(corpus);

    const outcome = await engine.scanFileOutcome(target, { timeoutMs: SLOW_SCAN_TIMEOUT_MS });
    assert.equal(outcome.status, "timeout");
    assert.deepEqual(outcome.matches, []);

    await assert.rejects(
      () => engine.scanFile(target, { timeoutMs: SLOW_SCAN_TIMEOUT_MS }),
      (error) => error instanceof YaraScanError && error.code === "timeout",
    );
  });
});
