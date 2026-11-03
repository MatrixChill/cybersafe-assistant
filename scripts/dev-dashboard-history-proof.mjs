import fs from 'node:fs';
import assert from 'node:assert/strict';
import {verifyClamavSeedBundle} from './clamav-seed-bundle.mjs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { run, realDeps } from './dev-isolated-run.mjs';

const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, ms = 30000) {
  const end = Date.now() + ms;
  let last;
  do { try { const r = await fn(); if (r) return r; } catch (e) { last = e; } await timeout(250); } while (Date.now() < end);
  throw new Error(`${label}: prazo esgotado${last ? ` (${last.message})` : ''}`);
}
async function connectPage(port) {
  const target = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((x) => x.type === 'page' && x.url === 'http://localhost:5173/');
  }, 'Electron renderer');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(key, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: key, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

const deps = realDeps();
// Explicitly authorized fixture-only Electron session. Production launcher is unchanged.
const originalSpawn = deps.spawn;
let fixtureRoot;
deps.spawn = (cmd, args, options) => {
  const env = { ...options.env };
  const service = args.some(x => String(x).endsWith('service\\dist\\index.js') || String(x).endsWith('service/dist/index.js'));
  const desktop = String(cmd).toLowerCase().endsWith('electron.exe');
  if (service) {
    assert.equal(env.CYBERSAFE_DEV_ISOLATION, '1');
    assert.equal(env.CYBERSAFE_USB_PROTECTION, '0');
    assert.equal(env.CYBERSAFE_STARTUP_RESUME, '0');
    fixtureRoot = path.join(env.CYBERSAFE_DEV_ROOT, 'authorized-fixtures');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'benign.txt'), 'Harmless PAP scanner control.');
    const seed = path.resolve('output/clamav-seed-v020-20261103');
    assert.equal(verifyClamavSeedBundle(seed).ok, true);
    env.CYBERSAFE_CLAMAV_SEED_DIR = seed;
    env.CYBERSAFE_DEV_WINDOWS_READONLY = '0';
    env.CYBERSAFE_REALDEV_FIXTURE_SCAN = '1';
    env.CYBERSAFE_REALDEV_FIXTURE_ROOT = fixtureRoot;

    env.CYBERSAFE_CLAMSCAN_PATH = path.resolve('vendor/clamav/clamscan.exe');
  }
  // Service gate remains authoritative: all non-scan mutations are refused.
  if (desktop) env.CYBERSAFE_DEV_WINDOWS_READONLY = '0';
  return originalSpawn(cmd, args, { ...options, env });
};
const logs = [];
deps.log = (line) => { logs.push(line); console.log(line); };
let stop;
deps.installSignalHandlers = () => {
  const promise = new Promise((resolve) => { stop = () => resolve({ kind: 'signal', name: 'smoke-complete' }); });
  return { promise, dispose() {} };
};
let smokeError;
let evidence;
deps.onStackReady = async ({ plan, spawned }) => {
  evidence = path.resolve('output/freebuff-final/dashboard-electron');
  fs.mkdirSync(evidence, { recursive: true });
  let cdp;
  const facts = { observedAt: new Date().toISOString(), root: plan.root, apiPort: plan.apiPort, ownedPids: spawned.map(({ name, pid }) => ({ name, pid })) };
  try {
    cdp = await connectPage(plan.debugPort);
    const evaluate = cdp.evaluate;
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled:true});
    await until(() => evaluate('Boolean(document.querySelector("#login-email") && window.electronAPI)'), 'login screen + preload', 60000);
    const apiBase = await evaluate('window.__CYBERSAFE_API_BASE__');
    if (apiBase !== `http://127.0.0.1:${plan.apiPort}`) throw new Error('API base injected into Electron differs from owned API');
    facts.apiBaseMatches = true;
    facts.loginScreen = true;
    const email = `pap-${randomBytes(4).toString('hex')}@example.test`;
    const password = randomBytes(18).toString('base64url') + '1!';
    const registered = await fetch(`${apiBase}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'PAP isolated smoke', email, password, type: 'personal' }) });
    if (registered.status !== 201) throw new Error(`Isolated test account: HTTP ${registered.status}`);
    facts.registerStatus = registered.status;
    await evaluate(`(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; for (const [id,value] of ${JSON.stringify([['login-email', email], ['login-password', password]])}) { const input=document.getElementById(id); set.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
    await timeout(300);
    await evaluate('document.querySelector("form.auth-form").requestSubmit()');
    await until(() => evaluate('Boolean(document.querySelector("[data-testid=engine-grid]"))'), 'authenticated Dashboard engine grid', 60000);
    facts.dashboard = true;
    await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Agora não'); b?.click(); })()`);
    await timeout(350);
    facts.rendererText = await evaluate('document.body.innerText.slice(0,16000)');
    facts.connection = await evaluate('window.electronAPI.getServiceConnectionState()');
    facts.protection = await evaluate('window.electronAPI.getProtectionState().catch(e=>({error:String(e)}))');
    facts.quarantine = await evaluate('window.electronAPI.getQuarantineFiles().catch(e=>({error:String(e)}))');
    facts.scanHistory = await evaluate('window.electronAPI.getScanHistory({limit:10})');
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(evidence, 'dashboard-electron.png'), Buffer.from(screenshot.data, 'base64'));
    // Keep the same mounted Dashboard throughout a real fixture scan.
    await evaluate('window.__dashboardNode=document.querySelector("[data-testid=v2-dashboard]"); window.__papProgress=[]; window.electronAPI.onScanProgress(s=>window.__papProgress.push(s))');
    facts.before = await evaluate('document.querySelector("[data-testid=v2-dashboard]").innerText');
    assert.ok(facts.before.includes('Ainda sem análises registadas'));
    facts.started = await evaluate('window.electronAPI.startScan("custom",'+JSON.stringify(fixtureRoot)+')');
    facts.terminal = await until(()=>evaluate('window.__papProgress.find(s=>["completed","failed","cancelled"].includes(s.status))'),'fixture terminal',120000);
    assert.equal(facts.terminal.status,'completed');
    await until(()=>evaluate('!document.querySelector("[data-testid=v2-dashboard]").innerText.includes("Ainda sem análises registadas")'),'latest scan refresh',15000);
    assert.equal(await evaluate('window.__dashboardNode===document.querySelector("[data-testid=v2-dashboard]")'),true);
    facts.history = await evaluate('window.electronAPI.getScanHistory({limit:1})');
    facts.after = await evaluate('document.querySelector("[data-testid=v2-dashboard]").innerText');
    assert.match(facts.after, /1\s*ficheiros analisados/);
    await evaluate(`document.querySelector('dialog[open] [aria-label="Fechar diálogo"]')?.click()`);
    await until(() => evaluate('!document.querySelector("dialog[open]")'), 'unobstructed Dashboard');
    facts.dashboardUnobstructed = true;
    await timeout(400);
    const finalShot=await cdp.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(evidence,'dashboard-after-scan.png'),Buffer.from(finalShot.data,'base64'));
    fs.writeFileSync(path.join(evidence, 'smoke-facts.json'), JSON.stringify(facts, null, 2));
    console.log('SMOKE: login via Electron, Dashboard, API base and real preload IPC completed.');
  } catch (error) {
    smokeError = error;
    facts.failure = String(error.message);
    if (cdp) {
      try { facts.rendererText = await cdp.evaluate('document.body.innerText.slice(0,16000)'); } catch {}
      try { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(evidence, 'failure-electron.png'), Buffer.from(r.data, 'base64')); } catch {}
    }
    fs.writeFileSync(path.join(evidence, 'smoke-facts.json'), JSON.stringify(facts, null, 2));
    console.error('SMOKE FAILED:', error.message);
  } finally { cdp?.close(); stop(); }
};

const result = await run({ argv: ['--start', '--owned-direct', '--gui-cdp'], env: process.env, deps });
const summary = { blocked: result.blocked, ready: result.ready, cleanup: result.cleanup, smokeError: smokeError?.message, evidence, root: result.plan?.root };
if (evidence) {
  fs.writeFileSync(path.join(evidence, 'runner.log'), logs.join('\n'));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(summary, null, 2));
}
console.log(JSON.stringify(summary, null, 2));
process.exitCode = result.blocked || smokeError || result.cleanup?.allDead !== true ? 1 : 0;
