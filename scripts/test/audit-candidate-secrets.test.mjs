/**
 * TESTES SINTÉTICOS DO GATE DE SEGREDOS DA CANDIDATA (scripts/audit-candidate-secrets.mjs).
 *
 * Um gate que só diz "OK" não está provado — passa porque ninguém olha. Estes
 * testes usam um artefacto SINTÉTICO (uma candidata falsa construída em tmp) e
 * provam três coisas, sem tocar em nenhum valor real:
 *
 *   1. SENTIDO (deteta segredo plantado): um valor não-placeholder plantado nos
 *      bytes do ASAR/unpacked tem de dar match e o processo tem de sair != 0.
 *   2. NÃO-PLACEBO: um valor claramente placeholder, MESMO plantado nos bytes,
 *      não pode ser reportado como exposição (senão o gate grita por ruído).
 *   3. NÃO-FUGA: o JSON e o Markdown de saída não podem conter o valor, o seu
 *      prefixo (8) nem o seu sufixo (8). A guarda interna é testada nos dois
 *      sentidos (bite quando há fuga, silêncio quando não há).
 *
 * Uso: node --test scripts/test/audit-candidate-secrets.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'audit-candidate-secrets.mjs');
const MOD = path.resolve(HERE, '..', 'audit-candidate-secrets.mjs');

const {
  parseEnvText, isPlaceholder, isComparableValue, classifyKey, deriveNeedles,
  findOffsets, readAsar, asarLocationForOffset, detectLeaks, buildHaystacks,
  compareEntriesToHaystacks,
} = await import(url.pathToFileURL(MOD).href);

// --- valores sintéticos (nunca são segredos reais) --------------------------
const PLANTED = 'SynthPlanted-' + 'aB3xY9kLm2Qp7Rt5Wz8Nc4Vd1Fg6Hj0K';  // valor exato plantado
const PLACEBO = 'your-placeholder-change-me-please-1234567890';        // placeholder (não pode alarmar)
const EXTRACT_ONLY = 'SynthSeg::' + 'QwErTyUiOp1234567890AsDfGh';      // só o segmento é plantado

function buildAsar(fileMap) {
  const parts = []; let off = 0; const files = {};
  for (const [name, buf] of Object.entries(fileMap)) {
    files[name] = { size: buf.length, offset: String(off) };
    parts.push(buf); off += buf.length;
  }
  const json = Buffer.from(JSON.stringify({ files }), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const data = Buffer.concat(parts);
  const out = Buffer.alloc(16 + json.length + pad + data.length);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(json.length + 11, 4);
  out.writeUInt32LE(json.length, 12);
  json.copy(out, 16);
  data.copy(out, 16 + json.length + pad);
  return out;
}

function makeFixture(tmp, { plant, plantPlacebo, extractOnly }) {
  const repo = path.join(tmp, 'repo');
  const api = path.join(repo, 'packages', 'api');
  fs.mkdirSync(api, { recursive: true });
  const env = [
    '# syntheitc',
    `SYNTH_PLANTED_KEY=${plant ? PLANTED : 'not-planted-anywhere-000000000000'}`,
    `SYNTH_PLACEBO_KEY=${plantPlacebo ? PLACEBO : 'also-not-present-00000000000'}`,
    `SYNTH_EXTRACT_KEY=${extractOnly ? EXTRACT_ONLY : 'no-segment-planted-000000000'}`,
    'NODE_ENV=production',
    'PORT=4180',
  ].join('\n');
  fs.writeFileSync(path.join(repo, '.env'), env + '\n');
  fs.writeFileSync(path.join(api, '.env'), 'API_SYNTH_TOKEN=' + PLANTED + '\n');
  fs.writeFileSync(path.join(api, '.env.backup-synth'), 'BACKUP_SYNTH_SECRET=' + PLANTED + '\n');

  const candidate = path.join(tmp, 'candidate-20261015-synth');
  const resources = path.join(candidate, 'win-unpacked', 'resources');
  const unpacked = path.join(resources, 'app.asar.unpacked');
  fs.mkdirSync(unpacked, { recursive: true });
  fs.writeFileSync(path.join(candidate, 'CyberSafe-synth-setup.exe'), Buffer.from('MZ-synth-installer-bytes'));

  const inner = [];
  if (plant) inner.push('const k = "' + PLANTED + '";');
  if (plantPlacebo) inner.push('const p = "' + PLACEBO + '";');
  if (extractOnly) inner.push('const s = "' + 'QwErTyUiOp1234567890AsDfGh' + '";');
  inner.push('module.exports = {};');
  const asar = buildAsar({ 'dist/main.js': Buffer.from(inner.join('\n')) });
  fs.writeFileSync(path.join(resources, 'app.asar'), asar);
  fs.writeFileSync(path.join(unpacked, 'extra.cjs'), plant ? PLANTED : 'nothing here');
  return { repo, candidate };
}

function runGate(args) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 });
    return { code: 0, stdout: out };
  } catch (e) {
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cybersafe-gate-synth-'));
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

describe('gate de segredos da candidata — unidade', () => {
  it('parseEnvText lê KEY=VALUE, export, aspas e comentário inline', () => {
    const e = parseEnvText('A=1\nexport B="dois"\nC=três # nota\n# D=4\n');
    assert.deepEqual(e.map((x) => x.key), ['A', 'B', 'C']);
    assert.equal(e[1].value, 'dois');
    assert.equal(e[2].value, 'três');
  });

  it('isPlaceholder distingue placeholder de valor real', () => {
    assert.equal(isPlaceholder('your-api-key-here'), true);
    assert.equal(isPlaceholder('<TOKEN>'), true);
    assert.equal(isPlaceholder('changeme'), true);
    assert.equal(isPlaceholder('SOME_ENV_VAR_NAME'), true); // referência a constante
    assert.equal(isPlaceholder(PLANTED), false);
    assert.equal(isComparableValue('true'), false);
    assert.equal(isComparableValue(PLANTED), true);
  });

  it('classifyKey separa CREDENTIAL de CONFIG', () => {
    assert.equal(classifyKey('OPENAI_API_KEY'), 'CREDENTIAL');
    assert.equal(classifyKey('DB_PASSWORD'), 'CREDENTIAL');
    assert.equal(classifyKey('NODE_ENV'), 'CONFIG');
    assert.equal(classifyKey('PORT'), 'CONFIG');
  });

  it('deriveNeedles gera valor exato + segmentos >= 16', () => {
    const n = deriveNeedles(EXTRACT_ONLY);
    assert.equal(n.exact, EXTRACT_ONLY);
    assert.ok(n.segments.includes('QwErTyUiOp1234567890AsDfGh'));
    assert.equal(deriveNeedles('short').exact, null);
  });

  it('findOffsets encontra ocorrências e respeita o cap', () => {
    const hay = Buffer.from('xxNEEDLExxNEEDLExx');
    assert.deepEqual(findOffsets(hay, 'NEEDLE'), [2, 10]);
    assert.equal(findOffsets(hay, 'NEEDLE', 1).length, 1);
  });

  it('readAsar + asarLocationForOffset mapeiam offset para caminho interno', () => {
    const asar = buildAsar({ 'a/one.js': Buffer.from('AAAA'), 'b/two.js': Buffer.from('BBBBBBB') });
    const p = path.join(tmp, 'roundtrip.asar');
    fs.writeFileSync(p, asar);
    const parsed = readAsar(p);
    assert.equal(parsed.entries.length, 2);
    const off = findOffsets(parsed.buf, 'BBBBBBB')[0];
    assert.equal(asarLocationForOffset(parsed, off), 'b/two.js');
  });

  it('detectLeaks BITE quando o valor está presente e fica silencioso quando não está', () => {
    const leaks = detectLeaks('texto com ' + PLANTED + ' dentro', [PLANTED]);
    assert.equal(leaks.length, 1);
    assert.equal(leaks[0].kind, 'full-value');
    assert.equal(detectLeaks('texto limpo sem nada', [PLANTED]).length, 0);
    // prefixo/sufixo também contam como fuga
    assert.equal(detectLeaks('pref=' + PLANTED.slice(0, 10), [PLANTED]).length, 1);
  });

  it('guarda anti-fuga NÃO devolve o valor em claro (id não reversível)', () => {
    const leaks = detectLeaks('v=' + PLANTED, [PLANTED]);
    assert.ok(!JSON.stringify(leaks).includes(PLANTED));
    assert.ok(!JSON.stringify(leaks).includes(PLANTED.slice(0, 8)));
  });
});

describe('gate de segredos da candidata — ponta-a-ponta (fixture sintética)', () => {
  it('deteta o valor plantado (EXACT) e sai != 0', () => {
    const t = fs.mkdtempSync(path.join(tmp, 'plant-'));
    const fx = makeFixture(t, { plant: true, plantPlacebo: true, extractOnly: false });
    const outJson = path.join(t, 'out.json');
    const outMd = path.join(t, 'out.md');
    const r = runGate(['--root', fx.repo, '--candidate', fx.candidate, '--json', outJson, '--md', outMd]);
    assert.equal(r.code, 10, 'exposição de credencial deve dar exit 10');
    const rep = JSON.parse(fs.readFileSync(outJson, 'utf8'));
    assert.ok(rep.totals.credentialValuesExposedInArtifact >= 1);
    const hit = rep.matches.find((m) => m.key === 'SYNTH_PLANTED_KEY');
    assert.ok(hit && hit.exposed, 'SYNTH_PLANTED_KEY devia estar exposto');
    assert.equal(hit.matches[0].matchType, 'EXACT');
    assert.ok(hit.matches.some((m) => m.kind === 'asar'), 'devia localizar no asar');
    assert.ok(hit.matches.some((m) => m.kind === 'unpacked'), 'devia localizar no unpacked');
  });

  it('NÃO alarme por placeholder, mesmo plantado nos bytes (anti-placebo)', () => {
    const t = fs.mkdtempSync(path.join(tmp, 'placebo-'));
    const f = makeFixture(t, { plant: false, plantPlacebo: true, extractOnly: false });
    const outJson = path.join(t, 'out.json');
    const r = runGate(['--root', f.repo, '--candidate', f.candidate, '--json', outJson, '--md', path.join(t, 'out.md')]);
    // o placeholder está nos bytes do artefacto, mas não pode ser exposição
    assert.equal(r.code, 0, 'sem valores reais plantados, o gate não pode alarmar');
    const rep = JSON.parse(fs.readFileSync(outJson, 'utf8'));
    // o placeholder é registado em `examined` como não-comparável e NUNCA entra em `matches`
    const placebo = rep.examined.find((m) => m.key === 'SYNTH_PLACEBO_KEY');
    assert.ok(placebo, 'a chave sintética existe nos examinados');
    assert.equal(placebo.comparable, false, 'placeholder não é valor comparável');
    assert.equal(placebo.fingerprint, null);
    assert.ok(!rep.matches.some((m) => m.key === 'SYNTH_PLACEBO_KEY'), 'placeholder não pode estar em matches');
    assert.equal(rep.totals.credentialValuesExposedInArtifact, 0);
    assert.equal(rep.totals.exactMatches, 0);
  });

  it('deteta segmento extraído quando só parte do valor está no artefacto (EXTRACT)', () => {
    const t = fs.mkdtempSync(path.join(tmp, 'extract-'));
    const f = makeFixture(t, { plant: false, plantPlacebo: false, extractOnly: true });
    const outJson = path.join(t, 'out.json');
    const r = runGate(['--root', f.repo, '--candidate', f.candidate, '--json', outJson, '--md', path.join(t, 'out.md')]);
    assert.equal(r.code, 10);
    const rep = JSON.parse(fs.readFileSync(outJson, 'utf8'));
    const hit = rep.matches.find((m) => m.key === 'SYNTH_EXTRACT_KEY');
    assert.ok(hit && hit.exposed, 'o segmento plantado devia dar match');
    assert.equal(hit.matches[0].matchType, 'EXTRACT');
  });

  it('artefacto limpo → exit 0 e zero credenciais expostas', () => {
    const t = fs.mkdtempSync(path.join(tmp, 'clean-'));
    const f = makeFixture(t, { plant: false, plantPlacebo: false, extractOnly: false });
    const outJson = path.join(t, 'out.json');
    const r = runGate(['--root', f.repo, '--candidate', f.candidate, '--json', outJson, '--md', path.join(t, 'out.md')]);
    assert.equal(r.code, 0);
    const rep = JSON.parse(fs.readFileSync(outJson, 'utf8'));
    assert.equal(rep.totals.credentialValuesExposedInArtifact, 0);
    assert.equal(rep.networkCalls, 0);
  });

  it('--expect-sha errado aborta (não compara artefacto errado)', () => {
    const t = fs.mkdtempSync(path.join(tmp, 'sha-'));
    const f = makeFixture(t, { plant: true, plantPlacebo: false, extractOnly: false });
    const r = runGate(['--root', f.repo, '--candidate', f.candidate, '--expect-sha', 'deadbeef'.repeat(8), '--json', path.join(t, 'o.json'), '--md', path.join(t, 'o.md')]);
    assert.equal(r.code, 3);
    assert.ok(/nao corresponde/.test(r.stderr));
  });

  it('o output (JSON + MD) NÃO contém valor, prefixo nem sufixo', () => {
    const t = fs.mkdtempSync(path.join(tmp, 'leak-'));
    const f = makeFixture(t, { plant: true, plantPlacebo: true, extractOnly: true });
    const outJson = path.join(t, 'out.json');
    const outMd = path.join(t, 'out.md');
    const r = runGate(['--root', f.repo, '--candidate', f.candidate, '--json', outJson, '--md', outMd]);
    assert.equal(r.code, 10);
    const json = fs.readFileSync(outJson, 'utf8');
    const md = fs.readFileSync(outMd, 'utf8');
    const seg = 'QwErTyUiOp1234567890AsDfGh';
    for (const secret of [PLANTED, PLACEBO, EXTRACT_ONLY, seg]) {
      for (const [name, text] of [['json', json], ['md', md]]) {
        assert.ok(!text.includes(secret), `${name} não pode conter o valor`);
        assert.ok(!text.includes(secret.slice(0, 8)), `${name} não pode conter o prefixo`);
        assert.ok(!text.includes(secret.slice(-8)), `${name} não pode conter o sufixo`);
      }
    }
    // mas tem de conter a chave + o fingerprint (prova que audita, sem expor)
    assert.ok(json.includes('SYNTH_PLANTED_KEY'));
    assert.ok(!json.includes(PLANTED));
    assert.ok(r.stdout.includes('guarda anti-fuga: OK'), 'stdout confirma a guarda');
  });
});
