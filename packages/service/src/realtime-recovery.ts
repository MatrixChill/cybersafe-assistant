export type SaturationStage = "metadata" | "analysis";
type Retry = (signal: AbortSignal) => Promise<boolean>;
type Entry = { run: Retry; firstAt: number; attempts: number; revision: number };
interface Options {
  maxPaths?: number; maxAttempts?: number; maxAgeMs?: number; delayMs?: number; attemptTimeoutMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}
/** Contenção adicional: não aumenta a fila de análises, não certifica cobertura.
 * Uma única tentativa de admissão por vez; cada caminho tem prazo e orçamento.
 * Não guarda conteúdo dos ficheiros. clear() invalida callbacks da geração antiga.
 */
export class RealtimeRecovery {
  private readonly entries = new Map<string, Entry>();
  private readonly terminal = new Map<string, number>();
  private readonly affected = new Set<string>();
  private affectedCapped = false;
  private timer: unknown;
  private scheduled = false;
  private busy = false;
  private cancelAttempt: (() => void) | null = null;
  private epoch = 0;
  private metadataRejections = 0;
  private analysisRejections = 0;
  private recovered = 0;
  private exhausted = 0;
  private expired = 0;
  private dropped = 0;
  private suppressed = 0;
  private cancelled = 0;
  private lastEventAt: string | null = null;
  private lastStage: SaturationStage | null = null;
  private readonly maxPaths: number;
  private readonly maxAttempts: number;
  private readonly maxAgeMs: number;
  private readonly delayMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<Options["setTimer"]>;
  private readonly clearTimer: NonNullable<Options["clearTimer"]>;
  constructor(options: Options = {}) {
    this.maxPaths = options.maxPaths ?? 64; this.maxAttempts = options.maxAttempts ?? 3;
    this.maxAgeMs = options.maxAgeMs ?? 30_000; this.delayMs = options.delayMs ?? 100;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 2_000;
    for (const value of [this.maxPaths,this.maxAttempts,this.maxAgeMs,this.delayMs,this.attemptTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Limite de recuperação inválido");
    }
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn,delay) => {const timer=setTimeout(fn,delay);timer.unref();return timer;});
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }
  defer(path: string, stage: SaturationStage, run: Retry): "scheduled" | "deduplicated" | "full" {
    const key = path.toLowerCase(); const now = this.now();
    this.recordRejection(path, stage);
    for(const [old,until] of this.terminal) if(until<=now)this.terminal.delete(old);
    if((this.terminal.get(key) ?? 0)>now){this.suppressed++;return "full";}
    const entry=this.entries.get(key);
    if(entry){entry.run=run;entry.revision++;return "deduplicated";}
    if(this.entries.size>=this.maxPaths){this.dropped++;return "full";}
    this.entries.set(key,{run,firstAt:now,attempts:0,revision:0});this.schedule();return "scheduled";
  }
  recordRejection(path: string, stage: SaturationStage): void {
    const key=path.toLowerCase();
    if(stage==="metadata")this.metadataRejections++;else this.analysisRejections++;
    this.lastEventAt=new Date(this.now()).toISOString();this.lastStage=stage;
    if(this.affected.size<this.maxPaths || this.affected.has(key))this.affected.add(key);else this.affectedCapped=true;
  }
  snapshot(){return {
    metadataRejections:this.metadataRejections,analysisRejections:this.analysisRejections,
    pending:this.entries.size,running:this.busy, recovered:this.recovered,exhausted:this.exhausted,
    expired:this.expired,dropped:this.dropped,suppressed:this.suppressed,cancelled:this.cancelled,
    distinctPaths:this.affected.size,pathsCapped:this.affectedCapped,affectedPaths:[...this.affected],lastEventAt:this.lastEventAt,lastStage:this.lastStage,
    lastEventId:this.metadataRejections+this.analysisRejections,
  };}
  clear(): void {
    this.epoch++;this.cancelAttempt?.();if(this.scheduled)this.clearTimer(this.timer);this.scheduled=false;
    this.cancelled+=this.entries.size;this.entries.clear();this.terminal.clear();
  }
  private schedule(): void {
    if(this.scheduled || this.busy || this.entries.size===0)return;
    this.scheduled=true;const epoch=this.epoch;
    this.timer=this.setTimer(()=>{if(epoch!==this.epoch)return;this.scheduled=false;void this.attempt();},this.delayMs);
  }
  private async attempt(): Promise<void> {
    const next=this.entries.entries().next().value;if(!next || this.busy)return;
    const [key,entry]=next;
    if(this.now()-entry.firstAt>=this.maxAgeMs){this.expired++;this.finish(key,entry);this.schedule();return;}
    this.busy=true;const epoch=this.epoch;const revision=entry.revision;entry.attempts++;
    let accepted=false;
    const controller=new AbortController();
    let deadline: unknown;
    const cancelled=new Promise<boolean>(resolve=>{
      this.cancelAttempt=()=>{controller.abort();resolve(false);};
      deadline=this.setTimer(()=>this.cancelAttempt?.(),this.attemptTimeoutMs);
    });
    try{accepted=await Promise.race([Promise.resolve().then(()=>entry.run(controller.signal)),cancelled]);}
    catch{/* A admissão não foi confirmada. */}
    finally{
      this.clearTimer(deadline);this.cancelAttempt=null;
      this.busy=false;
      if(epoch===this.epoch){
        if(accepted && revision===entry.revision){this.recovered++;this.finish(key,entry);}
        else if(entry.attempts>=this.maxAttempts){this.exhausted++;this.finish(key,entry);}
        else{this.entries.delete(key);this.entries.set(key,entry);}
      }
      this.schedule();
    }
  }
  private finish(key:string,entry:Entry):void{
    this.entries.delete(key);this.terminal.set(key,entry.firstAt+this.maxAgeMs);
    while(this.terminal.size>this.maxPaths)this.terminal.delete(this.terminal.keys().next().value!);
  }
}
