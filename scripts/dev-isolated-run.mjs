#!/usr/bin/env node
/**
 * dev-isolated-run.mjs — TP-REAL-BOOT-RUNNER (owner=qoder).
 *
 * Lança a stack de DEV do CyberSafe num PERFIL DE TESTE ISOLADO, sem tocar na
 * instalação pessoal, sem ativar proteção/monitor/scan e sem criar conta. Par de
 * execução do `dev-isolated-preflight.mjs` (intocado — o runner CHAMA-O e
 * respeita o veredito).
 *
 *   node scripts/dev-isolated-run.mjs            → --dry-run (default): só plano.
 *   node scripts/dev-isolated-run.mjs --start    → executa (após revisão).
 *   ... --start --clean                          → apaga a raiz SÓ depois de todos
 *                                                   os filhos confirmados mortos.
 *
 * Correções da Revisão 3 (2026-10-18), cada uma com teste de regressão:
 *   A. Ciclo de vida REAL: handlers SIGINT/SIGTERM registados ANTES do spawn;
 *      `run` aguarda o settle (sinal OU saída do Electron OU erro de um filho),
 *      faz cleanup AGUARDADO e idempotente, e remove os handlers. O CLI usa o
 *      resultado de `run` para sair — Ctrl-C limpa a sério.
 *   B. Readiness estrita: API exige 200 + corpo de health (4xx/401/404 NÃO contam);
 *      renderer exige 200 + HTML na origem exata (localhost:5173). O comando do
 *      app passa `--strictPort` explícito (sem editar o produto) para o Vite não
 *      cair para 5174; o Electron só lança depois de API+renderer+pipe provados.
 *   C. Cleanup comprovado: `killTree` (taskkill) é uma PROMISE aguardada com
 *      status; um filho só conta como morto se o kill confirmar E o processo
 *      emitir `exit` real (não `error` nem "sem-emissor"). Sem prova → mantém a
 *      raiz e devolve status FAIL; nunca alega allDead.
 *
 * Mantém as correções das revisões 1–2 (binário Electron real, npm via npm-cli.js,
 * build do desktop antes do spawn, portas IPv4/IPv6, API só :4000).
 * Nenhuma dependência nova; só Node. Não usa Playwright.
 */
import os from "node:os";
import path from "node:path";
import net from "node:net";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFLIGHT = path.join(REPO, "scripts", "dev-isolated-preflight.mjs");
const DESKTOP_DIR = path.join(REPO, "packages", "desktop");
const PERSONAL_DIR = path.join(os.homedir(), ".cybersafe-service");
// A porta do DEV isolado é o piso do perfil dev do desktop (`DEV_API_PORT_FLOOR`), não
// o 4000 de produção. Motivo medido: `desktop/src/dev-isolation.ts` calcula
// `escolherPorta(pedido) = max(4100, pedido)` — qualquer pedido abaixo de 4100 é
// SILENCIOSAMENTE subido a 4100. Com o runner a fixar a API em 4000, o desktop injectava
// `http://127.0.0.1:4100` no renderer, a UI nunca falava com a API e o erro mostrado era
// «A API de contas não respondeu». Além disso 4000 é a porta da instalação real: manter
// o dev fora dela é a garantia, não um detalhe.
/**
 * Raiz REUTILIZÁVEL para o teste de engenharia de persistência (Q2-A): o harness cria
 * um `mkdtemp` UMA vez e passa a mesma raiz a dois ciclos, para que o segundo encontre
 * o mesmo DB/userData. Controlado por construção:
 *  - absoluto, dentro da base temporária, NUNCA a própria base nem o perfil pessoal;
 *  - `realpath` igual ao caminho léxico → nenhum ancestral pode ser junction/symlink;
 *  - nunca o diretório do serviço instalado (`PERSONAL_DIR`) nem qualquer pasta da app real;
 *  - manifesto de propriedade em `<raiz>/.cybersafe-dev-owner.json`: se outro PID VIVO é
 *    dono, a execução é recusada (o lock já cobre isto; o manifesto cobre o caso de o
 *    lock ter expirado com a pilha acordada).
 * Sem a variável, o comportamento é exactamente o de hoje (mkdtemp por execução).
 */
const API_PORT_REQUIRED = 4100;

export function validarRaizReutilizavel(candidato, deps, env = {}) {
  if (!candidato) return { ok: false, motivo: "sem candidato" };
  if (!path.isAbsolute(candidato)) return { ok: false, motivo: "raiz tem de ser absoluta" };
  const resolvido = path.resolve(candidato);
  const temp = path.resolve(deps.tmpdir());
  const relativo = path.relative(temp, resolvido);
  if (!relativo || relativo.startsWith("..") || path.isAbsolute(relativo)) return { ok: false, motivo: "fora da base temporária" };
  if (resolvido.toLowerCase() === temp.toLowerCase()) return { ok: false, motivo: "é a base temporária em geral, não uma raiz dedicada" };
  const pessoal = path.resolve(deps.homedir());
  if (resolvido.toLowerCase() === pessoal.toLowerCase()) return { ok: false, motivo: "é o diretório pessoal" };
  if (resolvido.toLowerCase().startsWith(path.join(pessoal, ".cybersafe-service").toLowerCase())) return { ok: false, motivo: "é o serviço instalado" };
  let real;
  try { real = deps.realpathSync(resolvido); } catch { return { ok: false, motivo: "não existe" }; }
  if (real.toLowerCase() !== resolvido.toLowerCase()) return { ok: false, motivo: `realpath difere (reparse em algum nível): ${resolvido} -> ${real}` };
  const manifesto = path.join(resolvido, ".cybersafe-dev-owner.json");
  if (deps.existsSync(manifesto)) {
    try {
      const dono = JSON.parse(deps.readFileSync(manifesto, "utf8"));
      if (dono.pid && deps.isAlive(dono.pid)) return { ok: false, motivo: `raiz pertence a outro run vivo (pid ${dono.pid})` };
    } catch { /* manifesto ilegível: re-adotado, a escrita a seguir substitui */ }
  }
  return { ok: true, root: resolvido, manifesto };
}

const RENDERER_PORT = 5173;
const SECRET_KEY_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|KEY|CREDENTIAL|JWT)/i;

function probeTcp(host, port, ms = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (r) => { try { s.destroy(); } catch {} resolve(r); };
    s.setTimeout(ms); s.once("connect", () => done(true)); s.once("timeout", () => done(false)); s.once("error", () => done(false));
  });
}
function probePipe(p, ms = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ path: p });
    const done = (r) => { try { s.destroy(); } catch {} resolve(r); };
    s.setTimeout(ms); s.once("connect", () => done(true)); s.once("timeout", () => done(false)); s.once("error", () => done(false));
  });
}
const defaultPipeName = (pid) => `\\\\.\\pipe\\cybersafe-dev-run-${pid}`;
const sameOrUnder = (c, p) => { const cc = path.resolve(c).toLowerCase(), pp = path.resolve(p).toLowerCase(); return cc === pp || cc.startsWith(pp + path.sep); };

/** (Revisão 1) binário Electron real via require('electron'). */
export function resolveElectron(deps) {
  let bin;
  try { bin = deps.requireElectron(); } catch (e) { return { error: `electron não resolvido: ${e.message}` }; }
  if (typeof bin !== "string" || !bin) return { error: "electron não devolveu caminho de binário" };
  if (!deps.existsSync(bin)) return { error: `binário electron inexistente: ${bin}` };
  return { cmd: bin, via: "electron-module" };
}
/** (Revisão 2) entry JS do npm junto ao node (sem shell, sem npm.cmd). */
export function resolveNpmCli(deps) {
  const p = path.join(path.dirname(deps.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return deps.existsSync(p) ? p : null;
}

export function buildPlan({ env, dryRun, deps }) {
  const { mkdtempSync, tmpdir, pid } = deps;
  const requestedPort = Number(env.CYBERSAFE_API_PORT || API_PORT_REQUIRED);
  const portValid = Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535;
  const portSupported = requestedPort === API_PORT_REQUIRED;
  // Raiz: por omissão é `mkdtemp` por execução (comportamento de sempre). Com
  // `CYBERSAFE_DEV_RUN_ROOT` o harness pede uma raiz JÁ criada e reutilizada entre
  // ciclos — só depois de validada; se a validação falhar, bloqueia antes de criar/spawn.
  const raizPedida = env.CYBERSAFE_DEV_RUN_ROOT;
  const raizValidada = raizPedida ? validarRaizReutilizavel(raizPedida, deps, env) : { ok: true, root: null };
  if (!raizValidada.ok) {
    return { dryRun, blocked: `run-root-invalida:${raizValidada.motivo}`, root: null, addedKeys: [] };
  }
  const root = raizValidada.root
    ? raizValidada.root
    : (dryRun ? path.join(tmpdir(), `cybersafe-dev-run-<dryrun-${pid}>`) : mkdtempSync(path.join(tmpdir(), "cybersafe-dev-run-")));
  const serviceDir = path.join(root, "service");
  const apiDbPath = path.join(root, "api", "cybersafe-test.db");
  const userDataDir = path.join(root, "electron-user-data");
  const pipeName = env.CYBERSAFE_DEV_PIPE_NAME || defaultPipeName(pid);
  // Escrever o manifesto é o que torna a recusa por "dono vivo" real: sem isto só havia
  // leitura, logo a proteção nunca disparava (achado do OpenCode). A escrita é só no
  // START: `run()` faz sempre um `buildPlan(dryRun:true)` de probe ANTES de validar
  // porta/exe, e escrever aí deixaria rastro de posse numa execução que não arranca nada
  // (achado directo do Codex). No dry-run nada é escrito.
  if (!dryRun && raizValidada.root && typeof deps.writeFileSync === "function") {
    try {
      deps.writeFileSync(raizValidada.manifesto, JSON.stringify({
        runId: path.basename(raizValidada.root),
        // `pid` vem de `deps.pid` e pode não existir; sem PID real o manifesto não serve
        // para nada, porque a recusa por dono vivo é condicionada a ele.
        pid: pid ?? process.pid, desde: new Date().toISOString(),
        root: raizValidada.root, serviceDir, apiDbPath, userDataDir, pipeName, apiPort: API_PORT_REQUIRED,
      }, null, 2));
    } catch { /* manifesto não escrito não pode impedir o arranque; a recusa fica mais fraca */ }
  }
  const isolationEnv = {
    ...env, CYBERSAFE_DEV_ISOLATION: "1", CYBERSAFE_DEV_SERVICE_DIR: serviceDir, CYBERSAFE_DEV_PIPE_NAME: pipeName,
    CYBERSAFE_DB_PATH: apiDbPath, CYBERSAFE_API_PORT: String(API_PORT_REQUIRED), CYBERSAFE_DEV_USER_DATA_DIR: userDataDir,
    // O perfil dev do desktop deriva `userData`/`session` de `CYBERSAFE_DEV_ROOT`
    // (`desktop/src/dev-isolation.ts:116/146`) e o `main.ts` faz `app.setPath("userData", ...)`
    // por cima do `--user-data-dir`. Sem esta linha, duas corridas "isoladas" partilhavam
    // `%TEMP%\cybersafe-dev\userData` — o leveldb gravado por uma aparecia como sessão
    // restaurada na seguinte. A raiz do runner tem de ser a raiz do desktop.
    CYBERSAFE_DEV_ROOT: root,
    // O perfil dev do desktop (`desktop/src/dev-isolation.ts:132`) lê `CYBERSAFE_DEV_PORT`,
    // NÃO `CYBERSAFE_API_PORT`. Sem esta linha o desktop caía no `DEV_API_PORT_FLOOR` (4100),
    // injectava `http://127.0.0.1:4100` no renderer e a UI nunca falava com a API isolada
    // em 4000 — o erro visível era «A API de contas não respondeu», que não diz isto.
    // As duas nomes têm de apontar para a MESMA porta escolhida por este runner.
    CYBERSAFE_DEV_PORT: String(API_PORT_REQUIRED),
  };
  const electron = resolveElectron(deps);
  const npmCli = resolveNpmCli(deps);
  const npm = (args) => ({ cmd: deps.execPath, args: [npmCli ?? "<npm-cli.js>", ...args] });
  // (TP-REAL-ELECTRON-GUI) modo TESTE opt-in: só com --gui-cdp o Electron abre um
  // listener CDP num port DEDICADO, preso a 127.0.0.1. Default OFF → sem flag.
  const debugPort = Number(env.CYBERSAFE_DEV_DEBUG_PORT);
  const guiCdp = Number.isInteger(debugPort) && debugPort >= 1024 && debugPort <= 65535;
  // (TP-CACHED-DEV-EXCEPTION) EXCEÇÃO DEV de perda de serviço: opt-in explícito,
  // inerte por defeito. Só existe para o cenário de teste LIVE→CACHED na cópia
  // isolada, e só se aplica ao filho `service` depois da readiness completa.
  const devServiceException = ["1", "true", "yes"].includes(String(env.CYBERSAFE_DEV_KEEP_UI_ON_SERVICE_EXIT ?? "").toLowerCase().trim());
  const desktopArgs = [".", "--user-data-dir=" + userDataDir];
  // R1 (TP-UNIFIED-RUNTIME-FINAL): o CDP de teste abre só em loopback e autoriza
  // UMA origem estrita — a mesma origem exata do renderer que a readiness já
  // exige. Nunca `*`: wildcard poria qualquer página local a falar com o
  // depurador do processo real.
  const ORIGEM_RENDERER_STRICTA = `http://localhost:${RENDERER_PORT}`;
  if (guiCdp) {
    desktopArgs.push(
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-allow-origins=${ORIGEM_RENDERER_STRICTA}`,
    );
  }
  const steps = {
    desktopBuild: { name: "desktop-build", ...npm(["run", "build", "-w", "@cybersafe/desktop"]), cwd: REPO, env: isolationEnv },
    spawn: [
      { name: "service", ...npm(["run", "dev:service"]), cwd: REPO, env: isolationEnv },
      { name: "api", ...npm(["run", "dev:api"]), cwd: REPO, env: isolationEnv },
      // (B) --strictPort CHEGA ao Vite: chamar o dev do workspace DIRETO
      // (`run dev -w @cybersafe/app -- --strictPort`), não o alias `dev:app`
      // (que é npm→npm e engolia a flag com "Unknown cli config").
      { name: "app", ...npm(["run", "dev", "-w", "@cybersafe/app", "--", "--strictPort"]), cwd: REPO, env: isolationEnv },
      { name: "desktop", cmd: electron.cmd ?? "<electron-binary>", args: desktopArgs, cwd: DESKTOP_DIR, env: isolationEnv },
    ],
  };
  const preflight = { cmd: deps.execPath, args: [PREFLIGHT], cwd: REPO, env: isolationEnv };
  const dirsToCreate = [serviceDir, path.dirname(apiDbPath), userDataDir];
  const personalTouched = dirsToCreate.some((d) => sameOrUnder(d, PERSONAL_DIR) || sameOrUnder(PERSONAL_DIR, d));
  return {
    dryRun, root, serviceDir, apiDbPath, userDataDir, pipeName, apiPort: API_PORT_REQUIRED, requestedPort, portValid, portSupported,
    rendererPort: RENDERER_PORT, debugPort: guiCdp ? debugPort : null, isolationEnv,
    devServiceException,
    addedKeys: ["CYBERSAFE_DEV_ISOLATION", "CYBERSAFE_DEV_SERVICE_DIR", "CYBERSAFE_DEV_PIPE_NAME", "CYBERSAFE_DB_PATH", "CYBERSAFE_API_PORT", "CYBERSAFE_DEV_USER_DATA_DIR", "CYBERSAFE_DEV_ROOT"],
    electron, npmCli, steps, preflight, dirsToCreate, personalTouched,
  };
}

export function renderPlan(plan) {
  const l = [];
  // Um plano bloqueado por raiz inválida não tem `electron`/`npmCli`/`steps`; sem este
  // guard a linha 206 lia `plan.electron.error` e rebentava com TypeError, pelo que a
  // razão do bloqueio nunca era impressa (medido pelo OpenCode em dry-run).
  if (plan.blocked) return `BLOCKED ${plan.blocked}`;
  l.push(`modo: ${plan.dryRun ? "DRY-RUN (nada criado, nenhum filho arrancado)" : "START"}`);
  l.push(`raiz de teste: ${plan.root}`);
  l.push(`  serviço : ${plan.serviceDir}\n  API DB  : ${plan.apiDbPath}\n  userData: ${plan.userDataDir}  (Electron --user-data-dir)`);
  l.push(`pipe isolado: ${plan.pipeName}`);
  l.push(`API porta   : ${plan.apiPort} (só :${API_PORT_REQUIRED}; pedida=${plan.requestedPort}${plan.portSupported ? "" : " → RECUSADA"})`);
  l.push(`renderer    : ${plan.rendererPort} (livre IPv4+IPv6; --strictPort; readiness 200 HTML antes do Electron)`);
  l.push(`CDP teste    : ${plan.debugPort ? `ON 127.0.0.1:${plan.debugPort} (--gui-cdp; só loopback)` : "OFF (sem --gui-cdp)"}`);
  l.push(`exceção DEV service: ${plan.devServiceException ? "ON (CYBERSAFE_DEV_KEEP_UI_ON_SERVICE_EXIT) — só [service], só após readiness" : "OFF (saída de qualquer filho encerra tudo)"}`);
  l.push(`electron    : ${plan.electron.error ? "ERRO: " + plan.electron.error : plan.electron.cmd}`);
  l.push(`npm entry   : ${plan.npmCli ?? "ERRO: npm-cli.js não encontrado junto ao node"}`);
  if (plan.personalTouched) l.push("  AVISO: caminho toca o diretório pessoal — preflight vai BLOQUEAR.");
  l.push("env de isolamento acrescentado (valores de segredo nunca impressos):");
  for (const k of plan.addedKeys) l.push(`  ${k}=${SECRET_KEY_RE.test(k) ? "<redacted>" : plan.isolationEnv[k]}`);
  const orig = Object.keys(plan.isolationEnv).filter((k) => !plan.addedKeys.includes(k));
  l.push(`chaves originais preservadas: ${orig.length} (valores NUNCA impressos; ${orig.filter((k) => SECRET_KEY_RE.test(k)).length} <redacted>)`);
  l.push("sequência só com --start:");
  l.push(`  1) preflight: ${plan.preflight.cmd} ${plan.preflight.args.join(" ")}`);
  l.push(`  2) build desktop (aguardado): ${plan.steps.desktopBuild.cmd} ${plan.steps.desktopBuild.args.join(" ")}`);
  l.push(`  3) spawn service/api/app → readiness (API 200+health + renderer 200 HTML + pipe) → SÓ depois Electron:`);
  for (const c of plan.steps.spawn) l.push(`       [${c.name}] ${c.cmd} ${c.args.join(" ")}   (cwd ${c.cwd})`);
  l.push("ciclo de vida: SIGINT/SIGTERM e saída/erro do Electron disparam cleanup AGUARDADO; raiz mantida por omissão (--clean apaga só após filhos confirmados mortos).");
  l.push("não faz: ativar proteção/monitor/scan, criar conta, matar/reusar portas alheias, tocar a instalação pessoal.");
  return l.join("\n");
}

/** (B/C) readiness estrita — predicados puros, testáveis sem transporte. */
export function apiHealthReady(res) {
  if (!res || res.status !== 200) return false;
  // (C) contrato real /health = {status:"ok", service:"cybersafe-api"} (index.ts:577).
  // Parse JSON: status:"error" ou service diferente NÃO contam como pronto.
  try {
    const j = JSON.parse(res.body);
    return !!j && j.status === "ok" && j.service === "cybersafe-api";
  } catch { return false; }
}
export function rendererReady(res) {
  return !!res && res.status === 200 && /text\/html/i.test(res.contentType || "");
}

function trackChild(child) {
  // `dizerSaida()` é a versão SÍNCRONA do `exited`. A precedência sobre um «pronto» não
  // pode depender de quem ganha uma corrida de microtarefas: um filho que já morreu tem
  // de ser visível no instante em que a prontidão tenta declarar sucesso. (Review R1.)
  const estado = { saida: null };
  const exited = new Promise((resolve) => {
    if (!child || typeof child.once !== "function") { estado.saida = { kind: "none" }; return resolve({ kind: "none" }); }
    child.once("exit", (code) => { const e = { kind: "exit", code }; estado.saida = e; resolve(e); });
    child.once("error", (e) => { const r = { kind: "error", message: e?.message }; estado.saida = r; resolve(r); });
  });
  return { exited, dizerSaida: () => estado.saida };
}

/** (C) cleanup comprovado e aguardado. Nunca apaga raiz sem prova de morte. */
export async function cleanupAsync(plan, spawned, deps, log = () => {}, { removeRoot = false } = {}) {
  const killTimeout = deps.killTimeoutMs ?? 5000;
  const killResults = [];
  for (const s of spawned) {
    try {
      // (B) taskkill AGUARDADO mas com timeout finito: se nunca fechar, NÃO
      // prometemos cleanup finito — marcamos não-confirmado e mantemos a raiz.
      const res = await Promise.race([
        deps.killTree(s.pid, s.child),
        deps.sleep(killTimeout).then(() => ({ ok: false, code: "kill-timeout" })),
      ]);
      killResults.push({ s, res });
    } catch (e) { killResults.push({ s, res: { ok: false, error: e.message } }); log(`killTree ${s.name} lançou: ${e.message}`); }
  }
  const deadline = Date.now() + (deps.exitTimeoutMs ?? 8000);
  for (const { s, res } of killResults) {
    const remaining = Math.max(0, deadline - Date.now());
    const raced = await Promise.race([s.exited, deps.sleep(remaining).then(() => ({ kind: "timeout" }))]);
    // morto = 'exit' REAL do processo (prova forte) E kill que o confirmou morto:
    // taskkill ok (0) OU "já não existia" (128, consistente com o exit). Sem
    // 'exit' real (error/none/timeout) nunca se alega morte.
    const killConfirmedGone = !!(res && (res.ok === true || res.code === 128 || res.code === 0));
    s.dead = raced.kind === "exit" && killConfirmedGone;
    if (!s.dead) log(`AVISO: ${s.name} pid=${s.pid} sem prova de morte (kill=${JSON.stringify(res)}, exit=${raced.kind}); raiz NÃO apagada.`);
  }
  const allDead = spawned.every((s) => s.dead === true);
  if (removeRoot && allDead && !plan.dryRun && deps.existsSync(plan.root)) {
    try { deps.rmSync(plan.root, { recursive: true, force: true }); log(`raiz própria removida: ${plan.root}`); }
    catch (e) { log(`não removeu raiz (${e.message}); manual.`); }
  } else if (removeRoot && !allDead) {
    log("removeRoot pedido mas filhos não confirmados mortos → raiz MANTIDA (status FAIL).");
  } else {
    log(`raiz de teste MANTIDA p/ reteste: ${plan.root} (usa --clean para apagar após filhos mortos).`);
  }
  return { allDead, removeRoot, status: allDead ? "OK" : "FAIL" };
}

/** (A) espera o settle: sinal OU saída/erro do Electron OU erro de qualquer filho. */
async function waitForSettle(spawned, deps, signal) {
  const events = spawned.map((s) => s.exited.then((e) => ({ child: s.name, ...e })));
  return await Promise.race([signal.promise, ...events]);
}

export async function run({ argv = [], env = process.env, deps }) {
  const start = argv.includes("--start");
  const clean = argv.includes("--clean");
  const guiCdp = argv.includes("--gui-cdp");
  const dryRun = !start;
  const log = deps.log ?? ((s) => console.log(s));

  // (--gui-cdp) escolher port CDP dedicado LIVRE (127.0.0.1) antes de planear.
  let effEnv = env;
  if (guiCdp && !Number(env.CYBERSAFE_DEV_DEBUG_PORT)) {
    let port = null;
    for (let p = 9333; p <= 9399; p++) { if (!(await deps.probeTcp("127.0.0.1", p))) { port = p; break; } }
    if (!port) { log("BLOCK (--gui-cdp): sem port CDP livre em 9333-9399."); return { action: start ? "start" : "dry-run", spawned: [], blocked: "cdp-port-busy", plan: null }; }
    effEnv = { ...env, CYBERSAFE_DEV_DEBUG_PORT: String(port) };
  }

  const probe = buildPlan({ env: effEnv, dryRun: true, deps });
  if (dryRun) { log(renderPlan(probe)); return { action: "dry-run", spawned: [], preflightCode: null, ready: null, plan: probe }; }

  const failEarly = (reason) => { log(renderPlan(probe)); log(`BLOCK (${reason}) → nada criado, nenhum filho.`); return { action: "start", spawned: [], preflightCode: null, plan: probe, blocked: reason }; };
  // Um plano bloqueado pela raiz é um objecto PARCIAL (sem portValid/electron/npmCli).
  // Sem este guard primeiro, o `!probe.portValid` seguinte era `undefined` e devolvia
  // `port-invalid`, mascarando a causa real; o guard do renderPlan só evita o TypeError,
  // não devolve a estrutura (achado directo do Codex). Zero spawn, zero escrita.
  if (probe.blocked) return failEarly(probe.blocked);
  if (!probe.portValid) return failEarly("port-invalid");
  if (!probe.portSupported) return failEarly("port-unsupported");
  if (probe.electron.error) return failEarly("electron-unresolved");
  if (!probe.npmCli) return failEarly("npm-cli-missing");

  const plan = buildPlan({ env: effEnv, dryRun: false, deps });
  log(renderPlan(plan));
  for (const d of plan.dirsToCreate) deps.mkdirSync(d, { recursive: true });

  const pf = deps.spawnSync(plan.preflight.cmd, plan.preflight.args, { cwd: plan.preflight.cwd, env: plan.preflight.env, encoding: "utf8" });
  const preflightCode = pf?.status ?? 2;
  if (pf?.stdout) log(pf.stdout);
  if (preflightCode !== 0) {
    log(`PREFLIGHT BLOCK (exit ${preflightCode}) → nenhum filho; raiz vazia removida.`);
    if (deps.existsSync(plan.root)) deps.rmSync(plan.root, { recursive: true, force: true });
    return { action: "start", spawned: [], preflightCode, plan, blocked: "preflight" };
  }

  for (const [host, port] of [["127.0.0.1", plan.apiPort], ["127.0.0.1", plan.rendererPort], ["::1", plan.rendererPort]]) {
    if (await deps.probeTcp(host, port)) { await cleanupAsync(plan, [], deps, log, { removeRoot: false }); return { action: "start", spawned: [], preflightCode, plan, blocked: `port-busy:${host}:${port}` }; }
  }

  const build = deps.spawnSync(plan.steps.desktopBuild.cmd, plan.steps.desktopBuild.args, { cwd: plan.steps.desktopBuild.cwd, env: plan.steps.desktopBuild.env, encoding: "utf8" });
  if ((build?.status ?? 1) !== 0) {
    log(`BUILD desktop falhou (exit ${build?.status}) → nada arrancado.`);
    await cleanupAsync(plan, [], deps, log, { removeRoot: clean });
    return { action: "start", spawned: [], preflightCode, plan, blocked: "desktop-build" };
  }

  // (A) handlers de sinal ANTES do spawn; cleanup+dispose idempotentes no finally.
  const signal = deps.installSignalHandlers();
  const spawned = [];
  let result;
  let cleaned = null;
  const doCleanup = async () => {
    if (cleaned) return cleaned;                 // idempotente: nunca limpa 2×
    cleaned = await cleanupAsync(plan, spawned, deps, log, { removeRoot: clean });
    signal.dispose?.();                          // remove SIGINT/SIGTERM
    return cleaned;
  };
  const spawnOne = (c) => {
    const child = deps.spawn(c.cmd, c.args, { cwd: c.cwd, env: c.env, stdio: "inherit" });
    const rec = { name: c.name, pid: child?.pid, child, ...trackChild(child) };
    spawned.push(rec);
    log(`arrancado [${c.name}] pid=${child?.pid ?? "?"}`);
    return rec;
  };
  try {
    for (const c of plan.steps.spawn.filter((x) => x.name !== "desktop")) spawnOne(c);
    // readiness ABORTA a sinal/saída de filho — nunca lança Electron após SIGINT.
    const ready = await waitForStack(plan, deps, signal, spawned);
    if (!ready.ok) {
      // Só estatutos e elapsed: nunca corpo, URL, tokens ou ambiente no log.
      const estados = ready.ultimo
        ? `api=${ready.ultimo.api} renderer=${ready.ultimo.renderer} pipe=${ready.ultimo.pipe} aos=${ready.ultimo.decorridoMs}ms em ${ready.tentativas} tentativa(s)`
        : "sem tentativa completada";
      const porquê = ready.aborted ? `cancelada por ${ready.motivo}${ready.child ? ` [${ready.child}]` : ""}${ready.code !== null && ready.code !== undefined ? ` code=${ready.code}` : ""}` : `falhou (${ready.reason})`;
      log(`readiness ${porquê} (${estados}) → Electron NÃO lançado.`);
      result = {
        action: "start", spawned, preflightCode, plan, ready: false,
        blocked: ready.aborted ? "cancelled" : "readiness",
        blockedReason: ready.aborted ? ready.motivo : ready.reason,
        prontidao: { estados: ready.ultimo ?? null, tentativas: ready.tentativas, orcamento: ready.orcamento ?? null, motivo: ready.motivo ?? null, child: ready.child ?? null, code: ready.code ?? null },
      };
      return result;
    }
    spawnOne(plan.steps.spawn.find((x) => x.name === "desktop"));   // DENTRO do try
    log("stack isolada pronta (API+renderer+pipe verificados; Electron lançado). Aguarda settle.");
    let settle = await waitForSettle(spawned, deps, signal);
    // EXCEÇÃO DEV opt-in (`CYBERSAFE_DEV_KEEP_UI_ON_SERVICE_EXIT=1`): só o filho
    // `service`, só DEPOIS da readiness completa, uma vez. Sem a flag este bloco não
    // existe e a saída de qualquer filho continua a encerrar tudo. Não reinicia nada,
    // não abre porta de produção: API, Vite e Electron que terminem continuam a
    // provocar o cleanup completo abaixo, tal como SIGINT/SIGTERM.
    if (plan.devServiceException && settle.child === "service") {
      log("EXCEÇÃO DEV (flag explícita): [service] terminou após readiness — interface mantida aberta; qualquer outra saída ou sinal faz cleanup completo.");
      settle = await waitForSettle(spawned.filter((s) => s.name !== "service"), deps, signal);
      log(`settle após a exceção: ${JSON.stringify(settle)}.`);
    }
    log(`settle: ${JSON.stringify(settle)}.`);
    result = { action: "start", spawned, preflightCode, plan, ready: true, settle };
    return result;
  } catch (e) {
    log(`erro no arranque (após ${spawned.length} filho(s)): ${e.message}.`);
    result = { action: "start", spawned, preflightCode, plan, ready: false, blocked: "spawn-error", error: e.message };
    return result;
  } finally {
    // SEMPRE: cleanup AGUARDADO (árvore própria) + dispose, mesmo em erro/sinal.
    const cleanup = await doCleanup();
    if (result) result.cleanup = cleanup;
  }
}

/**
 * ORÇAMENTO DE RELÓGIO da prontidão. Porque existe: `40 tentativas × 500 ms` era um
 * orçamento de *polling*, não uma garantia de parede — cada sonda traz o seu próprio
 * timeout (HTTP 2000 ms, pipe 700 ms), por isso o pior caso por construção é ≈99,5 s e
 * uma sonda lenta pode esticar além disso. Medido na tentativa real de 2026-10-21: o
 * runner gastou 21,86 s e devolveu apenas «timeout», sem dizer qual dos três subsistemas
 * faltava, quando o que tinha acontecido era o API ter abortado antes do `listen`.
 *
 * Regras: tecto EXPLÍCITO e finito, NUNCA redefinido por tentativa, cada sonda limitada
 * pelo que falta (não pelo tecto fixo da sonda), e a hora vem de `deps.now` para os
 * testes serem determinísticos. O tecto máximo fica abaixo do `--max` aprovado do
 * supervisor (420 000 ms), para que a prontidão nunca possa sobreviver à vigia.
 */
export const PRONTIDAO_ORCAMENTO_PADRAO_MS = 120_000;
export const PRONTIDAO_PISO_MS = 1_000;
export const PRONTIDAO_TECTO_MS = 400_000;

export function normalizarOrcamentoProntidao(deps = {}) {
  const bruto = deps.readinessBudgetMs ?? PRONTIDAO_ORCAMENTO_PADRAO_MS;
  const n = Number(bruto);
  if (!Number.isFinite(n) || n <= 0) {
    return { ms: PRONTIDAO_ORCAMENTO_PADRAO_MS, ajustado: true, motivo: "invalido_usado_padrao" };
  }
  if (n < PRONTIDAO_PISO_MS) return { ms: PRONTIDAO_PISO_MS, ajustado: true, motivo: "abaixo_do_piso" };
  if (n > PRONTIDAO_TECTO_MS) return { ms: PRONTIDAO_TECTO_MS, ajustado: true, motivo: "acima_do_tecto" };
  return { ms: n, ajustado: false, motivo: "exacto" };
}

const PRAZO = Symbol("prazo");

/**
 * Limita as sondas ao tempo que RESTA do orçamento. UM temporizador por tentativa,
 * partilhado pelas três: com um temporizador por sonda, três esperas simultâneas
 * somavam tempo a uma corrida que devia ser paralela, e o «parede» estourava o
 * orçamento sem que nada estivesse pendurado. (Apanhado pelos testes de relógio falso,
 * não pela revisão.)
 */
function comPrazo(promise, prazoPartilhado) {
  return Promise.race([
    Promise.resolve(promise).then((v) => v, () => null),
    prazoPartilhado,
  ]);
}

/** Estado por subsistema: apenas enums de estatuto, nunca corpo, URL ou ambiente. */
function classeEstadoHttp(res, predicateOk) {
  if (res === PRAZO) return "prazo_da_sonda";
  if (res === null || res === undefined) return "sem_resposta";
  if (predicateOk) return "pronto";
  const st = typeof res.status === "number" ? res.status : null;
  if (st === null) return "resposta_sem_estado";
  if (st === 401 || st === 403) return `recusado_${st}`;
  if (st === 404) return "rota_inexistente_404";
  return `estado_${st}`;
}
function classeEstadoPipe(p) {
  if (p === PRAZO) return "prazo_da_sonda";
  return p === true ? "pronto" : "ausente";
}

/**
 * Forma única de dizer «a prontidão acabou por causa disto». Um filho que morreu é
 * nomeado com o nome e o código; `kind: "error"` nunca é chamado saída limpa, porque
 * saída limpa é exatamente `code === 0`.
 */
function formatarAborto(e) {
  if (!e) return { motivo: "desconhecido", child: null, code: null, sinal: null };
  if (e.tipo === "sinal") return { motivo: "sinal", child: null, code: null, sinal: e.nome ?? null };
  return { motivo: e.tipo, child: e.child ?? null, code: e.code ?? null, sinal: e.signal ?? e.nome ?? null };
}

export async function waitForStack(plan, deps, signal, spawned) {
  const agora = deps.now ?? (() => Date.now());
  const orcamento = normalizarOrcamentoProntidao(deps);
  const inicio = agora();
  const fim = inicio + orcamento.ms;
  const intervalo = Math.max(0, Number(deps.readinessDelayMs ?? 500) || 0);
  // Compatibilidade honesta: `readinessAttempts` continua a ser UM TECTO de tentativas
  // quando é dado explicitamente; nunca é o único controlo de tempo, e o orçamento de
  // parede aplica-se sempre por cima.
  const tectoTentativas = deps.readinessAttempts === undefined ? Infinity : Number(deps.readinessAttempts);
  // Aborta com o QUE aconteceu: sinal, ou qual filho saiu com que código. Um filho que
  // crasha deixa de ser reportado como «timeout».
  const abortar = Promise.race([
    Promise.resolve(signal.promise).then((s) => ({ tipo: "sinal", nome: s?.name ?? null }), () => ({ tipo: "sinal_erro" })),
    ...spawned.map((s) => s.exited.then(
      (e) => (e.kind === "exit" || e.kind === "error")
        ? { tipo: e.code === 0 ? "filho_saiu_limpo" : "filho_crashou", child: s.name, code: e.code ?? null, signal: e.signal ?? null, kind: e.kind }
        : new Promise(() => {}),
      () => ({ tipo: "filho_erro", child: s.name }),
    )),
  ]);
  let tentativas = 0;
  let ultimo = null;
  // O evento de cancelamento fica à vista além da corrida: `Promise.race` entrega o
  // valor mas não diz depois «já aconteceu». Sem este sinal, um SIGTERM que chegasse
  // enquanto as sondas ainda estavam no ar era perdido e o sucesso seguinte lançava o
  // Electron depois de o utilizador ter pedido para sair. (Reproduzido no review R1.)
  let cancelamento = null;
  const vigiarAbortar = () => abortar.then((e) => { cancelamento = e; return e; });
  // Leitura SÍNCRONA do que já aconteceu: um sinal levantado pelo utilizador ou um filho
  // já morto não podem perder uma corrida de microtarefas contra três sondas verdes.
  const verAborto = () => {
    const s = typeof signal?.dizerSinal === "function" ? signal.dizerSinal() : null;
    if (s) return { tipo: "sinal", nome: s?.name ?? null };
    for (const rec of spawned) {
      const e = typeof rec?.dizerSaida === "function" ? rec.dizerSaida() : null;
      if (!e || (e.kind !== "exit" && e.kind !== "error")) continue;
      return {
        tipo: e.kind === "error" ? "filho_crashou" : (e.code === 0 ? "filho_saiu_limpo" : "filho_crashou"),
        child: rec.name, code: e.code ?? null, signal: e.signal ?? null,
      };
    }
    return null;
  };
  const marcar = () => { if (!cancelamento) cancelamento = verAborto(); return cancelamento; };
  for (;;) {
    const restante = fim - agora();
    if (restante <= 0) {
      return { ok: false, reason: "orcamento_esgotado", orcamento: { ...orcamento, decorridoMs: agora() - inicio }, tentativas, ultimo };
    }
    if (marcar()) {
      return { ok: false, aborted: true, ...formatarAborto(cancelamento), orcamento: { ...orcamento, decorridoMs: agora() - inicio }, tentativas, ultimo };
    }
    tentativas += 1;
    // UM temporizador partilhado pelas três sondas, limitado ao que falta (dividido por
    // três para que nenhuma sonda pendurada coma o orçamento todo).
    const esperaPrazo = deps.sleep(Math.max(1, Math.floor(restante / 3)));
    const prazo = esperaPrazo.then(() => PRAZO);
    const sondas = Promise.all([
      comPrazo(deps.probeHttp(`http://127.0.0.1:${plan.apiPort}/health`), prazo),
      comPrazo(deps.probeHttp(`http://localhost:${plan.rendererPort}/`), prazo),
      comPrazo(deps.probePipe(plan.pipeName), prazo),
    ]);
    // O cancelamento participa NA ESPERA das sondas, não só depois delas: um sinal ou a
    // morte de um filho ganha às sondas penduradas, e ganha também a um «pronto» da
    // mesma volta. As sondas continuarem vivas por trás não é motivo para lançar Electron.
    const resultado = await Promise.race([sondas, vigiarAbortar()]);
    esperaPrazo.cancel?.();
    // `esperaPrazo.cancel()`: um prazo que já não interessa não pode manter o processo
    // vivo depois de a volta ter acabado — seja por sucesso, seja por cancelamento.
    // (Com relógio falso também deixa de mover o tempo; com timers reais só evento vivo.)
    esperaPrazo.cancel?.();
    if (!Array.isArray(resultado)) {
      return { ok: false, aborted: true, ...formatarAborto(resultado), orcamento: { ...orcamento, decorridoMs: agora() - inicio }, tentativas, ultimo };
    }
    const [apiBruto, rendererBruto, pipeBruto] = resultado;
    const apiOk = apiBruto !== PRAZO && apiHealthReady(apiBruto);
    const rendererOk = rendererBruto !== PRAZO && rendererReady(rendererBruto);
    const pipeOk = pipeBruto === true;
    ultimo = {
      api: classeEstadoHttp(apiBruto, apiOk),
      renderer: classeEstadoHttp(rendererBruto, rendererOk),
      pipe: classeEstadoPipe(pipeBruto),
      decorridoMs: agora() - inicio,
    };
    // Um cancelamento que chegou ENQUANTO as sondas respondiam não pode ser esquecido
    // por um «pronto» da mesma volta: o sinal é sempre anterior ao direito de lançar.
    if (marcar()) {
      return { ok: false, aborted: true, ...formatarAborto(cancelamento), orcamento: { ...orcamento, decorridoMs: agora() - inicio }, tentativas, ultimo };
    }
    // O último resultado válido antes do prazo é aceite; nunca se inventa prontidão
    // a partir de 401/404/JSON errado — os predicados são os mesmos de sempre.
    if (apiOk && rendererOk && pipeOk) {
      return { ok: true, orcamento: { ...orcamento, decorridoMs: agora() - inicio }, tentativas, ultimo };
    }
    // O prazo vence também DURANTE as sondas: se já passou, não há espera por cima.
    const restanteDepois = fim - agora();
    if (restanteDepois <= 0) {
      return { ok: false, reason: "orcamento_esgotado", orcamento: { ...orcamento, decorridoMs: agora() - inicio }, tentativas, ultimo };
    }
    const dorme = Math.min(intervalo, restanteDepois);
    const dormindo = deps.sleep(dorme);
    const corta = await Promise.race([vigiarAbortar(), dormindo.then(() => null)]);
    dormindo.cancel?.();
    if (corta) {
      return { ok: false, aborted: true, ...formatarAborto(corta), orcamento: { ...orcamento, decorridoMs: agora() - inicio }, tentativas, ultimo };
    }
    if (tentativas >= tectoTentativas) {
      return { ok: false, reason: "tentativas_esgotadas", orcamento: { ...orcamento, decorridoMs: agora() - inicio }, tentativas, ultimo };
    }
    if (agora() >= fim) {
      return { ok: false, reason: "orcamento_esgotado", orcamento: { ...orcamento, decorridoMs: agora() - inicio }, tentativas, ultimo };
    }
  }
}

function realDeps() {
  const require_ = createRequire(import.meta.url);
  return {
    execPath: process.execPath,
    mkdtempSync: (p) => fs.mkdtempSync(p),
    mkdirSync: (p, o) => fs.mkdirSync(p, o),
    existsSync: (p) => fs.existsSync(p),
    rmSync: (p, o) => fs.rmSync(p, o),
    // O `validarRaizReutilizavel` precisa destes três; sem eles qualquer raiz pedida
    // caía no `catch` de `realpathSync` e era recusada como "não existe", e um manifesto
    // existente rebentava no `readFileSync`. Medido pelo OpenCode em dry-run.
    realpathSync: (p) => fs.realpathSync(p),
    readFileSync: (p, o) => fs.readFileSync(p, o),
    writeFileSync: (p, c) => fs.writeFileSync(p, c),
    isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    spawn,
    spawnSync,
    requireElectron: () => require_("electron"),
    probeTcp,
    probePipe,
    // (B) devolve {status, contentType, body} — a validação é nos predicados, aqui não.
    probeHttp: (url) => new Promise((resolve) => {
      import("node:http").then((http) => {
        const req = http.get(url, (res) => {
          let body = ""; res.setEncoding("utf8");
          res.on("data", (c) => { if (body.length < 64 * 1024) body += c; });
          res.on("end", () => resolve({ status: res.statusCode, contentType: res.headers["content-type"] || "", body }));
        });
        req.on("error", () => resolve(null));
        req.setTimeout(2000, () => { req.destroy(); resolve(null); });
      });
    }),
    // (C) killTree AGUARDADO: resolve {ok, code} quando o taskkill termina.
    killTree: (pid) => new Promise((resolve) => {
      if (!pid) return resolve({ ok: false, code: "no-pid" });
      const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      k.once("error", (e) => resolve({ ok: false, code: "spawn-error", error: e.message }));
      k.once("close", (code) => resolve({ ok: code === 0, code }));
    }),
    sleep: (ms) => {
      let temporizador;
      const p = new Promise((r) => { temporizador = setTimeout(r, ms); });
      // `cancel` é o `clearTimeout` do mundo real: um prazo que deixou de interessar não
      // pode manter o processo vivo depois de a prontidão ter chegado.
      p.cancel = () => clearTimeout(temporizador);
      return p;
    },
    now: () => Date.now(),
    // (A) instala SIGINT/SIGTERM uma vez; devolve promise + dispose.
    installSignalHandlers: () => {
      let resolveSignal;
      const promise = new Promise((r) => { resolveSignal = r; });
      let disparado = null;
      // Guardado ANTES de resolver: `dizerSinal()` tem de ver o sinal no mesmo instante
      // em que a mão do utilizador o levantou, não uma macrotarefa mais tarde.
      const onSig = (name) => () => { disparado = { kind: "signal", name }; resolveSignal(disparado); };
      const h1 = () => onSig("SIGINT")(); const h2 = () => onSig("SIGTERM")();
      process.on("SIGINT", h1); process.on("SIGTERM", h2);
      return {
        promise,
        dizerSinal: () => disparado,
        dispose: () => { process.removeListener("SIGINT", h1); process.removeListener("SIGTERM", h2); },
      };
    },
    tmpdir: () => os.tmpdir(),
    homedir: () => os.homedir(),
    pid: process.pid,
    log: (s) => console.log(s),
    // O tempo MANDA, a contagem não: um tecto fixo de 40 tentativas × 500 ms valia ~20 s
    // de parede e era a razão pela qual uma prontidão legítima morria como «timeout» sem
    // nome. Aqui fica só o orçamento de relógio; `readinessAttempts` continua disponível
    // para os testes limitarem tentativas explicitamente.
    readinessBudgetMs: PRONTIDAO_ORCAMENTO_PADRAO_MS,
    readinessDelayMs: 500,
    exitTimeoutMs: 8000,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run({ argv: process.argv.slice(2), env: process.env, deps: realDeps() })
    .then((r) => { if (r.blocked) process.exit(2); if (r.cleanup && r.cleanup.status === "FAIL") process.exit(3); })
    .catch((e) => { console.error(e); process.exit(1); });
}
