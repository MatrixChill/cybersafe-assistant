import test from "node:test";
import assert from "node:assert/strict";
import {prepareIndividualTermination,confirmIndividualTermination,type IndividualTerminationBridge} from "../src/lib/individualProcessTermination";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {KillConfirmModal} from "../src/pages/TaskManagerPage";
const selection={pid:12345,startedAt:"2026-10-30T08:00:00.0000000Z"};
function bridge() {
 let confirmed=0,cancelled=0;
 const api:IndividualTerminationBridge={prepareProcessTermination:async()=>({ok:true,ticket:"test",target:{...selection,name:"notepad.exe"},expiresAt:Date.now()+60000}),
 confirmProcessTermination:async()=>{confirmed++;return {success:true,status:"killed",pid:12345,confirmation:"handle-signaled",scope:"single-process"}},cancelProcessTermination:async()=>{cancelled++;}};
 return {api,get confirmed(){return confirmed},get cancelled(){return cancelled}};
}
test("selection alone and cancellation never send confirm",async()=>{const f=bridge();const p=await prepareIndividualTermination(f.api,selection);assert.ok(p.ok);await f.api.cancelProcessTermination(p.ticket);assert.equal(f.confirmed,0);assert.equal(f.cancelled,1)});
test("explicit confirmation consumes one request and releases the ticket",async()=>{const f=bridge();assert.equal((await confirmIndividualTermination(f.api,"test",12345)).status,"killed");assert.equal(f.confirmed,1);assert.equal(f.cancelled,1)});
test("IPC failure never retries or claims success",async()=>{const f=bridge();f.api.confirmProcessTermination=async()=>{throw Error("IPC disconnected")};await assert.rejects(()=>confirmIndividualTermination(f.api,"test",12345));assert.equal(f.cancelled,1)});
test("late prepare is cancelled and never invokes termination",async()=>{const f=bridge();f.api.prepareProcessTermination=async()=>{await new Promise(r=>setTimeout(r,20));return {ok:true,ticket:"late",target:{...selection,name:"x"},expiresAt:Date.now()+1000}};assert.equal((await prepareIndividualTermination(f.api,selection,1)).ok,false);await new Promise(r=>setTimeout(r,30));assert.equal(f.cancelled,1);assert.equal(f.confirmed,0)});
test("status killed without proof or wrong PID is rejected",async()=>{const f=bridge();f.api.confirmProcessTermination=async()=>({success:true,status:"killed",pid:12345});assert.equal((await confirmIndividualTermination(f.api,"test",12345)).success,false);f.api.confirmProcessTermination=async()=>({success:true,status:"killed",pid:54321,confirmation:"handle-signaled",scope:"single-process"});assert.equal((await confirmIndividualTermination(f.api,"test",12345)).success,false)});
test("real modal identifies target and warns about data, without claiming tree termination",()=>{const html=renderToStaticMarkup(createElement(KillConfirmModal,{target:{...selection,name:"notepad.exe",memoryMb:10},isKilling:false,onCancel(){},onConfirm(){}}));assert.match(html,/notepad.exe/);assert.match(html,/12345/);assert.match(html,/dados não guardados/);assert.match(html,/filhos não serão terminados/);assert.match(html,/alertdialog/);assert.match(html,/Cancelar/)});
