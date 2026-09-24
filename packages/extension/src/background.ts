import { analyzeUrlRisk, analyzeDownloadEvent, type ThreatEvent } from "@cybersafe/shared-types";

const API_BASE = "http://localhost:4000";
const EVENTS_URL = `${API_BASE}/api/events`;
const HEALTH_URL = `${API_BASE}/health`;
const FETCH_TIMEOUT_MS = 3500;

type ApiState = "unknown" | "online" | "offline";

const SEVERITY_BADGE: Record<ThreatEvent["severity"], { text: string; color: string }> = {
  low: { text: "LOW", color: "#1f9d55" },
  medium: { text: "MED", color: "#d97706" },
  high: { text: "HIGH", color: "#dc2626" },
  critical: { text: "CRT", color: "#7f1d1d" }
};

const OFFLINE_BADGE = { text: "OFF", color: "#64748b" };

// ── Download frequency tracking ──
let downloadCounter = 0;
let downloadResetTimer: ReturnType<typeof setTimeout> | null = null;

// ── Connection + last-risk state (drives an honest badge) ──
let apiState: ApiState = "unknown";
let lastRisk: { severity: ThreatEvent["severity"]; rulesTriggered: string[] } | null = null;
let lastBadgeText: string | null = null;

function resetDownloadCounter() {
  downloadCounter = 0;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Envia apenas metadata mínima (scheme+host+path). Query/fragment são
 * descartados para nunca reter tokens ou dados sensíveis nos eventos.
 */
function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw;
  }
}

function renderBadge() {
  if (apiState === "offline") {
    chrome.action.setBadgeBackgroundColor({ color: OFFLINE_BADGE.color });
    chrome.action.setBadgeText({ text: OFFLINE_BADGE.text });
    chrome.action.setTitle({ title: `CyberSafe: API local indisponível (${API_BASE})` });
    return;
  }

  if (lastRisk) {
    const badgeStyle = SEVERITY_BADGE[lastRisk.severity];
    chrome.action.setBadgeBackgroundColor({ color: badgeStyle.color });
    chrome.action.setBadgeText({ text: lastBadgeText ?? badgeStyle.text });
    chrome.action.setTitle({
      title: `CyberSafe: ${lastRisk.severity.toUpperCase()} risk (${lastRisk.rulesTriggered.join(", ")})`
    });
    return;
  }

  chrome.action.setBadgeText({ text: "" });
  chrome.action.setTitle({ title: "CyberSafe Assistant" });
}

function setApiState(next: ApiState) {
  if (apiState === next) return;
  apiState = next;
  renderBadge();
}

/** Sonda /health para saber, de forma honesta, se a API local responde. */
async function probeApi(): Promise<ApiState> {
  try {
    const res = await fetchWithTimeout(HEALTH_URL, { method: "GET" });
    setApiState(res.ok ? "online" : "offline");
  } catch (err) {
    setApiState("offline");
    console.warn(
      `[CyberSafe] API local indisponível em ${HEALTH_URL}:`,
      err instanceof Error ? err.message : String(err)
    );
  }
  return apiState;
}

/**
 * Entrega um evento real à API local. Erros NÃO são silenciados: registam-se
 * em consola e refletem-se no estado/badge. Devolve true se foi aceite.
 */
async function sendEvent(event: ThreatEvent): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(EVENTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event)
    });
    if (!res.ok) {
      setApiState("offline");
      console.warn(`[CyberSafe] Evento não aceite pela API local (HTTP ${res.status}).`);
      return false;
    }
    setApiState("online");
    return true;
  } catch (err) {
    setApiState("offline");
    console.warn(
      `[CyberSafe] Falha ao enviar evento para ${EVENTS_URL}:`,
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}

// ── URL monitoring ──
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;
  if (tab.url.startsWith("chrome://")) return;

  const analysis = analyzeUrlRisk(tab.url);
  if (analysis.rulesTriggered.length === 0) {
    lastRisk = null;
    lastBadgeText = null;
    renderBadge();
    return;
  }

  const url = new URL(tab.url);
  const event: ThreatEvent = {
    source: "extension",
    url: sanitizeUrl(tab.url),
    domain: url.hostname,
    severity: analysis.severity,
    confidence: analysis.confidence,
    rulesTriggered: analysis.rulesTriggered,
    createdAt: new Date().toISOString(),
    riskScore: analysis.confidence * 100
  };

  lastRisk = { severity: event.severity, rulesTriggered: event.rulesTriggered };
  lastBadgeText = null;
  renderBadge();
  void sendEvent(event);
});

// ── Download monitoring ──
chrome.downloads.onCreated.addListener((download) => {
  downloadCounter++;

  // Reset counter after 60 seconds of inactivity
  if (downloadResetTimer) clearTimeout(downloadResetTimer);
  downloadResetTimer = setTimeout(resetDownloadCounter, 60_000);

  const filename = download.filename || download.url;
  const downloadUrl = download.url;
  let domain = "unknown";
  try {
    domain = new URL(downloadUrl).hostname;
  } catch { /* ok */ }

  // filename é usado só localmente pela heurística — nunca é enviado no evento.
  const analysis = analyzeDownloadEvent(filename, downloadUrl);

  // Escalate severity if download frequency is abnormally high
  let finalSeverity = analysis.severity;
  const finalRules = [...analysis.rulesTriggered];

  if (downloadCounter > 5) {
    finalSeverity = "critical";
    if (!finalRules.includes("high_download_frequency")) {
      finalRules.push("high_download_frequency");
    }
  } else if (downloadCounter > 3 && finalSeverity === "low") {
    finalSeverity = "medium";
    if (!finalRules.includes("high_download_frequency")) {
      finalRules.push("high_download_frequency");
    }
  }

  // Only send event if there's something suspicious
  if (finalRules.length === 0) return;

  const event: ThreatEvent = {
    source: "download-monitor",
    url: sanitizeUrl(downloadUrl),
    domain,
    severity: finalSeverity,
    confidence: analysis.confidence,
    rulesTriggered: finalRules,
    createdAt: new Date().toISOString(),
    riskScore: analysis.confidence * 100
  };

  lastRisk = { severity: finalSeverity, rulesTriggered: finalRules };
  lastBadgeText = "DL";
  renderBadge();
  void sendEvent(event);
});

// ── Connection probing (honest availability state) ──
chrome.runtime.onInstalled.addListener(() => { void probeApi(); });
chrome.runtime.onStartup.addListener(() => { void probeApi(); });
void probeApi();

chrome.alarms.create("cybersafe-health", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "cybersafe-health") void probeApi();
});
