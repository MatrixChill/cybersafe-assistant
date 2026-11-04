import {useEffect,useRef,useState} from "react";
import type {UpdatesActions,UpdatesViewState} from "./appUpdateController";
import {deriveUpdaterFlow,canConfirmUpdaterInstall,dispatchUpdaterAction} from "./updaterFlowModel";
import {UpdaterExperience} from "./UpdaterExperience";
import {InstallConfirmDialog} from "./InstallConfirmDialog";
import type {UpdaterAction} from "./updaterWindowModel";

/** One snapshot/controller shared with Settings. Closing only hides the presentation. */
export function UpdaterFlow({state,actions,onClose}:{state:UpdatesViewState;actions:UpdatesActions;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 const [confirmation,setConfirmation]=useState<{version:string;channel:"stable"|"preview"}|null>(null);
 const view=deriveUpdaterFlow(state);
 useEffect(()=>{
  const node=dialog.current;
  if(!node)return;
  node.showModal();
  return ()=>{if(node.open)node.close();};
 },[]);
 function action(request:UpdaterAction){
  // Recompute from current props; a disabled/stale presentation cannot issue another operation.
  dispatchUpdaterAction(request,state,actions,version=>{if(state.snapshot)setConfirmation({version,channel:state.snapshot.channel});});
 }
 return <dialog ref={dialog} className="updater-flow-dialog" aria-label="Atualização do CyberSafe Assistant" onCancel={event=>{event.preventDefault();if(confirmation)setConfirmation(null);else onClose();}}>
  <UpdaterExperience view={view} onAction={action} onCancel={view.cancelable?actions.cancel:undefined} onClose={onClose}/>
  {confirmation!==null&&<InstallConfirmDialog version={confirmation.version} channel={confirmation.channel} podeConfirmar={state.snapshot?.channel===confirmation.channel&&canConfirmUpdaterInstall(state,confirmation.version)} requiresElevation={state.snapshot?.requiresElevation} onCancel={()=>setConfirmation(null)} onConfirm={()=>{if(state.snapshot?.channel!==confirmation.channel||!canConfirmUpdaterInstall(state,confirmation.version))return;actions.install(confirmation.version);setConfirmation(null);}}/>}
 </dialog>;
}
