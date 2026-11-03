import {execFile} from 'node:child_process';
import path from 'node:path';
import type {PublisherVerifier} from './types.js';
const SCRIPT = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:CYBERSAFE_VERIFY_ARTIFACT; $n=''; if($s.SignerCertificate){$n=$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}; @{status=$s.Status.ToString();type=$s.SignatureType.ToString();name=$n}|ConvertTo-Json -Compress";
async function queryWindows(artifact: string): Promise<string> {
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(executable, ['-NoLogo','-NoProfile','-NonInteractive','-Command',SCRIPT], {
      windowsHide:true, timeout:30_000, maxBuffer:16_384, encoding:'utf8',
      env:{...process.env,PSModulePath:path.join(path.dirname(executable),'Modules'),CYBERSAFE_VERIFY_ARTIFACT:artifact},
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
/** Read-only Authenticode adapter. Production trust remains separately gated. */
export function createWindowsPublisherVerifier(options: {platform?: string;run?: (artifact: string)=>Promise<string>} = {}): PublisherVerifier {
  return { async verify(artifact, expectedPublisher) {
    if ((options.platform ?? process.platform) !== 'win32' || !expectedPublisher.trim() || !artifact || artifact.includes('\0')) return {ok:false,reason:'publisher verification unavailable'};
    try {
      const value: unknown = JSON.parse((await (options.run ?? queryWindows)(artifact)).replace(/^\uFEFF/,''));
      if (!value || typeof value !== 'object') return {ok:false,reason:'invalid signature response'};
      const signature = value as Record<string,unknown>;
      if (signature.status !== 'Valid' || signature.type !== 'Authenticode' || signature.name !== expectedPublisher) return {ok:false,reason:'Authenticode status or publisher mismatch'};
      return {ok:true,publisher:expectedPublisher};
    } catch { return {ok:false,reason:'Authenticode verification failed'}; }
  }};
}
