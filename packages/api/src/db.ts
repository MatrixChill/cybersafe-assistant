import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import os from 'os';
import { validarArranqueApi } from './dev-isolation.js';

// ── SQLite Database Setup ──

// A guarda corre ANTES do `mkdir` e do `new Database`: era aqui que um DEV sem configuração
// criava `%USERPROFILE%\.cybersafe-service\` e abria a base de dados real do utilizador.
// Produção explícita (NODE_ENV=production, o que o instalador define) mantém o default de sempre.
const arranque = validarArranqueApi({ entrypoint: process.argv[1] ?? '', env: process.env });
const dbPath = arranque.dbPath;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

/**
 * Caminho resolvido da DB desta instância. Exportado para o diagnóstico de
 * ciclo de vida (o registo vive ao lado da DB) e para as sondas poderem
 * declarar o ficheiro que estão a usar sem o reconstruir.
 */
export const DATABASE_FILE_PATH = dbPath;
// Logout must survive API restarts. Only token fingerprints are persisted.
db.exec(`CREATE TABLE IF NOT EXISTS auth_revoked_tokens (
  fingerprint TEXT PRIMARY KEY,
  expiresAt REAL NOT NULL
)`);
export function isAuthTokenRevoked(fingerprint: string): boolean {
  return !!db.prepare('SELECT 1 FROM auth_revoked_tokens WHERE fingerprint = ? AND expiresAt > ?').get(fingerprint, Date.now() / 1000);
}
export function revokeAuthToken(fingerprint: string, expiresAt: number): boolean {
  return db.transaction(() => {
    db.prepare('DELETE FROM auth_revoked_tokens WHERE expiresAt <= ?').run(Date.now() / 1000);
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM auth_revoked_tokens').get() as { count: number };
    if (count >= 10000) return false;
    db.prepare('INSERT OR REPLACE INTO auth_revoked_tokens (fingerprint, expiresAt) VALUES (?, ?)').run(fingerprint, expiresAt);
    return true;
  })();
}

/**
 * Fecha a ligacao singleton. Usada pelos testes no teardown: sem isto o
 * Windows mantem o handle do ficheiro sqlite aberto e o `rm` do diretorio
 * temporario falha com EPERM, deixando lixo em %TEMP%. Idempotente: chamar
 * duas vezes ou depois de fechada nao faz nada.
 */
export function closeDb(): void {
  if (db.open) {
    db.close();
  }
}

// ── Migrations ──

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    type TEXT NOT NULL,
    plan TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    companyName TEXT,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS threat_events (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    url TEXT,
    domain TEXT,
    severity TEXT NOT NULL,
    confidence REAL,
    rulesTriggered TEXT,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS training_results (
    id TEXT PRIMARY KEY,
    userId TEXT,
    gameType TEXT NOT NULL,
    score INTEGER NOT NULL,
    maxScore INTEGER NOT NULL,
    completedAt TEXT NOT NULL
  );
`);

// Migração de DBs legadas (criadas antes de existir role): ALTER TABLE é
// não-destrutivo e o DEFAULT 'user' mantém todas as contas existentes válidas.
const usersColumns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
if (!usersColumns.some((column) => column.name === 'role')) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}

// ── TP-MATRIX-FINAL-CONSENT ──
// Duas tabelas e nada mais. `app_installation` guarda o identificador OPACO desta
// instalação (UUID gerado por este processo e persistido cá): é o que faz um grant
// criado noutro dispositivo — ou noutra reinstalação — não valer aqui. Não é
// hardware ID, não é derivado do utilizador, não é segredo.
// `process_consent_grants` guarda só METADADOS da escolha explícita: fornecedor
// como hash (nunca URL nem chave), finalidade, lista de campos, datas, revogação e
// revisão. Não existe coluna para métricas de processo nem para texto de conversa,
// e é de propósito: um grant não pode transformar-se em contentor de dados.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_installation (
    id TEXT PRIMARY KEY,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS process_consent_grants (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    installationId TEXT NOT NULL,
    providerKey TEXT NOT NULL,
    purpose TEXT NOT NULL,
    fields TEXT NOT NULL,
    allowFutureProcesses INTEGER NOT NULL,
    persistent INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    revokedAt TEXT,
    revision INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_process_consent_conta
    ON process_consent_grants (userId, installationId, revokedAt);
`);

// ── TP-MATRIX-R2-CONSENT ──
// `process_consent_one_shots` é a autorização de UM envio, emitida e consumida por
// este processo. O token nunca é guardado: guarda-se o SHA-256 dele, pelo que uma
// leitura da base não devolve nenhuma chave utilizável. Guarda também o ALVO
// (pid + início) porque a autorização é «para este processo», não «para processos em
// geral» — e o início é o que distingue um pid reutilizado do processo que a pessoa
// apontou. Continuam a não existir colunas para métricas, texto ou segredos.
db.exec(`
  CREATE TABLE IF NOT EXISTS process_consent_one_shots (
    id TEXT PRIMARY KEY,
    tokenHash TEXT NOT NULL UNIQUE,
    userId TEXT NOT NULL,
    installationId TEXT NOT NULL,
    providerKey TEXT NOT NULL,
    purpose TEXT NOT NULL,
    fields TEXT NOT NULL,
    targetPid INTEGER NOT NULL,
    targetStartedAt TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    consumedAt TEXT,
    revokedAt TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_consent_one_shot_conta
    ON process_consent_one_shots (userId, installationId, consumedAt, revokedAt);
`);

/**
 * Devolve a ligação singleton para módulos que precisam de statements preparados
 * sem abrir um segundo handle sobre o mesmo ficheiro. O teardown continua a ser
 * exclusivamente o `closeDb()` acima — ninguém mais fecha a base.
 */
export function getDb() {
  return db;
}

// ── Types ──

export interface Company {
  name: string;
  size?: string;
  sector?: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  type: "personal" | "business";
  plan: "free" | "pro" | "premium";
  role: UserRole;
  company?: Company;
  createdAt: Date;
}

export type UserRole = "user" | "admin";

// ── Prisma-like Adapter ──

export const prisma = {
  user: {
    findUnique: async ({ where }: { where: { email?: string; id?: string } }): Promise<User | null> => {
      let row;
      if (where.email) {
        row = db.prepare('SELECT * FROM users WHERE email = ?').get(where.email) as any;
      } else if (where.id) {
        row = db.prepare('SELECT * FROM users WHERE id = ?').get(where.id) as any;
      }

      if (!row) return null;

      return {
        id: row.id,
        name: row.name,
        email: row.email,
        passwordHash: row.passwordHash,
        type: row.type,
        plan: row.plan,
        role: row.role === 'admin' ? 'admin' : 'user',
        company: row.companyName ? { name: row.companyName } : undefined,
        createdAt: new Date(row.createdAt)
      };
    },
    create: async ({ data }: { data: Omit<User, "id" | "createdAt"> }): Promise<User> => {
      const id = `usr-${Math.random().toString(36).substring(2, 10)}`;
      const createdAt = new Date().toISOString();
      const role: UserRole = data.role === 'admin' ? 'admin' : 'user';

      const stmt = db.prepare('INSERT INTO users (id, name, email, passwordHash, type, plan, role, companyName, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      stmt.run(id, data.name, data.email, data.passwordHash, data.type, data.plan, role, data.company?.name || null, createdAt);

      return {
        ...data,
        role,
        id,
        createdAt: new Date(createdAt)
      };
    },
    setRole: async ({ where, role }: { where: { email: string }; role: UserRole }): Promise<void> => {
      db.prepare('UPDATE users SET role = ? WHERE email = ?').run(role, where.email);
    },
  },

  threatEvent: {
    findMany: async (args?: any) => {
      let query = 'SELECT * FROM threat_events';
      if (args?.orderBy?.createdAt === 'desc') {
        query += ' ORDER BY createdAt DESC';
      }
      if (args?.take) {
        query += ` LIMIT ${Number(args.take)}`;
      }

      const rows = db.prepare(query).all() as any[];
      return rows.map(r => ({
        ...r,
        rulesTriggered: r.rulesTriggered ? JSON.parse(r.rulesTriggered) : [],
        createdAt: new Date(r.createdAt)
      }));
    },
    create: async ({ data }: any) => {
      const id = `m-${Math.random().toString(36).substring(7)}`;
      const createdAt = (data.createdAt || new Date()).toISOString();
      const rulesStr = JSON.stringify(data.rulesTriggered || []);

      const stmt = db.prepare('INSERT INTO threat_events (id, source, url, domain, severity, confidence, rulesTriggered, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      stmt.run(id, data.source, data.url, data.domain, data.severity, data.confidence, rulesStr, createdAt);

      return { ...data, id, createdAt: new Date(createdAt) };
    },
    createMany: async ({ data }: any) => {
      const insert = db.prepare('INSERT INTO threat_events (id, source, url, domain, severity, confidence, rulesTriggered, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

      const runMany = db.transaction((items) => {
        for (const item of items) {
          const id = `m-${Math.random().toString(36).substring(7)}`;
          const createdAt = (item.createdAt || new Date()).toISOString();
          const rulesStr = JSON.stringify(item.rulesTriggered || []);
          insert.run(id, item.source, item.url, item.domain, item.severity, item.confidence, rulesStr, createdAt);
        }
      });

      runMany(data);
      return { count: data.length };
    },
    deleteMany: async () => {
      const result = db.prepare('DELETE FROM threat_events').run();
      return { count: result.changes };
    }
  },

  trainingResult: {
    findMany: async (args?: any) => {
      let query = 'SELECT * FROM training_results';
      if (args?.orderBy?.completedAt === 'desc') {
        query += ' ORDER BY completedAt DESC';
      }
      if (args?.take) {
        query += ` LIMIT ${Number(args.take)}`;
      }

      const rows = db.prepare(query).all() as any[];
      return rows.map(r => ({
        ...r,
        completedAt: new Date(r.completedAt)
      }));
    },
    create: async ({ data }: any) => {
      const id = `tr-${Math.random().toString(36).substring(7)}`;
      const completedAt = new Date().toISOString();

      const stmt = db.prepare('INSERT INTO training_results (id, userId, gameType, score, maxScore, completedAt) VALUES (?, ?, ?, ?, ?, ?)');
      stmt.run(id, data.userId || null, data.gameType, data.score, data.maxScore, completedAt);

      return { ...data, id, completedAt: new Date(completedAt) };
    }
  }
};

// Seed initial data if DB is empty
const eventCount = db.prepare('SELECT COUNT(*) as c FROM threat_events').get() as {c: number};
if (eventCount.c === 0) {
  prisma.threatEvent.createMany({
    data: [
      {
        source: "dashboard",
        url: "file://suspicious-file.exe",
        domain: "file-scan",
        severity: "critical",
        confidence: 0.98,
        rulesTriggered: ["dangerous_file_extension", "heuristic_match"],
        createdAt: new Date(Date.now() - 1000 * 60 * 5)
      },
      {
        source: "extension",
        url: "http://phishing-site.net/login",
        domain: "phishing-site.net",
        severity: "high",
        confidence: 0.85,
        rulesTriggered: ["known_phishing_domain"],
        createdAt: new Date(Date.now() - 1000 * 60 * 15)
      }
    ]
  });
}
