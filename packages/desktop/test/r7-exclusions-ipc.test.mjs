import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {CANAIS_PERMITIDOS, CANAIS_NEGADOS} from '../src/dev-windows-readonly-boundary.ts';

test('preload entrega apenas os canais de exclusões e respeita shutdown',async()=>{
  let bridge;const calls=[];
  const code=ts.transpileModule(fs.readFileSync(new URL('../src/preload.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(code,{require:name=>{assert.equal(name,'electron');return {
    contextBridge:{exposeInMainWorld:(name,api)=>{if(name==='electronAPI')bridge=api}},
    ipcRenderer:{on(){},invoke:(...args)=>{calls.push(args);return Promise.resolve({success:true})}},webUtils:{},
  }},process:{env:{}},console,URL,setTimeout,clearTimeout});
  const rules=[];
  await bridge.getExclusions();await bridge.updateExclusions({rules});
  assert.deepEqual(calls.map(c=>c[0]),['service:get-exclusions','service:update-exclusions']);
  assert.equal(calls[1][1].rules,rules);
  bridge.beginShutdown();assert.equal(await bridge.updateExclusions({rules}),null);assert.equal(calls.length,2);
});
test('exclusões são leitura permitida e escrita recusada em Windows read-only',()=>{
  assert.equal(CANAIS_PERMITIDOS.has('service:get-exclusions'),true);
  assert.equal(CANAIS_NEGADOS.has('service:update-exclusions'),true);
});

test('main real encaminha exclusões com guardas de emissor e shutdown', async()=>{
  const {trustedIpcHandler,guardedServiceRequest,reportWindowPreferences}=await import('../src/ipc-guard.ts');
  const {registerProcessTerminationIpc}=await import('../src/process-termination-ipc.ts');
  const {registerAiCredentialsIpc}=await import('../src/ai-credentials-ipc.ts');
  const path=await import('node:path');const {pathToFileURL}=await import('node:url');
  const source=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  const ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const register=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='registerIpc');
  assert.ok(register);
  const handlers=new Map(),calls=[];
  const frame={url:'http://localhost:5173/'};const contents={mainFrame:frame,isDestroyed:()=>false};
  const sandbox={ipcRegistered:false,isQuitting:false,
    ipcMain:{handle:(channel,fn)=>handlers.set(channel,fn)},
    mainWindow:{webContents:contents},app:{isPackaged:false},
    path,pathToFileURL,__dirname:path.resolve('synthetic-exclusions','dist'),
    trustedIpcHandler,guardedServiceRequest,reportWindowPreferences,
    registerProcessTerminationIpc,registerAiCredentialsIpc,
    currentAiStore:()=>{throw Error('outside scope')},process:{platform:'win32',execPath:'fixture.exe'},
    client:{request:(...args)=>{calls.push(args);return Promise.resolve({success:true})}},
    preferences:{notificationsEnabled:true},savePreferences(){},
  };
  vm.createContext(sandbox);
  vm.runInContext(ts.transpileModule(register.getText(ast),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText+'\nregisterIpc();',sandbox);
  const event={sender:contents,senderFrame:frame};
  await handlers.get('service:get-exclusions')(event);
  await handlers.get('service:update-exclusions')(event,{rules:[]});
  assert.equal(JSON.stringify(calls),JSON.stringify([['exclusions.get',undefined],['exclusions.update',{rules:[]}]]));
  frame.url='https://untrusted.invalid/';
  assert.throws(()=>handlers.get('service:update-exclusions')(event,{rules:[]}),/autorizado/i);
  frame.url='http://localhost:5173/';sandbox.isQuitting=true;
  assert.equal(await handlers.get('service:update-exclusions')(event,{rules:[]}),null);
  assert.equal(calls.length,2);
});
