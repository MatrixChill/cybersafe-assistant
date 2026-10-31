import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cybersafe-auth-audit-'));
const secret=randomBytes(48).toString('hex');
async function start(){
 const child=fork(new URL('./fixtures/auth-audit-api.mjs',import.meta.url),[],{env:{SystemRoot:process.env.SystemRoot,TEMP:dir,TMP:dir,NODE_ENV:'production',CYBERSAFE_API_NO_LISTEN:'1',CYBERSAFE_DB_PATH:path.join(dir,'accounts.db'),JWT_SECRET:secret},silent:true});
 // Discard application output: never put credentials or response bodies in test logs.
 child.stdout.resume();child.stderr.resume();
 const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('API startup timeout')),10000);child.once('message',m=>{clearTimeout(timer);resolve(m.base)});child.once('exit',()=>{clearTimeout(timer);reject(Error('API exited before readiness'))});});
 return {child,base,async stop(){await new Promise(resolve=>{child.once('exit',resolve);child.send('stop')});}};
}
test('real API + SQLite: validity, account isolation and revocation survive process restart',async()=>{
 let api=await start();
 const call=(route,token,body)=>fetch(api.base+route,{method:body?'POST':route.endsWith('logout')?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
 try{
  const create=async(email)=>{const r=await call('/auth/register',null,{email,password:'Audit-only-fixture-271!',name:'Audit fixture',type:'personal'});assert.equal(r.status,201);return r.json()};
  const a=await create('audit-a@example.invalid');const b=await create('audit-b@example.invalid');
  assert.equal((await call('/auth/me',a.token)).status,200);
  assert.equal((await (await call('/auth/me',b.token)).json()).user.id,b.user.id);
  for(const token of [null,'corrupted',jwt.sign({sub:a.user.id},secret,{expiresIn:-1}),jwt.sign({sub:a.user.id},'wrong-fixture-key')])assert.equal((await call('/auth/me',token)).status,401);
  await api.stop();api=await start();
  assert.equal((await call('/auth/me',a.token)).status,200,'valid session survives API restart');
  assert.equal((await call('/auth/logout',a.token)).status,204);
  assert.equal((await call('/auth/me',a.token)).status,401);
  assert.equal((await call('/auth/me',b.token)).status,200,'logout A does not revoke B');
  await api.stop();api=await start();
  assert.equal((await call('/auth/me',a.token)).status,401,'revoked session MUST remain revoked after restart');
  assert.equal((await call('/auth/me',b.token)).status,200);
  const db=new Database(path.join(dir,'accounts.db'),{readonly:true});
  try {
   const users=db.prepare('SELECT passwordHash FROM users').all();
   assert.ok(users.every(u=>/^\$2[aby]\$12\$/.test(u.passwordHash)),'passwords are bcrypt hashes with cost 12');
   const rows=db.prepare('SELECT fingerprint FROM auth_revoked_tokens').all();
   assert.ok(rows.length>0 && rows.every(r=>/^[a-f0-9]{64}$/.test(r.fingerprint)),'only fingerprints, never bearers, are persisted for revocation');
  } finally {db.close();}
 }finally{await api.stop();}
});
