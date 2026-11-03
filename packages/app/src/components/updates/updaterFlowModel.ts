import type {UpdatesViewState} from "./appUpdateController";
import {deriveControls,errorCodeMessage} from "./appUpdateModel";
import {mapUpdaterSnapshot,type UpdaterWindowView} from "./updaterWindowModel";

/** State-to-view adapter; does not call IPC, derive trust or infer installation success. */
export function deriveUpdaterFlow(state:UpdatesViewState):UpdaterWindowView {
 const {snapshot,busy,bridgeAvailable,loading,actionError}=state;
 if(!snapshot){
  return {phase:actionError?"error":bridgeAvailable?"idle":"unavailable",currentVersion:"",percent:null,cancelable:false,
   primaryAction:bridgeAvailable&&!loading&&actionError?"retry":undefined,
   detail:actionError?errorCodeMessage(actionError.code):loading?"A consultar o estado do atualizador…":undefined};
 }
 const view=mapUpdaterSnapshot(snapshot);
 const controls=deriveControls(snapshot,busy,bridgeAvailable);
 view.cancelable=bridgeAvailable&&(snapshot.status==="downloading"||snapshot.status==="verifying")&&(busy===null||busy==="download"||busy==="check");
 const allowedActions={
  download:controls.download,install:controls.install,check:controls.check,
  retry:busy===null&&bridgeAvailable,open:false,
 };
 if(view.primaryAction&&!allowedActions[view.primaryAction])view.primaryAction=undefined;
 if(actionError){view.detail=errorCodeMessage(actionError.code);}
 return view;
}
export function canConfirmUpdaterInstall(state:UpdatesViewState,expectedVersion:string):boolean {
 return expectedVersion.length>0&&state.snapshot?.latest?.version===expectedVersion&&deriveControls(state.snapshot,state.busy,state.bridgeAvailable).install;
}
