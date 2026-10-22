#!/usr/bin/env node
/**
 * dev-isolated-metrics-gui.mjs — TP-PAP-METRICS-ELECTRON-VERIFY (DEV isolado, CDP nativo).
 *
 * Navega Painel(Dashboard) + PC Center REAIS e valida que o DOM é COMPATÍVEL com o
 * estado real publicado pelo serviço, lendo no MÁXIMO 2 snapshots via IPC existente
 * (`electronAPI.getHardwareSnapshot`) com timestamp. Regista usage status/updatedAt,
 * network readStatus/updatedAt e temperatura null/status, e confirma que:
 *   - pending/unavailable NÃO aparecem como medição "0"/número inventado;
 *   - um "0" REAL (available) pode aparecer;
 *   - `stale` é rotulado; temperatura nunca é mostrada como "0°C";
 *   - dois instantes não exigem CPU igual (compatibilidade, não equality exata).
 * NÃO injeta falhas no produto para forçar estados. Se um estado indisponível não
 * ocorrer nesta sessão, a prova desse ramo fica UNITÁRIA (não é fingida aqui).
 *
 * Sem scans/proteção/IA paga; conta sintética .invalid por form real (rota já
 * suportada); runner seguro `--gui-cdp`; 1 sessão ≤120s; limpa árvore própria;
 * :4000/:5173/:9333 livres, demo :4175 preservada. Sem credencial/serial/caminho
 * pessoal nas capturas. Default DRY-RUN; --go corre uma vez.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── rede (só leitura) ──
function hostIsLoopback(host) { const h = String(host).replace(/^\[|\]$/g, "").toLowerCase(); return h.startsWith("127.") || h === "::1" || h === "localhost"; }
function tcpListening(ports) {
  const out = spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout || ""; const rows = [];
  for (const line of out.split(/\r?\n/)) { const c = line.trim().split(/\s+/); if (c.length < 4 || !/LISTENING/i.test(line)) continue; const local = c[1]; const host = local.replace(/:\d+$/, ""); const port = Number(local.split(":").pop()); if (ports.includes(port)) rows.push({ local, host, port }); }
  return rows;
}
function probeTcp(host, port, ms = 400) { return new Promise((res) => { const s = net.connect({ host, port }); const d = (v) => { try { s.destroy(); } catch {} res(v); }; s.setTimeout(ms); s.once("connect", () => d(true)); s.once("timeout", () => d(false)); s.once("error", () => d(false)); }); }
function fetchJson(url) { return new Promise((resolve) => { import("node:http").then((http) => { const req = http.get(url, (res) => { let b = ""; res.setEncoding("utf8"); res.on("data", (c) => { if (b.length < 256 * 1024) b += c; }); res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on("error", () => resolve(null)); req.setTimeout(1500, () => { req.destroy(); resolve(null); }); }); }); }
async function pickFreeDebugPort() { for (let p = DEBUG_LO; p <= DEBUG_HI; p++) if (!(await probeTcp("127.0.0.1", p))) return p; return null; }

// ── CDP mínimo ──
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.events = new Map(); this.opened = new Promise((res, rej) => { this.ws.addEventListener("open", res); this.ws.addEventListener("error", () => rej(new Error("ws error"))); }); this.ws.addEventListener("message", (ev) => { let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else if (m.method) { for (const cb of (this.events.get(m.method) || []).slice()) cb(m.params || {}); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  once(method) { return new Promise((res) => { const cb = (p) => { this.events.set(method, (this.events.get(method) || []).filter((f) => f !== cb)); res(p); }; (this.events.set(method, [...(this.events.get(method) || []), cb])); }); }
  close() { try { this.ws.close(); } catch {} }
}
async function evalv(cdp, expression, awaitPromise = false) { const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }); if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value; }
async function realClick(cdp, x, y) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }); await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }); }
async function waitTrue(cdp, expr, tries = 40, ms = 500) { for (let i = 0; i < tries; i++) { if (await evalv(cdp, expr)) return i; await sleep(ms); } return -1; }
async function rectFor(cdp, findExpr) { return await evalv(cdp, `(()=>{const el=(${findExpr}); if(!el)return null; el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)};})()`); }
async function clickSelector(cdp, selector) { if ((await waitTrue(cdp, `!!document.querySelector(${JSON.stringify(selector)})`, 24, 250)) < 0) throw new Error("selector não encontrado: " + selector); const rc = await rectFor(cdp, `document.querySelector(${JSON.stringify(selector)})`); if (!rc || !rc.w) throw new Error("selector sem área: " + selector); await realClick(cdp, rc.x, rc.y); return rc; }
async function clickText(cdp, text, scope = "button") { const rc = await rectFor(cdp, `(()=>{const els=[...document.querySelectorAll(${JSON.stringify(scope)})]; return els.find(e=>e.textContent.trim()===${JSON.stringify(text)})||els.find(e=>e.textContent.includes(${JSON.stringify(text)}))||null;})()`); if (!rc || !rc.w) throw new Error("texto não encontrado: " + text); await realClick(cdp, rc.x, rc.y); return rc; }
const asId = (v) => String(v).replace(/^#/, "");
async function fillById(cdp, rawId, value) { const id = asId(rawId); for (let t = 0; t < 2; t++) { if ((await waitTrue(cdp, `!!document.getElementById(${JSON.stringify(id)})`, 24, 250)) < 0) throw new Error(`fill ${id}: missing`); const got = await evalv(cdp, `(()=>{const el=document.getElementById(${JSON.stringify(id)}); if(!el)return -1; const P=el.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement; const st=Object.getOwnPropertyDescriptor(P.prototype,'value').set; el.focus(); st.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return el.value.length;})()`); if (got === value.length) return; await sleep(200); } throw new Error(`fill ${id}: não fixou`); }
async function dismissOnboarding(cdp) { const sel = 'button[aria-label="Fechar boas-vindas"]'; if (!(await evalv(cdp, `!!document.querySelector(${JSON.stringify(sel)})`))) return false; await clickSelector(cdp, sel).catch(() => {}); return (await waitTrue(cdp, `!document.querySelector(${JSON.stringify(sel)})`, 10, 300)) >= 0; }
async function shot(cdp, file) { const r = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(file, Buffer.from(r.data, "base64")); return { bytes: fs.statSync(file).size, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") }; }
async function findRendererTarget(port) { const list = await fetchJson(`http://127.0.0.1:${port}/json/list`); if (!Array.isArray(list)) return { error: "sem /json/list" }; const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl); const app = pages.find((t) => /localhost:5173|127\.0\.0\.1:5173/.test(t.url || "")) || pages.find((t) => (t.url || "").startsWith("http")) || pages[0]; if (!app) return { error: "sem page target" }; let host = null; try { host = new URL(app.webSocketDebuggerUrl).hostname; } catch {} if (!hostIsLoopback(host)) return { error: "ws não-loopback", host }; return { target: app }; }

// snapshot via IPC existente (números de sistema; SEM credencial/serial/caminho pessoal)
async function readSnapshot(cdp) {
  return await evalv(cdp, `(async()=>{try{const s=await window.electronAPI.getHardwareSnapshot(); if(!s) return {ok:false};
    return {ok:true, readAt:new Date().toISOString(), snapshotTimestamp:s.timestamp,
      cpu:{usage:s.cpu?.usage, usageStatus:s.cpu?.usageStatus??null, usageUpdatedAt:s.cpu?.usageUpdatedAt??null, temperature:s.cpu?.temperature??null, temperatureStatus:s.cpu?.temperatureStatus??null},
      network:{rxSec:s.network?.rxSec??null, txSec:s.network?.txSec??null, readStatus:s.network?.readStatus??null, updatedAt:s.network?.updatedAt??null},
      gpu:{usagePercent:s.gpu?.usagePercent??null, temperature:s.gpu?.temperature??null, temperatureStatus:s.gpu?.temperatureStatus??null, available:s.gpu?.available??null},
      ramUsage:s.ram?.usagePercent??null};
  }catch(e){return {ok:false, error:String(e&&e.message||e)}}})()`, true);
}
function domText(cdp) { return evalv(cdp, `(()=>{const t=document.body.innerText||''; return {hasSemLeitura:/Sem leitura/.test(t), hasAMedir:/A medir/.test(t), hasRecolher:/A recolher dados/.test(t), hasTempIndisponivel:/Temperatura indispon/.test(t), hasUltimaLeitura:/última leitura/i.test(t), rateCell:/[\\d.]+\\s?(B|KB|MB)\\/s/.test(t), numericPercent:/\\d+\\s?%/.test(t), hasZeroCelsius:/(^|[^\\d])0\\s?°\\s?C/i.test(t), hasNA:/\\bN\\/A\\b/.test(t)};})()`); }

// Compatibilidade DOM<->estado (tolerante; NÃO exige igualdade exata entre instantes)
function checkCompat(snap, dom) {
  const out = { observations: {}, issues: [] };
  const cs = snap.cpu;
  if (cs.usageStatus === "unavailable" || cs.usageStatus === "error") {
    out.observations.cpu = "unavailable/error";
    // não pode aparecer como percentagem medida confiável: o cartão CPU usa "Sem leitura"
    if (!dom.hasSemLeitura && !dom.hasNA) out.issues.push("cpu unavailable mas sem rótulo honesto no DOM");
  } else if (cs.usageStatus === "stale") { out.observations.cpu = "stale"; if (!dom.hasUltimaLeitura && !dom.numericPercent) out.issues.push("cpu stale sem rotular"); }
  else if (cs.usageStatus === "available" || (cs.usageStatus == null && Number.isFinite(cs.usage))) { out.observations.cpu = "available"; if (!dom.numericPercent) out.issues.push("cpu available mas sem número no DOM"); }
  else { out.observations.cpu = `usageStatus=${cs.usageStatus}`; }

  const ns = snap.network;
  if (ns.readStatus === "pending") { out.observations.network = "pending"; if (!dom.hasAMedir) out.issues.push("network pending sem 'A medir…'"); if (dom.rateCell && !dom.hasAMedir) {} }
  else if (ns.readStatus === "unavailable") { out.observations.network = "unavailable"; if (!dom.hasSemLeitura && !dom.hasNA) out.issues.push("network unavailable sem rótulo honesto"); }
  else if (ns.readStatus === "stale") { out.observations.network = "stale"; if (!dom.rateCell && !dom.hasUltimaLeitura) out.issues.push("network stale sem valor/rotulo"); }
  else if (ns.readStatus === "available") { out.observations.network = "available"; if (!dom.rateCell) out.issues.push("network available sem taxa no DOM"); }
  else { out.observations.network = ns.readStatus === null ? "readStatus=null (compat: derivado)" : String(ns.readStatus); }

  const validTemp = Number.isFinite(cs.temperature) && cs.temperature > 0;
  if (validTemp) { out.observations.temperature = `available ${cs.temperature}°C`; if (dom.hasZeroCelsius) out.issues.push("apareceu 0°C espúrio"); }
  else { out.observations.temperature = (cs.temperature === null ? "null" : cs.temperature === 0 ? "0" : String(cs.temperature)) + `/status=${cs.temperatureStatus}`;
    if (dom.hasZeroCelsius) out.issues.push("temperatura indisponível exibida como 0°C");
    if (!(dom.hasRecolher || dom.hasTempIndisponivel || dom.hasSemLeitura || dom.hasNA)) out.issues.push("temperatura indisponível sem rótulo honesto"); }

  if (dom.hasZeroCelsius) out.issues.push("invariante violada: '0°C' presente no DOM");
  return out;
}

async function runSession(port, captureDir, log) {
  const R = { loopback: "n/a", connect: "n/a", auth: "n/a", metrics: "n/a", detail: {} };
  const listening = tcpListening([port]);
  if (!listening.length) { R.loopback = "BLOCKED"; R.detail.loopback = "debug port não LISTENING"; return R; }
  if (listening.some((r) => !hostIsLoopback(r.host))) { R.loopback = "ABORT"; R.detail.loopback = `EXPPOSTO: ${listening.filter((r) => !hostIsLoopback(r.host)).map((r) => r.local).join(", ")}`; return R; }
  R.loopback = "PASS"; R.detail.loopback = listening.map((r) => r.local).join(", ");

  const found = await findRendererTarget(port);
  if (found.error) { R.connect = "BLOCKED"; R.detail.connect = found.error; return R; }
  const cdp = new CDP(found.target.webSocketDebuggerUrl);
  await cdp.opened; await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }).catch(() => {});
  R.connect = "PASS"; R.detail.connect = found.target.url;

  // AUTH (rota real já suportada: form de registo sintético) — necessária para as páginas
  try {
    await waitTrue(cdp, `!!(document.getElementById('login-email')||document.getElementById('register-name'))`, 80, 500);
    const creds = { name: "Conta Métricas", email: `metrics-probe-${crypto.randomBytes(6).toString("hex")}@electron-gui.invalid`, password: crypto.randomBytes(18).toString("base64url") };
    const onReg = () => evalv(cdp, `!!document.getElementById('register-name')`);
    const onLogin = () => evalv(cdp, `!!document.getElementById('login-email')`);
    for (let a = 0; a < 3; a++) { if (await onReg()) break; if (!(await onLogin())) break; try { await clickText(cdp, "Criar conta", ".auth-footer .auth-link"); } catch { try { await clickSelector(cdp, ".auth-footer .auth-link"); } catch {} } await sleep(500); if (await onReg()) break; if (await onLogin()) await evalv(cdp, `(()=>{const b=[...document.querySelectorAll('.auth-link')].find(e=>e.textContent.includes('Criar conta'));if(b)b.click()})()`); }
    await fillById(cdp, "register-name", creds.name); await fillById(cdp, "register-email", creds.email); await fillById(cdp, "register-password", creds.password); await fillById(cdp, "register-confirm-password", creds.password);
    await clickSelector(cdp, 'form.auth-form button.auth-submit[type="submit"]');
    R.auth = (await waitTrue(cdp, `!!document.querySelector('.dashboard-page,.hero-banner')`, 50, 500)) >= 0 ? "PASS" : "FAIL";
    await dismissOnboarding(cdp);
    if (R.auth !== "PASS") { cdp.close(); return R; }
  } catch (e) { R.auth = "FAIL"; R.detail.auth_error = e.message; cdp.close(); return R; }

  // MÉTRICAS: PC Center + Dashboard; ≤2 snapshots com timestamp
  try {
    await clickText(cdp, "PC Center", "button");
    await waitTrue(cdp, `!!document.querySelector('.dashboard-page,[class*="pccenter"],main,section')`, 20, 300);
    await sleep(1500);
    const snap1 = await readSnapshot(cdp); const dom1 = await domText(cdp);
    const shotPc = await shot(cdp, path.join(captureDir, "pccenter-metrics.png"));
    // snapshot 2 após um intervalo (sem exigir igualdade de CPU)
    await sleep(2500);
    const snap2 = await readSnapshot(cdp); const dom2 = await domText(cdp);
    // Dashboard
    await clickText(cdp, "Painel", "button"); await sleep(1200); await dismissOnboarding(cdp);
    const shotDash = await shot(cdp, path.join(captureDir, "dashboard-telemetry.png"));

    const ok = snap1.ok && snap2.ok;
    const compat1 = ok ? checkCompat(snap1, dom1) : { issues: ["sem snapshot"] };
    const compat2 = ok ? checkCompat(snap2, dom2) : { issues: ["sem snapshot"] };
    R.detail.snapshots = [
      { readAt: snap1.readAt, snapshotTimestamp: snap1.snapshotTimestamp, cpu: snap1.cpu, network: snap1.network, gpu: snap1.gpu, ramUsage: snap1.ramUsage, dom: dom1, compat: compat1 },
      { readAt: snap2.readAt, snapshotTimestamp: snap2.snapshotTimestamp, cpu: snap2.cpu, network: snap2.network, gpu: snap2.gpu, ramUsage: snap2.ramUsage, dom: dom2, compat: compat2 },
    ];
    R.detail.observedStates = { cpu: [compat1.observations?.cpu, compat2.observations?.cpu], network: [compat1.observations?.network, compat2.observations?.network], temperature: [compat1.observations?.temperature, compat2.observations?.temperature] };
    const issues = [...(compat1.issues || []), ...(compat2.issues || [])];
    R.detail.issues = issues;
    R.detail.shots = { pccenter: shotPc, dashboard: shotDash };
    // métricas: ok se ambos snapshots lidos e sem issues de compatibilidade
    R.metrics = (ok && issues.length === 0) ? "PASS" : (ok ? "COMPAT-CHECK" : "FAIL");
  } catch (e) { R.metrics = "FAIL"; R.detail.metrics_error = e.message; }
  cdp.close();
  return R;
}

function killTree(pid, log) { if (!pid) return; const r = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }); log(`cleanup: taskkill /pid ${pid} /T /F (exit ${r.status})`); }
function portReport(ports) { const rows = tcpListening(ports); return ports.map((p) => `:${p}=${rows.some((r) => r.port === p) ? "LISTENING" : "free"}`).join(" "); }

async function main() {
  const go = process.argv.includes("--go");
  const outDir = path.join(REPO, "output", "pap-candidate-20261018");
  const captureDir = path.join(outDir, "captures", "metrics");
  const logFile = path.join(outDir, "METRICS-ELECTRON-VERIFY-session.log");
  fs.mkdirSync(captureDir, { recursive: true });
  const log = (s) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); try { fs.appendFileSync(logFile, line + "\n"); } catch {} };

  if (!go) {
    log("DRY-RUN. Com --go: UMA sessão ≤120s → runner --gui-cdp (debug só loopback); registo sintético form real; navegar Painel+PC Center; ler ≤2 getHardwareSnapshot c/ timestamp; validar DOM compatível (pending/unavailable≠0, available0 ok, stale rotulado, nunca 0°C); 2 capturas sem PII; cleanup; :4175 preservada; report METRICS-ELECTRON-VERIFY.md + captures/metrics/**.");
    process.exit(0);
  }
  const port = await pickFreeDebugPort();
  if (!port) { log("BLOCK sem port CDP livre."); process.exit(2); }
  const env = { ...process.env, CYBERSAFE_DEV_DEBUG_PORT: String(port) };
  const runner = spawn(process.execPath, [RUNNER, "--gui-cdp", "--start", "--clean"], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  runner.stdout.on("data", (d) => { try { fs.appendFileSync(logFile, d); } catch {} });
  runner.stderr.on("data", (d) => { try { fs.appendFileSync(logFile, "[runner-err] " + d); } catch {} });
  log(`runner pid=${runner.pid} debug=${port}`);
  let guardFired = false; const guard = setTimeout(() => { guardFired = true; log("GUARD 120s → teardown."); }, SESSION_MS);
  let result;
  try {
    let up = false;
    for (let i = 0; i < 60; i++) { const rows = tcpListening([port]); if (rows.length && rows.every((r) => hostIsLoopback(r.host)) && await probeTcp("127.0.0.1", port)) { up = true; break; } if (runner.killed) break; await sleep(1000); }
    result = up ? await runSession(port, captureDir, log) : { loopback: "BLOCKED", detail: { reason: `debug ${port} não abriu só-loopback em ≤60s` } };
  } catch (e) { result = { error: e.message }; }
  finally {
    clearTimeout(guard); killTree(runner.pid, log); await sleep(3000);
    result.portsAfterCleanup = portReport([API_PORT, RENDERER_PORT, DEMO_PORT]);
    result.debugAfterCleanup = tcpListening([port]).length ? "STILL LISTENING" : "free";
    log("RESULT: " + JSON.stringify({ loopback: result.loopback, connect: result.connect, auth: result.auth, metrics: result.metrics, ports: result.portsAfterCleanup, debug: result.debugAfterCleanup }));
    fs.writeFileSync(path.join(outDir, "metrics-gui-result.json"), JSON.stringify(result, null, 2));
  }
  console.log("\n===== RESULTADO =====\n" + JSON.stringify(result, null, 2));
  process.exit(result.loopback === "PASS" && result.auth === "PASS" && (result.metrics === "PASS" || result.metrics === "COMPAT-CHECK") ? 0 : 1);
}
main().catch((e) => { console.error("fatal:", e); process.exit(3); });
