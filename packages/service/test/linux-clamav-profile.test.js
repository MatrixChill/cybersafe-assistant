import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLinuxClamavProfile } from '../dist/linux-clamav-profile.js';
test('Linux performance is explicit and profile must be private, regular and local', {skip:process.platform!=='linux'}, async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cs-clam-profile-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'profile.json');assert.equal(readLinuxClamavProfile(file),undefined);
 await fs.writeFile(file,JSON.stringify({mode:'performance',socketPath:'/run/user/1000/cybersafe-clamd/clamd.sock'}),{mode:0o600});
 assert.deepEqual(readLinuxClamavProfile(file),{socketPath:'/run/user/1000/cybersafe-clamd/clamd.sock',databaseDirectory:'/var/lib/clamav'});
 await fs.writeFile(file,JSON.stringify({mode:'economy',socketPath:'/tmp/socket'}));assert.equal(readLinuxClamavProfile(file),undefined);
 await fs.writeFile(file,JSON.stringify({mode:'performance',socketPath:'tcp://localhost:3310'}));assert.equal(readLinuxClamavProfile(file),undefined);
 if(process.platform==='linux') {await fs.writeFile(file,JSON.stringify({mode:'performance',socketPath:'/tmp/socket'}));await fs.chmod(file,0o666);assert.equal(readLinuxClamavProfile(file),undefined);}
});
