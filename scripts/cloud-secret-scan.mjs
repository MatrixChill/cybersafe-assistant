#!/usr/bin/env node
// Auditoria de segredos (release/cloud prep): working tree candidato a snapshot + historico Git.
// Regra dura: NUNCA imprime o valor detectado — reporta caminho, linha, regra, severidade,
// comprimento e fingerprint sha256(10) do valor.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 10 * 1024 * 1024;

export const RULES = [
  { id: 'openai-style-sk', severity: 'HIGH', re: /sk-(?!ant-)[A-Za-z0-9_-]{16,}/g },
  { id: 'anthropic-sk-ant', severity: 'HIGH', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'github-token', severity: 'HIGH', re: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { id: 'aws-access-key', severity: 'HIGH', re: /AKIA[0-9A-Z]{16}/g },
  { id: 'slack-token', severity: 'HIGH', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'gcp-api-key', severity: 'HIGH', re: /AIza[0-9A-Za-z_-]{30,}/g },
  { id: 'private-key-block', severity: 'HIGH', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: 'jwt-like', severity: 'MEDIUM', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { id: 'url-credentials', severity: 'HIGH', re: /\/\/[^\s/:@"']{1,40}:[^\s@"']{3,}@[A-Za-z0-9.-]+/g },
  { id: 'bearer-token', severity: 'MEDIUM', re: /\bBearer\s+[A-Za-z0-9._-]{24,}/g },
  { id: 'apikey-query', severity: 'HIGH', re: /[?&]api[_-]?key=[A-Za-z0-9]{24,}/gi },
  { id: 'quoted-secret-assign', severity: 'MEDIUM', re: /(?:api[_-]?key|apikey|secret|token|password|passwd|senha|chave)[\w-]*["']?\s*[:=]\s*["'`][^"'`\s]{12,}["'`]/gi },
  { id: 'bare-env-secret-assign', severity: 'MEDIUM', re: /^[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|SENHA)[A-Z0-9_]*\s*=\s*[^\s"'$<]{16,}$/gm },
  { id: 'personal-path', severity: 'LOW', re: /[Cc]:[\\/]Users[\\/][A-Za-z0-9._-]{2,}/g },
];

// Valores claramente placeholder/template: registados como suppressed, não como finding.
export function isPlaceholder(value) {
  const v = value.replace(/^["'`\s]+|["'`\s]+$/g, '');
  if (!v) return true;
  if (/^(?:<[^>]*>|\{\{?\S+\}?\}?|x{8,}|\*{8,}|\.{3,})/.test(v)) return true;
  if (/process\.env|import\.meta|require\(/.test(v)) return true;
  if (/^(?:altera|change[-_]?me|placeholder|your[-_]?|dummy|fake|exemplo|exemp|todo[-_]?|replace[-_]?|exemple)/i.test(v)) return true;
  if (/^[A-Z0-9_]{3,64}$/.test(v)) return true; // referencia a outra constante de ambiente
  return false;
}

const fp = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 10);

// Regras com risco de backtracking quadrático em linhas minificadas muito longas.
const RISKY_RULES = new Set(['url-credentials', 'bearer-token', 'quoted-secret-assign', 'bare-env-secret-assign']);
const LONG_LINE = 3000;

export function scanText(text) {
  const out = [];
  const suppressed = [];
  let longLineSkips = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const rule of RULES) {
      if (line.length > LONG_LINE && RISKY_RULES.has(rule.id)) { longLineSkips++; continue; }
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const value = m[0];
        if (rule.id !== 'personal-path' && isPlaceholder(value)) {
          suppressed.push({ rule: rule.id, line: i + 1 });
          continue;
        }
        out.push({ rule: rule.id, severity: rule.severity, line: i + 1, length: value.length, fingerprint: rule.id === 'personal-path' ? fp(value.toLowerCase()) : fp(value) });
      }
    }
  }
  return { findings: out, suppressed, longLineSkips };
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
}
function gitZ(args) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean);
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function candidateFiles() {
  const tracked = gitZ(['ls-files', '-z']);
  const others = gitZ(['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...tracked, ...others])];
}

function scanTree() {
  const results = [];
  let filesScanned = 0, skipped = 0;
  for (const rel of candidateFiles()) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) { skipped++; continue; }
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_BYTES) { skipped++; continue; }
    const buf = readFileSync(abs);
    if (isBinary(buf)) { skipped++; continue; }
    filesScanned++;
    const { findings, suppressed } = scanText(buf.toString('utf8'));
    for (const f of findings) results.push({ scope: 'tree', path: rel.replace(/\\/g, '/'), ...f });
    if (suppressed.length) results.push({ scope: 'tree', path: rel.replace(/\\/g, '/'), rule: 'SUPPRESSED', severity: 'INFO', count: suppressed.length });
  }
  return { results, filesScanned, skipped };
}

function scanHistory() {
  const results = [];
  const pats = RULES.map((r) => r.re.source);
  let revs = git(['rev-list', '--all', 'refs/stash']).trim().split('\n').filter(Boolean);
  // git grep -l nao imprime conteudo: devolve apenas rev:path
  let hits = [];
  for (const rev of revs) {
    try {
      const out = execFileSync('git', ['grep', '-I', '-l', '-P', ...pats.flatMap((p) => ['-e', p]), rev], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
      hits.push(...out.trim().split('\n').filter(Boolean));
    } catch (e) {
      if (e.status !== 1 && e.status !== undefined && e.status !== 0) throw e; // status 1 = sem matches
    }
  }
  const blobs = new Set();
  for (const hit of hits) {
    const idx = hit.indexOf(':');
    const rev = hit.slice(0, idx), rel = hit.slice(idx + 1);
    let blob;
    try { blob = git(['rev-parse', `${rev}:${rel}`]).trim(); } catch { continue; }
    const key = `${blob}|${rel}`;
    if (blobs.has(key)) continue;
    blobs.add(key);
    let content;
    try { content = execFileSync('git', ['cat-file', 'blob', blob], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }); } catch { continue; }
    if (isBinary(content)) continue;
    const { findings } = scanText(content.toString('utf8'));
    for (const f of findings) results.push({ scope: 'history', path: rel, blob: blob.slice(0, 12), ...f });
  }
  return { results, commitsScanned: revs.length, blobsScanned: blobs.size };
}

function summarize(rows) {
  const byRule = {};
  for (const r of rows) {
    if (r.severity === 'INFO') continue;
    const k = `${r.severity}/${r.rule}`;
    byRule[k] = byRule[k] || { count: 0, paths: new Set() };
    byRule[k].count++;
    byRule[k].paths.add(r.path);
  }
  const out = {};
  for (const [k, v] of Object.entries(byRule)) out[k] = { count: v.count, distinctPaths: v.paths.size, paths: [...v.paths].slice(0, 12) };
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const jsonArg = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : join(ROOT, 'output', 'manual-retest', 'DELIVERY-20261015', 'SECRET-SCAN-20261015.json');
  const skipHistory = process.argv.includes('--tree-only');
  const tree = scanTree();
  const history = skipHistory ? { results: [], commitsScanned: 0, blobsScanned: 0 } : scanHistory();
  const all = [...tree.results.filter((r) => r.severity !== 'INFO'), ...history.results];
  const high = all.filter((r) => r.severity === 'HIGH');
  const report = {
    generatedAt: new Date().toISOString(),
    head: git(['rev-parse', '--short', 'HEAD']).trim(),
    tree: { filesScanned: tree.filesScanned, skipped: tree.skipped, findings: tree.results.filter((r) => r.severity !== 'INFO') },
    history: { commitsScanned: history.commitsScanned, blobsScanned: history.blobsScanned, findings: history.results },
    summary: summarize(all),
    totals: { HIGH: high.length, MEDIUM: all.filter((r) => r.severity === 'MEDIUM').length, LOW: all.filter((r) => r.severity === 'LOW').length },
  };
  mkdirSync(dirname(jsonArg), { recursive: true });
  writeFileSync(jsonArg, JSON.stringify(report, null, 1));
  console.log(`SEGREDOS — HIGH: ${report.totals.HIGH} | MEDIUM: ${report.totals.MEDIUM} | LOW: ${report.totals.LOW}`);
  console.log(`tree: ${report.tree.filesScanned} ficheiros lidos (${report.tree.skipped} skipped: binario/grande/ausente)`);
  console.log(`historico: ${report.history.commitsScanned} commits, ${report.history.blobsScanned} blobs com match`);
  console.log('report (sem valores):', jsonArg.replace(/\\/g, '/'));
  for (const [k, v] of Object.entries(report.summary)) console.log(`  ${k}: ${v.count} em ${v.distinctPaths} caminhos`);
  process.exit(0);
}
