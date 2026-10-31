import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubReleaseOpener, isGitHubReleaseUrl } from '../src/updater/github-transport.ts';
const url = 'https://github.com/MatrixChill/cybersafe-assistant/releases/latest/download/update.json';
const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/file?signature=test';
test('repository assets only; no arbitrary URLs, userinfo, ports or foreign repos', () => {
  assert.equal(isGitHubReleaseUrl(url), true);
  for (const bad of [cdn, url.replace('MatrixChill','attacker'), url.replace('https:', 'http:'), url.replace('github.com', 'github.com.evil.test'), url.replace('github.com', 'user@github.com'), url + '#fragment']) assert.equal(isGitHubReleaseUrl(bad), false);
});
test('follows permitted CDN redirect, releases intermediate response', async () => {
  const calls=[]; let aborted=0;
  const final={status:200,headers:{},body:[],abort(){}};
  const opener=createGitHubReleaseOpener({async open(u){calls.push(u);return calls.length===1?{status:302,headers:{location:cdn},abort(){aborted++;}}:final;}});
  assert.equal(await opener.open(url,new AbortController().signal),final);
  assert.deepEqual(calls,[url,cdn]); assert.equal(aborted,1);
});
test('blocks foreign redirect before network and caps loops', async () => {
  for (const destination of ['https://evil.test/setup.exe', url]) {
    let calls=0;
    const opener=createGitHubReleaseOpener({async open(){calls++;return {status:302,headers:{location:destination},abort(){}};}});
    await assert.rejects(opener.open(url,new AbortController().signal),/autorizado|excessivo/);
    assert.equal(calls,destination===url?4:1);
  }
});
test('aborted operation opens no connection', async () => {
  const controller=new AbortController();controller.abort();
  await assert.rejects(createGitHubReleaseOpener({open(){throw Error('unexpected network');}}).open(url,controller.signal),/cancelado/);
});
