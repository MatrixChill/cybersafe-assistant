type Job = {fingerprint:string;run:()=>Promise<void>;epoch:number};
/** One running file analysis and a bounded, latest-version queue. */
export class RealtimeFileQueue {
  private pending = new Map<string,Job>();
  /** Downloads e ficheiros acabados de aparecer: entram antes dos restantes. */
  private priorityPending = new Map<string,Job>();
  private recent = new Map<string,{fingerprint:string;at:number}>();
  private running: {key:string;job:Job}|null=null;
  private epoch=0;
  constructor(private readonly capacity=64,private readonly now=Date.now) {}
  get active(){return this.running?1:0;}
  get size(){return this.pending.size + this.priorityPending.size;}
  clear(){this.epoch++;this.pending.clear();this.priorityPending.clear();this.recent.clear();}
  enqueue(key:string,fingerprint:string,run:()=>Promise<void>,priority:'high'|'normal'='normal'):'queued'|'duplicate'|'full' {
    const pending=this.pending.get(key) ?? this.priorityPending.get(key);
    const running=this.running?.key===key && this.running.job.epoch===this.epoch ? this.running.job : undefined;
    const old=this.recent.get(key);
    // Only the latest admitted version can establish a duplicate. An older
    // running/completed version must not hide a change after a different one.
    if(pending ? pending.fingerprint===fingerprint : running ? running.fingerprint===fingerprint
      : old?.fingerprint===fingerprint && this.now()-old.at<10000) {
      // Mesma versao ja em espera normal: um evento high sobe-a de fila. Nao
      // se analisa duas vezes; so se garante que o download nao espera atras
      // de trabalho de fundo.
      if(priority==='high' && this.pending.has(key) && !this.priorityPending.has(key)) {
        this.pending.delete(key);
        this.priorityPending.set(key,{fingerprint,run,epoch:this.epoch});
        this.pump();return 'queued';
      }
      return 'duplicate';
    }
    if(!pending && this.size>=this.capacity) return 'full';
    // Um evento prioritario de um caminho ja em espera sobe-o de fila; um
    // evento normal nunca despromove um prioritario ja admitido.
    let target = priority==='high' ? this.priorityPending : this.pending;
    if(priority==='normal' && this.priorityPending.has(key)) target=this.priorityPending;
    this.pending.delete(key);this.priorityPending.delete(key);
    target.set(key,{fingerprint,run,epoch:this.epoch});this.pump();return 'queued';
  }
  private pump(){
    if(this.running) return;
    const high=this.priorityPending.entries().next().value;
    const next=high ?? this.pending.entries().next().value;if(!next)return;
    const [key,job]=next;(high?this.priorityPending:this.pending).delete(key);this.running={key,job};
    // The async boundary also contains a callback that throws before returning
    // its Promise; that failure must release the only running slot.
    void (async()=>{await job.run();})().then(()=>{
      if(job.epoch===this.epoch){this.recent.delete(key);this.recent.set(key,{fingerprint:job.fingerprint,at:this.now()});while(this.recent.size>256)this.recent.delete(this.recent.keys().next().value!);}
    }).catch(()=>undefined).finally(()=>{this.running=null;this.pump();});
  }
}
