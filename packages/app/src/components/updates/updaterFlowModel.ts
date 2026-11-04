import type {UpdatesActions,UpdatesViewState} from "./appUpdateController";
import {deriveControls,errorCodeMessage} from "./appUpdateModel";
import {mapUpdaterSnapshot,type UpdaterAction,type UpdaterWindowView} from "./updaterWindowModel";

/** State-to-view adapter; does not call IPC, derive trust or infer installation success. */
export function deriveUpdaterFlow(state:UpdatesViewState):UpdaterWindowView {
 const {snapshot,busy,bridgeAvailable,loading,actionError,failedOperation}=state;
 if(!snapshot){
  return {phase:actionError?"error":bridgeAvailable?"idle":"unavailable",currentVersion:"",percent:null,cancelable:false,
   primaryAction:bridgeAvailable&&!loading&&actionError?"retry":undefined,
   detail:actionError?errorCodeMessage(actionError.code):loading?"A consultar o estado do atualizador…":undefined};
 }
 const view=mapUpdaterSnapshot(snapshot);
 const controls=deriveControls(snapshot,busy,bridgeAvailable);
 view.cancelable=bridgeAvailable&&snapshot.status==="downloading"&&(busy===null||busy==="download"||busy==="check");
 if(snapshot.status==="error"){
  if(failedOperation==="install"){
   view.primaryAction=undefined;
   view.detail="A instalação não será repetida automaticamente. Verifique o estado de recuperação antes de iniciar outra instalação.";
  }else if(failedOperation==="download"&&snapshot.latest&&snapshot.error&&["cancelled","offline","timeout","interrupted","integrity"].includes(snapshot.error.code)){
   view.primaryAction="retry-download";
  }else{
   // After app restart the validated in-memory manifest is gone; a fresh check is safe.
   view.primaryAction="retry-check";
  }
 }
 const allowedActions={
  download:controls.download,install:controls.install,check:controls.check,
  retry:busy===null&&bridgeAvailable&&snapshot===null,
  "retry-check":controls.check,
  "retry-download":busy===null&&bridgeAvailable&&snapshot.status==="error"&&snapshot.latest!==undefined,
  open:false,
 };
 if(view.primaryAction&&!allowedActions[view.primaryAction])view.primaryAction=undefined;
 if(actionError){
  const handoff=actionError.code==="installation"&&actionError.message.match(/^external installation handoff failed \(([A-Za-z0-9_.-]{1,100})\); recovery may be required$/);
  const handoffDetail=handoff?`O handoff externo falhou. Motivo registado: ${handoff[1]}.`:errorCodeMessage(actionError.code);
  view.detail=failedOperation==="install"?`${handoffDetail} Verifique o estado de recuperação antes de tentar instalar novamente.`:handoffDetail;
 }
 return view;
}
export function canConfirmUpdaterInstall(state:UpdatesViewState,expectedVersion:string):boolean {
 return expectedVersion.length>0&&state.snapshot?.latest?.version===expectedVersion&&deriveControls(state.snapshot,state.busy,state.bridgeAvailable).install;
}

/** Dispatches only the action currently authorized by the real view state. */
export function dispatchUpdaterAction(request:UpdaterAction,state:UpdatesViewState,actions:UpdatesActions,onConfirmInstall:(version:string)=>void):boolean {
 if(deriveUpdaterFlow(state).primaryAction!==request)return false;
 if(request==="retry")actions.refresh();
 else if(request==="retry-check"||request==="check")actions.check();
 else if(request==="retry-download"||request==="download")actions.download();
 else if(request==="install"&&state.snapshot?.latest)onConfirmInstall(state.snapshot.latest.version);
 else return false;
 return true;
}
