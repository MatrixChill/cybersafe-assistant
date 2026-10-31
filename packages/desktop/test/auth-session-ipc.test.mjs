import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(file){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,URL});return exports;}
const {trustedIpcHandler}=load('ipc-guard.ts');
const {registerAuthSessionIpc}=load('auth-session-ipc.ts');
test('auth IPC rejects other windows, subframes and documents before storage access',()=>{
 const frame={url:'file:///audit/index.html'},contents={mainFrame:frame,isDestroyed:()=>false};
 const handlers=new Map();let calls=0;
 const store={read(){calls++;return 'public.fixture.signature'},write(){calls++},clear(){calls++}};
 registerAuthSessionIpc((channel,handler)=>handlers.set(channel,trustedIpcHandler(()=>contents,()=>frame.url,handler)),()=>store);
 assert.deepEqual([...handlers.keys()],['auth-session:read','auth-session:write','auth-session:clear']);
 const bad=[{sender:{},senderFrame:frame},{sender:contents,senderFrame:{url:frame.url}},{sender:contents,senderFrame:null}];
 for(const event of bad)for(const handler of handlers.values())assert.throws(()=>handler(event));
 const old=frame.url;frame.url='https://untrusted.invalid/';
 // Expected URL is an immutable shell document, not the peer's URL.
 const guard=trustedIpcHandler(()=>contents,()=>old,()=>{calls++});
 assert.throws(()=>guard({sender:contents,senderFrame:frame}));frame.url=old;
 assert.equal(calls,0);
 const event={sender:contents,senderFrame:frame};
 assert.equal(handlers.get('auth-session:read')(event)==='public.fixture.signature',true);
 handlers.get('auth-session:write')(event,'public.fixture.signature',false);handlers.get('auth-session:clear')(event);
 assert.equal(calls,3);
});
test('main wires all auth handlers through the existing sender/document guard',()=>{
 const main=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
 assert.match(main,/registerSession\(handle\)/);
 assert.match(main,/\(handle\) => registerAuthSessionIpc\(handle,/);
 assert.equal((main.match(/ipcMain\.handle\(/g)||[]).length,1);
 assert.match(main,/createAuthSessionStore\(app\.getPath\("userData"\), safeStorage\)/);
});
test('preload rejects writes during shutdown but still permits session invalidation',()=>{
 const source=fs.readFileSync(new URL('../src/preload.ts',import.meta.url),'utf8');
 const snippet=source.slice(source.indexOf('  authSession:'),source.indexOf('  getProtectionState:'));
 assert.match(snippet,/write:.*shuttingDown[\s\S]*Promise\.reject/);
 assert.match(snippet,/clear: \(\) => ipcRenderer\.invoke\("auth-session:clear"\)/);
});
