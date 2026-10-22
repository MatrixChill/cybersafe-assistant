import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { YaraEngine } from '../packages/core/dist/yara.js';
// Só lê o corpus. Não usa scanFile, IPC, serviço, rede ou ficheiros pessoais como alvos.
const original = path.join(os.homedir(), '.cybersafe-service/definitions/yara/default.yar');
const bytes = await fs.readFile(original);
const hash = b => createHash('sha256').update(b).digest('hex');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cybersafe-yara-buffer-check-'));
try {
  const copy = path.join(root, 'rules.yar');
  await fs.writeFile(copy, bytes);
  const engine = new YaraEngine(copy);
  await engine.load(copy);
  const positive = engine.match(Buffer.from([0x78,0x3b,0xf6,0x82]));
  const negative = engine.match(Buffer.from('Texto benigno de controlo CyberSafe 2026.'));
  const result = { at:new Date().toISOString(), context:'standalone core/dist; NOT installed process', corpusSha256:hash(bytes), health:engine.health, positive:{fixture:'4 bytes da constante matemática CRC32c', matches:positive}, negative:{matches:negative}, sourceUnchanged:hash(await fs.readFile(original))===hash(bytes), pass:positive.some(m=>m.ruleId==='CRC32c_poly_Constant') && negative.length===0 };
  await fs.writeFile(new URL('../output/human-review-20261018/HUMAN01-YARA-BUFFER.json',import.meta.url),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  if(!result.pass) process.exitCode=1;
} finally { await fs.rm(root,{recursive:true,force:true}); }
