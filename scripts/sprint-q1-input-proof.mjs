/**
 * TP-PAP-UI-E2E-FAILURES-20261028 — Qoder — prova de interface em ELECTRON REAL.
 *
 * O que isto é: o launcher isolado do CyberSafe (`dev-isolated-run.mjs`, com
 * `--start --owned-direct --gui-cdp`) e a camada de fixture de quarentena já
 * existente (`dev-quarantine-fixture-service.mjs`) — o mesmo harness que o Codex
 * usa. Não há launcher novo, não há stubs de produto, não há motores falsos.
 * O que este script acrescenta é só o que ele observa e por onde injeta falhas.
 *
 * Provas (todas no renderer REAL, com preload e IPC reais):
 *   A. controlo positivo: quarentena realmente vazia diz «A quarentena está vazia».
 *   B. largar uma PASTA: o serviço confirma `targetKind:"directory"` e o cartão
 *      por ficheiro deixa de se chamar «Ficheiro analisado» e de oferecer
 *      «Analisar com os motores» (UI-D4).
 *   C. CTA: com deteções medidas, existe «Ver as N deteções em Ameaças» e o
 *      clique muda mesmo a página (UI-B, ligado pelo Codex em App.tsx).
 *   D. cancelamento: a frase mostrada é a que o contrato autoriza, e uma sessão
 *      nova não herda o estado de cancelamento da anterior (UI-D1, guard de
 *      identidade).
 *   E. sucesso com aviso: `success:true` acompanhado de `error` mostra sucesso +
 *      aviso, e o aviso sobrevive ao recarregamento (P1).
 *   F/G. bridge em encerramento (reads devolvem `null`): a Quarentena diz que não
 *      conseguiu ler e nunca afirma vacuidade (UI-D3); o histórico entra em
 *      «sem confirmação» sem `TypeError` (UI-D2).
 *
 * Injeção de falha — declarada, não escondida:
 *   F/G usam `window.electronAPI.beginShutdown()`, que é UMA FUNÇÃO DO PRODUTO:
 *   marca a bandeira de encerramento na própria bridge (`preload.ts:37-39`) e faz
 *   `invoke()` devolver `Promise.resolve(null)` (`preload.ts:12-17`). Não há
 *   substituição de código; é o caminho documentado que a app segue quando o
 *   utilizador confirma «Sair». O serviço e o main continuam vivos.
 *   E substitui a devolução de `restoreQuarantine` no lado do renderer, quando o
 *   objeto da bridge o permite (verificado e registado em `facts.aviso.injection`).
 *   O motivo: o `success:true + error` real do core só acontece quando a
 *   publicação do destino falhou depois de escrita — não há forma de provocar
 *   isso numa fixture sem ajuda do backend. Isto é dito na evidência, não fingido.
 *
 * Limites:
 *   - só fixtures dentro da raiz da sessão; zero caminhos pessoais;
 *   - orçamento de escrita do harness respeitado: usa 1 dos 2 isolamentos,
 *     0 restauros reais, 0 eliminações reais;
 *   - sem rede, sem updates, sem proteção em tempo real, sem matar processos
 *     alheios; o encerramento é pedido pelo IPC próprio do runner.
 *
 * Execução (dentro da lane, onde `packages/app` é a minha cópia com POST2):
 *   node scripts/qoder-ui-fault-proof.mjs
 *   node scripts/qoder-ui-fault-proof.mjs --evidence <dir- absoluto-da-lane>
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { BUILTIN_HASH_SIGNATURES } from '../packages/core/dist/signatures.js';
import { DEV_TEST_YARA_CANONICO, DEV_TEST_YARA_MARCA } from '../packages/service/dist/dev-test-yara.js';
import { run, realDeps } from './dev-isolated-run.mjs';

const SHIM = path.resolve('scripts/dev-quarantine-fixture-service.mjs');
const TARGET_NAME = 'qoder-fault-target.txt';
const BENIGN_NAME = 'qoder-fault-control.txt';
const MANIFEST_SCHEMA = 'cybersafe-quarantine-fixture-v1';
const DEFAULT_CLAMAV_DB = 'C:/Users/caioc/.cybersafe-integration/pap-integration-p0-codex-20261027/freshclam-validation/database';
// Deve bater com `QUARENTENA_ATUALIZAR_ARIA` de QuarantinePage.tsx (testado lá).
const ATUALIZAR_ARIA = 'Atualizar a lista de quarentena a partir do serviço';
const AVISO_SERVICO =
  'Ficheiro restaurado; limpeza, permissoes ou metadados pendentes. Entrada preservada para recuperacao. EPERM: chmod (motivo reproduzido por qoder-ui-fault-proof; nao veio do serviço)';

const argv = process.argv.slice(2);
const evidenceArg = argv[argv.indexOf('--evidence') + 1];
const EVIDENCE_DIR = evidenceArg && evidenceArg.startsWith('--') ? null : evidenceArg || null;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CANARY_BYTES = Buffer.from(DEV_TEST_YARA_MARCA);
const CANARY_SHA = sha256(CANARY_BYTES);
const timeout = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function connectPage(port) {
  const target = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((x) => x.type === 'page' && x.url === 'http://localhost:5173/');
  }, 'Electron renderer', 90000);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const events = [];
  // R4: ate aqui o conector so guardava o NOME do evento CDP. Uma falha em B
  // ficava sem stack nem sem origem — «capturou Dashboard» sem dizer se foi o
  // main a navegar, o renderer a recarregar ou uma excecao. Os payloads dos
  // eventos que explicam essas tres hipoteses passam a ser retidos.
  const METODOS_DE_INTERESSE =
    /^(Runtime\.exceptionThrown|Log\.entryAdded|Page\.navigatedWithinDocument|Page\.frameNavigated|Page\.loadEventFired|Page\.javascriptDialogOpening|Page\.crashed|Inspector\.targetCrashed)$/;
  const detalhes = [];
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.method) {
      events.push(msg.method);
      if (METODOS_DE_INTERESSE.test(msg.method)) {
        // R5 — com `detalhes.length < 80` ficavam os PRIMEIROS 80, e uma falha
        // tardia (depois de B, C, D) não deixava nada. O buffer roda: guarda a
        // cauda, que é onde está a causa.
        detalhes.push({ em: Date.now(), method: msg.method, params: msg.params });
        if (detalhes.length > 80) detalhes.splice(0, detalhes.length - 80);
      }
    }
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
      }, 20000);
      pending.set(key, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text}: ${r.exceptionDetails.exception?.description ?? ''}`);
    return r.result?.value;
  };
  return { send, evaluate, events, detalhes, close: () => ws.close() };
}

const deps = realDeps();
const originalSpawn = deps.spawn;
let fixtureRoot;
let targetPath;
let serviceDir;
let evidence;

deps.spawn = (cmd, args, options) => {
  const env = { ...options.env };
  const isServiceEntry = (arg) => /packages[\\/]service[\\/]dist[\\/]index\.js$/.test(String(arg));
  const service = args.some(isServiceEntry);
  const desktop = String(cmd).toLowerCase().endsWith('electron.exe');

  if (service) {
    assert.equal(env.CYBERSAFE_DEV_ISOLATION, '1');
    assert.equal(env.CYBERSAFE_USB_PROTECTION, '0');
    assert.equal(env.CYBERSAFE_STARTUP_RESUME, '0');
    serviceDir = env.CYBERSAFE_DEV_SERVICE_DIR;
    assert.ok(serviceDir, 'serviço isolado sem CYBERSAFE_DEV_SERVICE_DIR');

    fixtureRoot = path.join(env.CYBERSAFE_DEV_ROOT, 'qoder-fault-fixtures');
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.mkdirSync(fixtureRoot, { recursive: true });
    targetPath = path.join(fixtureRoot, TARGET_NAME);
    fs.writeFileSync(targetPath, CANARY_BYTES);
    fs.writeFileSync(path.join(fixtureRoot, BENIGN_NAME), 'Harmless PAP fault-proof control.');

    const rootReal = fs.realpathSync.native(fixtureRoot);
    const manifestPath = path.join(env.CYBERSAFE_DEV_ROOT, 'qoder-fault-session.json');
    const files = [TARGET_NAME, BENIGN_NAME].map((name) => {
      const bytes = fs.readFileSync(path.join(rootReal, name));
      return { name, bytes: bytes.length, sha256: sha256(bytes) };
    });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ schema: MANIFEST_SCHEMA, root: rootReal, quarantineTarget: TARGET_NAME, files }, null, 2),
    );

    const corpus = path.join(env.CYBERSAFE_DEV_ROOT, 'qoder-fault-canary.yar');
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

    const dbSource = env.CYBERSAFE_QUARANTINE_HARNESS_CLAMAV_DB || DEFAULT_CLAMAV_DB;
    for (const name of ['main.cvd', 'daily.cvd', 'bytecode.cvd']) {
      assert.ok(fs.existsSync(path.join(dbSource, name)), `base ClamAV local ausente (${name} em ${dbSource}): a prova não corre e nada é descarregado`);
    }
    const dbDest = path.join(serviceDir, 'definitions/clamav');
    fs.mkdirSync(dbDest, { recursive: true });
    for (const name of ['main.cvd', 'daily.cvd', 'bytecode.cvd']) {
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
    args = args.map((arg) => (isServiceEntry(arg) ? SHIM : arg));
    assert.ok(args.includes(SHIM), 'a camada de fixture não foi montada');
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
    stop = () => resolve({ kind: 'signal', name: 'qoder-ui-fault-proof-complete' });
  });
  return { promise, dispose() {} };
};

const facts = {
  tp: 'TP-PAP-UI-E2E-FAILURES-20261028',
  owner: 'qoder',
  observedAt: new Date().toISOString(),
  provas: {},
  injecao: {
    f_g: 'window.electronAPI.beginShutdown() — função do produto (preload.ts:37-39); a partir daí invoke() devolve null (preload.ts:12-17). Nenhuma substituição de código.',
    e: 'substituição da devolução de restoreQuarantine no lado do renderer; mecanismo e eficácia registados.',
  },
};
let smokeError;

deps.onStackReady = async ({ plan, spawned }) => {
  evidence = path.join(plan.root, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  Object.assign(facts, {
    root: plan.root,
    apiPort: plan.apiPort,
    rendererPort: plan.rendererPort,
    ownedPids: spawned.map(({ name, pid }) => ({ name, pid })),
    fixture: { root: fixtureRoot, target: TARGET_NAME, sha256: CANARY_SHA },
  });

  const cdp = await connectPage(plan.debugPort);
  const evaluate = cdp.evaluate;
  const shot = async (name) => {
    try {
      const img = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(evidence, `${name}.png`), Buffer.from(img.data, 'base64'));
      (facts.screenshots ??= []).push(name);
    } catch (e) {
      (facts.screenshotsFailed ??= []).push(`${name}: ${e.message}`);
    }
  };
  const bodyText = () => evaluate('document.body.innerText');
  const clickSidebar = (label) =>
    evaluate(`(() => { const r=document.querySelector('[data-cs-sidebar=main]'); const b=[...r.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)}); if(!b) return false; b.click(); return true; })()`);
  const clickMain = (text) =>
    evaluate(`(() => { const b=[...document.querySelectorAll('main button')].find(x=>x.textContent.trim()===${JSON.stringify(text)}); if(!b) return false; b.click(); return true; })()`);
  const clickMainStarts = (prefix) =>
    evaluate(`(() => { const b=[...document.querySelectorAll('main button')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(prefix)})); if(!b) return false; b.click(); return true; })()`);
  const clickAria = (label) =>
    evaluate(`(() => { const b=document.querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']'); if(!b) return false; b.click(); return true; })()`);

  // Arrasto de uma PASTA real para a zona de largura, pelo evento de input do CDP.
  // R5 — o marcador vai para o âmbito da FUNÇÃO. Em R4 foi declarado `const`
  // dentro do `try`, e o `catch` do fim usava-o: a recolha de evidência
  // rebentava com «MARCADOR_BOOT is not defined» exatamente na corrida que
  // precisava dela.
  const MARCADOR_BOOT = `qoder-${randomBytes(4).toString('hex')}`;
  const arrastoObservado = [];
  const drag = { items: [], files: [fixtureRoot], dragOperationsMask: 1 };
  const dropFolder = async () => {
    // R6 - WvJtu7 deixou isto medido: o ponto calculado a partir do `h3` caiu no
    // controlo flutuante «Opções» (rect 258,722 71x87) — dentro do rect do cartão,
    // mas NÃO dentro do contentor que tem os ouvintes. Os três eventos foram ter a
    // um botão e os 120 s do `until` expiraram sem `scan.start`.
    // Em vez de uma coordenada única, o runner procura um ponto que seja mesmo do
    // contentor: sobe do cabeçalho até ao cartão com as classes do estado `idle`
    // (FileScannerPage.tsx:1465-1474), rola-o para o centro (`scrollIntoView`, scroll
    // normal, nada de produto alterado), propõe formas geométricas dentro do rect e
    // do viewport, e aceita a primeira em que `elementFromPoint` devolve um
    // descendente desse contentor. Se nenhuma desobstruir, falha já com o
    // diagnóstico completo — não repete o timeout de 120 s.
    const escolha = await evaluate(`(() => {
      const h = [...document.querySelectorAll('h3,h2')].find((x) => x.textContent.includes('O que pretende analisar'));
      if (!h) return { erro: 'cartao ausente' };
      let zona = h.parentElement;
      let profundidade = 0;
      // R6b (revisao do Codex): a saida por limite de 6 niveis acontecia sem nunca
      // ter provado as classes, e o teste seguinte so perguntava se existia
      // ancestral. Um contentor errado seria aceite e zona.contains(el) daria
      // verde falso - o contrario do falhar-cedo que R6 prometeu.
      // A bandeira revalida as classes do cartao dos ouvintes.
      let encontrouContentor = false;
      while (zona && profundidade < 6) {
        const c = String(zona.className || '');
        if (c.includes('rounded-xl') && c.includes('p-8')) {
          encontrouContentor = true;
          break;
        }
        zona = zona.parentElement;
        profundidade++;
      }
      if (!encontrouContentor || !zona || !zona.getBoundingClientRect) {
        return {
          erro: 'contentor de largar (rounded-xl + p-8) nao encontrado em 6 niveis',
          encontrouContentor,
          profundidade,
          classesDoUltimo: zona ? String(zona.className || '').slice(0, 200) : null,
        };
      }
      zona.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = zona.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rectZona = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      const propostas = [];
      const candidatas = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + r.width / 2, r.bottom - 24],
        [r.left + r.width * 0.25, r.top + r.height / 2],
        [r.left + r.width * 0.75, r.top + r.height / 2],
        [r.left + 24, r.top + r.height - 24],
        [r.right - 24, r.top + r.height - 24],
      ];
      for (const [x, y] of candidatas) {
        const foraDaJanela = x < 0 || y < 0 || x >= vw || y >= vh;
        const foraDoRect = x <= r.left + 4 || x >= r.right - 4 || y <= r.top + 4 || y >= r.bottom - 4;
        if (foraDaJanela || foraDoRect) { propostas.push({ x: Math.round(x), y: Math.round(y), rejeicao: foraDaJanela ? 'fora do viewport' : 'fora do rect' }); continue; }
        const el = document.elementFromPoint(x, y);
        if (!el) { propostas.push({ x: Math.round(x), y: Math.round(y), rejeicao: 'sem elemento' }); continue; }
        const contido = zona.contains(el);
        const er = el.getBoundingClientRect();
        propostas.push({
          x: Math.round(x), y: Math.round(y),
          etiqueta: el.tagName,
          texto: (el.textContent || '').trim().slice(0, 40),
          contido,
          rect: { x: Math.round(er.left), y: Math.round(er.top), w: Math.round(er.width), h: Math.round(er.height) },
        });
        if (contido) {
          return { ponto: { x, y }, rectZona, viewport: { vw, vh, dpr: window.devicePixelRatio }, propostas, profundidade, encontrouContentor };
        }
      }
      return { erro: 'nenhum ponto desobstruido dentro do contentor', encontrouContentor, rectZona, viewport: { vw, vh, dpr: window.devicePixelRatio }, propostas, profundidade };
    })()`);
    arrastoObservado.push({ em: Date.now(), tipo: 'escolha-do-ponto', escolha });
    if (!escolha || !escolha.ponto) {
      // Falha cedo: o diagnóstico vale mais do que outro timeout de 120 s.
      throw new Error(`drop: nenhum ponto do contentor de largar — ${JSON.stringify(escolha).slice(0, 1500)}`);
    }
    const location = escolha.ponto;
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, ...location, data: drag });
    // Chegou alguma coisa ao ouvinte do renderer? Regista-se já, sem esperar
    // pelo `until` que pode vir a expirar.
    await new Promise((r) => setTimeout(r, 400));
    arrastoObservado[arrastoObservado.length - 1] = {
      ...arrastoObservado[arrastoObservado.length - 1],
      progressosLogoApos: await evaluate('(window.__papProgress ?? []).map((s) => ({ status: s.status, targetKind: s.targetKind }))'),
      eventosCDPVisiveis: (cdp.events ?? []).slice(-12),
    };
  };

  try {
    // Sem `enable`, o CDP não emite exceptionThrown nem entryAdded — a recolha
    // de R4 ficava vazia por omissão do domínio, não por falta de erro.
    for (const dominio of ['Runtime.enable', 'Log.enable', 'Page.enable']) {
      try { await cdp.send(dominio); } catch { /* domínio indisponível não pára a prova */ }
    }
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

    // ── login sintético no Electron real ──
    await until(() => evaluate('Boolean(document.querySelector("#login-email") && window.electronAPI)'), 'login + preload', 90000);
    const apiBase = await evaluate('window.__CYBERSAFE_API_BASE__');
    assert.equal(apiBase, `http://127.0.0.1:${plan.apiPort}`, 'a API injetada no Electron tem de ser a da sessão isolada');
    const email = `qoder-fault-${randomBytes(4).toString('hex')}@example.test`;
    const password = randomBytes(18).toString('base64url') + '1!';
    const registered = await fetch(`${apiBase}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Qoder fault proof', email, password, type: 'personal' }),
    });
    assert.equal(registered.status, 201, `registo da conta isolada: HTTP ${registered.status}`);
    facts.registerStatus = registered.status;
    await evaluate(
      `(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; for (const [id,v] of ${JSON.stringify([
        ['login-email', email],
        ['login-password', password],
      ])}) { const i=document.getElementById(id); set.call(i,v); i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); } })()`,
    );
    await timeout(300);
    await evaluate('document.querySelector("form.auth-form").requestSubmit()');
    await until(() => evaluate('Boolean(document.querySelector("[data-testid=engine-grid]"))'), 'Dashboard autenticado', 90000);
    await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Agora não'); b?.click(); })()`);
    await timeout(400);

    // Rede de erro do renderer: nada escapa para um texto interno sem ser registado.
    await evaluate(
      `window.__papErrors=[]; window.__papConsole=[];
       window.addEventListener('error', e => window.__papErrors.push('error: ' + (e.message || String(e.error))));
       window.addEventListener('unhandledrejection', e => window.__papErrors.push('rejection: ' + String(e.reason)));
       const ce = console.error; console.error = (...a) => { window.__papConsole.push(a.map(x => String(x)).join(' ')); ce.apply(console, a); };`,
    );

    // AUTOMAÇÃO DO HARNESS, declarada: a assistência («O meu computador está
    // bem?») apresenta-se no meio do fluxo e a app vai para o Painel, o que
    // DESMONTA o Scanner e faz desaparecer o cartão que se quer observar. O
    // observador abaixo dispensa-a no instante em que aparece. Não é código de
    // produto: é o operador deste smoke a carregar «Agora não».
    await evaluate(
      `window.__papMatrizDispensadas = 0;
       new MutationObserver(() => {
         const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Agora não');
         if (b) { b.click(); window.__papMatrizDispensadas++; }
       }).observe(document.body, { childList: true, subtree: true });`,
    );
    // Observador de frases: o que a UI MOSTROU em algum momento, não apenas o
    // que está no ecrã quando o harness chega lá. Com uma fixture que cancela em
    // <400 ms, uma leitura pontual vê só o estado terminal e confundiria
    // velocidade com silêncio.
    await evaluate(
      `window.__papFrases = [];
       window.__papMarcas = {
         cancelPedido: 'Cancelamento pedido ao motor',
         cancelRecusado: 'O serviço não aceitou o cancelamento pedido',
         cancelSemConfirmacao: 'O serviço não confirmou o pedido de cancelamento',
         avisoRestauracao: 'Ação confirmada, com aviso do serviço:',
         quarentenaFalhou: 'Não foi possível ler a quarentena',
         quarentenaVazia: 'A quarentena está vazia',
         historicoSemConfirmacao: 'O serviço não devolveu nenhuma página de histórico',
         historicoFalhou: 'O histórico não pôde ser lido',
       };
       new MutationObserver(() => {
         const t = document.body.innerText;
         for (const [marca, texto] of Object.entries(window.__papMarcas)) {
           if (t.includes(texto) && !window.__papFrases.some((f) => f.marca === marca)) {
             window.__papFrases.push({ marca, texto, vistoEm: Date.now(), h1: document.querySelector('main h1')?.textContent ?? null });
           }
         }
       }).observe(document.body, { childList: true, subtree: true });`,
    );
    const frases = () => evaluate('window.__papFrases');

    // Banda de resultado de ação (V4) e lista real da quarentena — usadas em E e F.
    const banda = () =>
      evaluate(
        `(() => { const b = document.querySelector('[data-tipo]'); return b ? { tipo: b.dataset.tipo, texto: b.innerText, papel: b.getAttribute('role'), vivo: b.getAttribute('aria-live') } : null; })()`,
      );
    const lista = () => evaluate('window.electronAPI.getQuarantineFiles()');
    // Instrumentação de atribuição (item 5 do TP): distinguir NAVEGAÇÃO de
    // RECARGA do documento. O marcador `__papBoot` vive no window: se a app
    // recarregar (ex.: o error boundary do App.tsx chama `window.location.reload()`)
    // o marcador desaparece. As navegações vindas do main (tray) ficam registadas
    // por um segundo ouvinte do evento real do preload — observar não é alterar.
    await evaluate(
      `window.__papBoot = ${JSON.stringify(MARCADOR_BOOT)};
       window.__papNav = [];
       window.__papNavOrigem = (performance.getEntriesByType('navigation')[0] || {}).type || null;
       window.electronAPI.onNavigateRequest?.((p) => window.__papNav.push({ pagina: p, em: Date.now() }));`,
    );
    const estadoNavegacao = () =>
      evaluate('({ marcadorVivo: window.__papBoot === ' + JSON.stringify(MARCADOR_BOOT) +
        ', navegacoesDoMain: window.__papNav, origemDoDocumento: window.__papNavOrigem, h1: document.querySelector("main h1")?.textContent ?? null })');
    /**
     * Como se lê `facts.navegacao` no fim:
     *   marcadorVivo=true  + navegacoesDoMain=[{pagina:"dashboard"}] → foi o MAIN
     *     (tray: `sendToRenderer("dashboard")`, main.ts:915). Não é a Matrix.
     *   marcadorVivo=false → o documento foi RECARRRGADO (HMR do vite em dev, ou
     *     `reload()` do main depois de `render-process-gone`). A recarga repõe
     *     `page="dashboard"` e apaga o que a UI tinha em memória.
     *   marcadorVivo=true  + navegacoesDoMain=[]  + h1 do Painel → navegação
     *     dentro do renderer, e aí sim haveria código de produto a procurar.
     * Não há código de navegação no AIAssistant (sem `location`, `reload`,
     * `setPage`, `onNavigate`, `.click()`), e nenhum `exit.log` das sessões
     * preservadas regista `render-process-gone`/`unresponsive`.
     */

    facts.harness = {
      automatizacao: 'MutationObserver a carregar «Agora não» na assistência da Matrix sempre que ela aparece',
      motivo: 'sem isto a app navega para o Painel a meio do fluxo e o Scanner desmonta; as afirmações sobre o cartão deixariam de observáveis',
    };
    const erros = () => evaluate('({errors: window.__papErrors, console: window.__papConsole.slice(0,40)})');
    const semTypeError = (onde, snapshot) => {
      const tudo = [...snapshot.errors, ...snapshot.console].join('\n');
      assert.ok(!/Cannot read properties of (null|undefined)/.test(tudo), `${onde}: houve TypeError interno no renderer: ${tudo.slice(0, 300)}`);
      assert.ok(!/is not a function|reading 'entries'/.test(tudo), `${onde}: erro de runtime no renderer: ${tudo.slice(0, 300)}`);
    };

    // ───────────────────────────────────────────────────────────── A ──────────
    // Controlo positivo: com leitura confirmada e quarentena mesmo vazia, a
    // página DIZ «está vazia». Sem este controlo, a prova F não vale nada.
    {
      assert.equal(await clickSidebar('Ameaças'), true, 'sidebar Ameaças');
      await until(() => evaluate("[...document.querySelectorAll('main h1')].some(x=>x.textContent.includes('Ameaças'))"), 'página Ameaças');
      assert.equal(await clickMainStarts('Quarentena'), true, 'aba Quarentena');
      await until(async () => (await bodyText()).includes('A quarentena está vazia'), 'estado vazio real (leitura confirmada)', 30000);
      const lista = await evaluate('window.electronAPI.getQuarantineFiles()');
      const texto = await bodyText();
      facts.provas.A = {
        esperado: 'leitura confirmada + lista vazia ⇒ «A quarentena está vazia»',
        obtido: texto.includes('A quarentena está vazia'),
        entradasReais: Array.isArray(lista) ? lista.length : `não-array: ${String(lista)}`,
        dizFalhou: texto.includes('Não foi possível ler a quarentena'),
      };
      assert.equal(Array.isArray(lista) && lista.length === 0, true, 'a quarentena da sessão começa vazia');
      assert.equal(facts.provas.A.dizFalhou, false, 'sem falha de leitura não pode haver aviso de falha');
      await shot('A-vazio-confirmado');
    }

    // ───────────────────────────────────────────────────────────── B ──────────
    // Largar a PASTA: o serviço confirma directory; o cartão por ficheiro tem de
    // mudar de palavra e deixar de oferecer análise por motor.
    {
      assert.equal(await clickSidebar('Análise de Segurança'), true, 'sidebar Scanner');
      await until(() => evaluate("[...document.querySelectorAll('main h3')].some(x=>x.textContent.includes('O que pretende analisar'))"), 'Scanner pronto');
      await evaluate('window.__papProgress=[]; window.electronAPI.onScanProgress(s=>window.__papProgress.push(s))');
      await evaluate(`(()=>{window.__q1Input=[];for(const type of ['click','keydown'])document.addEventListener(type,e=>{const control=e.target.closest?.('button,a');window.__q1Input.push({type,trusted:e.isTrusted,key:e.key,text:control?.getAttribute('aria-label')||control?.textContent?.trim().slice(0,120),at:Date.now()});if(window.__q1Input.length>80)window.__q1Input.shift();},true);})()`);

      // R4 — GUARDA antes da largura. Não impede nem mascara navegação nenhuma:
      // regista se o Scanner está de facto montado neste instante e qual é a
      // origem do estado (marcador vivo, navegações pedidas ao renderer, tipo de
      // navegação do documento). Se a página tiver mudado, a guarda dá a
      // evidência em vez de deixar o `until` do cartão a expirar às cegas — foi
      // o que aconteceu no XLbL6R, onde se sabia que «capturou Dashboard» mas não
      // porquê.
      // Chave própria em `facts`, não dentro de `provas.B`: a prova B completa é
      // escrita mais à frente e seria substituída; e um `provas.B` parcial faria
      // o resumo contar «B completo» numa corrida que rebentou precisamente aqui.
      facts.antesDaLargura = await evaluate(
          `({ url: location.href,
             scannerVisivel: [...document.querySelectorAll('main h3')].some(x=>x.textContent.includes('O que pretende analisar')),
             h1: document.querySelector('main h1')?.textContent ?? null,
             marcadorVivo: window.__papBoot === ${JSON.stringify(MARCADOR_BOOT)},
             navegacoesDoMain: window.__papNav ?? null,
             origemDoDocumento: window.__papNavOrigem ?? null })`,
        );
      await dropFolder();

      // Diagnóstico imediato: o que é que a largura produziu NESTE instante?
      const logoAposLargura = await evaluate(
        `(() => ({ href: location.href, h1: document.querySelector('main h1')?.textContent ?? null,
                   temCartao: Boolean(document.querySelector('.cs-scanner-perfile')),
                   fase: document.querySelector('.cs-scanner-perfile')?.dataset?.fase ?? null,
                   evento0: window.__papProgress[0]?.status ?? null }))()`,
      );
      // O cartão muda quando o SERVIÇO confirma a pasta — e isso acontece antes
      // do terminal. Observa-se aqui, enquanto o Scanner está montado.
      const cartaoPasta = await until(
        () => evaluate(
          `(() => { const c=document.querySelector('.cs-scanner-perfile');
             if (!c || c.dataset.fase !== 'diretorio') return null;
             return { fase: c.dataset.fase, heading: c.querySelector('h3')?.textContent, texto: c.innerText,
                      temBotaoMotores: [...c.querySelectorAll('button')].some(b => b.textContent.includes('Analisar com os motores')) }; })()`,
        ),
        'cartão a mudar para pasta quando o serviço confirma',
        90000,
      );
      const scan = await until(
        () => evaluate('window.__papProgress.find(s=>["completed","failed","cancelled"].includes(s.status))'),
        'scan terminal da pasta',
        240000,
      );
      const noTerminal = await evaluate(
        `(() => ({ href: location.href, h1: document.querySelector('main h1')?.textContent ?? null,
                   h3: [...document.querySelectorAll('main h3')].map(x=>x.textContent).slice(0,6),
                   temCartao: Boolean(document.querySelector('.cs-scanner-perfile')),
                   fase: document.querySelector('.cs-scanner-perfile')?.dataset?.fase ?? null }))()`,
      );
      const eventos = await evaluate('window.__papProgress.map(s=>({status:s.status,targetKind:s.targetKind,targetPath:s.targetPath,filesAnalyzed:s.filesAnalyzed,threatsFound:s.threatsFound}))');
      const cartao = await evaluate(
        `(() => { const c=document.querySelector('.cs-scanner-perfile'); if(!c) return null;
           return { fase: c.dataset.fase, texto: c.innerText,
                    temBotaoMotores: [...c.querySelectorAll('button')].some(b=>b.textContent.includes('Analisar com os motores')),
                    heading: c.querySelector('h3')?.textContent }; })()`,
      );
      facts.provas.B = {
        scanTerminal: { status: scan.status, filesAnalyzed: scan.filesAnalyzed, threatsFound: scan.threatsFound },
        targetKindRealDoServico: eventos.filter((e) => e.targetKind).map((e) => e.targetKind).slice(-1)[0] ?? null,
        amostraEventos: eventos.slice(0, 6),
        logoAposLargura,
        noTerminal,
        cartaoPasta,
        cartaoNoTerminal: cartao,
        matrizDispensadaPeloHarness: await evaluate('window.__papMatrizDispensadas'),
        // Item 5: se a página tivesse sido perdida por RECARGA, o marcador de
        // boot já não existe; se foi por NAVEGAÇÃO, `navegacoesDoMain` diz qual.
        navegacao: await estadoNavegacao(),
      };
      // A imagem é tirada ANTES das asserções: se a prova falhar, o ecrã já está
      // guardado como evidência, não como mistério.
      await shot('B-apos-terminal');
      assert.equal(scan.status, 'completed', JSON.stringify(scan));
      assert.equal(scan.filesAnalyzed, 2, `a pasta da fixture tem 2 ficheiros: ${JSON.stringify(scan)}`);
      assert.equal(facts.provas.B.targetKindRealDoServico, 'directory', 'o serviço tem de confirmar a pasta');
      assert.ok(cartaoPasta, 'o cartão da largura tem de existir enquanto o Scanner está montado');
      assert.equal(cartaoPasta.fase, 'diretorio', `esperava cartão de pasta, veio ${cartaoPasta.fase}: ${cartaoPasta.texto}`);
      assert.match(cartaoPasta.heading, /Pasta largada/, 'a palavra acompanha o que o serviço confirmou');
      assert.equal(cartaoPasta.temBotaoMotores, false, 'uma pasta não oferece análise por motor de UM ficheiro');
      semTypeError('B (largar pasta)', await erros());
      await shot('B-pasta-confirmada');
    }

    // ───────────────────────────────────────────────────────────── C ──────────
    // CTA real: com deteções, o botão existe e leva a Ameaças.
    {
      const texto = await bodyText();
      const existe = await evaluate(
        `(() => { const b=[...document.querySelectorAll('main button')].find(x=>/Ver as \\d+ deteções em Ameaças/.test(x.textContent.trim())); return b ? b.textContent.trim() : null; })()`,
      );
      facts.provas.C = { notaSessaoTerminal: /Nenhum ficheiro foi isolado automaticamente/.test(texto), botao: existe };
      assert.ok(existe, `esperava o botão de Ameaças com ${scanThreats(facts)} deteções; ecrã: ${texto.slice(0, 400)}`);
      assert.equal(await evaluate(`(() => { const b=[...document.querySelectorAll('main button')].find(x=>/Ver as \\d+ deteções em Ameaças/.test(x.textContent.trim())); b.click(); return true; })()`), true);
      await until(() => evaluate("[...document.querySelectorAll('main h1')].some(x=>x.textContent.includes('Ameaças'))"), 'navegação pelo CTA', 30000);
      facts.provas.C.navegouParaAmeacas = true;
      await shot('C-cta-ameacas');
      assert.equal(await clickSidebar('Análise de Segurança'), true);
      await until(() => evaluate("[...document.querySelectorAll('main h3')].some(x=>x.textContent.includes('O que pretende analisar')) || [...document.querySelectorAll('main button')].some(x=>x.textContent.trim()==='Nova análise')"), 'Scanner após CTA');
    }

    // ───────────────────────────────────────────────────────────── D ──────────
    // Cancelamento honesto + uma sessão nova não herda o estado da anterior.
    //
    // A fixture de 2 ficheiros termina em segundos, e sem análise em curso não
    // há cancelamento para observar. Antes desta prova é escrita uma pasta de
    // trabalho maior (dentro da raiz da sessão, nada pessoal) para que exista
    // uma janela real onde o botão está ativo.
    {
      const raizD = path.join(fixtureRoot, 'miudo');
      fs.mkdirSync(raizD, { recursive: true });
      for (let i = 0; i < 60; i += 1) {
        fs.writeFileSync(path.join(raizD, `f-${i}.bin`), randomBytes(128 * 1024));
      }
      facts.provas.D = { fixtureMaior: { ficheiros: 60, bytesPorFicheiro: 128 * 1024, motivo: 'criar janela de cancelamento real' } };

      assert.equal(await clickSidebar('Análise de Segurança'), true);
      await until(() => evaluate("[...document.querySelectorAll('main h3')].some(x=>x.textContent.includes('O que pretende analisar')) || [...document.querySelectorAll('main button')].some(x=>x.textContent.trim()==='Nova análise')"), 'Scanner para D');
      await clickMain('Nova análise');
      await until(() => evaluate("[...document.querySelectorAll('main h3')].some(x=>x.textContent.includes('O que pretende analisar'))"), 'Scanner limpo para D');
      await evaluate('window.__papProgress=[]');
      await dropFolder();
      await until(() => evaluate('window.__papProgress.length > 0'), 'primeiro evento da sessão D');
      const botaoCancelar = "(() => { const b=[...document.querySelectorAll('main button')].find(x=>x.textContent.trim().startsWith('Cancela')); return b ? {texto:b.textContent.trim(),disabled:b.disabled} : null; })()";
      const tentaCancelar = async () => {
        const fim = Date.now() + 40000;
        while (Date.now() < fim) {
          const clicou = await evaluate(
            "(() => { const b=[...document.querySelectorAll('main button')].find(x=>x.textContent.trim()==='Cancelar'); if(!b||b.disabled) return false; b.click(); return true; })()",
          );
          if (clicou) return { clicou: true, estado: await evaluate(botaoCancelar) };
          const terminal = await evaluate('window.__papProgress.find(s=>["completed","failed","cancelled"].includes(s.status))');
          if (terminal) return { clicou: false, motivo: 'a sessão chegou a terminal antes do clique', estado: await evaluate(botaoCancelar) };
          await timeout(100);
        }
        return { clicou: false, motivo: 'botão nunca ficou ativo', estado: await evaluate(botaoCancelar) };
      };
      const cancelamento = await tentaCancelar();
      await timeout(400);
      const depoisTexto = await bodyText();
      // Diagnóstico do clique: onde estávamos, o que existia, e o que mudou.
      facts.provas.D.janela = await evaluate(
        `(() => {
           const b = [...document.querySelectorAll('main button')].filter(x => /^Cancela/.test(x.textContent.trim()));
           return {
             h1: document.querySelector('main h1')?.textContent ?? null,
             cartaoAtivoVisivel: Boolean(document.querySelector('[data-testid=scan-progress], .cs-scanner-progresso')) || Boolean(document.querySelector('main h1')),
             progressos: window.__papProgress.length,
             ultimoStatus: window.__papProgress.at(-1)?.status ?? null,
             ultimoId: window.__papProgress.at(-1)?.id ?? null,
             botoesCancelar: b.map(x => ({ texto: x.textContent.trim(), disabled: x.disabled, classe: String(x.className).slice(0, 60), aria: x.getAttribute('aria-label') })),
           };
         })()`,
      );
      const respostaCrua = await evaluate("window.electronAPI.cancelScan('id-que-nao-existe-de-ninguem').then(r=>({ok:r}),e=>({erro:String(e)}))");
      // O que o serviço responde ao id VIVO, medido pelo harness à margem da UI,
      // e o que o renderer tem registado como erro/consola neste instante.
      const idVivo = await evaluate('window.__papProgress.at(-1)?.id ?? null');
      const respostaViva = idVivo
        ? await evaluate(`window.electronAPI.cancelScan(${JSON.stringify(idVivo)}).then(r=>({ok:r}),e=>({erro:String(e)}))`)
        : null;
      const errosD = await erros();
      const notas = {
        pedido: depoisTexto.includes('Cancelamento pedido ao motor'),
        recusado: depoisTexto.includes('O serviço não aceitou o cancelamento pedido'),
        semConfirmacao: depoisTexto.includes('O serviço não confirmou o pedido de cancelamento'),
      };
      const frasesD = await frases();
      const marcasD = frasesD.map((f) => f.marca);
      Object.assign(facts.provas.D, {
        botaoAntes: cancelamento.estado,
        tentativa: cancelamento,
        notaVisivel: notas,
        frasesRegistadas: frasesD,
        probeContratoIdDesconhecido: respostaCrua,
        idVivo,
        probeIdVivo: respostaViva,
        errosDoRenderer: errosD,
      });
      if (cancelamento.clicou) {
        // Invariante, não coreografia: com uma fixture pequena o pedido é aceite
        // e o terminal chega no mesmo lote de actualizações, por isso a nota
        // intermédia pode NUNCA ter sido pintada. O que não é admissível é a UI
        // afirmar cancelamento sem aceitação, ou afirmar o fim antes do motor.
        const terminalD = await until(
          () => evaluate('window.__papProgress.find(s=>["completed","failed","cancelled"].includes(s.status))'),
          'terminal da sessão D',
          120000,
        );
        facts.provas.D.terminal = terminalD.status;
        const recusou = terminalD.status !== 'cancelled';
        if (recusou) {
          facts.provas.D.violacao = marcasD.includes('cancelRecusado') || marcasD.includes('cancelSemConfirmacao')
            ? null
            : 'a sessão não foi cancelada pelo serviço e a UI não disse nada sobre o cancelamento';
        } else {
          facts.provas.D.observacao =
            'aceite: o terminal (cancelled) chegou no mesmo ciclo de render; a nota intermédia «Cancelamento pedido ao motor» não chegou a ser pintada, o que é honesto — o que está em ecrã é o terminal do motor';
        }
        assert.equal(
          marcasD.includes('cancelPedido') && terminalD.status !== 'cancelled',
          false,
          'a UI prometeu «cancelamento pedido» a uma sessão que o serviço não cancelou',
        );
      } else {
        facts.provas.D.nota =
          `cancelamento não clicado (${cancelamento.motivo}); verifica-se apenas que a UI nada afirma indevidamente`;
      }
      assert.ok(
        !/^\s*Cancelado\b/m.test(depoisTexto) && !depoisTexto.includes('Análise cancelada.'),
        'a UI nunca pode declarar o fim sem o terminal do motor',
      );
      await shot('D-cancelamento');

      // Sessão NOVA: o estado da anterior não pode ter passado para aqui.
      await evaluate('window.__papProgress=[]');
      await clickMain('Nova análise');
      await until(() => evaluate("[...document.querySelectorAll('main h3')].some(x=>x.textContent.includes('O que pretende analisar'))"), 'Scanner para sessão nova');
      await dropFolder();
      await until(() => evaluate('window.__papProgress.length > 0'), 'evento da sessão nova');
      const nova = await bodyText();
      const botao = await evaluate(botaoCancelar);
      facts.provas.D.novaSessao = {
        herdaNotaCancelamento: nova.includes('Cancelamento pedido ao motor') || nova.includes('não aceitou o cancelamento'),
        botao,
      };
      assert.equal(facts.provas.D.novaSessao.herdaNotaCancelamento, false, 'a nota de cancelamento da sessão anterior passou para a nova');
      await until(
        () => evaluate('window.__papProgress.find(s=>["completed","failed","cancelled"].includes(s.status))'),
        'terminal da sessão nova',
        240000,
      );
      semTypeError('D (cancelamento)', await erros());
      await shot('D-nova-sessao');
    }

    // ───────────────────────────────────────────────────────────── E ──────────
    // V4 — estados de ação reais da Quarentena, SEM tocar na ponte do Electron.
    // Ordem ditada pelo orçamento do harness (2 isolamentos, 1 restauro, 1
    // eliminação) e pelo que é provável sem ajuda do backend:
    //   1. isolamento real pela aba Ameaças;
    //   2. destino do restauro ocupado — nesta composição a banda é
    //      `sem_confirmacao` (o gate devolve `ok:false`, o service-client
    //      REJEITA a promessa, o `invoke` lança, o `catch` de `run()` escreve
    //      «sem confirmação»). A entrada continua listada e nada se destrói.
    //      A banda `recusado` fica declarada como NÃO alcançável por aqui.
    //   3. restauro real (lease share3 do FreePi) — banda `confirmado` e a
    //      PERSISTÊNCIA da banda depois de a linha sair da lista;
    //   4. REANÁLISE dos bytes restaurados e segundo isolamento, para o
    //      `sem_confirmacao` em F (ponte em encerramento: a ação não chega ao
    //      serviço e a UI não pode fingir).
    {
      facts.provas.E = {};

      const isolarAlvo = async (rotulo) => {
        assert.equal(await clickSidebar('Ameaças'), true, `${rotulo}: sidebar Ameaças`);
        await until(() => evaluate("[...document.querySelectorAll('main h1')].some(x=>x.textContent.includes('Ameaças'))"), `${rotulo}: página Ameaças`);
        await until(() => clickMainStarts('Deteções'), `${rotulo}: aba Deteções`);
        await until(async () => (await bodyText()).includes(TARGET_NAME), `${rotulo}: deteção visível`, 30000);
        await until(() => clickMainStarts('Colocar em quarentena'), `${rotulo}: botão de quarentena`, 30000);
        await until(() => evaluate('Boolean(document.querySelector(\'[role=dialog][aria-label="Confirmar quarentena"]\'))'), `${rotulo}: diálogo`, 20000);
        await evaluate(
          `(() => { const d=document.querySelector('[role=dialog][aria-label="Confirmar quarentena"]'); const b=[...d.querySelectorAll('button')].find(x=>x.textContent.trim()==='Confirmar'); b?.click(); })()`,
        );
        await until(() => !fs.existsSync(targetPath), `${rotulo}: alvo ausente do disco`, 30000);
      };

      // Reanálise dos bytes que voltaram ao disco. Um evento de ameaça já
      // tratado (restaurado) continua na lista de Deteções com o seu estado de
      // quarentena e NÃO oferece «Colocar em quarentena»: sem uma leitura nova,
      // o segundo isolamento não tem alvo acionável. É a mesma ordem do harness
      // de quarentena do Codex (dev-quarantine-electron-proof.mjs), que reanalisa
      // entre o restauro e o segundo isolamento.
      const reanalisarAlvo = async (rotulo) => {
        assert.equal(fs.existsSync(targetPath) && fs.readFileSync(targetPath).equals(CANARY_BYTES), true, `${rotulo}: os bytes restaurados têm de estar no disco para serem reanalisados`);
        assert.equal(await clickSidebar('Análise de Segurança'), true, `${rotulo}: sidebar Scanner`);
        // A página pode estar ainda no terminal da análise anterior: aí o h3
        // «O que pretende analisar» não existe e o `getBoundingClientRect` do
        // ponto de largura apanha `null` (foi assim que R1 falhou E4 no DEV de
        // 28/10). Primeiro pede-se a nova análise, e só depois se espera pelo
        // cartão — a mesma ordem do harness do Codex
        // (dev-quarantine-electron-proof.mjs:407-412).
        await until(
          () => evaluate("[...document.querySelectorAll('main h3')].some(x=>x.textContent.includes('O que pretende analisar')) || [...document.querySelectorAll('main button')].some(x=>x.textContent.trim()==='Nova análise')"),
          `${rotulo}: Scanner após o restauro`,
          30000,
        );
        await clickMain('Nova análise');
        await until(
          () => evaluate("[...document.querySelectorAll('main h3')].some(x=>x.textContent.includes('O que pretende analisar'))"),
          `${rotulo}: cartão de nova análise pronto`,
          30000,
        );
        await evaluate('window.__papProgress=[]; window.electronAPI.onScanProgress(s=>window.__papProgress.push(s))');
      await evaluate(`(()=>{window.__q1Input=[];for(const type of ['click','keydown'])document.addEventListener(type,e=>{const control=e.target.closest?.('button,a');window.__q1Input.push({type,trusted:e.isTrusted,key:e.key,text:control?.getAttribute('aria-label')||control?.textContent?.trim().slice(0,120),at:Date.now()});if(window.__q1Input.length>80)window.__q1Input.shift();},true);})()`);
        await dropFolder();
        const novaLeitura = await until(
          () => evaluate('window.__papProgress.find(s=>["completed","failed","cancelled"].includes(s.status))'),
          `${rotulo}: reanálise terminal`,
          240000,
        );
        facts.provas.E.reanalise = {
          rotulo,
          status: novaLeitura.status,
          filesAnalyzed: novaLeitura.filesAnalyzed,
          threatsFound: novaLeitura.threatsFound,
        };
        assert.equal(novaLeitura.status, 'completed', `${rotulo}: a reanálise tem de terminar: ${JSON.stringify(novaLeitura)}`);
        assert.ok(novaLeitura.threatsFound >= 1, `${rotulo}: a reanálise dos bytes restaurados tem de reaparecer como deteção: ${JSON.stringify(novaLeitura)}`);
      };

      // 1. isolamento real
      await isolarAlvo('E1');
      const aposIsolar = await lista();
      facts.provas.E.isolamento = { entradas: aposIsolar.length, sha: aposIsolar[0]?.sha256, digestSessao: CANARY_SHA };
      assert.equal(aposIsolar.length, 1, 'uma entrada em quarentena');
      assert.equal(aposIsolar[0].sha256, CANARY_SHA, 'a entrada tem o digest da sessão');

      assert.equal(await clickMainStarts('Quarentena'), true, 'aba Quarentena');
      await until(async () => (await bodyText()).includes(TARGET_NAME), 'entrada visível na quarentena', 30000);

      // 2. destino ocupado: o destino do restauro passa a existir (bloco escrito
      //    pelo próprio harness, dentro da raiz da fixture). O que a composição
      //    faz com esta recusa foi MEDIDO no DEV de 28/10 (run E2 do harness de
      //    faults): o gate responde `ok:false`, o `service-client` rejeita a
      //    promessa, o `invoke` do preload lança e o `catch` de `run()`
      //    (QuarantinePage.tsx:347-353) escreve `sem_confirmacao`. A banda
      //    `recusado` exige um objeto `{ ok:false }` RESOLVIDO — caminho que não
      //    existe nesta composição. Expectativa errada, não limitação do harness:
      //    o produto NÃO é alterado para fabricar um `false` que não acontece.
      fs.writeFileSync(targetPath, 'qoder-ui-fault-proof: destino ocupado');
      assert.equal(await clickAria(`Restaurar ${TARGET_NAME} para o local original`), true, 'botão Restaurar (destino ocupado)');
      await until(async () => (await bodyText()).includes('Restaurar este ficheiro para o local original?'), 'confirmação do restauro', 20000);
      await clickAria(`Confirmar restauro de ${TARGET_NAME}`);
      await until(async () => (await banda())?.tipo === 'sem_confirmacao', 'banda sem-confirmação (destino ocupado)', 30000);
      const recusaBanda = await banda();
      const recusaLista = await lista();
      facts.provas.E.destinoOcupado = {
        banda: recusaBanda,
        esperado: 'sem_confirmacao',
        porque: 'gate ok:false → service-client rejeita → invoke lança → catch de run() (QuarantinePage.tsx:347-353)',
        entradaContinuaListada: recusaLista.length === 1,
        nomeVisivel: recusaBanda.texto.includes(TARGET_NAME),
        afirmouSucesso: /confirmada pelo servi/i.test(recusaBanda.texto),
        alvoIntactoNoDisco: fs.existsSync(targetPath),
      };
      assert.equal(recusaBanda.papel, 'alert', 'sem-confirmação é alert');
      assert.equal(facts.provas.E.destinoOcupado.entradaContinuaListada, true, 'a recusa não pode apagar o registo');
      assert.equal(facts.provas.E.destinoOcupado.nomeVisivel, true, 'a banda diz a que ficheiro respeita');
      assert.equal(facts.provas.E.destinoOcupado.afirmouSucesso, false, 'sem restauro não se pode afirmar sucesso');
      assert.equal(facts.provas.E.destinoOcupado.alvoIntactoNoDisco, true, 'o bloqueio não destrói o destino');
      // Redação factual (R2): o que está provado é o CAMINHO observável nesta
      // composição para este pedido — o gate responde `ok:false`, o
      // `service-client` rejeita e a banda é `sem_confirmacao`. Isso NÃO equivale
      // a dizer que `recusado` é inalcancável em geral: o objeto resolvido
      // `{ success:false, error }` do motor é um caminho diferente e existe; este
      // harness não o exerce, e não o confunde com a exceção do RPC.
      facts.provas.E.recusado = {
        resultado: 'nao exercido por este harness neste pedido',
        caminhoObservado: 'gate ok:false → rejeição do service-client → catch de run() → sem_confirmacao',
        caminhoNaoExercido: 'resposta RESOLVIDA com success:false vinda do motor — é outro caminho, e `decideResultadoAcao` trata-o como `recusado`',
        coberturaExistente: 'teste de componente (decideResultadoAcao/decideBandeira em quarantine-design-v2.test.ts)',
      };
      await shot('E2-destino-ocupado-sem-confirmacao');

      // 3. restauro real e persistência da banda
      fs.rmSync(targetPath, { force: true });
      assert.equal(await clickAria(`Restaurar ${TARGET_NAME} para o local original`), true, 'botão Restaurar (segunda tentativa)');
      await until(async () => (await bodyText()).includes('Restaurar este ficheiro para o local original?'), 'confirmação do restauro', 20000);
      await clickAria(`Confirmar restauro de ${TARGET_NAME}`);
      await until(async () => (await banda())?.tipo === 'confirmado', 'banda de confirmação', 30000);
      const confirmada = await banda();
      const listaDepois = await lista();
      // A razão de ser da V4: a linha desaparece; a frase do serviço tem de ficar.
      await timeout(1500);
      const aindaVisivel = await banda();
      const bytesVoltaram = fs.existsSync(targetPath) && fs.readFileSync(targetPath).equals(CANARY_BYTES);
      facts.provas.E.confirmado = {
        banda: confirmada,
        entrouListadaSaiu: listaDepois.length === 0,
        sobreviveuDepoisDoRecarregamento: aindaVisivel?.tipo === 'confirmado',
        textoAindaVisivel: aindaVisivel?.texto.includes(TARGET_NAME),
        bytesIguaisNoDisco: bytesVoltaram,
        papel: confirmada.papel,
        ariaLive: confirmada.vivo,
      };
      assert.equal(facts.provas.E.confirmado.entrouListadaSaiu, true, 'o restauro tirou a entrada da lista');
      assert.equal(facts.provas.E.confirmado.sobreviveuDepoisDoRecarregamento, true, 'a banda morreu com a linha — o defeito que a V4 veio fechar');
      assert.equal(facts.provas.E.confirmado.bytesIguaisNoDisco, true, 'o restauro devolveu os mesmos bytes');
      assert.equal(confirmada.papel, 'status', 'confirmação não é alert');
      await shot('E3-confirmado-persistente');

      // fechar a banda
      assert.equal(await clickAria(`Fechar o resultado da operação sobre ${TARGET_NAME}`), true, 'a banda fecha-se');
      await until(async () => (await banda()) === null, 'banda fechada', 15000);

      // 4. reanálise dos bytes restaurados e segundo isolamento, para o estado
      //    `sem_confirmacao` em F. Isolar o registo antigo da primeira análise
      //    seria isolar um facto que já não está no disco.
      await reanalisarAlvo('E4');
      await isolarAlvo('E4');
      assert.equal(await clickMainStarts('Quarentena'), true, 'aba Quarentena (2.ª)');
      await until(async () => (await bodyText()).includes(TARGET_NAME), 'segunda entrada visível', 30000);
      facts.provas.E.isolamento2 = { entradas: (await lista()).length };

      // O quarto estado (sucesso COM aviso do serviço) não é alcançável por aqui:
      // a ponte do contextBridge não é redefinível (`Cannot redefine property`) e
      // o `success:true + error` do core só aparece quando a limpeza falha DEPOIS
      // de publicar o destino. Fica à espera do helper de fixture do FreePi; se
      // `QODER_FIXTURE_CLEANUP_FAILURE=1`, regista-se que o harness ainda o não
      // exerce — nada de fingir que foi provado.
      facts.provas.E.sucessoComAviso = process.env.QODER_FIXTURE_CLEANUP_FAILURE
        ? { ambiente: 'QODER_FIXTURE_CLEANUP_FAILURE=1', nota: 'helper pedido ao FreePi; o harness ainda não o exerce' }
        : {
            resultado: 'nao alcancado em runtime',
            coberturaExistente: 'teste de componente (quarantine-success-warning.test.ts: decideResultadoAcao/decideBandeira)',
            oQueFalta: 'helper na camada de fixture que, publicado o destino, faça a limpeza falhar — é o caminho literal de packages/core/src/response.ts para { success:true, error:"…limpeza, permissoes ou metadados pendentes…" }',
          };
      semTypeError('E (estados de ação)', await erros());
    }

    // ───────────────────────────────────────────────────────────── F ──────────
    // Bridge em encerramento: `getQuarantineFiles()` devolve `null`.
    //
    // V4 mudou isto: na V3 o «Tentar novamente» só existia DEPOIS de um `falhou`,
    // por isso não havia forma de provocar a falha em runtime. Com a recarga
    // sempre disponível (um só botão no cabeçalho), o clique chama o
    // `fetchSnapshot` do contentor, a leitura devolve `null`, o `App.tsx` marca
    // `falhou` (App.tsx:405-416) e a página tem de o dizer sem afirmar vacuidade.
    // Prova-se também o quarto estado de ação: `sem_confirmacao`, com a ponte muda.
    {
      // A contagem de entrada é lida ANTES de desligar a ponte. Depois de
      // `beginShutdown` todas as leituras devolvem `null`, por isso um
      // «antes/depois» comparado por IPC dava `null`/`null` e a asserção de
      // preservação ficava indecidível — no R2 do DEV de 28/10 isso leu-se como
      // um `true` que ninguém podia afirmar. O que fica: contagem real antes,
      // preservação provada por DOM e por blob depois.
      const entradaAntes = await evaluate('window.electronAPI.getQuarantineFiles()');
      const haviaEntrada = Array.isArray(entradaAntes) ? entradaAntes.length : null;
      assert.ok(Array.isArray(entradaAntes), `antes de desligar, a leitura tem de ser um array: ${JSON.stringify(entradaAntes)}`);

      await evaluate('window.electronAPI.beginShutdown()');
      const sonda = await evaluate('window.electronAPI.getQuarantineFiles().then(v => (v === null ? "null" : typeof v))');
      facts.provas.F = { sondaNull: sonda, entradaAntes: haviaEntrada };
      assert.equal(sonda, 'null', 'a bandeira de encerramento da bridge tem de estar ativa');

      // F1 — ação com a ponte muda: `Eliminar` não chega ao serviço.
      assert.equal(await clickMainStarts('Quarentena'), true, 'aba Quarentena');
      await until(async () => (await bodyText()).includes(TARGET_NAME), 'entrada visível antes da ação muda', 20000);
      assert.equal(await clickAria(`Eliminar ${TARGET_NAME} permanentemente`), true, 'botão Eliminar');
      await until(async () => (await bodyText()).includes('Eliminar permanentemente?'), 'confirmação da eliminação', 20000);
      await clickAria(`Confirmar eliminação de ${TARGET_NAME}`);
      await until(async () => (await banda())?.tipo === 'sem_confirmacao', 'banda sem-confirmação', 30000);
      const bandaMuda = await banda();
      // Prova de preservação SEM IPC: a linha continua no DOM e o blob continua
      // no disco. `getQuarantineFiles()` já não responde nesta janela.
      const visivelNoDom = (await bodyText()).includes(TARGET_NAME);
      const linhasNoDom = await evaluate("[...document.querySelectorAll('main [data-quarantine-row],main tbody tr')].length");
      facts.provas.F.semConfirmacao = {
        banda: bandaMuda,
        entradaAntes: haviaEntrada,
        linhasNoDom,
        entradaContinuaListada: visivelNoDom,
        prova: 'DOM + blob; nenhuma leitura IPC depois de beginShutdown é usada como prova',
        blobContinuaNoDisco: fs.existsSync(path.join(serviceDir, 'quarantine'))
          ? fs.readdirSync(path.join(serviceDir, 'quarantine')).some((ficheiro) => ficheiro.endsWith('.quarantine'))
          : null,
        afirmouRestaurado: (bandaMuda?.texto || '').includes('confirmada pelo serviço'),
      };
      assert.equal(bandaMuda.papel, 'alert', 'sem-confirmação é alert');
      assert.equal(facts.provas.F.semConfirmacao.afirmouRestaurado, false, 'não pode afirmar sucesso que não aconteceu');
      assert.equal(facts.provas.F.semConfirmacao.entradaContinuaListada, true, 'a ação muda não apaga o registo visível');
      await shot('F1-sem-confirmacao');

      // F2 — recarga com a ponte muda: o contentor vê a falha e a página diz-na.
      assert.equal(await clickAria(ATUALIZAR_ARIA), true, 'botão de recarga presente (V4)');
      const recarregou = await until(
        async () => ((await bodyText()).includes('Não foi possível ler a quarentena') ? true : null),
        'aviso de leitura falhada',
        30000,
      ).then(() => true).catch(() => false);
      const texto = await bodyText();
      facts.provas.F.resultado = recarregou ? 'alcancado' : 'nao alcancado';
      facts.provas.F.observado = {
        afirmouVazia: texto.includes('A quarentena está vazia'),
        afirmouFalha: texto.includes('Não foi possível ler a quarentena'),
        ultimaLeituraRotulada: texto.includes('Última leitura confirmada'),
        entradaDaSessaoVisivel: texto.includes(TARGET_NAME),
        botaoRepetir: texto.includes('Tentar novamente'),
        frasesRegistadas: await frases(),
      };
      // Invariante: com a ponte muda a página não pode afirmar vacuidade que não
      // foi lida. E, desde a V4, a falha TEM de aparecer quando se pede a recarga
      // — se não aparecer, é violação, não limitação do harness.
      assert.equal(facts.provas.F.observado.afirmouVazia, false, 'sem leitura confirmada não se pode dizer «está vazia»');
      facts.provas.F.violacao = recarregou
        ? (facts.provas.F.observado.ultimaLeituraRotulada && facts.provas.F.observado.botaoRepetir
            ? null
            : 'a falha apareceu mas sem rótulo de última leitura ou sem botão de repetir')
        : 'pedi a recarga com a ponte muda e o estado "falhou" não apareceu';
      await shot('F-bridge-em-encerramento');
      semTypeError('F (leitura recusada)', await erros());
    }

    // ───────────────────────────────────────────────────────────── G ──────────
    // Mesmo estado de bridge, no painel do histórico: `null` não é erro nem vazio.
    {
      const sonda = await evaluate('window.electronAPI.getScanHistory().then(v => (v === null ? "null" : typeof v))');
      assert.equal(await clickSidebar('Análise de Segurança'), true);
      await until(() => evaluate("[...document.querySelectorAll('main h2')].some(x=>x.textContent.includes('Análises anteriores'))"), 'painel do histórico visível');
      assert.equal(await clickMain('Recarregar'), true, 'botão Recarregar do histórico');
      await until(async () => (await bodyText()).includes('O serviço não devolveu nenhuma página de histórico'), 'estado sem confirmação', 30000);
      const texto = await bodyText();
      const errosRenderer = await erros();
      facts.provas.G = {
        sondaNull: sonda,
        semConfirmacao: texto.includes('O serviço não devolveu nenhuma página de histórico'),
        negaLeituraDeVazio: texto.includes('Isto não quer dizer que não existam análises registadas'),
        chamouFalha: texto.includes('O histórico não pôde ser lido'),
        typErrorVisivel: /Cannot read properties of (null|undefined)/.test(texto),
        errosCapturados: errosRenderer,
        frasesRegistadas: await frases(),
      };
      assert.equal(facts.provas.G.sondaNull, 'null');
      assert.equal(facts.provas.G.semConfirmacao, true, 'tem de dizer que não houve página');
      assert.equal(facts.provas.G.chamouFalha, false, 'ausência de resposta não é falha de leitura');
      assert.equal(facts.provas.G.typErrorVisivel, false, 'texto interno no ecrã');
      semTypeError('G (histórico sem resposta)', errosRenderer);
      await shot('G-historico-sem-confirmacao');
    }

    facts.navegacao = await estadoNavegacao();
    facts.errosFinais = await erros();
    // R4: as exceções e as navegações vistas pelo CDP, com payload. O nome do
    // evento sozinho não explica nada; o stack e o `url` do evento são a
    // diferença entre «a página mudou» e «o main pediu dashboard».
    facts.excecoesCDP = (cdp.detalhes ?? [])
      .filter((e) => e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded')
      .slice(-25);
    facts.navegacoesCDP = (cdp.detalhes ?? []).filter((e) => e.method.startsWith('Page.')).slice(-25);
    facts.arrastoObservado = arrastoObservado.slice(-6);
    semTypeError('fecho', facts.errosFinais);
    // As violações registadas a meio do fluxo rebentam aqui, no fim, para que
    // todas as provas tenham sido medidas.
    const violacoes = Object.entries(facts.provas)
      .filter(([, v]) => v && typeof v === 'object' && v.violacao)
      .map(([k, v]) => `${k}: ${v.violacao}`);
    facts.violacoes = violacoes;
    assert.equal(violacoes.length, 0, violacoes.join(' | '));
    facts.scope =
      'Electron real (launcher isolado do projeto), preload/IPC reais, serviço real com a camada de fixture já existente; '
      + 'fixture sintética de 2 ficheiros, ClamAV com base local copiada; zero caminhos pessoais; 1 isolamento real, 0 restauros reais, 0 eliminações reais.';
    facts.limitations = [
      'A devolução de restoreQuarantine no caso E foi substituída no renderer: o success:true+error real do core exige falha depois de publicar o destino, o que a fixture não provoca sem ajuda do backend.',
      'F/G usam beginShutdown(), a bandeira de encerramento da bridge do produto; não é uma queda de pipe nem uma recusa do serviço.',
      'O cancelamento D observa o que o serviço respondeu nesta sessão; o probe com id inexistente é leitura do contrato, não comportamento esperado da UI.',
      'Proteção em tempo real, USB, processos, rede e definições não são exercitados.',
      'A cobertura antivírica não é afirmada: a deteção é o canário sintético da fixture.',
      'O estado a_ler da Quarentena não é alcançável neste fluxo (só existe antes do primeiro snapshot); fica coberto pelo teste de componente.',
    ];
  } catch (error) {
    smokeError = error;
    facts.failure = String(error.message);
    try { facts.q1InputTrace = await evaluate('window.__q1Input ?? []'); } catch {}
    try {
      facts.rendererTextOnFailure = await evaluate('document.body.innerText.slice(0,16000)');
    } catch {}
    // R4: o estado de navegacao era gravado so no ramo de sucesso. Quando a prova
    // rebentava em B, exatamente o caso que interessa ficava sem evidencia.
    try {
      facts.navegacaoOnFailure = await evaluate(
        '({ url: location.href, marcadorVivo: window.__papBoot === ' + JSON.stringify(MARCADOR_BOOT) +
        ', navegacoesDoMain: window.__papNav ?? null, origemDoDocumento: window.__papNavOrigem ?? null,' +
        ' h1: document.querySelector("main h1")?.textContent ?? null, h3: [...document.querySelectorAll("main h3")].map(x=>x.textContent).slice(0,4),' +
        ' renderizadorVivo: document.readyState })',
      );
    } catch (e) {
      facts.navegacaoOnFailure = { erro: String(e.message) };
    }
    try {
      facts.cdpOnFailure = (cdp.detalhes ?? []).slice(-20);
      facts.cdpEventosTail = (cdp.events ?? []).slice(-40);
    } catch (e) {
      facts.cdpOnFailure = { erro: String(e.message) };
    }
    try {
      const img = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(evidence, 'failure.png'), Buffer.from(img.data, 'base64'));
      // R6: R5 prometia `captureDeFalha` mas so o escrevia na falha. O caso de
      // sucesso tambem tem de ficar registado, senao «sem chave» e «sem captura»
      // leem-se igual na evidencia.
      facts.captureDeFalha = { gravado: true, bytes: Buffer.from(img.data, 'base64').length };
    } catch (e) {
      // Em R4 o `catch {}` calava uma captura de ecrã que não aconteceu. Sem
      // screenshot a evidência visual falta, e isso tem de se saber.
      facts.captureDeFalha = { gravado: false, motivo: String(e && e.message ? e.message : e) };
    }
    facts.arrastoObservado = arrastoObservado.slice(-6);
    console.error('QODER UI FAULT PROOF FAILED:', error.message);
  } finally {
    try {
      fs.writeFileSync(path.join(evidence, 'fault-facts.json'), JSON.stringify(facts, null, 2));
    } catch (e) {
      console.error('evidência:', String(e.message));
    }
    cdp.close();
    stop?.();
  }
};

function scanThreats(f) {
  return f?.provas?.B?.scanTerminal?.threatsFound ?? '?';
}

const result = await run({ argv: ['--start', '--owned-direct', '--gui-cdp'], env: process.env, deps });
const summary = {
  blocked: result.blocked,
  ready: result.ready,
  cleanup: result.cleanup,
  proofError: smokeError?.message,
  provasCompletas: Object.keys(facts.provas),
  evidence,
  root: result.plan?.root,
};
if (evidence) {
  fs.writeFileSync(path.join(evidence, 'runner.log'), logs.join('\n'));
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(summary, null, 2));
}
if (EVIDENCE_DIR) {
  // A raiz isolada fica em TEMP e pode ser apagada; a evidência tem de viver na lane.
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  if (evidence && fs.existsSync(evidence)) {
    for (const nome of fs.readdirSync(evidence)) {
      fs.copyFileSync(path.join(evidence, nome), path.join(EVIDENCE_DIR, nome));
    }
  }
  // Mesmo sem chegar à stack, o que se sabe fica registado.
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'fault-facts.json'), JSON.stringify(facts, null, 2));
  summary.evidenceCopy = { dir: EVIDENCE_DIR, ficheiros: fs.readdirSync(EVIDENCE_DIR) };
}
console.log(JSON.stringify(summary, null, 2));
process.exitCode = result.blocked || smokeError || result.cleanup?.allDead !== true ? 1 : 0;

