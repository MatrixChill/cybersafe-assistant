import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('original Orbital B no longer fabricates progress, space or success',()=>{
 const ui=read('scripts/setup-ui/main.cpp');
 assert.doesNotMatch(ui,/g_progress\s*\+=|318 MB|64,2 GB|Extrair application\.asar/);
 assert.match(ui,/DrawOrbitals\(g,/);
 assert.match(ui,/WM_ORBITAL_PHASE/);
 assert.match(ui,/WM_ORBITAL_RESULT/);
});
test('single NSIS artefact embeds native frontend; original MUI work is retained',()=>{
 const config=JSON.parse(read('packages/desktop/package.json'));
 assert.equal(config.build.nsis.include,'installer/orbital-installer.nsh');
 const hooks=read('packages/desktop/build/installer/orbital-installer.nsh');
 assert.match(hooks,/OrbitalSetup::Start/);
 assert.match(hooks,/Pop \$INSTDIR/);
 assert.match(hooks,/Function \.onInstSuccess/);
 assert.match(hooks,/Function \.onInstFailed/);
 assert.match(hooks,/\$\{IfNot\} \$\{Silent\}/);
 assert.match(read('packages/desktop/build/installer/cybersafe-installer.nsh'),/Function CSConfigLeave/);
});
test('binary plugin is explicit freeze and packaging input, not excluded build output',()=>{
 assert.match(read('scripts/source-freeze.mjs'),/packages\/desktop\/build\/x86-unicode\/OrbitalSetup\.dll/);
 assert.match(read('scripts/package-windows.mjs'),/OrbitalSetup\.dll/);
});
