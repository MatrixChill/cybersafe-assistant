import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readProductVersion, isValidVersion } from './app-version.mjs';
test('candidate, product and Windows versions are distinct and consistent',()=>{
 const v=readProductVersion();
 assert.equal(v.version,'0.1.10-internal.pap-r6.20261031');
 assert.equal(v.productVersion,'0.1.10'); assert.equal(v.windowsVersion,'0.1.10.0');
});
test('rejects ambiguous semver identifiers',()=>{
 for(const value of ['01.2.3','1.2.3-01','1.2.3-a..b','1.2.3-','1.2']) assert.equal(isValidVersion(value),false,value);
 assert.equal(isValidVersion('1.2.3-rc.2'),true);
});
