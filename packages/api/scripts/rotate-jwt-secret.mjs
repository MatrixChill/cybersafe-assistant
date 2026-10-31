#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

function rotate() {
  let file = fileURLToPath(new URL('../.env', import.meta.url));
  let dryRun = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--file' && args[i + 1] && !args[i + 1].startsWith('--')) file = path.resolve(args[++i]);
    else throw new Error('Argumentos inválidos: usar --file <caminho> e/ou --dry-run.');
  }
  if (/[\r\n]/.test(file)) throw new Error('Caminho inválido.');
  let stat;
  try { stat = fs.lstatSync(file); }
  catch { throw new Error('O ficheiro alvo não existe ou não pode ser lido.'); }
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('O alvo deve ser um ficheiro regular sem ligações adicionais.');
  const original = fs.readFileSync(file);
  // Latin-1 provides one character per byte, preserving UTF-8, BOM and line endings.
  const content = original.toString('latin1');
  const pattern = /^(?:\xEF\xBB\xBF)?[ \t]*(?:export[ \t]+)?JWT_SECRET[ \t]*=[ \t]*/gm;
  const keys = [...content.matchAll(pattern)];
  if (keys.length > 1) throw new Error('Chave JWT_SECRET duplicada; resolver antes de rodar o segredo.');
  const secret = randomBytes(48).toString('base64url');
  if (secret.length < 32) throw new Error('O segredo gerado não cumpre o mínimo de 32 caracteres.');
  let updated;
  if (keys.length) {
    const start = keys[0].index + keys[0][0].length;
    const endOfLine = content.indexOf('\n', start);
    const end = endOfLine < 0 ? content.length : endOfLine;
    const line = content.slice(start, end).replace(/\r$/, '');
    let valueEnd;
    let offset = start;
    if (line[0] === '"' || line[0] === "'") {
      const closing = line.indexOf(line[0], 1);
      if (closing < 0 || !/^[ \t]*(?:#.*)?$/.test(line.slice(closing + 1))) {
        throw new Error('Linha JWT_SECRET inválida; esperado um valor numa única linha.');
      }
      offset++;
      valueEnd = start + closing;
    } else {
      valueEnd = start + line.split('#', 1)[0].replace(/[ \t]+$/, '').length;
    }
    updated = content.slice(0, offset) + secret + content.slice(valueEnd);
  } else {
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    updated = content + (content.length && !content.endsWith('\n') ? newline : '') + `JWT_SECRET=${secret}${newline}`;
  }
  const backup = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  if (!dryRun) {
    const temporary = `${file}.rotate-${randomUUID()}`;
    const mode = stat.mode & 0o777;
    let tempCreated = false;
    function unchanged() {
      const now = fs.lstatSync(file);
      if (!now.isFile() || now.ino !== stat.ino || now.dev !== stat.dev || !fs.readFileSync(file).equals(original)) {
        throw new Error('O ficheiro alvo mudou durante a operação; rotação cancelada.');
      }
    }
    try {
      unchanged();
      const backupFd = fs.openSync(backup, 'wx', mode);
      try {
        fs.writeFileSync(backupFd, original);
        fs.fchmodSync(backupFd, mode);
        fs.fsyncSync(backupFd);
      } finally { fs.closeSync(backupFd); }
      const fd = fs.openSync(temporary, 'wx', mode);
      tempCreated = true;
      try {
        fs.writeFileSync(fd, Buffer.from(updated, 'latin1'));
        fs.fchmodSync(fd, mode);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      unchanged();
      fs.renameSync(temporary, file);
      tempCreated = false;
    } finally {
      if (tempCreated) fs.unlinkSync(temporary);
    }
  }
  const fingerprint = createHash('sha256').update(secret).digest('hex').slice(0, 12);
  console.log(`ACTION=ROTATE_JWT_SECRET\nFILE=${file}\nBACKUP=${backup}\nFINGERPRINT=sha256:${fingerprint}`);
  console.log(dryRun
    ? 'DRY-RUN: nenhuma escrita. A rotação invalidará TODAS as sessões/JWT anteriores após reiniciar a API.'
    : 'AVISO: reiniciar a API para usar o novo segredo e invalidar TODAS as sessões/JWT anteriores.');
}

try { rotate(); }
catch (error) {
  // Native errors can contain uncontrolled paths; never dump objects or file contents.
  console.error(error.code ? 'Falha de acesso ao ficheiro; rotação não concluída.' : error.message);
  process.exitCode = 1;
}
