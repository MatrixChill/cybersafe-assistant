#!/usr/bin/node
// One-shot privileged boundary. No network, user-supplied commands or keys.
// Only this installed, root-owned helper may hand a private verified copy to
// pacman; client-side hash checks are never treated as privileged evidence.
import {createHash} from 'node:crypto';
import {constants,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,readlinkSync,realpathSync,renameSync,rmdirSync,rmSync,writeFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {compareVersions,formatVersion,loadChannelConfig,PACKAGE_NAME,parseVersion,validateManifest,verifyManifestSignature} from './updater.mjs';

export const INSTALL_ROOT='/opt/cybersafe-assistant-linux-lite';
const MAX_PACKAGE_BYTES=512*1024*1024;
// O_PATH is absent from Node's fs.constants. Linux x86_64 can inspect a
// pinned inode before opening it for reading (including special files).
const O_PATH_LINUX_X64 = 0o10000000;
const fail=reason=>{throw Object.assign(new Error(reason),{code:reason});};

async function ownedSource(file,uid,limit){
  if(!Number.isSafeInteger(uid)||uid<1||!file||!file.startsWith('/'))fail('source-unsafe');
  let reference;
  try{
    reference=await open(file,O_PATH_LINUX_X64|constants.O_NOFOLLOW);
    const stat=await reference.stat();
    if(!stat.isFile()||stat.nlink!==1||stat.uid!==uid||(stat.mode&0o022)||stat.size>limit)fail('source-unsafe');
    return await open(`/proc/self/fd/${reference.fd}`,constants.O_RDONLY|constants.O_NONBLOCK);
  }finally{await reference?.close();}
}

async function boundedOwnedBytes(file,uid,limit){
  const handle=await ownedSource(file,uid,limit);
  try{
    const bytes=Buffer.alloc(limit+1);
    let length=0;
    while(length<bytes.length){const {bytesRead}=await handle.read(bytes,length,bytes.length-length,null);if(!bytesRead)break;length+=bytesRead;}
    if(length>limit)fail('source-unsafe');
    return bytes.subarray(0,length);
  }finally{await handle.close();}
}

/** Also used by the lab tests as an ordinary user; CLI below requires root. */
export async function stageVerifiedPackage({packageFile,manifestFile,signatureFile,expectedSha256,uid,config,stagingRoot}){
  const bytes=await boundedOwnedBytes(manifestFile,uid,65536);
  const signature=(await boundedOwnedBytes(signatureFile,uid,1024)).toString('utf8');
  if(!verifyManifestSignature(bytes,signature,config.publicKeys))fail('signature');
  const parsed=validateManifest(JSON.parse(bytes.toString('utf8')));
  if(!parsed.ok)fail(`manifest-${parsed.reason}`);
  const manifest=parsed.manifest;
  if(config.edition!=='arch-shared'||manifest.sha256!==expectedSha256||basename(packageFile)!==manifest.file)fail('request-mismatch');
  const stat=lstatSync(stagingRoot);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)||realpathSync(stagingRoot)!==resolve(stagingRoot)){
    fail('staging-unsafe');
  }
  const directory=mkdtempSync(join(stagingRoot,'transaction-'));
  const file=join(directory,manifest.file);
  let source, destination, verified=false;
  try{
    source=await ownedSource(packageFile,uid,MAX_PACKAGE_BYTES);
    destination=await open(file,'wx',0o600);
    const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);
    let size=0;
    for(;;){
      const {bytesRead}=await source.read(buffer,0,buffer.length,null);if(!bytesRead)break;
      size+=bytesRead;if(size>manifest.size)fail('package-integrity');
      const chunk=buffer.subarray(0,bytesRead);hash.update(chunk);await destination.writeFile(chunk);
    }
    if(size!==manifest.size||hash.digest('hex')!==manifest.sha256)fail('package-integrity');
    await destination.sync();
    verified=true;
    return {file,directory,manifest};
  }finally{
    await source?.close();
    await destination?.close();
    if(!verified)rmSync(directory,{recursive:true,force:true});
  }
}

export function validatePackageInfo(text,manifest){
  const fields=new Map();
  for(const line of text.split('\n')){
    const match=/^([a-z][a-z0-9_]*) = (.*)$/.exec(line);if(!match)continue;
    const values=fields.get(match[1])??[];values.push(match[2]);fields.set(match[1],values);
  }
  const exactly=(key,value)=>fields.get(key)?.length===1&&fields.get(key)[0]===value;
  if(!exactly('pkgname',PACKAGE_NAME)||!exactly('pkgver',`${manifest.version}-${manifest.pkgrel}`)||!exactly('arch',manifest.arch))fail('package-identity');
  const dependencies=fields.get('depend')??[];
  if(dependencies.length>256||dependencies.some(value=>!value||value.length>256||/[\0\r\n]/.test(value)))fail('package-identity');
  if(fields.has('replaces')||fields.has('conflict'))fail('system-package-change');
  return {dependencies};
}

function rootOwnedPath(file){
  for(let current=resolve(file);;current=dirname(current)){
    const stat=lstatSync(current);
    if(stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o022))fail('installed-trust-unsafe');
    if(current===dirname(current))break;
  }
}

export function assertProductStopped(proc='/proc'){
  for(const name of readdirSync(proc)){
    if(!/^\d+$/.test(name)||+name===process.pid)continue;
    try{
      const executable=readlinkSync(join(proc,name,'exe')).replace(/ \(deleted\)$/,'');
      if(executable.startsWith(`${INSTALL_ROOT}/`))fail('application-running');
      // The service launcher is system Node; identify its exact installed entry.
      const args=readFileSync(join(proc,name,'cmdline')).toString('utf8').split('\0');
      if(args.includes(`${INSTALL_ROOT}/run-service.mjs`)||args.some(arg=>arg.startsWith(`${INSTALL_ROOT}/resources/app.asar/`)))fail('service-running');
    }catch(error){if(!['ENOENT','ESRCH','EINVAL'].includes(error.code))throw error;}
  }
}

function systemTool(binary,args){
  const result=spawnSync(binary,args,{encoding:'utf8',timeout:15000,maxBuffer:131072,env:{PATH:'/usr/bin',LC_ALL:'C'}});
  return result;
}

export function installationPreflight(staged,run=systemTool,dbLock='/var/lib/pacman/db.lck'){
  if(existsSync(dbLock))fail('pacman-busy');
  const installed=run('/usr/bin/pacman',['-Q',PACKAGE_NAME]);
  const current=installed.status===0?parseVersion(installed.stdout.trim().split(/\s+/)[1]):null;
  if(!current)fail('installed-version-unknown');
  if(compareVersions(staged.manifest.parsedVersion,current)<=0)fail('downgrade-or-equal');
  const info=run('/usr/bin/bsdtar',['-xOf',staged.file,'.PKGINFO']);
  if(info.status!==0)fail('package-metadata');
  const {dependencies}=validatePackageInfo(info.stdout,staged.manifest);
  if(dependencies.length&&run('/usr/bin/pacman',['-T','--',...dependencies]).status!==0)fail('dependencies-unsatisfied');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  let staged, installLock;
  const report=(state,reason)=>console.log(JSON.stringify({schema:1,state,reason,transaction:staged?basename(staged.directory):null}));
  const journal=state=>{
    const target=join(staged.directory,'transaction.json');
    const temporary=`${target}.${process.pid}.tmp`;
    writeFileSync(temporary,JSON.stringify({schema:1,state,version:formatVersion(staged.manifest.parsedVersion),sha256:staged.manifest.sha256,at:new Date().toISOString()}),{mode:0o600,flag:'wx',flush:true});
    renameSync(temporary,target);
  };
  try{
    if(process.platform!=='linux'||process.arch!=='x64'||process.getuid()!==0)fail('authorisation-required');
    const uid=Number(process.env.PKEXEC_UID);
    const [packageFile,manifestFile,signatureFile,expectedSha256,...extra]=process.argv.slice(2);
    if(!Number.isSafeInteger(uid)||uid<1||extra.length||!/^[a-f0-9]{64}$/.test(expectedSha256??''))fail('arguments');
    if(resolve(fileURLToPath(import.meta.url))!==`${INSTALL_ROOT}/update-install-helper.mjs`)fail('helper-not-installed');
    for(const file of ['update-install-helper.mjs','updater.mjs','update-channel.json'])rootOwnedPath(join(INSTALL_ROOT,file));
    if(!process.stdin.isTTY||!process.stdout.isTTY)fail('terminal-required');
    const stagingRoot='/var/cache/cybersafe-assistant-linux-lite/updates';
    mkdirSync(stagingRoot,{recursive:true,mode:0o700});rootOwnedPath(stagingRoot);
    const lockDirectory=join(stagingRoot,'.install.lock');
    try { mkdirSync(lockDirectory,{mode:0o700}); }
    catch(error){if(error.code==='EEXIST')fail('installation-busy-or-interrupted');throw error;}
    installLock=lockDirectory;
    assertProductStopped();
    staged=await stageVerifiedPackage({packageFile,manifestFile,signatureFile,expectedSha256,uid,config:loadChannelConfig(),stagingRoot});
    journal('verified');installationPreflight(staged);assertProductStopped();
    journal('installing');
    const result=await new Promise((ok,ko)=>{
      const child=spawn('/usr/bin/pacman',['-U','--',staged.file],{stdio:'inherit',env:{PATH:'/usr/bin',LC_ALL:'C'}});
      child.once('error',ko);child.once('exit',(code,signal)=>ok({code,signal}));
    });
    if(result.code!==0||result.signal)fail('package-installation-failed');
    const after=systemTool('/usr/bin/pacman',['-Q',PACKAGE_NAME]);
    if(after.status!==0||after.stdout.trim()!==`${PACKAGE_NAME} ${formatVersion(staged.manifest.parsedVersion)}`)fail('installed-version-mismatch');
    journal('installed-health-pending');report('installed','restart-and-health-required');
  }catch(error){
    try{if(staged)journal('failed');}catch{report('error','journal-write-failed');}
    report('error',/^[a-z][a-z0-9-]+$/.test(error.code??'')?error.code:'installation-error');process.exitCode=1;
  }finally{
    if(installLock){try{rmdirSync(installLock);}catch{report('error','installation-lock-cleanup');process.exitCode=1;}}
  }
}
