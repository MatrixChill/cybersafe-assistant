import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function loadPreferences()'),source.indexOf('// RECOVERY-SECURITY-20261014'));
test('automatic update preference survives disk serialization and a fresh load; invalid types stay disabled',()=>{
 let disk='{}';const ctx={preferences:{notificationsEnabled:true,automaticUpdateCheckEnabled:false},VALID_BACKGROUND_MATERIALS:[],settingsFilePath:()=>'/fixture/settings.json',path:{dirname:()=>'/fixture'},fs:{existsSync:()=>true,mkdirSync(){},writeFileSync:(_p,v)=>{disk=v},readFileSync:()=>disk}};
 vm.createContext(ctx);vm.runInContext(code,ctx);ctx.preferences.automaticUpdateCheckEnabled=true;assert.equal(ctx.savePreferences(),true);ctx.preferences={notificationsEnabled:true,automaticUpdateCheckEnabled:false};ctx.loadPreferences();assert.equal(ctx.preferences.automaticUpdateCheckEnabled,true);
 disk='{"automaticUpdateCheckEnabled":"true"}';ctx.preferences.automaticUpdateCheckEnabled=false;ctx.loadPreferences();assert.equal(ctx.preferences.automaticUpdateCheckEnabled,false);
 ctx.fs.writeFileSync=()=>{throw Error('disk full')};assert.equal(ctx.savePreferences(),false);
});
