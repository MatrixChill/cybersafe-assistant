import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const lock=JSON.parse(fs.readFileSync(new URL('../../package-lock.json',import.meta.url),'utf8'));
for(const platform of ['linux-x64-gnu','win32-x64-msvc']) test(`npm ci can resolve the locked Rolldown binding for ${platform}`,()=>{
 const name=`@rolldown/binding-${platform}`;const expected=lock.packages['node_modules/rolldown'].optionalDependencies[name];
 const entry=lock.packages[`node_modules/${name}`];assert.ok(entry,`missing ${name}; clean build cannot run Vite`);
 assert.equal(entry.version,expected);assert.equal(entry.optional,true);assert.match(entry.integrity,/^sha512-/);
 assert.ok(entry.resolved.startsWith('https://registry.npmjs.org/'));
});
