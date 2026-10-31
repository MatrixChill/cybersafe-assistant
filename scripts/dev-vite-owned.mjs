import path from 'node:path';
import { createServer } from 'vite';

// This process must be forked by the isolated runner: IPC is the only shutdown channel.
if (!process.send || !process.env.CS_OWNED_VITE_ROOT) {
  throw new Error('Vite isolado requer processo pai e raiz explícita');
}
const testMode = process.env.CS_OWNED_VITE_TEST === '1';
const root = path.resolve(process.env.CS_OWNED_VITE_ROOT);
const cacheDir = process.env.CS_OWNED_VITE_CACHE;
if (!testMode && !cacheDir) throw new Error('Vite isolado requer cache dedicada');
const server = await createServer({
  root,
  configLoader: 'runner',
  ...(testMode ? { configFile: false, cacheDir: path.join(root, '.cache') } : { cacheDir }),
  server: { host: '127.0.0.1', port: testMode ? 0 : 5173, strictPort: !testMode },
});
await server.listen();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  if (process.connected) process.disconnect?.();
}
process.on('message', (message) => { if (message?.type === 'cybersafe:dev:shutdown') void close(); });
process.on('disconnect', () => { void close(); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => { void close(); });
process.send({ type: 'ready', port: server.httpServer.address().port });
