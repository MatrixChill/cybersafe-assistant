import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BUILTIN_HASH_SIGNATURES } from '../packages/core/dist/signatures.js';
import { DEV_TEST_YARA_CANONICO, DEV_TEST_YARA_MARCA } from '../packages/service/dist/dev-test-yara.js';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { run, realDeps } from './dev-isolated-run.mjs';


if(!process.argv.includes('--authorized-fixtures')) throw Error('Explicit test authorization required: --authorized-fixtures');
const deps = realDeps();
// Explicitly authorized fixture-only Electron session. Production launcher is unchanged.
const originalSpawn = deps.spawn;
let fixtureRoot;
deps.spawn = (cmd, args, options) => {
  const env = { ...options.env };
  const service = args.some(x => String(x).endsWith('service\\dist\\index.js') || String(x).endsWith('service/dist/index.js'));
  const desktop = String(cmd).toLowerCase().endsWith('electron.exe');
  if (service) {
    assert.equal(env.CYBERSAFE_DEV_ISOLATION, '1');
    assert.equal(env.CYBERSAFE_USB_PROTECTION, '0');
    assert.equal(env.CYBERSAFE_STARTUP_RESUME, '0');
    fixtureRoot = path.join(env.CYBERSAFE_DEV_ROOT, 'authorized-fixtures');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'benign.txt'), 'Harmless PAP scanner control.');
    fs.writeFileSync(path.join(fixtureRoot, 'synthetic-canary.txt'), DEV_TEST_YARA_MARCA);
    const corpus = path.join(env.CYBERSAFE_DEV_ROOT, 'synthetic-canary.yar');
    fs.writeFileSync(corpus, DEV_TEST_YARA_CANONICO);
    const hashes = path.join(env.CYBERSAFE_DEV_SERVICE_DIR, 'definitions/hashes/default.json');
    fs.mkdirSync(path.dirname(hashes), { recursive:true });
    fs.writeFileSync(hashes, JSON.stringify([...BUILTIN_HASH_SIGNATURES, {sha256:createHash('sha256').update(DEV_TEST_YARA_MARCA).digest('hex'), family:'PAP synthetic fixture', severity:'low', source:'synthetic-validation-only'}]));
    const dbSource = 'C:/Users/caioc/.cybersafe-integration/pap-integration-p0-codex-20261027/freshclam-validation/database';
    const dbDest = path.join(env.CYBERSAFE_DEV_SERVICE_DIR, 'definitions/clamav');
    fs.mkdirSync(dbDest, { recursive: true });
    for (const name of ['main.cvd', 'daily.cvd', 'bytecode.cvd']) {
      const from = path.join(dbSource, name), to = path.join(dbDest, name);
      const stat = fs.statSync(from); fs.copyFileSync(from, to); fs.utimesSync(to, stat.atime, stat.mtime);
    }
    env.CYBERSAFE_DEV_WINDOWS_READONLY = '0';
    env.CYBERSAFE_REALDEV_FIXTURE_SCAN = '1';
    env.CYBERSAFE_REALDEV_FIXTURE_ROOT = fixtureRoot;
    env.CYBERSAFE_DEV_TEST_YARA_PATH = corpus;
    env.CYBERSAFE_CLAMSCAN_PATH = path.resolve('vendor/clamav/clamscan.exe');
  }
  // Service gate remains authoritative: all non-scan mutations are refused.
  if (desktop) env.CYBERSAFE_DEV_WINDOWS_READONLY = '0';
  return originalSpawn(cmd, args, { ...options, env });
};

deps.onStackReady=async({plan})=>{
  console.log('PAP: perfil isolado de teste. Só a pasta sintética abaixo pode ser analisada.');
  console.log('Arraste esta pasta para o Scanner: '+fixtureRoot);
  console.log('Canário inofensivo YARA/HashDB; não representa malware real.');
  console.log('Análises rápida/profunda, caminhos fora da fixture, quarentena e proteção são recusados neste perfil.');
  console.log('Dados de teste preservados em: '+plan.root);
};
const result=await run({argv:['--start','--owned-direct'],env:process.env,deps});
if(result.blocked || result.cleanup?.allDead!==true) process.exitCode=1;
