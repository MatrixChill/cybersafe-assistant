import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ProtectionEngineService} from '../dist/engine.js';
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)),'exclusions-r7-'));
  const base=path.join(root,'service');await fs.mkdir(base);
  const folder=path.join(root,'chosen');await fs.mkdir(folder);
  const file=path.join(folder,'benign.txt');await fs.writeFile(file,'Benign exclusion fixture.');
  const engines=[];
  const open=async()=>{const e=new ProtectionEngineService(base);engines.push(e);await e.exclusions.init(path.join(base,'exclusions.json'));return e;};
  t.after(async()=>{await Promise.all(engines.map(e=>e.dispose()));await fs.rm(root,{recursive:true,force:true});});
  const rule=(type,value,extra={})=>({id:'rule-1',type,value,enabled:true,createdAt:'2026-11-01T00:00:00.000Z',reason:'Teste autorizado',...extra});
  return {root,base,folder,file,open,rule};
}
test('regra de pasta persiste, exclui sem analisar, desativa e remove sem excluir irmão',async t=>{
  const f=await fixture(t);const e=await f.open();
  const result=await e.dispatch('exclusions.update',{rules:[f.rule('folder',f.folder)]});
  assert.equal(result.success,true);
  assert.equal(e.isExcluded(f.file),true);
  assert.equal(e.isExcluded(f.folder+'-sibling/a.txt'),false);
  const scan=await e.scanArtifact(f.file,'system-scanner',{skipVirusTotal:true});
  assert.equal(scan.results[0].analysisState,'excluded');assert.equal(scan.results[0].verdict,'inconclusive');
  const reopened=await f.open();
  const config=await reopened.dispatch('exclusions.get',undefined);
  assert.equal(config.rules.length,1);assert.equal(config.rules[0].reason,'Teste autorizado');
  assert.equal(reopened.isExcluded(f.file),true);
  assert.equal((await reopened.dispatch('exclusions.update',{rules:[{...config.rules[0],enabled:false}]})).success,true);
  assert.equal(reopened.isExcluded(f.file),false);
  assert.equal((await reopened.dispatch('exclusions.update',{rules:[]})).success,true);
  assert.equal((await (await f.open()).dispatch('exclusions.get',undefined)).rules.length,0);
});
test('ficheiro exato e extensão normalizados; snapshot não permite mutação externa',async t=>{
  const f=await fixture(t);const e=await f.open();
  assert.equal((await e.dispatch('exclusions.update',{rules:[f.rule('file',f.file),f.rule('extension','.TXT',{id:'ext'})]})).success,true);
  const cfg=await e.dispatch('exclusions.get',undefined);assert.equal(cfg.rules[1].value,'.txt');cfg.rules.length=0;
  assert.equal(e.isExcluded(f.file),true);assert.equal(e.isExcluded(path.join(f.root,'other.TXT')),true);
});
test('recusa configuração perigosa ou malformada sem alterar disco ou política anterior',async t=>{
  const f=await fixture(t);const e=await f.open();
  await e.dispatch('exclusions.update',{rules:[f.rule('file',f.file)]});
  const before=await fs.readFile(path.join(f.base,'exclusions.json'),'utf8');
  for(const input of [null,{paths:[path.parse(f.root).root]},{rules:[f.rule('folder',path.parse(f.root).root)]},{rules:[f.rule('folder',f.root)]},{rules:[f.rule('folder',f.base)]},{rules:[f.rule('extension','.exe')]},{rules:[f.rule('file','../relative')]},{rules:[f.rule('extension','*')]},{rules:[f.rule('file',f.file,{enabled:'yes'})]}]){
    const r=await e.dispatch('exclusions.update',input);assert.equal(r.success,false,JSON.stringify(input));
    assert.equal(await fs.readFile(path.join(f.base,'exclusions.json'),'utf8'),before);assert.equal(e.isExcluded(f.file),true);
  }
});
test('escrita falhada não ativa regra; documento corrompido preservado não exclui alvos',async t=>{
  const f=await fixture(t);const e=await f.open();
  await fs.mkdir(path.join(f.base,'exclusions.json'));
  assert.equal((await e.dispatch('exclusions.update',{rules:[f.rule('file',f.file)]})).success,false);assert.equal(e.isExcluded(f.file),false);
  await fs.rmdir(path.join(f.base,'exclusions.json'));await fs.writeFile(path.join(f.base,'exclusions.json'),'{broken');
  const reopened=await f.open();assert.equal(reopened.isExcluded(f.file),false);
  assert.match((await reopened.dispatch('exclusions.get',undefined)).error,/exclusões/i);
  assert.equal(await fs.readFile(path.join(f.base,'exclusions.json'),'utf8'),'{broken');
});
test('junction é recusada e não transforma pasta arbitrária numa exclusão',async t=>{
  const f=await fixture(t);const e=await f.open();const alias=path.join(f.root,'alias');
  await fs.symlink(f.folder,alias,process.platform==='win32'?'junction':'dir');
  const r=await e.dispatch('exclusions.update',{rules:[f.rule('folder',alias)]});assert.equal(r.success,false);assert.equal(e.isExcluded(f.file),false);
});

test('fila de gravações mantém a última configuração; duplicados e limites não alteram a anterior', async t => {
  const f=await fixture(t); const e=await f.open();
  const [a,b]=await Promise.all([
    e.dispatch('exclusions.update',{rules:[f.rule('file',f.file)]}),
    e.dispatch('exclusions.update',{rules:[f.rule('extension','.txt')]}),
  ]);
  assert.equal(a.success,true); assert.equal(b.success,true);
  const cfg=await e.dispatch('exclusions.get',undefined);
  assert.equal(cfg.rules[0].type,'extension');
  for(const rules of [[f.rule('file',f.file),f.rule('file',f.file,{id:'other'})],
    Array.from({length:129},(_,i)=>f.rule('extension','.t'+i,{id:'r'+i})),
    [f.rule('file',f.file,{reason:'x'.repeat(241)})]]) {
    assert.equal((await e.dispatch('exclusions.update',{rules})).success,false);
    assert.deepEqual((await e.dispatch('exclusions.get',undefined)).rules,cfg.rules);
  }
  assert.deepEqual((await (await f.open()).dispatch('exclusions.get',undefined)).rules,cfg.rules);
});

test('folder substituída por junction depois de guardar não herda a exclusão',async t=>{
  const f=await fixture(t);const e=await f.open();
  assert.equal((await e.dispatch('exclusions.update',{rules:[f.rule('folder',f.folder)]})).success,true);
  const destination=path.join(f.root,'not-chosen');await fs.mkdir(destination);
  await fs.rename(f.folder,f.folder+'-original');
  await fs.symlink(destination,f.folder,process.platform==='win32'?'junction':'dir');
  assert.equal(e.isExcluded(path.join(f.folder,'next.txt')),false);
});

test('shutdown recusa novas exclusões sem gravar',async t=>{
  const f=await fixture(t);const e=await f.open();e.isShuttingDown=true;
  await assert.rejects(e.dispatch('exclusions.update',{rules:[f.rule('file',f.file)]}),/encerrar/);
  await assert.rejects(fs.stat(path.join(f.base,'exclusions.json')),{code:'ENOENT'});
});

test('falha no rename mantém configuração anterior e limpa o temporário',async t=>{
  const f=await fixture(t);const e=await f.open();
  await e.dispatch('exclusions.update',{rules:[f.rule('file',f.file)]});
  const before=await fs.readFile(path.join(f.base,'exclusions.json'),'utf8');
  const rename=fs.rename;
  fs.rename=async (from,to)=>{if(to===path.join(f.base,'exclusions.json'))throw Object.assign(Error('test rename'),{code:'EPERM'});return rename(from,to);};
  try {assert.equal((await e.dispatch('exclusions.update',{rules:[]})).success,false);}
  finally{fs.rename=rename;}
  assert.equal(await fs.readFile(path.join(f.base,'exclusions.json'),'utf8'),before);
  assert.equal(e.isExcluded(f.file),true);
  assert.deepEqual((await fs.readdir(f.base)).filter(name=>name.endsWith('.tmp')),[]);
});
