#!/usr/bin/env node
/**
 * dev-isolated-electron-gui.mjs — TP-REAL-ELECTRON-GUI (DEV isolado, CDP nativo).
 *
 * Automatiza UMA sessão GUI real do Electron por Chrome DevTools Protocol sobre
 * o WebSocket global do Node (SEM Playwright, SEM instalar nada). Não altera
 * produto: só conduz, por controlos reais, o que o utilizador faria.
 *
 * O que faz, por camada (cada uma reportada como PASS/FAIL/BLOCKED, nunca fingida):
 *   LOOPBACK — antes de ligar: confirma que o port CDP está a escutar SÓ em
 *              127.0.0.1/::1; se virar 0.0.0.0 ou IP de rede → aborta + cleanup.
 *   FORM     — cria conta SINTÉTICA .invalid pela rota NORMAL: preenche o
 *              formulário de registo real (native value setter + 'input') e
 *              clica o submit real. NÃO injeta token nem localStorage.
 *   IPC      — valida a bridge `window.electronAPI` PRESENTE e lê estado REAL
 *              (proteção/conexão/updater) sem ligar proteção nem fazer scan.
 *   NAV      — captura Dashboard e Definições/updates SEM o formulário em ecrã.
 *   PREFS    — muda Material e Tema por controlos reais, recarrega o renderer e
 *              confirma persistência no MESMO perfil (userData isolado).
 *   GUI      — screenshots (PNG) em output/…/captures/electron/**.
 *
 * Guarda: --go corre UMA tentativa, janela máxima 120s, sem loop. Default sem
 * --go é DRY-RUN (imprime o plano e o que vai verificar; nada é arrancado).
 * Credenciais só em memória; token/palavra-passe/email identificável nunca são
 * impressos. Cleanup mata SÓ a própria árvore (runner → filhos) e verifica
 * portas livres, preservando a demo :4175.
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
const API_PORT = 4000;
const RENDERER_PORT = 5173;
const DEMO_PORT = 4175;
const SESSION_MS = 120_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── seletores reais (transcritos de RegisterPage/LoginPage/SettingsPage/App) ──
const SEL = {
  loginSwitchToRegister: '.auth-footer .auth-link',      // «Criar conta» no login
  regName: "register-name",
  regEmail: "register-email",
  regPassword: "register-password",
  regConfirm: "register-confirm-password",
  regSubmit: 'form.auth-form button.auth-submit[type="submit"]',
  dashboard: ".dashboard-page, .hero-banner, section.hero-banner",
  navSettings: 'button, a',                              // resolvido por texto «Definições»
  materialSolid: "Sólido",
  identityNeon: "Neon",
  updatePanel: '[data-testid="app-update-panel"], .app-update-panel',
};

// ── util de rede: é loopback? ──
function hostIsLoopback(host) {
  const h = String(host).replace(/^\[|\]$/g, "").toLowerCase();
  return h.startsWith("127.") || h === "::1" || h === "localhost";
}
function tcpListening(localAddrs) {
  // devolve as linhas LISTENING cujo endereço local bate com :<port>
  const out = spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout || "";
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || !/LISTENING/i.test(line)) continue;
    const local = cols[1];
    const host = local.replace(/:\d+$/, "");
    const port = Number(local.split(":").pop());
    if (localAddrs.includes(port)) rows.push({ local, host, port });
  }
  return rows;
}
function probeTcp(host, port, ms = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(ms); s.once("connect", () => done(true)); s.once("timeout", () => done(false)); s.once("error", () => done(false));
  });
}
function httpJson(urlStr, ms = 1500) {
  return new Promise((resolve) => {
    import("node:http").then((http) => {
      const req = http.get(urlStr, (res) => {
        let body = ""; res.setEncoding("utf8");
        res.on("data", (c) => { if (body.length < 256 * 1024) body += c; });
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
      req.on("error", () => resolve(null));
      req.setTimeout(ms, () => { req.destroy(); resolve(null); });
    });
  });
}

// ── cliente CDP mínimo sobre WebSocket global (Node 20+) ──
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0; this.pending = new Map(); this.events = new Map();
    this.opened = new Promise((res, rej) => {
      this.ws.addEventListener("open", res);
      this.ws.addEventListener("error", () => rej(new Error("ws error")));
    });
    this.ws.addEventListener("message", (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        for (const cb of (this.events.get(m.method) || []).slice()) cb(m.params || {});
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method, cb) { (this.events.set(method, [...(this.events.get(method) || []), cb])); }
  once(method) { return new Promise((res) => { const cb = (p) => { this.events.set(method, (this.events.get(method) || []).filter((f) => f !== cb)); res(p); }; this.on(method, cb); }); }
  close() { try { this.ws.close(); } catch {} }
}
async function evalv(cdp, expression, awaitPromise = false) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}
async function realClick(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function rectFor(cdp, findExpr) {
  return await evalv(cdp, `(()=>{const el=(${findExpr}); if(!el)return null; el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),h:Math.round(r.height)};})()`);
}
async function clickSelector(cdp, selector) {
  // StrictMode pode desmontar/remontar; espera o alvo estabilizar antes do clique.
  if ((await waitTrue(cdp, `!!document.querySelector(${JSON.stringify(selector)})`, 24, 250)) < 0) throw new Error("selector não encontrado: " + selector);
  const rc = await rectFor(cdp, `document.querySelector(${JSON.stringify(selector)})`);
  if (!rc || !rc.w) throw new Error("selector sem área: " + selector);
  await realClick(cdp, rc.x, rc.y); return rc;
}
async function clickText(cdp, text, scope = "button") {
  const rc = await rectFor(cdp, `(()=>{const els=[...document.querySelectorAll(${JSON.stringify(scope)})]; return els.find(e=>e.textContent.trim()===${JSON.stringify(text)})||els.find(e=>e.textContent.includes(${JSON.stringify(text)}))||null;})()`);
  if (!rc || !rc.w) throw new Error("texto não encontrado: " + text);
  await realClick(cdp, rc.x, rc.y); return rc;
}
// contrato de ferramenta: getElementById quer id SEM '#'; querySelector quer o
// seletor COM '#'. Normaliza para que um SEL com '#' não rebente silenciosamente.
function asId(v) { return String(v).replace(/^#/, ""); }
async function fillById(cdp, rawId, value) {
  const id = asId(rawId);
  // espera o input existir e estabilizar (StrictMode desmonta/remonta), escreve via
  // setter nativo + 'input', e confirma que o valor ficou; tenta 2×.
  for (let t = 0; t < 2; t++) {
    if ((await waitTrue(cdp, `!!document.getElementById(${JSON.stringify(id)})`, 24, 250)) < 0) throw new Error(`fill ${id}: missing`);
    const got = await evalv(cdp, `(()=>{const el=document.getElementById(${JSON.stringify(id)}); if(!el)return -1; const P=el.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement; const st=Object.getOwnPropertyDescriptor(P.prototype,'value').set; el.focus(); st.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return el.value.length;})()`);
    if (got === value.length) return;
    await sleep(200);
  }
  throw new Error(`fill ${id}: valor não fixou (StrictMode remount)`);
}
// Resumo SEGURO de um estado: só booleanos/números e strings curtas não-path/URL.
async function safeState(cdp, callExpr) {
  return await evalv(cdp, `(async()=>{try{const s=await (${callExpr}); if(s==null)return{present:false}; const o=(typeof s==='object')?s:{value:s}; const keys=Object.keys(o); const prim={}; for(const k of keys){const v=o[k]; if(typeof v==='boolean'||typeof v==='number')prim[k]=v; else if(typeof v==='string'&&v.length<=32&&!/[\\\\/:]|https?:|token|path|email|@/i.test(v))prim[k]=v;} return{present:true,keys,prim};}catch(e){return{error:String(e&&e.message||e)}}})()`, true);
}
async function shot(cdp, file) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  return { bytes: fs.statSync(file).size, sha256: sha256File(file) };
}
function sha256File(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

async function pickFreeDebugPort() {
  for (let p = 9333; p <= 9399; p++) if (!(await probeTcp("127.0.0.1", p))) return p;
  return null;
}

// escolhe o target do RENDERER (página do app), validando que o ws é loopback
async function findRendererTarget(port) {
  const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
  if (!Array.isArray(list)) return { error: "sem /json/list" };
  const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const app = pages.find((t) => /localhost:5173|127\.0\.0\.1:5173/.test(t.url || ""))
    || pages.find((t) => (t.url || "").startsWith("http"))
    || pages[0];
  if (!app) return { error: "sem target page", seen: pages.map((p) => p.url) };
  let host = null; try { host = new URL(app.webSocketDebuggerUrl).hostname; } catch {}
  if (!hostIsLoopback(host)) return { error: "ws não-loopback", host };
  return { target: app };
}

async function screenDump(cdp) {
  return await evalv(cdp, `(()=>({
    authTitle:(document.querySelector('.auth-title')||{}).textContent||null,
    loginEmail:!!document.getElementById('login-email'),
    registerName:!!document.getElementById('register-name'),
    dashboard:!!document.querySelector('.dashboard-page,.hero-banner'),
    errorBoundary:/Erro no renderer/i.test(document.body.innerText||''),
    statusRegion:(document.querySelector('.auth-error')||{}).innerText||null,
    nInputs:document.querySelectorAll('input').length,
    h1:(document.querySelector('h1')||{}).textContent||null
  }))()`);
}

// espera até expr devolver truthy; devolve o nº de tentativas usadas ou -1
async function waitTrue(cdp, expr, tries = 40, ms = 500) {
  for (let i = 0; i < tries; i++) { if (await evalv(cdp, expr)) return i; await sleep(ms); }
  return -1;
}
// fecha o overlay de boas-vindas pelo botão real (X «Fechar boas-vindas»); NÃO injeta.
async function dismissOnboarding(cdp) {
  const sel = 'button[aria-label="Fechar boas-vindas"]';
  const present = await evalv(cdp, `!!document.querySelector(${JSON.stringify(sel)})`);
  if (!present) return { seen: false };
  await clickSelector(cdp, sel).catch(() => {});
  const gone = (await waitTrue(cdp, `!document.querySelector(${JSON.stringify(sel)})`, 10, 300)) >= 0;
  return { seen: true, dismissed: gone };
}

// ── sessão ──
async function runSession(port, creds, captureDir, log) {
  const R = { loopback: "n/a", connect: "n/a", form: "n/a", ipc: "n/a", nav: "n/a", prefs: "n/a", gui: "n/a", detail: {} };

  // (1) LOOPBACK antes de ligar
  const listening = tcpListening([port]);
  if (listening.length === 0) { R.loopback = "BLOCKED"; R.detail.loopback = "port CDP não está LISTENING"; return R; }
  const nonLoop = listening.filter((r) => !hostIsLoopback(r.host));
  if (nonLoop.length) { R.loopback = "ABORT"; R.detail.loopback = `EXPPOSTO fora de loopback: ${nonLoop.map((r) => r.local).join(", ")}`; return R; }
  R.loopback = "PASS"; R.detail.loopback = listening.map((r) => r.local).join(", ");

  const found = await findRendererTarget(port);
  if (found.error) { R.connect = "BLOCKED"; R.detail.connect = found.error + (found.seen ? ` (${found.seen.join("|")})` : ""); return R; }
  const cdp = new CDP(found.target.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }).catch(() => {});
  R.connect = "PASS"; R.detail.connect = found.target.url;
  const reloadWait = () => Promise.race([cdp.once("Page.loadEventFired"), sleep(15000)]);

  // (1.5) ESPERA o ecrã de autenticação MONTAR (Vite cold-compile + boot/splash)
  R.detail.authFormWait = await waitTrue(cdp, `!!(document.getElementById('login-email')||document.getElementById('register-name'))`, 80, 500);
  const formReached = R.detail.authFormWait >= 0;

  // (2) FORM: switch login→register, campos reais, submit real (clique), dashboard
  try {
    if (!formReached) throw new Error("ecrã de autenticação nunca montou (login/registo) — boot falhou");
    R.detail.authScreen = await evalv(cdp, `(()=>({title:(document.querySelector('.auth-title')||{}).textContent||null,loginEmail:!!document.getElementById('login-email'),registerName:!!document.getElementById('register-name'),footerLinks:[...document.querySelectorAll('.auth-link')].map(b=>b.textContent.trim())}))()`);
    // login→registo por controlo real. Cada clique só dispara quando ESTAMOS mesmo
    // no login — evita o duplo-toggle login→registo→login (mouse + JS em fila).
    const onReg = () => evalv(cdp, `!!document.getElementById('register-name')`);
    const onLogin = () => evalv(cdp, `!!document.getElementById('login-email')`);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await onReg()) break;
      if (!(await onLogin())) break;
      try { await clickText(cdp, "Criar conta", SEL.loginSwitchToRegister); } catch { try { await clickSelector(cdp, SEL.loginSwitchToRegister); } catch {} }
      await sleep(500);
      if (await onReg()) break;
      if (await onLogin()) await evalv(cdp, `(()=>{const b=[...document.querySelectorAll('.auth-link')].find(e=>e.textContent.includes('Criar conta'));if(b)b.click();return!!b})()`);
    }
    R.detail.registerReached = (await waitTrue(cdp, `!!document.getElementById('register-name')`, 16, 300)) >= 0;
    await sleep(800);
    R.detail.screenAfterSwitch = await screenDump(cdp);
    await fillById(cdp, SEL.regName, creds.name);
    await fillById(cdp, SEL.regEmail, creds.email);
    await fillById(cdp, SEL.regPassword, creds.password);
    await fillById(cdp, SEL.regConfirm, creds.password);
    const pre = await evalv(cdp, `(()=>{const f=(id)=>{const e=document.getElementById(id);return e?e.value.length:-1};return {n:f('register-name'),e:f('register-email'),p:f('register-password'),c:f('register-confirm-password')}})()`);
    // submit: clique real; se não montar dashboard em ~6s MAS continuarmos no form
    // de registo, .click() no MESMO submit real (submete o form; NÃO injeta token).
    await clickSelector(cdp, SEL.regSubmit);
    let dashTries = await waitTrue(cdp, `!!document.querySelector(${JSON.stringify(SEL.dashboard)})`, 12, 500);
    if (dashTries < 0 && await onReg()) {
      await evalv(cdp, `(()=>{const b=document.querySelector(${JSON.stringify(SEL.regSubmit)});if(b)b.click();return!!b})()`);
      dashTries = await waitTrue(cdp, `!!document.querySelector(${JSON.stringify(SEL.dashboard)})`, 40, 500);
    }
    const onboard = await dismissOnboarding(cdp);
    const authed = dashTries >= 0;
    R.form = authed ? "PASS" : "FAIL";
    R.detail.form = { camposComValores: pre, dashboardAposSubmitTries: dashTries, onboarding: onboard, via: "preenchimento real + clique submit (sem injetar token)" };
    if (!authed) { R.detail.screenAtFail = await screenDump(cdp).catch(() => "dump falhou"); cdp.close(); return R; }
  } catch (e) { R.form = "FAIL"; R.detail.form_error = e.message; R.detail.screenAtFail = await screenDump(cdp).catch(() => "dump falhou"); cdp.close(); return R; }

  // (2.5) TP-PAP-MATRIX-LAUNCHER-OVERLAP — geometria do launcher no Dashboard real.
  // Mede o FAB vs a Sidebar (aside[data-collapsed]) e vs a banda de toasts
  // (.fixed.bottom-6.right-6) em viewport 1200x820 e 820x600 (device metrics; não
  // redimensiona a janela do OS). Sem scans/proteção; só leitura de rects + captura.
  try {
    const overlap = (a, b) => !!a && !!b && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
    const geom = async () => evalv(cdp, `(()=>{
      const r=(el)=>{if(!el)return null;const b=el.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),right:Math.round(b.right),bottom:Math.round(b.bottom),w:Math.round(b.width),h:Math.round(b.height)};};
      const fab=r(document.querySelector('button[aria-label="Abrir assistente Matrix AI"]'));
      const aside=r(document.querySelector('[data-collapsed]'));
      const toast=r(document.querySelector('.fixed.bottom-6.right-6'));
      return {vw:window.innerWidth,vh:window.innerHeight,fab,aside,toast,collapsed:document.querySelector('[data-collapsed]')?.getAttribute('data-collapsed')||null};
    })()`);
    const sizes = [[1200, 820], [820, 600]];
    const runs = [];
    for (const [w, h] of sizes) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(400);
      const g = await geom();
      const clear = g.fab && !overlap(g.fab, g.aside) && !overlap(g.fab, g.toast);
      const png = await shot(cdp, path.join(captureDir, `launcher-dashboard-${w}x${h}.png`));
      runs.push({ size: `${w}x${h}`, ...g, overlapFabAside: overlap(g.fab, g.aside), overlapFabToast: overlap(g.fab, g.toast), clear });
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    R.launcherLayout = runs.every((x) => x.clear) ? "PASS" : "FAIL";
    R.detail.launcherLayout = runs;
  } catch (e) { R.launcherLayout = "FAIL"; R.detail.launcherLayout_error = e.message; await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {}); }

  // (3) IPC: bridge presente + estado real (sem ligar proteção nem scan)
  try {
    const bridge = await evalv(cdp, `(()=>{const a=window.electronAPI; return a?{present:true,keys:Object.keys(a).length,hasSetProtection:typeof a.setProtection==='function',hasUpdate:!!a.appUpdate}:{present:false}})()`);
    const conn = await safeState(cdp, `window.electronAPI.getServiceConnectionState?window.electronAPI.getServiceConnectionState():null`);
    const prot = await safeState(cdp, `window.electronAPI.getProtectionState?window.electronAPI.getProtectionState():null`);
    const upd = await safeState(cdp, `window.electronAPI.appUpdate&&window.electronAPI.appUpdate.getSnapshot?window.electronAPI.appUpdate.getSnapshot():null`);
    R.ipc = bridge.present ? "PASS" : "FAIL";
    R.detail.ipc = { bridge, conn, prot, upd };
  } catch (e) { R.ipc = "FAIL"; R.detail.ipc_error = e.message; }

  // (4) NAV: Dashboard (pós-onboarding) → Configurações/updates (sem formulário em ecrã)
  try {
    R.detail.dash1 = await shot(cdp, path.join(captureDir, "dashboard-01-real.png"));
    await clickText(cdp, "Configurações", "button");
    await waitTrue(cdp, `[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Sólido'))`, 30, 400);
    R.detail.settings_material_present = await evalv(cdp, `[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Sólido'))`);
    R.detail.settings_update_panel_present = await evalv(cdp, `!!document.querySelector(${JSON.stringify(SEL.updatePanel)})`);
    R.detail.settings1 = await shot(cdp, path.join(captureDir, "settings-01-real.png"));
    R.nav = "PASS";
  } catch (e) { R.nav = "FAIL"; R.detail.nav_error = e.message; }

  // (5) PREFS: material Sólido + tema Neon por controlos reais → reload → persistência mesmo perfil
  try {
    const before = await evalv(cdp, `({surface:document.documentElement.dataset.surface,theme:document.documentElement.dataset.theme})`);
    await clickText(cdp, SEL.materialSolid, "button");
    await clickText(cdp, SEL.identityNeon, "button");
    await sleep(500);
    const afterClick = await evalv(cdp, `({surface:document.documentElement.dataset.surface,theme:document.documentElement.dataset.theme,lsSurface:localStorage.getItem('cybersafe_surface'),lsTheme:localStorage.getItem('cybersafe_theme')})`);
    await cdp.send("Page.reload", { ignoreCache: false }); await reloadWait();
    await waitTrue(cdp, `!!document.querySelector(${JSON.stringify(SEL.dashboard)})`, 50, 500);
    await dismissOnboarding(cdp);
    const surfaceAfter = await evalv(cdp, `document.documentElement.dataset.surface`);
    const themeAfter = await evalv(cdp, `document.documentElement.dataset.theme`);
    const lsAfter = await evalv(cdp, `({surface:localStorage.getItem('cybersafe_surface'),theme:localStorage.getItem('cybersafe_theme')})`);
    const persisted = surfaceAfter === "solid" && themeAfter === "cybersafe-neon";
    R.prefs = persisted ? "PASS" : "FAIL";
    R.detail.prefs = { before, afterClick, reloadDom: { surfaceReload: surfaceAfter, themeReload: themeAfter }, reloadLocalStorage: lsAfter, persisted };
    R.detail.after = await shot(cdp, path.join(captureDir, "after-reload-solid-neon.png"));
  } catch (e) { R.prefs = "FAIL"; R.detail.prefs_error = e.message; }

  R.gui = [R.detail.dash1, R.detail.settings1, R.detail.after].some((v) => v && v.bytes) ? "PASS" : "FAIL";
  cdp.close();
  return R;
}

function killTree(pid, log) {
  if (!pid) return;
  const r = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  log(`cleanup: taskkill /pid ${pid} /T /F (exit ${r.status})`);
}

function portStateReport() {
  const rows = tcpListening([API_PORT, RENDERER_PORT, DEMO_PORT]);
  const has = (p) => rows.some((r) => r.port === p);
  return { [`:${API_PORT}`]: has(API_PORT) ? "LISTENING" : "free", [`:${RENDERER_PORT}`]: has(RENDERER_PORT) ? "LISTENING" : "free", [`:${DEMO_PORT}`]: has(DEMO_PORT) ? "LISTENING (preservada)" : "FREE (perdida!)" };
}

async function main() {
  const go = process.argv.includes("--go");
  const captureDir = path.join(REPO, "output", "design-evolution-v2-20261017", "captures", "electron");
  const logFile = path.join(REPO, "output", "design-evolution-v2-20261017", "TP-REAL-ELECTRON-GUI-session.log");
  const log = (s) => { const line = `${new Date().toISOString()} ${s}`; console.log(line); try { fs.appendFileSync(logFile, line + "\n"); } catch {} };

  fs.appendFileSync(logFile, `\n===== dev-isolated-electron-gui (${go ? "GO" : "DRY-RUN"}) ${new Date().toISOString()} =====\n`);

  if (!go) {
    log("DRY-RUN: nada arrancado. Este driver, com --go, fará UMA sessão ≤120s:");
    log(`  spawn runner: node ${path.relative(REPO, RUNNER)} --gui-cdp --start (CYBERSAFE_DEV_DEBUG_PORT=port livre 9333-9399)`);
    log("  LOOPBACK: netstat antes de ligar → só 127.0.0.1/::1; exposto fora → abort+cleanup");
    log("  FORM: registo SINTÉTICO .invalid por campos reais + clique submit (sem injetar token/localStorage)");
    log("  IPC: valida window.electronAPI + lê estado real (proteção/conexão/updater) sem ligar proteção nem scan");
    log("  NAV: screenshots Dashboard + Definições/updates (nunca o formulário)");
    log("  PREFS: Material=Sólido e Tema=Neon por controlos reais → Page.reload → persistência mesmo perfil");
    log(`  cleanup: taskkill da árvore do runner; verifica :4000/:5173 livres, preserva :${DEMO_PORT}`);
    log(`  captures: ${path.relative(REPO, captureDir)}/*.png`);
    process.exit(0);
  }

  const port = await pickFreeDebugPort();
  if (!port) { log("BLOCK: sem port CDP livre em 9333-9399."); process.exit(2); }
  fs.mkdirSync(captureDir, { recursive: true });

  const creds = { name: "Conta GUI Teste", email: `gui-probe-${crypto.randomBytes(6).toString("hex")}@electron-gui.invalid`, password: crypto.randomBytes(18).toString("base64url") };

  // porta do Electron já deve estar presa por algo? (evitar colisão) — pickFreeDebugPort já testou.
  const runner = spawn(process.execPath, [RUNNER, "--gui-cdp", "--start", "--clean"], {
    cwd: REPO, env: { ...process.env, CYBERSAFE_DEV_DEBUG_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
  });
  runner.stdout.on("data", (d) => { try { fs.appendFileSync(logFile, d); } catch {} });
  runner.stderr.on("data", (d) => { try { fs.appendFileSync(logFile, "[runner-err] " + d); } catch {} });
  log(`runner pid=${runner.pid} com CYBERSAFE_DEV_DEBUG_PORT=${port}`);

  // guarda de 120s a partir de agora
  let guardFired = false;
  const guard = setTimeout(() => { guardFired = true; log("GUARD: 120s excedido → a forçar teardown."); }, SESSION_MS);

  let result;
  try {
    // espera o listener CDP do Electron nascer, SÓ em loopback
    let up = false;
    for (let i = 0; i < 60; i++) {
      if (runner.killed) break;
      const rows = tcpListening([port]);
      if (rows.length && rows.every((r) => hostIsLoopback(r.host)) && (await probeTcp("127.0.0.1", port))) { up = true; break; }
      await sleep(1000);
    }
    if (!up) {
      result = { loopback: guardFired ? "TIMEOUT" : "BLOCKED", detail: { reason: `port ${port} não abriu (só loopback) em ≤60s; Electron pode não ter lançado` } };
    } else {
      result = await runSession(port, creds, captureDir, log);
    }
  } catch (e) {
    result = { loopback: "ERROR", detail: { error: e.message } };
  } finally {
    clearTimeout(guard);
    killTree(runner.pid, log);
    await sleep(3000);
    const ports = portStateReport();
    result.portsAfterCleanup = ports;
    result.debugPortAfterCleanup = tcpListening([port]).filter((r) => r.port === port).length ? "STILL LISTENING (perigoso)" : "free";
    log("RESULT: " + JSON.stringify({ loopback: result.loopback, connect: result.connect, form: result.form, launcherLayout: result.launcherLayout, ipc: result.ipc, nav: result.nav, prefs: result.prefs, gui: result.gui, portsAfterCleanup: result.portsAfterCleanup, debugPortAfterCleanup: result.debugPortAfterCleanup }));
    fs.writeFileSync(path.join(captureDir, "session-result.json"), JSON.stringify(result, null, 2));
  }

  console.log("\n===== RESULTADO =====\n" + JSON.stringify(result, null, 2));
  const pass = result.loopback === "PASS" && result.form === "PASS" && result.launcherLayout === "PASS" && result.ipc === "PASS" && result.nav === "PASS" && result.prefs === "PASS";
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("driver fatal:", e); process.exit(3); });
