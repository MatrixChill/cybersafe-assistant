import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLinuxMonitoringProfile } from '../dist/linux-monitoring-profile.js';
test('explicit Linux roots are private, bounded, canonical and exclude virtual/system roots',{skip:process.platform!=='linux'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cs-monitor-profile-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'monitoring.json'),target=path.join(root,'chosen');await fs.mkdir(target);
 assert.deepEqual(readLinuxMonitoringProfile(file),{directories:[],configured:false});
 await fs.writeFile(file,JSON.stringify({directories:[target,target]}),{mode:0o600});
 assert.deepEqual(readLinuxMonitoringProfile(file),{directories:[target],configured:true});
 for(const bad of ['/', '/proc', '/proc/1','/sys/kernel','/dev/shm','/etc','/usr/bin','relative']){
  await fs.writeFile(file,JSON.stringify({directories:[bad]}));assert.equal(readLinuxMonitoringProfile(file).error,'invalid-profile');
 }
 await fs.symlink(target,path.join(root,'redirect'));await fs.writeFile(file,JSON.stringify({directories:[path.join(root,'redirect')]}));
 assert.equal(readLinuxMonitoringProfile(file).error,'invalid-profile');
 await fs.writeFile(file,JSON.stringify({directories:[target]}));await fs.chmod(file,0o666);assert.equal(readLinuxMonitoringProfile(file).error,'invalid-profile');
});
