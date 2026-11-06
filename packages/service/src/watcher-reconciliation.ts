import * as fs from 'node:fs/promises';
import path from 'node:path';

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
