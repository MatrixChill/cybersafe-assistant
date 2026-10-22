type Job = {fingerprint:string;run:()=>Promise<void>;epoch:number};
/** One running file analysis and a bounded, latest-version queue. */
export class RealtimeFileQueue {
  private pending = new Map<string,Job>();
  private recent = new Map<string,{fingerprint:string;at:number}>();
  private running: {key:string;job:Job}|null=null;
  private epoch=0;
  constructor(private readonly capacity=64,private readonly now=Date.now) {}
  get active(){return this.running?1:0;}
  get size(){return this.pending.size;}
  clear(){this.epoch++;this.pending.clear();this.recent.clear();}
  enqueue(key:string,fingerprint:string,run:()=>Promise<void>):'queued'|'duplicate'|'full' {
    const old=this.recent.get(key);
    if(this.pending.get(key)?.fingerprint===fingerprint || (this.running?.key===key && this.running.job.epoch===this.epoch && this.running.job.fingerprint===fingerprint)
      || (old?.fingerprint===fingerprint && this.now()-old.at<10000)) return 'duplicate';
    if(!this.pending.has(key) && this.pending.size>=this.capacity) return 'full';
    this.pending.set(key,{fingerprint,run,epoch:this.epoch});this.pump();return 'queued';
  }
  private pump(){
    if(this.running) return;
    const next=this.pending.entries().next().value;if(!next)return;
    const [key,job]=next;this.pending.delete(key);this.running={key,job};
    void job.run().then(()=>{
      if(job.epoch===this.epoch){this.recent.delete(key);this.recent.set(key,{fingerprint:job.fingerprint,at:this.now()});while(this.recent.size>256)this.recent.delete(this.recent.keys().next().value!);}
    }).catch(()=>undefined).finally(()=>{this.running=null;this.pump();});
  }
}
