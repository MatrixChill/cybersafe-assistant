/** Bounded independent reads, ordered barriers for mutations. One instance per pipe. */
export class RpcRequestQueue {
  private pending:Array<{read:boolean;work:()=>Promise<void>}>=[];
  private active=0;
  private writing=false;
  private closed=false;
  constructor(private readonly maxReads=4){}
  enqueue(read:boolean,work:()=>Promise<void>):void {if(this.closed)return;this.pending.push({read,work});this.pump();}
  close():void {this.closed=true;this.pending=[];}
  private pump():void {
    if(this.closed||this.writing)return;
    while(this.pending.length&&this.active<this.maxReads){
      const next=this.pending[0];if(!next.read&&this.active>0)return;
      this.pending.shift();this.active++;if(!next.read)this.writing=true;
      void new Promise<void>(resolve => setImmediate(resolve)).then(() => { if (!this.closed) return next.work(); }).catch(()=>{}).finally(()=>{this.active--;if(!next.read)this.writing=false;this.pump();});
      if(!next.read)return;
    }
  }
}
export const INDEPENDENT_READ_METHODS:ReadonlySet<string>=new Set([
  'protection.getState','events.list','threats.list','processes.list','connections.list',
  'quarantine.list','pcstate.get','hardware.snapshot','windows.healthSnapshot',
]);
