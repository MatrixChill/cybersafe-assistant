#!/usr/bin/env node
/**
 * Validação do Scanner no Electron por CDP — sem gestos nativos.
 *
 * Porque existe: a validação anterior dependia de `SendKeys`/`SetCursorPos`/
 * `win-*.ps1` e de `Page.captureScreenshot`, e três corridas consecutivas
 * morreram (incluindo toda a árvore do processo, API incluída) sem prova de
 * causa. O caminho que sobra é o contrato público da app:
 *
 *   window.electronAPI.startScan(type, targetPath, origin)
 *   window.electronAPI.onScanProgress(cb) / onScanSession(cb)
 *
 * `startScan` já aceita `targetPath`, pelo que uma análise de pasta sintética
 * não precisa do diálogo nativo (`dialog:open-folder`) nem de teclado/ratinho.
 * Tudo o resto é `Runtime.evaluate` em CDP.
 *
 * O que este script NÃO faz: escrever ficheiros de fixture, abrir diálogos,
 * tocar no sistema fora do caminho pedido, matar processos alheios. A fixture
 * é criada por quem chama (ver `--fixture`), e o serviço em modo fixture gate
 * recusa `scan.start` fora da raiz autorizada.
 *
 * Uso:
 *   node scripts/scanner-cdp-validate.mjs \
 *     --fixture=%TEMP%\cs-obj-pos-20261020 \
 *     --api=http://127.0.0.1:4100 \
 *     --cdp=http://127.0.0.1:9333 \
 *     --out=%TEMP%\scanner-cdp.json
 *
 * Códigos de saída: 0 = análise iniciada e terminada; 2 = não arrancou;
 * 3 = tempo esgotado; 4 = CDP/autenticação inviáveis; 5 = fixture inválida.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);
const DEFAULT_TIMEOUT_MS = 240_000;
const POLL_MS = 500;

// ── Funções puras (testadas em scripts/test/scanner-cdp-validate.test.mjs) ──

/** `--chave=valor` / `--chave` → objecto. Sem dependências. */
export function parseArgs(argv = []) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) out[body] = "true";
    else out[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

export function isTerminalStatus(status) {
  return typeof status === "string" && TERMINAL_STATUSES.has(status);
}

/** Aceita só caminhos reais sob a base temporária (igual ao guard do runner). */
export function isInsideTemp(candidate, tempBase = os.tmpdir()) {
  if (typeof candidate !== "string" || !candidate.trim()) return false;
  if (!path.isAbsolute(candidate)) return false;
  const real = fs.existsSync(candidate) ? fs.realpathSync(candidate) : path.resolve(candidate);
  const base = fs.realpathSync(tempBase);
  const rel = path.relative(base, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return real.toLowerCase() !== base.toLowerCase();
}

/**
 * Resumo determinístico de amostras de progresso: primeiro/último estado,
 * máximo observado e monotonia do contador de ficheiros (um contador que
 * recua é sinal de estado misturado, não de progresso).
 */
export function summarizeSamples(samples = []) {
  const valid = samples.filter((s) => s && typeof s === "object");
  if (valid.length === 0) return { count: 0, first: null, last: null, maxProgress: null, filesRegressed: false };
  let maxProgress = null;
  let filesRegressed = false;
  let previousFiles = null;
  for (const s of valid) {
    if (typeof s.progress === "number" && Number.isFinite(s.progress)) {
      maxProgress = maxProgress === null ? s.progress : Math.max(maxProgress, s.progress);
    }
    if (typeof s.filesScanned === "number") {
      if (previousFiles !== null && s.filesScanned < previousFiles) filesRegressed = true;
      previousFiles = s.filesScanned;
    }
  }
  return { count: valid.length, first: valid[0], last: valid[valid.length - 1], maxProgress, filesRegressed };
}

export function buildFixtureEmail(label = "cdp", now = Date.now()) {
  const safe = String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "cdp";
  return `${safe}+${now}@cybersafe.invalid`;
}

// ── CDP mínimo ──

async function listTargets(cdpBase) {
  const res = await fetch(`${cdpBase}/json/list`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(`json/list ${res.status}`);
  return await res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        send(method, params = {}, timeoutMs = 20_000) {
          return new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`cdp_sem_resposta_${method}_${timeoutMs}ms`));
              }
            }, timeoutMs);
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* já fechado */
          }
        },
      });
    ws.onerror = () => reject(new Error("cdp_ws_error"));
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg.id || !pending.has(msg.id)) return;
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(`cdp_error_${msg.error.code ?? "?"}_${msg.error.message ?? ""}`));
      else p.res(msg.result);
    };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "erro";
    throw new Error(`eval_falhou: ${String(detail).slice(0, 300)}`);
  }
  return result.result?.value;
}

// ── Fluxo principal ──

async function ensureSession(client, apiBase, email) {
  const estado = await evaluate(client, "({ token: !!localStorage.getItem('cybersafe_token'), api: window.__CYBERSAFE_API_BASE__ || null })");
  if (estado.token) return { autenticado: true, criado: false, api: estado.api };

  const password = `cdp-${randomBytes(12).toString("base64url")}`;
  const registo = await evaluate(
    client,
    `(async () => {
      const r = await fetch(${JSON.stringify(`${apiBase}/auth/register`)}, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Harness CDP", email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)}, type: "personal" }),
      });
      const texto = await r.text();
      let corpo = null;
      try { corpo = JSON.parse(texto); } catch { /* corpo não-JSON */ }
      if (r.status === 201 && corpo && corpo.token) {
        localStorage.setItem("cybersafe_token", corpo.token);
        return { ok: true, status: r.status };
      }
      return { ok: false, status: r.status, amostra: texto.slice(0, 120) };
    })()`,
  );
  if (!registo?.ok) throw new Error(`registo_dev_falhou: ${JSON.stringify(registo)}`);
  return { autenticado: true, criado: true, api: estado.api };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiBase = (args.api ?? "http://127.0.0.1:4100").replace(/\/+$/, "");
  const cdpBase = (args.cdp ?? "http://127.0.0.1:9333").replace(/\/+$/, "");
  const timeoutMs = Number(args.timeout ?? DEFAULT_TIMEOUT_MS);
  const label = args.label ?? "cdp";
  const fixture = args.fixture;

  if (!fixture) {
    console.error("falta --fixture=<caminho absoluto sob %TEMP%>");
    return 5;
  }
  if (!isInsideTemp(fixture)) {
    console.error(`recusado: fixture fora da base temporária ou inexistente: ${fixture}`);
    return 5;
  }
  if (!fs.statSync(fixture).isDirectory()) {
    console.error(`recusado: fixture não é uma pasta: ${fixture}`);
    return 5;
  }

  const targets = await listTargets(cdpBase).catch((error) => {
    console.error(`CDP indisponível em ${cdpBase}: ${error.message}`);
    return null;
  });
  if (!targets) return 4;
  const page =
    targets.find((t) => t.type === "page" && typeof t.url === "string" && t.url.includes(":5173")) ??
    targets.find((t) => t.type === "page" && !String(t.url).startsWith("devtools://"));
  if (!page?.webSocketDebuggerUrl) {
    console.error("sem target de página no CDP");
    return 4;
  }

  const client = await connect(page.webSocketDebuggerUrl);
  const evidence = { fixture, apiBase, cdpBase, target: page.url, startedAt: new Date().toISOString() };
  try {
    await client.send("Runtime.enable");
    const bridge = await evaluate(client, "typeof window.electronAPI === 'object' && typeof window.electronAPI.startScan === 'function'");
    if (bridge !== true) {
      console.error("preload ausente: window.electronAPI.startScan não é uma função (a página não corre no Electron?)");
      return 4;
    }

    const sessao = await ensureSession(client, apiBase, buildFixtureEmail(label));
    evidence.session = sessao;
    if (sessao.criado) {
      await evaluate(client, "location.reload(); 'a-recarregar'").catch(() => {});
      await sleep(5000);
    }

    // Recolha no próprio renderer: sem polling ao CDP por cada evento.
    await evaluate(
      client,
      `(() => {
        window.__csCdpHarness?.dispose?.();
        const store = { samples: [], sessions: [], errors: [], startedAt: new Date().toISOString() };
        const push = (lista, valor, max) => { lista.push(valor); if (lista.length > max) lista.shift(); };
        const offProgress = window.electronAPI.onScanProgress((estado) => {
          if (!estado || typeof estado !== "object") return;
          const amostra = {
            at: new Date().toISOString(),
            id: estado.id ?? null,
            status: estado.status ?? null,
            progress: typeof estado.progress === "number" ? estado.progress : null,
            filesScanned: typeof estado.filesScanned === "number" ? estado.filesScanned : null,
            currentFile: typeof estado.currentFile === "string" ? estado.currentFile.slice(-120) : null,
          };
          push(store.samples, amostra, 4000);
          push(store.sessions, amostra, 40);
        });
        const offSession = window.electronAPI.onScanSession((delivery) => {
          if (delivery?.error) push(store.errors, { at: new Date().toISOString(), error: String(delivery.error).slice(0, 200) }, 20);
          if (delivery?.state) push(store.sessions, { at: new Date().toISOString(), estado: delivery.state }, 40);
        });
        window.__csCdpHarness = { store, dispose() { try { offProgress?.(); } catch {} try { offSession?.(); } catch {} } };
        return { ok: true };
      })()`,
    );

    // Clicar o item de navegação do Scanner é cosmético (o bridge é global),
    // mas mostra o cartão real ao utilizador durante a corrida.
    const navegou = await evaluate(
      client,
      `(() => {
        const alvo = [...document.querySelectorAll('button,a,[role="button"]')]
          .find((el) => /^\\s*scanner\\b/i.test((el.textContent || '').trim()));
        if (!alvo) return false;
        alvo.click();
        return true;
      })()`,
    );
    evidence.navegouParaScanner = navegou === true;
    if (navegou) await sleep(1200);

    const inicio = await evaluate(
      client,
      `window.electronAPI.startScan("custom", ${JSON.stringify(fixture)}, "harness-cdp")`,
    );
    evidence.startScan = inicio ?? null;
    const scanId = inicio && typeof inicio.id === "string" ? inicio.id : null;
    if (!inicio || !inicio.success || !scanId) {
      console.error(`scan.start recusado: ${JSON.stringify(inicio)}`);
      return 2;
    }

    const deadline = Date.now() + timeoutMs;
    let resumo = { count: 0, first: null, last: null, maxProgress: null, filesRegressed: false };
    let domExcerpt = "";
    while (Date.now() < deadline) {
      const leitura = await evaluate(
        client,
        `(() => {
          const store = window.__csCdpHarness?.store ?? { samples: [], errors: [] };
          const corpo = document.body ? document.body.innerText : "";
          const linha = corpo.split("\\n").find((l) => /An[áa]lise\\b|Scanner/i.test(l)) ?? corpo.slice(0, 200);
          return { samples: store.samples, errors: store.errors, texto: (linha + "\\n" + corpo.slice(0, 400)).slice(0, 600) };
        })()`,
      );
      resumo = summarizeSamples(leitura?.samples ?? []);
      domExcerpt = leitura?.texto ?? "";
      evidence.errors = leitura?.errors ?? [];
      if (resumo.last && isTerminalStatus(resumo.last.status)) break;
      await sleep(POLL_MS);
    }

    evidence.finishedAt = new Date().toISOString();
    evidence.scanId = scanId;
    evidence.summary = resumo;
    evidence.domExcerpt = domExcerpt;
    evidence.timedOut = !(resumo.last && isTerminalStatus(resumo.last.status));
    const resultado = {
      ok: !evidence.timedOut,
      motivo: evidence.timedOut ? "tempo_esgotado_sem_estado_terminal" : null,
      ...evidence,
    };
    if (args.out) {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, `${JSON.stringify(resultado, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(resultado, null, 2));
    if (evidence.timedOut) return 3;
    return 0;
  } finally {
    try {
      await evaluate(client, "window.__csCdpHarness?.dispose?.(); true");
    } catch {
      /* alvo pode ter fechado */
    }
    client.close();
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`falhou: ${error?.message ?? error}`);
      process.exit(4);
    });
}
