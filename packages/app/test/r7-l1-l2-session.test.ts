import { test } from "node:test";
import assert from "node:assert/strict";
import * as session from "../src/lib/scanSession";
import type { ScanState } from "@cybersafe/shared-types";
const state = (extra: Partial<ScanState> = {}): ScanState => ({ id:"one", type:"quick", status:"running", phase:"scanning", progress:20, filesScanned:1, threatsFound:0, startTime:"2026-10-12T12:00:00Z", updatedAt:new Date().toISOString(), revision:2, ...extra });
test("A: sessão do tray é adotada sem id esperado e acompanha progresso real", () => {
  const attach = session.decideScanAttachment;
  assert.equal(typeof attach, "function");
  const current = attach(null, state());
  assert.equal(current?.id, "one");
  assert.equal(attach(current, state({revision:3,filesScanned:2}))?.filesScanned, 2);
});
test("C/D/E: terminal regressa como resultado, nunca como recuperação viva", async () => {
  assert.equal(typeof session.readScanSnapshot, "function");
  for (const status of ["completed","cancelled","failed"] as const) {
    const terminal = state({status, endTime:"2026-10-12T12:01:00Z"});
    const result = await session.readScanSnapshot({getActiveScan:async()=>null,getLastScan:async()=>terminal});
    assert.equal(session.decideScanAttachment(null,result)?.status,status);
    assert.equal(session.decideScanRecovery(result), null);
  }
});
test("F: evento/resultado antigo e revisão antiga não substituem sessão nova", () => {
  assert.equal(typeof session.decideScanAttachment,"function");
  const newer = state({id:"two",startTime:"2026-10-12T12:02:00Z"});
  assert.equal(session.decideScanAttachment(newer,state({status:"completed"})),null);
  assert.equal(session.decideScanAttachment(newer,{...newer,revision:1}),null);
  assert.equal(session.decideScanAttachment(state({status:"cancelled"}),state()),null);
});
test("D: snapshot terminal antigo perde para sessão viva entretanto iniciada", async () => {
  assert.equal(typeof session.readScanSnapshot,"function");
  let reads=0;
  const live=state({id:"two",startTime:"2026-10-12T12:02:00Z"});
  const result=await session.readScanSnapshot({getActiveScan:async()=>++reads===1?null:live,getLastScan:async()=>state({status:"completed"})});
  assert.equal(result?.id,"two");
});
test("L: erro IPC é propagado sem fabricar estado idle ou failed", async () => {
  assert.equal(typeof session.readScanSnapshot,"function");
  await assert.rejects(session.readScanSnapshot({getActiveScan:async()=>{throw new Error("IPC indisponível");},getLastScan:async()=>null}),/IPC indisponível/);
});

test("F: terminal cancelado e duplicados nunca são reescritos",()=>{
 const terminal=state({status:"cancelled",revision:8});
 assert.equal(session.decideScanAttachment(terminal,{...terminal,status:"completed",revision:9}),null);
 assert.equal(session.decideScanAttachment(terminal,{...terminal}),null);
});
test("F: sessões no mesmo milissegundo usam ordem real do serviço",()=>{
 const old=state({sessionSequence:1,status:"completed"});
 const next=state({id:"two",sessionSequence:2});
 assert.equal(session.decideScanAttachment(old,next)?.id,"two");
 assert.equal(session.decideScanAttachment(next,old),null);
});
