// Lab-only cross-filesystem quarantine acceptance (driven by verify-quarantine-crossfs.sh). Disposable mounts and fixtures only.
import {mkdtemp,mkdir,writeFile,readFile,stat,lstat,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {join} from 'node:path';import {tmpdir} from 'node:os';
const T=new URL('../..', import.meta.url).pathname.replace(/\/$/,'');
const {ProtectionEngineService}=await import(T+'/packages/service/dist/engine.js');
const base=await mkdtemp(join('/home/csbuild','cs-qx-'));await mkdir(join(base,'logs'));
const engine=new ProtectionEngineService(base);await engine.quarantine.init();
const sha=b=>createHash('sha256').update(b).digest('hex');const out=[];
async function trial(label,dir,expectSuccess){
  const content=Buffer.from(`benign cross-fs fixture ${label} ${Date.now()}`);const file=join(dir,`fixture-${label}.txt`);
  try{await writeFile(file,content,{mode:0o600});}catch(e){if(expectSuccess)throw e;}
  const d=sha(content);
  const analysis={artifactPath:file,fileName:`fixture-${label}.txt`,sha256:d,size:content.length,verdict:'malicious',severity:'critical',riskScore:100,confidence:1,rulesTriggered:['known_bad_hash'],factors:[],recommendedAction:'quarantined',scanTimestamp:new Date().toISOString()};
  const r=await engine.requestQuarantine(analysis,'manual');
  const stillThere=await stat(file).then(()=>true,()=>false);
  const row={fs:label,quarantine:r.success,originalStillAccessible:stillThere};
  if(r.success){
    const e=engine.quarantine.list().find(x=>x.originalPath===file);
    row.isolation=e?.isolationStatus;row.quarantineMode=((await lstat(e.quarantinePath)).mode&0o777).toString(8);
    const rr=await engine.restoreQuarantine(e.id,false);row.restore=rr.success;
    row.restoredIntact=rr.success&&sha(await readFile(file))===d;
    await unlink(file).catch(()=>{});
  } else row.reason=r.reason??r.error??r.message;
  out.push(row);
}
const sib=await mkdtemp(join('/home/csbuild','cs-qx-src-'));await trial('mesmo-volume-ext4',sib,true);
await trial('tmpfs',process.env.TMPFS,true);
await trial('vfat-usb',process.env.VFAT,true);
// vfat só de leitura: a origem já existe e não pode ser retirada
await trial('vfat-ro',process.env.VFATRO,false);
await engine.dispose();
console.log(JSON.stringify(out,null,1));
