import express from "express";
import { apiHealthPayload } from "./health-payload.js";
import dotenv from "dotenv";
dotenv.config();
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHash, randomUUID } from "node:crypto";
import type { DashboardSummary, ThreatEvent, EventStats } from "@cybersafe/shared-types";
import { chatCompletion, streamChatCompletion, checkAiAvailability, aiAvailabilityError, AI_CONFIG, findShapeViolation, INVALID_REQUEST_MESSAGE, type AiMessage } from "./ai.js";
import { processContextBlock, ProcessContextRefusal } from "./process-intelligence.js";
import {
  ConsentDenial, corpoExatoValido, criarGrant, criarAutorizacaoUnica, descriptorActual, grantActivo,
  resolverGrantParaEnvio, conferirAutorizacaoUnica, consumirAutorizacaoUnica, revogarGrants, chaveDoPedidoBateActual,
} from "./process-consent.js";
import { analyzeDownloadFilename, calculateDownloadRisk, isValidEmailFormat, type FileScanResponse, type FileScanResult } from "@cybersafe/shared-types";
// ── Severity redefined locally as the Prisma enum is not available ──
type Severity = "low" | "medium" | "high" | "critical";
import AdmZip from "adm-zip";
import { createBoundedUpload } from "./upload-limits.js";
import { readBoundedArchiveEntry, ArchiveEntryError, ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_TOTAL_BYTES } from "@cybersafe/core/dist/archive-limits.js";
import { prisma, isAuthTokenRevoked, revokeAuthToken } from "./db.js";
import type { User, Company } from "./db.js";
import { DATABASE_FILE_PATH } from "./db.js";
import { createLifecycleRecorder, installProcessDiagnostics, resolveLifecycleLogPath } from "./lifecycle.js";
import { validarArranqueApi } from "./dev-isolation.js";
import { installDevParentShutdown } from "./dev-parent-shutdown.js";
import { closeDb } from "./db.js";

// ── Guarda de isolamento ──
// Chamada aqui, e não só em `db.ts`, para que a ordem dos imports nunca deixe o registo de
// `startup` ou o `listen` acontecer antes da recusa. Falha fechada: modo não declarado, DEV
// parcial, porta 4000 ou recurso pessoal param o processo sem escrever nada.
const arranqueApi = validarArranqueApi({ entrypoint: process.argv[1] ?? "", env: process.env });

// ── Diagnóstico de ciclo de vida ──
// Instalado antes de qualquer trabalho: um processo que desaparece sem rasto
// (ver 0xC000013A em 2026-10-20) deixa de ser indistinguível de um crash JS.
// O registo é local, best-effort e sanitizado; ver `lifecycle.ts`.
const lifecycle = createLifecycleRecorder({
  file: resolveLifecycleLogPath(process.env, DATABASE_FILE_PATH),
});
installProcessDiagnostics(lifecycle);
lifecycle.record("startup", { reason: "module-evaluated" });


// ── JWT Config ──
// S1 (2026-10-09): o segredo é provisionado FORA do código (env/instalação).
// Não existe fallback: ausente, vazio, só com espaços ou um valor conhecido
// (o antigo fallback público e o placeholder do .env.example) é recusado, e o
// processo termina ANTES de abrir o listener (ver assertJwtSecretConfigured).
const JWT_ALGORITHM = "HS256";
const JWT_EXPIRES_IN = "7d";
// Mínimo exigido para um segredo por instalação (Etapa 0: "segredos seguros e
// persistentes por instalação"). Curto demais = adivinhável/força-bruta.
const JWT_SECRET_MIN_LENGTH = 32;
const REJECTED_JWT_SECRETS = new Set([
  "cybersafe-fallback-secret", // fallback público até 2026-10-09 (P1 #2)
  "altera-isto-em-producao", // placeholder do .env.example: previsível, não é segredo
]);

/** Devolve o segredo utilizável ou null se não houver um segredo aceitável. */
export function resolveJwtSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = (env.JWT_SECRET ?? "").trim();
  if (!secret) return null;
  if (secret.length < JWT_SECRET_MIN_LENGTH) return null;
  if (REJECTED_JWT_SECRETS.has(secret)) return null;
  return secret;
}

// Resolvido uma única vez por processo: rodar o segredo exige reiniciar com o
// novo valor (e invalida os tokens emitidos com o anterior). Nunca é impresso.
let jwtSecret: string | null = null;
let jwtSecretResolved = false;

function getJwtSecret(): string {
  if (!jwtSecretResolved) {
    jwtSecret = resolveJwtSecret();
    jwtSecretResolved = true;
  }
  if (!jwtSecret) {
    // Sem fallback: falhar alto em vez de emitir/aceitar tokens assinados com
    // um segredo previsível. O arranque normal já validou isto antes do listener.
    throw new Error(
      `JWT_SECRET ausente, vazio ou inseguro: defina um segredo aleatório com pelo menos ${JWT_SECRET_MIN_LENGTH} caracteres, próprio desta instalação (ver .env.example).`,
    );
  }
  return jwtSecret;
}

// Revocations are persisted as fingerprints, never bearer tokens.
const tokenFingerprint = (token: string): string => createHash("sha256").update(token).digest("hex");

function signToken(userId: string): string {
  return jwt.sign({ sub: userId, jti: randomUUID() }, getJwtSecret(), {
    algorithm: JWT_ALGORITHM,
    expiresIn: JWT_EXPIRES_IN,
  });
}

function verifyToken(token: string): { sub: string } | null {
  try {
    // Algoritmo fixado na verificação: um token com alg/alg diferente não passa.
    const payload = jwt.verify(token, getJwtSecret(), { algorithms: [JWT_ALGORITHM] });
    if (typeof payload === "string") return null;
    if (isAuthTokenRevoked(tokenFingerprint(token))) return null;
    // Sem `sub` utilizável não há identidade: rejeitar antes de qualquer lookup.
    if (typeof payload.sub !== "string" || !payload.sub.trim()) return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

/** Falha alto (sem listener) quando o segredo não é aceitável. Nunca imprime o segredo. */
function assertJwtSecretConfigured(): void {
  try {
    getJwtSecret();
  } catch (error) {
    console.error(`[API] ${(error as Error).message}`);
    console.error("[API] Arranque abortado: nenhum listener foi aberto.");
    lifecycle.record("shutdown", { reason: "jwt-secret-invalid", error });
    process.exit(1);
  }
}

function sanitizeUser(user: User) {
  const { passwordHash, ...safe } = user;
  return safe;
}

/**
 * DIST-AUTH13OUT: validação estrita de tipos de input. Um campo
 * de registo/login é sempre uma string não vazia (após trim);
 * arrays, objetos, números, booleanos e null são recusados com
 * 400 ANTES de tocar a DB ou o bcrypt. Sem isto o SQLite
 * coercionava tipos (contas com name numerico) ou o handler
 * falhava com 500 — input inválido nunca é erro interno.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * `company` é um objeto simples: `name` (string não
 * vazia) e os opcionais `size`/`sector` (strings não
 * vazias quando presentes — o ecrã de registo envia
 * `size` como faixa "1-10".."500+"). Nada mais é lido
 * nem ecoado. Formas inválidas (arrays, strings,
 * números, campos não-string) são recusadas. Devolve
 * o objeto validado ou undefined (campo ausente/null)
 * — ou ok:false quando a forma é inválida (o caller
 * recusa antes de criar).
 *
 * LIMITE HISTÓRICO DE PERSISTÊNCIA (db.ts:40/116/126,
 * anterior a esta ronda): a DB só tem a coluna
 * companyName. `size`/`sector` válidos são preservados
 * na resposta 201 do registo, mas NÃO são persistidos
 * — login e /auth/me devolvem company apenas com
 * `name`. Sem migração no escopo: não prometer
 * roundtrip de size/sector.
 */
function validateCompany(
  company: unknown,
): { ok: true; value?: Company } | { ok: false } {
  if (company === undefined || company === null) return { ok: true };
  if (typeof company !== "object" || Array.isArray(company)) {
    return { ok: false };
  }
  const raw = company as Record<string, unknown>;
  if (!isNonEmptyString(raw.name)) return { ok: false };
  const value: Company = { name: raw.name };
  if (raw.size !== undefined && raw.size !== null) {
    if (!isNonEmptyString(raw.size)) return { ok: false };
    value.size = raw.size;
  }
  if (raw.sector !== undefined && raw.sector !== null) {
    if (!isNonEmptyString(raw.sector)) return { ok: false };
    value.sector = raw.sector;
  }
  return { ok: true, value };
}

// ── SSE Clients ──
interface SseClient {
  id: string;
  res: express.Response;
}
let sseClients: SseClient[] = [];

function broadcastEvent(event: ThreatEvent) {
  sseClients.forEach((client) => {
    client.res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
}

const app = express();
// Exportado para os testes poderem exercitar as rotas sem subir o servidor.
export { app };

/** Persona da Matrix é centralizada em ./ai.ts (persona feminina + escopo + guardas). */

// Porta configurável para testes/integração; por omissão 4000 (produção). Em DEV o valor é
// validado por `dev-isolation.ts` — 4000 ou porta em falta recusam o arranque.
const port = arranqueApi.porta;
const upload = createBoundedUpload();

/**
 * Contrato de recusa do /api/file-scan.
 *
 * Um ZIP que excede um limite não é um erro interno: é uma recusa previsível e
 * o cliente tem de a poder distinguir de uma avaria. Os códigos são um conjunto
 * fechado e as mensagens são fixas — nunca incluem a exceção, o caminho, o nome
 * da entrada nem o texto do parser. O 500 fica reservado para o que não se
 * consegue classificar, também com mensagem fixa.
 *
 * O orçamento de cada entrada é o MESMO do Scanner (`ARCHIVE_MAX_ENTRY_BYTES`,
 * 400 KiB): os dois caminhos aplicam `readBoundedArchiveEntry` antes de inflar,
 * por isso não há um limite API mais permissivo do que a análise de fundo.
 */
export type FileScanRefusalCode =
  | "archive_limit_exceeded"
  | "archive_entry_rejected"
  | "archive_invalid";

const FILE_SCAN_REFUSAL_MESSAGES: Record<FileScanRefusalCode, string> = {
  archive_limit_exceeded: "O arquivo excede os limites de análise permitidos.",
  archive_entry_rejected: "O arquivo contém uma entrada recusada por segurança.",
  archive_invalid: "O arquivo não pôde ser lido como um ZIP válido.",
};

class FileScanRefusal extends Error {
  constructor(readonly status: 413 | 422, readonly code: FileScanRefusalCode) {
    super(code);
    this.name = "FileScanRefusal";
  }
}

export interface FileScanFailure {
  status: 413 | 422 | 500;
  body: { code: string; message: string };
}

/** Traduz exceções do fluxo de scan para uma resposta estável e sanitizada. */
export function fileScanFailure(error: unknown): FileScanFailure {
  if (error instanceof FileScanRefusal) {
    return { status: error.status, body: { code: error.code, message: FILE_SCAN_REFUSAL_MESSAGES[error.code] } };
  }
  if (error instanceof ArchiveEntryError) {
    const code: FileScanRefusalCode = error.code === "ARCHIVE_ENTRY_REJECTED" ? "archive_entry_rejected" : "archive_limit_exceeded";
    return { status: code === "archive_entry_rejected" ? 422 : 413, body: { code, message: FILE_SCAN_REFUSAL_MESSAGES[code] } };
  }
  // Avaria não classificada: 500 seguro, sem eco de exceção/paths.
  return { status: 500, body: { code: "scan_failed", message: "Não foi possível concluir a análise do ficheiro." } };
}

function scoreWeight(severity: ThreatEvent["severity"]): number {
  if (severity === "critical") return 30;
  if (severity === "high") return 20;
  if (severity === "medium") return 10;
  return 4;
}

function calculateRiskScore(threatEvents: ThreatEvent[]): number {
  if (threatEvents.length === 0) return 95;
  const recent = threatEvents.slice(-50);
  const scorePenalty = recent.reduce((acc, event) => acc + scoreWeight(event.severity), 0);
  return Math.max(0, 100 - Math.round(scorePenalty / Math.max(recent.length / 2, 1)));
}

function toThreatEvent(event: any): ThreatEvent {
  return {
    source: event.source === "dashboard" ? "dashboard" : event.source === "download-monitor" ? "download-monitor" : "extension",
    url: event.url,
    domain: event.domain,
    severity: event.severity as ThreatEvent["severity"],
    confidence: event.confidence,
    rulesTriggered: event.rulesTriggered as any || [],
    createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : new Date(event.createdAt).toISOString(),
    riskScore: event.riskScore || event.confidence * 100
  };
}

function buildDashboardSummary(events: ThreatEvent[]): DashboardSummary {
  const recentThreats = events.slice(0, 20);
  const highSeverityEvents = events.filter((e) => e.severity === "high" || e.severity === "critical").length;
  const alerts = recentThreats
    .filter((e) => e.severity === "high" || e.severity === "critical")
    .slice(0, 5)
    .map((e) => ({
      id: `${e.createdAt}-${e.domain}`,
      title: `Atividade suspeita detectada em ${e.domain}`,
      description: `${e.rulesTriggered.length} regra(s) heurística(s) acionada(s) via ${e.source}.`,
      severity: e.severity,
      createdAt: e.createdAt
    }));

  return {
    riskScore: calculateRiskScore(events),
    totalEvents: events.length,
    highSeverityEvents,
    downloadRisk: calculateDownloadRisk(events),
    recentThreats,
    alerts
    ,
    systemStatus: highSeverityEvents > 0 ? "attention" : "safe"
  };
}

function severityRank(severity: ThreatEvent["severity"]): number {
  if (severity === "critical") return 4;
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

function maxSeverity(results: FileScanResult[]): ThreatEvent["severity"] {
  let max: ThreatEvent["severity"] = "low";
  for (const item of results) {
    if (severityRank(item.severity) > severityRank(max)) max = item.severity;
  }
  return max;
}

// ── S3: origens permitidas (allowlist exata, sem wildcard) ──
// Access-Control-Allow-Origin nunca é "*". Em DEV a app corre no Vite server
// (5173) OU no `vite preview` do build (4173, o modo de PREVIEW sem proxy); o
// resto é configurável por instalação (CYBERSAFE_API_ALLOWED_ORIGINS). O
// Electron empacotado (file://) envia Origin: null e só é aceite com opt-in
// explícito dessa instalação (CYBERSAFE_API_ALLOW_NULL_ORIGIN=1).
// A PREVIEW corre em 4173 e chama a API em http://127.0.0.1:4000 sem proxy, logo
// é CROSS-ORIGIN: sem 4173 na allowlist o preflight do login devolve 403 sem ACAO
// e o browser bloqueia TODAS as chamadas (o sintoma "PREVIEW BLOQUEADO"). As duas
// formas de abrir localhost/127.0.0.1 são origens DISTINTAS para CORS — listamos
// ambas, sempre só em loopback, nunca wildcard.
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

/** Origens autorizadas: lista exata configurada ou o default de DEV. */
export function getAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env.CYBERSAFE_API_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

/**
 * Valor a anunciar em Access-Control-Allow-Origin, ou null quando a origem não
 * está autorizada. Ausência de Origin não autoriza nada: significa apenas que
 * não há contexto CORS (o pedido continua sujeito a autenticação).
 */
export function resolveAllowedOrigin(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!origin) return null;
  if (origin === "null") return env.CYBERSAFE_API_ALLOW_NULL_ORIGIN === "1" ? "null" : null;
  return getAllowedOrigins(env).includes(origin) ? origin : null;
}

// ── Middleware ──
app.use(express.json());
app.use((req, res, next) => {
  const allowedOrigin = resolveAllowedOrigin(req.headers.origin);
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  if (req.method === "OPTIONS") {
    // Preflight respondido sem dados. CORS não é autorização: mesmo com origem
    // autorizada, o pedido real passa por requireAuth nas rotas privadas.
    res.status(allowedOrigin ? 204 : 403).end();
    return;
  }
  next();
});

// ── S3: principal autenticado ──
// A identidade vem SEMPRE do token verificado. role/owner/userId vindos do body
// ou da query são ignorados e nunca elevam privilégios.
interface Principal {
  userId: string;
  role: string;
}
type AuthenticatedRequest = express.Request & { principal?: Principal };

async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ message: "Autenticação necessária." });
    return;
  }

  const payload = verifyToken(authHeader.slice("Bearer ".length).trim());
  if (!payload) {
    res.status(401).json({ message: "Token inválido ou expirado." });
    return;
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      res.status(401).json({ message: "Sessão inválida." });
      return;
    }
    (req as AuthenticatedRequest).principal = { userId: user.id, role: user.role };
    next();
  } catch (error) {
    console.error("[AUTH] requireAuth error:", error);
    res.status(500).json({ message: "Erro interno ao validar a sessão." });
  }
}

/**
 * Operações globais destrutivas (ex.: apagar todos os eventos) exigem
 * administrador. Enquanto S5 não existir, qualquer sessão autenticada veria os
 * mesmos dados globais — mas destruí-los não pode estar ao alcance de qualquer
 * conta registada. Requer requireAuth antes.
 */
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const principal = (req as AuthenticatedRequest).principal;
  if (principal?.role !== "admin") {
    res.status(403).json({ message: "Apenas um administrador pode executar esta operação." });
    return;
  }
  next();
}

// ══════════════════════════════════════════════════
// ── AUTH ENDPOINTS ──
// ══════════════════════════════════════════════════

// ── Register ──
app.post("/auth/register", async (req, res) => {
  try {
    const { name, email, password, type, company } = (req.body ?? {}) as {
      name?: unknown;
      email?: unknown;
      password?: unknown;
      type?: unknown;
      company?: unknown;
    };

    if (
      !isNonEmptyString(name) ||
      !isNonEmptyString(email) ||
      !isNonEmptyString(password) ||
      !isNonEmptyString(type)
    ) {
      res.status(400).json({ message: "Todos os campos são obrigatórios (name, email, password, type)." });
      return;
    }

    if (type !== "personal" && type !== "business") {
      res.status(400).json({ message: "Tipo de conta inválido. Use 'personal' ou 'business'." });
      return;
    }

    // S3: o registo público não escolhe plano privilegiado. O `plan` do body é
    // ignorado: a conta nasce sempre no plano base e os entitlements são
    // atribuídos/validados pela autoridade, nunca pelo próprio caller.
    const userPlan = "free";

    // Formato do email: mesma função que o ecrã de registo usa (16/10/2026).
    // O regex local antigo aceitava TLD incompleto (`gmail.c`) e domínios
    // mal formados; a regra vive agora em @cybersafe/shared-types.
    if (!isValidEmailFormat(email)) {
      res.status(400).json({ message: "Formato de email inválido." });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ message: "A senha deve ter pelo menos 6 caracteres." });
      return;
    }

    const companyCheck = validateCompany(company);
    if (!companyCheck.ok) {
      res.status(400).json({ message: "Dados da empresa inválidos: company deve ser um objeto com name (string não vazia)." });
      return;
    }
    if (type === "business" && companyCheck.value === undefined) {
      res.status(400).json({ message: "Nome da empresa é obrigatório para contas empresariais." });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ message: "Este email já está registado." });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        type,
        plan: userPlan as any,
        // O register público nunca cria admins: role no body é ignorado.
        // S2 (2026-10-09): não existe promoção automática no produto — o
        // bootstrap DEV foi removido; um admin é provisionado fora do fluxo
        // normal (procedimento ainda por aprovar na Etapa 0).
        role: "user",
        // Só os campos validados são persistidos/ecoados —
        // campos extra do caller nunca entram na resposta.
        // (size/sector são ecoados no 201; a DB só
        // persiste companyName — limite histórico.)
        company: type === "business" && companyCheck.value !== undefined
          ? companyCheck.value
          : undefined,
      },
    });

    const token = signToken(user.id);
    console.log(`[AUTH] New user registered: ${email} (${type}, ${userPlan})`);

    res.status(201).json({ token, user: sanitizeUser(user) });
  } catch (error) {
    console.error("[AUTH] Register error:", error);
    res.status(500).json({ message: "Erro interno ao criar conta." });
  }
});

// Revokes only the authenticated bearer. Existing callers must explicitly
// invoke this endpoint; clearing browser storage alone does not revoke a JWT.
app.post("/auth/logout", requireAuth, (req, res) => {
  const token = req.headers.authorization!.slice("Bearer ".length).trim();
  const payload = jwt.decode(token);
  if (!payload || typeof payload === "string" || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    res.status(401).json({ message: "Token inválido ou expirado." });
    return;
  }
  try {
    if (!revokeAuthToken(tokenFingerprint(token), payload.exp)) {
      res.status(503).json({ message: "Não foi possível terminar a sessão. Tenta novamente." });
      return;
    }
  } catch {
    res.status(503).json({ message: "Não foi possível terminar a sessão. Tenta novamente." });
    return;
  }
  res.status(204).end();
});
// ── Login ──
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };

    if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
      res.status(400).json({ message: "Email e senha são obrigatórios." });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(401).json({ message: "Credenciais inválidas." });
      return;
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      res.status(401).json({ message: "Credenciais inválidas." });
      return;
    }

    const token = signToken(user.id);
    console.log(`[AUTH] User logged in: ${email}`);

    res.json({ token, user: sanitizeUser(user) });
  } catch (error) {
    console.error("[AUTH] Login error:", error);
    res.status(500).json({ message: "Erro interno ao fazer login." });
  }
});

// ── Get Current User ──
app.get("/auth/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ message: "Token não fornecido." });
      return;
    }

    const token = authHeader.split(" ")[1];
    const payload = verifyToken(token);
    if (!payload) {
      res.status(401).json({ message: "Token inválido ou expirado." });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      res.status(404).json({ message: "Utilizador não encontrado." });
      return;
    }

    res.json({ user: sanitizeUser(user) });
  } catch (error) {
    console.error("[AUTH] Me error:", error);
    res.status(500).json({ message: "Erro interno." });
  }
});

// ── (removido em 2026-10-09) Bootstrap DEV: POST /auth/dev/ensure-admin ──
// S2: o endpoint de promoção automática a admin saiu do produto. O registo
// público cria sempre role "user" e não há via de elevação pelo fluxo normal.
// Provisionar um admin local exige um procedimento explícito fora do fluxo
// normal, a aprovar na Etapa 0 (ver ACCOUNT-SECURITY-FIX-PLAN-2026-10-09).

// ── SSE Endpoint ──
app.get("/api/stream", requireAuth, (req, res) => {
  const principal = (req as AuthenticatedRequest).principal;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Optional session tracking
  const sessionId = req.query.sessionId as string || Math.random().toString(36).substring(7);

  const client: SseClient = { id: sessionId, res };
  sseClients.push(client);

  console.log(`[SSE] Client connected: ${sessionId} (user ${principal?.userId ?? "?"}, total: ${sseClients.length})`);

  // S3: os headers só saem no primeiro write. Sem isto, um cliente autenticado
  // ficava sem resposta até existir um evento (e o fetch do cliente expirava).
  res.write(": connected\n\n");

  req.on("close", () => {
    sseClients = sseClients.filter((c) => c.id !== sessionId);
    console.log(`[SSE] Client disconnected: ${sessionId} (Total: ${sseClients.length})`);
  });
});

// ── Health ──
app.get("/health", (_req, res) => {
  res.json(apiHealthPayload(process.env));
});

// ── AI Chat (streaming + fallback JSON; persona Matrix em ./ai.ts) ──
app.post("/api/ai/chat", requireAuth, async (req, res) => {
  const { messages, context, page, stream } = (req.body || {}) as {
    messages?: AiMessage[];
    context?: string;
    page?: string;
    stream?: boolean;
  };

  let effectiveContext = context;
  // Autorização única CONFERIDA (não gasta) e consumida só antes do envio: a forma do
  // pedido e o payload são decididos primeiro, pelo que um pedido inválido não queima
  // a autorização que a pessoa acabou de dar.
  let autorizacaoUnicaPendente: { userId: string; tokenHash: string } | null = null;
  let cobertoPorAutorizacao = false;
  try {
    // TP-MATRIX-R2-CONSENT — QUATRO verificações antes de qualquer coisa ir para o
    // fornecedor, e a regra que fecha o defeito da R1 está na terceira:
    //
    // (1) `consentProviderKey`, quando presente, tem de ser o fornecedor ACTUAL;
    // (2) `consentGrantId` e `consentAuthorization` são canais EXCLUSIVOS — os dois
    //     juntos são pedido ambíguo, não dois caminhos para tentar;
    // (3) sem nenhum deles o envio NÃO ACONTECE. `processConsent: true` vindo do
    //     cliente deixou de ser autorização: era o servidor a perguntar ao pedido se
    //     o pedido estava autorizado, e bastava escrever `true` no corpo para a
    //     telemetria de processos sair para o fornecedor. Quem autoriza agora é um
    //     registo criado por este processo para esta conta/instalação/fornecedor/
    //     campos/alvo (grant persistente, ou autorização única de um envio). A flag
    //     continua aceite no corpo — ignorada, para não fingir um contrato novo;
    // (4) a medição em si continua a passar pelo validador central. Nenhum caminho
    //     cai para o outro: grant inválido não passa a autorização única (nem o
    //     contrário) e nenhuma autorização compra silêncio sobre outro fornecedor.
    const medicaoPresente = (req.body || {}).processIntelligence !== undefined;
    if (medicaoPresente) {
      const chaveDoPedido = chaveDoPedidoBateActual(req.body);
      if (chaveDoPedido.presente && !chaveDoPedido.ok) {
        throw new ConsentDenial("process_consent_provider_mismatch",
          "O fornecedor indicado no pedido não é aquele que a app está a usar neste momento.");
      }
      const corpo = (req.body || {}) as { consentGrantId?: unknown; consentAuthorization?: unknown };
      const trazGrant = corpo.consentGrantId !== undefined && corpo.consentGrantId !== null;
      const trazUnica = corpo.consentAuthorization !== undefined && corpo.consentAuthorization !== null;
      if (trazGrant && trazUnica) {
        throw new ProcessContextRefusal("process_consent_ambiguous");
      }
      const userId = (req as AuthenticatedRequest).principal?.userId ?? "";
      if (trazGrant) {
        const decidido = resolverGrantParaEnvio({ userId, grantId: corpo.consentGrantId });
        if (!decidido.ok) throw new ConsentDenial(decidido.code, decidido.mensagem);
        cobertoPorAutorizacao = true;
      } else if (trazUnica) {
        const conferida = conferirAutorizacaoUnica({
          userId, token: corpo.consentAuthorization, payload: corpo,
        });
        if (!conferida.ok) throw new ConsentDenial(conferida.code, conferida.mensagem);
        cobertoPorAutorizacao = true;
        autorizacaoUnicaPendente = { userId, tokenHash: conferida.tokenHash };
      } else {
        throw new ProcessContextRefusal("process_consent_missing");
      }
    }
    if (medicaoPresente && cobertoPorAutorizacao) {
      const processBlock = processContextBlock(req.body);
      if (processBlock !== null) {
        if (context !== undefined && typeof context !== "string") throw new Error("invalid_context");
        effectiveContext = [context, processBlock].filter(Boolean).join("\n\n");
      }
    }
  } catch (error: any) {
    // Recusa estável ANTES do fornecedor, com a causa que se pode corrigir: falta
    // de autorização não é a mesma coisa que medição mal formada, e nenhuma das duas
    // é um erro de rede que se repita. O `invalid_request` genérico fica só para a
    // forma do pedido (ex.: `context` não textual).
    // Autorização recusada é 403 (a pessoa disse não, ou o contexto mudou); defeito
    // de forma do pedido continua 400. São eixos diferentes e a UI decide-os de
    // forma diferente: um reenvio não corrige um 403.
    if (error instanceof ConsentDenial) {
      res.status(403).json({ message: error.message, code: error.code });
      return;
    }
    if (error?.code === "process_consent_missing" || error?.code === "process_context_invalid") {
      res.status(400).json({ message: error.message, code: error.code });
      return;
    }
    // Dois canais de autorização no mesmo pedido: forma inválida, não preferência.
    // Recusar aqui é o que impede um cliente de tentar «grant OU token» até um passar.
    if (error?.code === "process_consent_ambiguous") {
      res.status(400).json({
        message: "O pedido traz duas autorizações diferentes: envia só uma (grant persistente ou autorização única).",
        code: "process_consent_ambiguous",
      });
      return;
    }
    res.status(400).json({ message: "O pedido ao serviço de IA tem uma forma inválida.", code: "invalid_request" });
    return;
  }

  // TP-MATRIX-R2-CONSENT (revisão): a autorização única só é consumida DEPOIS da
  // forma do pedido e do payload estarem decididos — e imediatamente antes do envio.
  // Assim um pedido recusado (medição a mais, forma inválida) não custa a autorização,
  // e um token continua a valer no máximo UMA tentativa real ao fornecedor.
  if (autorizacaoUnicaPendente) {
    const violacao = findShapeViolation({ messages, context, page });
    if (violacao !== null) {
      res.status(400).json({ message: INVALID_REQUEST_MESSAGE, code: "invalid_request" });
      return;
    }
    const consumida = consumirAutorizacaoUnica(autorizacaoUnicaPendente);
    if (!consumida.ok) {
      res.status(403).json({ message: consumida.mensagem, code: consumida.code });
      return;
    }
  }

  if (stream === true) {
    try {
      await streamChatCompletion(res, req, messages || [], effectiveContext, page);
    } catch (error: any) {
      // Guard de credenciais + forma do pedido: erro estável, já tratado
      // dentro do stream; aqui só por segurança, sem ecoar nem registar o
      // conteúdo recusado.
      if (error?.kind === "credential_blocked" || error?.kind === "invalid_request") {
        if (res.writable && !res.writableEnded && !res.headersSent) {
          res.status(400).json({ message: error.message, code: error.kind });
        }
        return;
      }
      console.error("[AI] stream error:", error);
      if (res.writable && !res.writableEnded && !res.headersSent) {
        res.status(500).json({ message: "Ocorreu um erro ao conectar com o serviço de IA." });
      }
    }
    return;
  }

  try {
    // Cliente desligado antes da resposta: cancela o pedido ao provider (o stream já fazia isto).
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const response = await chatCompletion(messages || [], effectiveContext, page, controller.signal);
    res.json({ response, mode: "online" });
  } catch (error: any) {
    // Guard de credenciais (P0) e forma do pedido: 400 estável, mensagem fixa
    // sem o segredo. O texto recusado não é registado em lado nenhum.
    if (error?.kind === "credential_blocked" || error?.kind === "invalid_request") {
      res.status(400).json({ message: error.message, code: error.kind });
      return;
    }
    if (error?.kind === "no_provider") {
      res.status(503).json({ message: error.message, code: "no_provider" });
      return;
    }
    // Erros classificados do provider (404 modelo, 401/403 auth, 429, timeout, rede)
    // chegam com estado e código estáveis, para a UI decidir fallback ou retry.
    if (error?.kind && error.kind !== "unknown" && error.kind !== "aborted") {
      const status = typeof error.status === "number" && error.status >= 400 ? error.status : 503;
      res.status(status).json({ message: error.message, code: error.kind });
      return;
    }
    console.error("[AI] completion error:", error);
    res.status(500).json({ message: "Ocorreu um erro ao conectar com o serviço de IA." });
  }
});

// ── TP-MATRIX-FINAL-CONSENT: escolha persistente de explicações de processos ──
// As três rotas são 100% locais: não sondam o fornecedor (isso é o `/api/ai/status`,
// que faz `checkAiAvailability`). Um GET não pode depender da rede para dizer ao
// utilizador com quem ele autorizou, nem pode ser a forma de um pedido de autorização.
app.get("/api/ai/process-consent", requireAuth, (req, res) => {
  const userId = (req as AuthenticatedRequest).principal?.userId ?? "";
  res.json({ descriptor: descriptorActual(), grant: grantActivo(userId) });
});

app.post("/api/ai/process-consent", requireAuth, (req, res) => {
  const forma = corpoExatoValido(req.body);
  if (forma.ok === false) {
    res.status(400).json({ message: forma.mensagem, code: "invalid_request" });
    return;
  }
  const userId = (req as AuthenticatedRequest).principal?.userId;
  if (!userId) {
    res.status(401).json({ message: "A sessão deixou de estar disponível.", code: "unauthenticated" });
    return;
  }
  try {
    const grant = criarGrant(userId, req.body);
    res.json({ descriptor: descriptorActual(), grant });
  } catch (error: any) {
    if (error instanceof ConsentDenial) {
      res.status(403).json({ message: error.message, code: error.code });
      return;
    }
    // Sem grant escrito: uma gravação a meio é exatamente o estado que o gate
    // existe para evitar. A causa não é exposta como se fosse decisão da pessoa.
    res.status(400).json({ message: "Não foi possível registar a autorização.", code: "invalid_request" });
  }
});

app.delete("/api/ai/process-consent", requireAuth, (req, res) => {
  const userId = (req as AuthenticatedRequest).principal?.userId ?? "";
  const { revoked, revokedOneShots, installationId } = revogarGrants(userId);
  res.json({ descriptor: descriptorActual(), revoked, revokedOneShots, installationId });
});

/**
 * TP-MATRIX-R2-CONSENT — autorização de UM envio, emitida pelo servidor.
 *
 * Porque uma rota nova: a autorização de um único envio tem de ser um acto do
 * servidor, não um campo que o cliente escreve no corpo do chat. Esta rota é 100%
 * local (não sonda o fornecedor, não chama nada lá fora); devolve um token opaco que
 * só serve para um envio e só para o alvo pedido. O corpo tem de trazer fornecedor,
 * finalidade, campos e alvo — e é confrontado com o descriptor ACTUAL, pelo que um
 * cliente a mentir sobre o fornecedor recebe 403 em vez de autorização.
 */
app.post("/api/ai/process-consent/one-shot", requireAuth, (req, res) => {
  const userId = (req as AuthenticatedRequest).principal?.userId;
  if (!userId) {
    res.status(401).json({ message: "A sessão deixou de estar disponível.", code: "unauthenticated" });
    return;
  }
  try {
    const autorizacao = criarAutorizacaoUnica(userId, req.body);
    res.json({ descriptor: descriptorActual(), authorization: autorizacao });
  } catch (error: any) {
    if (error instanceof ConsentDenial) {
      res.status(403).json({ message: error.message, code: error.code });
      return;
    }
    // Nada foi emitido: um token a meio seria exactamente o estado que este gate evita.
    res.status(400).json({ message: "Não foi possível emitir a autorização deste envio.", code: "invalid_request" });
  }
});

// ── Status da IA (sem expor chaves) — permite à app mostrar ONLINE/LOCAL ──
app.get("/api/ai/status", requireAuth, async (_req, res) => {
  const reachable = await checkAiAvailability();
  res.json({
    enabled: reachable,
    errorKind: reachable ? null : aiAvailabilityError(),
    provider: AI_CONFIG.provider,
    model: AI_CONFIG.model,
    streaming: true,
    // O descriptor aqui é o MESMO do GET local: serve para a app mostrar o alvo da
    // autorização onde já estava a mostrar o estado do fornecedor. Nunca leva URL
    // nem chave, e não é o caminho de autoria (esse é o GET, que não sonda nada).
    consentDescriptor: descriptorActual(),
  });
});

// ── Create event ──
app.post("/api/events", requireAuth, async (req, res) => {
  try {
    const event = req.body as ThreatEvent;
    const created = await prisma.threatEvent.create({
      data: {
        source: event.source,
        url: event.url,
        domain: event.domain,
        severity: event.severity,
        confidence: event.confidence,
        rulesTriggered: event.rulesTriggered,
        createdAt: new Date(event.createdAt)
      }
    });
    const mappedEvent = toThreatEvent(created as any);
    broadcastEvent(mappedEvent);

    res.status(202).json({
      accepted: true,
      eventSummary: {
        id: created.id,
        domain: created.domain,
        severity: created.severity,
        rulesTriggered: created.rulesTriggered.length
      }
    });
  } catch (error) {
    res.status(500).json({ accepted: false, message: "Failed to store event", error: String(error) });
  }
});

// ── List events ──
app.get("/api/events", requireAuth, async (_req, res) => {
  try {
    const events = await prisma.threatEvent.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    res.json(events.map(toThreatEvent));
  } catch (error) {
    res.status(500).json({ message: "Failed to load events", error: String(error) });
  }
});

// ── Delete all events ──
app.delete("/api/events", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const result = await prisma.threatEvent.deleteMany();
    res.json({ deleted: result.count });
  } catch (error) {
    res.status(500).json({ message: "Failed to clear events", error: String(error) });
  }
});

// ── Event stats ──
app.get("/api/events/stats", requireAuth, async (_req, res) => {
  try {
    const events = await prisma.threatEvent.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    const mapped = events.map(toThreatEvent);
    const stats: EventStats = {
      total: mapped.length,
      low: mapped.filter((e) => e.severity === "low").length,
      medium: mapped.filter((e) => e.severity === "medium").length,
      high: mapped.filter((e) => e.severity === "high").length,
      critical: mapped.filter((e) => e.severity === "critical").length,
      downloadRisk: calculateDownloadRisk(mapped),
      recentDownloadCount: mapped.filter((e) => e.source === "download-monitor").length
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: "Failed to compute stats", error: String(error) });
  }
});

// ── Dashboard ──
app.get("/api/dashboard", requireAuth, async (_req, res) => {
  try {
    const events = await prisma.threatEvent.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    res.json(buildDashboardSummary(events.map(toThreatEvent)));
  } catch (error) {
    res.status(500).json({ message: "Failed to load dashboard", error: String(error) });
  }
});

// ── File scan ──
app.post("/api/file-scan", requireAuth, upload, async (req, res) => {
  try {
    const uploaded = req.file;
    if (!uploaded) {
      res.status(400).json({ message: "File is required", code: "file_required" });
      return;
    }

    const results: FileScanResult[] = [];
    const name = uploaded.originalname;
    const isZip = name.toLowerCase().endsWith(".zip");

    if (isZip) {
      let entries: ReturnType<AdmZip["getEntries"]>;
      try {
        const zip = new AdmZip(uploaded.buffer);
        entries = zip.getEntries().filter((entry) => !entry.isDirectory);
      } catch {
        throw new FileScanRefusal(422, "archive_invalid");
      }
      if (entries.length > ARCHIVE_MAX_ENTRIES) {
        throw new FileScanRefusal(413, "archive_limit_exceeded");
      }
      let expandedBytes = 0;
      const seen = new Set<string>();
      for (const entry of entries) {
        const identity = entry.entryName.replace(/\\/g, "/").toLowerCase();
        if (seen.has(identity)) throw new FileScanRefusal(422, "archive_entry_rejected");
        seen.add(identity);
        let analysis = analyzeDownloadFilename(entry.entryName);

        // ── Advanced Heuristics: Magic Number Detection ──
        // Check if the file has an MZ header (4D 5A) indicating an executable,
        // even if the filename doesn't have a dangerous extension.
        let data: Buffer;
        try {
          data = readBoundedArchiveEntry(entry, ARCHIVE_MAX_TOTAL_BYTES - expandedBytes);
        } catch (error) {
          if (error instanceof ArchiveEntryError) throw error;
          throw new FileScanRefusal(422, "archive_invalid");
        }
        expandedBytes += data.length;
        if (data.length >= 2 && data[0] === 0x4d && data[1] === 0x5a) {
          if (!analysis.rulesTriggered.includes("dangerous_file_extension")) {
             analysis.rulesTriggered.push("dangerous_file_extension");
             analysis.severity = "critical";
             analysis.confidence = 0.99;
          }
        }

        results.push({
          fileName: entry.entryName,
          size: entry.header.size,
          severity: analysis.severity,
          confidence: analysis.confidence,
          rulesTriggered: analysis.rulesTriggered
        });
      }
    } else {
      const analysis = analyzeDownloadFilename(name);
      results.push({
        fileName: name,
        size: uploaded.size,
        severity: analysis.severity,
        confidence: analysis.confidence,
        rulesTriggered: analysis.rulesTriggered
      });
    }

    const now = new Date();
    const records = results
      .filter((item) => item.rulesTriggered.length > 0)
      .map((item) => ({
        source: "dashboard",
        url: `file://${item.fileName}`,
        domain: "file-scan",
        severity: item.severity,
        confidence: item.confidence,
        rulesTriggered: item.rulesTriggered,
        createdAt: now
      }));

    if (records.length > 0) {
      await prisma.threatEvent.createMany({ data: records });
    }

    const combinedRules = Array.from(new Set(results.flatMap((item) => item.rulesTriggered)));
    const response: FileScanResponse = {
      results,
      totalFiles: results.length,
      highRiskCount: results.filter((item) => item.severity === "high" || item.severity === "critical").length,
      overallSeverity: maxSeverity(results),
      rulesTriggered: combinedRules
    };
    res.json(response);
  } catch (error) {
    const failure = fileScanFailure(error);
    if (failure.status === 500) console.error("[FILE-SCAN] falha não classificada", (error as Error)?.name ?? "unknown");
    res.status(failure.status).json(failure.body);
  }
});

// ── Training score ──
app.post("/api/training-score", requireAuth, async (req, res) => {
  try {
    const { correctCount, totalCount } = req.body as { correctCount: number; totalCount: number };
    const score = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
    const result = await prisma.trainingResult.create({
      data: {
        correctCount,
        totalCount,
        score,
        // O schema exige gameType e maxScore: sem estas colunas o INSERT
        // falhava sempre e o resultado do Simulador nunca era guardado
        // (bug pré-existente, corrigido na ronda S3 para o consumidor deixar
        // de ter uma falha silenciosa).
        gameType: "simulator",
        maxScore: totalCount,
      }
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to save training score", error: String(error) });
  }
});

app.get("/api/training-score", requireAuth, async (_req, res) => {
  try {
    const results = await prisma.trainingResult.findMany({ orderBy: { completedAt: "desc" }, take: 20 });
    const totalSessions = results.length;
    const avgScore = totalSessions > 0 ? Math.round(results.reduce((acc: number, r: { score: number }) => acc + r.score, 0) / totalSessions) : 0;
    res.json({ totalSessions, averageScore: avgScore, recentResults: results });
  } catch (error) {
    res.status(500).json({ message: "Failed to load training scores", error: String(error) });
  }
});

// CYBERSAFE_API_NO_LISTEN=1 deixa os testes importar o app sem bind à porta 4000.
if (process.env.CYBERSAFE_API_NO_LISTEN !== "1") {
  // S1: sem segredo JWT válido o processo aborta aqui — nenhum listener abre.
  assertJwtSecretConfigured();
  // S3: bind explícito a loopback (IPv4). Não escutar em 0.0.0.0 nem depender
  // da resolução de "localhost" (que pode preferir ::1 sem listener).
  const server = app.listen(port, "127.0.0.1", () => {
    lifecycle.record("listening", { port });
    console.log(`CyberSafe API listening on http://127.0.0.1:${port}`);
    if (process.env.CYBERSAFE_DEV_OWNED_CHILD === "1") process.send?.({ type: "dev-api-ready", port });
  });

  installDevParentShutdown(process, process.env, () => new Promise<void>((resolve, reject) => {
    lifecycle.record("signal", { signal: "parent-ipc" });
    server.close((error) => {
      if (error) { reject(error); return; }
      closeDb();
      lifecycle.record("shutdown", { reason: "parent-ipc-server-closed" });
      if (process.connected) process.disconnect?.();
      resolve();
    });
  }));

  const gracefulShutdown = (signal: string) => {
    lifecycle.record("signal", { signal });
    console.log(`[API] Received ${signal}, shutting down...`);
    server.close(() => {
      lifecycle.record("shutdown", { reason: "server-closed" });
      console.log("[API] Server closed.");
      process.exit(0);
    });

    // Force close after 2s if still hanging
    setTimeout(() => {
      lifecycle.record("shutdown", { reason: "forced-after-timeout" });
      console.log("[API] Forcing exit after timeout.");
      process.exit(0);
    }, 2000);
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  // Windows não entrega SIGTERM a um processo de consola que morre com o
  // terminal: o sinal que chega é CTRL_BREAK (SIGBREAK) ou CTRL_C (SIGINT).
  // Registar SIGBREAK é o que permite distinguir "fecharam a consola" de
  // "morreu sozinho" (0xC000013A).
  process.on("SIGBREAK", () => gracefulShutdown("SIGBREAK"));
}
