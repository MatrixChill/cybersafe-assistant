#!/usr/bin/env node
/**
 * dev-preflight.mjs — diagnóstico READ-ONLY para arrancar a stack de DEV/PREVIEW.
 *
 * Não escreve, não cria contas, não abre a DB pessoal, não imprime segredos.
 * Só reporta NOMES/PRESENÇA de variáveis, carga do módulo nativo, estado dos
 * listeners e se a allowlist CORS já cobre a porta de preview. Sai 0 se nada
 * estrutura bloquear; 1 apenas se um pré-requisito de runtime falhar (ABI).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REJECTED = new Set(["cybersafe-fallback-secret", "altera-isto-em-producao"]);
const MIN_SECRET = 32;

let blocks = 0;
const line = (tag, msg) => console.log(`${tag.padEnd(6)} ${msg}`);
const PASS = (m) => line("PASS", m);
const WARN = (m) => line("WARN", m);
const FAIL = (m) => { blocks += 1; line("BLOCK", m); };

function probePort(host, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (listening) => { try { socket.destroy(); } catch {} resolve(listening); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

// ── Node ──
const major = Number(process.versions.node.split(".")[0]);
PASS(`node ${process.versions.node} (>=20: ${major >= 20 ? "ok" : "NO"}` + (major >= 20 ? ")" : ")"));

// ── JWT_SECRET: só presença/qualidade, NUNCA o valor ──
const secret = (process.env.JWT_SECRET ?? "").trim();
if (!secret) WARN("JWT_SECRET ausente no ambiente do preflight (a API lê packages/api/.env; ver o check .env abaixo — se lá estiver, o arranque normal funciona).");
else if (secret.length < MIN_SECRET) FAIL(`JWT_SECRET demasiado curto (<${MIN_SECRET}); arranque bloqueado.`);
else if (REJECTED.has(secret)) FAIL("JWT_SECRET é um valor conhecido/fraco (rejeitado pela API); troque-o.");
else PASS(`JWT_SECRET presente (len=${secret.length}, qualidade=ok) — valor não impresso.`);

// ── Módulo nativo better-sqlite3 (ABI do Node) ──
try {
  require("better-sqlite3");
  PASS("better-sqlite3 carregou (native ABI compatível com este Node).");
} catch (error) {
  FAIL(`better-sqlite3 NÃO carregou: ${(error && error.message) || error}. Reconstruir o módulo nativo para esta ABI é necessário antes de correr a API.`);
}

// ── Build do API (dist) presente? ──
const distIndex = path.join(repoRoot, "packages", "api", "dist", "index.js");
if (fs.existsSync(distIndex)) PASS("packages/api/dist/index.js existe (npm run build -w api já foi corrido).");
else WARN("packages/api/dist/index.js ausente — corre `npm run build -w api` (dev:api usa tsx e não precisa de dist).");

// ── Allowlist CORS cobre a porta de preview (4173)? ──
// Inspeção de TEXTO (não importa o módulo para não abrir/semear a DB).
const srcIndex = path.join(repoRoot, "packages", "api", "src", "index.ts");
try {
  const txt = fs.readFileSync(srcIndex, "utf8");
  const block = (txt.match(/DEFAULT_ALLOWED_ORIGINS\s*=\s*\[[\s\S]*?\]/) || [""])[0];
  const has4173 = /localhost:4173/.test(block) && /127\.0\.0\.1:4173/.test(block);
  if (has4173) PASS("CORS default inclui as origens de PREVIEW (localhost:4173 + 127.0.0.1:4173).");
  else FAIL("CORS default NÃO inclui a porta de preview 4173 ⇒ preflight do login daria 403 sem ACAO (aplica o fix em packages/api/src/index.ts).");
  const has5173 = /localhost:5173/.test(block);
  if (!has5173) WARN("Falta localhost:5173 na allowlist (dev server).");
} catch (error) {
  WARN(`não consegui ler ${srcIndex}: ${error.message}`);
}

// ── Variáveis OPCIONAIS relevantes (nomes/presença) ──
for (const name of ["CYBERSAFE_API_PORT", "CYBERSAFE_API_ALLOWED_ORIGINS", "CYBERSAFE_API_ALLOW_NULL_ORIGIN", "CYBERSAFE_DB_PATH", "CYBERSAFE_AI_PROVIDER", "CYBERSAFE_AI_BASE_URL", "CYBERSAFE_AI_MODEL", "CYBERSAFE_AI_API_KEY", "GROQ_API_KEY", "OPENAI_API_KEY"]) {
  const present = process.env[name] !== undefined && String(process.env[name]).trim() !== "";
  line(present ? "set" : "unset", `${name}${present ? " (valor não impresso)" : ""}`);
}

// ── DB path (não abre; só estat) ──
const dbPath = process.env.CYBERSAFE_DB_PATH ? path.resolve(process.env.CYBERSAFE_DB_PATH) : path.join(os.homedir(), ".cybersafe-service", "cybersafe.db");
const isPersonalDefault = !process.env.CYBERSAFE_DB_PATH;
line("db", `CYBERSAFE_DB_PATH=${isPersonalDefault ? "(default)" : "(override)"}  existe=${fs.existsSync(dbPath)}  ${isPersonalDefault ? "[DB pessoal — préflight não escreve]" : ""}`);

// ── Listeners em tempo real ──
const checks = [
  ["api:4000", "127.0.0.1", 4000],
  ["preview:4173 v4", "127.0.0.1", 4173],
  ["preview:4173 v6", "::1", 4173],
  ["vite-dev:5173", "127.0.0.1", 5173],
];
for (const [label, host, port] of checks) {
  const listening = await probePort(host, port);
  line(listening ? "LISTEN" : "free", `${label} (${host})`);
}

// ── FULL-STACK readiness (o requisito do utilizador é frontend+Electron+serviço+API) ──
// O comando COMPLETO já existe: `npm run dev` = concurrently dev:service + dev:api
// + dev:app + dev:desktop. Não duplicamos; só validamos pré-condições e ordem.
line("full", "comando completo: `npm run dev` (service+api+app+desktop via concurrently) — NÃO é o modo preview");

// Motor nativo de que desktop/serviço dependem (sem o executar).
const engineExe = path.join(repoRoot, "packages", "native-engine", "build", "Release", "scan-engine.exe");
if (fs.existsSync(engineExe)) PASS("motor nativo presente: scan-engine.exe (necessário a dev:desktop/dev:service).");
else WARN("scan-engine.exe AUSENTE — dev:desktop/dev:service perdem o motor; construir nativo é pré-requisito (fora deste preflight).");

// JWT_SECRET da API: só PRESENÇA da chave em packages/api/.env (NUNCA o valor). Se
// ausente/curto, `dev:api` aborta antes do listener (S1) — o arranque completo falha aqui.
const apiEnv = path.join(repoRoot, "packages", "api", ".env");
if (fs.existsSync(apiEnv)) {
  const keys = new Set(
    fs.readFileSync(apiEnv, "utf8").split(/\r?\n/)
      .filter((l) => l && !l.trim().startsWith("#") && l.includes("="))
      .map((l) => l.split("=")[0].trim()),
  );
  if (keys.has("JWT_SECRET")) PASS("packages/api/.env define JWT_SECRET (presença; valor não impresso) — dev:api pode abrir o listener.");
  else FAIL("packages/api/.env NÃO define JWT_SECRET — `dev:api` aborta antes do listener; o arranque completo fica bloqueado.");
} else {
  WARN("packages/api/.env ausente — só arranca se JWT_SECRET vier do ambiente do chamador.");
}

// Postura honesta: o preflight NÃO arranca service/Electron (o serviço pode ligar o
// motor e o desktop pode, ao ligar, pedir monitor.start → proteção/scan). Nada é
// iniciado aqui; proteção fica OFF até monitor.start (index.ts:155).
line("note", "preflight NÃO inicia serviço/Electron/scan/proteção nem altera política do Windows.");


console.log("");
if (blocks > 0) {
  console.log(`PREFLIGHT: ${blocks} BLOCK. Resolve os BLOCK acima antes de arrancar; WARN não bloqueia.`);
  process.exit(1);
}
console.log("PREFLIGHT: GO (sem BLOCK).");
console.log("  • PREVIEW (só API+build servido, sem serviço/Electron):  powershell -NoProfile -File scripts\\dev-full.ps1");
console.log("  • STACK COMPLETO (frontend+Electron+serviço+API, o requisito):  npm run dev");
console.log("    (concurrently dev:service+dev:api+dev:app+dev:desktop; proteção fica OFF até monitor.start no desktop).");
