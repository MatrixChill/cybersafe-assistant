#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { askHidden, readPipedLine } from './lib/hidden-prompt.mjs';

// Ferramenta administrativa explícita; não importa db.js (que migra/semeia
// dados ao importar). Nunca arranca API, serviço, scanners ou listeners.
const LEGACY_EMAIL = 'admin@cybersafe.local';
class CliError extends Error {}
const refuse = (message) => { throw new CliError(message); };

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!['--inspect', '--create', '--rotate-legacy-dev', '--restore', '--email', '--password-stdin', '--confirm', '--dry-run', '--help'].includes(arg)) refuse('Argumento desconhecido. Use --help.');
    if (Object.hasOwn(options, arg)) refuse('Argumento repetido.');
    if (arg === '--email' || arg === '--restore') {
      const value = args[++i];
      if (!value || value.startsWith('--')) refuse('Falta um valor de argumento.');
      options[arg] = value;
    } else options[arg] = true;
  }
  if (options['--help'] && args.length === 1) return options;
  const modes = ['--inspect', '--create', '--rotate-legacy-dev', '--restore'].filter((key) => options[key]);
  if (modes.length !== 1) refuse('Escolha exatamente um modo. Use --help.');
  options.mode = modes[0];
  if (options['--email'] && options.mode !== '--create') refuse('--email só é válido com --create.');
  if (options['--help']) refuse('--help não pode ser combinado com operações.');
  if (options.mode === '--inspect' && (options['--confirm'] || options['--dry-run'])) refuse('--inspect é sempre read-only; não aceita confirmação nem dry-run.');
  if (options.mode === '--create' && options['--confirm']) refuse('--create não usa --confirm.');
  if (options['--password-stdin'] && options.mode !== '--create') refuse('--password-stdin só é válido com --create.');
  if (['--rotate-legacy-dev', '--restore'].includes(options.mode) && !options['--confirm'] && !options['--dry-run']) refuse('Operação recusada: é necessário --confirm (ou --dry-run sem escrita).');
  return options;
}

function regularFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) refuse('A DB/backup deve ser um ficheiro regular existente, não uma ligação simbólica.');
  return fs.realpathSync(file);
}

function openDb(file, readonly = true) {
  return new Database(file, { readonly, fileMustExist: true, timeout: 3000 });
}

function columns(db, table) {
  // Nomes exclusivamente internos, nunca argumentos do caller.
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

function validateDb(db) {
  const userColumns = new Set(columns(db, 'users').map((column) => column.name));
  if (!['id', 'name', 'email', 'passwordHash', 'type', 'plan', 'createdAt'].every((key) => userColumns.has(key))) refuse('Esquema de utilizadores incompatível; nenhuma alteração aplicada.');
  if (db.pragma('quick_check').some((row) => Object.values(row)[0] !== 'ok')) refuse('A DB/backup falhou a verificação de integridade.');
}

function userByEmail(db, email) {
  const users = db.prepare('SELECT id, email FROM users WHERE email = ? COLLATE NOCASE').all(email);
  if (users.length > 1) refuse('Email ambíguo: existem contas distintas que só diferem na capitalização.');
  return users[0];
}

function requireLegitimateAdmin(db) {
  if (!columns(db, 'users').some((column) => column.name === 'role') ||
      !db.prepare("SELECT id FROM users WHERE role = 'admin' AND lower(trim(email)) <> ? LIMIT 1").get(LEGACY_EMAIL)) {
    refuse('Rotação recusada: crie primeiro um administrador local legítimo com email diferente da conta DEV.');
  }
  const legacy = userByEmail(db, LEGACY_EMAIL);
  if (!legacy) refuse('A conta DEV legada não existe; não há credencial a rodar.');
  return legacy;
}

function inspect(db) {
  const roleColumn = columns(db, 'users').find((column) => column.name === 'role');
  const hasTraining = columns(db, 'training_results').some((column) => column.name === 'userId');
  const threatColumns = columns(db, 'threat_events');
  const totalThreats = threatColumns.length ? db.prepare('SELECT COUNT(*) AS n FROM threat_events').get().n : null;
  const training = hasTraining ? db.prepare('SELECT COUNT(*) AS n FROM training_results WHERE userId = ?') : null;
  const users = db.prepare(`SELECT id, email, ${roleColumn ? 'role' : 'NULL AS role'}, type, plan, createdAt FROM users ORDER BY email`).all();
  console.log(JSON.stringify({
    roleColumn: { exists: Boolean(roleColumn), type: roleColumn?.type ?? null, notNull: Boolean(roleColumn?.notnull), defaultValue: roleColumn?.dflt_value ?? null },
    users: users.map((user) => ({
      ...user, trainingResults: training ? training.get(user.id).n : null,
      threatEventsTotal: totalThreats,
      threatEventsOwnership: threatColumns.some((column) => ['userId', 'ownerId', 'tenantId'].includes(column.name)) ? 'owner-columns-present' : 'unowned',
    })),
  }, null, 2));
}

function validateEmail(value) {
  const email = (value ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) refuse('Indique um email válido com --email.');
  if (email === LEGACY_EMAIL) refuse('Use um email legítimo diferente da conta DEV legada.');
  return email;
}

// Decisão do utilizador (09/10/2026, condição 5): a palavra-passe é introduzida
// exclusivamente por um humano, no terminal local, de forma interativa e SEM
// ECO. Não se lê de variáveis de ambiente (ficariam no ambiente do processo) e
// stdin encaminhado só é aceite com --password-stdin explícito, para automação.
async function readPassword(useStdin) {
  if (useStdin) return readPipedLine();
  return askHidden('Palavra-passe do administrador (não é mostrada, nem com máscaras): ');
}

function validatePassword(password, email) {
  // Política conservadora verificável, não uma promessa de detetar todo o
  // segredo adivinhável. bcrypt limita-se a 72 bytes: nunca truncar em silêncio.
  if ([...password].length < 12 || Buffer.byteLength(password, 'utf8') > 72 || /[\r\n\0]/.test(password)) refuse('Palavra-passe recusada: mínimo 12 caracteres, máximo 72 bytes, numa única linha.');
  const simple = password.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
  const unmasked = password.normalize('NFKD').toLowerCase().replace(/[@$!0134578]/g,
    (character) => ({ '@': 'a', '$': 's', '!': 'i', 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b' })[character]).replace(/[^a-z0-9]/g, '');
  const local = email.split('@')[0].replace(/[^a-z0-9]/g, '');
  const common = /password|palavrapasse|senha|letmein|welcome|changeme|qwerty|asdf|zxcvbn|poiuy|lkjhg|cybersafe|admin|123456|abcdef|correcthorsebatterystaple/;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^a-zA-Z0-9\s]/u].filter((pattern) => pattern.test(password)).length;
  const words = password.trim().split(/\s+/u);
  const passphrase = words.length >= 4 && new Set(words.map((word) => word.toLowerCase())).size === words.length && [...password].length >= 24;
  if (common.test(simple) || common.test(unmasked) || (local.length >= 4 && simple.includes(local)) || new Set(password).size < 8 || /^(.{1,6})\1+$/u.test(password) || (classes < 3 && !passphrase)) {
    refuse('Palavra-passe previsível recusada. Use um segredo aleatório ou uma frase longa com palavras independentes.');
  }
}

async function backup(db, dbPath) {
  const name = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`;
  // Reserva exclusiva e permissões restritas (ACL herdada no Windows).
  fs.closeSync(fs.openSync(name, 'wx', 0o600));
  try {
    // A API SQLite inclui commits WAL; copiar só cybersafe.db perderia dados.
    await db.backup(name);
    const check = openDb(name);
    try { validateDb(check); } finally { check.close(); }
    // FlushFileBuffers no Windows exige handle com acesso de escrita.
    const fd = fs.openSync(name, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) { fs.unlinkSync(name); throw error; }
  console.log(`BACKUP=${name}`);
  return name;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options['--help']) {
    console.log('Modos: --inspect | --create --email <email> | --rotate-legacy-dev --confirm | --restore <backup> --confirm.\n--dry-run planeia qualquer escrita sem a executar. A DB deve existir.\n--create pede a palavra-passe de forma INTERATIVA e SEM ECO no terminal (mínimo 12 caracteres, máximo 72 bytes, sem padrões comuns). Para automação existe --password-stdin (lê uma linha de stdin encaminhado; nunca é ecoada). A palavra-passe nunca é lida de variáveis de ambiente, nunca é impressa e nunca é escrita em logs. Exige segredo mesmo ao promover uma conta existente, mas não altera a palavra-passe dessa conta.\nRotação/restore preservam backup SQLite consistente. Faça estas operações em manutenção, sem escritores concorrentes. Restore reverte também credenciais e dados: preserve os caminhos impressos. Não revoga JWT já emitidos.');
    return;
  }
  const dbPath = regularFile(process.env.CYBERSAFE_DB_PATH
    ? path.resolve(process.env.CYBERSAFE_DB_PATH)
    : path.join(os.homedir(), '.cybersafe-service', 'cybersafe.db'));
  let db = openDb(dbPath);
  try {
    validateDb(db);
    if (options.mode === '--inspect') { inspect(db); return; }
    if (options.mode === '--create') {
      const email = validateEmail(options['--email']);
      const existing = userByEmail(db, email);
      if (options['--dry-run']) {
        console.log(`DRY_RUN=${existing ? 'PROMOTE_ADMIN (palavra-passe preservada)' : 'CREATE_ADMIN (bcrypt custo 12)'} EMAIL=${email}`);
        return;
      }
      const password = await readPassword(Boolean(options['--password-stdin']));
      validatePassword(password, email);
      const passwordHash = existing ? null : bcrypt.hashSync(password, 12);
      db.close(); db = openDb(dbPath, false);
      const action = db.transaction(() => {
        if (!columns(db, 'users').some((column) => column.name === 'role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
        const current = userByEmail(db, email);
        if (current) {
          db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(current.id);
          return 'ACTION=PROMOTE_ADMIN; palavra-passe existente não foi alterada.';
        } else {
          if (!passwordHash) refuse('A conta mudou durante a operação; volte a inspecionar.');
          db.prepare("INSERT INTO users (id,name,email,passwordHash,type,plan,role,createdAt) VALUES (?,?,?,?,?,?,?,?)")
            .run(`usr-${randomUUID()}`, 'Administrador local', email, passwordHash, 'personal', 'free', 'admin', new Date().toISOString());
          return 'ACTION=CREATE_ADMIN';
        }
      }).immediate();
      console.log(`${action} TIMESTAMP=${new Date().toISOString()}`);
      return;
    }
    if (options.mode === '--rotate-legacy-dev') {
      requireLegitimateAdmin(db);
      if (options['--dry-run']) { console.log('DRY_RUN=BACKUP_AND_ROTATE_LEGACY_DEV; conta e dados preservados.'); return; }
      await backup(db, dbPath);
      const randomHash = bcrypt.hashSync(randomBytes(48).toString('base64url'), 12);
      db.close(); db = openDb(dbPath, false);
      db.transaction(() => {
        const legacy = requireLegitimateAdmin(db); // Revalidar após o await.
        db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(randomHash, legacy.id);
      }).immediate();
      console.log(`ACTION=ROTATE_LEGACY_DEV TIMESTAMP=${new Date().toISOString()}; conta, email e dados preservados. JWT já emitidos não são revogados por esta operação.`);
      return;
    }
    const sourcePath = regularFile(path.resolve(options['--restore']));
    const sourceStat = fs.statSync(sourcePath), targetStat = fs.statSync(dbPath);
    if (sourcePath === dbPath || (sourceStat.ino && sourceStat.ino === targetStat.ino && sourceStat.dev === targetStat.dev)) refuse('O backup de origem não pode ser a própria DB de destino.');
    const source = openDb(sourcePath);
    try {
      // Validação e restore veem o mesmo snapshot, mesmo que o ficheiro de
      // origem tenha outro escritor; nunca validar uma versão e copiar outra.
      source.exec('BEGIN');
      validateDb(source);
      for (const table of ['threat_events', 'training_results']) {
        if (columns(db, table).length && !columns(source, table).length) refuse('Backup incompatível: faltam tabelas de dados existentes no destino.');
      }
      if (options['--dry-run']) { console.log(`DRY_RUN=BACKUP_CURRENT_AND_RESTORE SOURCE=${sourcePath} TARGET=${dbPath}`); return; }
      await backup(db, dbPath);
      db.close();
      // SQLite restaura em transação, respeitando WAL/locks; não apagar sidecars
      // nem substituir um ficheiro debaixo de outra ligação SQLite aberta.
      await source.backup(dbPath);
      console.log(`ACTION=RESTORE TIMESTAMP=${new Date().toISOString()} SOURCE=${sourcePath} TARGET=${dbPath}`);
    } finally { source.close(); }
  } finally { if (db.open) db.close(); }
}

main().catch((error) => {
  // Não refletir erros SQL/argumentos que possam conter dados ou segredos.
  const message = error instanceof CliError ? error.message : `Falha na operação SQLite/ficheiro (${/^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'ERROR'}).`;
  console.error(`ERRO=${message}`);
  process.exitCode = 1;
});
