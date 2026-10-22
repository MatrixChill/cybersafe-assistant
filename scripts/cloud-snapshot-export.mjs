#!/usr/bin/env node
// Exporta o snapshot privado auditado (WIP completo do working tree) para
// output/cloud-private-20261015/snapshot/ com MANIFEST.json (SHA-256 por ficheiro,
// incluidos + excluidos com motivo). Copia: NUNCA move, apaga ou altera originais.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sIdx = process.argv.indexOf('--staging');
const STAGING = sIdx > -1
  ? join(ROOT, process.argv[sIdx + 1])
  : process.env.CLOUD_SNAP_DIR
    ? join(ROOT, process.env.CLOUD_SNAP_DIR)
    : join(ROOT, 'output', 'cloud-private-20261015');
const HASH_LIMIT = 10 * 1024 * 1024; // acima disto, excluindo: registamos bytes, nao hash

const EXCLUSIONS = [
  { re: /^scripts\/(?:test\/)?audit-candidate-patterns(?:\.test)?\.mjs$/i, reason: 'auditor Qoder EXPERIMENTAL com falha de sintaxe/testes; preservado no WIP, nao publicar ate reparacao validada' },
  { re: /^packages\/api\/\.env\.backup/i, reason: 'backup .env com valores reais — NUNCA exportar; decisao de limpeza do titular' },
  { re: /(^|\/)\.env(\.|$)/i, keep: (p) => p.endsWith('.env.example'), reason: 'segredos/config ambiente' },
  { re: /\.(docx|doc|rtf|odt|pdf)$/i, reason: 'documentos Word/PDF — nao abertos nesta missao' },
  { re: /\.(db|sqlite|sqlite3|db-journal)$/i, reason: 'bases de dados' },
  { re: /\.(exe|msi|msp|appx|zip|7z|rar|gz|bz2|tar)$/i, reason: 'instaladores/arquivos pesados' },
  { re: /\.log$/i, reason: 'logs' },
  { re: /\.bak(\..*)?$/i, reason: 'backups' },
  { re: /(^|\/)(node_modules|vendor|release|dist|build|output)\//i, reason: 'pesado/gerado — fora por definicao' },
  { re: /^opencode\.json$/i, reason: 'config local de ferramenta; decisao titular (git rm --cached pendente)' },
  { re: /^test-(ai|openai)\.js$/i, reason: 'legacy; decisao titular antes de qualquer inclusao' },
  { re: /^app\//i, reason: 'copia morta da raiz; decisao titular (nao entra no repo)' },
  { re: /(^|\/)(backup|_prev|prev-DIST)(\/|$)/i, reason: 'backups/versoes anteriores' },
];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}
function gitZ(args) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean);
}
const sha256File = (abs) => createHash('sha256').update(readFileSync(abs)).digest('hex');

const dry = process.argv.includes('--dry');
if (!dry && existsSync(STAGING) && existsSync(join(STAGING, 'MANIFEST.json'))) {
  console.error(`STAGING ${STAGING} ja existe com MANIFEST.json — nao sobrescrever; usar --staging <novo-dir> (nunca apagar anterior).`);
  process.exit(2);
}

const rels = [...new Set([...gitZ(['ls-files', '-z']), ...gitZ(['ls-files', '--others', '--exclude-standard', '-z'])])].sort();

const included = [];
const excluded = [];
const missing = [];
for (const rel of rels) {
  const norm = rel.replace(/\\/g, '/');
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) { missing.push(norm); continue; }
  const st = statSync(abs);
  if (!st.isFile()) continue;
  let skip = null;
  for (const rule of EXCLUSIONS) {
    if (rule.re.test(norm) && !(rule.keep && rule.keep(norm))) { skip = rule.reason; break; }
  }
  if (st.size > 25 * 1024 * 1024) skip = `excede limite 25MB (${st.size} bytes)`;
  if (skip) {
    excluded.push({ path: norm, bytes: st.size, reason: skip, sha256: st.size <= HASH_LIMIT ? sha256File(abs) : 'size-only' });
    continue;
  }
  included.push({ path: norm, bytes: st.size, sha256: sha256File(abs) });
  if (!dry) {
    const dest = join(STAGING, 'snapshot', norm);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
  }
}

const meta = {
  generatedAt: new Date().toISOString(),
  mode: dry ? 'dry-run' : 'export',
  staging: STAGING.slice(ROOT.length + 1).split('\\').join('/'),
  head: git(['rev-parse', '--short', 'HEAD']).trim(),
  headDate: git(['log', '-1', '--format=%ad', '--date=short']).trim(),
  commitCountMain: Number(git(['rev-list', '--count', 'HEAD']).trim()),
  branches: git(['branch', '--format=%(refname:short)']).trim().split('\n'),
  snapshotNature: 'WIP COMPLETO do working tree (nao e HEAD). HEAD main (2026-10-05) esta desatualizado e nao e construivel sozinho: fixes de tsconfig/typecheck e integracao final vivem em WIP nao-committado.',
  counts: { candidates: rels.length, included: included.length, excluded: excluded.length, missingInTree: missing.length },
  bytesIncluded: included.reduce((a, f) => a + f.bytes, 0),
  requiredButAbsentFromGit: [
    'ClamAV portatil oficial (vendor/clamav/) — obter com `node scripts/vendor-clamav.mjs` (constantes sha256/GPG fixadas; licenca GPLv2, fonte correspondente incluida no bundle)',
    'Toolchain C++ (CMake + MSVC/Windows SDK) para packages/native-engine',
    'PowerShell/CIM (camada Windows real de native-windows)',
    'NSIS/makensis para empacotamento (gate: so apos congelamento aprovado)',
    'Node.js >= 20 e `npm ci` a partir do package-lock.json',
  ],
  secretsPolicy: 'nenhum valor de segredo copiado para o staging; auditado por scripts/cloud-secret-scan.mjs (reporta regra+fingerprint, nunca conteudo)',
};

if (!dry) {
  mkdirSync(STAGING, { recursive: true });
  writeFileSync(join(STAGING, 'MANIFEST.json'), JSON.stringify({ meta, included, excluded, missingInTree: missing }, null, 1));
  const lines = [
    `# SNAPSHOT SUMMARY — ${basename(STAGING)}`,
    '',
    `Gerado: ${meta.generatedAt} · HEAD ${meta.head} (${meta.headDate}) · ${meta.commitCountMain} commits em main`,
    '',
    `**${meta.snapshotNature}**`,
    '',
    `- Incluidos: ${meta.counts.included} ficheiros (${(meta.bytesIncluded / 1e6).toFixed(1)} MB) — hash SHA-256 por ficheiro em MANIFEST.json`,
    `- Excluidos: ${meta.counts.excluded} (motivo + hash por ficheiro em MANIFEST.json)`,
    `- Rastreados sem ficheiro no tree: ${missing.length}`,
    '',
    '## Dependencias/nativos explicitamente FORA do git (obter no ambiente)',
    ...meta.requiredButAbsentFromGit.map((x) => `- ${x}`),
    '',
    '## Exclusoes por motivo',
  ];
  const byReason = {};
  for (const e of excluded) byReason[e.reason] = (byReason[e.reason] || 0) + 1;
  lines.push(...Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => `- (${n}) ${r}`));
  writeFileSync(join(STAGING, 'SNAPSHOT-SUMMARY.md'), lines.join('\n') + '\n');
  writeFileSync(join(STAGING, 'VENDOR-NOTES.md'), [
    '# VENDOR-NOTES — ClamAV e licencas (reprodutivel, sem deps pesadas no git)',
    '',
    '- O binario ClamAV NAO vive no git. Obtencao reprodutivel: `node scripts/vendor-clamav.mjs` a partir do pacote portatil OFICIAL Cisco-Talos, com versao, bytes e SHA-256 do ZIP/.sig fixados como constantes no script, assinatura GPG confirmada por dois caminhos independentes e keyring isolado. Qualquer divergencia = aborta (regras 1-10 no cabecalho do script).',
    '- Licenca: ClamAV e GPLv2. A fonte correspondente (tar.gz oficial completo + assinatura, sha256 fixado) vai dentro do bundle, conforme exige a regra 10 do script.',
    '- Bases CVD/CLD nunca sao copiadas: freshclam por-utilizador em %USERPROFILE%.cyberservice.',
    '- O script vendor-clamav.mjs esta incluido no snapshot (caminho: snapshot/scripts/vendor-clamav.mjs; hash no MANIFEST.json).',
    '- Demais nativos/dependencias fora do git: ver meta.requiredButAbsentFromGit em MANIFEST.json.',
  ].join('\n') + '\n');
}

console.log(`[${dry ? 'DRY-RUN' : 'EXPORT'}] candidatos=${rels.length} incluidos=${included.length} excluidos=${excluded.length} semFicheiro=${missing.length} bytes=${(meta.bytesIncluded / 1e6).toFixed(1)}MB`);
for (const e of excluded.filter((x) => /segredo|decisao|Word|\.env/i.test(x.reason))) console.log(`  EXCL: ${e.path} — ${e.reason}`);
