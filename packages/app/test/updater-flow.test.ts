import {test} from "node:test";
import assert from "node:assert/strict";
import {deriveUpdaterFlow,canConfirmUpdaterInstall,dispatchUpdaterAction} from "../src/components/updates/updaterFlowModel";
import type {UpdatesViewState} from "../src/components/updates/appUpdateController";
const state:UpdatesViewState={bridgeAvailable:true,loading:false,busy:null,actionError:null,failedOperation:null,snapshot:{status:"available",channel:"stable",installed:{version:"0.2.0-rc.1"},latest:{version:"0.2.0",publishedAt:"2026-11-03T00:00:00Z",notes:"release"},canInstall:false,automaticCheckEnabled:false}};
test("unconfigured real flow cannot download or install",()=>{
 const v=deriveUpdaterFlow({...state,snapshot:{...state.snapshot!,status:"unconfigured"}});assert.equal(v.primaryAction,undefined);assert.equal(v.cancelable,false);
});
test("busy gates actions but keeps cancellation available during transfer",()=>{
 assert.equal(deriveUpdaterFlow({...state,busy:"download"}).primaryAction,undefined);
 assert.equal(deriveUpdaterFlow({...state,busy:"download",snapshot:{...state.snapshot!,status:"downloading"}}).cancelable,true);
 assert.equal(deriveUpdaterFlow({...state,busy:"cancel",snapshot:{...state.snapshot!,status:"downloading"}}).cancelable,false);
});
test("version changes or revoked install permission invalidate confirmation",()=>{
 const ready={...state,snapshot:{...state.snapshot!,status:"downloaded" as const,canInstall:true}};
 assert.equal(canConfirmUpdaterInstall(ready,"0.2.0"),true);
 assert.equal(canConfirmUpdaterInstall(ready,"0.2.1"),false);
 assert.equal(canConfirmUpdaterInstall({...ready,busy:"install"},"0.2.0"),false);
 assert.equal(canConfirmUpdaterInstall({...ready,snapshot:{...ready.snapshot,canInstall:false}},"0.2.0"),false);
});
test("failed snapshot read offers only explicit state retry without pretending a check",()=>{
 const v=deriveUpdaterFlow({...state,snapshot:null,loading:false,actionError:{code:"timeout",message:"ignored"}});
 assert.equal(v.phase,"error");assert.equal(v.primaryAction,"retry");assert.equal(v.percent,null);
});
test("a cancelled download offers the download operation again, not a snapshot refresh",()=>{
 const cancelled={...state,failedOperation:"download" as const,snapshot:{...state.snapshot!,status:"error" as const,error:{code:"cancelled" as const,message:"Operação cancelada."}}};
 const v=deriveUpdaterFlow(cancelled);
 assert.equal(v.primaryAction,"retry-download");
 const calls:string[]=[];
 const actions={refresh:()=>calls.push("refresh"),check:()=>calls.push("check"),download:()=>calls.push("download"),cancel:()=>{},defer:()=>{},install:()=>{},setAutomaticCheck:()=>{}};
 assert.equal(dispatchUpdaterAction("retry-download",cancelled,actions,()=>calls.push("confirm-install")),true);
 assert.deepEqual(calls,["download"]);
});
test("check failures retry the check; snapshot-read failures retry only the read",()=>{
 const failed={...state,failedOperation:"check" as const,snapshot:{...state.snapshot!,status:"error" as const,error:{code:"timeout" as const,message:"timeout"}}};
 assert.equal(deriveUpdaterFlow(failed).primaryAction,"retry-check");
 assert.equal(deriveUpdaterFlow({...state,snapshot:null,loading:false,actionError:{code:"timeout",message:"timeout"}}).primaryAction,"retry");
});
test("installation failures do not offer a blind retry and verification is not cancelable",()=>{
 const failed={...state,failedOperation:"install" as const,snapshot:{...state.snapshot!,status:"error" as const,error:{code:"installation" as const,message:"handoff falhou"}}};
 assert.equal(deriveUpdaterFlow(failed).primaryAction,undefined);
 assert.match(deriveUpdaterFlow(failed).detail??"",/recuperação/);
 const handoff={...state,failedOperation:"install" as const,actionError:{code:"installation" as const,message:"external installation handoff failed (launcher-lock-failed); recovery may be required"}};
 assert.match(deriveUpdaterFlow(handoff).detail??"",/Motivo registado: launcher-lock-failed/);
 assert.doesNotMatch(deriveUpdaterFlow(handoff).detail??"",/etapa/,"o código do motivo não é uma etapa");
 assert.equal(deriveUpdaterFlow({...state,snapshot:{...state.snapshot!,status:"verifying"}}).cancelable,false);
});
