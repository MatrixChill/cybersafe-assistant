#!/usr/bin/env node
/** Offline BUILD workspace only; not a runtime publisher. Never target a profile.
 * Source and output parents must be trusted, not attacker-writable concurrently.
 * Creates an exclusively new output; failures leave evidence, never roll back DBs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_CLAMAV_SEED, buildSeedManifest, sha256FileSync, verifyClamavSeedBundle } from './clamav-seed-bundle.mjs';
const args = process.argv.slice(2);
const value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--help')) { console.log('Build only: --source <cache absoluta> --out <nova pasta absoluta> [--license <COPYING>] | --check --out <pasta>'); process.exit(0); }
try {
  const out = value('--out');
  if (!out || !path.isAbsolute(out)) throw Error('--out absoluto obrigatório');
  if (args.includes('--check')) {
    const result = verifyClamavSeedBundle(out);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }
  const source = value('--source');
  if (!source || !path.isAbsolute(source)) throw Error('--source absoluto obrigatório');
  const license = value('--license') ?? fileURLToPath(new URL('../vendor/clamav/COPYING.txt', import.meta.url));
  const sources = Object.keys(EXPECTED_CLAMAV_SEED).map(name => [name, name === 'COPYING.txt' ? license : path.join(source, name)]);
  // Fail before output creation; do not overwrite an earlier bundle.
  for (const [name, file] of sources) {
    const stat = fs.lstatSync(file), pin = EXPECTED_CLAMAV_SEED[name];
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.bytes || sha256FileSync(file) !== pin.sha256) throw Error(`CLAMAV_SEED_INVALID: ${name}`);
  }
  fs.mkdirSync(out); // no recursive/reuse
  for (const [name, from] of sources) fs.copyFileSync(from, path.join(out, name), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(out, 'SEED-MANIFEST.json'), JSON.stringify(buildSeedManifest({ source: 'Previously verified official cache; release pins checked before and after build copy' }), null, 2) + '\n', { flag: 'wx' });
  const result = verifyClamavSeedBundle(out);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (error) { console.error(error.message); process.exit(1); }
