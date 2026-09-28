import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import os from 'os';

// ── SQLite Database Setup ──

// CYBERSAFE_DB_PATH permite aos testes usar uma DB isolada; o default é a DB real do serviço.
const dbPath = process.env.CYBERSAFE_DB_PATH
  ? path.resolve(process.env.CYBERSAFE_DB_PATH)
  : path.join(os.homedir(), '.cybersafe-service', 'cybersafe.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

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
