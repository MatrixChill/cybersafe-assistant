import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { NativeWindowsWatcher } from '../dist/index.js';
const linux={skip:process.platform!=='linux'};
test('Linux defaults observe user autostart and systemd directories, not Windows Run keys',linux,()=>{
 const roots=new NativeWindowsWatcher().getDefaultPaths();
 assert.ok(roots.includes(path.join(os.homedir(),'.config/autostart')));
 assert.ok(roots.includes(path.join(os.homedir(),'.config/systemd/user')));
 assert.ok(!roots.some(p=>/AppData|ProgramData/.test(p)));
});
test('explicit hidden-root persistence directory emits real new-file observation',linux,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cs-linux-watch-'));const dir=path.join(root,'.config/autostart');await fs.mkdir(dir,{recursive:true});
 const watcher=new NativeWindowsWatcher();t.after(async()=>{await watcher.stop();await fs.rm(root,{recursive:true,force:true});});
 watcher.on('error',()=>{});await watcher.start([dir]);
 assert.equal(watcher.registryTimer,null);
 const file=path.join(dir,'benign.desktop');const started=performance.now();
 const observed=once(watcher,'file.created',{signal:AbortSignal.timeout(7000)});
 await fs.writeFile(file,'[Desktop Entry]\nType=Application\nName=Benign fixture\n');
 const [event]=await observed;assert.equal(event.path,file);
 assert.ok(performance.now()-started>=3000,'preserve write stability window');
});
