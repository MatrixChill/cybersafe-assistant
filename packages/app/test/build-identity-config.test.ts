import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import config from '../vite.config';
import { aboutIdentityLines, technicalInfoText } from '../src/lib/buildIdentity';
const build = JSON.parse((config as {define:Record<string,string>}).define.__BUILD__);
it('identidade compilada conserva os seis algarismos HHMMSS',()=>{assert.match(build.buildId,/^\d{8}-\d{6}$/);});
it('identidade declara o estado Git real sem esconder WIP',()=>{const dirty=execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim().length>0;assert.equal(build.sourceState,dirty?'modified':'clean');});
it('Sobre não expõe estado de árvore; a copia tecnica mantem-no',()=>{
 const i={version:'0.1.1',buildId:'20261018-173741',commit:'abc1234',sourceState:'modified' as const};
 assert.equal(aboutIdentityLines(i).some(x=>/alteraç|modificad/i.test(x.value)), false, 'a interface normal não apresenta a linha de alterações locais');
 assert.match(technicalInfoText(i,'33.4.11'),/alteraç|modificad/i);
});
