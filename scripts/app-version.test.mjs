import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProductVersion, isValidVersion, verifyBuiltRenderer } from './app-version.mjs';
test('candidate, product and Windows versions are distinct and consistent',()=>{
 const v=readProductVersion();
 assert.equal(v.version,'0.1.11-internal.pap-r7.20261031');
 assert.equal(v.productVersion,'0.1.11'); assert.equal(v.windowsVersion,'0.1.11.0');
});
test('rejects ambiguous semver identifiers',()=>{
 for(const value of ['01.2.3','1.2.3-01','1.2.3-a..b','1.2.3-','1.2']) assert.equal(isValidVersion(value),false,value);
 assert.equal(isValidVersion('1.2.3-rc.2'),true);
});

function rendererFixture(source) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybersafe-renderer-'));
 fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
 fs.writeFileSync(path.join(dir, 'assets', 'index.js'), source);
 return dir;
}

test('renderer gate ignores the explicit development fallback', () => {
 const dir = rendererFixture('const build={version:"0.1.10-internal.pap-r6.20261031",buildId:"20261031-210011",commit:"fc960c8",sourceState:"clean"};const fallback={version:"desconhecida",buildId:"desenvolvimento",commit:"desconhecido"};');
 try {
  const result = verifyBuiltRenderer({ distDir: dir, version: '0.1.10-internal.pap-r6.20261031' });
  assert.equal(result.ok, true);
  assert.equal(result.identities.length, 1);
  assert.equal(result.identities[0].version, '0.1.10-internal.pap-r6.20261031');
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('renderer gate still rejects a real second version', () => {
 const dir = rendererFixture('const build={version:"0.1.10-internal.pap-r6.20261031",buildId:"20261031-210011",commit:"fc960c8"};const old={version:"0.1.9-internal.pap-r4.20261030",buildId:"20261030-210720",commit:"abcdef1"};');
 try {
  const result = verifyBuiltRenderer({ distDir: dir, version: '0.1.10-internal.pap-r6.20261031' });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes('2 versões diferentes')));
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
