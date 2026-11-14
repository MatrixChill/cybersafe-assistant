#!/usr/bin/node
// Atualizador da aplicação CyberSafe Linux (Arch/pacman).
//
// Separado do atualizador Windows e das atualizações de assinaturas.
// Garantias:
//  - o manifesto só vale com assinatura Ed25519 de uma chave pública incorporada
//    (`update-channel.json`); sem chave configurada o canal fica "not-configured"
//    e nada é descarregado — o SHA-256 vem DO manifesto assinado, não de uma
//    página ao lado do ficheiro;
//  - downgrades e versões de outro canal são recusados;
//  - o download vai para uma cache do utilizador, retoma com Range quando o
//    servidor o permite, e só é promovido depois de tamanho + SHA-256 baterem;
//  - a instalação é sempre explícita: `install --consent` corre
//    `pkexec pacman -U <ficheiro verificado>`; o polkit pede a autorização e o
//    pacman aplica as suas próprias verificações. Nunca corre como root, nunca
//    usa shell, nunca `--noconfirm` nem desativa assinaturas do pacman.
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE_NAME = 'cybersafe-assistant-linux-lite';
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const FILE_RE = /^cybersafe-assistant-linux-lite-(\d+\.\d+\.\d+)-(\d+)-x86_64\.pkg\.tar\.zst$/;

// ── Versões ──────────────────────────────────────────────────────────────
export function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pkgrel: m[4] === undefined ? 1 : +m[4] };
}
export function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch', 'pkgrel']) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  return 0;
}
export const formatVersion = (v) => `${v.major}.${v.minor}.${v.patch}-${v.pkgrel}`;

// ── Manifesto ────────────────────────────────────────────────────────────
export function validateManifest(m) {
  const fail = (reason) => ({ ok: false, reason });
  if (!m || typeof m !== 'object' || Array.isArray(m)) return fail('not-an-object');
  if (m.schema !== 1) return fail('schema');
  if (m.package !== PACKAGE_NAME) return fail('package');
  if (m.channel !== 'stable' && m.channel !== 'experimental') return fail('channel');
  if (m.arch !== 'x86_64') return fail('arch');
  const version = parseVersion(`${m.version}-${m.pkgrel}`);
  if (!version || !Number.isSafeInteger(m.pkgrel) || m.pkgrel < 1) return fail('version');
  let url;
  try { url = new URL(m.url); } catch { return fail('url'); }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) return fail('url-host');
  const file = basename(decodeURIComponent(url.pathname));
  const fm = FILE_RE.exec(file);
  if (!fm || fm[1] !== m.version || +fm[2] !== m.pkgrel) return fail('filename');
  if (!Number.isSafeInteger(m.size) || m.size <= 0 || m.size > MAX_PACKAGE_BYTES) return fail('size');
  if (typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256)) return fail('sha256');
  if (m.notes !== undefined && (typeof m.notes !== 'string' || m.notes.length > 8000)) return fail('notes');
  if (typeof m.publishedAt !== 'string' || !Number.isFinite(Date.parse(m.publishedAt))) return fail('publishedAt');
  return { ok: true, manifest: { ...m, file, parsedVersion: version } };
}

/** Assinatura Ed25519 destacada (base64) sobre os bytes exatos do manifesto. */
export function verifyManifestSignature(bytes, signatureB64, publicKeysPem) {
  if (!Array.isArray(publicKeysPem) || publicKeysPem.length === 0) return false;
  let sig;
  try { sig = Buffer.from(String(signatureB64).trim(), 'base64'); } catch { return false; }
  if (sig.length !== 64) return false;
  return publicKeysPem.some((pem) => {
    try {
      const key = createPublicKey(pem);
      return key.asymmetricKeyType === 'ed25519' && cryptoVerify(null, bytes, key, sig);
    } catch { return false; }
  });
}

export function loadChannelConfig(file = join(dirname(fileURLToPath(import.meta.url)), 'update-channel.json')) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    const keys = Array.isArray(c.publicKeys) ? c.publicKeys.filter((k) => typeof k === 'string' && k.includes('PUBLIC KEY')) : [];
    return { manifestBase: typeof c.manifestBase === 'string' ? c.manifestBase : null, publicKeys: keys };
  } catch {
    return { manifestBase: null, publicKeys: [] };
  }
}

async function fetchBytes(fetchImpl, url, limit) {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'http' });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limit) throw Object.assign(new Error('too large'), { code: 'too-large' });
  return buf;
}

/**
 * Consulta o canal. Devolve sempre um objeto com `state`:
 *   not-configured | up-to-date | available | downgrade-refused | invalid | error
 */
export async function checkForUpdate({ installed, channel = 'stable', config, fetchImpl = fetch, now = () => new Date() }) {
  const checkedAt = now().toISOString();
  const base = { schema: 1, channel, checkedAt, installed: installed ? formatVersion(installed) : null };
  if (!config.manifestBase || config.publicKeys.length === 0) {
    return { ...base, state: 'not-configured', message: 'Canal de atualizações sem chave pública confiável configurada neste pacote.' };
  }
  if (channel !== 'stable' && channel !== 'experimental') return { ...base, state: 'invalid', reason: 'channel' };
  try {
    const url = `${config.manifestBase.replace(/\/$/, '')}/manifest-${channel}.json`;
    const bytes = await fetchBytes(fetchImpl, url, MAX_MANIFEST_BYTES);
    const sig = (await fetchBytes(fetchImpl, `${url}.sig`, 1024)).toString('utf8');
    if (!verifyManifestSignature(bytes, sig, config.publicKeys)) {
      return { ...base, state: 'invalid', reason: 'signature', message: 'Assinatura do manifesto inválida; a atualização foi ignorada.' };
    }
    const parsed = validateManifest(JSON.parse(bytes.toString('utf8')));
    if (!parsed.ok) return { ...base, state: 'invalid', reason: parsed.reason };
    const m = parsed.manifest;
    if (m.channel !== channel) return { ...base, state: 'invalid', reason: 'channel-mismatch' };
    const available = { version: formatVersion(m.parsedVersion), size: m.size, sha256: m.sha256, notes: m.notes ?? '', url: m.url, file: m.file, publishedAt: m.publishedAt, signature: 'ed25519-verified' };
    if (!installed) return { ...base, state: 'available', available };
    const cmp = compareVersions(m.parsedVersion, installed);
    if (cmp > 0) return { ...base, state: 'available', available };
    if (cmp === 0) return { ...base, state: 'up-to-date', available };
    return { ...base, state: 'downgrade-refused', available };
  } catch (error) {
    return { ...base, state: 'error', reason: error?.code ?? 'network', message: 'Não foi possível consultar o canal de atualizações.' };
  }
}

// ── Download ─────────────────────────────────────────────────────────────
export function sha256File(file) {
  return new Promise((ok, ko) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', ko).on('end', () => ok(h.digest('hex')));
  });
}

export async function downloadUpdate({ available, cacheDir, fetchImpl = fetch, onProgress = () => {} }) {
  if (!FILE_RE.test(available.file) || !/^[a-f0-9]{64}$/.test(available.sha256)) return { state: 'invalid', reason: 'manifest' };
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const final = join(cacheDir, available.file);
  const part = `${final}.part`;
  if (existsSync(final)) {
    if (statSync(final).size === available.size && await sha256File(final) === available.sha256) {
      return { state: 'verified', file: final, reused: true };
    }
    rmSync(final, { force: true });
  }
  let offset = existsSync(part) ? statSync(part).size : 0;
  if (offset > available.size) { rmSync(part, { force: true }); offset = 0; }
  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
  const res = await fetchImpl(available.url, { headers, redirect: 'follow' });
  if (!(res.status === 200 || res.status === 206)) return { state: 'error', reason: `http-${res.status}` };
  if (res.status === 200 && offset > 0) offset = 0; // servidor ignorou o Range: recomeça
  const out = createWriteStream(part, { flags: offset > 0 ? 'a' : 'w', mode: 0o600 });
  let received = offset;
  try {
    for await (const chunk of res.body) {
      received += chunk.length;
      if (received > available.size) throw Object.assign(new Error('oversize'), { code: 'size' });
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress({ received, total: available.size });
    }
  } catch (error) {
    // Fecha com flush: o que já chegou fica no .part para a retoma.
    await new Promise((r) => out.end(r));
    if (error?.code === 'size') { rmSync(part, { force: true }); return { state: 'invalid', reason: 'size' }; }
    return { state: 'error', reason: 'interrupted', resumable: true };
  }
  await new Promise((r) => out.end(r));
  if (statSync(part).size !== available.size) return { state: 'error', reason: 'incomplete', resumable: true };
  if (await sha256File(part) !== available.sha256) { rmSync(part, { force: true }); return { state: 'invalid', reason: 'sha256' }; }
  renameSync(part, final);
  return { state: 'verified', file: final, reused: false };
}

// ── Instalação ───────────────────────────────────────────────────────────
export async function installPlan({ file, expectedSha256, consent, uid }) {
  if (consent !== true) return { ok: false, error: 'consent-required' };
  if (!Number.isInteger(uid) || uid === 0) return { ok: false, error: 'run-as-user' };
  if (!FILE_RE.test(basename(file)) || !existsSync(file)) return { ok: false, error: 'file' };
  if (await sha256File(file) !== expectedSha256) return { ok: false, error: 'sha256' };
  return { ok: true, argv: ['pkexec', 'pacman', '-U', resolve(file)] };
}

export function installedVersion(run = spawn) {
  return new Promise((ok) => {
    let out = '';
    const p = run('/usr/bin/pacman', ['-Q', PACKAGE_NAME], { env: { PATH: '/usr/bin', LC_ALL: 'C' } });
    p.stdout?.on('data', (d) => { out += d; });
    p.once('error', () => ok(null));
    p.once('exit', (code) => ok(code === 0 ? parseVersion(out.trim().split(/\s+/)[1]) : null));
  });
}

export function paths(env = process.env) {
  const cache = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const config = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return { cacheDir: join(cache, PACKAGE_NAME, 'updates'), prefsFile: join(config, PACKAGE_NAME, 'updates.json') };
}

export function readPrefs(file) {
  try {
    const p = JSON.parse(readFileSync(file, 'utf8'));
    return { channel: p.channel === 'experimental' ? 'experimental' : 'stable', autoDownload: p.autoDownload === true };
  } catch {
    return { channel: 'stable', autoDownload: false };
  }
}

// ── CLI: cybersafe-linux-update [check|download|install --consent|prefs] ──
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [cmd = 'check', ...rest] = process.argv.slice(2);
  const print = (o) => console.log(JSON.stringify(o));
  (async () => {
    if (process.platform !== 'linux' || process.getuid?.() === 0) { print({ schema: 1, state: 'error', reason: 'run-as-user' }); process.exitCode = 2; return; }
    const p = paths();
    const prefs = readPrefs(p.prefsFile);
    const statusFile = join(p.cacheDir, 'last-check.json');
    if (cmd === 'prefs') {
      const channel = rest.includes('--experimental') ? 'experimental' : rest.includes('--stable') ? 'stable' : prefs.channel;
      const next = { channel, autoDownload: rest.includes('--auto-download') ? true : rest.includes('--no-auto-download') ? false : prefs.autoDownload };
      mkdirSync(dirname(p.prefsFile), { recursive: true, mode: 0o700 });
      writeFileSync(p.prefsFile, JSON.stringify(next), { mode: 0o600 });
      return print({ schema: 1, prefs: next });
    }
    const result = await checkForUpdate({ installed: await installedVersion(), channel: prefs.channel, config: loadChannelConfig() });
    mkdirSync(p.cacheDir, { recursive: true, mode: 0o700 });
    writeFileSync(statusFile, JSON.stringify(result), { mode: 0o600 });
    if (cmd === 'check') { print({ ...result, prefs }); process.exitCode = result.state === 'error' || result.state === 'invalid' ? 1 : 0; return; }
    if (result.state !== 'available') { print(result); process.exitCode = result.state === 'up-to-date' ? 0 : 1; return; }
    const dl = await downloadUpdate({ available: result.available, cacheDir: p.cacheDir });
    if (cmd === 'download' || dl.state !== 'verified') { print({ ...result, download: dl }); process.exitCode = dl.state === 'verified' ? 0 : 1; return; }
    if (cmd === 'install') {
      const plan = await installPlan({ file: dl.file, expectedSha256: result.available.sha256, consent: rest.includes('--consent'), uid: process.getuid() });
      if (!plan.ok) { print({ ...result, download: dl, install: plan }); process.exitCode = 2; return; }
      const child = spawn('/usr/bin/pkexec', plan.argv.slice(1), { stdio: 'inherit', env: { PATH: '/usr/bin', HOME: homedir(), DISPLAY: process.env.DISPLAY ?? '', WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? '' } });
      child.once('exit', async (code) => {
        const after = await installedVersion();
        print({ ...result, download: dl, install: { ok: code === 0, exitCode: code, installedAfter: after ? formatVersion(after) : null } });
        process.exitCode = code === 0 ? 0 : 1;
      });
      return;
    }
    print({ schema: 1, state: 'error', reason: 'unknown-command' }); process.exitCode = 2;
  })();
}
