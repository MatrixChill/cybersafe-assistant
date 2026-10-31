// Test bootstrap only. Never loaded by the normal launcher or packaged product.
import path from 'node:path';
import { ProtectionEngineService } from '../packages/service/dist/engine.js';
import { fixtureRootFromEnv, scanCustomContido } from '../packages/service/dist/dev-fixture-gate.js';
import { pinFixture } from '../packages/service/dist/fixture-pin.js';

if (process.env.CYBERSAFE_DEV_FIXTURE_PROTECTION_AUTHORIZED !== '1' ||
    process.env.NODE_ENV !== 'development' || process.env.CYBERSAFE_DEV_ISOLATION !== '1' ||
    process.env.CYBERSAFE_REALDEV_FIXTURE_SCAN !== '1' ||
    process.env.CYBERSAFE_USB_PROTECTION !== '0' || process.env.CYBERSAFE_STARTUP_RESUME !== '0' ||
    process.env.CYBERSAFE_DEV_WINDOWS_READONLY === '1') {
  throw Error('Scoped protection test profile was not explicitly authorized');
}
const root = fixtureRootFromEnv();
const proto = ProtectionEngineService.prototype;
const initialize = proto.init;
const dispatchRequest = proto.handleRequest;
proto.init = async function (...args) {
  // Existing ClamAV test seam: this explicitly authorized harness permits its
  // own harmless load-proof file/process. Health still depends on actual output.
  this.clamav.loadProofEnabled = true;
  // Automatic definition updates are outside this profile's authorization.
  // Keep seeded local definitions fixed; do not launch FreshClam or downloads.
  this.updater.startScheduler = () => console.log('[PAP fixture protection] Automatic definition updates disabled by test scope; approved local definitions retained.');
  // The real watcher validates/attaches this one root. No default personal roots.
  this.watcher.getDefaultPaths = () => [root.real];
  const admitStartedProcess = this.shouldScanStartedProcess.bind(this);
  this.shouldScanStartedProcess = processInfo => {
    if (typeof processInfo.path !== 'string' || !processInfo.path) return false;
    const relative = path.relative(root.real, path.resolve(processInfo.path));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && admitStartedProcess(processInfo);
  };
  const analyze = this.scanArtifact.bind(this);
  this.scanArtifact = async (file, source, options) => {
    const decision = scanCustomContido({ type:'custom', targetPath:path.resolve(file) }, root);
    if (!decision.ok || !decision.snapshot) throw Error('Scoped protection: file outside authorized fixture or identity unavailable');
    const lease = pinFixture(decision.snapshot);
    try {
      // File monitoring is real; automatic mutation and VirusTotal remain off.
      return await analyze(file, source, { ...options, readOnly:true, skipVirusTotal:true });
    } finally { lease.release(); }
  };
  const fixtureRequest = this.handleRequest.bind(this);
  this.handleRequest = request => {
    // Only explicit activation/deactivation bypass the scan-only RPC gate.
    // The actual service methods and lifecycle execute, with the scoped watcher
    // and analysis guard above. All other mutations remain refused by that gate.
    if (request?.method === 'monitor.start' || request?.method === 'monitor.stop') {
      return dispatchRequest.call(this, request);
    }
    return fixtureRequest(request);
  };
  console.log('[PAP fixture protection] Real watcher restricted to synthetic fixture root; outside analysis refused; quarantine/VirusTotal disabled. This is not global protection certification.');
  return initialize.apply(this, args);
};

await import('../packages/service/dist/index.js');
