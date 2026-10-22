// organizer-load-check.mjs — teste de carregamento REAL do Organizador via file://
// (missão P0 "aparece vazio", qoder, 14/10). Reproduz o que o utilizador vê:
// abre o HTML num Chromium sem interface, deixa o script da página correr e
// AFIRMA que a lista não está vazia e que os contadores não são zero.
// Sem dependências. Uso: node scripts/organizer-load-check.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const REPO = path.resolve(import.meta.dirname, "..");
const HTML = path.join(REPO, "docs", "cybersafe-organizador-pap-v2-editavel.html");

function findChromium() {
  const candidatos = [
    process.env.CHROME_BIN,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  for (const c of candidatos) { try { if (c === "canary" || requireExists(c)) return c; } catch {} }
  // ultima via: `where` no PATH
  try {
    const saida = execFileSync("where", ["chrome", "msedge"], { encoding: "utf8" });
    const primeiro = saida.split(/\r?\n/).find((l) => l.trim());
    if (primeiro) return primeiro.trim();
  } catch {}
  for (const c of candidatos) if (requireExists(c)) return c;
  throw new Error("nenhum Chromium/Edge encontrado — instala ou define CHROME_BIN");
}
function requireExists(p) { try { readFileSync(p).length >= 0; return true; } catch { return false; } }

const chrome = findChromium();
const baseArgs = ["--headless=new", "--disable-gpu", "--no-first-run", "--virtual-time-budget=5000", "--dump-dom"];

function dump(file) {
  return execFileSync(chrome, [...baseArgs, pathToFileURL(file).href], { maxBuffer: 128 * 1024 * 1024 }).toString();
}

// 1) carregamento real do ficheiro tal como existe
const dom = dump(HTML);
const linhas = (dom.match(/class="task (?:done|progress|planned|blocked)/g) || []).length;
assert.ok(linhas > 0, "FALHOU: o DOM carregado nao contem NENHUMA tarefa (lista vazia)");
assert.ok(linhas >= 242, `FALHOU: esperava >=242 linhas de tarefa, o DOM tem ${linhas}`);
const pct = dom.match(/Progresso geral[^%]{0,400}?(\d+)\s*%/);
assert.ok(pct, "FALHOU: 'Progresso geral' nao encontrado no DOM");
assert.ok(Number(pct[1]) > 0, `FALHOU: progresso geral a 0% com ${linhas} tarefas no DOM`);
// prova dos estados originais: o DOM carregado tem de ter exatamente a
// distribuicao gravada no ficheiro (106 done / 45 progress / 88 planned / 3 blocked)
const porEstado = { done: 0, progress: 0, planned: 0, blocked: 0 };
for (const m of dom.matchAll(/class="task (done|progress|planned|blocked)/g)) porEstado[m[1]]++;
assert.deepEqual(porEstado, { done: 106, progress: 45, planned: 88, blocked: 3 }, `FALHOU: distribuicao de estados nao é a do ficheiro: ${JSON.stringify(porEstado)}`);
const counters = [...dom.matchAll(/(\d+)\/(\d+) conclu/gi)];
assert.ok(counters.length > 0, "FALHOU: contadores de conclusao ausentes");
console.log(`carregamento file://: ${linhas} tarefas, progresso ${pct[1]}% — PASS`);

// 2) expandir/recolher de verdade: copia temporaria com um script de teste que
//    CLI nos botoes e reporta no titulo; o original nunca e tocado nem alterado.
const dir = mkdtempSync(path.join(tmpdir(), "org-check-"));
try {
  const original = readFileSync(HTML, "utf8");
  const probe = `<script>(function(){
    var exp=document.getElementById('expandAll'), col=document.getElementById('collapseAll');
    if(!exp||!col){document.title='ORG-CHECK:NAO-HANDLERS';return;}
    exp.click();
    var abertos=0, taskDivs=0;
    document.querySelectorAll('.tasks').forEach(function(x){taskDivs++; if(!x.classList.contains('hidden'))abertos++;});
    var detailsAbertos=0; document.querySelectorAll('details').forEach(function(d){if(d.open)detailsAbertos++;});
    col.click();
    var apos=0; document.querySelectorAll('.tasks').forEach(function(x){if(!x.classList.contains('hidden'))apos++;});
    var detailsFechados=0; document.querySelectorAll('details').forEach(function(d){if(!d.open)detailsFechados++;});
    document.title='ORG-CHECK:'+(taskDivs>0&&abertos===taskDivs?'EXPAND_OK':'EXPAND_FAIL')+':'+(apos===0?'COLLAPSE_OK':'COLLAPSE_FAIL')+':TASKDIVS='+taskDivs+':DETALLES='+document.querySelectorAll('details').length;
  })();</script>`;
  const tmp = path.join(dir, "organizador-com-probe.html");
  writeFileSync(tmp, original.replace("</body>", probe + "</body>"), "utf8");
  const dom2 = dump(tmp);
  const titulo = (dom2.match(/<title>(ORG-CHECK:[^<]*)<\/title>/) || [])[1] || "";
  console.log("probe:", titulo);
  assert.ok(titulo.includes("EXPAND_OK"), "FALHOU: 'Expandir tudo' nao abriu todas as seccoes");
  assert.ok(titulo.includes("COLLAPSE_OK"), "FALHOU: 'Recolher tudo' nao recolheu tudo");
  console.log("expandir/recolher: PASS");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("ORGANIZADOR LOAD CHECK: PASS");
