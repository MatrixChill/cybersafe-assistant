import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createNativeNotificationDelivery} from '../src/notification-delivery.ts';
function fixture(options={}){const calls=[],diagnostics=[];let instance;
 class MockNotification extends EventEmitter {constructor(value){super();if(options.constructThrows)throw Error('private path C:/Users/private');calls.push(value);instance=this;}show(){if(options.showThrows)throw Error('private token');this.emit('show');}}
 const deliver=createNativeNotificationDelivery({isSupported:()=>{if(options.supportThrows)throw Error('secret');return options.supported??true;},create:opts=>new MockNotification(opts),notificationsEnabled:()=>options.enabled??true,isQuitting:()=>options.quitting??false,diagnostic:status=>diagnostics.push(status)});
 return {deliver,calls,diagnostics,get instance(){return instance;}};}
test('unsupported notifications record diagnosis, never construct or throw',()=>{const f=fixture({supported:false});f.deliver.notify('Title','body');f.deliver.notify('Title','body');assert.deepEqual(f.diagnostics,['unsupported']);assert.equal(f.calls.length,0);});
test('disabled preference and shutdown never attempt OS delivery',()=>{for(const options of [{enabled:false},{quitting:true}]){const f=fixture(options);f.deliver.notify('Title','body');assert.equal(f.calls.length,0);assert.equal(f.diagnostics.length,0);}});
test('supported attempt hooks failure before show and never reports HUMAN delivery',()=>{const f=fixture();f.deliver.notify('Title','body');assert.deepEqual(f.calls,[{title:'Title',body:'body'}]);assert.deepEqual(f.diagnostics,['accepted']);f.instance.emit('failed',{},'private C:/Users/name');assert.deepEqual(f.diagnostics,['accepted','failed']);assert.doesNotMatch(JSON.stringify(f.diagnostics),/Users|private/);});
test('OS exceptions are contained with technical-only diagnostic',()=>{for(const [options,status] of [[{constructThrows:true},'failed'],[{showThrows:true},'failed'],[{supportThrows:true},'unsupported']]){const f=fixture(options);assert.doesNotThrow(()=>f.deliver.notify('Title','body'));assert.deepEqual(f.diagnostics,[status]);}});
test('diagnostic sink failure does not affect delivery',()=>{let shown=false;const d=createNativeNotificationDelivery({isSupported:()=>false,create:()=>{throw Error('unused')},notificationsEnabled:()=>true,isQuitting:()=>false,diagnostic:()=>{throw Error('I/O')}});assert.doesNotThrow(()=>d.notify('t','b'));});
