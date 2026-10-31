#!/usr/bin/env node
/**
 * dev-isolated-custom-scan.mjs — TP-PAP-CUSTOM-REAL-DEV (DEV isolado, uma execução).
 *
 * Corre UM scan "custom" REAL (IPC genuíno, não stub) numa RAIZ-FIXTURE criada só por
 * este teste (benigna: .txt, 0 byte, ZIP STORE benigno), com proteção OFF / monitor OFF
 * e SEM rede externa/VT. Antes de scanear PROVA a política EFETIVA de quarentena lida do
 * serviço; se não for `warn`/`ask` (nunca `automatic-high-confidence`) ou não for legível
 * → BLOCK e NÃO scanneia. Sem EICAR/malware/.exe/dados pessoais/quarentena real.
 *
 * Contrato verificado no código (esta linha não reimplementa produto):
 *   - ScanType = "quick"|"full"|"custom"; resolvePathsForScan("custom",p) → [p] SÓ
 *     (quick/full tocam home/Downloads — por isso usamos SEMPRE custom + fixture).
 *   - getProtectionState().stats.quarantinePolicy = política efetiva (ausente/inválido = "warn").
 *   - canAutoQuarantine só é true se policy === "automatic-high-confidence"; com warn/ask
 *     NADA é quarentenado (ficheiros só lidos/hashed).
 *   - scan de pasta chama scanArtifact(...,{skipVirusTotal:true}) → SEM VirusTotal; além
 *     disso NÃO definimos VIRUSTOTAL_API_KEY (isEnabled() false).
 *
 * Guarda: --go = UMA sessão ≤120s, sem loop. Default DRY-RUN. Cancelamento real extra só
 * se seguro/bounded (uma vez), nunca carga artificial. Cleanup da árvore própria do runner;
 * :4000/:5173/debug livres, demo :4175 preservada. Fixture removida no fim (é minha).
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const RUNNER = path.join(REPO, "scripts", "dev-isolated-run.mjs");
const API_PORT = 4000, RENDERER_PORT = 5173, DEMO_PORT = 4175, DEBUG_LO = 9333, DEBUG_HI = 9399;
const SESSION_MS = 120_000;
const SCAN_DEADLINE_MS = 70_000;   // o scan em si; resto do tempo é boot + gates + cleanup
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── helpers de rede (igual ao GUI driver; só leitura) ──
function hostIsLoopback(host) { const h = String(host).replace(/^\[|\]$/g, "").toLowerCase(); return h.startsWith("127.") || h === "::1" || h === "localhost"; }
function tcpListening(ports) {
  const out = spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout || "";
  const rows = [];
  for (const line of out.split(/\r?\n/)) { const c = line.trim().split(/\s+/); if (c.length < 4 || !/LISTENING/i.test(line)) continue; const local = c[1]; const host = local.replace(/:\d+$/, ""); const port = Number(local.split(":").pop()); if (ports.includes(port)) rows.push({ local, host, port }); }
  return rows;
}
function probeTcp(host, port, ms = 400) { return new Promise((res) => { const s = net.connect({ host, port }); const d = (v) => { try { s.destroy(); } catch {} res(v); }; s.setTimeout(ms); s.once("connect", () => d(true)); s.once("timeout", () => d(false)); s.once("error", () => d(false)); }); }
async function pickFreeDebugPort() { for (let p = DEBUG_LO; p <= DEBUG_HI; p++) if (!(await probeTcp("127.0.0.1", p))) return p; return null; }
function sha256File(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

// ── ZIP STORE benigno (um membro), construído à mão para exercitar o caminho de arquivo ──
function crc32(buf) {
  if (!crc32.t) { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } crc32.t = t; }
  const t = crc32.t; let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0;
}
function buildStoredZip(name, text) {
  const nameBuf = Buffer.from(name, "utf8"); const data = Buffer.from(text, "utf8"); const crc = crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
  const localFull = Buffer.concat([local, nameBuf, data]);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(0, 42);
  const centralFull = Buffer.concat([central, nameBuf]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(centralFull.length, 12); eocd.writeUInt32LE(localFull.length, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localFull, centralFull, eocd]);
}

function makeFixture(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "benign-note.txt"), "CyberSafe fixture benigna para teste de scan custom DEV. Sem conteudo malicioso.\n");
  fs.writeFileSync(path.join(root, "empty.bin"), Buffer.alloc(0)); // 0 bytes
  fs.writeFileSync(path.join(root, "benign-stored.zip"), buildStoredZip("inside.txt", "arquivo benigno dentro de zip STORE\n"));
  return fs.readdirSync(root).sort().map((f) => { const p = path.join(root, f); return { file: f, bytes: fs.statSync(p).size, sha256: sha256File(p) }; });
}
function hashFixture(root) { const set = new Map(fs.readdirSync(root).sort().map((f) => [f, sha256File(path.join(root, f))])); return set; }

// ── CDP mínimo (WebSocket global) ──
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.events = new Map(); this.opened = new Promise((res, rej) => { this.ws.addEventListener("open", res); this.ws.addEventListener("error", () => rej(new Error("ws error"))); }); this.ws.addEventListener("message", (ev) => { let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else if (m.method) { for (const cb of (this.events.get(m.method) || []).slice()) cb(m.params || {}); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  once(method) { return new Promise((res) => { const cb = (p) => { this.events.set(method, (this.events.get(method) || []).filter((f) => f !== cb)); res(p); }; (this.events.set(method, [...(this.events.get(method) || []), cb])); }); }
  close() { try { this.ws.close(); } catch {} }
}
async function evalv(cdp, expression, awaitPromise = false) { const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }); if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value; }
// chama window.electronAPI.<fn>(...) devolve JSON simples (sem valores grandes/binários)
async function ipc(cdp, callExpr) { return await evalv(cdp, `(async()=>{try{const s=await (${callExpr}); return {ok:true, value:(s===undefined?null:s)};}catch(e){return {ok:false, error:String(e&&e.message||e)}}})()`, true); }
async function findRendererTarget(port) { const list = await fetchJson(`http://127.0.0.1:${port}/json/list`); if (!Array.isArray(list)) return { error: "sem /json/list" }; const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl); const app = pages.find((t) => /localhost:5173|127\.0\.0\.1:5173/.test(t.url || "")) || pages.find((t) => (t.url || "").startsWith("http")) || pages[0]; if (!app) return { error: "sem page target", seen: pages.map((p) => p.url) }; let host = null; try { host = new URL(app.webSocketDebuggerUrl).hostname; } catch {} if (!hostIsLoopback(host)) return { error: "ws não-loopback", host }; return { target: app }; }
function fetchJson(url) { return new Promise((resolve) => { import("node:http").then((http) => { const req = http.get(url, (res) => { let b = ""; res.setEncoding("utf8"); res.on("data", (c) => { if (b.length < 256 * 1024) b += c; }); res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on("error", () => resolve(null)); req.setTimeout(1500, () => { req.destroy(); resolve(null); }); }); }); }

async function runSession(port, fixtureRoot, outDir, log) {
  const R = { loopback: "n/a", connect: "n/a", gate: "n/a", scan: "n/a", containment: "n/a", detail: {} };

  // (1) LOOPBACK só; senão aborta (não liga)
  const listening = tcpListening([port]);
  if (listening.length === 0) { R.loopback = "BLOCKED"; R.detail.loopback = "debug port não LISTENING"; return R; }
  const nonLoop = listening.filter((r) => !hostIsLoopback(r.host));
  if (nonLoop.length) { R.loopback = "ABORT"; R.detail.loopback = `EXPPOSTO fora de loopback: ${nonLoop.map((r) => r.local).join(", ")}`; return R; }
  R.loopback = "PASS"; R.detail.loopback = listening.map((r) => r.local).join(", ");

  const found = await findRendererTarget(port);
  if (found.error) { R.connect = "BLOCKED"; R.detail.connect = found.error; return R; }
  const cdp = new CDP(found.target.webSocketDebuggerUrl);
  await cdp.opened; await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
  R.connect = "PASS"; R.detail.connect = found.target.url;

  try {
    // (2) GATE política efetiva via estado do serviço (preferido a escrever ficheiro)
    const bridge = await evalv(cdp, `(()=>{const a=window.electronAPI; return a?{present:true}:{present:false}})()`);
    if (!bridge.present) { R.gate = "BLOCK"; R.detail.gate = "sem window.electronAPI (não é Electron/preload)"; cdp.close(); return R; }
    const state = await ipc(cdp, `window.electronAPI.getProtectionState()`);
    if (!state.ok) { R.gate = "BLOCK"; R.detail.gate = `getProtectionState falhou: ${state.error}`; cdp.close(); return R; }
    const stats = state.value?.stats || {};
    const engine = state.value?.engine || {};
    const policy = stats.quarantinePolicy;
    const protectionEnabled = state.value?.protectionEnabled;
    const engineHealth = { clamav: engine.clamav?.status, nativeEngine: engine.nativeEngine?.status, yara: engine.yara?.status, hashDb: engine.hashDb?.status };
    R.detail.effective = { status: state.value?.status, protectionEnabled, quarantinePolicy: policy, quarantinedCount: stats.quarantinedCount, engineHealth };

    // política efetiva TEM de ser warn/ask e NUNCA automatic; senão BLOCK sem scan.
    if (policy !== "warn" && policy !== "ask") { R.gate = "BLOCK"; R.detail.gateBlock = `política efetiva='${policy}' não é warn/ask`; cdp.close(); return R; }
    if (policy === "automatic-high-confidence") { R.gate = "BLOCK"; R.detail.gateBlock = "política automática recusada"; cdp.close(); return R; }
    R.gate = "PASS";

    // contensão da raiz: custom + fixture; NÃO é quick/full
    R.detail.scanTargetKind = "custom";
    // quarentena ANTES
    const qBefore = await ipc(cdp, `window.electronAPI.getQuarantineFiles ? window.electronAPI.getQuarantineFiles() : []`);
    const qCountBefore = Array.isArray(qBefore.value) ? qBefore.value.length : (qBefore.value?.length ?? "unknown");

    // (3) UM scan custom REAL na fixture
    const startRes = await ipc(cdp, `window.electronAPI.startScan("custom", ${JSON.stringify(fixtureRoot)}, "tp-pap-custom-real-dev")`);
    if (!startRes.ok) { R.scan = "FAIL"; R.detail.scanStart = startRes; cdp.close(); return R; }
    const scanId = (startRes.value && (startRes.value.id || startRes.value.scanId)) || startRes.value;
    R.detail.scanStartRaw = startRes.value;
    const t0 = Date.now();
    let last = null, timedOut = false, cancelledOnce = false;
    while (Date.now() - t0 < SCAN_DEADLINE_MS) {
      const act = await ipc(cdp, `window.electronAPI.getActiveScan ? window.electronAPI.getActiveScan() : null`);
      const s = act.value;
      if (s && typeof s === "object") {
        last = pickScan(s);
        if (["completed", "cancelled", "failed"].includes(last.status)) break;
      } else if (act.ok && s == null) {
        // deixou de estar ativo: apanha o último registo
        const fin = await ipc(cdp, `window.electronAPI.getLastScan ? window.electronAPI.getLastScan(${JSON.stringify(scanId == null ? undefined : scanId)}) : null`);
        if (fin.value && typeof fin.value === "object") last = pickScan(fin.value);
        break;
      }
      await sleep(1500);
    }
    if (!last || !["completed", "cancelled", "failed"].includes(last?.status)) {
      timedOut = true;
      // cancelamento real, UMA vez, só porque o tempo acabou — bounded, não forçado
      if (scanId != null) { const cr = await ipc(cdp, `window.electronAPI.cancelScan(${JSON.stringify(scanId)})`); cancelledOnce = cr.ok; await sleep(2500); const fin = await ipc(cdp, `window.electronAPI.getLastScan ? window.electronAPI.getLastScan(${JSON.stringify(scanId)}) : (window.electronAPI.getActiveScan ? window.electronAPI.getActiveScan(): null)`); if (fin.value && typeof fin.value === "object") last = pickScan(fin.value); }
    }
    R.detail.scanTerminal = last; R.detail.elapsedMs = Date.now() - t0; R.detail.timedOut = timedOut; R.detail.cancelledOnce = cancelledOnce;
    R.scan = last ? (last.status === "completed" ? "PASS" : last.status === "cancelled" ? (timedOut ? "TIMEOUT-CANCELLED" : "PASS-CANCELLED") : "FAIL") : "NO-TERMINAL";

    // (4) contenção: ficheiros ÍNTegros + quarentena VAZIA depois
    const after = hashFixture(fixtureRoot);
    const before = fixtureHashes;
    const intact = before.every((b) => after.get(b.file) === b.sha256);
    const qAfter = await ipc(cdp, `window.electronAPI.getQuarantineFiles ? window.electronAPI.getQuarantineFiles() : []`);
    const qCountAfter = Array.isArray(qAfter.value) ? qAfter.value.length : (qAfter.value?.length ?? "unknown");
    const st2 = await ipc(cdp, `window.electronAPI.getProtectionState()`);
    const qConfirmedAfter = st2.value?.stats?.quarantinedCount;
    R.detail.containment = { fixtureIntact: intact, quarantinedBefore: qCountBefore, quarantinedAfter: qCountAfter, quarantinedCountStatAfter: qConfirmedAfter };
    R.containment = (intact && qCountBefore === 0 && (qCountAfter === 0 || qCountAfter === "unknown") && (qConfirmedAfter === 0 || qConfirmedAfter == null)) ? "PASS" : "CHECK";

    // screenshot leve do renderer (estado), sem segredos
    try { const r = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(outDir, "custom-scan-state.png"), Buffer.from(r.data, "base64")); } catch {}
  } catch (e) { R.gate = "FAIL"; R.detail.session_error = e.message; }
  cdp.close();
  return R;
}
function pickScan(s) { return { id: s.id, type: s.type, status: s.status, progress: s.progress, phase: s.phase, targetKind: s.targetKind, filesDiscovered: s.filesDiscovered, filesTotal: s.filesTotal, filesScanned: s.filesScanned, filesAnalyzed: s.filesAnalyzed, filesExcluded: s.filesExcluded, filesFailed: s.filesFailed, filesInconclusive: s.filesInconclusive, threats: s.threats, error: s.error }; }

let fixtureHashes = [];
function killTree(pid, log) { if (!pid) return; const r = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }); log(`cleanup: taskkill /pid ${pid} /T /F (exit ${r.status})`); }
function portReport(ports) { const rows = tcpListening(ports); return ports.map((p) => `:${p}=${rows.some((r) => r.port === p) ? "LISTENING" : "free"}`).join(" "); }

async function main() {
  const go = process.argv.includes("--go");
  const outDir = path.join(REPO, "output", "pap-candidate-20261018");
  const logFile = path.join(outDir, "CUSTOM-REAL-DEV-session.log");
  fs.mkdirSync(outDir, { recursive: true });
  const log = (s) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); try { fs.appendFileSync(logFile, line + "\n"); } catch {} };

  if (!go) {
    log("DRY-RUN (nada arrancado). Com --go corre UMA sessão ≤120s:");
    log("  spawn runner --gui-cdp --start --clean, debug port só 127.0.0.1; env SEM VIRUSTOTAL_API_KEY");
    log("  fixture só deste teste (temp): benign-note.txt + empty.bin(0B) + benign-stored.zip; sha256 antes");
    log("  GATE: getProtectionState().stats.quarantinePolicy TEM de ser warn/ask (nunca automatic) senão BLOCK sem scan");
    log("  UM scan custom IPC na fixture ([targetPath] só; quick/full nunca); skipVirusTotal no caminho de pasta");
    log("  depois: re-hash fixture íntegra + quarentena vazia; 1 cancelamento real só se bounded/timeout");
    log("  cleanup árvore runner; :4000/:5173/debug free, :4175 preservada; report CUSTOM-REAL-DEV.md");
    process.exit(0);
  }

  const port = await pickFreeDebugPort();
  if (!port) { log("BLOCK: sem port CDP livre."); process.exit(2); }
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-custom-fixture-"));
  const files = makeFixture(fixtureRoot); fixtureHashes = files;
  log(`fixture: ${fixtureRoot}`); log("fixture manifest: " + JSON.stringify(files));

  const env = { ...process.env, CYBERSAFE_DEV_DEBUG_PORT: String(port) };
  delete env.VIRUSTOTAL_API_KEY; // sem VT/rede externa por construction
  const runner = spawn(process.execPath, [RUNNER, "--gui-cdp", "--start", "--clean"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  runner.stdout.on("data", (d) => { try { fs.appendFileSync(logFile, d); } catch {} });
  runner.stderr.on("data", (d) => { try { fs.appendFileSync(logFile, "[runner-err] " + d); } catch {} });
  log(`runner pid=${runner.pid} debug=${port} VIRUSTOTAL_API_KEY=${process.env.VIRUSTOTAL_API_KEY ? "SET(removido no filho)" : "unset"}`);

  let guardFired = false;
  const guard = setTimeout(() => { guardFired = true; log("GUARD 120s excedido → teardown."); }, SESSION_MS);
  let result;
  try {
    let up = false;
    for (let i = 0; i < 60; i++) { const rows = tcpListening([port]); if (rows.length && rows.every((r) => hostIsLoopback(r.host)) && await probeTcp("127.0.0.1", port)) { up = true; break; } if (runner.killed) break; await sleep(1000); }
    if (!up) { result = { loopback: guardFired ? "TIMEOUT" : "BLOCKED", detail: { reason: `debug ${port} não abriu só-loopback em ≤60s` } }; }
    else result = await runSession(port, fixtureRoot, outDir, log);
  } catch (e) { result = { error: e.message }; }
  finally {
    clearTimeout(guard);
    killTree(runner.pid, log);
    await sleep(3000);
    result.portsAfterCleanup = portReport([API_PORT, RENDERER_PORT, DEMO_PORT]);
    result.debugAfterCleanup = tcpListening([port]).length ? "STILL LISTENING" : "free";
    log("RESULT: " + JSON.stringify({ loopback: result.loopback, connect: result.connect, gate: result.gate, scan: result.scan, containment: result.containment, ports: result.portsAfterCleanup, debug: result.debugAfterCleanup }));
    fs.writeFileSync(path.join(outDir, "custom-scan-result.json"), JSON.stringify(result, null, 2));
    // remover a fixture (é minha, benigna) — mantém evidência nos hashes/registo
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); log("fixture removida: " + fixtureRoot); } catch {}
  }
  console.log("\n===== RESULTADO =====\n" + JSON.stringify(result, null, 2));
  process.exit(result.gate === "PASS" && result.scan && result.scan.startsWith("PASS") ? 0 : 1);
}
main().catch((e) => { console.error("fatal:", e); process.exit(3); });
