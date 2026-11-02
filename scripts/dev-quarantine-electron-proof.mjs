/**
 * TP-PAP-QUARANTINE-ELECTRON-HARNESS-20261028 — prova de UI REAL:
 * deteção → quarentena manual → restauro → quarentena → eliminação.
 *
 * O que este harness é:
 *   Um smoke de Electron real (launcher `--start --owned-direct --gui-cdp` do
 *   `dev-isolated-run.mjs`), com login sintético, IPC de preload real e o
 *   serviço real. O único desvio é o comando filho do serviço: em vez de
 *   `packages/service/dist/index.js` corre
 *   `scripts/dev-quarantine-fixture-service.mjs`, que monta a camada de fixture
 *   de quarentena sobre o `handleRequest` do serviço (ver o cabeçalho desse
 *   ficheiro para o contrato completo). Nada de stubs, nada de motores falsos.
 *
 * O que prova (com evidência em disco, não com o texto da UI):
 *   1. o Scanner analisa a fixture e produz uma deteção com `filePath` e
 *      `sha256` reais (YARA canónico + base de hashes de fixture);
 *   2. a aba Ameaças mostra a deteção e o botão "Colocar em quarentena…", com o
 *      diálogo a mostrar nome, caminho e SHA-256 antes de confirmar;
 *   3. depois de confirmar, o ficheiro DESAPARECE do disco e a entrada aparece
 *      na aba Quarentena com o digest da sessão;
 *   4. o restauro devolve os MESMOS bytes (comparados no processo Node) e a
 *      entrada sai da lista;
 *   5. a segunda quarentena + eliminação remove entrada, blob e ficheiro;
 *   6. o gate de fixture continua autoridade: `startScan('quick')` é recusado.
 *
 * O que NÃO faz:
 *   - não prova proteção em tempo real, USB, processos, rede nem definições;
 *   - não cobre `trustAfterRestore` (a UI não envia o campo) — essa recusa é
 *     contrato do bootstrap e vê-se por revisão, não por este smoke;
 *   - não descarrega nada: a base ClamAV tem de existir localmente, senão o
 *     harness pára antes de arrancar (ver CYBERSAFE_QUARANTINE_HARNESS_CLAMAV_DB);
 *   - não toca em caminhos pessoais: tudo vive na raiz isolada da sessão.
 *
 * Execução (quando o Codex integrar na candidata DEV):
 *   node scripts/dev-quarantine-electron-proof.mjs
 *   node scripts/dev-quarantine-electron-proof.mjs --interactive        (prova e depois deixa a janela aberta)
 *   node scripts/dev-quarantine-electron-proof.mjs --interactive=only   (abre sem prova; orçamento de escrita intacto)
 *
 * Em `--interactive`, o teardown só acontece quando o operador carrega Enter
 * (ou Ctrl+C) no terminal, e o perfil/semente da sessão é o mesmo. Em
 * `--interactive=only` nada é isolado/restaurado/eliminado automaticamente: o
 * operador analisa no Scanner e usa as abas à mão, com as mesmas guardas.
 * O modo por omissão continua a fechar sozinho e a exigir `cleanup.allDead`.
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { BUILTIN_HASH_SIGNATURES } from '../packages/core/dist/signatures.js';
import { DEV_TEST_YARA_CANONICO, DEV_TEST_YARA_MARCA } from '../packages/service/dist/dev-test-yara.js';
import { run, realDeps } from './dev-isolated-run.mjs';

const SHIM = path.resolve('scripts/dev-quarantine-fixture-service.mjs');
const TARGET_NAME = 'quarantine-target.txt';const BENIGN_NAME = 'benign-control.txt';
const MANIFEST_SCHEMA = 'cybersafe-quarantine-fixture-v1';
const DEFAULT_CLAMAV_DB = 'C:/Users/caioc/.cybersafe-integration/pap-integration-p0-codex-20261027/freshclam-validation/database';

// Modos: por omissão corre a prova e fecha. `--interactive` corre a prova e
// mantém a janela aberta. `--interactive=only` abre sem prova, com o orçamento
// de escrita intacto para o operador experimentar à mão.
const ARGV = new Set(process.argv.slice(2));
// --settings-proof exercises navigation only; never isolates/restores/deletes.
const ORBITAL_CAPTURE = ARGV.has('--orbital-capture');
const ORBITAL_PROOF = ARGV.has('--orbital-proof') || ORBITAL_CAPTURE;
const VISUAL_PAGES_PROOF = ARGV.has('--visual-pages-proof');
const WEBGL_FAILURE_PROOF = ARGV.has('--webgl-failure-proof');
const APPEARANCE_PROOF = ARGV.has('--appearance-proof') || ORBITAL_PROOF;
const SETTINGS_PROOF = ARGV.has('--settings-proof') || APPEARANCE_PROOF || VISUAL_PAGES_PROOF || WEBGL_FAILURE_PROOF;
const INTERACTIVE_ONLY = ARGV.has('--interactive=only');
const INTERACTIVE = INTERACTIVE_ONLY || ARGV.has('--interactive');
const INTERACTIVE_MAX_MS = Number(process.env.CYBERSAFE_QUARANTINE_INTERACTIVE_MAX_MS || 30 * 60 * 1000);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CANARY_BYTES = Buffer.from(DEV_TEST_YARA_MARCA);
const CANARY_SHA = sha256(CANARY_BYTES);

const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, ms = 30000) {
  const end = Date.now() + ms;
  let last;
  do {
    try {
      const r = await fn();
      if (r) return r;
    } catch (e) {
      last = e;
    }
    await timeout(250);
  } while (Date.now() < end);
  throw new Error(`${label}: prazo esgotado${last ? ` (${last.message})` : ''}`);
}

/**
 * Espera o operador no modo interactivo: Enter (ou fim de stdin / Ctrl+C)
 * termina; um tecto de tempo evita uma pilha esquecida a arder para sempre.
 */
async function esperarOperador() {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let temporizador;
  let sinal = false;
  const onSigint = () => {
    sinal = true;
    rl.close();
  };
  process.once('SIGINT', onSigint);
  try {
    await Promise.race([
      new Promise((resolve) => rl.once('line', resolve)),
      new Promise((resolve) => rl.once('close', resolve)),
      new Promise((resolve) => {
        temporizador = setTimeout(resolve, INTERACTIVE_MAX_MS);
      }),
    ]);
  } finally {
    clearTimeout(temporizador);
    process.removeListener('SIGINT', onSigint);
    rl.close();
    if (sinal) console.log('\n[interactive] Ctrl+C recebido: a encerrar a pilha pela via normal.');
  }
}

async function connectPage(port) {
  const target = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((x) => x.type === 'page' && x.url === 'http://localhost:5173/');
  }, 'Electron renderer');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    listeners.get(msg.method)?.(msg.params);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      pending.set(key, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result?.value;
  };
  return { send, evaluate, on:(method,listener)=>{listeners.set(method,listener);return()=>listeners.delete(method);}, close: () => ws.close() };
}

const deps = realDeps();
const originalSpawn = deps.spawn;
let fixtureRoot;
let targetPath;
let manifestPath;
let serviceDir;
let evidenceDir;

deps.spawn = (cmd, args, options) => {
  const env = { ...options.env };
  if (ORBITAL_PROOF) env.VITE_CYBERSAFE_ORBITAL_PREVIEW = "1";
  const isServiceEntry = (arg) => /packages[\\/]service[\\/]dist[\\/]index\.js$/.test(String(arg));
  const service = args.some(isServiceEntry);
  const desktop = String(cmd).toLowerCase().endsWith('electron.exe');

  if (service) {
    // O runner já garante isolamento; aqui só se confirma, nunca se relaxa.
    assert.equal(env.CYBERSAFE_DEV_ISOLATION, '1');
    assert.equal(env.CYBERSAFE_USB_PROTECTION, '0');
    assert.equal(env.CYBERSAFE_STARTUP_RESUME, '0');
    serviceDir = env.CYBERSAFE_DEV_SERVICE_DIR;
    assert.ok(serviceDir, 'serviço isolado sem CYBERSAFE_DEV_SERVICE_DIR');

    fixtureRoot = path.join(env.CYBERSAFE_DEV_ROOT, 'quarantine-fixtures');
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.mkdirSync(fixtureRoot, { recursive: true });
    targetPath = path.join(fixtureRoot, TARGET_NAME);
    fs.writeFileSync(targetPath, CANARY_BYTES);
    fs.writeFileSync(path.join(fixtureRoot, BENIGN_NAME), 'Harmless PAP quarantine control.');

    // Manifesto da sessão: root em realpath e digests lidos do disco AGORA.
    const rootReal = fs.realpathSync.native(fixtureRoot);
    manifestPath = path.join(env.CYBERSAFE_DEV_ROOT, 'quarantine-session.json');
    const files = [TARGET_NAME, BENIGN_NAME].map((name) => {
      const bytes = fs.readFileSync(path.join(rootReal, name));
      return { name, bytes: bytes.length, sha256: sha256(bytes) };
    });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ schema: MANIFEST_SCHEMA, root: rootReal, quarantineTarget: TARGET_NAME, files }, null, 2),
    );

    // Corpus YARA canónico (o mesmo que a prova do Scanner usa) + base de hashes.
    const corpus = path.join(env.CYBERSAFE_DEV_ROOT, 'quarantine-canary.yar');
    fs.writeFileSync(corpus, DEV_TEST_YARA_CANONICO);
    const hashFile = path.join(serviceDir, 'definitions/hashes/default.json');
    fs.mkdirSync(path.dirname(hashFile), { recursive: true });
    fs.writeFileSync(
      hashFile,
      JSON.stringify([
        ...BUILTIN_HASH_SIGNATURES,
        { sha256: CANARY_SHA, family: 'PAP synthetic fixture', severity: 'low', source: 'synthetic-validation-only' },
      ]),
    );

    // Base ClamAV local: copiada, nunca descarregada. Sem base, não se arranca.
    const dbSource = env.CYBERSAFE_QUARANTINE_HARNESS_CLAMAV_DB || DEFAULT_CLAMAV_DB;
    const dbFiles = ['main.cvd', 'daily.cvd', 'bytecode.cvd'];
    for (const name of dbFiles) {
      assert.ok(fs.existsSync(path.join(dbSource, name)), `base ClamAV local ausente (${name} em ${dbSource}): a prova não corre e não descarrega nada`);
    }
    const dbDest = path.join(serviceDir, 'definitions/clamav');
    fs.mkdirSync(dbDest, { recursive: true });
    for (const name of dbFiles) {
      const from = path.join(dbSource, name);
      const to = path.join(dbDest, name);
      fs.copyFileSync(from, to);
      const stat = fs.statSync(from);
      fs.utimesSync(to, stat.atime, stat.mtime);
    }

    env.CYBERSAFE_DEV_WINDOWS_READONLY = '0';
    env.CYBERSAFE_REALDEV_FIXTURE_SCAN = '1';
    env.CYBERSAFE_REALDEV_FIXTURE_ROOT = fixtureRoot;
    env.CYBERSAFE_DEV_TEST_YARA_PATH = corpus;
    env.CYBERSAFE_CLAMSCAN_PATH = path.resolve('vendor/clamav/clamscan.exe');
    env.CYBERSAFE_QUARANTINE_FIXTURE_SESSION = '1';
    env.CYBERSAFE_QUARANTINE_FIXTURE_MANIFEST = manifestPath;
    // O comando filho passa a ser o shim; stdio/ipc/owned-shutdown ficam iguais.
    args = args.map((arg) => (isServiceEntry(arg) ? SHIM : arg));
    assert.ok(args.includes(SHIM), 'substituição do comando filho do serviço não aconteceu');
  }
  if (desktop) env.CYBERSAFE_DEV_WINDOWS_READONLY = '0';
  return originalSpawn(cmd, args, { ...options, env });
};

const logs = [];
deps.log = (line) => {
  logs.push(line);
  console.log(line);
};
let stop;
deps.installSignalHandlers = () => {
  const promise = new Promise((resolve) => {
    stop = () => resolve({ kind: 'signal', name: 'quarantine-proof-complete' });
  });
  return { promise, dispose() {} };
};

let smokeError;
let evidence;
deps.onStackReady = async ({ plan, spawned }) => {
  evidence = path.join(plan.root, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const facts = {
    observedAt: new Date().toISOString(),
    root: plan.root,
    apiPort: plan.apiPort,
    ownedPids: spawned.map(({ name, pid }) => ({ name, pid })),
    fixture: { target: TARGET_NAME, sha256: CANARY_SHA, manifest: 'quarantine-session.json' },
  };
  let cdp;
  const safeShot = async (name) => {
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(evidence, `${name}.png`), Buffer.from(shot.data, 'base64'));
    } catch (error) {
      facts.screenshotsFailed = [...(facts.screenshotsFailed ?? []), `${name}: ${error.message}`];
    }
  };
  try {
    cdp = await connectPage(plan.debugPort);
    const evaluate = cdp.evaluate;
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

    // 1. Login sintético no Electron real.
    await until(() => evaluate('Boolean(document.querySelector("#login-email") && window.electronAPI)'), 'login screen + preload', 60000);
    const apiBase = await evaluate('window.__CYBERSAFE_API_BASE__');
    if (apiBase !== `http://127.0.0.1:${plan.apiPort}`) throw new Error('API base injected into Electron differs from owned API');
    const email = `pap-quarantine-${randomBytes(4).toString('hex')}@example.test`;
    const password = randomBytes(18).toString('base64url') + '1!';
    const registered = await fetch(`${apiBase}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'PAP isolated quarantine', email, password, type: 'personal' }),
    });
    if (registered.status !== 201) throw new Error(`Isolated test account: HTTP ${registered.status}`);
    facts.registerStatus = registered.status;
    await evaluate(
      `(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; for (const [id,value] of ${JSON.stringify([
        ['login-email', email],
        ['login-password', password],
      ])}) { const input=document.getElementById(id); set.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); } })()`,
    );
    await timeout(300);
    await evaluate('document.querySelector("form.auth-form").requestSubmit()');
    await until(() => evaluate('Boolean(document.querySelector("[data-testid=engine-grid]"))'), 'authenticated Dashboard', 60000);
    facts.dashboard = true;
    await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Agora não'); b?.click(); })()`);
    await timeout(350);

    const clickSidebar = async (label) =>
      evaluate(
        `(() => { const root=document.querySelector("[data-cs-sidebar=main]"); const b=[...root.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)}); if(!b) return false; b.click(); return true; })()`,
      );
    const clickMain = async (text) =>
      evaluate(
        `(() => { const b=[...document.querySelectorAll('main button')].find(x=>x.textContent.trim()===${JSON.stringify(text)}); if(!b) return false; b.click(); return true; })()`,
      );
    const clickMainStarts = async (prefix) =>
      evaluate(
        `(() => { const b=[...document.querySelectorAll('main button')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(prefix)})); if(!b) return false; b.click(); return true; })()`,
      );
    const clickAria = async (label) =>
      evaluate(
        `(() => { const b=document.querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']'); if(!b) return false; b.click(); return true; })()`,
      );
    const bodyText = () => evaluate('document.body.innerText');

    if (SETTINGS_PROOF) {
      await safeShot('dashboard-current-real');
      if(WEBGL_FAILURE_PROOF){
        const injected=await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:`const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return /^webgl|experimental-webgl/.test(type)?null:original.call(this,type,...args);};`});
        await cdp.send('Page.reload');
        await until(()=>evaluate('Boolean(document.querySelector(".visual-adaptation-notice"))'),'aviso de incompatibilidade WebGL');
        assert.equal(await evaluate('Boolean(document.querySelector(".three-scene canvas"))'),false);
        await safeShot('webgl-unavailable-real');
        await evaluate('document.querySelector(".visual-adaptation-notice").click()');
        await cdp.send('Page.reload');
        await until(()=>evaluate('document.documentElement.dataset.v2Webgl === "false" && Boolean(document.querySelector(".brand-scene"))'),'fallback após reload');
        assert.equal(await evaluate('Boolean(document.querySelector(".visual-adaptation-notice"))'),false);
        await safeShot('webgl-notice-dismissal-persisted');
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:injected.identifier});
        await cdp.send('Page.reload');
        await until(()=>evaluate('Boolean(document.querySelector(".three-scene canvas"))'),'recuperação de WebGL após reabrir sessão');
        await safeShot('webgl-recovered-real');
        facts.webglFailure={injectedPlatformFailure:true,cssFallback:true,noticeDismissalSurvivesReload:true,recoveredAfterReload:true};
        fs.writeFileSync(path.join(evidence,'webgl-failure-facts.json'),JSON.stringify(facts,null,2));
        return;
      }
      if(VISUAL_PAGES_PROOF){
        facts.visualPages=[];
        for(const [label,id] of [['Painel','dashboard'],['Análise de Segurança','scanner'],['Gestor de Tarefas','taskmanager'],['PC Center','pccenter'],['Monitor em Tempo Real','monitor'],['Otimizar','optimize'],['Ameaças','threats'],['Configurações','settings']]){
          assert.equal(await clickSidebar(label),true,`navegação ${label}`);
          await timeout(600);
          if(id==='dashboard'){
            const dock=await evaluate(`(()=>{const slot=document.querySelector('[data-cs-matrix-dock]').getBoundingClientRect();const launcher=document.querySelector('[data-matrix-mode="docked"]').getBoundingClientRect();return {slot:{left:slot.left,right:slot.right,top:slot.top,bottom:slot.bottom},launcher:{left:launcher.left,right:launcher.right,top:launcher.top,bottom:launcher.bottom}};})()`);
            assert.ok(dock.launcher.left>=dock.slot.left && dock.launcher.right<=dock.slot.right+1,'MATRIX encaixada não cobre conteúdo');
            facts.matrixDock=dock;
          }
          for(const scale of [1,1.25,1.5]){
            await cdp.send('Emulation.setDeviceMetricsOverride',{width:1100,height:820,deviceScaleFactor:scale,mobile:false});
            await timeout(150);
            assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'),false,`overflow ${id} escala ${scale}`);
            await safeShot('visual-page-'+id+'-scale-'+scale);
          }
          facts.visualPages.push({page:id,scalesEmulated:[1,1.25,1.5]});
        }
        fs.writeFileSync(path.join(evidence,'visual-pages-facts.json'),JSON.stringify(facts,null,2));
        return;
      }
      assert.equal(await clickSidebar('Configurações'), true);
      await until(() => evaluate(`Boolean(document.querySelector('nav[aria-label="Categorias das configurações"]'))`), 'categorias prontas');
      if (APPEARANCE_PROOF) {
        const selectValue = async (id, value) => evaluate(`(() => {
          const element = document.getElementById(${JSON.stringify(id)});
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, ${JSON.stringify(value)});
          element.dispatchEvent(new Event('change', {bubbles:true}));
        })()`);
        await selectValue('settings-motion', 'reduced');
        await selectValue('settings-performance', 'economy');
        await evaluate(`(() => {const input=document.getElementById('settings-webgl');if(input.checked)input.click();})()`);
        await until(() => evaluate('document.documentElement.dataset.v2Performance === "economy" && document.documentElement.dataset.reduced === "true"'), 'perfil económico aplicado');
        await cdp.send('Page.reload');
        await until(() => evaluate('Boolean(document.querySelector("[data-cs-sidebar=main]"))'), 'sessão após reload');
        await clickSidebar('Configurações');
        await until(() => evaluate('Boolean(document.getElementById("settings-motion"))'), 'controlos após reload');
        facts.appearancePersisted = await evaluate(`({movement:document.getElementById('settings-motion').value,performance:document.getElementById('settings-performance').value,webgl:document.getElementById('settings-webgl').checked,reduced:document.documentElement.dataset.reduced})`);
        assert.deepEqual(facts.appearancePersisted,{movement:'reduced',performance:'economy',webgl:false,reduced:'true'});
        await evaluate(`document.getElementById('settings-effects-title').scrollIntoView({block:'center'})`);
        await safeShot('appearance-controls-persisted-real');
        for (const scale of [1,1.25,1.5]) {
          await cdp.send('Emulation.setDeviceMetricsOverride',{width:1000,height:800,deviceScaleFactor:scale,mobile:false});
          await timeout(200);
          assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'),false);
          await safeShot('appearance-scale-emulated-' + scale);
        }
        if (ORBITAL_PROOF) {
          await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
          await selectValue('settings-motion','balanced');
          await selectValue('settings-performance','balanced');
          await evaluate(`(() => {const input=document.getElementById('settings-webgl');if(!input.checked)input.click();})()`);
          await clickSidebar('Painel');
          await until(() => evaluate(`Boolean(document.querySelector('[data-orbital-proposal="true"] .three-scene canvas'))`),'cena 3D da proposta',15000);
          await timeout(500);
          facts.orbitalProposal = {webglScene:true,productionDefault:false};
          if(ORBITAL_CAPTURE){
            const frames=path.join(evidence,'motion-frames');fs.mkdirSync(frames);
            let count=0;const times=[];
            const unsubscribe=cdp.on('Page.screencastFrame',frame=>{
              fs.writeFileSync(path.join(frames,String(count++).padStart(5,'0')+'.jpg'),Buffer.from(frame.data,'base64'));
              times.push(frame.metadata.timestamp);
              void cdp.send('Page.screencastFrameAck',{sessionId:frame.sessionId}).catch(()=>{});
            });
            await cdp.send('Page.startScreencast',{format:'jpeg',quality:80,maxWidth:960,maxHeight:675,everyNthFrame:4});
            for(let part=0;part<6;part++)await timeout(11000);
            await cdp.send('Page.stopScreencast');unsubscribe();
            fs.writeFileSync(path.join(evidence,'motion-frame-times.json'),JSON.stringify(times));
            assert.ok(count>30,'gravação precisa de frames reais');
            facts.motionCapture={frames:count,seconds:times.at(-1)-times[0],source:'Electron CDP screencast; cadence is recording cadence, not measured app FPS'};
            for(const width of [900,1280])for(const scale of [1,1.25,1.5]){
              await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:scale,mobile:false});
              await timeout(250);await safeShot('orbital-layout-'+width+'-'+scale);
              assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
            }
            fs.writeFileSync(path.join(evidence,'orbital-capture-facts.json'),JSON.stringify(facts,null,2));
            return;
          }
          await safeShot('orbital-v3-proposal-a');
          await timeout(1200);
          await safeShot('orbital-v3-proposal-b');
          for (const seconds of [8,16,24,32,40,48,56,64]) {
            await timeout(8000);
            await safeShot('orbital-v3-rotation-'+seconds);
          }
          facts.visualProfiles=[];
          for(const profile of ['auto','high','balanced','economy','custom']) {
            await clickSidebar('Configurações');
            await until(()=>evaluate('Boolean(document.getElementById("settings-performance"))'),'perfil visual');
            await selectValue('settings-performance',profile);
            await until(()=>evaluate(`document.documentElement.dataset.v2Performance === ${JSON.stringify(profile)}`),'perfil aplicado');
            await evaluate(`document.getElementById('settings-effects-title').scrollIntoView({block:'center'})`);
            await safeShot('visual-profile-settings-'+profile);
            if(profile==='custom') {
              await evaluate(`document.querySelectorAll('[id^="settings-effect-"]').forEach(input=>{if(input.checked)input.click();})`);
              await until(()=>evaluate('document.documentElement.dataset.effectCore3d === "false"'),'3D personalizado desligado');
              await cdp.send('Page.reload');
              await until(()=>evaluate('Boolean(document.querySelector("[data-cs-sidebar=main]"))'),'perfil personalizado após reload');
              assert.equal(await evaluate('document.documentElement.dataset.effectCore3d'), 'false');
            }
            await clickSidebar('Painel');
            await until(()=>evaluate('Boolean(document.querySelector(".brand-scene"))'),'painel no perfil');
            if(profile==='economy'||profile==='custom')assert.equal(await evaluate('Boolean(document.querySelector(".three-scene canvas"))'),false);
            await safeShot('visual-profile-dashboard-'+profile);
            facts.visualProfiles.push({profile,core3d:await evaluate('Boolean(document.querySelector(".three-scene canvas"))')});
          }
          await clickSidebar('Configurações');
          await until(()=>evaluate('Boolean(document.getElementById("settings-performance"))'),'repor perfil para movimento reduzido');
          await selectValue('settings-performance','balanced');
          await clickSidebar('Painel');
          await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
          await until(()=>evaluate('document.documentElement.dataset.reduced === "true"'),'movimento reduzido efetivo');
          facts.orbitalProposal.reducedMotion=true;
          await safeShot('orbital-v3-reduced-motion');
          await clickSidebar('Configurações');
          await until(()=>evaluate('Boolean(document.getElementById("settings-webgl"))'),'configuração de fallback');
          await evaluate(`(() => {const input=document.getElementById('settings-webgl');if(input.checked)input.click();})()`);
          await clickSidebar('Painel');
          await until(()=>evaluate('!document.querySelector(".three-scene") && Boolean(document.querySelector(".orbiting-core"))'),'fallback sem WebGL');
          facts.orbitalProposal.cssFallback=true;
          await safeShot('orbital-v3-css-fallback');
        }
        fs.writeFileSync(path.join(evidence,'appearance-facts.json'),JSON.stringify(facts,null,2));
        return;
      }

      const ids = ['geral','aparencia','protecao','exclusoes','atualizacoes','matrix','avancado'];
      facts.settings = [];
      for (const id of ids) {
        const result = await evaluate(`(() => {
          const link = document.querySelector('a[href="#settings-${id}"]');
          const region = document.getElementById('settings-${id}');
          if (!link || !region) return null;
          link.focus(); link.click();
          return {id:region.id,role:region.getAttribute('role'),label:region.getAttribute('aria-labelledby'),focus:document.activeElement.id};
        })()`);
        assert.equal(result?.id, 'settings-' + id);
        assert.equal(result.role, 'region');
        assert.ok(result.label);
        assert.equal(result.focus, result.id, "a âncora move o foco para a região");
        // Hash navigation must not invalidate the trusted-frame IPC guard.
        assert.ok(await evaluate('window.electronAPI.getServiceConnectionState()'));
        facts.settings.push(result);
      }
      await evaluate(`document.querySelector('a[href="#settings-geral"]').click()`);
      await timeout(300);
      await cdp.send('Input.dispatchKeyEvent', {type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9});
      await cdp.send('Input.dispatchKeyEvent', {type:'keyUp', key:'Tab', code:'Tab', windowsVirtualKeyCode:9});
      facts.settingsKeyboard = await evaluate('({tag:document.activeElement.tagName,role:document.activeElement.getAttribute("role")})');
      assert.ok(['BUTTON','INPUT','A'].includes(facts.settingsKeyboard.tag), 'Tab chega a um controlo');
      await safeShot('settings-categories-real');
      await cdp.send('Emulation.setDeviceMetricsOverride', {width:900,height:700,deviceScaleFactor:1,mobile:false});
      await timeout(300);
      facts.settingsHorizontalOverflow = await evaluate('document.documentElement.scrollWidth > innerWidth');
      assert.equal(facts.settingsHorizontalOverflow, false);
      await safeShot('settings-categories-900-real');
      fs.writeFileSync(path.join(evidence, 'settings-facts.json'), JSON.stringify(facts, null, 2));
      return;
    }

    // A prova automatizada (passos 2–9). Em `--interactive=only` é saltada: o
    // operador experimenta à mão com o orçamento de escrita intacto.
    if (!INTERACTIVE_ONLY) {

    // 2. Scanner: drop da fixture, análise real.
    assert.equal(await clickSidebar('Análise de Segurança'), true, 'sidebar: Análise de Segurança');
    await until(() => evaluate("[...document.querySelectorAll('main h3')].some(x=>x.textContent.includes('O que pretende analisar'))"), 'Scanner pronto', 30000);
    await evaluate('window.__papProgress=[]; window.electronAPI.onScanProgress(s=>window.__papProgress.push(s))');
    const drag = { items: [], files: [fixtureRoot], dragOperationsMask: 1 };
    const dropFixture = async () => {
      const location = await evaluate(
        "(() => {const h=[...document.querySelectorAll('h3,h2')].find(x=>x.textContent.includes('O que pretende analisar'));const r=h.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+6};})()",
      );
      for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, ...location, data: drag });
    };
    await dropFixture();
    facts.scan = await until(() => evaluate('window.__papProgress.find(s=>["completed","failed","cancelled"].includes(s.status))'), 'scan terminal', 180000);
    assert.equal(facts.scan.status, 'completed', JSON.stringify(facts.scan));
    assert.equal(facts.scan.filesAnalyzed, 2, `esperava 2 ficheiros analisados: ${JSON.stringify(facts.scan)}`);
    assert.ok(facts.scan.threatsFound >= 1, 'a canario sintetica tem de chegar como ameaca');

    // 3. A deteção real tem identidade (path + digest), que é o que a UI exige
    //    para oferecer a quarentena manual.
    facts.threats = await evaluate('window.electronAPI.getThreatEvents()');
    const detecao = facts.threats.find(
      (t) => typeof t?.filePath === 'string' && path.resolve(t.filePath).toLowerCase() === targetPath.toLowerCase() && t.sha256 === CANARY_SHA,
    );
    assert.ok(detecao, `sem ThreatEvent para o alvo com o digest da sessão: ${JSON.stringify(facts.threats?.slice(0, 3))}`);
    facts.detection = { filePath: detecao.filePath, sha256: detecao.sha256, severity: detecao.severity, action: detecao.action };

    // 4. Ameaças: botão manual, diálogo com nome/caminho/digest, confirmação.
    assert.equal(await clickSidebar('Ameaças'), true, 'sidebar: Ameaças');
    await until(async () => (await bodyText()).includes(TARGET_NAME), 'deteção visível na aba Ameaças', 30000);
    await until(() => clickMainStarts('Colocar em quarentena'), 'botão de quarentena visível após navegação', 30000);
    await until(() => evaluate('Boolean(document.querySelector(\'[role=dialog][aria-label="Confirmar quarentena"]\'))'), 'diálogo de confirmação de quarentena', 15000);
    const dialogo = await evaluate('document.querySelector(\'[role=dialog][aria-label="Confirmar quarentena"]\').innerText');
    assert.ok(dialogo.includes(TARGET_NAME), 'o diálogo tem de mostrar o nome do ficheiro');
    assert.ok(dialogo.includes(CANARY_SHA), 'o diálogo tem de mostrar o SHA-256 da sessão');
    facts.quarantineDialog = dialogo;
    await safeShot('threats-quarantine-dialog');
    const confirmou = await evaluate(
      `(() => { const d=document.querySelector('[role=dialog][aria-label="Confirmar quarentena"]'); const b=[...d.querySelectorAll('button')].find(x=>x.textContent.trim()==='Confirmar'); if(!b) return false; b.click(); return true; })()`,
    );
    assert.equal(confirmou, true, 'botão Confirmar do diálogo');
    await until(async () => (await bodyText()).includes('Quarentena confirmada pelo serviço'), 'confirmação do serviço na UI', 30000);

    // 5. Pós-condição no FICHEIRO, não na UI: alvo ausente + entrada com o digest.
    await until(() => !fs.existsSync(targetPath), 'alvo ausente no disco após isolamento', 15000);
    facts.afterQuarantine = {
      targetAbsent: !fs.existsSync(targetPath),
      entries: await evaluate('window.electronAPI.getQuarantineFiles()'),
    };
    assert.equal(facts.afterQuarantine.entries.length, 1, 'uma entrada na quarentena');
    assert.equal(facts.afterQuarantine.entries[0].sha256, CANARY_SHA, 'a entrada tem o digest da sessão');
    assert.equal(facts.afterQuarantine.entries[0].isolationStatus, 'confirmed', `isolamento não confirmado: ${JSON.stringify(facts.afterQuarantine.entries[0])}`);
    const primeiraEntrada = facts.afterQuarantine.entries[0].id;
    facts.afterQuarantine.entryId = primeiraEntrada;
    facts.afterQuarantine.blobSha256 = sha256(fs.readFileSync(path.join(serviceDir, 'quarantine', `${primeiraEntrada}.quarantine`)));
    assert.equal(facts.afterQuarantine.blobSha256, CANARY_SHA, 'o blob em quarentena tem os mesmos bytes');

    // 6. Aba Quarentena → Restaurar → Confirmar → bytes iguais no disco.
    assert.equal(await clickMainStarts('Quarentena'), true, 'aba Quarentena');
    await until(async () => (await bodyText()).includes(TARGET_NAME), 'entrada visível na aba Quarentena', 15000);
    await safeShot('quarantine-tab-before-restore');
    assert.equal(await clickAria(`Restaurar ${TARGET_NAME} para o local original`), true, 'botão Restaurar');
    await until(async () => (await bodyText()).includes('Restaurar este ficheiro para o local original?'), 'confirmação do restauro', 15000);
    assert.equal(await clickAria(`Confirmar restauro de ${TARGET_NAME}`), true, 'confirmar restauro');
    await until(async () => (await evaluate('window.electronAPI.getQuarantineFiles()')).length === 0, 'lista da quarentena vazia após restauro', 30000);
    await until(() => fs.existsSync(targetPath), 'alvo de volta no disco', 15000);
    facts.afterRestore = {
      bytesEqual: fs.readFileSync(targetPath).equals(CANARY_BYTES),
      sha256: sha256(fs.readFileSync(targetPath)),
      entries: await evaluate('window.electronAPI.getQuarantineFiles()'),
    };
    assert.equal(facts.afterRestore.bytesEqual, true, 'o restauro devolveu os mesmos bytes');
    assert.equal(facts.afterRestore.sha256, CANARY_SHA, 'o digest restaurado é o da sessão');
    await safeShot('quarantine-restored');

    // 7. Segundo ciclo: isolar outra vez e eliminar.
    // A deteção anterior é um facto histórico já marcado como isolado.
    // Reanalisar os bytes restaurados cria a nova deteção que autoriza a ação.
    assert.equal(await clickSidebar('Análise de Segurança'), true);
    await until(() => evaluate("[...document.querySelectorAll('main h3')].some(x=>x.textContent.includes('O que pretende analisar')) || [...document.querySelectorAll('main button')].some(x=>x.textContent.trim()==='Nova análise')"), 'Scanner após restauro');
    await clickMain('Nova análise');
    await until(() => evaluate("[...document.querySelectorAll('main h3')].some(x=>x.textContent.includes('O que pretende analisar'))"), 'Scanner pronto para reanálise');
    await evaluate('window.__papProgress=[]');
    await dropFixture();
    facts.rescan = await until(() => evaluate('window.__papProgress.find(s=>["completed","failed","cancelled"].includes(s.status))'), 'reanálise dos bytes restaurados', 120000);
    assert.equal(facts.rescan.status, 'completed');
    assert.equal(await clickSidebar('Ameaças'), true);
    await until(() => evaluate("[...document.querySelectorAll('main h1')].some(x=>x.textContent.includes('Ameaças'))"), 'Ameaças após reanálise');
    assert.equal(await clickMainStarts('Deteções'), true, 'aba Deteções');
    await until(async () => (await bodyText()).includes(TARGET_NAME), 'deteção ainda listada', 15000);
    await until(() => clickMainStarts('Colocar em quarentena'), 'segunda deteção acionável', 30000);
    await until(() => evaluate('Boolean(document.querySelector(\'[role=dialog][aria-label="Confirmar quarentena"]\'))'), 'diálogo do segundo isolamento', 15000);
    await evaluate(
      `(() => { const d=document.querySelector('[role=dialog][aria-label="Confirmar quarentena"]'); const b=[...d.querySelectorAll('button')].find(x=>x.textContent.trim()==='Confirmar'); b?.click(); })()`,
    );
    await until(() => !fs.existsSync(targetPath), 'alvo ausente no segundo isolamento', 30000);
    const segundaLista = await until(async () => {
      const list = await evaluate('window.electronAPI.getQuarantineFiles()');
      return list.length === 1 ? list : null;
    }, 'segunda entrada na quarentena', 30000);
    const segundaEntrada = segundaLista[0];
    assert.equal(segundaEntrada.sha256, CANARY_SHA);
    assert.equal(await clickMainStarts('Quarentena'), true, 'aba Quarentena (segunda)');
    await until(async () => (await bodyText()).includes(TARGET_NAME), 'segunda entrada visível', 15000);
    assert.equal(await clickAria(`Eliminar ${TARGET_NAME} permanentemente`), true, 'botão Eliminar');
    await until(async () => (await bodyText()).includes('Eliminar permanentemente?'), 'confirmação da eliminação', 15000);
    assert.equal(await clickAria(`Confirmar eliminação de ${TARGET_NAME}`), true, 'confirmar eliminação');
    await until(async () => (await evaluate('window.electronAPI.getQuarantineFiles()')).length === 0, 'lista vazia após eliminação', 30000);
    facts.afterDelete = {
      entryAbsent: !fs.existsSync(path.join(serviceDir, 'quarantine', `${segundaEntrada.id}.quarantine`)),
      targetAbsent: !fs.existsSync(targetPath),
      entries: await evaluate('window.electronAPI.getQuarantineFiles()'),
    };
    assert.equal(facts.afterDelete.entryAbsent, true, 'o blob foi eliminado');
    assert.equal(facts.afterDelete.targetAbsent, true, 'o ficheiro original não voltou');
    await safeShot('quarantine-deleted');

    // 8. O gate continua a mandar: scan completo/quick segue recusado.
    facts.gateRefusal = await evaluate(
      "window.electronAPI.startScan('quick', undefined, 'scanner-page').then(r=>({result:r}),e=>({error:String(e)}))",
    );
    assert.match(JSON.stringify(facts.gateRefusal), /realdev_fixture_gate/, 'o gate tem de continuar a recusar scan quick');

    // 9. Auditoria da camada: each write accounted, zero post-checks falhados.
    const auditFile = path.join(serviceDir, 'quarantine-harness-audit.jsonl');
    const linhas = fs.existsSync(auditFile)
      ? fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const contar = (decision, method) => linhas.filter((l) => l.decision === decision && (!method || l.method === method)).length;
    facts.audit = {
      total: linhas.length,
      install: contar('allow', 'install'),
      quarantineAllowed: contar('allow', 'threat.action'),
      restoreAllowed: contar('allow', 'quarantine.restore'),
      deleteAllowed: contar('allow', 'quarantine.delete'),
      postCheckFailed: contar('postcheck-failed'),
      releaseFailed: contar('release-failed'),
      engineRefused: contar('engine-refused'),
      decisions: linhas.map((l) => `${l.decision}:${l.method}`),
    };
    fs.copyFileSync(auditFile, path.join(evidence, 'quarantine-harness-audit.jsonl'));
    assert.equal(facts.audit.install, 1, 'camada instalada exactamente uma vez');
    assert.equal(facts.audit.quarantineAllowed, 2, 'dois isolamentos permitidos');
    assert.equal(facts.audit.restoreAllowed, 1, 'um restauro permitido');
    assert.equal(facts.audit.deleteAllowed, 1, 'uma eliminação permitida');
    assert.equal(facts.audit.postCheckFailed, 0, 'nenhuma pós-condição falhou');
    assert.equal(facts.audit.releaseFailed, 0, 'nenhuma lease ficou presa');
    }

    if (INTERACTIVE) {
      // Repõe o alvo com os MESMOS bytes (mesmo digest da sessão), para o
      // operador encontrar a fixture no ponto de partida, e mantém a pilha viva.
      if (!fs.existsSync(targetPath)) fs.writeFileSync(targetPath, CANARY_BYTES);
      const orcamento = INTERACTIVE_ONLY ? 'intacto (2 isolamentos, 1 restauro, 1 eliminação)' : 'gasto pela prova automática';
      facts.interactive = {
        mode: INTERACTIVE_ONLY ? 'hold-only' : 'proof+hold',
        target: targetPath,
        digest: CANARY_SHA,
        budget: orcamento,
        exit: 'Enter no terminal (ou Ctrl+C)',
        maxWaitMs: INTERACTIVE_MAX_MS,
      };
      fs.writeFileSync(path.join(evidence, 'smoke-facts.json'), JSON.stringify(facts, null, 2));
      console.log(
        [
          '',
          '=== MODO INTERACTIVO ===',
          `Fixture: ${targetPath}`,
          `SHA-256: ${CANARY_SHA}`,
          `Orçamento de escrita: ${orcamento}`,
          'Fluxo: Scanner -> arrastar a pasta do fixture -> Ameaças -> "Colocar em quarentena…" -> Confirmar;',
          '       aba Quarentena -> Restaurar / Eliminar (cada ação pede confirmação).',
          'Guardas intactas: só este alvo, só IDs desta sessão, sem proteção em tempo real/USB/processos.',
          'Carrega Enter no terminal para encerrar a pilha (ou Ctrl+C).',
          '',
        ].join('\n'),
      );
      await esperarOperador();
    }


    facts.rendererText = await evaluate('document.body.innerText.slice(0,16000)');
    facts.scope =
      'Electron real com launcher isolado; UI real (Ameaças/Quarentena), IPC de preload real e serviço real com a camada de fixture; '
      + 'fixture sintetica de 2 ficheiros sem canário EICAR e sem malware; ClamAV com base local copiada, nunca descarregada; zero caminhos pessoais.';
    facts.limitations = [
      'Prova o fluxo de quarentena/restauro/eliminacao da fixture; nao prova protecao em tempo real, USB, processos, rede ou definicoes.',
      'trustAfterRestore nao e exercitado pela UI; a recusa estrita vive no bootstrap e verifica-se por revisao.',
      'A cobertura antivirus nao e afirmada: a deteccao e a canario sintetica da fixture, por regra canonica + hash de fixture.',
    ];
    fs.writeFileSync(path.join(evidence, 'smoke-facts.json'), JSON.stringify(facts, null, 2));
    console.log('QUARANTINE SMOKE: deteccao, quarentena, restauro e eliminacao confirmados no Electron real.');
  } catch (error) {
    smokeError = error;
    facts.failure = String(error.message);
    if (cdp) {
      try {
        facts.rendererText = await cdp.evaluate('document.body.innerText.slice(0,16000)');
      } catch {}
      await safeShot('failure');
    }
    fs.writeFileSync(path.join(evidence, 'smoke-facts.json'), JSON.stringify(facts, null, 2));
    console.error('QUARANTINE SMOKE FAILED:', error.message);
  } finally {
    if (INTERACTIVE && serviceDir && evidence) {
      // Em modo interactivo a auditoria só está completa depois da sessão manual:
      // copia-se aqui, antes de o runner apagar a raiz isolada.
      try {
        const auditFile = path.join(serviceDir, 'quarantine-harness-audit.jsonl');
        if (fs.existsSync(auditFile)) fs.copyFileSync(auditFile, path.join(evidence, 'quarantine-harness-audit-interactive.jsonl'));
        let finalEntries = null;
        try {
          finalEntries = await cdp?.evaluate('window.electronAPI.getQuarantineFiles()');
        } catch {}
        fs.writeFileSync(
          path.join(evidence, 'interactive-facts.json'),
          JSON.stringify(
            {
              observedAt: new Date().toISOString(),
              mode: INTERACTIVE_ONLY ? 'hold-only' : 'proof+hold',
              fixtureRoot,
              targetPath,
              digest: CANARY_SHA,
              targetPresent: fs.existsSync(targetPath),
              quarantineEntries: finalEntries,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        console.error('interactive evidence:', String(error.message));
      }
    }
    cdp?.close();
    stop();
  }
};

const result = await run({ argv: ['--start', '--owned-direct', '--gui-cdp'], env: process.env, deps });
const summary = {
  blocked: result.blocked,
  ready: result.ready,
  cleanup: result.cleanup,
  smokeError: smokeError?.message,
  evidence,
  root: result.plan?.root,
};
if (evidence) {
  fs.writeFileSync(path.join(evidence, 'runner.log'), logs.join('\n'));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(summary, null, 2));
}
console.log(JSON.stringify(summary, null, 2));
process.exitCode = result.blocked || smokeError || result.cleanup?.allDead !== true ? 1 : 0;
