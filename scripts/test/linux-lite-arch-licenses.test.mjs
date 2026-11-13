import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as inventory from '../linux-lite/arch/collect-licenses.mjs';

test('runtime license inventory uses payload bytes and rejects absent notices', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cs-licenses-'));
  try {
    const dep=path.join(root,'node_modules','fixture');fs.mkdirSync(dep,{recursive:true});
    fs.writeFileSync(path.join(dep,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',license:'MIT'}));
    assert.throws(()=>inventory.collectRuntimeLicenses(root,'approved own license'),/notice/i);
    fs.writeFileSync(path.join(dep,'LICENSE'),'Copyright fixture\nPermission is hereby granted.');
    const result=inventory.collectRuntimeLicenses(root,'approved own license');
    assert.equal(result.packages[0].name,'fixture');
    assert.equal(result.packages[0].version,'1.0.0');
    assert.match(result.notices,/Copyright fixture/);
    assert.equal(result.packages[0].notices[0].sha256.length,64);
    fs.writeFileSync(path.join(dep,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',license:'UNLICENSED'}));
    assert.throws(()=>inventory.collectRuntimeLicenses(root,'approved own license'),/license/i);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('Koffi binary notice can only reuse the identically versioned parent license', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cs-koffi-license-'));
  try {
    const binary=path.join(root,'node_modules','@koromix','koffi-linux-x64');
    const parent=path.join(root,'node_modules','koffi');
    fs.mkdirSync(binary,{recursive:true});fs.mkdirSync(parent,{recursive:true});
    fs.writeFileSync(path.join(binary,'package.json'),JSON.stringify({name:'@koromix/koffi-linux-x64',version:'3.3.4',license:'MIT'}));
    fs.writeFileSync(path.join(parent,'package.json'),JSON.stringify({name:'koffi',version:'3.3.4',license:'MIT'}));
    fs.writeFileSync(path.join(parent,'LICENSE.txt'),'Copyright Koffi fixture.');
    const result=inventory.collectRuntimeLicenses(root,'own');
    assert.match(result.notices,/Copyright Koffi fixture/);
    assert.equal(result.packages.length,2);
    fs.writeFileSync(path.join(parent,'package.json'),JSON.stringify({name:'koffi',version:'3.3.5',license:'MIT'}));
    assert.throws(()=>inventory.collectRuntimeLicenses(root,'own'),/mismatch/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
