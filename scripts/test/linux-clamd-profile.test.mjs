import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClamdProfile } from '../linux-lite/arch/clamav-profile.mjs';
test('persistent profile enables archives and limit alerts, one worker, no TCP or prevention',()=>{
 const {config,profile}=buildClamdProfile({uid:1000,database:'/var/lib/clamav',mode:'performance'});
 assert.match(config,/^MaxThreads 1$/m);assert.match(config,/^ScanArchive yes$/m);assert.match(config,/^AlertExceedsMax yes$/m);
 assert.match(config,/^ConcurrentDatabaseReload no$/m);assert.doesNotMatch(config,/^TCPSocket|^OnAccessPrevention yes/m);
 assert.equal(profile.socketPath,'/run/user/1000/cybersafe-clamd/clamd.sock');
 assert.throws(()=>buildClamdProfile({uid:1000,database:'/tmp/a\nTCPSocket 3310',mode:'performance'}));
 assert.equal(buildClamdProfile({uid:1000,database:'/var/lib/clamav',mode:'economy'}).profile.mode,'economy');
});
