import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BUILTIN_HASH_SIGNATURES } from '../packages/core/dist/signatures.js';
import { DEV_TEST_YARA_CANONICO, DEV_TEST_YARA_MARCA } from '../packages/service/dist/dev-test-yara.js';
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
    fs.writeFileSync(path.join(fixtureRoot, 'synthetic-canary.txt'), DEV_TEST_YARA_MARCA);
    const corpus = path.join(env.CYBERSAFE_DEV_ROOT, 'synthetic-canary.yar');
    fs.writeFileSync(corpus, DEV_TEST_YARA_CANONICO);
    const hashes = path.join(env.CYBERSAFE_DEV_SERVICE_DIR, 'definitions/hashes/default.json');
    fs.mkdirSync(path.dirname(hashes), { recursive:true });
    fs.writeFileSync(hashes, JSON.stringify([...BUILTIN_HASH_SIGNATURES, {sha256:createHash('sha256').update(DEV_TEST_YARA_MARCA).digest('hex'), family:'PAP synthetic fixture', severity:'low', source:'synthetic-validation-only'}]));
    const dbSource = 'C:/Users/caioc/.cybersafe-integration/pap-integration-p0-codex-20261027/freshclam-validation/database';
    const dbDest = path.join(env.CYBERSAFE_DEV_SERVICE_DIR, 'definitions/clamav');
    fs.mkdirSync(dbDest, { recursive: true });
    for (const name of ['main.cvd', 'daily.cvd', 'bytecode.cvd']) {
      const from = path.join(dbSource, name), to = path.join(dbDest, name);
      const stat = fs.statSync(from); fs.copyFileSync(from, to); fs.utimesSync(to, stat.atime, stat.mtime);
    }
    env.CYBERSAFE_DEV_WINDOWS_READONLY = '0';
    env.CYBERSAFE_REALDEV_FIXTURE_SCAN = '1';
    env.CYBERSAFE_REALDEV_FIXTURE_ROOT = fixtureRoot;
    env.CYBERSAFE_DEV_TEST_YARA_PATH = corpus;
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
  evidence = path.join(plan.root, 'evidence');
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
    facts.pages = [];
    for (const [label, expected, capture] of [
      ['Análise de Segurança', 'Análise', 'scanner'],

    ]) {
      const started = Date.now();
      const clicked = await evaluate(`(() => { const root=${label === 'Quarentena' ? 'document' : 'document.querySelector("[data-cs-sidebar=main]")'}; const b=[...root.querySelectorAll('button')].find(x=>${label === 'Quarentena' ? 'x.textContent.trim().startsWith("Quarentena")' : 'x.textContent.trim()===' + JSON.stringify(label)}); if(!b) return false; b.click(); return true; })()`);
      if (!clicked) throw new Error(`Navigation control missing: ${label}`);
      await until(() => evaluate(`document.body.innerText.includes(${JSON.stringify(expected)})`), `page ${label}`, 15000);
      await timeout(capture === 'pccenter' ? 2500 : 300);
      const text = await evaluate('document.body.innerText.slice(0,16000)');
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(evidence, `${capture}-electron.png`), Buffer.from(shot.data, 'base64'));
      facts.pages.push({ label, elapsedMs: Date.now() - started, text });
    }
    await until(() => evaluate("[...document.querySelectorAll('main h3')].some(x=>x.textContent.includes('O que pretende analisar'))"), 'Scanner content visible', 30000);
    await evaluate('window.__papProgress=[]; window.electronAPI.onScanProgress(s=>window.__papProgress.push(s));window.__papEvents=[];window.electronAPI.onSecurityEvent(e=>window.__papEvents.push(e));window.__papNavigation=[];window.electronAPI.onNavigateRequest(p=>window.__papNavigation.push({p,at:Date.now()}))');
    const zone = await evaluate("(() => {const h=[...document.querySelectorAll('h3,h2')].find(x=>x.textContent.includes('O que pretende analisar')); const e=h?.closest('[class]'); const r=e?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+10}:null;})()");
    assert.ok(zone, 'Scanner drop target must exist');
    const drag = { items: [], files: [fixtureRoot], dragOperationsMask: 1 };
    await cdp.send('Input.dispatchDragEvent', { type:'dragEnter', ...zone, data:drag });
    await cdp.send('Input.dispatchDragEvent', { type:'dragOver', ...zone, data:drag });
    await cdp.send('Input.dispatchDragEvent', { type:'drop', ...zone, data:drag });
    facts.terminal = await until(() => evaluate('window.__papProgress.find(s=>["completed","failed","cancelled"].includes(s.status))'), 'UI fixture scan terminal', 120000);
    facts.progress = await evaluate('window.__papProgress');
    assert.equal(facts.terminal.status, 'completed', JSON.stringify(facts.terminal));
    assert.equal(facts.terminal.filesAnalyzed, 2);
    assert.ok(facts.terminal.threatsFound >= 1, 'Synthetic YARA canary detection must reach Electron');
    await timeout(1000);
    facts.scannerText = await evaluate('document.body.innerText');
    facts.navigationEvents=await evaluate('window.__papNavigation');
    facts.activeNavigation=await evaluate('document.querySelector("[data-cs-sidebar=main] [aria-current=page]")?.innerText');
    assert.ok(facts.scannerText.includes('Pasta largada'),'Confirmed directory must have the directory card');
    assert.equal(facts.scannerText.includes('Analisar com os motores'),false,'Directory must not offer per-file analysis');
    const scannerShot=await cdp.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(evidence,'scanner-results-electron.png'),Buffer.from(scannerShot.data,'base64'));
    facts.scanHistory = await evaluate('window.electronAPI.getScanHistory({limit:10})');
    facts.outsideRefusal = await evaluate("window.electronAPI.startScan('custom'," + JSON.stringify(path.dirname(fixtureRoot)) + ",'scanner-page').then(r=>({result:r}),e=>({error:String(e)}))");
    assert.match(JSON.stringify(facts.outsideRefusal),/realdev_fixture_gate/);
    facts.quickRefusal = await evaluate("window.electronAPI.startScan('quick',undefined,'scanner-page').then(r=>({result:r}),e=>({error:String(e)}))");
    assert.match(JSON.stringify(facts.quickRefusal),/realdev_fixture_gate/);
    const openedThreats=await evaluate("(() => {const b=[...document.querySelectorAll('main button')].find(x=>x.textContent.includes('deteções em Ameaças'));if(!b)return false;b.click();return true;})()");
    assert.equal(openedThreats,true,'Terminal detection CTA must be wired');
    await until(()=>evaluate("[...document.querySelectorAll('main h1')].some(x=>x.textContent.includes('Ameaças'))"),'Threats via Scanner CTA');
    facts.threatsViaCta=await evaluate('document.querySelector("main").innerText');
    await evaluate("[...document.querySelector('[data-cs-sidebar=main]').querySelectorAll('button')].find(x=>x.textContent.trim()==='Análise de Segurança').click()");
    await until(()=>evaluate("[...document.querySelectorAll('main button')].some(x=>x.textContent.trim()==='Nova análise')"),'Scanner terminal restored after navigation');
    // A second real scan is cancelled through the rendered button, not a stub.
    const clickText = async text => evaluate("(() => {const b=[...document.querySelectorAll('main button')].find(x=>x.textContent.trim()===" + JSON.stringify(text) + ");if(!b)return false;b.click();return true;})()");
    assert.equal(await clickText('Nova análise'), true);
    await until(() => evaluate("[...document.querySelectorAll('main h3')].some(x=>x.textContent.includes('O que pretende analisar'))"), 'Scanner ready for cancellation');
    for(let i=0;i<12;i++) fs.writeFileSync(path.join(fixtureRoot,'cancel-control-'+i+'.txt'),'Harmless cancel control '+i);
    const dropFixture = async () => {
      const location = await evaluate("(() => {const e=[...document.querySelectorAll('main h3')].find(x=>x.textContent.includes('O que pretende analisar'));const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+5};})()");
      for(const type of ['dragEnter','dragOver','drop']) await cdp.send('Input.dispatchDragEvent',{type,...location,data:drag});
    };
    await dropFixture();
    await until(() => evaluate('window.__papProgress.some(s=>s.id!=='+JSON.stringify(facts.terminal.id)+' && s.status==="running" && s.phase==="scanning")'), 'Second scan running');
    const cancelButton = await evaluate("(() => {const b=[...document.querySelectorAll('main button')].find(x=>x.textContent.includes('Cancelar'));if(!b)return false;b.click();return true;})()");
    assert.equal(cancelButton,true,'Cancel must be available during scan');
    facts.cancelled = await until(() => evaluate('window.__papProgress.find(s=>s.id!=='+JSON.stringify(facts.terminal.id)+' && s.status==="cancelled")'), 'UI cancellation confirmed',30000);
    assert.ok(facts.cancelled.progress<100);
    await timeout(1000);
    facts.cancelledText=await evaluate('document.body.innerText');
    const cancelShot=await cdp.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(evidence,'scanner-cancelled-electron.png'),Buffer.from(cancelShot.data,'base64'));
    assert.equal(await clickText('Nova análise'),true);
    await until(() => evaluate("[...document.querySelectorAll('main h3')].some(x=>x.textContent.includes('O que pretende analisar'))"), 'Scanner ready for refusal');
    // Fixture archives have no extraction lease and must fail before extraction.
    fs.writeFileSync(path.join(fixtureRoot,'refused.zip'),Buffer.from([0x50,0x4b,3,4,0,0,0,0]));
    await dropFixture();
    facts.failed = await until(() => evaluate('window.__papProgress.find(s=>s.status==="failed")'), 'Fixture archive refusal',30000);
    assert.match(facts.failed.error,/realdev_fixture_gate/);
    await timeout(500);
    facts.failedText=await evaluate('document.body.innerText');
    facts.scanHistory=await evaluate('window.electronAPI.getScanHistory({limit:10})');
    facts.scope = 'Electron real; UI drop, real IPC and service; two harmless fixture files; no personal paths admitted';
    facts.renderResponsive = await evaluate('Number.isFinite(performance.now()) && document.readyState === "complete"');
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
