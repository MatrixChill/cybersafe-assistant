// Testes do gate de artefacto (audit-candidate-review36.mjs).
//
// Fixtures BENIGNAS e sintéticas: ASARs fabricados em pasta temporária, com um token
// aleatório gerado em runtime (impossível de existir no repo). Não se abre candidata
// real, não se toca em builds, não há rede, não se lê nenhuma app instalada.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs, assertSha, verdictFor, EXIT, FAMILIES, GateError, isProvenanceSource, buildSourceIndex } from './audit-candidate-review36.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCRIPT = join(HERE, 'audit-candidate-review36.mjs');

/** Fabricante mínimo do formato ASAR (mesmo layout que readAsar() consome). */
function makeAsar(files) {
  let offset = 0;
  const header = { files: {} };
  const chunks = [];
  for (const [name, data] of Object.entries(files)) {
    header.files[name] = { size: data.length, offset };
    chunks.push(data);
    offset += data.length;
  }
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const headerSize = headerJson.length;
  const padding = (4 - (headerSize % 4)) % 4;
  const out = Buffer.alloc(16 + headerSize + padding + offset);
  out.writeUInt32LE(headerSize, 12);
  headerJson.copy(out, 16);
  let d = 16 + headerSize + padding;
  for (const c of chunks) { c.copy(out, d); d += c.length; }
  return out;
}

function makeCandidate(base, name, asarBuf) {
  const dir = join(base, name);
  mkdirSync(join(dir, 'win-unpacked', 'resources'), { recursive: true });
  writeFileSync(join(dir, 'win-unpacked', 'resources', 'app.asar'), asarBuf);
  return dir;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
}

// --- autoridade declarada na linha de comandos -----------------------------------

test('USO: sem --candidate aborta com EXIT.USAGE (nunca escolhe candidata por omissao)', () => {
  assert.throws(() => parseArgs(['--expect-asar-sha', 'a'.repeat(64)]), (e) => e instanceof GateError && e.code === EXIT.USAGE);
});

test('USO: sem --expect-asar-sha aborta (artefacto sem identidade nao e analisado)', () => {
  assert.throws(() => parseArgs(['--candidate', 'packages/desktop/release/x']), (e) => e instanceof GateError && e.code === EXIT.USAGE);
});

test('USO: sha malformado e recusado antes de tocar no disco', () => {
  assert.throws(() => parseArgs(['--candidate', 'x', '--expect-asar-sha', 'deadbeef']), (e) => e instanceof GateError && e.code === EXIT.USAGE);
});

test('ARTEFACTO: sha divergente aborta com EXIT.ARTIFACT nomeando esperado e real', () => {
  assert.throws(
    () => assertSha('a'.repeat(64), 'b'.repeat(64)),
    (e) => e instanceof GateError && e.code === EXIT.ARTIFACT && /esperado/.test(e.message) && /real/.test(e.message),
  );
});

// --- veredicto por proveniencia ---------------------------------------------------

// CORRIGIDO POR SEGURANCA (nao por verde artificial): estar numa dependencia NAO
// prova que o valor nao seja uma credencial. Uma dependencia empacotada pode conter
// um valor com forma de chave (fixture de terceiros, config embutida, dado de teste).
// So PROVA SEMANTICA — identificador publico de CSS (`mask-*`) confirmado na versao
// real do tailwind-merge — pode declarar falso positivo.
test('veredicto: dep empacotada NAO inocenta um valor com forma de credencial (bloqueia)', () => {
  const v = verdictFor({ rule: 'openai-style-sk', provenance: { packagedDeps: ['node_modules/tailwind-merge/dist/bundle.mjs'], repoSource: [] } });
  assert.equal(v.verdict, 'UNRESOLVED', 'ser de uma dependencia nao prova que nao seja credencial');
  assert.match(v.origin, /tailwind-merge/);
  assert.match(v.reason, /n[ãa]o prova/i);
});

test('veredicto: origem no NOSSO fonte NUNCA e falso positivo', () => {
  const v = verdictFor({ rule: 'openai-style-sk', provenance: { packagedDeps: [], repoSource: ['packages/app/src/leak.ts'] } });
  assert.equal(v.verdict, 'UNRESOLVED');
});

test('veredicto: sem origem = UNRESOLVED (bloqueia)', () => {
  const v = verdictFor({ rule: 'openai-style-sk', provenance: { packagedDeps: [], repoSource: [] } });
  assert.equal(v.verdict, 'UNRESOLVED');
  assert.equal(v.origin, null);
});

test('cobertura declarada: sao 2 familias, com a regex em texto e sem promessa de seguranca total', () => {
  assert.equal(FAMILIES.length, 2);
  for (const f of FAMILIES) assert.ok(f.source.startsWith('/'), `familia ${f.id} sem regex declarada`);
});

// --- end-to-end com fixtures benignas ---------------------------------------------

test('E2E: artefacto A com ocorrencia SEM origem -> EXIT.UNRESOLVED e token nunca impresso', () => {
  const base = mkdtempSync(join(tmpdir(), 'artifact-gate-a-'));
  try {
    const token = `sk-${randomBytes(10).toString('hex')}`; // sintetico, aleatorio, benigno
    const asar = makeAsar({ 'index.js': Buffer.from(`const k = "${token}";\n`, 'utf8') });
    const dir = makeCandidate(base, 'cand-A', asar);
    const outJson = join(base, 'a.json');
    const outMd = join(base, 'a.md');
    const r = runCli(['--candidate', dir, '--expect-asar-sha', sha256(asar), '--json', outJson, '--md', outMd]);

    assert.equal(r.status, EXIT.UNRESOLVED, `esperava bloqueio por UNRESOLVED; stderr=${r.stderr}`);
    const json = readFileSync(outJson, 'utf8');
    const md = readFileSync(outMd, 'utf8');
    assert.equal(JSON.parse(json).totals.unresolved, 1);
    assert.equal(JSON.parse(json).artifact.authorityVerified, true);
    assert.ok(!json.includes(token), 'o token em claro NAO pode aparecer no json');
    assert.ok(!md.includes(token), 'o token em claro NAO pode aparecer no md');
    assert.ok(!r.stdout.includes(token), 'o token em claro NAO pode aparecer no stdout');
    assert.match(json, /"isFullSafety": false/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('E2E: artefacto B limpo -> EXIT.OK com metadata REAL de B (A versus B)', () => {
  const base = mkdtempSync(join(tmpdir(), 'artifact-gate-b-'));
  try {
    const asar = makeAsar({ 'index.js': Buffer.from('export const ok = true;\n', 'utf8') });
    const dir = makeCandidate(base, 'cand-B', asar);
    const outJson = join(base, 'b.json');
    const r = runCli(['--candidate', dir, '--expect-asar-sha', sha256(asar), '--json', outJson, '--md', join(base, 'b.md')]);

    assert.equal(r.status, EXIT.OK, `esperava OK; stderr=${r.stderr}`);
    const rep = JSON.parse(readFileSync(outJson, 'utf8'));
    assert.equal(rep.totals.hits, 0);
    assert.equal(rep.totals.unresolved, 0);
    assert.ok(rep.artifact.candidate.endsWith('cand-B'), 'metadata tem de referir a candidata REAL, sem fallback');
    assert.equal(rep.artifact.asarSha256, sha256(asar));
    assert.ok(!rep.artifact.candidate.includes('candidate-20261015-083959-010660bd'), 'sem fallback para a C1');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('E2E: sha errado aborta e NAO escreve outputs', () => {
  const base = mkdtempSync(join(tmpdir(), 'artifact-gate-c-'));
  try {
    const asar = makeAsar({ 'index.js': Buffer.from('x\n', 'utf8') });
    const dir = makeCandidate(base, 'cand-C', asar);
    const outJson = join(base, 'c.json');
    const r = runCli(['--candidate', dir, '--expect-asar-sha', 'c'.repeat(64), '--json', outJson, '--md', join(base, 'c.md')]);

    assert.equal(r.status, EXIT.ARTIFACT, `esperava EXIT.ARTIFACT; stderr=${r.stderr}`);
    assert.equal(existsSync(outJson), false, 'nao pode haver relatorio de um artefacto sem identidade verificada');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('E2E: candidata inexistente aborta com EXIT.ARTIFACT', () => {
  const base = mkdtempSync(join(tmpdir(), 'artifact-gate-d-'));
  try {
    const r = runCli(['--candidate', join(base, 'nao-existe'), '--expect-asar-sha', 'd'.repeat(64), '--json', join(base, 'd.json')]);
    assert.equal(r.status, EXIT.ARTIFACT);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- FP exige PROVA SEMANTICA (proveniencia != nao-credencial) ---------------------
// Correcao do HIGH: "esta numa dependencia" deixou de ser suficiente para declarar
// falso positivo, e a prova de documentacao do PEM passou a ser POR ENTRADA do ASAR
// (nunca uma flag global de um ficheiro do host, que limparia um hit noutro entry).

test('(a) dep com token formato-chave e corrida NAO-publica -> UNRESOLVED', () => {
  const v = verdictFor({
    rule: 'openai-style-sk',
    provenance: { repoSource: [], packagedDeps: ['node_modules/algum-dep/dist/index.js'] },
    context: { enclosingRun: `sk-${randomBytes(16).toString('hex')}`, entryPath: 'node_modules/algum-dep/dist/index.js', publicCssIdentifier: false },
  }, {});
  assert.equal(v.verdict, 'UNRESOLVED', 'dependencia com valor formato-chave nao e falso positivo');
});

test('(a2) prova CSS publica nao se estende a corrida aleatoria no mesmo entry', () => {
  const v = verdictFor({
    rule: 'openai-style-sk',
    provenance: { repoSource: [], packagedDeps: [] },
    context: { enclosingRun: `sk-${randomBytes(16).toString('hex')}`, entryPath: 'node_modules/tailwind-merge/dist/bundle.mjs', publicCssIdentifier: false },
  }, { tailwindMergeVersion: '3.3.1' });
  assert.equal(v.verdict, 'UNRESOLVED');
});

test('(b) PEM com corpo de chave real no ASAR nao e limpo por README benigno do host', () => {
  const v = verdictFor({
    rule: 'private-key-block',
    provenance: { repoSource: [], packagedDeps: [] },
    context: { entryPath: 'node_modules/dotenv/README-es.md', isDocEntry: true, inDocsFence: true, hasKeyBody: true },
  }, { pemDocProven: true, pemDocFile: 'node_modules/dotenv/README-es.md' }); // flag global benigna NAO pode limpar
  assert.equal(v.verdict, 'UNRESOLVED', 'corpo de chave presente => nunca falso positivo');
  assert.match(v.reason, /corpo/i);
});

test('(c) PEM em ficheiro ERRADO do ASAR -> UNRESOLVED', () => {
  const v = verdictFor({
    rule: 'private-key-block',
    provenance: { repoSource: [], packagedDeps: [] },
    context: { entryPath: 'static/js/index-abc.js', isDocEntry: false, inDocsFence: true, hasKeyBody: false },
  }, { pemDocProven: true });
  assert.equal(v.verdict, 'UNRESOLVED', 'fence de docs noutro ficheiro nao autoriza este entry');
});

test('(c2) PEM no proprio README mas FORA de bloco de codigo -> UNRESOLVED', () => {
  const v = verdictFor({
    rule: 'private-key-block',
    provenance: { repoSource: [], packagedDeps: [] },
    context: { entryPath: 'node_modules/dotenv/README-es.md', isDocEntry: true, inDocsFence: false, hasKeyBody: false },
  }, {});
  assert.equal(v.verdict, 'UNRESOLVED');
});

test('(d) PRESERVADO: exemplo no proprio README empacotado, em fence, sem corpo -> FP', () => {
  const v = verdictFor({
    rule: 'private-key-block',
    provenance: { repoSource: [], packagedDeps: [] },
    context: { entryPath: 'node_modules/dotenv/README-es.md', isDocEntry: true, inDocsFence: true, hasKeyBody: false },
  }, {});
  assert.equal(v.verdict, 'FALSE_POSITIVE_PROVEN');
  assert.match(v.origin, /dotenv/);
});

test('(d2) PRESERVADO: identificador CSS publico mask-* com tailwind-merge real -> FP', () => {
  const v = verdictFor({
    rule: 'openai-style-sk',
    provenance: { repoSource: [], packagedDeps: ['node_modules/tailwind-merge/dist/bundle.mjs'] },
    context: { enclosingRun: 'mask-radial-from-color', entryPath: 'static/css/index.css', publicCssIdentifier: true },
  }, { tailwindMergeVersion: '3.3.1' });
  assert.equal(v.verdict, 'FALSE_POSITIVE_PROVEN');
  assert.match(v.origin, /tailwind-merge@3\.3\.1/);
});

test('(d3) mask-* SEM versao real de tailwind-merge -> UNRESOLVED (prova incompleta)', () => {
  const v = verdictFor({
    rule: 'openai-style-sk',
    provenance: { repoSource: [], packagedDeps: [] },
    context: { enclosingRun: 'mask-radial-from-color', entryPath: 'static/css/index.css', publicCssIdentifier: true },
  }, {});
  assert.equal(v.verdict, 'UNRESOLVED');
});

test('E2E: PEM com corpo de chave real -> EXIT.UNRESOLVED e corpo nunca impresso', () => {
  const base = mkdtempSync(join(tmpdir(), 'artifact-gate-pem-'));
  try {
    const body = randomBytes(64).toString('base64'); // sintetico, aleatorio, benigno
    const content = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
    const asar = makeAsar({ 'node_modules/dotenv/README-es.md': Buffer.from(content, 'utf8') });
    const dir = makeCandidate(base, 'cand-PEM', asar);
    const outJson = join(base, 'pem.json');
    const outMd = join(base, 'pem.md');
    const r = runCli(['--candidate', dir, '--expect-asar-sha', sha256(asar), '--json', outJson, '--md', outMd]);

    assert.equal(r.status, EXIT.UNRESOLVED, `corpo de chave real tem de bloquear; stderr=${r.stderr}`);
    const json = readFileSync(outJson, 'utf8');
    assert.ok(!json.includes(body), 'o corpo da chave nunca pode ser impresso');
    assert.ok(!readFileSync(outMd, 'utf8').includes(body));
    assert.ok(!r.stdout.includes(body));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('E2E: cabecalho PEM fora de documentacao (sem corpo) -> EXIT.UNRESOLVED', () => {
  const base = mkdtempSync(join(tmpdir(), 'artifact-gate-pem2-'));
  try {
    const asar = makeAsar({ 'static/js/index-abc.js': Buffer.from('const p = "-----BEGIN PRIVATE KEY-----";\n', 'utf8') });
    const dir = makeCandidate(base, 'cand-PEM2', asar);
    const r = runCli(['--candidate', dir, '--expect-asar-sha', sha256(asar), '--json', join(base, 'p2.json'), '--md', join(base, 'p2.md')]);
    assert.equal(r.status, EXIT.UNRESOLVED, `stderr=${r.stderr}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- PRIVACIDADE: proveniencia restrita a fontes de runtime ------------------------
// Uma versao anterior varria o repo inteiro: 684 ficheiros indexados, 485 fora do
// codigo de runtime, incluindo `.qoder/settings.local.json`, `.claude/agents/**` e
// `.aider.chat.history.md`. Estes testes prendem a allowlist.

test('(e) proveniencia: aceita fontes de runtime em packages/*/src', () => {
  for (const f of ['packages/app/src/App.tsx', 'packages/desktop/src/main.ts', 'packages/core/src/scan.ts', 'packages/app/src/styles/theme.css']) {
    assert.equal(isProvenanceSource(f), true, `${f} devia ser fonte de proveniencia`);
  }
});

test('(e2) proveniencia: agentes/credenciais/backups/configs/testes NUNCA entram', () => {
  const proibidos = [
    '.qoder/settings.local.json',
    '.claude/agents/x.md',
    '.aider.chat.history.md',
    '.maestri/state/key.json',
    'opencode.json',
    'package.json',
    'package-lock.json',
    'packages/app/package.json',
    'backups/x/creds.ts',
    'credentials/aws.ts',
    'secrets/token.ts',
    'docs/ai-map/05-CURRENT-STATE.md',
    'scripts/test/x.mjs',
    'packages/app/test/fixture.test.ts',
    'packages/app/src/__tests__/a.ts',
    'packages/app/src/fixtures/k.ts',
    'packages/app/src/specs/b.ts',
    'boxes/credentials/a.ts',
    'packages/app/src/logo.png',
  ];
  for (const f of proibidos) assert.equal(isProvenanceSource(f), false, `${f} NAO pode entrar na proveniencia`);
});

test('(e3) proveniencia: o indice real so contem caminhos do allowlist', () => {
  const idx = buildSourceIndex();
  assert.ok(idx.length > 0, 'o repo tem fontes de runtime');
  const fora = idx.filter((e) => !/^packages\/[^/]+\/src\//.test(e.f)).map((e) => e.f);
  assert.deepEqual(fora, [], 'nada fora de packages/*/src');
  const ocultos = idx.filter((e) => e.f.split('/').some((s) => s.startsWith('.'))).map((e) => e.f);
  assert.deepEqual(ocultos, [], 'nenhum diretorio oculto/agente pode ser indexado');
  const suspeitos = idx.filter((e) => e.f.split('/').some((s) => ['test', 'tests', '__tests__', 'fixtures', 'backups', 'credentials'].includes(s.toLowerCase()))).map((e) => e.f);
  assert.deepEqual(suspeitos, [], 'testes/fixtures/credenciais ficam fora da proveniencia');
});
