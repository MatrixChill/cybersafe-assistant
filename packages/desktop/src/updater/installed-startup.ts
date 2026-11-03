import type {UpdateJournal} from './install-journal.js';
/** Startup reconciliation never launches an installer or restores data automatically. */
export async function reconcileInstalledUpdate(options:{journal:UpdateJournal;installedVersion:string;dataReady:()=>Promise<boolean>;isQuitting?:()=>boolean;timeoutMs?:number}) {
  let operation=options.journal.reconcileHandoff();
  if(!operation||operation.stage==='completed'||operation.stage==='recovery-required')return operation;
  const deadline=Date.now()+(options.timeoutMs??15000);
  while((operation.stage==='shutdown'||operation.stage==='installing')&&Date.now()<deadline){
    if(options.isQuitting?.())return operation;
    await new Promise(resolve=>setTimeout(resolve,100));
    operation=options.journal.reconcileHandoff();
    if(!operation)return null;
  }
  if(options.isQuitting?.())return operation;
  if(operation.stage==='awaiting-start'){
    let ready=false;try{ready=await options.dataReady();}catch{/* unknown is not ready */}
    if(options.isQuitting?.())return operation;
    return options.journal.confirmStartup(operation.id,operation.startupToken,options.installedVersion,ready);
  }
  if(operation.stage==='completed'||operation.stage==='recovery-required')return operation;
  return options.journal.recoverInterrupted();
}
