import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const body=source.slice(source.indexOf('function configureAutoStart()'),source.indexOf('// O lock de instância',source.indexOf('function configureAutoStart()')));
for(const enabled of [false,true]) test(`startup preserves Windows autostart=${enabled}`,()=>{
 let state=enabled;const writes=[];
 const ctx={process:{platform:'win32',execPath:'CyberSafe.exe',argv:['CyberSafe.exe']},perfil:{autoStart:true},fronteiraLeituraWindows:{activo:false},app:{isPackaged:true,setLoginItemSettings(value){writes.push(value);state=value.openAtLogin}},path:{resolve:x=>x}};
 vm.runInNewContext(body+'\nconfigureAutoStart();configureAutoStart();',ctx);
 assert.equal(state,enabled);assert.deepEqual(writes,[]);
});
const setter=source.slice(source.indexOf('handle("app:set-auto-start"'),source.indexOf('// ── Notifications IPC'));
const setterBody=setter.slice(setter.indexOf('=> {')+3,setter.lastIndexOf('});'));
for(const packaged of [false,true]) test(`IPC write eligibility packaged=${packaged}`,()=>{
 const writes=[];const ctx={process:{platform:'win32',execPath:'CyberSafe.exe'},perfil:{autoStart:true},fronteiraLeituraWindows:{activo:false},app:{isPackaged:packaged,setLoginItemSettings:s=>writes.push(s)}};
 const set=vm.runInNewContext('(config)=>'+setterBody+'}',ctx);
 assert.equal(set({enabled:true,startMinimized:true}).success,packaged);
 assert.equal(writes.length,packaged?1:0);
 if(packaged){assert.equal(writes[0].openAtLogin,true);assert.equal(writes[0].args[0],'--hidden');set({enabled:false,startMinimized:false});assert.equal(writes[1].openAtLogin,false);assert.equal(set({enabled:'true',startMinimized:false}).success,false);assert.equal(writes.length,2);}
});
