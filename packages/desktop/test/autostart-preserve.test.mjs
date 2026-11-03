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
