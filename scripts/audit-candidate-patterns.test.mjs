// Testes próprios do auditor de padrões (scripts/audit-candidate-patterns.mjs v2) — EXPERIMENTAL / NAO USAR (15/10): acompanha auditor corrompido por patch de shell; ultima execucao conhecida 6/7; reparacoes NEGADAS; NAO usar como gate.
// Propriedades exigidas pelo review do titular 15/10:
//  1. NAO-OCULTACAO: chave sintética com corpo >=30 concatenada a prefixo alfanumérico (vizinhança
//     hostil) NUNCA e suprimida — vai sempre para CREDENTIAL_SHAPE_FOR_HUMAN_COMPARE.
//  2. SEM PSEUDO-PASS: run curto sem proveniancia fica UNRESOLVED; so a igualdade byte-a-byte com a
//     fonte local (node_modules/packages) permite classificar como conteudo legitimo.
//  3. PEM: header isolado sem corpo e UNRESOLVED; header COM corpo base64 adjacente escala a humano.
//  4. REDACTION: nenhum byte correspondido, literal PEM ou corpo de chave aparece no output JSON.
// Todos os valores sao SINTETICOS de teste.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { auditArchive, classify, listAsarEntries, rightRun } from './audit-candidate-patterns.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const KEY_BODY = 'M'.repeat(20) + 'K'.repeat(20) + '9'; // 41 — corpo real-plausivel, sintetico
const CONCAT_KEY = 'x9' + 'sk-' + KEY_BODY; // nasce colado a um identificador (vizinhanca hostil)
const SHORT_RUN = 'blob1234sk-Ab3dEfBBxxYYccDD'; // corpo ~18, dentro de blob maior
const PEM_ONLY = 'example: "-----BEGIN OPENSSH PRIVATE KEY-----"';
const PEM_WITH_BODY = '-----BEGIN RSA PRIVATE KEY-----\n' + 'QWJjZGVmZ2hpams=' + '\nmore';

async function fixture(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap2-'));
  const src = path.join(dir, 'src');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(src, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const archive = path.join(dir, 'app.asar');
  await asar.createPackage(src, archive);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, archive };
}

test('NAO-OCULTACAO: chave concatenada com corpo >=30 escapa a CREDENTIAL_SHAPE mesmo com vizinhanca alfanumerica', async (t) => {
  const { archive, dir } = await fixture(t, { 'dist/a.js': `var i="${CONCAT_KEY}";` });
  const r = auditArchive(archive, dir, { noProvenance: true });
  const sk = r.hits.filter((h) => h.rule === 'openai-style-sk');
  assert.equal(sk.length, 1);
  assert.equal(sk[0].classification, 'CREDENTIAL_SHAPE_FOR_HUMAN_COMPARE');
  assert.equal(sk[0].neighborBefore, 'ALNUM/B64', 'a adjacentia hostil fica registada mas NAO suprime');
  assert.ok(sk[0].bodyRun >= 33);
});

test('SEM PSEUDO-PASS: run curto sem proveniancia fica UNRESOLVED_CURTO (nao e benigno por heuristica)', async (t) => {
  const { archive, dir } = await fixture(t, { 'dist/b.js': `var t="${SHORT_RUN}q";` });
  const r = auditArchive(archive, dir, { noProvenance: true });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].classification, 'UNRESOLVED_CURTO');
});

test('PROVENIANCIA: o mesmo run curto presente na fonte local sobe a CONTEUDO_LEGITIMO_PROVENIENCIA com pkg+offset', async (t) => {
  const { archive, dir } = await fixture(t, { 'dist/c.js': `var t="${SHORT_RUN}q";` });
  const provRoot = path.join(dir, 'provsrc');
  fs.mkdirSync(provRoot, { recursive: true });
  fs.writeFileSync(path.join(provRoot, 'orig.js'), 'prefixo ' + SHORT_RUN + ' sufixo');
  const r = auditArchive(archive, dir, { provenanceRoots: [provRoot] });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].classification, 'CONTEUDO_LEGITIMO_PROVENIENCIA');
  assert.ok(r.hits[0].provenance.localFile.includes('orig.js'));
  assert.equal(typeof r.hits[0].provenance.offsetInLocal, 'number');
});

test('PEM: header isolado UNRESOLVED; header com corpo base64 adjacente escala a humano', async (t) => {
  const { archive, dir } = await fixture(t, { 'dist/d.txt': PEM_ONLY + '\n' + JSON.stringify(PEM_WITH_BODY) });
  const r = auditArchive(archive, dir, { noProvenance: true });
  const pems = r.hits.filter((h) => h.rule === 'private-key-block');
  assert.equal(pems.length, 2);
  assert.deepEqual(pems.map((p) => p.classification).sort(), ['CREDENTIAL_SHAPE_FOR_HUMAN_COMPARE', 'UNRESOLVED_PEM_HEADER_ONLY']);
});

test('REDACTION: output nao contem corpo de chave nem literal PEM nem texto correspondido', async (t) => {
  const { archive, dir } = await fixture(t, { 'dist/e.js': `k="${CONCAT_KEY}"; doc="${PEM_ONLY}"; b=${JSON.stringify(PEM_WITH_BODY)};` });
  const r = auditArchive(archive, dir, { noProvenance: true });
  const json = JSON.stringify(r);
  assert.ok(!json.includes(KEY_BODY), 'corpo plantado nao ecoado');
  assert.ok(!json.includes('sk-'), 'nem o prefixo literal sk- aparece no output');
  assert.ok(!json.includes('BEGIN'), 'nem o literal PEM aparece no output');
  assert.ok(!json.includes('QWJjZGVmZ2hpams'), 'nem o corpo b64 do PEM');
  assert.ok(r.hits.every((h) => h.fingerprint && h.fingerprint.length === 10));
});

test('rightRun/classify unitarios: corpo maximal e o criterio, nunca a adjacencia', () => {
  const b1 = Buffer.from('x' + CONCAT_KEY + '"', 'latin1');
  assert.equal(classify('openai-style-sk', b1, 1, CONCAT_KEY.length).cls, 'CREDENTIAL_SHAPE_FOR_HUMAN_COMPARE');
  const b2 = Buffer.from('"' + SHORT_RUN + '"', 'latin1');
  assert.equal(classify('openai-style-sk', b2, 1, SHORT_RUN.length - 1).cls, 'UNRESOLVED_CURTO');
  assert.equal(rightRun(Buffer.from('sk-ABC def', 'latin1'), 0), 7);
});

test('offsets asar: listAsarEntries == extractFile (atribuicao confiavel)', async (t) => {
  const { archive, dir } = await fixture(t, { 'f1.txt': 'AAA', 'sub/f2.txt': 'BBBBBBBB' });
  const { entries, dataStart } = listAsarEntries(archive);
  const raw = fs.readFileSync(archive);
  for (const e of entries) {
    assert.ok(raw.subarray(dataStart + e.offset, dataStart + e.offset + e.size).equals(asar.extractFile(archive, e.path)), e.path);
  }
});
