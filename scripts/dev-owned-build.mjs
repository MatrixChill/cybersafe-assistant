import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const workspace of ['core', 'api', 'service']) {
  const r = spawnSync(process.execPath, [path.join(repo, 'node_modules/typescript/bin/tsc'), '-p', path.join(repo, 'packages', workspace, 'tsconfig.json')], { cwd: repo, stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
// Runner loader avoids Vite writing its config bundle into shared node_modules.
const result = spawnSync(process.execPath, [path.join(repo, 'node_modules/vite/bin/vite.js'), 'build', '--configLoader', 'runner'], { cwd: path.join(repo, 'packages/desktop'), stdio: 'inherit', env: process.env });
process.exitCode = result.status ?? 1;
