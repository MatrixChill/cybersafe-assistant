import {test} from 'node:test';
import assert from 'node:assert/strict';
import {windowsAppIdentity} from '../src/app-identity.ts';
test('internal package can declare a distinct notification/taskbar identity',()=>{
 assert.equal(windowsAppIdentity({cybersafeAppId:'com.cybersafe.assistant.internal.vm016'},true),'com.cybersafe.assistant.internal.vm016');
});
test('dev and absent/invalid packaged metadata keep explicit safe defaults',()=>{
 assert.equal(windowsAppIdentity({},false),'com.cybersafe.assistant.dev');
 assert.equal(windowsAppIdentity({},true),'com.cybersafe.assistant');
 for(const value of ['a b','https://host','',null,42])assert.equal(windowsAppIdentity({cybersafeAppId:value},true),'com.cybersafe.assistant');
});
