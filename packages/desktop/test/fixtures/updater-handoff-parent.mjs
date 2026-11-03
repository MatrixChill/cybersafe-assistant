// Isolated laboratory parent. No production publisher or trust is altered.
import fs from 'node:fs';import path from 'node:path';
import {createWindowsInstaller} from '../../src/updater/windows-installer.ts';
import {createEd25519ManifestVerifier} from '../../src/updater/crypto.ts';
const root=process.argv[2];const fixture=JSON.parse(fs.readFileSync(path.join(root,'request.json'),'utf8'));
process.env.CYBERSAFE_LAB_INSTALL_EXIT=String(fixture.exitCode??0);
const adapter=createWindowsInstaller({launcherPath:path.resolve('packages/native-engine/build/Release/cybersafe-update-launcher.exe'),stagingRoot:path.join(root,'staging'),journalFile:path.join(root,'operation.json'),expectedPublisher:'LABORATORY SIMULATOR',
 signatureVerifier:createEd25519ManifestVerifier({publicKey:fixture.publicKey,pinnedFingerprint:fixture.fingerprint}),
 // Simulator is intentionally unsigned; this test seam is never in production.
 publisherVerifier:{verify:async()=>({ok:true,publisher:'LABORATORY SIMULATOR'})},
 authorizeExecution:()=>true,confirmConsent:async()=>true,
 requestShutdown:async()=>{fs.writeFileSync(path.join(root,'shutdown-ready'),'resources drained');setTimeout(()=>process.exit(0),100);},
});
const result=await adapter.install(fixture.context);console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
