import { analyzeUrlRisk, analyzeDownloadEvent, type ThreatEvent } from "@cybersafe/shared-types";

const API_URL = "http://localhost:4000/api/events";

const SEVERITY_BADGE: Record<ThreatEvent["severity"], { text: string; color: string }> = {
  low: { text: "LOW", color: "#1f9d55" },
  medium: { text: "MED", color: "#d97706" },
  high: { text: "HIGH", color: "#dc2626" },
  critical: { text: "CRT", color: "#7f1d1d" }
};

// ── Download frequency tracking ──
let downloadCounter = 0;
let downloadResetTimer: ReturnType<typeof setTimeout> | null = null;

function resetDownloadCounter() {
  downloadCounter = 0;
}

function sendEvent(event: ThreatEvent) {
  fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event)
  }).catch(() => {
    // Keep extension non-blocking if API is offline.
  });
}

// ── URL monitoring ──
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;
  if (tab.url.startsWith("chrome://")) return;

  const analysis = analyzeUrlRisk(tab.url);
  if (analysis.rulesTriggered.length === 0) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  const url = new URL(tab.url);
  const event: ThreatEvent = {
    source: "extension",
    url: tab.url,
    domain: url.hostname,
    severity: analysis.severity,
    confidence: analysis.confidence,
    rulesTriggered: analysis.rulesTriggered,
    createdAt: new Date().toISOString(),
    riskScore: analysis.confidence * 100
  };

  const badgeStyle = SEVERITY_BADGE[event.severity];
  chrome.action.setBadgeBackgroundColor({ color: badgeStyle.color });
  chrome.action.setBadgeText({ text: badgeStyle.text });
  chrome.action.setTitle({
    title: `CyberSafe: ${event.severity.toUpperCase()} risk (${event.rulesTriggered.join(", ")})`
  });

  sendEvent(event);
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
    url: downloadUrl,
    domain,
    severity: finalSeverity,
    confidence: analysis.confidence,
    rulesTriggered: finalRules,
    createdAt: new Date().toISOString(),
    riskScore: analysis.confidence * 100
  };

  sendEvent(event);

  // Update badge to show download alert
  const badgeStyle = SEVERITY_BADGE[finalSeverity];
  chrome.action.setBadgeBackgroundColor({ color: badgeStyle.color });
  chrome.action.setBadgeText({ text: "DL" });
  chrome.action.setTitle({
    title: `CyberSafe: Download suspeito — ${filename} (${finalRules.join(", ")})`
  });
});
