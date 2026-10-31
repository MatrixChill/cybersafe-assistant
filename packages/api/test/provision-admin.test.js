import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const cli = fileURLToPath(new URL('../scripts/provision-admin.mjs', import.meta.url));
const legacyPassword = 'CyberSafe2026!';
const goodPassword = 'N7!vQ2#zL9@rT5$x';

function fixture(t, { role = true, wal = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybersafe-provision-'));
  const dbPath = path.join(dir, 'cybersafe.db');
  const db = new Database(dbPath);
  if (wal) db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL, type TEXT NOT NULL, plan TEXT NOT NULL,
      ${role ? "role TEXT NOT NULL DEFAULT 'user'," : ''} companyName TEXT, createdAt TEXT NOT NULL);
    CREATE TABLE training_results (id TEXT PRIMARY KEY, userId TEXT, gameType TEXT NOT NULL,
      score INTEGER NOT NULL, maxScore INTEGER NOT NULL, completedAt TEXT NOT NULL);
    CREATE TABLE threat_events (id TEXT PRIMARY KEY, source TEXT, url TEXT);
  `);
  const oldHash = bcrypt.hashSync(legacyPassword, 4);
  db.prepare('INSERT INTO users (id,name,email,passwordHash,type,plan,createdAt) VALUES (?,?,?,?,?,?,?)')
    .run('legacy', 'Legacy', 'admin@cybersafe.local', oldHash, 'personal', 'premium', '2026-01-01');
  db.prepare('INSERT INTO training_results VALUES (?,?,?,?,?,?)').run('tr1', 'legacy', 'quiz', 1, 2, '2026-01-01');
  db.prepare('INSERT INTO threat_events VALUES (?,?,?)').run('ev1', 'extension', 'https://example.test');
  if (!wal) db.close();
  t.after(() => { if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const run = (args, { password, input, env: extraEnv } = {}) => {
    const env = { ...process.env, CYBERSAFE_DB_PATH: dbPath, ...extraEnv };
    // Decisão do utilizador (09/10/2026, condição 5): a palavra-passe NUNCA é
    // lida de variáveis de ambiente. Em teste não há TTY, por isso o caminho
    // não interativo exige --password-stdin explícito (aqui não há eco possível).
    delete env.CYBERSAFE_ADMIN_PASSWORD;
    // A flag só existe para --create: os outros modos não pedem palavra-passe.
    const needsPassword = args.includes('--create');
    const withFlag = password !== undefined && needsPassword ? [...args, '--password-stdin'] : args;
    return spawnSync(process.execPath, [cli, ...withFlag], {
      env,
      input: password !== undefined && needsPassword ? `${password}\n` : (input ?? ''),
      encoding: 'utf8',
      timeout: 15000,
    });
  };
  const read = (email = 'admin@cybersafe.local') => {
    const connection = new Database(dbPath, { readonly: true });
    try { return connection.prepare('SELECT * FROM users WHERE email = ?').get(email); }
    finally { connection.close(); }
  };
  return { dir, dbPath, db, oldHash, run, read };
}

function pass(result) { assert.equal(result.status, 0, result.stderr); }
function fail(result) { assert.notEqual(result.status, 0); assert.equal(result.signal, null, result.stderr); }
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const backupPath = (result) => result.stdout.match(/^BACKUP=(.+)$/m)?.[1].trim();

test('--inspect lista utilizadores/dependências sem alterar ficheiros', (t) => {
  const f = fixture(t);
  const before = { digest: digest(f.dbPath), mtime: fs.statSync(f.dbPath).mtimeMs, files: fs.readdirSync(f.dir) };
  const result = f.run(['--inspect']); pass(result);
  const info = JSON.parse(result.stdout);
  assert.equal(info.roleColumn.exists, true);
  assert.equal(info.users[0].id, 'legacy');
  assert.equal(info.users[0].role, 'user');
  assert.equal(info.users[0].trainingResults, 1);
  assert.equal(info.users[0].threatEventsTotal, 1);
  assert.equal(info.users[0].threatEventsOwnership, 'unowned');
  assert.equal(info.users[0].email, 'admin@cybersafe.local');
  assert.equal(info.users[0].type, 'personal');
  assert.equal(info.users[0].plan, 'premium');
  assert.equal(info.users[0].createdAt, '2026-01-01');
  assert.equal(digest(f.dbPath), before.digest);
  assert.equal(fs.statSync(f.dbPath).mtimeMs, before.mtime);
  assert.deepEqual(fs.readdirSync(f.dir), before.files);
  assert.doesNotMatch(result.stdout, /passwordHash|\$2[aby]\$/);
});

test('--create recusa palavras-passe fracas/previsíveis sem criar utilizador', (t) => {
  const f = fixture(t);
  for (const password of ['short', 'Password12345!', 'P@ssw0rd1234!', 'Zxcvbnm12345!', 'aaaaaaaaaaaa', 'Abcdefgh1234!', '123456789012', 'Ab!Ab!Ab!Ab!', 'correct horse battery staple']) {
    const result = f.run(['--create', '--email', 'owner@example.test'], { password }); fail(result);
    assert.equal(f.read('owner@example.test'), undefined);
    assert.ok(!result.stdout.includes(password) && !result.stderr.includes(password));
  }
});

test('--create recusa a credencial DEV conhecida', (t) => {
  const f = fixture(t);
  fail(f.run(['--create', '--email', 'owner@example.test'], { password: legacyPassword }));
  assert.equal(f.read('owner@example.test'), undefined);
});

test('--create cria admin com bcrypt custo 12 e palavra-passe fornecida', (t) => {
  const f = fixture(t);
  const result = f.run(['--create', '--email', 'owner@example.test'], { password: goodPassword }); pass(result);
  const user = f.read('owner@example.test');
  assert.equal(user.role, 'admin');
  assert.equal(user.type, 'personal');
  assert.equal(user.plan, 'free');
  assert.equal(bcrypt.getRounds(user.passwordHash), 12);
  assert.equal(bcrypt.compareSync(goodPassword, user.passwordHash), true);
  assert.ok(!result.stdout.includes(goodPassword));
  assert.ok(!result.stdout.includes(user.passwordHash));
});

test('a palavra-passe nunca é lida do ambiente nem de stdin sem flag explícita', (t) => {
  const f = fixture(t);
  const goodPassword = 'R8#kM3!wX6$qJ2%pz';

  // (a) só a variável de ambiente: tem de ser IGNORADA (nada é criado).
  const viaEnv = f.run(['--create', '--email', 'owner@example.test'], { env: { CYBERSAFE_ADMIN_PASSWORD: goodPassword } });
  fail(viaEnv);
  assert.equal(f.read('owner@example.test'), undefined);
  assert.ok(!viaEnv.stdout.includes(goodPassword) && !viaEnv.stderr.includes(goodPassword));

  // (b) stdin com dados mas sem --password-stdin: recusa (não há TTY para
  //     garantir leitura sem eco, e adivinhar seria pior do que falhar).
  const viaPipedStdin = f.run(['--create', '--email', 'owner@example.test'], { input: `${goodPassword}\n` });
  fail(viaPipedStdin);
  assert.equal(f.read('owner@example.test'), undefined);

  // (c) a flag só é válida com --create.
  fail(f.run(['--inspect', '--password-stdin']));
});

test('--create --password-stdin promove sem alterar passwordHash', (t) => {
  const f = fixture(t);
  pass(f.run(['--create', '--email', 'owner@example.test'], { password: 'R8#kM3!wX6$qJ2%pz' }));
  const hash = f.read('owner@example.test').passwordHash;
  const db = new Database(f.dbPath);
  db.prepare("UPDATE users SET role='user' WHERE email=?").run('owner@example.test'); db.close();
  const result = f.run(['--create', '--email', 'owner@example.test'], { password: 'R8#kM3!wX6$qJ2%p' }); pass(result);
  assert.equal(f.read('owner@example.test').role, 'admin');
  assert.equal(f.read('owner@example.test').passwordHash, hash);
  assert.match(result.stdout, /palavra-passe existente não foi alterada/);
});

test('--rotate-legacy-dev sem admin legítimo recusa e preserva hash', (t) => {
  const f = fixture(t);
  const result = f.run(['--rotate-legacy-dev', '--confirm']); fail(result);
  assert.match(result.stderr, /administrador.*legítimo/i);
  assert.equal(f.read().passwordHash, f.oldHash);
  assert.equal(fs.readdirSync(f.dir).length, 1);
});

test('a conta DEV já admin NÃO satisfaz o requisito de admin legítimo', (t) => {
  const f = fixture(t);
  const db = new Database(f.dbPath);
  db.prepare("UPDATE users SET role='admin' WHERE id='legacy'").run(); db.close();
  fail(f.run(['--rotate-legacy-dev', '--confirm']));
  assert.equal(f.read().passwordHash, f.oldHash);
  assert.equal(fs.readdirSync(f.dir).length, 1);
});

test('DB ausente não é criada e argumentos inválidos não modificam a existente', (t) => {
  const f = fixture(t);
  const before = digest(f.dbPath);
  for (const args of [['--create'], ['--inspect', '--create'], ['--create', '--email', 'invalid'], ['--create', '--email', 'admin@cybersafe.local']]) fail(f.run(args, { password: goodPassword }));
  assert.equal(digest(f.dbPath), before);
  const missing = path.join(f.dir, 'missing.db');
  const result = spawnSync(process.execPath, [cli, '--inspect'], { env: { ...process.env, CYBERSAFE_DB_PATH: missing }, encoding: 'utf8' });
  fail(result);
  assert.equal(fs.existsSync(missing), false);
});

test('--rotate-legacy-dev faz backup e --restore prova rollback sem perder dados', (t) => {
  const f = fixture(t);
  pass(f.run(['--create', '--email', 'owner@example.test'], { password: goodPassword }));
  const rotated = f.run(['--rotate-legacy-dev', '--confirm']); pass(rotated);
  const backup = backupPath(rotated);
  assert.ok(backup && fs.existsSync(backup));
  const user = f.read();
  assert.equal(user.id, 'legacy');
  assert.notEqual(user.passwordHash, f.oldHash);
  assert.equal(bcrypt.compareSync(legacyPassword, user.passwordHash), false);
  assert.ok(!rotated.stdout.includes(user.passwordHash));
  const snapshot = new Database(backup, { readonly: true });
  assert.equal(snapshot.prepare("SELECT passwordHash FROM users WHERE id='legacy'").get().passwordHash, f.oldHash);
  snapshot.close();
  const restored = f.run(['--restore', backup, '--confirm']); pass(restored);
  assert.ok(fs.existsSync(backupPath(restored)), 'restore guarda primeiro a DB atual');
  const beforeRestore = new Database(backupPath(restored), { readonly: true });
  assert.equal(beforeRestore.prepare("SELECT passwordHash FROM users WHERE id='legacy'").get().passwordHash, user.passwordHash,
    'o backup pré-restore contém exatamente a credencial rodada, permitindo desfazer o rollback');
  beforeRestore.close();
  assert.equal(f.read().passwordHash, f.oldHash);
  assert.equal(f.read('owner@example.test').role, 'admin');
  const db = new Database(f.dbPath, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM threat_events').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM training_results').get().n, 1); db.close();
});

test('dry-run de todos os modos de escrita não muda DB nem cria backups', (t) => {
  const f = fixture(t);
  pass(f.run(['--create', '--email', 'owner@example.test'], { password: goodPassword }));
  const copy = path.join(f.dir, 'snapshot.sqlite'); fs.copyFileSync(f.dbPath, copy);
  const before = { hash: digest(f.dbPath), files: fs.readdirSync(f.dir), mtime: fs.statSync(f.dbPath).mtimeMs };
  for (const args of [
    ['--create', '--email', 'other@example.test', '--dry-run'],
    ['--rotate-legacy-dev', '--dry-run'],
    ['--restore', copy, '--dry-run'],
  ]) { pass(f.run(args, { password: goodPassword })); }
  assert.equal(digest(f.dbPath), before.hash);
  assert.equal(fs.statSync(f.dbPath).mtimeMs, before.mtime);
  assert.deepEqual(fs.readdirSync(f.dir), before.files);
});

test('rotação/restore sem --confirm recusam sem escrita; backup inválido também', (t) => {
  const f = fixture(t);
  const before = digest(f.dbPath);
  fail(f.run(['--rotate-legacy-dev']));
  fail(f.run(['--restore', f.dbPath]));
  const invalid = path.join(f.dir, 'invalid.sqlite'); fs.writeFileSync(invalid, 'not sqlite');
  fail(f.run(['--restore', invalid, '--confirm']));
  fail(f.run(['--restore', f.dbPath, '--confirm']));
  assert.equal(digest(f.dbPath), before);
  assert.equal(fs.readdirSync(f.dir).filter((name) => name.includes('.backup-')).length, 0);
});

test('DB legada sem role: inspect é honesto; create migra sem perder dados', (t) => {
  const f = fixture(t, { role: false });
  const before = digest(f.dbPath);
  const result = f.run(['--inspect']); pass(result);
  const info = JSON.parse(result.stdout);
  assert.equal(info.roleColumn.exists, false);
  assert.equal(info.users[0].role, null);
  assert.equal(digest(f.dbPath), before);
  pass(f.run(['--create', '--email', 'owner@example.test'], { password: goodPassword }));
  assert.equal(f.read().role, 'user');
  assert.equal(f.read().passwordHash, f.oldHash);
  assert.equal(f.read('owner@example.test').role, 'admin');
});

test('backup e restore incluem commits WAL com outra ligação aberta', (t) => {
  const f = fixture(t, { wal: true });
  pass(f.run(['--create', '--email', 'owner@example.test'], { password: goodPassword }));
  const rotated = f.run(['--rotate-legacy-dev', '--confirm']); pass(rotated);
  const snapshot = new Database(backupPath(rotated), { readonly: true });
  assert.equal(snapshot.prepare('SELECT COUNT(*) AS n FROM training_results').get().n, 1);
  assert.equal(snapshot.prepare("SELECT role FROM users WHERE email='owner@example.test'").get().role, 'admin');
  snapshot.close();
  pass(f.run(['--restore', backupPath(rotated), '--confirm']));
  assert.equal(f.db.prepare("SELECT passwordHash FROM users WHERE id='legacy'").get().passwordHash, f.oldHash);
});
