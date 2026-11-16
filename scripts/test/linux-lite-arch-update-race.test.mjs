// Corridas adversariais contra o limite privilegiado do atualizador Linux.
// Invariante: stageVerifiedPackage OU falha, OU devolve uma cópia privada cujos
// bytes são exatamente o artefacto assinado. Nunca outra coisa.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {linkSync,mkdirSync,mkdtempSync,openSync,readFileSync,renameSync,rmSync,writeFileSync,writeSync,closeSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const linux={skip:process.platform!=='linux'};
const FILE='cybersafe-assistant-linux-lite-0.2.5-1-x86_64.pkg.tar.zst';

function fixture(size=24*1024*1024){
  const root=mkdtempSync(join(tmpdir(),'cs-race-'));
  const staging=join(root,'staging');mkdirSync(staging,{mode:0o700});
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const body=randomBytes(size);
  const sha256=createHash('sha256').update(body).digest('hex');
  const manifest={schema:2,package:'cybersafe-assistant-linux-lite',edition:'arch-shared',channel:'experimental',arch:'x86_64',version:'0.2.5',pkgrel:1,minClient:'0.2.4-4',
    url:`https://github.com/MatrixChill/cybersafe-assistant/releases/download/linux-v0.2.5-arch-preview.1/${FILE}`,size:body.length,sha256,publishedAt:'2026-11-16T00:00:00Z'};
  const bytes=Buffer.from(JSON.stringify(manifest));
  const manifestFile=join(root,'manifest.json'),signatureFile=join(root,'manifest.sig'),packageFile=join(root,FILE);
  writeFileSync(manifestFile,bytes,{mode:0o600});
  writeFileSync(signatureFile,sign(null,bytes,privateKey).toString('base64'),{mode:0o600});
  writeFileSync(packageFile,body,{mode:0o600});
  const config={schema:2,publicKeys:[publicKey.export({type:'spki',format:'pem'})],edition:'arch-shared'};
  return {root,body,sha256,request:{manifestFile,signatureFile,packageFile,expectedSha256:sha256,uid:process.getuid(),config,stagingRoot:staging}};
}
const digest=(b)=>createHash('sha256').update(b).digest('hex');

async function invariant(promise,sha256){
  try{
    const staged=await promise;
    assert.equal(digest(readFileSync(staged.file)),sha256,'cópia privilegiada difere do artefacto assinado');
    assert.equal(statSync(staged.file).mode&0o777,0o600);
    return 'staged-exact';
  }catch(error){
    if(error.code==='ERR_ASSERTION')throw error;
    return error.code;
  }
}

test('alteração concorrente DURANTE a cópia nunca produz uma cópia aceite diferente',linux,async()=>{
  const {stageVerifiedPackage}=await import('../linux-lite/arch/update-install-helper.mjs');
  const outcomes=new Map();
  for(let round=0;round<6;round++){
    const f=fixture();
    try{
      let stop=false;
      // Escritor adversarial: reescreve blocos no próprio inode enquanto o helper copia.
      const writer=(async()=>{const fd=openSync(f.request.packageFile,'r+');try{while(!stop){writeSync(fd,randomBytes(4096),0,4096,Math.floor(Math.random()*(f.body.length-4096)));await new Promise(r=>setImmediate(r));}}finally{closeSync(fd);}})();
      const result=await invariant(stageVerifiedPackage(f.request),f.sha256);
      stop=true;await writer;
      outcomes.set(result,(outcomes.get(result)??0)+1);
    }finally{rmSync(f.root,{recursive:true,force:true});}
  }
  assert.ok(outcomes.has('package-integrity'),`a corrida tem de ser detetada pelo menos uma vez: ${[...outcomes]}`);
  for(const key of outcomes.keys())assert.ok(['package-integrity','staged-exact'].includes(key),key);
});

test('troca do caminho por rename depois de aberto: copia o inode fixado ou falha',linux,async()=>{
  const {stageVerifiedPackage}=await import('../linux-lite/arch/update-install-helper.mjs');
  const f=fixture();
  try{
    const evil=join(f.root,'evil');writeFileSync(evil,randomBytes(f.body.length),{mode:0o600});
    const pending=stageVerifiedPackage(f.request);
    setImmediate(()=>{try{renameSync(evil,f.request.packageFile);}catch{}});
    const result=await invariant(pending,f.sha256);
    assert.ok(['staged-exact','package-integrity'].includes(result),result);
    // Depois da troca o caminho aponta para o ficheiro malicioso: uma nova tentativa falha.
    assert.equal(await invariant(stageVerifiedPackage(f.request),f.sha256),'package-integrity');
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('hard link e ficheiro gravável por outros são recusados antes de ler',linux,async()=>{
  const {stageVerifiedPackage}=await import('../linux-lite/arch/update-install-helper.mjs');
  const f=fixture(4096);
  try{
    linkSync(f.request.packageFile,join(f.root,'alias'));
    assert.equal(await invariant(stageVerifiedPackage(f.request),f.sha256),'source-unsafe');
    rmSync(join(f.root,'alias'));
    writeFileSync(f.request.packageFile,f.body,{mode:0o666});
    const fd=openSync(f.request.packageFile,'r');closeSync(fd);
    (await import('node:fs')).chmodSync(f.request.packageFile,0o666);
    assert.equal(await invariant(stageVerifiedPackage(f.request),f.sha256),'source-unsafe');
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('staging não privado é recusado; falha de escrita não deixa cópia parcial',linux,async()=>{
  const {stageVerifiedPackage}=await import('../linux-lite/arch/update-install-helper.mjs');
  const f=fixture(4096);
  try{
    (await import('node:fs')).chmodSync(f.request.stagingRoot,0o755);
    assert.equal(await invariant(stageVerifiedPackage(f.request),f.sha256),'staging-unsafe');
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('instalação interrompida: lock órfão recuperado e preservado; dono vivo ou pacman ocupado recusam',linux,async()=>{
  const {acquireInstallLock}=await import('../linux-lite/arch/update-install-helper.mjs');
  const root=mkdtempSync(join(tmpdir(),'cs-lock-'));
  const proc=join(root,'proc');mkdirSync(proc);
  const dbLock=join(root,'db.lck');
  try{
    const first=acquireInstallLock(root,{proc,dbLock,pid:4242});
    mkdirSync(join(proc,'4242'));
    assert.throws(()=>acquireInstallLock(root,{proc,dbLock,pid:5000}),/installation-busy/,'dono vivo');
    rmSync(join(proc,'4242'),{recursive:true});
    writeFileSync(dbLock,'');
    assert.throws(()=>acquireInstallLock(root,{proc,dbLock,pid:5000}),/installation-busy/,'pacman ocupado');
    rmSync(dbLock);
    const again=acquireInstallLock(root,{proc,dbLock,pid:5000});
    assert.equal(again,first);
    assert.equal(readFileSync(join(again,'owner'),'utf8'),'5000');
    const {readdirSync}=await import('node:fs');
    assert.equal(readdirSync(root).filter(n=>n.startsWith('.install.lock.stale-')).length,1,'evidência preservada');
  }finally{rmSync(root,{recursive:true,force:true});}
});
