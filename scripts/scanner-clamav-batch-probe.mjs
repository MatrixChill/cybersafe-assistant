#!/usr/bin/env node
/**
 * HARNESS DE COMPARAÇÃO POR TAMANHO — P0 SCANNER_RUNTIME_ZERO_PROGRESS.
 *
 * Responde à pergunta que ficou em UNKNOWN: o batch de produção (ClamavBridge
 * real, clamscan real, slot global, lease da base, argv/file-list, parser de
 * progresso) para em ALGUM tamanho? E se para, em que passo exacto?
 *
 * O que faz, e só isto:
 *   1. cria N fixtures BENIGNAS (texto) num directório temporário próprio;
 *   2. corre UM batch real (`ClamavBridge.scanFiles`) por tamanho, UMA vez;
 *   3. recolhe as linhas `[ScanPerf]` do próprio tracing opt-in e imprime a
 *      linha do tempo (evento + ms relativos ao início da promise);
 *   4. mede por fora o que os logs não dão: wall time, pico de filhos NOSSOS
 *      (`bridge.liveChildPids()`), spawns, callbacks de progresso, lease
 *      adquirida/libertada e órfãos com >= 200 MB depois da run.
 *
 * Não corre EICAR. Não corre Quick Scan (nenhum ficheiro do utilizador é
 * tocado). Máximo de um clamscan simultâneo (`maxConcurrent: 1`, o default
 * global). O tracing (`CYBERSAFE_DEBUG_SCAN=1`) é ligado aqui dentro.
 *
 * Uso:
 *   node scripts/scanner-clamav-batch-probe.mjs
 *   PROBE_SIZES=5,20 node scripts/scanner-clamav-batch-probe.mjs
 *   PROBE_TIMEOUT_MS=120000 node scripts/scanner-clamav-batch-probe.mjs
 *   PROBE_KEEP_FIXTURES=1 node scripts/scanner-clamav-batch-probe.mjs
 *
 * As fixtures vivem em `os.tmpdir()`, que é uma das raízes de um Quick Scan.
 * São removidas no fim de cada tamanho — se o harness for morto a meio, o
 * directório `cybersafe-batch-fixture-*` resta e deve ser apagado à mão.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.CYBERSAFE_DEBUG_SCAN = process.env.CYBERSAFE_DEBUG_SCAN || "1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LOG_DIR = path.join(ROOT, "output", "manual-retest");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_PATH = path.join(LOG_DIR, `clamav-batch-probe-${STAMP}.log`);
const JSON_PATH = path.join(LOG_DIR, `clamav-batch-probe-${STAMP}.json`);

const { ClamavBridge, createSpawnClamav } = await import(
  pathToFileURL(path.join(ROOT, "packages", "core", "dist", "index.js")).href
);

// ── Captura de log: tudo o que o tracing escreve fica em memória e em ficheiro.
const logLines = [];
const originalLog = console.log.bind(console);
console.log = (...args) => {
  const line = args
    .map((a) =>
      typeof a === "string"
        ? a
        : a instanceof Error
          ? (a.stack ?? a.message)
          : (() => {
              try {
                return JSON.stringify(a);
              } catch {
                return String(a);
              }
            })(),
    )
    .join(" ");
  logLines.push({ at: Date.now(), line });
  originalLog(line);
};
const originalError = console.error.bind(console);
console.error = (...args) => {
  const line = args
    .map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : String(a)))
    .join(" ");
  logLines.push({ at: Date.now(), line: `[stderr] ${line}` });
  originalError(line);
};

const DEFAULT_SIZES = [5, 20, 100, 300, 730];
const SIZES = (() => {
  const raw = (process.env.PROBE_SIZES ?? "").trim();
  if (!raw) return DEFAULT_SIZES;
  // `PROBE_SIZES=none` corre só as variantes (formas/ficheiro grande).
  if (raw.toLowerCase() === "none") return [];
  return raw
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
})();
const HARD_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 240_000);
const KEEP_FIXTURES = process.env.PROBE_KEEP_FIXTURES === "1";
const SHAPES = process.env.PROBE_SHAPES === "1";
const SLOT = process.env.PROBE_SLOT === "1";
const BIG_MB = Number(process.env.PROBE_BIG_MB ?? 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Guardas de ambiente ────────────────────────────────────────────────
const CLAMSCAN = (() => {
  try {
    const r = spawnSync("clamscan", ["--version"], { timeout: 5000, windowsHide: true, encoding: "utf-8" });
    const text = String(r.stdout ?? "").trim();
    return { ok: r.status === 0 && text.includes("ClamAV"), version: text };
  } catch (e) {
    return { ok: false, version: String(e?.message ?? e) };
  }
})();

function listClamscanRows() {
  if (process.platform !== "win32") return [];
  try {
    const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq clamscan.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf-8",
      windowsHide: true,
    });
    return String(r.stdout ?? "")
      .split(/\r?\n/)
      .filter((line) => line.includes("clamscan.exe"))
      .map((line) => {
        const parts = line.split(",").map((p) => p.replace(/"/g, "").trim());
        return { pid: Number(parts[1]), memoryKb: Number(String(parts[4] ?? "").replace(/[^0-9]/g, "")) };
      })
      .filter((row) => Number.isFinite(row.pid) && row.pid > 0);
  } catch {
    return [];
  }
}

// ── Fixtures benignas ─────────────────────────────────────────────────
async function makeFixtures(count) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `cybersafe-batch-fixture-${count}-`));
  const payload = Buffer.from("CyberSafe benign batch fixture. Nao e malware. ".repeat(24), "utf-8");
  const files = [];
  for (let i = 0; i < count; i++) {
    const p = path.join(dir, `fixture-${String(i).padStart(4, "0")}.txt`);
    await fsp.writeFile(p, Buffer.concat([payload, Buffer.from(`#${i}\n`)]));
    files.push(p);
  }
  return { dir, files };
}

// ── Linha do tempo a partir do tracing (uma fonte única: os próprios logs).
const PERF_RE = /^\[ScanPerf\] (\S+) scanId=(\S+) at=(\S+)(.*)$/;

function timelineFor(scanId) {
  const events = [];
  for (const { line } of logLines) {
    const m = PERF_RE.exec(line);
    if (!m || m[2] !== scanId) continue;
    events.push({ event: m[1], at: Date.parse(m[3]), details: m[4].trim() });
  }
  const base = events.find((e) => e.event === "BATCH_PROMISE_BEGIN")?.at ?? events[0]?.at ?? null;
  return events.map((e) => ({ ...e, deltaMs: base === null ? null : e.at - base }));
}

function detailValue(details, key) {
  const m = new RegExp(`${key}=([^\\s]+)`).exec(details ?? "");
  return m ? m[1] : null;
}

function eventOf(events, name) {
  return events.find((e) => e.event === name) ?? null;
}

// ── Uma run por tamanho ───────────────────────────────────────────────
async function runSize(count) {
  const { dir, files } = await makeFixtures(count);
  const baseline = new Set(listClamscanRows().map((r) => r.pid));

  const leases = { acquire: 0, release: 0 };
  const spawns = { calls: 0 };
  const realSpawn = createSpawnClamav();
  const wrappedSpawn = (file, args, request, hooks) => {
    spawns.calls++;
    const handle = realSpawn(file, args, request, hooks);
    return handle;
  };

  const bridge = new ClamavBridge({
    maxConcurrent: 1,
    acquireDatabaseLease: () => {
      leases.acquire++;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          leases.release++;
        },
        get released() {
          return released;
        },
      };
    },
    spawn: wrappedSpawn,
  });

  let peak = 0;
  const sampler = setInterval(() => {
    const live = bridge.liveChildPids().length;
    if (live > peak) peak = live;
  }, 100);

  const scanId = `probe-${count}-${Date.now().toString(36)}`;
  let progressCalls = 0;
  let firstProgressAt = null;
  let lastProgress = 0;
  let outcome = null;
  let hardTimedOut = false;
  let thrown = null;

  const hardTimer = setTimeout(() => {
    hardTimedOut = true;
    void bridge.dispose();
  }, HARD_TIMEOUT_MS);

  const startedAt = Date.now();
  try {
    outcome = await bridge.scanFiles(files, {
      scanId,
      onProgress: (n) => {
        progressCalls++;
        if (firstProgressAt === null) firstProgressAt = Date.now();
        lastProgress = n;
      },
    });
  } catch (error) {
    thrown = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    clearTimeout(hardTimer);
    clearInterval(sampler);
  }
  const wallMs = Date.now() - startedAt;

  const events = timelineFor(scanId);
  const fileList = eventOf(events, "FILE_LIST_CREATED");
  const batchCount = eventOf(events, "CLAMAV_BATCH_COUNT");
  const slotBegin = eventOf(events, "CLAMAV_SLOT_ACQUIRE_BEGIN");
  const slotEnd = eventOf(events, "CLAMAV_SLOT_ACQUIRE_END");
  const spawnBegin = eventOf(events, "CLAMSCAN_SPAWN_BEGIN");
  const spawnReturn = eventOf(events, "CLAMSCAN_SPAWN_RETURN");
  const spawnThrow = eventOf(events, "CLAMSCAN_SPAWN_THROW");
  const stdoutFirst = eventOf(events, "STDOUT_FIRST_CHUNK");
  const stderrFirst = eventOf(events, "STDERR_FIRST_CHUNK");
  const firstResult = eventOf(events, "STDOUT_FIRST_COMPLETE_RESULT");
  const onProgressFirst = eventOf(events, "ON_PROGRESS_FIRST");
  const childExit = eventOf(events, "CHILD_EXIT");
  const childClose = eventOf(events, "CHILD_CLOSE");
  const outcomeResolve = eventOf(events, "CLAMAV_CHILD_OUTCOME_RESOLVE");
  const childError = eventOf(events, "CHILD_ERROR_EVENT");
  const promiseResolve = eventOf(events, "BATCH_PROMISE_RESOLVE");
  const promiseReject = eventOf(events, "BATCH_PROMISE_REJECT");
  const leaseBegin = eventOf(events, "DB_LEASE_ACQUIRE_BEGIN");
  const leaseEnd = eventOf(events, "DB_LEASE_ACQUIRE_END");
  const leaseRelease = events.filter((e) => e.event === "DB_LEASE_RELEASE");

  await sleep(1200);
  const orphans = listClamscanRows()
    .filter((r) => !baseline.has(r.pid) && r.memoryKb >= 200_000)
    .map((r) => ({ pid: r.pid, memoryKb: r.memoryKb }));

  await bridge.dispose();

  if (!KEEP_FIXTURES) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    size: count,
    scanId,
    wallMs,
    hardTimedOut,
    thrown,
    strategy: batchCount ? detailValue(batchCount.details, "strategy") : fileList ? "file-list" : "unknown",
    argvChars: spawnBegin ? Number(detailValue(spawnBegin.details, "argvChars")) : null,
    fileListEntries: fileList ? Number(detailValue(fileList.details, "entries")) : null,
    fileListBytes: fileList ? Number(detailValue(fileList.details, "bytes")) : null,
    spawnCalls: spawns.calls,
    spawnThrew: Boolean(spawnThrow),
    leaseAcquire: leases.acquire,
    leaseRelease: leases.release,
    leaseEndResult: leaseEnd ? detailValue(leaseEnd.details, "result") : null,
    leaseReleaseReasons: leaseRelease.map((e) => detailValue(e.details, "reason")),
    peakChildren: peak,
    orphans,
    progressCalls,
    lastProgress,
    progressMatchesFiles: progressCalls === count,
    firstProgressDeltaMs: firstProgressAt === null ? null : firstProgressAt - startedAt,
    statusFromPromise: promiseResolve ? detailValue(promiseResolve.details, "status") : null,
    promiseReject: promiseReject ? detailValue(promiseReject.details, "code") : null,
    outcomeStatus: outcome?.status?.status ?? null,
    outcomeFiles: outcome?.files?.length ?? null,
    outcomeErrorCount: outcome?.errorCount ?? null,
    degradedByTimeout: hardTimedOut,
    timeline: {
      batchBegin: 0,
      leaseBegin: leaseBegin?.deltaMs ?? null,
      leaseEnd: leaseEnd?.deltaMs ?? null,
      slotBegin: slotBegin?.deltaMs ?? null,
      slotEnd: slotEnd?.deltaMs ?? null,
      spawnBegin: spawnBegin?.deltaMs ?? null,
      spawnReturn: spawnReturn?.deltaMs ?? null,
      stdoutFirst: stdoutFirst?.deltaMs ?? null,
      stderrFirst: stderrFirst?.deltaMs ?? null,
      firstCompleteResult: firstResult?.deltaMs ?? null,
      onProgressFirst: onProgressFirst?.deltaMs ?? null,
      childError: childError?.deltaMs ?? null,
      childExit: childExit?.deltaMs ?? null,
      childClose: childClose?.deltaMs ?? null,
      outcomeResolve: outcomeResolve?.deltaMs ?? null,
      promiseResolve: promiseResolve?.deltaMs ?? null,
    },
    events: events.map((e) => ({ deltaMs: e.deltaMs, event: e.event, details: e.details })),
  };
}

// ── Variante FORMA DOS CAMINHOS ──────────────────────────────────────
//
// Os 730 sintéticos provaram que o batch aguenta o VOLUME. Falta a FORMA dos
// caminhos reais: acentos, espaços, nomes longos e caminhos fundos. Esta
// variante mede exactamente isso, em argv E em file-list, e confirma quantos
// ficheiros desses voltaram `clean` — um caminho que o clamscan não consegue
// abrir não dá linha `: OK`, e portanto não conta progresso.
async function runPathShapes() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cybersafe-batch-shapes-"));
  const accentedDir = path.join(dir, "Documentos Ação — Rede Social");
  const deepDir = path.join(dir, ...Array.from({ length: 12 }, (_, i) => `nivel-${i}-${"d".repeat(20)}`));
  await fsp.mkdir(accentedDir, { recursive: true });
  await fsp.mkdir(deepDir, { recursive: true });

  const payload = Buffer.from("CyberSafe benign shape fixture.\n", "utf-8");
  const shapes = [
    { label: "acentos", file: path.join(accentedDir, "ficheiro com acentuação ção ãõ.txt") },
    { label: "espacos", file: path.join(accentedDir, "relatório final 2026 (v2) - cópia.txt") },
    { label: "basename-longo", file: path.join(dir, `${"x".repeat(150)}.txt`) },
    { label: "caminho-fundo", file: path.join(deepDir, "fundo.txt") },
    { label: "brackets", file: path.join(dir, "ficheiro [teste] {1}.txt") },
    { label: "unicode-fora-latin1", file: path.join(dir, "ficheiro 日本語 emoji 🚀.txt") },
  ];
  for (const s of shapes) await fsp.writeFile(s.file, payload);

  // Muitos nomes longos para FORÇAR a estratégia file-list (argvChars > 8000).
  const manyDir = path.join(dir, "muitos-com-nomes-longos");
  await fsp.mkdir(manyDir, { recursive: true });
  const many = [];
  for (let i = 0; i < 120; i++) {
    const p = path.join(manyDir, `fixture-com-nome-muito-longo-${String(i).padStart(4, "0")}-${"y".repeat(60)}.txt`);
    await fsp.writeFile(p, payload);
    many.push(p);
  }

  const cases = [
    { name: "argv-com-acentos", files: shapes.map((s) => s.file), expect: shapes.length },
    { name: "file-list-com-acentos", files: many, expect: many.length },
  ];

  const results = [];
  for (const c of cases) {
    const bridge = new ClamavBridge({
      maxConcurrent: 1,
      acquireDatabaseLease: () => ({ release() {}, get released() { return false; } }),
      spawn: createSpawnClamav(),
    });
    const scanId = `shape-${c.name}-${Date.now().toString(36)}`;
    let progressCalls = 0;
    const startedAt = Date.now();
    let outcome = null;
    let thrown = null;
    try {
      outcome = await bridge.scanFiles(c.files, { scanId, onProgress: () => { progressCalls++; } });
    } catch (e) {
      thrown = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    const wallMs = Date.now() - startedAt;
    const events = timelineFor(scanId);
    const batchCount = eventOf(events, "CLAMAV_BATCH_COUNT");
    const spawnBegin = eventOf(events, "CLAMSCAN_SPAWN_BEGIN");
    const stdoutFirst = eventOf(events, "STDOUT_FIRST_CHUNK");
    let cleanCount = 0;
    let errorSample = null;
    for (const f of outcome?.files ?? []) {
      if (f.verdict === "clean") cleanCount++;
      else if (!errorSample) errorSample = `${path.basename(f.file)} => verdict=${f.verdict} detail=${String(f.detail ?? "").slice(0, 160)}`;
    }
    const r = {
      case: c.name,
      files: c.files.length,
      expectedClean: c.expect,
      strategy: batchCount ? detailValue(batchCount.details, "strategy") : null,
      argvChars: spawnBegin ? Number(detailValue(spawnBegin.details, "argvChars")) : null,
      progressCalls,
      cleanCount,
      errorCount: outcome?.errorCount ?? null,
      status: outcome?.status?.status ?? null,
      stdoutFirstMs: stdoutFirst?.deltaMs ?? null,
      wallMs,
      thrown,
      firstNonClean: errorSample,
    };
    results.push(r);
    console.log(
      `FORMA case=${c.name} files=${r.files} strategy=${r.strategy} argvChars=${r.argvChars} ` +
        `progress=${r.progressCalls} clean=${r.cleanCount}/${c.expect} status=${r.status} stdout1st=${r.stdoutFirstMs}ms wallMs=${r.wallMs}` +
        (r.firstNonClean ? ` PRIMEIRO_NAO_CLEAN: ${r.firstNonClean}` : "") +
        (r.thrown ? ` THROWN=${r.thrown}` : ""),
    );
    await bridge.dispose();
  }
  if (!KEEP_FIXTURES) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  return results;
}

// ── Variante FICHEIRO GRANDE À FRENTE ────────────────────────────────
//
// Hipótese: um candidato grande (ISO/IMG/EXE) em PRIMEIRO lugar faz o clamscan
// emitir a primeira linha `: OK` só quando o acaba de varrer. Se for esse o
// caso, a produção mostra `STDOUT_FIRST_CHUNK` MUITO depois do spawn, com a
// vaga e a lease adquiridas — e não uma ausência de spawn.
async function runBigLeadingFile(mb) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cybersafe-batch-bigfile-"));
  const big = path.join(dir, `grande-${mb}mb.bin`);
  const chunk = Buffer.alloc(1024 * 1024, 0x41);
  const fh = await fsp.open(big, "w");
  for (let i = 0; i < mb; i++) await fh.write(chunk);
  await fh.close();
  const smalls = [];
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, `pequeno-${i}.txt`);
    await fsp.writeFile(p, Buffer.from("pequeno benigno\n", "utf-8"));
    smalls.push(p);
  }
  const files = [big, ...smalls];
  console.log(`BIGFILE criado ${mb}MB em ${(await fsp.stat(big)).size} bytes`);

  const bridge = new ClamavBridge({
    maxConcurrent: 1,
    acquireDatabaseLease: () => ({ release() {}, get released() { return false; } }),
    spawn: createSpawnClamav(),
  });
  const scanId = `big-${mb}mb-${Date.now().toString(36)}`;
  let progressCalls = 0;
  const startedAt = Date.now();
  let outcome = null;
  let thrown = null;
  try {
    outcome = await bridge.scanFiles(files, { scanId, onProgress: () => { progressCalls++; } });
  } catch (e) {
    thrown = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  const wallMs = Date.now() - startedAt;
  const events = timelineFor(scanId);
  printTimeline({ size: `big-${mb}mb`, events });
  const r = {
    mb,
    files: files.length,
    progressCalls,
    status: outcome?.status?.status ?? null,
    errorCount: outcome?.errorCount ?? null,
    stdoutFirstMs: eventOf(events, "STDOUT_FIRST_CHUNK")?.deltaMs ?? null,
    exitMs: eventOf(events, "CHILD_EXIT")?.deltaMs ?? null,
    wallMs,
    thrown,
  };
  console.log(
    `BIGFILE mb=${mb} progress=${r.progressCalls}/${files.length} stdout1st=${r.stdoutFirstMs}ms exit=${r.exitMs}ms wallMs=${r.wallMs} status=${r.status}` +
      (r.thrown ? ` THROWN=${r.thrown}` : ""),
  );
  await bridge.dispose();
  if (!KEEP_FIXTURES) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  return r;
}

// ── Variante CONTENÇÃO DA VAGA GLOBAL ───────────────────────────────
//
// A vaga do clamscan é GLOBAL (1) e partilhada com o monitor de ficheiros, o
// monitor de processos e o dashboard. Se outro chamador a tiver, um batch de
// Quick Scan espera SEM LIMITE. Esta variante força essa espera (dois callers,
// dois bridges, o mesmo slot) e prova que o `CLAMAV_SLOT_WAIT` aparece — que é
// a assinatura exacta a procurar se a produção parar com o batch anunciado.
async function runSlotContention() {
  const a = await makeFixtures(30);
  const b = await makeFixtures(30);
  const mkBridge = () =>
    new ClamavBridge({
      maxConcurrent: 1,
      acquireDatabaseLease: () => ({ release() {}, get released() { return false; } }),
      spawn: createSpawnClamav(),
    });
  const bridgeA = mkBridge();
  const bridgeB = mkBridge();
  const startedAt = Date.now();

  const promiseA = bridgeA.scanFiles(a.files, { scanId: "slot-A" });
  await sleep(300); // A já segura a vaga
  const promiseB = bridgeB.scanFiles(b.files, { scanId: "slot-B" });
  const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

  const eventsA = timelineFor("slot-A");
  const eventsB = timelineFor("slot-B");
  const waitLines = eventsB.filter((e) => e.event === "CLAMAV_SLOT_WAIT");
  const o = {
    contentionWallMs: Date.now() - startedAt,
    aStatus: resultA?.status?.status ?? null,
    bStatus: resultB?.status?.status ?? null,
    aSlotGrantedMs: eventOf(eventsA, "CLAMAV_SLOT_ACQUIRE_END")?.deltaMs ?? null,
    bSlotBeginMs: eventOf(eventsB, "CLAMAV_SLOT_ACQUIRE_BEGIN")?.deltaMs ?? null,
    bSlotGrantedMs: eventOf(eventsB, "CLAMAV_SLOT_ACQUIRE_END")?.deltaMs ?? null,
    bWaitedMs: (eventOf(eventsB, "CLAMAV_SLOT_ACQUIRE_END")?.deltaMs ?? 0) - (eventOf(eventsB, "CLAMAV_SLOT_ACQUIRE_BEGIN")?.deltaMs ?? 0),
    bSlotWaitHeartbeats: waitLines.length,
    bSlotWaitFirst: waitLines[0]?.deltaMs ?? null,
    progressA: resultA?.files?.length ?? null,
    progressB: resultB?.files?.length ?? null,
    aOrphans: null,
  };
  console.log(
    `CONTENCAO aGranted=${o.aSlotGrantedMs}ms bGranted=${o.bSlotGrantedMs}ms bEsperou=${o.bWaitedMs}ms ` +
      `batimentos=${o.bSlotWaitHeartbeats} primeiro=${o.bSlotWaitFirst}ms a=${o.aStatus}/30 b=${o.bStatus}/30 wallMs=${o.contentionWallMs}`,
  );
  printTimeline({ size: "slot-B (o segundo caller)", events: eventsB });
  await bridgeA.dispose();
  await bridgeB.dispose();
  if (!KEEP_FIXTURES) {
    await fsp.rm(a.dir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(b.dir, { recursive: true, force: true }).catch(() => {});
  }
  return o;
}

function printTimeline(result) {
  console.log(`\n--- LINHA DO TEMPO ${typeof result.size === "string" ? result.size : `size=${result.size}`} (ms desde BATCH_PROMISE_BEGIN) ---`);
  for (const e of result.events) {
    console.log(`  +${String(e.deltaMs).padStart(6)}ms  ${e.event}${e.details ? `  ${e.details}` : ""}`);
  }
}

async function main() {
  console.log("=== CyberSafe — ClamAV batch probe (P0 SCANNER_RUNTIME_ZERO_PROGRESS) ===");
  console.log(`node=${process.version} platform=${process.platform} clamscan=${CLAMSCAN.version || "?"}`);
  console.log(`tmpdir=${os.tmpdir()}`);
  console.log(`sizes=${SIZES.join(", ")} hardTimeoutMs=${HARD_TIMEOUT_MS} keepFixtures=${KEEP_FIXTURES}`);
  console.log(`log=${LOG_PATH}`);

  if (!CLAMSCAN.ok) {
    console.log(`CLAMSCAN_AVAILABLE=NO — a parar sem correr nada. (${CLAMSCAN.version})`);
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(LOG_PATH, logLines.map((l) => l.line).join("\n"));
    process.exitCode = 2;
    return;
  }

  const preexisting = listClamscanRows();
  console.log(
    `clamscan.exe pre-existentes=${preexisting.length}` +
      (preexisting.length ? ` pids=${preexisting.map((r) => r.pid).join(",")}` : ""),
  );

  const results = [];
  if (SIZES.length > 0) {
    for (const size of SIZES) {
      console.log(`\n=== BATCH size=${size} ===`);
      try {
        const result = await runSize(size);
        results.push(result);
        printTimeline(result);
        console.log(
          `RESUMO size=${size} strategy=${result.strategy} argvChars=${result.argvChars} ` +
            `fileListBytes=${result.fileListBytes} spawnCalls=${result.spawnCalls} peak=${result.peakChildren} ` +
            `progress=${result.progressCalls}/${size} wallMs=${result.wallMs} status=${result.outcomeStatus} ` +
            `outcomeFiles=${result.outcomeFiles} errors=${result.outcomeErrorCount} orphans=${result.orphans.length}` +
            (result.degradedByTimeout ? " HARD_TIMEOUT=YES" : "") +
            (result.thrown ? ` THROWN=${result.thrown}` : ""),
        );
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.log(`RESUMO size=${size} FALHOU_NO_HARNESS=${message}`);
        results.push({ size, harnessError: message });
      }
    }
  }

  let shapeResults = null;
  let bigResult = null;
  if (SHAPES) {
    console.log("\n=== FORMA DOS CAMINHOS (acentos / espaços / nomes longos / fundo) ===");
    try {
      shapeResults = await runPathShapes();
    } catch (error) {
      console.log(`FORMAS FALHARAM_NO_HARNESS=${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let slotResult = null;
  if (SLOT) {
    console.log("\n=== CONTENÇÃO DA VAGA GLOBAL (dois callers, o mesmo slot) ===");
    try {
      slotResult = await runSlotContention();
    } catch (error) {
      console.log(`CONTENCAO FALHOU_NO_HARNESS=${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (BIG_MB > 0) {
    console.log(`\n=== FICHEIRO GRANDE À FRENTE (${BIG_MB} MB) ===`);
    try {
      bigResult = await runBigLeadingFile(BIG_MB);
    } catch (error) {
      console.log(`BIGFILE FALHOU_NO_HARNESS=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("\n=== TABELA FINAL ===");
  const header = [
    "size",
    "strat",
    "argvChars",
    "listBytes",
    "spawns",
    "peak",
    "prog",
    "wallMs",
    "stdout1st",
    "exit",
    "close",
    "promise",
    "status",
    "orphans",
  ];
  console.log(header.join("\t"));
  for (const r of results) {
    if (r.harnessError) {
      console.log(`${r.size}\tHARNESS_ERROR\t${r.harnessError}`);
      continue;
    }
    console.log(
      [
        r.size,
        r.strategy,
        r.argvChars,
        r.fileListBytes,
        r.spawnCalls,
        r.peakChildren,
        `${r.progressCalls}/${r.size}`,
        r.wallMs,
        r.timeline.stdoutFirst,
        r.timeline.childExit,
        r.timeline.childClose,
        r.timeline.promiseResolve,
        r.outcomeStatus,
        r.orphans.length,
      ].join("\t"),
    );
  }

  const summary = {
    stamp: STAMP,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    clamscanVersion: CLAMSCAN.version,
    tmpdir: os.tmpdir(),
    sizes: SIZES,
    hardTimeoutMs: HARD_TIMEOUT_MS,
    results,
    shapeResults,
    bigResult,
    slotResult,
  };
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(JSON_PATH, JSON.stringify(summary, null, 2));
  fs.writeFileSync(LOG_PATH, logLines.map((l) => l.line).join("\n"));
  console.log(`\nJSON=${JSON_PATH}`);
  console.log(`LOG=${LOG_PATH}`);
}

await main();
