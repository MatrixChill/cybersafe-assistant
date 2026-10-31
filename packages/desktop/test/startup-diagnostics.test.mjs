import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import { createStartupDiagnostic, classifyStartupError } from '../src/startup-diagnostics.ts';
test('persistent startup log accepts technical fields and never records credentials/payloads',()=>{
 const file=path.join(os.tmpdir(),'cs-startup-diag-'+crypto.randomUUID()+'.log');
 const record=createStartupDiagnostic(file);
 record('api-attempt',{pid:123,port:4321,packaged:true,version:'0.1.5-internal.20261029',password:'SECRET_SENTINEL',token:'TOKEN_SENTINEL',message:'Bearer TOKEN_SENTINEL',endpoint:'https://evil.invalid/private',event:'forged'});
 const text=fs.readFileSync(file,'utf8'),row=JSON.parse(text.trim());
 assert.equal(row.event,'api-attempt');assert.equal(row.pid,123);assert.equal(row.port,4321);assert.equal(row.endpoint,'http://127.0.0.1:4321');assert.ok(row.at);assert.doesNotMatch(text,/SENTINEL|evil|forged|password|Bearer/);
});
test('disabled logging and invalid fields/events create no log',()=>{
 const file=path.join(os.tmpdir(),'cs-startup-diag-disabled-'+crypto.randomUUID()+'.log');
 createStartupDiagnostic(file,false)('electron-start',{pid:123});assert.equal(fs.existsSync(file),false);
 createStartupDiagnostic(file)('unknown-secret-event',{port:4000});assert.equal(fs.existsSync(file),false);
});
test('classification identifies causes without returning the original message',()=>{
 assert.equal(classifyStartupError(new Error('NODE_MODULE_VERSION 130 wanted 137 SECRET_SENTINEL')),'NATIVE_ABI_MISMATCH');
 assert.equal(classifyStartupError('Cannot find package x PRIVATE_PATH'),'MODULE_NOT_FOUND');
 assert.equal(classifyStartupError('SQLITE_BUSY at private path'),'SQLITE_BUSY');
 assert.equal(classifyStartupError('outro serviço está a servir o pipe'),'SERVICE_IDENTITY_OR_HANDSHAKE');
 assert.equal(classifyStartupError('random SECRET_SENTINEL'),'UNKNOWN');
});
test('writer errors cannot change boot control flow',()=>{
 assert.doesNotThrow(()=>createStartupDiagnostic('C:/invalid',true,()=>{throw new Error('denied')})('electron-start',{pid:123}));
});
test('API callback classifications and fixed reasons survive the final log whitelist',()=>{
 const rows=[];const record=createStartupDiagnostic('unused',true,(_file,event,data)=>{rows.push({event,...data});return true});
 record('api-child-error',{classification:'SPAWN_ERROR',code:'ENOENT'});
 record('api-child-stderr',{classification:'SQLITE',bytes:200});
 record('api-child-stderr',{classification:'EPERM_EACCES'});
 record('api-unavailable',{reason:'health-timeout'});
 record('api-child-error',{code:'SECRET_SENTINEL',reason:'SECRET_SENTINEL'});
 assert.equal(rows[0].classification,'SPAWN_ERROR');assert.equal(rows[0].code,'ENOENT');
 assert.equal(rows[1].classification,'SQLITE');assert.equal(rows[2].classification,'EPERM_EACCES');assert.equal(rows[3].reason,'health-timeout');
 assert.doesNotMatch(JSON.stringify(rows),/SECRET_SENTINEL/);
});
