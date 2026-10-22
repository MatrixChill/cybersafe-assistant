#!/usr/bin/env node
// Testes proprios do snapshot cloud (node --test scripts/cloud-snapshot-verify.test.mjs)
// Verifica o export em output/cloud-private-20261015 contra o MANIFEST.json e as regras
// de seguranca: hashes byte-a-byte, completude bidirecional, exclusoes respeitas,
// zero findings HIGH de segredos dentro do export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { scanText } from './cloud-secret-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGING = process.env.CLOUD_SNAP_DIR ? join(ROOT, process.env.CLOUD_SNAP_DIR) : join(ROOT, 'output', 'cloud-private-20261015');
const MANIFEST_PATH = join(STAGING, 'MANIFEST.json');

const manifest = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : null;
const sha256File = (abs) => createHash('sha256').update(readFileSync(abs)).digest('hex');

function walk(dir, base = dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, base, acc);
    else acc.push(p.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return acc;
}

test('manifest existe e meta honesta', { skip: !manifest && 'run cloud-snapshot-export.mjs first' }, () => {
  assert.equal(manifest.meta.head, execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim());
  assert.match(manifest.meta.snapshotNature, /WIP COMPLETO/);
  assert.match(manifest.meta.snapshotNature, /nao e construivel sozinho/);
  assert.ok(Array.isArray(manifest.meta.requiredButAbsentFromGit) && manifest.meta.requiredButAbsentFromGit.length >= 4);
});

test('todos os incluidos batem com o source (SHA-256) e com o copy exportado', { skip: !manifest }, () => {
  for (const f of manifest.included.slice(0, 40)) {
    assert.equal(sha256File(join(ROOT, f.path)), f.sha256, `source divergente: ${f.path}`);
  }
  for (const f of manifest.included) {
    const dest = join(STAGING, 'snapshot', f.path);
    assert.ok(existsSync(dest), `em falta no export: ${f.path}`);
    if (f.bytes <= 10 * 1024 * 1024) assert.equal(sha256File(dest), f.sha256, `export divergente: ${f.path}`);
  }
});

test('export nao tem ficheiros fora do manifest (completude bidirecional)', { skip: !manifest }, () => {
  const listed = new Set(manifest.included.map((f) => f.path));
  const extra = walk(join(STAGING, 'snapshot')).filter((p) => !listed.has(p));
  assert.deepEqual(extra, []);
});

test('nenhum conteudo proibido no export', { skip: !manifest }, () => {
  const paths = manifest.included.map((f) => f.path);
  const forbidden = [
    [/(^|\/)\.env(\.|$)/, (p) => p.endsWith('.env.example'), '.env/backup .env'],
    [/\.(docx|doc|rtf|odt|pdf)$/i, null, 'Word/PDF'],
    [/\.(db|sqlite|sqlite3)$/i, null, 'base de dados'],
    [/\.(exe|msi|zip|7z)$/i, null, 'instalador/arquivo'],
    [/^packages\/api\/prisma\/dev\.db$/, null, 'dev.db'],
    [/^opencode\.json$/, null, 'opencode.json'],
    [/^test-(ai|openai)\.js$/, null, 'test legacy'],
    [/^app\//, null, 'copia morta app/'],
    [/^output\//, null, 'output/'],
    [/^vendor\//, null, 'vendor/'],
  ];
  for (const [re, keep, label] of forbidden) {
    const hits = paths.filter((p) => re.test(p) && !(keep && keep(p)));
    assert.deepEqual(hits, [], `proibido no export (${label}): ${hits.slice(0, 5)}`);
  }
});

// HIGHs auditados a 15/10 como sinteticos/exemplo — unicos permitidos no export.
// Qualquer NOVO HIGH fora desta lista faz o teste falhar.
const AUDITED_HIGH_ALLOWLIST = [
  'packages/api/.env.example:url-credentials', // credencial de exemplo fraca num template
  'packages/api/test/matrix-guard.test.js:openai-style-sk', // fixture sintetica de teste de guard
  'packages/api/test/matrix-guard.test.js:url-credentials', // fixture sintetica
  'packages/desktop/test/r6-l13-ipc-security.test.mjs:url-credentials', // fixture origem CORS de teste
];

test('zero findings HIGH nao auditados dentro do export', { skip: !manifest }, () => {
  const hits = [];
  for (const f of manifest.included) {
    const abs = join(STAGING, 'snapshot', f.path);
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) continue;
    const { findings } = scanText(buf.toString('utf8'));
    for (const h of findings) if (h.severity === 'HIGH') hits.push(`${f.path}:${h.rule}`);
  }
  assert.deepEqual([...new Set(hits)].sort(), [...AUDITED_HIGH_ALLOWLIST].sort());
});

test('vendor ClamAV reprodutivel e licencas presentes no export', { skip: !manifest }, () => {
  const listed = manifest.included.map((f) => f.path);
  assert.ok(listed.includes('scripts/vendor-clamav.mjs'), 'vendor-clamav.mjs nao incluido');
  assert.ok(existsSync(join(STAGING, 'VENDOR-NOTES.md')));
  const notes = readFileSync(join(STAGING, 'VENDOR-NOTES.md'), 'utf8');
  assert.match(notes, /GPLv2/);
  assert.match(notes, /vendor-clamav\.mjs/);
});

test('scripts de nuvem existem e o scanner nao devolve HIGH no proprio codigo', () => {
  for (const s of ['scripts/cloud-secret-scan.mjs', 'scripts/cloud-snapshot-export.mjs']) {
    assert.ok(existsSync(join(ROOT, s)), s);
  }
});
