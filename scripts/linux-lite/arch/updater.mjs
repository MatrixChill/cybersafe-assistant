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
import { constants, closeSync, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE_NAME = 'cybersafe-assistant-linux-lite';
export const EDITION = 'arch-shared';
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const FILE_RE = /^cybersafe-assistant-linux-lite-(\d+\.\d+\.\d+)-(\d+)-x86_64\.pkg\.tar\.zst$/;

// ── Versões ──────────────────────────────────────────────────────────────
export function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const version = { major: +m[1], minor: +m[2], patch: +m[3], pkgrel: m[4] === undefined ? 1 : +m[4] };
  return Object.values(version).every(Number.isSafeInteger) && version.pkgrel >= 1 ? version : null;
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
  // Nigor currently uses this exact Arch package, not a fictional second
  // edition. A future distinct package must get an explicit identity contract.
  if (m.edition !== undefined && m.edition !== 'arch-shared') return fail('edition');
  const version = parseVersion(`${m.version}-${m.pkgrel}`);
  if (!version || !Number.isSafeInteger(m.pkgrel) || m.pkgrel < 1) return fail('version');
  let url;
  try { url = new URL(m.url); } catch { return fail('url'); }
  if (!allowedUrl(url.href) || url.hostname !== 'github.com') return fail('url-host');
  const releasePath = /^\/MatrixChill\/cybersafe-assistant\/releases\/download\/([^/]+)\/[^/]+$/.exec(url.pathname);
  if (!releasePath || url.search || url.hash) return fail('release-route');
  let file;
  try { file = basename(decodeURIComponent(url.pathname)); } catch { return fail('url-encoding'); }
  const fm = FILE_RE.exec(file);
  if (!fm || fm[1] !== m.version || +fm[2] !== m.pkgrel) return fail('filename');
  const tag = releasePath[1];
  const previewPrefix = `linux-v${m.version}-arch-preview.`;
  if (m.channel === 'stable' ? tag !== `linux-v${m.version}`
    : !tag.startsWith(previewPrefix) || !/^[1-9]\d*$/.test(tag.slice(previewPrefix.length))) return fail('release-channel');
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
    return { manifestBase: typeof c.manifestBase === 'string' ? c.manifestBase : null, publicKeys: keys, edition: c.edition ?? EDITION };
  } catch {
    return { manifestBase: null, publicKeys: [] };
  }
}

function allowedUrl(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname)
    && !u.username && !u.password && (!u.port || u.port === '443'); } catch { return false; }
}
async function restrictedFetch(fetchImpl, url, options = {}) {
  for (let hop = 0; hop < 6; hop++) {
    if (!allowedUrl(url)) throw Object.assign(new Error('Untrusted download route'), {code:'url-host'});
    const res = await fetchImpl(url, {...options,redirect:'manual'});
    if (![301,302,303,307,308].includes(res.status)) return res;
    const location = res.headers.get('location'); await res.body?.cancel();
    if (!location) throw Object.assign(new Error('Invalid redirect'),{code:'redirect'});
    url = new URL(location,url).href;
  }
  throw Object.assign(new Error('Redirect limit'),{code:'redirect'});
}
async function fetchBytes(fetchImpl, url, limit) {
  const res = await restrictedFetch(fetchImpl, url, {signal:AbortSignal.timeout(30_000)});
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'http' });
  const chunks=[];let size=0;
  for await (const bytes of res.body) {
    size+=bytes.length;
    if(size>limit)throw Object.assign(new Error('too large'),{code:'too-large'});
    chunks.push(Buffer.from(bytes));
  }
  return Buffer.concat(chunks);
}

/**
 * Consulta o canal. Devolve sempre um objeto com `state`:
 *   not-configured | no-release | up-to-date | available | downgrade-refused | invalid | error
 */
export async function checkForUpdate({ installed, channel = 'experimental', config, fetchImpl = fetch, now = () => new Date() }) {
  const checkedAt = now().toISOString();
  const base = { schema: 1, edition: EDITION, channel, checkedAt, installed: installed ? formatVersion(installed) : null };
  if (config.edition !== undefined && config.edition !== EDITION) {
    return {...base, state:'not-configured', reason:'edition', message:'A edição instalada não corresponde a este atualizador Arch partilhado.'};
  }
  if (!config.manifestBase || config.publicKeys.length === 0) {
    return { ...base, state: 'not-configured', message: 'Canal de atualizações sem chave pública confiável configurada neste pacote.' };
  }
  if (channel !== 'stable' && channel !== 'experimental') return { ...base, state: 'invalid', reason: 'channel' };
  try {
    const url = `${config.manifestBase.replace(/\/$/, '')}/manifest-${channel}.json`;
    let bytes;
    try {
      bytes = await fetchBytes(fetchImpl, url, MAX_MANIFEST_BYTES);
    } catch (error) {
      if (error?.message === 'HTTP 404') return { ...base, state: 'no-release', message: 'Ainda não há versões publicadas neste canal.' };
      throw error;
    }
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

export async function downloadUpdate({ available, cacheDir, fetchImpl = fetch, onProgress = () => {}, signal = AbortSignal.timeout(30*60_000), freeBytes = () => {const s=statfsSync(cacheDir);return BigInt(s.bavail)*BigInt(s.bsize);} }) {
  if (!available || !FILE_RE.test(available.file) || !/^[a-f0-9]{64}$/.test(available.sha256)
    || !Number.isSafeInteger(available.size) || available.size<1 || available.size>MAX_PACKAGE_BYTES || !allowedUrl(available.url)) return { state: 'invalid', reason: 'manifest' };
  const final=join(cacheDir,available.file),part=`${final}.part`,lock=join(cacheDir,'.download.lock');
  let lockFd, lockInode;
  const regular = file => {
    try {const s=lstatSync(file);return s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&(process.platform!=='linux'||s.uid===process.getuid());}
    catch(error){if(error.code==='ENOENT')return true;throw error;}
  };
  try {
    mkdirSync(cacheDir,{recursive:true,mode:0o700});
    const root=lstatSync(cacheDir);
    if(!root.isDirectory()||root.isSymbolicLink()||(process.platform==='linux'&&(root.uid!==process.getuid()||(root.mode&0o077)||realpathSync(cacheDir)!==resolve(cacheDir)))
      || !regular(final)||!regular(part))return {state:'invalid',reason:'cache-unsafe'};
    try {lockFd=openSync(lock,'wx',0o600);lockInode=fstatSync(lockFd).ino;}
    catch(error){if(error.code==='EEXIST')return {state:'error',reason:'busy'};throw error;}
    if(existsSync(final)) {
      if(statSync(final).size===available.size&&await sha256File(final)===available.sha256)return {state:'verified',file:final,reused:true};
      rmSync(final,{force:true});
    }
    let offset=existsSync(part)?statSync(part).size:0;
    if(offset>available.size){rmSync(part);offset=0;}
    if(BigInt(freeBytes())<BigInt(available.size-offset))return {state:'error',reason:'no-space'};
    let res;
    try {res=await restrictedFetch(fetchImpl,available.url,{headers:offset?{Range:`bytes=${offset}-`}:{},signal});}
    catch(error){return {state:'error',reason:signal.aborted?'cancelled':error.code==='url-host'?'url-host':'network',resumable:offset>0};}
    if(![200,206].includes(res.status))return {state:'error',reason:`http-${res.status}`};
    if(res.status===206){
      const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range')??'');
      if(!range||+range[1]!==offset||+range[2]<offset||+range[2]>=available.size||+range[3]!==available.size){await res.body?.cancel();return {state:'invalid',reason:'range'};}
    }else offset=0;
    let received=offset;
    const out=await open(part,constants.O_WRONLY|constants.O_CREAT|(constants.O_NOFOLLOW??0)|(offset?constants.O_APPEND:constants.O_TRUNC),0o600);
    let failed;
    try {
      const stat=await out.stat();if(!stat.isFile()||stat.nlink!==1||stat.size!==offset)throw Object.assign(new Error('unsafe partial'),{code:'cache-unsafe'});
      for await(const chunk of res.body){
        if(signal.aborted)throw Object.assign(new Error('cancelled'),{code:'cancelled'});
        if(received+chunk.length>available.size)throw Object.assign(new Error('oversize'),{code:'size'});
        await out.writeFile(chunk);received+=chunk.length;onProgress({received,total:available.size});
      }
      await out.sync();
    }catch(error){failed=error;}
    finally{await out.close();}
    if(failed){
      if(failed.code==='size'){rmSync(part,{force:true});return {state:'invalid',reason:'size'};}
      return {state:'error',reason:failed.code==='ENOSPC'?'no-space':failed.code==='cache-unsafe'?'cache-unsafe':signal.aborted?'cancelled':'interrupted',resumable:true};
    }
    if(statSync(part).size!==available.size)return {state:'error',reason:'incomplete',resumable:true};
    if(await sha256File(part)!==available.sha256){rmSync(part,{force:true});return {state:'invalid',reason:'sha256'};}
    renameSync(part,final);return {state:'verified',file:final,reused:false};
  }catch(error){return {state:'error',reason:error.code==='ENOSPC'?'no-space':'cache-io'};}
  finally {
    if(lockFd!==undefined){closeSync(lockFd);try{if(lstatSync(lock).ino===lockInode)unlinkSync(lock);}catch{ /* unknown lock retained */ }}
  }
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
    return { channel: p.channel === 'stable' ? 'stable' : 'experimental', autoDownload: p.autoDownload === true };
  } catch {
    // A edição Linux só tem pré-releases: o canal por omissão é o experimental.
    return { channel: 'experimental', autoDownload: false };
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
