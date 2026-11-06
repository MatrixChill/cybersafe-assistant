import * as fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Revisão RECENTE (v0.2.3): depois de um sinal sem nome, só os ficheiros criados,
 * modificados ou alterados desde `sinceMs` são analisados. O modo completo abaixo
 * reanalisava a pasta inteira com teto de 32 ficheiros e falhava em Downloads,
 * Desktop ou Temp reais — a lacuna ficava para sempre (159 sinais no notebook).
 * Links e ficheiros especiais são saltados (as junções existem em pastas normais).
 * Confirma só se o conjunto recente não mudou e não apareceram outros entretanto.
 */
export async function reconcileRecentWatcherRoot(
 root: string, sinceMs: number, analyze: (file: string)=>Promise<boolean>, signal: AbortSignal,
 limits: { maxEntries?: number; maxMs?: number; maxFiles?: number; maxBytes?: number } = {},
): Promise<boolean> {
 const maxEntries=limits.maxEntries??5_000, maxMs=limits.maxMs??10_000, maxFiles=limits.maxFiles??200, maxBytes=limits.maxBytes??256*1024*1024;
 const recentes=async()=>{
  const files=new Map<string,string>();let entries=0,bytes=0;const started=Date.now();
  const rootStat=await fs.lstat(root);if(!rootStat.isDirectory() || rootStat.isSymbolicLink())throw Error('unsafe-root');
  const pending=[root];
  while(pending.length>0){
   if(signal.aborted || Date.now()-started>maxMs)throw Error('budget');
   const dir=pending.pop()!;
   let dirents: import('node:fs').Dirent[];
   try{dirents=await fs.readdir(dir,{withFileTypes:true});}catch{if(dir===root)throw Error('root-unreadable');continue;}
   for(const entry of dirents){
    if(++entries>maxEntries)throw Error('entry-budget');
    if(entry.isSymbolicLink())continue;
    const file=path.join(dir,entry.name);
    if(entry.isDirectory()){pending.push(file);continue;}
    if(!entry.isFile())continue;
    let st: import('node:fs').Stats;try{st=await fs.lstat(file);}catch{continue;}
    if(Math.max(st.mtimeMs,st.ctimeMs,st.birthtimeMs)<sinceMs)continue;
    bytes+=st.size;if(files.size>=maxFiles || bytes>maxBytes)throw Error('file-budget');
    files.set(file,`${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`);
   }
  }
  return files;
 };
 try{
  const before=await recentes();
  for(const file of before.keys())if(signal.aborted || !await analyze(file))return false;
  const after=await recentes();
  return !signal.aborted && before.size===after.size && [...before].every(([file,version])=>after.get(file)===version);
 }catch{return false;}
}

/** A bounded current snapshot, never a certificate of historical event delivery. */
export async function reconcileWatcherRoot(root: string, analyze: (file: string)=>Promise<boolean>, signal: AbortSignal): Promise<boolean> {
 const snapshot=async()=>{
  const files=new Map<string,string>();let entries=0,bytes=0;const started=Date.now();
  const walk=async(dir:string,depth:number):Promise<void>=>{
   if(signal.aborted || depth>8 || Date.now()-started>2000)throw Error('budget');
   const stat=await fs.lstat(dir);if(!stat.isDirectory() || stat.isSymbolicLink())throw Error('unsafe-root');
   for await (const entry of await fs.opendir(dir)){
    if(++entries>256)throw Error('entry-budget');
    const file=path.join(dir,entry.name);const st=await fs.lstat(file);
    if(st.isSymbolicLink())throw Error('link');
    if(st.isDirectory()){await walk(file,depth+1);continue;}
    if(!st.isFile())throw Error('special-file');
    bytes+=st.size;if(files.size>=32 || bytes>16*1024*1024)throw Error('file-budget');
    files.set(file,`${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`);
   }
  };await walk(root,0);return files;
 };
 try{
  const before=await snapshot();
  for(const file of before.keys())if(signal.aborted || !await analyze(file))return false;
  const after=await snapshot();
  return !signal.aborted && before.size===after.size && [...before].every(([file,version])=>after.get(file)===version);
 }catch{return false;}
}

export class WatcherReconciler {
 private entries=new Map<string,{revision:number,timer:ReturnType<typeof setTimeout>}>();
 private epoch=0;
 private busy=false;
 constructor(private readonly reconcile:(root:string)=>Promise<boolean>,private readonly confirmed:(root:string)=>void){}
 schedule(root:string):void{
  const old=this.entries.get(root);if(!old && this.entries.size>=32)return;
  if(old)clearTimeout(old.timer);
  const revision=(old?.revision??0)+1,epoch=this.epoch;
  const timer=setTimeout(()=>{void (async()=>{
   if(this.busy){this.schedule(root);return;}
   this.busy=true;let success=false;
   try{success=await this.reconcile(root);}finally{this.busy=false;}
   if(epoch!==this.epoch || this.entries.get(root)?.revision!==revision)return;
   this.entries.delete(root);if(success)this.confirmed(root);
  })().catch(()=>{if(epoch===this.epoch && this.entries.get(root)?.revision===revision)this.entries.delete(root);});},3000);
  timer.unref();this.entries.set(root,{revision,timer});
 }
 clear():void{this.epoch++;for(const {timer} of this.entries.values())clearTimeout(timer);this.entries.clear();}
}
