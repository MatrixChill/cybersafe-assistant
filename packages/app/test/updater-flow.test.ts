import {test} from "node:test";
import assert from "node:assert/strict";
import {deriveUpdaterFlow,canConfirmUpdaterInstall} from "../src/components/updates/updaterFlowModel";
import type {UpdatesViewState} from "../src/components/updates/appUpdateController";
const state:UpdatesViewState={bridgeAvailable:true,loading:false,busy:null,actionError:null,snapshot:{status:"available",channel:"stable",installed:{version:"0.2.0-rc.1"},latest:{version:"0.2.0",publishedAt:"2026-11-03T00:00:00Z",notes:"release"},canInstall:false,automaticCheckEnabled:false}};
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
