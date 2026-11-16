#!/usr/bin/env node
// Ferramenta do MANTENEDOR para o canal de atualizações Linux.
//
//   keygen <diretório-fora-do-repositório>   gera um par Ed25519 (privada 0600)
//   build  <pacote.pkg.tar.zst> <channel> <url> [notas.txt] [cliente-mínimo] → manifesto v2
//   sign   <manifest.json> <privada.pem>       → <manifest.json>.sig
//
// A chave privada nunca entra no repositório: keygen recusa caminhos dentro
// dele. A chave pública gerada é a que se coloca em
// scripts/linux-lite/arch/update-channel.json ("publicKeys").
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, parseVersion, compareVersions } from './arch/updater.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'keygen') {
  const dir = resolve(args[0] ?? '');
  const rel = relative(repo, dir);
  if (!args[0] || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Indique um diretório FORA do repositório para a chave privada.');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(dir, 'cybersafe-linux-update.key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  writeFileSync(join(dir, 'cybersafe-linux-update.pub.pem'), pub, { flag: 'wx' });
  console.log(pub);
} else if (cmd === 'build') {
  const [pkg, channel, url, notesFile, requestedFloor] = args;
  const file = basename(pkg);
  const m = /^(cybersafe-assistant-(linux-lite|nigor))-(\d+\.\d+\.\d+)-(\d+)-x86_64\.pkg\.tar\.zst$/.exec(file);
  if (!m) throw new Error('Nome de pacote inesperado.');
  const edition = m[2] === 'nigor' ? 'nigor' : 'arch-shared';
  const firstProtectedClient = edition === 'nigor' ? '0.2.4-1' : '0.2.4-4';
  const minClient = requestedFloor ?? firstProtectedClient;
  const parsedFloor = parseVersion(minClient);
  if (!parsedFloor || compareVersions(parsedFloor, parseVersion(firstProtectedClient)) < 0) throw new Error('Cliente mínimo anterior ao protocolo protegido.');
  const manifest = {
    schema: 2, package: m[1], edition, channel, arch: 'x86_64', minClient,
    version: m[3], pkgrel: Number(m[4]), url,
    size: statSync(pkg).size,
    sha256: createHash('sha256').update(readFileSync(pkg)).digest('hex'),
    notes: notesFile ? readFileSync(notesFile, 'utf8') : '',
    publishedAt: new Date().toISOString(),
  };
  const v = validateManifest(manifest, {schema: 2, edition});
  if (!v.ok) throw new Error(`Manifesto inválido: ${v.reason}`);
  const out = `manifest-${channel}.json`;
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(out);
} else if (cmd === 'sign') {
  const [manifestFile, keyFile] = args;
  const key = createPrivateKey(readFileSync(keyFile));
  const sig = sign(null, readFileSync(manifestFile), key).toString('base64');
  writeFileSync(`${manifestFile}.sig`, sig + '\n');
  console.log(`${manifestFile}.sig`);
} else {
  console.error('Uso: update-manifest.mjs keygen <dir> | build <pkg> <channel> <url> [notas] | sign <manifest> <key>');
  process.exitCode = 2;
}
