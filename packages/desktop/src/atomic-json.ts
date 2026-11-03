import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
/** Same-directory replacement; never delete the destination to work around Windows locks. */
export function atomicWriteJsonSync(file: string, value: unknown, io: Pick<typeof fs,'mkdirSync'|'openSync'|'writeFileSync'|'fsyncSync'|'closeSync'|'renameSync'|'unlinkSync'> = fs): void {
  const content = JSON.stringify(value, null, 2);
  if (typeof content !== 'string') throw new Error('JSON document required');
  const directory = path.dirname(file);
  io.mkdirSync(directory,{recursive:true});
  const temporary = path.join(directory,`.${path.basename(file)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = io.openSync(temporary,'wx',0o600); created = true;
    io.writeFileSync(fd,content,'utf8');
    io.fsyncSync(fd);
    io.closeSync(fd); fd = undefined;
    io.renameSync(temporary,file);
    created = false;
  } finally {
    if (fd !== undefined) { try { io.closeSync(fd); } catch { /* preserve original failure */ } }
    if (created) { try { io.unlinkSync(temporary); } catch { /* orphan temp is never loaded as settings */ } }
  }
}
