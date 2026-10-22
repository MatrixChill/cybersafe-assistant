#!/usr/bin/env node
// ⚠️ EXPERIMENTAL / NAO USAR (15/10): ficheiro corrompido por patch via shell; heuristica de
// adjacencia da v1 foi REFUTADA pelo review (adjacencia nao prova falso positivo); reparacoes
// bloqueadas/NEGADAS — preservar como WIP, NAO usar para classificacao nem incluir em export
// privado ate reparacao testada. Evidencia valida desta rodada: FREEBUFF-REVIEW-36 + 
// CANDIDATE-PATTERN-SCAN.json (fingerprints/offsets) + QODER-REVIEW.md/JSON.
// AUDITORIA DIRIGIDA DE PADRÕES NO CANDIDATO (P0, autorizada pelo titular 15/10) — v2 pós-review.
// Propriedades duras:
//  - Só LÊ artefactos (asar/unpacked/resources) e a fonte local node_modules/packages para PROVENIÊNCIA.
//    Nunca lê configs/.env (scope Freebuff). Nunca executa binários. Nunca imprime bytes correspondidos,
//    contexto de caracteres ou conteúdo de ficheiros: apenas comprimentos, character-classes, offsets,
//    fingerprints sha256(10), proveniência (pkg@versão+ficheiro) e razões verificáveis.
//  - Contrato classify(ruleId, bytes, relIdx, matchLen):
//      * Adjacência alfanumérica à esquerda NÃO suprime: um segredo pode estar concatenado.
//      * O corpo avaliável = run maximal [A-Za-z0-9_-] à direita desde o inicio do match; body = run-3.
//      * body >= 30  -> CREDENTIAL_SHAPE_FOR_HUMAN_COMPARE (nunca ocultado, qualquer vizinhança).
//      * PEM: header isolado sozinho NADA prova; verifica-se corpo base64 adjacente (10+ chars na linha
//        seguinte dentro de 300 bytes) -> com corpo: CREDENTIAL_SHAPE; sem corpo: UNRESOLVED.
//      * body < 30 -> UNRESOLVED_CURTO, salvo PROVENIÊNCIA verificada: o window byte-a-byte do run
//        (±8 de contexto binario, mantido so em memoria) e encontrado em node_modules/pkg ou packages/**
//        -> CONTEUDO_LEGITIMO_PROVENIENCIA (dep@versao + ficheiro + offset local). Proveniencia e a
//        unica via para "legitimo"; sem ela nada e declarado benigno.
//  - Cobertura declarada no output: todos os packs do asar + unpacked <= limite + scan-engine.exe.
// Uso: node scripts/audit-candidate-patterns.mjs <app.asar> <dir-resources> [--out <json>] [--max-file-mb 64] [--no-provenance]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { RULES } from './cloud-secret-scan.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const KEYCHAR = /[A-Za-z0-9_-]/;
const B64CHAR = /[A-Za-z0-9+/=]/;
const fp = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
const cls = (b) => {
  if (b === undefined) return 'EOB';
  if (b === 0x22) return 'DQUOTE'; if (b === 0x27) return 'SQUOTE'; if (b === 0x60) return 'BTICK';
  if (b === 0x28 || b === 0x29) return 'PAREN'; if (b === 0x2c) return 'COMMA'; if (b === 0x3b) return 'SEMI';
  if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) return 'SPACE';
  if (B64CHAR.test(String.fromCharCode(b))) return 'ALNUM/B64';
  return 'OTHER';
};

export function listAsarEntries(archivePath) {
  const { headerString, headerSize } = asar.getRawHeader(archivePath);
  const header = JSON.parse(headerString);
  const dataStart = 8 + headerSize;
  const out = [];
  (function walk(node, base) {
    for (const [name, meta] of Object.entries(node.files || {})) {
      const p = base ? base + '/' + name : name;
      if (meta.files) walk(meta, p);
      else out.push({ path: p, offset: Number(meta.offset), size: Number(meta.size), unpacked: !!meta.unpacked });
    }
  })(header, '');
  return { entries: out, dataStart };
}

// run maximal de caracteres de chave à direita, comeco em relIdx (o 's' de sk- ou o inicio do match)
export function rightRun(bytes, relIdx, max = 256) {
  let i = relIdx;
  while (i < bytes.length && (i - relIdx) < max && KEYCHAR.test(String.fromCharCode(bytes[i]))) i++;
  return i - relIdx;
}

const PEM_BODY_RE = /\n[A-Za-z0-9+/=]{10,}/;

export function classify(ruleId, bytes, relIdx, matchLen) {
  const before = bytes[relIdx - 1];
  const afterIdx = relIdx + matchLen;
  const after = bytes[afterIdx];
  const meta = { neighborBefore: cls(before), neighborAfter: cls(after) };
  if (ruleId === 'private-key-block') {
    const window = bytes.subarray(relIdx, Math.min(bytes.length, relIdx + 300));
    const hasBody = PEM_BODY_RE.test(window.toString('latin1'));
    return hasBody
      ? { cls: 'CREDENTIAL_SHAPE_FOR_HUMAN_COMPARE', reason: 'header PEM COM corpo base64 adjacente (>=10 chars na linha seguinte): forma de chave completa presente', ...meta }
      : { cls: 'UNRESOLVED_PEM_HEADER_ONLY', reason: 'header PEM sem corpo adjacente nos 300 bytes seguintes; header isolado por si nao prova benignidade — proveniencia decide', ...meta };
  }
  const run = rightRun(bytes, relIdx);
  const body = run - 3;
  if (body >= 30) {
    return { cls: 'CREDENTIAL_SHAPE_FOR_HUMAN_COMPARE', reason: 'run de caracteres de chave com corpo >=30 a partir do prefixo do padrao (OpenAI/Anthropic >=32); adjacencia esquerda NAO suprime', bodyRun: run, ...meta };
  }
  return { cls: 'UNRESOLVED_CURTO', reason: 'corpo maximal <30 (run=' + run + '); abaixo do formato publico minimo dos fornecedores deste padrao, mas sem prova de benignidade — so proveniancia byte-a-byte pode classificar como legitimo', bodyRun: run, ...meta };
}

export function depVersionOf(relPath) {
  const m = relPath.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  return m ? m[1] : null;
}

// PROVENIÊNCIA: janela = run maximal +- contexto binario pequeno; procura em node_modules e packages.
export function buildProvenanceIndex(roots, maxFileBytes = 2 * 1024 * 1024) {
  const idx = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '.bin') walk(p); continue; }
      if (!/\.(js|cjs|mjs|json|md|map|css|html|ts)$/i.test(e.name)) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.size > maxFileBytes) continue;
      idx.push(p);
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r);
  return idx;
}

export function findProvenance(windowBytes, index, cache) {
  for (const f of index) {
    let buf = cache.get(f);
    if (!buf) { try { buf = fs.readFileSync(f); } catch { continue; } if (buf.length > 2 * 1024 * 1024) buf = null; cache.set(f, buf); }
    if (!buf) continue;
    const pos = buf.indexOf(windowBytes);
    if (pos !== -1) return { file: f.replaceAll('\\', '/'), offsetInFile: pos };
  }
  return null;
}

export function auditArchive(archivePath, resourcesDir, opts = {}) {
  const maxBytes = opts.maxBytes || 64 * 1024 * 1024;
  const SECRET_SHAPES = RULES.filter((r) => r.severity === 'HIGH' && r.id !== 'personal-path');
  const { entries, dataStart } = listAsarEntries(archivePath);
  const raw = fs.readFileSync(archivePath);
  const hits = [];
  const skippedBig = [];
  let bytesScanned = 0;
  const index = opts.noProvenance ? [] : buildProvenanceIndex(opts.provenanceRoots || ['node_modules', 'packages/app/src', 'packages/app/dist', 'packages/desktop/src'], maxBytes);
  const cache = new Map();

  const versionCache = new Map();
  const depVersionFor = (entryPath) => {
    const dep = depVersionOf(entryPath);
    if (!dep) return null;
    if (versionCache.has(dep)) return versionCache.get(dep);
    let v = null;
    const pj = entries.find((e) => e.path === 'node_modules/' + dep + '/package.json' && !e.unpacked);
    if (pj) { try { const j = JSON.parse(asar.extractFile(archivePath, pj.path).toString('utf8')); v = j.name + '@' + j.version; } catch { v = dep + '@?'; } }
    else v = dep + '@?';
    versionCache.set(dep, v);
    return v;
  };

  const runRules = (bytes, where, entryPathForDep) => {function raw() { [native code] }  for (const e of entries) {
    if (e.unpacked) continue;
    const bytes = raw.subarray(dataStart + e.offset, dataStart + e.offset + e.size);
    bytesScanned += bytes.length;
    runRules(bytes, 'asar:/' + e.path, e.path);
  }
  const unpackedRoot = path.join(resourcesDir, 'app.asar.unpacked');
  let unpackedCount = 0;
  const walkFs = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((ent) => ent.isDirectory() ? walkFs(path.join(d, ent.name)) : [path.join(d, ent.name)]);
  if (fs.existsSync(unpackedRoot)) {
    for (const f of walkFs(unpackedRoot)) {
      const st = fs.statSync(f);
      if (st.size > maxBytes) { skippedBig.push({ file: f.replaceAll('\\', '/'), bytes: st.size }); continue; }
      const bytes = fs.readFileSync(f);
      bytesScanned += bytes.length; unpackedCount++;
      runRules(bytes, 'unpacked:' + path.relative(unpackedRoot, f).replaceAll('\\', '/'), path.relative(unpackedRoot, f).replaceAll('\\', '/'));
    }
  }
  const engine = path.join(resourcesDir, 'scan-engine.exe');
  if (fs.existsSync(engine)) { const b = fs.readFileSync(engine); bytesScanned += b.length; runRules(b, 'resources:scan-engine.exe', null); }

  const byClass = {};
  for (const h of hits) byClass[h.classification] = (byClass[h.classification] || 0) + 1;
  return {
    audit: { archive: archivePath.replaceAll('\\', '/'), asarEntriesPacked: entries.filter((e) => !e.unpacked).length, unpackedFilesScanned: unpackedCount, scanEngineScanned: fs.existsSync(engine), bytesScanned, provenanceIndexFiles: index.length },
    coverage: { skippedOverLimit: skippedBig, limiteMB: maxBytes / 1e6, naoLido: 'framework Electron dll/pak fora deste escopo; .env nunca (scope Freebuff)' },
    totals: { hits: hits.length, distinctFingerprints: new Set(hits.map((h) => h.fingerprint)).size, byClass },
    hits,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx > -1 ? args[outIdx + 1] : path.join('output', 'manual-retest', 'SECURITY-GATE-20261015', 'QODER-PATTERN-AUDIT.json');
  const mbIdx = args.indexOf('--max-file-mb');
  const result = auditArchive(args[0], args[1], {
    maxBytes: mbIdx > -1 ? Number(args[mbIdx + 1]) * 1e6 : 64 * 1024 * 1024,
    noProvenance: args.includes('--no-provenance'),
  });
  result.meta = { generatedAt: new Date().toISOString(), tool: 'scripts/audit-candidate-patterns.mjs v2', candidate: 'candidate-20261015-083959-010660bd' };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
  console.log('AUDIT hits=' + result.totals.hits, 'distinct=' + result.totals.distinctFingerprints, JSON.stringify(result.totals.byClass));
  console.log('cobertura: asarPacked=' + result.audit.asarEntriesPacked, 'unpacked=' + result.audit.unpackedFilesScanned, 'bytes=' + (result.audit.bytesScanned / 1e6).toFixed(1) + 'MB', 'indiceProveniancia=' + result.audit.provenanceIndexFiles + ' ficheiros');
  console.log('out:', outPath);
}
