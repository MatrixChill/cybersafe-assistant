import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {candidateOutput,buildAppManifest} from '../package-windows.mjs';
test('candidate has a unique dedicated output and installer name, standard packaging remains unchanged',()=>{
 const desktop=path.resolve('packages/desktop');const a=candidateOutput(desktop,'20261014-130000-abcdef12'),b=candidateOutput(desktop,'20261014-130000-abcdef13');assert.notEqual(a.output,b.output);assert.equal(path.dirname(a.output),path.join(desktop,'release'));assert.match(a.artifactName,/candidate-20261014-130000-abcdef12/);assert.match(a.artifactName,/setup/);
 const input={desktopManifest:{name:'desktop',version:'0.1.1',build:{productName:'CyberSafe',artifactName:'original.exe',directories:{output:'release'},win:{}}},tarballs:{"@cybersafe/core":"/temp/core.tgz","@cybersafe/shared-types":"/temp/shared.tgz","@cybersafe/service":"/temp/service.tgz",api:"/temp/api.tgz"},electronVersion:'33.4.11',scanEngine:'scanner',outDir:a.output,desktopDir:desktop,productVersion:'0.1.10-internal.pap-r6.20261031'};
 assert.equal(buildAppManifest(input).build.artifactName,'original.exe');assert.equal(buildAppManifest({...input,candidateId:'20261014-130000-abcdef12'}).build.artifactName,a.artifactName);
});
test('candidate identifier rejects path traversal, drive paths and empty input',()=>{for(const id of ['../old','C:/data','','20261014/130000/abcdef12'])assert.throws(()=>candidateOutput('desktop',id));});
