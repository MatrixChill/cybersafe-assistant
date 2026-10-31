#!/usr/bin/env node
// SECURITY GATE (candidata 20261015) — comparação LOCAL, OFFLINE, apenas leitura.
//
// Objetivo: verificar se valores de configuracao LOCAIS do proprio repo
// (root .env e packages/api/.env / .env.backup*) aparecem, em texto, dentro do
// artefacto da candidata (setup.exe + app.asar + app.asar.unpacked).
//
// Regras duras (ver pacote P0 2026-10-15):
//   * Le APENAS configs do repo. Nao toca home, perfis pessoais nem backups fora do repo.
//   * Valores sao lidos em memoria e NUNCA sao escritos: nem no stdout, nem no JSON,
//     nem no relatorio, nem em qualquer ficheiro. So contagens, categorias, matches,
//     localizacao no artefacto e IDs internos nao reversiveis (sha256(10)).
//   * Nenhuma chamada de rede/provider. Importa apenas node:* (fs/path/crypto/url).
//   * Uma unica rota autorizada. Se a auto-revisao bloquear, para e reporta.
//
// Uso:
//   node scripts/audit-candidate-secrets.mjs --self-check
//   node scripts/audit-candidate-secrets.mjs --candidate <dir> --expect-sha <sha256> --json <out.json> --md <out.md>

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, '..');

// ---------------------------------------------------------------------------
// Classificacao placeholder — copia explicita de scripts/cloud-secret-scan.mjs
// (fonte unica conhecida: isPlaceholder() do scan de 15/10). Inlinada de
// proposito para o gate nao depender de um ficheiro que outro owner pode
// alterar a meio da auditoria.
// ---------------------------------------------------------------------------
export function isPlaceholder(value) {
  const v = String(value).replace(/^["'`\s]+|["'`\s]+$/g, '');
  if (!v) return true;
  if (/^(?:<[^>]*>|\{\{?\S+\}?\}?|x{8,}|\*{8,}|\.{3,})/.test(v)) return true;
  if (/process\.env|import\.meta|require\(/.test(v)) return true;
  if (/^(?:altera|change[-_]?me|placeholder|your[-_]?|dummy|fake|exemplo|exemp|todo[-_]?|replace[-_]?|exemple)/i.test(v)) return true;
  if (/^[A-Z0-9_]{3,64}$/.test(v)) return true; // referencia a outra constante de ambiente
  return false;
}

// Chaves que transportam credenciais (candidatas a rotacao) vs chaves de configuracao.
const CREDENTIAL_KEY_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|SENHA|CHAVE|CREDENTIAL|AUTH|PRIVATE|DSN|CONNECTION|API|SALT|HASH|CLIENT|BEARER|COOKIE|SESSION)/i;

export function classifyKey(key) {
  return CREDENTIAL_KEY_RE.test(key) ? 'CREDENTIAL' : 'CONFIG';
}

// Caminho relativo ao repo quando possivel: o relatorio NUNCA deve carregar
// caminhos absolutos da maquina (privacidade e portabilidade do artefacto).
function toRepoRelative(root, abs) {
  const rel = relative(root, abs);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return './' + rel.split(sep).join('/');
  return '(fora do repo)/' + abs.split(sep).pop();
}

const fp = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// Parsing de ficheiros .env (sem emitir valores)
// ---------------------------------------------------------------------------
export function parseEnvText(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') || v.startsWith("'")) {
      const q = v[0];
      const end = v.indexOf(q, 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      const ci = v.indexOf(' #');
      if (ci >= 0) v = v.slice(0, ci);
      v = v.trim();
    }
    out.push({ key: m[1], value: v, line: i + 1 });
  }
  return out;
}

// Valor "real" = nao-placeholder, nao vazio, comprimento minimo util.
const MIN_SECRET_LEN = 8;
export function isComparableValue(value) {
  return typeof value === 'string' && value.length >= MIN_SECRET_LEN && !isPlaceholder(value);
}

// Needles derivados de um valor: valor exato + extrato(s) alfanumerico(s) >= 16 chars
// (apanha tokens truncados/embebidos sem aumentar falsos positivos).
export function deriveNeedles(value) {
  const needles = { exact: null, segments: [] };
  if (!isComparableValue(value)) return needles;
  needles.exact = value;
  const segs = String(value).match(/[A-Za-z0-9_\-]{16,}/g) || [];
  const seen = new Set();
  for (const s of segs) {
    if (s === value || seen.has(s)) continue;
    seen.add(s);
    needles.segments.push(s);
  }
  return needles;
}

// ---------------------------------------------------------------------------
// Pesquisa em buffers (offsets, limitada, sem emitir conteudo)
// ---------------------------------------------------------------------------
export function findOffsets(haystack, needle, cap = 8) {
  const offsets = [];
  if (!needle || needle.length === 0) return offsets;
  const n = Buffer.from(needle, 'utf8');
  if (n.length === 0 || n.length > haystack.length) return offsets;
  let from = 0;
  while (offsets.length < cap) {
    const idx = haystack.indexOf(n, from);
    if (idx < 0) break;
    offsets.push(idx);
    from = idx + 1;
  }
  return offsets;
}

// ---------------------------------------------------------------------------
// Leitura do ASAR: header + mapa offset -> entrada interna (para localizar match)
// ---------------------------------------------------------------------------
export function readAsar(asarPath) {
  const buf = readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(12);
  const dataStart = 16 + headerSize + ((4 - (headerSize % 4)) % 4);
  const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'));
  const entries = [];
  const walk = (node, pref) => {
    for (const [name, val] of Object.entries(node.files || {})) {
      if (val && val.files) { walk(val, pref + name + '/'); continue; }
      // Ficheiros `unpacked` vivem FORA do asar (em app.asar.unpacked/): nao tem
      // offset real e sao varridos como ficheiros soltos. Ignorar aqui evita
      // mapear um offset para a entrada errada.
      if (val.unpacked === true || val.offset === undefined) continue;
      const start = dataStart + Number(val.offset || 0);
      entries.push({ path: pref + name, start, end: start + Number(val.size || 0) });
    }
  };
  walk(header, '');
  entries.sort((a, b) => a.start - b.start);
  return { buf, headerSize, dataStart, entries };
}

// Offset absoluto (dentro do asar) -> caminho interno. Binario search se preciso.
export function asarLocationForOffset(asar, offset) {
  const e = asar.entries.find((x) => offset >= x.start && offset < x.end);
  return e ? e.path : null;
}

// ---------------------------------------------------------------------------
// Comparacao local -> artefacto
// ---------------------------------------------------------------------------
export function buildHaystacks(candidateDir) {
  const resources = join(candidateDir, 'win-unpacked', 'resources');
  const asarPath = join(resources, 'app.asar');
  const out = { asar: null, unpacked: [], setupExe: null, files: [] };
  if (existsSync(asarPath)) {
    out.asar = { id: 'app.asar', path: 'win-unpacked/resources/app.asar', ...readAsar(asarPath) };
    out.files.push(out.asar.path);
  }
  const unpackedDir = join(resources, 'app.asar.unpacked');
  if (existsSync(unpackedDir)) {
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        const st = statSync(abs);
        if (st.isDirectory()) { walk(abs); continue; }
        const rel = relative(resources, abs).split(sep).join('/');
        out.unpacked.push({ id: rel, path: rel, abs, buf: readFileSync(abs) });
        out.files.push(rel);
      }
    };
    walk(unpackedDir);
  }
  for (const name of readdirSync(candidateDir)) {
    if (/\.exe$/.test(name)) {
      out.setupExe = { id: name, path: name, abs: join(candidateDir, name), buf: readFileSync(join(candidateDir, name)) };
      out.files.push(name);
    }
  }
  return out;
}

export function compareEntriesToHaystacks(entries, haystacks) {
  const matches = [];
  const examined = [];
  for (const entry of entries) {
    const category = classifyKey(entry.key);
    const comparable = isComparableValue(entry.value);
    examined.push({
      file: entry.file,
      line: entry.line,
      key: entry.key,
      category,
      comparable,
      valueLength: entry.value.length,
      fingerprint: comparable ? fp(entry.value) : null,
    });
    if (!comparable) continue;
    const needles = deriveNeedles(entry.value);
    const targets = [];
    if (haystacks.asar) targets.push({ kind: 'asar', id: haystacks.asar.id, buf: haystacks.asar.buf, asar: haystacks.asar });
    for (const u of haystacks.unpacked) targets.push({ kind: 'unpacked', id: u.id, buf: u.buf });
    if (haystacks.setupExe) targets.push({ kind: 'setup.exe', id: haystacks.setupExe.id, buf: haystacks.setupExe.buf });

    const entryMatches = [];
    for (const t of targets) {
      const exact = findOffsets(t.buf, needles.exact);
      if (exact.length) {
        entryMatches.push({ artifact: t.id, kind: t.kind, matchType: 'EXACT', count: exact.length, offsets: exact, innerPaths: t.kind === 'asar' ? exact.map((o) => asarLocationForOffset(t.asar, o)).filter(Boolean) : [] });
        continue;
      }
      for (const seg of needles.segments) {
        const offs = findOffsets(t.buf, seg, 4);
        if (offs.length) {
          entryMatches.push({ artifact: t.id, kind: t.kind, matchType: 'EXTRACT', segmentLength: seg.length, segmentFingerprint: fp(seg), count: offs.length, offsets: offs, innerPaths: t.kind === 'asar' ? offs.map((o) => asarLocationForOffset(t.asar, o)).filter(Boolean) : [] });
          break;
        }
      }
    }
    matches.push({
      file: entry.file,
      line: entry.line,
      key: entry.key,
      category,
      valueLength: entry.value.length,
      fingerprint: fp(entry.value),
      exposed: entryMatches.length > 0,
      matches: entryMatches,
    });
  }
  return { matches, examined };
}

// ---------------------------------------------------------------------------
// Guarda anti-fuga: o texto do relatorio nao pode conter nenhum valor real
// ---------------------------------------------------------------------------
export function detectLeaks(text, values, minPrefix = 8) {
  const leaks = [];
  for (const v of values) {
    if (typeof v !== 'string' || v.length < minPrefix) continue;
    if (text.includes(v)) { leaks.push({ kind: 'full-value', valueLength: v.length, fingerprint: fp(v) }); continue; }
    // prefixo e sufixo distintos (nao revelam o valor, so provam a fuga)
    const pre = v.slice(0, minPrefix);
    const suf = v.slice(-minPrefix);
    if (text.includes(pre) || text.includes(suf)) leaks.push({ kind: 'prefix/suffix', valueLength: v.length, fingerprint: fp(v) });
  }
  return leaks;
}

// Localiza a fuga sem revelar nada: devolve apenas o CAMINHO do campo do
// relatorio e o tipo de colisao. Nunca devolve o valor nem o contexto.
export function locateLeaks(obj, values, minPrefix = 8) {
  const leaks = [];
  const walk = (node, pathStr) => {
    if (typeof node === 'string') {
      for (const v of values) {
        if (typeof v !== 'string' || v.length < minPrefix) continue;
        if (node.includes(v)) leaks.push({ path: pathStr, kind: 'full-value', valueLength: v.length, fingerprint: fp(v) });
        else if (node.includes(v.slice(0, minPrefix)) || node.includes(v.slice(-minPrefix))) {
          const kind = node.includes(v.slice(0, minPrefix)) ? 'prefix' : 'suffix';
          leaks.push({ path: pathStr, kind, valueLength: v.length, fingerprint: fp(v) });
        }
      }
      return;
    }
    if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${pathStr}[${i}]`)); return; }
    if (node && typeof node === 'object') { for (const [k, x] of Object.entries(node)) walk(x, pathStr ? `${pathStr}.${k}` : k); }
  };
  walk(obj, '');
  return leaks;
}

// ---------------------------------------------------------------------------
// Recolha das configs LOCAIS do repo (estritamente no repo)
// ---------------------------------------------------------------------------
export function collectLocalConfigs(root) {
  const targets = [];
  const push = (rel) => { const abs = join(root, rel); if (existsSync(abs) && statSync(abs).isFile()) targets.push({ rel: rel.split(sep).join('/'), abs }); };
  push('.env');
  push('.env.local');
  push(join('packages', 'api', '.env'));
  const apiDir = join(root, 'packages', 'api');
  if (existsSync(apiDir)) {
    for (const name of readdirSync(apiDir)) {
      if (/^\.env\.backup/.test(name) || /^\.env\.[A-Za-z0-9._-]+\.backup/.test(name)) push(join('packages', 'api', name));
    }
  }
  const entries = [];
  const skippedFiles = [];
  for (const t of targets) {
    let text;
    try { text = readFileSync(t.abs, 'utf8'); } catch { skippedFiles.push(t.rel); continue; }
    for (const e of parseEnvText(text)) entries.push({ ...e, file: t.rel });
  }
  return { files: targets.map((t) => t.rel), entries, skippedFiles };
}

// ---------------------------------------------------------------------------
// Relatorio (mascarado)
// ---------------------------------------------------------------------------
export function summarize(report) {
  const credMatches = report.matches.filter((m) => m.category === 'CREDENTIAL' && m.exposed);
  const configMatches = report.matches.filter((m) => m.category === 'CONFIG' && m.exposed);
  return {
    filesScanned: report.local.files.length,
    keysParsed: report.local.keysParsed,
    comparableValues: report.local.comparable,
    placeholdersSuppressed: report.local.placeholders,
    credentialKeys: report.matches.filter((m) => m.category === 'CREDENTIAL').length,
    configKeys: report.matches.filter((m) => m.category === 'CONFIG').length,
    credentialValuesExposedInArtifact: credMatches.length,
    configValuesExposedInArtifact: configMatches.length,
    exactMatches: report.matches.flatMap((m) => m.matches).filter((m) => m.matchType === 'EXACT').length,
    extractMatches: report.matches.flatMap((m) => m.matches).filter((m) => m.matchType === 'EXTRACT').length,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function run() {
  const args = process.argv.slice(2);
  const get = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
  const root = get('--root', ROOT);
  const candidateDir = get('--candidate', join(ROOT, 'packages', 'desktop', 'release', 'candidate-20261015-083959-010660bd'));
  const expectSha = get('--expect-sha', null);
  const outJson = get('--json', join(ROOT, 'output', 'manual-retest', 'SECURITY-GATE-20261015', 'FREEBUFF-SECURITY-GATE-20261015.json'));
  const outMd = get('--md', join(ROOT, 'output', 'manual-retest', 'SECURITY-GATE-20261015', 'FREEBUFF-SECURITY-GATE-20261015.md'));

  // Verificacao do artefacto ANTES de qualquer comparacao.
  let setupExe = null;
  for (const name of readdirSync(candidateDir)) if (/\.exe$/.test(name)) setupExe = join(candidateDir, name);
  if (!setupExe) { console.error('FALHA: nenhum .exe na candidata'); process.exit(2); }
  const setupHash = sha256(readFileSync(setupExe));
  if (expectSha && setupHash !== expectSha) {
    console.error(`FALHA: sha256 da candidata nao corresponde. medido=${setupHash}`);
    process.exit(3);
  }
  const asarHash = sha256(readFileSync(join(candidateDir, 'win-unpacked', 'resources', 'app.asar')));

  const local = collectLocalConfigs(root);
  const haystacks = buildHaystacks(candidateDir);
  const { matches, examined } = compareEntriesToHaystacks(local.entries, haystacks);

  const report = {
    generatedAt: new Date().toISOString(),
    scope: 'security-gate-candidate-20261015',
    mode: 'LOCAL-ONLY / OFFLINE / READ-ONLY',
    networkCalls: 0,
    repoHead: null,
    artifact: { candidateDir: toRepoRelative(root, candidateDir), setupSha256: setupHash, asarSha256: asarHash, asarBytes: statSync(join(candidateDir, 'win-unpacked', 'resources', 'app.asar')).size, asarEntries: haystacks.asar ? haystacks.asar.entries.length : 0, unpackedFiles: haystacks.unpacked.length },
    local: { files: local.files, skippedFiles: local.skippedFiles, keysParsed: local.entries.length, comparable: local.entries.filter((e) => isComparableValue(e.value)).length, placeholders: local.entries.filter((e) => !isComparableValue(e.value)).length },
    examined, // metadados por chave (key, ficheiro, linha, fp) — NUNCA valores
    matches,
  };
  report.totals = summarize(report);

  const values = local.entries.map((e) => e.value);
  const reportText = JSON.stringify(report, null, 1);
  const leaks = detectLeaks(reportText, values);
  if (leaks.length) {
    console.error('ABORTADO: guarda anti-fuga detetou possivel valor no relatorio.', JSON.stringify(leaks));
    console.error('DIAGNOSTICO (mascarado, sem valores):', JSON.stringify(locateLeaks(report, values), null, 1));
    process.exit(4);
  }

  mkdirSync(dirname(outJson), { recursive: true });
  writeFileSync(outJson, reportText + '\n');

  const md = renderMarkdown(report);
  const mdLeaks = detectLeaks(md, values);
  if (mdLeaks.length) { console.error('ABORTADO: relatorio .md continha valor.', JSON.stringify(mdLeaks)); process.exit(4); }
  writeFileSync(outMd, md + '\n');

  // Sumario no stdout — contagens apenas.
  console.log('SECURITY GATE (candidata 20261015) — MODO LOCAL/OFFLINE, 0 chamadas de rede');
  console.log(`artefacto: setup sha256=${setupHash.slice(0, 12)}… asar sha256=${asarHash.slice(0, 12)}… (${report.artifact.asarEntries} entradas asar, ${report.artifact.unpackedFiles} ficheiros unpacked)`);
  console.log(`configs locais: ${report.local.files.length} ficheiros, ${report.local.keysParsed} chaves (${report.local.comparable} valores comparaveis, ${report.local.placeholders} placeholder)`);
  const t = report.totals;
  console.log(`matches CREDENTIAL expostos no artefacto: ${t.credentialValuesExposedInArtifact} | matches CONFIG: ${t.configValuesExposedInArtifact}`);
  console.log(`  EXACT=${t.exactMatches} EXTRACT=${t.extractMatches}`);
  // Caminhos relativos ao repo: o stdout nao deve carregar caminhos absolutos da maquina.
  console.log(`relatorio: ${toRepoRelative(root, outMd)}`);
  console.log(`json:      ${toRepoRelative(root, outJson)}`);
  console.log(`guarda anti-fuga: OK (0 valores no relatorio)`);
  process.exit(t.credentialValuesExposedInArtifact > 0 ? 10 : 0);
}

function renderMarkdown(report) {
  const t = report.totals;
  const L = [];
  L.push('# FREEBUFF — Security Gate candidata 20261015 (comparacao LOCAL)');
  L.push('');
  L.push(`Modo: **LOCAL-ONLY / OFFLINE / READ-ONLY** — ${report.networkCalls} chamadas de rede/provider.`);
  L.push(`Gerado: ${report.generatedAt}`);
  L.push('');
  L.push('## Artefacto auditado');
  L.push('');
  L.push(`- candidata: \`${report.artifact.candidateDir}\``);
  L.push(`- setup.exe sha256: \`${report.artifact.setupSha256}\``);
  L.push(`- app.asar sha256: \`${report.artifact.asarSha256}\` (${report.artifact.asarBytes} B, ${report.artifact.asarEntries} entradas)`);
  L.push(`- app.asar.unpacked: ${report.artifact.unpackedFiles} ficheiros`);
  L.push('');
  L.push('## Configs locais comparadas (apenas repo, valores lidos em memoria)');
  L.push('');
  for (const f of report.local.files) L.push(`- \`${f}\``);
  L.push('');
  L.push(`Chaves parseadas: ${report.local.keysParsed} · valores comparaveis (nao-placeholder): ${report.local.comparable} · placeholder suprimidos: ${report.local.placeholders}`);
  L.push('');
  L.push('## Resultado');
  L.push('');
  L.push(`| Metrica | Valor |`);
  L.push(`|---|---|`);
  L.push(`| Chaves CREDENTIAL | ${t.credentialKeys} |`);
  L.push(`| Chaves CONFIG | ${t.configKeys} |`);
  L.push(`| **Valores CREDENTIAL expostos no artefacto** | **${t.credentialValuesExposedInArtifact}** |`);
  L.push(`| Valores CONFIG expostos no artefacto | ${t.configValuesExposedInArtifact} |`);
  L.push(`| matches EXACT | ${t.exactMatches} |`);
  L.push(`| matches EXTRACT | ${t.extractMatches} |`);
  L.push('');
  const exposed = report.matches.filter((m) => m.exposed);
  if (exposed.length === 0) {
    L.push('**Nenhum valor de configuracao local (credencial ou config) foi encontrado em texto no artefacto.**');
  } else {
    L.push('## Matches (mascarados — sem valor, prefixo ou contexto)');
    L.push('');
    L.push('| Chave | Categoria | Ficheiro | Linha | fp(valor) | Tipo | Artefacto | count |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const m of exposed) {
      for (const mm of m.matches) {
        L.push(`| \`${m.key}\` | ${m.category} | ${m.file} | ${m.line} | \`${m.fingerprint}\` | ${mm.matchType} | ${mm.artifact} | ${mm.count} |`);
      }
    }
    const inner = exposed.flatMap((m) => m.matches.flatMap((mm) => mm.innerPaths || []));
    if (inner.length) { L.push(''); L.push('Localizacao interna (asar): ' + [...new Set(inner)].map((p) => `\`${p}\``).join(', ')); }
  }
  L.push('');
  L.push('## Guarda anti-fuga');
  L.push('');
  L.push('- O gerador verifica que nem o JSON nem este Markdown contem qualquer valor, prefixo (8) ou sufixo (8) dos valores lidos — se falhasse, abortava.');
  L.push('- Este relatorio so contem chaves de configuracao, caminhos, contagens, offsets e fingerprints sha256(16) nao reversiveis.');
  return L.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
