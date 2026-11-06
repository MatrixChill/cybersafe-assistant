export type SaturationStage = "metadata" | "analysis";
type Retry = (signal: AbortSignal) => Promise<boolean>;
type Entry = { run: Retry; firstAt: number; attempts: number; revision: number };
/**
 * Ciclo de um caminho AFETADO por saturação, até à análise da versão mais recente:
 *  waiting   rejeitado, repetição de admissão agendada;
 *  given-up  repetição largada/expirada/esgotada sem nenhuma versão admitida;
 *  queued    uma versão (fingerprint) entrou na fila, análise ainda não concluída;
 *  confirmed a análise dessa versão terminou com veredicto e o ficheiro não mudou;
 *  inconclusive a análise terminou sem veredicto (inconclusivo/cancelada);
 *  stale     a análise terminou mas o ficheiro mudou depois da admissão: a
 *            versão atual não está confirmada.
 * Só `confirmed` fecha a lacuna. Admitir não é analisar.
 */
export type TrackedState = "waiting" | "given-up" | "queued" | "confirmed" | "inconclusive" | "stale";
export type AnalysisOutcome = "verdict" | "inconclusive" | "changed";
type Tracked = { state: TrackedState; fingerprint: string | null };
interface Options {
  maxPaths?: number; maxTracked?: number; maxAttempts?: number; maxAgeMs?: number; delayMs?: number; attemptTimeoutMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** Chamado quando o backlog esvazia depois de ter tido caminhos. */
  onIdle?: () => void;
}
/** Contenção adicional: não aumenta a fila de análises, não certifica cobertura.
 * Uma única tentativa de admissão por vez; cada caminho tem prazo e orçamento.
 * Não guarda conteúdo dos ficheiros. clear() invalida callbacks da geração antiga.
 */
export class RealtimeRecovery {
  private readonly entries = new Map<string, Entry>();
  private readonly terminal = new Map<string, number>();
  private readonly affected = new Set<string>();
  /** Caminhos afetados seguidos até à análise da versão mais recente. */
  private readonly tracked = new Map<string, Tracked>();
  /** Afetados que já não cabem no seguimento: contam como não confirmados. */
  private trackedOverflow = 0;
  private failures = 0;
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
  private readonly maxTracked: number;
  private readonly maxAttempts: number;
  private readonly maxAgeMs: number;
  private readonly delayMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<Options["setTimer"]>;
  private readonly clearTimer: NonNullable<Options["clearTimer"]>;
  private readonly onIdle: (() => void) | undefined;
  constructor(options: Options = {}) {
    // Orçamento medido no incidente de 06/11: 863 caminhos numa instalação.
    // Com 128 caminhos e 2 min, 475+ eram largados e 545+ expiravam antes de a
    // fila escoar. O backlog guarda só a chave do caminho (sem conteúdo) e não
    // aumenta a fila nem a concorrência das análises: teto rígido de 4 096
    // caminhos, 15 min de prazo. O que passar daqui conta como não recuperado.
    this.maxPaths = options.maxPaths ?? 4_096; this.maxAttempts = options.maxAttempts ?? 64;
    this.maxAgeMs = options.maxAgeMs ?? 900_000; this.delayMs = options.delayMs ?? 100;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 2_000;
    this.maxTracked = options.maxTracked ?? this.maxPaths * 4;
    for (const value of [this.maxPaths,this.maxTracked,this.maxAttempts,this.maxAgeMs,this.delayMs,this.attemptTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Limite de recuperação inválido");
    }
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn,delay) => {const timer=setTimeout(fn,delay);timer.unref();return timer;});
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.onIdle = options.onIdle;
  }
  defer(path: string, stage: SaturationStage, run: Retry): "scheduled" | "deduplicated" | "full" {
    const key = path.toLowerCase(); const now = this.now();
    this.recordRejection(path, stage);
    for(const [old,until] of this.terminal) if(until<=now)this.terminal.delete(old);
    if((this.terminal.get(key) ?? 0)>now){this.suppressed++;return "full";}
    const entry=this.entries.get(key);
    if(entry){entry.run=run;entry.revision++;return "deduplicated";}
    if(this.entries.size>=this.maxPaths){this.dropped++;this.mark(key,"given-up");return "full";}
    this.mark(key,"waiting");
    this.entries.set(key,{run,firstAt:now,attempts:0,revision:0});this.schedule();return "scheduled";
  }
  recordRejection(path: string, stage: SaturationStage): void {
    const key=path.toLowerCase();
    if(stage==="metadata")this.metadataRejections++;else this.analysisRejections++;
    this.lastEventAt=new Date(this.now()).toISOString();this.lastStage=stage;
    if(this.affected.size<this.maxTracked || this.affected.has(key))this.affected.add(key);else this.affectedCapped=true;
    // Uma versão nova rejeitada torna a anterior irrelevante: volta a esperar.
    const t=this.tracked.get(key);if(t && t.state!=="waiting")t.state=this.entries.has(key)?"waiting":"given-up";
  }
  /** Uma versão (fingerprint) deste caminho entrou na fila — por observação
      nova ou repetição. Só caminhos afetados são seguidos. Cancela a repetição
      pendente; a lacuna só fecha quando a ANÁLISE dessa versão terminar. */
  noteAdmitted(path: string, fingerprint: string): void {
    const key=path.toLowerCase();const t=this.tracked.get(key);if(!t)return;
    if(t.state==="waiting"||t.state==="given-up")this.recovered++;
    // Duplicado de uma versão já analisada com veredicto: não reabre.
    if(t.state==="confirmed" && t.fingerprint===fingerprint)return;
    t.state="queued";t.fingerprint=fingerprint;
    const entry=this.entries.get(key);
    if(entry){this.entries.delete(key);this.terminal.set(key,this.holdUntil(entry));this.idleCheck();}
  }
  /** A análise de `fingerprint` terminou. Ignora versões antigas: se entretanto
      foi admitida outra versão, é essa que tem de ser confirmada. */
  noteAnalyzed(path: string, fingerprint: string, outcome: AnalysisOutcome): void {
    const t=this.tracked.get(path.toLowerCase());
    if(!t || t.state!=="queued" || t.fingerprint!==fingerprint)return;
    t.state=outcome==="verdict"?"confirmed":outcome==="inconclusive"?"inconclusive":"stale";
  }
  /** O ficheiro desapareceu antes de ser analisado: a versão que causou a
      rejeição nunca foi vista. Não se finge confirmação. */
  noteVanished(path: string): void {
    const key=path.toLowerCase();const t=this.tracked.get(key);if(!t)return;
    t.state="stale";const entry=this.entries.get(key);
    if(entry){this.entries.delete(key);this.terminal.set(key,this.holdUntil(entry));this.idleCheck();}
  }
  /** Afinal não é ficheiro (diretório, junction): não há cobertura a confirmar. */
  forget(path: string): void {
    const key=path.toLowerCase();if(!this.tracked.delete(key))return;
    const entry=this.entries.get(key);
    if(entry){this.entries.delete(key);this.terminal.set(key,this.holdUntil(entry));this.idleCheck();}
  }
  /** A fila abriu espaço: tenta já, sem esperar pelo recuo. */
  nudge(): void {
    if(this.busy || this.entries.size===0)return;
    if(this.scheduled){this.clearTimer(this.timer);this.scheduled=false;}
    this.failures=0;this.schedule();
  }
  snapshot(){return {
    metadataRejections:this.metadataRejections,analysisRejections:this.analysisRejections,
    pending:this.entries.size,running:this.busy, recovered:this.recovered,exhausted:this.exhausted,
    expired:this.expired,dropped:this.dropped,suppressed:this.suppressed,cancelled:this.cancelled,
    distinctPaths:this.affected.size,pathsCapped:this.affectedCapped,affectedPaths:[...this.affected],lastEventAt:this.lastEventAt,lastStage:this.lastStage,
    lastEventId:this.metadataRejections+this.analysisRejections,
    ...this.coverageCounts(),
  };}
  /** Desfecho por caminho afetado. `unrecovered` (nenhuma versão admitida) é
      só uma parte da lacuna: `analysisPending`, `inconclusive` e
      `versionUnconfirmed` também impedem confirmar cobertura. */
  private coverageCounts(){
    const c={waiting:0,unrecovered:this.trackedOverflow,analysisPending:0,analysisConfirmed:0,inconclusive:0,versionUnconfirmed:0};
    for(const t of this.tracked.values()){
      if(t.state==="waiting")c.waiting++;else if(t.state==="given-up")c.unrecovered++;
      else if(t.state==="queued")c.analysisPending++;else if(t.state==="confirmed")c.analysisConfirmed++;
      else if(t.state==="inconclusive")c.inconclusive++;else c.versionUnconfirmed++;
    }
    return {...c,trackedCapped:this.trackedOverflow>0};
  }
  clear(): void {
    this.epoch++;this.cancelAttempt?.();if(this.scheduled)this.clearTimer(this.timer);this.scheduled=false;
    this.cancelled+=this.entries.size;this.entries.clear();this.terminal.clear();
    this.tracked.clear();this.trackedOverflow=0;this.failures=0;
  }
  private mark(key:string,state:TrackedState):void{
    const t=this.tracked.get(key);
    if(t){t.state=state;return;}
    // Só chaves e um estado: segue mais caminhos do que o backlog de repetições,
    // para que uma observação nova também feche um caminho já largado.
    if(this.tracked.size<this.maxTracked)this.tracked.set(key,{state,fingerprint:null});else this.trackedOverflow++;
  }
  private idleCheck():void{if(this.entries.size===0 && !this.busy)this.onIdle?.();}
  private schedule(): void {
    if(this.scheduled || this.busy || this.entries.size===0)return;
    this.scheduled=true;const epoch=this.epoch;
    // BACKOFF só depois de uma tentativa recusada: repetir a 100 ms contra a
    // mesma fila cheia gasta CPU. Depois de uma admissão aceite a fila tem
    // espaço, e o recuo antigo (pelo histórico do próximo caminho) deixava o
    // backlog expirar. `nudge()` da fila também zera o recuo.
    const delay=this.failures===0?0:Math.min(this.delayMs*2**Math.min(this.failures-1,6),5_000);
    this.timer=this.setTimer(()=>{if(epoch!==this.epoch)return;this.scheduled=false;void this.attempt();},delay);
  }
  private async attempt(): Promise<void> {
    const next=this.entries.entries().next().value;if(!next || this.busy)return;
    const [key,entry]=next;
    if(this.now()-entry.firstAt>=this.maxAgeMs){this.expired++;this.giveUp(key);this.finish(key,entry);this.schedule();this.idleCheck();return;}
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
        if(accepted && revision===entry.revision){
          this.failures=0;
          // O motor chama noteAdmitted com a fingerprint; sem ela (chamador que
          // não a conhece) a versão fica pendente sem nunca se confirmar.
          const t=this.tracked.get(key);if(t && (t.state==="waiting"||t.state==="given-up")){this.recovered++;t.state="queued";t.fingerprint=null;}
          this.finish(key,entry);}
        else{
          if(!accepted)this.failures++;
          if(entry.attempts>=this.maxAttempts){this.exhausted++;this.giveUp(key);this.finish(key,entry);}
          else{this.entries.delete(key);this.entries.set(key,entry);}
        }
      }
      this.schedule();
      if(epoch===this.epoch)this.idleCheck();
    }
  }
  /** Supressão de repetição por caminho: mantém o teto antigo de 2 min mesmo
      com o prazo de 15 min — um ficheiro reescrito sem parar não volta a
      repetir em cadeia, e uma rejeição suprimida fica como lacuna. */
  private holdUntil(entry:Entry):number{return Math.min(entry.firstAt+this.maxAgeMs,this.now()+120_000);}
  private giveUp(key:string):void{const t=this.tracked.get(key);if(t?.state==="waiting")t.state="given-up";}
  private finish(key:string,entry:Entry):void{
    this.entries.delete(key);this.terminal.set(key,this.holdUntil(entry));
    while(this.terminal.size>this.maxPaths)this.terminal.delete(this.terminal.keys().next().value!);
  }
}
