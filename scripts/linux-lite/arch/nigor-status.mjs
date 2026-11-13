import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToken } from './run-service.mjs';

try {
  if (process.platform !== 'linux' || process.getuid() === 0) {
    throw new Error('Use uma sessão Linux sem privilégios.');
  }
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const token = readToken(join(config, 'cybersafe-assistant-linux-lite'), process.getuid());
  const app = dirname(fileURLToPath(import.meta.url));
  const entry = join(app, 'resources/app.asar/dist/nigor-client.js');
  const client = spawn(join(app, 'cybersafe-assistant-linux-lite'), [entry], {
    stdio: 'inherit',
    env: {
      PATH: '/usr/bin',
      HOME: homedir(),
      ELECTRON_RUN_AS_NODE: '1',
      CYBERSAFE_NIGOR_STATUS: '1',
      CYBERSAFE_PIPE_TOKEN: token,
    },
  });
  client.once('error', () => {
    console.error('Não foi possível iniciar o cliente CyberSafe.');
    process.exitCode = 1;
  });
  client.once('exit', (code) => { process.exitCode = code ?? 1; });
} catch {
  console.error('Credencial CyberSafe indisponível ou inválida.');
  process.exitCode = 1;
}
