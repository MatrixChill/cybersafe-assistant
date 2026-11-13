import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

export function readToken(profile, uid) {
  const directory = join(profile, 'secrets');
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o022)) {
    throw new Error('Diretório da credencial não é seguro.');
  }
  const fd = openSync(join(directory, 'pipe-credential'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) || stat.size > 65) {
      throw new Error('Credencial não é um ficheiro privado.');
    }
    const token = readFileSync(fd, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Formato de credencial inválido.');
    return token;
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('Use uma sessão Linux sem privilégios.');
    const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const token = readToken(join(config, 'cybersafe-assistant-linux-lite'), process.getuid());
    const app = dirname(process.argv[1]);
    const entry = join(app, 'resources/app.asar/node_modules/@cybersafe/service/dist/index.js');
    const child = spawn(join(app, 'cybersafe-assistant-linux-lite'), [entry], {
      stdio: 'inherit',
      env: { PATH: '/usr/local/bin:/usr/bin', HOME: homedir(), NODE_ENV: 'production',
        ELECTRON_RUN_AS_NODE: '1', CYBERSAFE_PIPE_TOKEN: token },
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', () => { console.error('Não foi possível iniciar o serviço CyberSafe.'); process.exitCode = 1; });
    child.on('exit', (code) => { process.exitCode = code ?? 1; });
  } catch (error) {
    console.error(error.code ? 'Credencial privada indisponível. Abra e feche a aplicação primeiro.' : error.message);
    process.exitCode = 78;
  }
}
