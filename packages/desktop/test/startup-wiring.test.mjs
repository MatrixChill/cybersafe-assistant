import {test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
import {DEFAULT_API_PORT} from '../src/api-lifecycle.ts';
const source=fs.readFileSync(new URL('../src/main.ts',import.meta.url),'utf8').replaceAll('\r\n','\n');
const from=source.indexOf('    wireRealtimeEvents();',source.indexOf('app.whenReady()'));
const to=source.indexOf('    try {\n      await client.connect();',from);
assert.ok(from>=0&&to>from);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=new AsyncFunction('wireRealtimeEvents','createTray','startServiceProcess','startPackagedApi','console','dialog','app','logStartup','classifyStartupError',`let isQuitting=false; const DEFAULT_API_PORT=${DEFAULT_API_PORT};\n${source.slice(from,to)}`);
test('actual boot persists service-attempt before a pending service and result after it',async()=>{
 const events=[];let release;const pending=new Promise(r=>release=r);
 const work=run(()=>{},()=>{},()=>pending,()=>events.push('API'),{error:()=>{}},{showErrorBox:()=>{}},{quit:()=>{}},event=>events.push(event),()=> 'UNKNOWN');
 await Promise.resolve();assert.ok(events.includes('service-attempt'));assert.ok(!events.includes('API'));
 release({status:'connected'});await work;assert.ok(events.includes('service-result'));assert.ok(events.indexOf('service-result')<events.indexOf('API'));
});
test('actual service failure persists skipped/unavailable API and preserves the refusal',async()=>{
 const events=[];await run(()=>{},()=>{},async()=>({status:'failed',reason:'foreign service'}),()=>events.push('API'),{error:()=>{}},{showErrorBox:()=>events.push('dialog')},{quit:()=>events.push('quit')},event=>events.push(event),()=> 'SERVICE_IDENTITY_OR_HANDSHAKE');
 assert.ok(events.includes('service-result'));assert.ok(events.includes('api-skipped'));assert.ok(events.includes('api-unavailable'));assert.ok(events.includes('quit'));assert.ok(!events.includes('API'));
});
