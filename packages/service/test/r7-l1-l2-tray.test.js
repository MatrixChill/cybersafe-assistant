import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { ScanManager } from "../dist/scan-manager.js";
import { ProtectionEngineService } from "../dist/engine.js";
const source=await fs.readFile(new URL("../../desktop/src/tray-menu.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const tray=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const uiSource=await fs.readFile(new URL("../../app/src/lib/scanSession.ts",import.meta.url),"utf8");
const uiCompiled=ts.transpileModule(uiSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const ui=await import(`data:text/javascript;base64,${Buffer.from(uiCompiled).toString("base64")}`);
const dispatchFor = manager => {
 const service=Object.create(ProtectionEngineService.prototype);
 service.scanManager=manager;
 return (topic,payload)=>service.dispatch(topic,payload);
};
const wait=async fn=>{for(let n=0;n<400;n++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw new Error("fixture deadline");};
async function fixture(run){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"cybersafe-r7-l1-l2-"));
 const events=[];
 let consume=()=>{};
 const manager=new ScanManager({scanArtifact:async()=>({highRiskCount:0,overallSeverity:"safe"}),emitScanProgress:s=>{const snapshot=structuredClone(s);events.push(snapshot);consume(snapshot);}});
 manager.resolvePathsForScan=async()=>[root];
 try {for(let n=0;n<5;n++)await fs.writeFile(path.join(root,`${n}.txt`),"FICTICIO");await run(manager,events,listener=>{consume=listener;});}
 finally {await wait(()=>manager.currentScanPromise===null);assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith("cybersafe-r7-l1-l2-"));await fs.rm(root,{recursive:true,force:true});}
}
test("controlo positivo: ScanManager real conclui cinco ficheiros temporários",()=>fixture(async(m)=>{
 const id=await m.startScan("quick");await wait(()=>m.getScan(id)?.status==="completed");assert.equal(m.getScan(id).filesScanned,5);
}));
test("A/B: tray inicia/adota sem duplicar e entrega snapshot real",()=>fixture(async(m,events,subscribe)=>{
 assert.equal(typeof tray.createTrayQuickScan,"function");
 let starts=0;const delivered=[];const errors=[];
 let page=null;
 subscribe(state=>{page=ui.decideScanAttachment(page,state)??page;});
 const dispatch=dispatchFor(m);
 const request=async(topic,payload)=>{
  if(topic==="scan.start")starts++;
  return dispatch(topic,payload);
 };
 const quick=tray.createTrayQuickScan(request,s=>{delivered.push(s);page=ui.decideScanAttachment(page,s)??page;},e=>errors.push(e));
 await Promise.all([quick(),quick()]);
 assert.equal(starts,1);assert.equal(delivered.length,1);assert.equal(delivered[0].id,m.getActiveScan().id);
 await quick();assert.equal(starts,1);assert.equal(delivered.length,2);assert.deepEqual(errors,[]);
 assert.equal(page.id,delivered[0].id);
 assert.notEqual(ui.uiStatusForState(page),"idle");
 await wait(()=>page.status==="completed");
 assert.equal(page.filesScanned,5);
 assert.ok(events.some(s=>s.filesScanned>0));
}));
test("C/D/E: terminal retido por id e latest, getActive continua null",()=>fixture(async(m)=>{
 assert.equal(typeof m.getLastScan,"function");
 const id=await m.startScan("quick");m.cancelScan(id);await wait(()=>m.currentScanPromise===null);
 assert.equal(m.getActiveScan(),null);const terminal=m.getLastScan(id);assert.equal(terminal.status,"cancelled");
 assert.equal(m.getLastScan().id,id);assert.equal(ui.decideScanAttachment(null,terminal).status,"cancelled");terminal.filesScanned=999;assert.notEqual(m.getLastScan(id).filesScanned,999);
 assert.equal(m.getLastScan("inexistente"),null);
}));
test("L: falha IPC não anuncia início nem inventa sessão",async()=>{
 assert.equal(typeof tray.createTrayQuickScan,"function");
 let delivered=0;const errors=[];
 const quick=tray.createTrayQuickScan(async()=>{throw new Error("socket closed");},()=>delivered++,e=>errors.push(e));
 assert.equal(await quick(),false);assert.equal(delivered,0);assert.match(errors[0],/serviço de análise/);
});

test("C/D: concluído com página desmontada reaparece pelas decisões reais",()=>fixture(async(m)=>{
 const dispatch=dispatchFor(m);
 const {id}=await dispatch("scan.start",{type:"quick"});
 // No renderer consumer is subscribed while the real worker finishes.
 await wait(()=>m.getScan(id)?.status==="completed");
 const snapshot=await ui.readScanSnapshot({getActiveScan:()=>dispatch("scan.getActive"),getLastScan:id=>dispatch("scan.getLast",{id})});
 const page=ui.decideScanAttachment(null,snapshot);
 assert.equal(page.id,id);assert.equal(page.status,"completed");assert.equal(page.filesScanned,5);
 assert.equal(ui.decideScanRecovery(page),null);
 assert.equal(await dispatch("scan.getActive"),null);
}));
test("C/D: falha real do worker é restaurada, não convertida em idle",()=>fixture(async(m)=>{
 m.resolvePathsForScan=async()=>{throw new Error("SYNTHETIC_ENUMERATION_FAILURE");};
 const dispatch=dispatchFor(m);
 const {id}=await dispatch("scan.start",{type:"quick"});
 await wait(()=>m.getScan(id)?.status==="failed");
 const snapshot=await dispatch("scan.getLast",{id});
 assert.equal(ui.decideScanAttachment(null,snapshot).status,"failed");
 assert.match(snapshot.error,/SYNTHETIC_ENUMERATION_FAILURE/);
 await assert.rejects(dispatch("scan.getLast",{id:42}),/Identificador/);
}));
