import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildClamdProfile({ uid, database = '/var/lib/clamav', mode }) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !['economy','performance'].includes(mode)
    || !path.posix.isAbsolute(database) || /[\r\n\0]/.test(database)) throw new Error('Perfil ClamAV inválido.');
  const socketPath = `/run/user/${uid}/cybersafe-clamd/clamd.sock`;
  return {profile:{mode,socketPath},config:[
    '# CyberSafe: local detection only; no automatic activation or prevention.',
    'Foreground yes', `DatabaseDirectory ${database}`, `LocalSocket ${socketPath}`,
    'LocalSocketMode 0600', 'FixStaleSocket yes', 'MaxThreads 1', 'MaxQueue 8',
    'ConcurrentDatabaseReload no', 'SelfCheck 600', 'ReadTimeout 30', 'CommandReadTimeout 5',
    'SendBufTimeout 1000', 'MaxScanTime 120000', 'StreamMaxLength 100M', 'MaxFileSize 100M',
    'MaxScanSize 400M', 'MaxRecursion 17', 'MaxFiles 10000', 'ScanArchive yes', 'AlertExceedsMax yes',
    'FollowDirectorySymlinks no', 'FollowFileSymlinks no', '',
  ].join('\n')};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('Use uma sessão Linux sem privilégios.');
    const {config,profile}=buildClamdProfile({uid:process.getuid(),mode:process.argv[2],database:process.argv[3]});
    const root=path.join(os.homedir(),'.config/cybersafe-assistant-linux-lite');
    await fs.mkdir(root,{recursive:true,mode:0o700});
    if(await fs.realpath(root)!==root)throw new Error('Pasta de configuração com redirecionamento.');
    await fs.chmod(root,0o700);
    for(const [name,bytes] of [['clamd.conf',config],['clamav-profile.json',JSON.stringify(profile)+'\n']]){
      const tmp=path.join(root,`.${name}-${process.pid}.tmp`);
      await fs.writeFile(tmp,bytes,{flag:'wx',mode:0o600});
      await fs.rename(tmp,path.join(root,name));
    }
    console.log('Perfil preparado. Nenhum serviço foi iniciado ou ativado.');
    console.log(profile.mode==='performance'
      ? 'Inicie cybersafe-clamd.service com systemctl --user e reinicie apenas o serviço CyberSafe quando não houver análises em curso.'
      : 'Reinicie o serviço CyberSafe sem análises em curso; pode depois parar cybersafe-clamd.service.');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
