#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import { askHidden, readPipedLine, PromptError } from "./lib/hidden-prompt.mjs";

// ── Verificação da migração de conta (condição 8 da decisão de 09/10/2026) ──
// Comprova, contra a instalação real: o novo administrador entra, a credencial
// DEV legada já não entra, a sessão continua válida depois de reiniciar a API,
// terminar a sessão é efetivo e os dados não se perdem.
//
// Regras de segurança: a palavra-passe é pedida de forma interativa e SEM ECO
// (ou via --password-stdin, para automação); nada de segredos em argumentos,
// ambiente, stdout, logs ou ficheiros.

const LEGACY_EMAIL = "admin@cybersafe.local";
// Credencial DEV publicada (a que tem de deixar de funcionar). É um valor
// conhecido e público; serve apenas para provar que o login é recusado.
const LEGACY_DEV_PASSWORD = "CyberSafe2026!";

class CliError extends Error {}
const refuse = (message) => {
  throw new CliError(message);
};

function parseArgs(args) {
  const options = { api: "http://127.0.0.1:4000" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!["--email", "--api", "--db", "--await-restart", "--password-stdin", "--help"].includes(arg)) {
      refuse("Argumento desconhecido. Use --help.");
    }
    if (Object.hasOwn(options, arg)) refuse("Argumento repetido.");
    if (arg === "--email" || arg === "--api" || arg === "--db") {
      const value = args[++i];
      if (!value || value.startsWith("--")) refuse("Falta um valor de argumento.");
      options[arg] = value;
    } else options[arg] = true;
  }
  if (options["--help"]) return options;
  if (!options["--email"]) refuse("Indique o email do administrador legítimo com --email.");
  options["--email"] = options["--email"].trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options["--email"])) refuse("Email inválido.");
  if (options["--email"] === LEGACY_EMAIL) refuse("O email indicado é a própria conta DEV legada; use a conta legítima.");
  // `--api` é guardado com o nome da flag (as chaves têm de ser distinguíveis
  // de `api`, o valor já resolvido que o resto do script usa).
  options.api = (options["--api"] ?? options.api).replace(/\/+$/, "");
  delete options["--api"];
  return options;
}

function dbPathFrom(options) {
  const resolved = options["--db"]
    ? path.resolve(options["--db"])
    : process.env.CYBERSAFE_DB_PATH
      ? path.resolve(process.env.CYBERSAFE_DB_PATH)
      : path.join(os.homedir(), ".cybersafe-service", "cybersafe.db");
  if (!fs.existsSync(resolved)) refuse(`DB não encontrada: ${resolved}`);
  return resolved;
}

const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** Leitura read-only: contagens + impressão digital dos dados de conta. */
function snapshot(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 3000 });
  try {
    const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const count = (table) => (columns(table).length ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : 0);
    const users = db.prepare("SELECT id, email, role, type, plan, createdAt FROM users ORDER BY id").all();
    const hashes = db.prepare("SELECT id, passwordHash FROM users ORDER BY id").all();
    const legacy = users.find((user) => (user.email || "").toLowerCase() === LEGACY_EMAIL) ?? null;
    return {
      users: users.length,
      trainingResults: count("training_results"),
      threatEvents: count("threat_events"),
      usersDigest: digest(JSON.stringify(users)),
      hashesById: Object.fromEntries(hashes.map((row) => [row.id, digest(row.passwordHash)])),
      legacy: legacy ? { id: legacy.id, role: legacy.role } : null,
    };
  } finally {
    db.close();
  }
}

async function login(api, email, password) {
  const res = await fetch(`${api}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* resposta sem JSON */
  }
  return { status: res.status, token: body?.token, user: body?.user };
}

async function me(api, token) {
  const res = await fetch(`${api}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* resposta sem JSON */
  }
  return { status: res.status, user: body?.user };
}

async function waitForEnter(message) {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await new Promise((resolve) => reader.question(message, resolve));
  } finally {
    reader.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options["--help"]) {
    console.log(
      "Uso: verify-account-migration.mjs --email <admin-legitimo> [--api http://127.0.0.1:4000] [--db <caminho>] [--await-restart] [--password-stdin]\n" +
        "A palavra-passe é pedida de forma interativa e SEM ECO (nunca vem de argumentos nem do ambiente).\n" +
        "Verifica: login do novo admin, /auth/me, recusa do login da conta DEV legada, sessão após reinício (com --await-restart), fim de sessão e conservação dos dados.\n" +
        "Exit 0 = todas as verificações passaram. Nada é escrito na DB.",
    );
    return;
  }

  const dbPath = dbPathFrom(options);
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const before = snapshot(dbPath);
  console.log(
    `INFO DATA_BEFORE users=${before.users} training=${before.trainingResults} events=${before.threatEvents} ` +
      `legacy=${before.legacy ? `role=${before.legacy.role}` : "ausente"}`,
  );

  const password = options["--password-stdin"]
    ? await readPipedLine()
    : await askHidden(`Palavra-passe de ${options["--email"]} (não é mostrada, nem com máscaras): `);
  if (!password) refuse("Palavra-passe vazia.");

  let reachable = false;
  try {
    const health = await fetch(`${options.api}/health`);
    reachable = health.ok;
  } catch {
    reachable = false;
  }
  check("API_REACHABLE", reachable, `${options.api}/health`);
  if (!reachable) refuse("A API local não respondeu. Arranca a API/aplicação e repete este comando.");

  const admin = await login(options.api, options["--email"], password);
  check("LOGIN_NEW_ADMIN", admin.status === 200 && Boolean(admin.token), `HTTP ${admin.status}`);
  if (admin.status !== 200 || !admin.token) {
    console.log("INFO A migração não pode ser validada sem um login de administrador que funcione.");
  }

  if (admin.token) {
    const session = await me(options.api, admin.token);
    const matches = session.status === 200 && (session.user?.email || "").toLowerCase() === options["--email"];
    check("SESSION_ME", matches, `HTTP ${session.status}`);

    const legacy = await login(options.api, LEGACY_EMAIL, LEGACY_DEV_PASSWORD);
    check(
      "LEGACY_LOGIN_BLOCKED",
      legacy.status === 401,
      legacy.status === 200 ? "a credencial DEV ainda entra (401 esperado)" : `HTTP ${legacy.status}`,
    );

    if (options["--await-restart"]) {
      await waitForEnter(
        "Reinicia agora a API/aplicação (mesmo segredo) e prime Enter para continuar a verificação: ",
      );
      const after = await me(options.api, admin.token);
      check("SESSION_AFTER_RESTART", after.status === 200, `HTTP ${after.status}`);
    } else {
      console.log("INFO SESSION_AFTER_RESTART não verificado (usa --await-restart para o incluir).");
    }

    // Fim de sessão: não há endpoint de logout no servidor — a sessão termina
    // quando o token deixa de ser apresentado. Verifica-se que sem token não há
    // acesso (o que o cliente faz ao apagar o token do armazenamento local).
    const anonymous = await fetch(`${options.api}/auth/me`);
    check("LOGOUT_NO_TOKEN_DENIED", anonymous.status === 401, `HTTP ${anonymous.status}`);
  }

  const after = snapshot(dbPath);
  const dataPreserved = before.users === after.users
    && before.trainingResults === after.trainingResults
    && before.threatEvents === after.threatEvents
    && before.usersDigest === after.usersDigest;
  check(
    "DATA_PRESERVED",
    dataPreserved,
    `users ${before.users}->${after.users}, training ${before.trainingResults}->${after.trainingResults}, ` +
      `events ${before.threatEvents}->${after.threatEvents}`,
  );

  const legacyPresent = Boolean(after.legacy);
  check("LEGACY_ACCOUNT_ROW_PRESERVED", legacyPresent, legacyPresent ? `role=${after.legacy.role}` : "linha desapareceu");

  if (admin.token) {
    const changed = Object.keys({ ...before.hashesById, ...after.hashesById })
      .filter((id) => before.hashesById[id] !== after.hashesById[id]);
    const legacyId = after.legacy?.id;
    const onlyLegacyChanged = changed.length === 0 || (changed.length === 1 && changed[0] === legacyId);
    check(
      "PASSWORD_HASHES_UNCHANGED",
      onlyLegacyChanged,
      changed.length === 0 ? "nenhum hash mudou" : `${changed.length} hash(es) mudaram (esperado: só o da conta DEV)`,
    );
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`SUMMARY ${results.length - failed.length}/${results.length} PASS`);
  console.log(
    failed.length === 0
      ? "RESULTADO=TODAS_AS_VERIFICACOES_PASSARAM. Guarda os caminhos de backup impressos pelo provisionamento. Se ainda não rodaste o segredo JWT, as sessões antigas continuam válidas até expirarem."
      : `RESULTADO=FALHOU (${failed.map((result) => result.name).join(", ")}). Não declares a migração concluída.`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  const message =
    error instanceof CliError || error instanceof PromptError
      ? error.message
      : `Falha inesperada (${error?.code ?? "ERROR"}).`;
  console.error(`ERRO=${message}`);
  process.exitCode = 1;
});
