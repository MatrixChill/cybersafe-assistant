import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import {pathToFileURL} from "node:url";
import ts from "typescript";
const read=name=>fs.readFile(new URL(`../../desktop/src/${name}`,import.meta.url),"utf8");
const compile=(source,module=ts.ModuleKind.CommonJS)=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module}}).outputText;
const load=async name=>import(`data:text/javascript;base64,${Buffer.from(compile(await read(name),ts.ModuleKind.ES2022)).toString("base64")}`);
const {trustedIpcHandler,guardedServiceRequest,reportWindowPreferences}=await load("ipc-guard.ts");
const {createTrayQuickScan}=await load("tray-menu.ts");
const source=await read("main.ts");
const ast=ts.createSourceFile("main.ts",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const fn=name=>ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast);
const preload=await read("preload.ts");
function fixture(){
 const handlers=new Map(), effects=[], listeners=new Map();
 const frame={url:"http://localhost:5173/"};const contents={mainFrame:frame,isDestroyed:()=>false};
 const sandbox={ipcRegistered:false,isQuitting:false,ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},
  mainWindow:{webContents:contents},app:{isPackaged:false},process:{platform:"win32"},path,pathToFileURL,__dirname:"fixture-only",
  trustedIpcHandler,guardedServiceRequest,reportWindowPreferences,
  // Seam do fixture (pre-existente): registerIpc chama este registo no arranque;
  // o canal de credenciais de IA não é exercido por este teste.
  registerAiCredentialsIpc:()=>{},currentAiStore:{},registerProcessTerminationIpc:()=>{},
  client:{request:async(topic,payload)=>{effects.push([topic,payload]);return {id:payload?.id,status:"completed"};}},
 };
 vm.runInNewContext(compile(fn("registerIpc"))+"\nregisterIpc();",sandbox);
 const event={sender:contents,senderFrame:frame};let api;
 vm.runInNewContext(compile(preload),{queueMicrotask,process:{env:{}},require:()=>({
  contextBridge:{exposeInMainWorld:(_name,value)=>{api=value;}},webUtils:{},
  ipcRenderer:{invoke:(name,...args)=>Promise.resolve().then(()=>handlers.get(name)(event,...args)),
   on:(name,callback)=>listeners.set(name,callback),removeListener:(name)=>listeners.delete(name)},
 })});
 return {api,event,frame,effects,listeners};
}
test("novo getLast atravessa preload e handler real; origem remota tem zero efeitos",async()=>{
 const f=fixture();
 const result=await f.api.getLastScan("fixture-id");
 assert.equal(result.id,"fixture-id");assert.equal(f.effects.length,1);
 assert.equal(f.effects[0][0],"scan.getLast");assert.equal(f.effects[0][1].id,"fixture-id");
 f.frame.url="https://attacker.invalid/";
 await assert.rejects(f.api.getLastScan("fixture-id"),/Emissor IPC não autorizado/);
 assert.equal(f.effects.length,1);
});
test("entrega real do preload sobrevive à montagem tardia e unsubscribe corta callbacks",async()=>{
 const f=fixture();const received=[];
 const delivery={state:{id:"fixture-id",status:"running"}};
 f.listeners.get("app:scan-session")({sender:"PRIVILEGED_EVENT_MUST_NOT_ESCAPE"},delivery);
 const unsubscribe=f.api.onScanSession((...args)=>received.push(args));
 await new Promise(resolve=>queueMicrotask(resolve));
 assert.equal(received.length,1);assert.equal(received[0].length,1);assert.equal(received[0][0],delivery);
 unsubscribe();f.listeners.get("app:scan-session")({}, {error:"FALHA_FICTICIA"});
 assert.equal(received.length,1);
});
test("handler real do main abre scanner e entrega a sessão confirmada pelo tray",async()=>{
 const messages=[];let opens=0;const topics=[];
 const state={id:"fixture-id",type:"quick",status:"running",filesScanned:2,threatsFound:0,progress:40};
 const declaration=ast.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)==="runTrayQuickScan")).getText(ast);
 const sandbox={createTrayQuickScan,isQuitting:false,console,
  showWindow:()=>opens++,mainWindow:{isDestroyed:()=>false,webContents:{isLoading:()=>false,send:(...args)=>messages.push(args)}},
  client:{request:async(topic)=>{topics.push(topic);return state;}},
 };
 vm.runInNewContext(compile(fn("sendToRenderer")+"\n"+declaration+"\n"+fn("trayActionHandlers"))+"\ntrayActionHandlers().quickScan();",sandbox);
 for(let n=0;n<20&&!messages.some(m=>m[0]==="app:scan-session");n++)await new Promise(r=>setTimeout(r,1));
 assert.equal(opens,1);assert.ok(messages.some(m=>m[0]==="app:navigate"&&m[1]==="scanner"));
 assert.equal(messages.find(m=>m[0]==="app:scan-session")[1].state.id,"fixture-id");
 assert.deepEqual(topics,["scan.getActive"],"active adoption never sends scan.start");
});
