import express from "express";
import dotenv from "dotenv";
dotenv.config();
import OpenAI from "openai";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { DashboardSummary, ThreatEvent, EventStats } from "@cybersafe/shared-types";
import { analyzeDownloadFilename, calculateDownloadRisk, type FileScanResponse, type FileScanResult } from "@cybersafe/shared-types";
// ── Severity redefined locally as the Prisma enum is not available ──
type Severity = "low" | "medium" | "high" | "critical";
import AdmZip from "adm-zip";
import multer from "multer";
import { prisma } from "./db.js";
import type { User } from "./db.js";

// ── JWT Config ──
const JWT_SECRET = process.env.JWT_SECRET || "cybersafe-fallback-secret";
const JWT_EXPIRES_IN = "7d";

function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token: string): { sub: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { sub: string };
  } catch {
    return null;
  }
}

function sanitizeUser(user: User) {
  const { passwordHash, ...safe } = user;
  return safe;
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

const groqApiKey = process.env.GROQ_API_KEY?.trim();
const openai = new OpenAI({
  apiKey: groqApiKey || "missing-groq-key",
  baseURL: "https://api.groq.com/openai/v1",
});

/** Persona do assistente no painel do antivírus (Groq / OpenAI-compatible). */
const CYBERSAFE_AI_SYSTEM_PROMPT = `És o assistente virtual do antivírus CyberSafe. Fala português (Portugal ou Brasil, conforme o utilizador).

Objetivo: ajudar o utilizador a usar o produto e a perceber segurança — ameaças, boas práticas, phishing, passwords, VPN, atualizações, quarentena, scans, falsos positivos, e o que significam alertas do CyberSafe.

Regras:
- Sê claro, curto e acionável; usa listas quando ajudar.
- Nunca inventes que o PC está infectado sem contexto; se não souberes, diz o que falta (ex.: resultado do scan, mensagem de erro).
- Não peças nem repitas chaves API, passwords nem dados pessoais. Se o utilizador colar segredos, avisa para revogar e usar .env.
- Não dês conselhos ilegais (cracking, evasão de segurança empresarial, malware).
- Quando falares de risco, distingue "possível" vs "confirmado" e sugere o próximo passo seguro (scan, quarentena, verificação VirusTotal, contactar admin).
- Podes usar **negrito** em markdown ligeiro; evita respostas enormes (máx. ~4 parágrafos curtos salvo se pedirem detalhe).`;

const port = 4000;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

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

// ── Middleware ──
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// ══════════════════════════════════════════════════
// ── AUTH ENDPOINTS ──
// ══════════════════════════════════════════════════

// ── Register ──
app.post("/auth/register", async (req, res) => {
  try {
    const { name, email, password, type, plan, company } = req.body;

    if (!name || !email || !password || !type) {
      res.status(400).json({ message: "Todos os campos são obrigatórios (name, email, password, type)." });
      return;
    }

    if (!["personal", "business"].includes(type)) {
      res.status(400).json({ message: "Tipo de conta inválido. Use 'personal' ou 'business'." });
      return;
    }

    const validPlans = ["free", "pro", "premium"];
    const userPlan = validPlans.includes(plan) ? plan : "free";

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      res.status(400).json({ message: "Formato de email inválido." });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ message: "A senha deve ter pelo menos 6 caracteres." });
      return;
    }

    if (type === "business" && (!company || !company.name)) {
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
        company: type === "business" ? company : undefined,
      },
    });

    const token = signToken(user.id);
    console.log(`[AUTH] New user registered: ${email} (${type}, ${userPlan})`);

    res.status(201).json({ token, user: sanitizeUser(user) });
  } catch (error) {
    console.error("[AUTH] Register error:", error);
    res.status(500).json({ message: "Erro interno ao criar conta.", error: String(error) });
  }
});

// ── Login ──
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
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
    res.status(500).json({ message: "Erro interno ao fazer login.", error: String(error) });
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
    res.status(500).json({ message: "Erro interno.", error: String(error) });
  }
});

// ── SSE Endpoint ──
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Optional session tracking
  const sessionId = req.query.sessionId as string || Math.random().toString(36).substring(7);
  
  const client: SseClient = { id: sessionId, res };
  sseClients.push(client);

  console.log(`[SSE] Client connected: ${sessionId} (Total: ${sseClients.length})`);

  req.on("close", () => {
    sseClients = sseClients.filter((c) => c.id !== sessionId);
    console.log(`[SSE] Client disconnected: ${sessionId} (Total: ${sseClients.length})`);
  });
});

// ── Health ──
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "cybersafe-api" });
});

// ── AI Chat ──
app.post("/api/ai/chat", async (req, res) => {
  try {
    if (!groqApiKey) {
      res.status(503).json({
        message: "IA indisponível: define GROQ_API_KEY no ficheiro .env da API (packages/api) e reinicia o servidor.",
      });
      return;
    }

    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ message: "Messages array is required" });
      return;
    }

    const systemPrompt = {
      role: "system" as const,
      content: CYBERSAFE_AI_SYSTEM_PROMPT,
    };

    const completion = await openai.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [systemPrompt, ...messages],
      temperature: 0.7,
      max_tokens: 500,
    });

    res.json({ response: completion.choices[0].message.content });
  } catch (error) {
    console.error("OpenAI API error:", error);
    res.status(500).json({ message: "Ocorreu um erro ao conectar com o serviço de IA." });
  }
});

// ── Create event ──
app.post("/api/events", async (req, res) => {
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
app.get("/api/events", async (_req, res) => {
  try {
    const events = await prisma.threatEvent.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    res.json(events.map(toThreatEvent));
  } catch (error) {
    res.status(500).json({ message: "Failed to load events", error: String(error) });
  }
});

// ── Delete all events ──
app.delete("/api/events", async (_req, res) => {
  try {
    const result = await prisma.threatEvent.deleteMany();
    res.json({ deleted: result.count });
  } catch (error) {
    res.status(500).json({ message: "Failed to clear events", error: String(error) });
  }
});

// ── Event stats ──
app.get("/api/events/stats", async (_req, res) => {
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
app.get("/api/dashboard", async (_req, res) => {
  try {
    const events = await prisma.threatEvent.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    res.json(buildDashboardSummary(events.map(toThreatEvent)));
  } catch (error) {
    res.status(500).json({ message: "Failed to load dashboard", error: String(error) });
  }
});

// ── File scan ──
app.post("/api/file-scan", upload.single("file"), async (req, res) => {
  try {
    const uploaded = req.file;
    if (!uploaded) {
      res.status(400).json({ message: "File is required" });
      return;
    }

    const results: FileScanResult[] = [];
    const name = uploaded.originalname;
    const isZip = name.toLowerCase().endsWith(".zip");

    if (isZip) {
      const zip = new AdmZip(uploaded.buffer);
      const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
      for (const entry of entries) {
        let analysis = analyzeDownloadFilename(entry.entryName);
        
        // ── Advanced Heuristics: Magic Number Detection ──
        // Check if the file has an MZ header (4D 5A) indicating an executable,
        // even if the filename doesn't have a dangerous extension.
        const data = entry.getData();
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
    res.status(500).json({ message: "Failed to scan file", error: String(error) });
  }
});

// ── Training score ──
app.post("/api/training-score", async (req, res) => {
  try {
    const { correctCount, totalCount } = req.body as { correctCount: number; totalCount: number };
    const score = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
    const result = await prisma.trainingResult.create({
      data: { correctCount, totalCount, score }
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to save training score", error: String(error) });
  }
});

app.get("/api/training-score", async (_req, res) => {
  try {
    const results = await prisma.trainingResult.findMany({ orderBy: { completedAt: "desc" }, take: 20 });
    const totalSessions = results.length;
    const avgScore = totalSessions > 0 ? Math.round(results.reduce((acc: number, r: { score: number }) => acc + r.score, 0) / totalSessions) : 0;
    res.json({ totalSessions, averageScore: avgScore, recentResults: results });
  } catch (error) {
    res.status(500).json({ message: "Failed to load training scores", error: String(error) });
  }
});

app.listen(port, () => {
  console.log(`CyberSafe API listening on http://localhost:${port}`);
});
