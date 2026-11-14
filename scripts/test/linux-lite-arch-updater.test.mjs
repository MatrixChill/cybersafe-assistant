import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkForUpdate, compareVersions, downloadUpdate, installPlan, loadChannelConfig, parseVersion, validateManifest,
} from '../linux-lite/arch/updater.mjs';

// Chaves efémeras, só em memória durante o teste: nenhuma chave entra no repositório.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const BASE = 'https://github.com/MatrixChill/cybersafe-assistant/releases/download/linux-update-channel';
const PKG = Buffer.from('conteudo-de-pacote-sintetico-'.repeat(1000));
const SHA = createHash('sha256').update(PKG).digest('hex');

function manifest(over = {}) {
  return {
    schema: 1, package: 'cybersafe-assistant-linux-lite', channel: 'experimental', arch: 'x86_64',
    version: '0.2.5', pkgrel: 1,
    url: `${BASE.replace('linux-update-channel', 'linux-v0.2.5-arch-preview.1')}/cybersafe-assistant-linux-lite-0.2.5-1-x86_64.pkg.tar.zst`,
    size: PKG.length, sha256: SHA, notes: 'Correções Linux.', publishedAt: '2026-11-14T12:00:00Z', ...over,
  };
}

function fakeFetch({ m = manifest(), key = privateKey, tamper = false, pkg = PKG, rangeSupported = true, failAfter = null } = {}) {
  const bytes = Buffer.from(JSON.stringify(m));
  const sig = sign(null, bytes, key).toString('base64');
  const served = tamper ? Buffer.from(JSON.stringify({ ...m, sha256: 'f'.repeat(64) })) : bytes;
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {} });
    if (url.endsWith('/manifest-experimental.json')) return new Response(served);
    if (url.endsWith('/manifest-experimental.json.sig')) return new Response(sig);
    if (url === m.url) {
      const range = init.headers?.Range;
      let start = 0;
      if (range && rangeSupported) start = Number(/bytes=(\d+)-/.exec(range)[1]);
      let body = pkg.subarray(start);
      if (failAfter !== null) {
        const half = body.subarray(0, failAfter);
        // Entrega metade e só depois falha (error() no start descartaria a fila).
        let sent = false;
        const stream = new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(half); } else c.error(new Error('reset')); } });
        return new Response(stream, { status: 200 });
      }
      return new Response(body, { status: range && rangeSupported ? 206 : 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return { impl, calls };
}

const config = { manifestBase: BASE, publicKeys: [PUB] };
const v = (s) => parseVersion(s);

test('versões: pkgrel conta e a comparação é numérica', () => {
  assert.equal(compareVersions(v('0.2.10-1'), v('0.2.9-3')), 1);
  assert.equal(compareVersions(v('0.2.4-1'), v('0.2.4-2')), -1);
  assert.equal(parseVersion('0.2.4-beta'), null);
});

test('sem chave pública configurada o canal fica not-configured e nada é pedido', async () => {
  const { impl, calls } = fakeFetch();
  const r = await checkForUpdate({ installed: v('0.2.4-1'), channel: 'experimental', config: { manifestBase: BASE, publicKeys: [] }, fetchImpl: impl });
  assert.equal(r.state, 'not-configured');
  assert.equal(calls.length, 0);
  // A chave incorporada no pacote é exatamente uma chave pública Ed25519 (nunca privada).
  const embedded = loadChannelConfig();
  assert.equal(embedded.publicKeys.length, 1);
  assert.doesNotMatch(embedded.publicKeys[0], /PRIVATE/);
  assert.equal(createPublicKey(embedded.publicKeys[0]).asymmetricKeyType, 'ed25519');
});

test('manifesto assinado com versão maior → available, com notas, tamanho e assinatura verificada', async () => {
  const r = await checkForUpdate({ installed: v('0.2.4-1'), channel: 'experimental', config, fetchImpl: fakeFetch().impl });
  assert.equal(r.state, 'available');
  assert.equal(r.available.version, '0.2.5-1');
  assert.equal(r.available.size, PKG.length);
  assert.equal(r.available.signature, 'ed25519-verified');
  assert.equal(r.available.notes, 'Correções Linux.');
});

test('assinatura de outra chave ou manifesto adulterado → invalid', async () => {
  const wrong = await checkForUpdate({ installed: v('0.2.4-1'), channel: 'experimental', config, fetchImpl: fakeFetch({ key: other.privateKey }).impl });
  assert.equal(wrong.state, 'invalid');
  assert.equal(wrong.reason, 'signature');
  const tampered = await checkForUpdate({ installed: v('0.2.4-1'), channel: 'experimental', config, fetchImpl: fakeFetch({ tamper: true }).impl });
  assert.equal(tampered.reason, 'signature');
});

test('downgrade e versão igual não são oferecidos; canal trocado é recusado', async () => {
  assert.equal((await checkForUpdate({ installed: v('0.2.6-1'), channel: 'experimental', config, fetchImpl: fakeFetch().impl })).state, 'downgrade-refused');
  assert.equal((await checkForUpdate({ installed: v('0.2.5-1'), channel: 'experimental', config, fetchImpl: fakeFetch().impl })).state, 'up-to-date');
  const r = await checkForUpdate({ installed: v('0.2.4-1'), channel: 'experimental', config, fetchImpl: fakeFetch({ m: manifest({ channel: 'stable' }) }).impl });
  assert.equal(r.reason, 'channel-mismatch');
});

test('manifesto: host fora da lista, http e nome de ficheiro incoerente são recusados', () => {
  assert.equal(validateManifest(manifest({ url: 'https://evil.example/cybersafe-assistant-linux-lite-0.2.5-1-x86_64.pkg.tar.zst' })).reason, 'url-host');
  assert.equal(validateManifest(manifest({ url: manifest().url.replace('https:', 'http:') })).reason, 'url-host');
  assert.equal(validateManifest(manifest({ version: '0.2.6' })).reason, 'filename');
  assert.equal(validateManifest(manifest({ sha256: 'abc' })).reason, 'sha256');
});

test('download: verifica SHA-256, reutiliza o ficheiro já verificado e não duplica', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-upd-'));
  try {
    const { available } = await checkForUpdate({ installed: v('0.2.4-1'), channel: 'experimental', config, fetchImpl: fakeFetch().impl });
    const f = fakeFetch();
    const first = await downloadUpdate({ available, cacheDir: dir, fetchImpl: f.impl });
    assert.equal(first.state, 'verified');
    assert.deepEqual(readFileSync(first.file), PKG);
    const again = await downloadUpdate({ available, cacheDir: dir, fetchImpl: f.impl });
    assert.equal(again.reused, true);
    assert.equal(f.calls.filter((c) => c.url === available.url).length, 1, 'sem segundo download');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('download interrompido retoma com Range; conteúdo errado é apagado', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-upd-'));
  try {
    const { available } = await checkForUpdate({ installed: v('0.2.4-1'), channel: 'experimental', config, fetchImpl: fakeFetch().impl });
    const cut = await downloadUpdate({ available, cacheDir: dir, fetchImpl: fakeFetch({ failAfter: 5000 }).impl });
    assert.equal(cut.state, 'error');
    assert.equal(cut.resumable, true);
    const f = fakeFetch();
    const resumed = await downloadUpdate({ available, cacheDir: dir, fetchImpl: f.impl });
    assert.equal(resumed.state, 'verified');
    assert.match(f.calls.at(-1).headers.Range, /^bytes=5000-$/);
    assert.deepEqual(readFileSync(resumed.file), PKG);

    const dir2 = mkdtempSync(join(tmpdir(), 'cs-upd-'));
    const bad = Buffer.from(PKG); bad[10] ^= 1;
    const r = await downloadUpdate({ available, cacheDir: dir2, fetchImpl: fakeFetch({ pkg: bad }).impl });
    assert.equal(r.reason, 'sha256');
    assert.equal(existsSync(join(dir2, `${available.file}.part`)), false, 'parcial inválido limpo');
    rmSync(dir2, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('instalação: exige consentimento, utilizador normal e o mesmo SHA-256; só pkexec pacman -U', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-upd-'));
  try {
    const file = join(dir, 'cybersafe-assistant-linux-lite-0.2.5-1-x86_64.pkg.tar.zst');
    writeFileSync(file, PKG);
    assert.equal((await installPlan({ file, expectedSha256: SHA, consent: false, uid: 1000 })).error, 'consent-required');
    assert.equal((await installPlan({ file, expectedSha256: SHA, consent: true, uid: 0 })).error, 'run-as-user');
    assert.equal((await installPlan({ file, expectedSha256: 'a'.repeat(64), consent: true, uid: 1000 })).error, 'sha256');
    const plan = await installPlan({ file, expectedSha256: SHA, consent: true, uid: 1000 });
    assert.deepEqual(plan.argv.slice(0, 3), ['pkexec', 'pacman', '-U']);
    assert.equal(plan.argv.some((a) => /noconfirm|SigLevel/i.test(a)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canal sem manifesto publicado (404) → no-release, não erro', async () => {
  const impl = async () => new Response('not found', { status: 404 });
  const r = await checkForUpdate({ installed: v('0.2.4-2'), channel: 'stable', config, fetchImpl: impl });
  assert.equal(r.state, 'no-release');
});
