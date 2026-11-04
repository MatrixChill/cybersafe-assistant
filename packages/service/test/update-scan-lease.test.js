import test from 'node:test';
import assert from 'node:assert/strict';
import {ScanManager} from '../dist/scan-manager.js';
import {ProtectionEngineService} from '../dist/engine.js';

function serviceFixture() {
  const service=Object.create(ProtectionEngineService.prototype);
  service.scanManager=new ScanManager({emitScanProgress(){}});
  service.criticalRpcOperations=0;service.isShuttingDown=false;
  service.gateMethodDuringStartup=async()=>{};
  return service;
}

test('service lease blocks legacy/manual mutation routes without altering protection',async()=>{
  const service=serviceFixture();
  const {token}=await service.dispatch('update.acquireScanLease');
  assert.equal(typeof token,'string');
  for(const method of ['scan.start','scan.artifact','scan.fullSystem','analysis.restricted','process.analyze','quarantine.restore','definitions.update'])
    await assert.rejects(service.dispatch(method,{}),/Atualização em preparação/);
  assert.equal((await service.dispatch('update.releaseScanLease',{token})).ok,true);
});

test('legacy full scan ACK is not mistaken for worker completion',async()=>{
  const service=serviceFixture();let finish;
  service.runFullSystemScan=()=>new Promise(resolve=>{finish=resolve});
  assert.equal((await service.dispatch('scan.fullSystem')).success,true);
  assert.equal((await service.dispatch('update.acquireScanLease')).token,null);
  finish();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof (await service.dispatch('update.acquireScanLease')).token,'string');
});

test('update lease excludes every ScanManager entry and only its owner can release',async()=>{
  const manager=new ScanManager({emitScanProgress(){},scanArtifact(){throw Error('must not scan')}});
  const token=manager.acquireUpdateLease();
  assert.equal(typeof token,'string');
  assert.equal(manager.acquireUpdateLease(),null);
  for(const type of ['custom','quick','full']) assert.equal(await manager.startScan(type,'unused'),null);
  assert.equal(manager.releaseUpdateLease('foreign'),false);
  assert.equal(manager.renewUpdateLease(token),true);
  assert.equal(manager.releaseUpdateLease(token),true);
  assert.equal(manager.renewUpdateLease(token),false);
  assert.equal(typeof manager.acquireUpdateLease(),'string');
});

test('update lease refuses an active worker even when UI scan state is already terminal',()=>{
  const manager=new ScanManager({emitScanProgress(){}});
  manager.currentScanPromise=Promise.resolve();
  assert.equal(manager.acquireUpdateLease(),null);
});

test('expired lease cannot be renewed or used to release a later operation',()=>{
  const manager=new ScanManager({emitScanProgress(){}});
  const first=manager.acquireUpdateLease();
  manager.updateLease.expires=0;
  assert.equal(manager.renewUpdateLease(first),false);
  const second=manager.acquireUpdateLease();
  assert.notEqual(first,second);
  assert.equal(manager.releaseUpdateLease(first),false);
  assert.equal(manager.releaseUpdateLease(second),true);
});
