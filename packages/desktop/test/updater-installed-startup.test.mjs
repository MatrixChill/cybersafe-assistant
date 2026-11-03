import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {UpdateJournal} from '../src/updater/install-journal.ts';import {reconcileInstalledUpdate} from '../src/updater/installed-startup.ts';
test('fresh startup confirms only the expected version with ready data, and is idempotent',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cs-startup-confirm-'));t.after(()=>{for(const f of fs.readdirSync(root))fs.unlinkSync(path.join(root,f));fs.rmdirSync(root)});
 const journal=new UpdateJournal(path.join(root,'operation.json'));const context={confirmed:true,scanState:'idle',expectedVersion:'0.2.0',manifest:{version:'0.2.0',file:{sha256:'a'.repeat(64)}}};
 const p=journal.prepare(context);journal.advance(p.id,'shutdown');journal.advance(p.id,'installing');journal.installerExited(p.id,0);
 const opts={journal,installedVersion:'0.2.0',dataReady:async()=>true};assert.equal((await reconcileInstalledUpdate(opts)).stage,'completed');assert.equal((await reconcileInstalledUpdate({...opts,dataReady:async()=>{throw Error('must not replay')}})).stage,'completed');
 const next=journal.prepare(context);journal.advance(next.id,'shutdown');journal.advance(next.id,'installing');journal.installerExited(next.id,0);
 assert.equal((await reconcileInstalledUpdate({...opts,dataReady:async()=>false})).stage,'recovery-required');
});
