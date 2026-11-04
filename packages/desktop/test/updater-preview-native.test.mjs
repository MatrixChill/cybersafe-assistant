import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const launcher=fileURLToPath(new URL('../../native-engine/build/Release/cybersafe-update-launcher.exe',import.meta.url));

test('Preview execution refuses a Node parent even with execution environment forged', {skip:process.platform!=='win32'},()=>{
  const result=spawnSync(launcher,['--preview-handoff','AAAA','AAAA','C:\\missing\\installer.exe'],{
    windowsHide:true,timeout:5000,env:{...process.env,CS_UPDATE_PARENT:String(process.pid),CS_UPDATE_EXECUTION:'authorized'},
  });
  assert.ifError(result.error);
  assert.equal(result.status,10);
});
