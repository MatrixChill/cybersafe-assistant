import test from 'node:test';
import assert from 'node:assert/strict';
import { configureLinuxSecretStore } from '../src/linux-secret-store.ts';

test('Nigor selects Secret Service before ready, preserving explicit backend choices',()=>{
 const switches=new Map();const app={commandLine:{hasSwitch:k=>switches.has(k),appendSwitch:(k,v)=>switches.set(k,v)}};
 configureLinuxSecretStore(app,{platform:'linux',desktop:'Nigor'});assert.equal(switches.get('password-store'),'gnome-libsecret');
 switches.set('password-store','kwallet6');configureLinuxSecretStore(app,{platform:'linux',desktop:'Nigor'});assert.equal(switches.get('password-store'),'kwallet6');
 switches.clear();configureLinuxSecretStore(app,{platform:'win32',desktop:'Nigor'});assert.equal(switches.size,0);
 configureLinuxSecretStore(app,{platform:'linux',desktop:'KDE'});assert.equal(switches.size,0);
});
