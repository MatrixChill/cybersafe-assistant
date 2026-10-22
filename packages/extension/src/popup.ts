import { analyzeUrlRisk } from "@cybersafe/shared-types";

// S3: a API local escuta apenas em loopback IPv4. /health continua público.
const HEALTH_URL = "http://127.0.0.1:4000/health";
const FETCH_TIMEOUT_MS = 3500;

/** Sonda a API local e mostra o estado real (ONLINE/OFFLINE/ERRO). */
async function checkApi(el: HTMLElement): Promise<void> {
  el.textContent = "…";
  el.className = "value";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(HEALTH_URL, { signal: controller.signal });
    if (res.ok) {
      el.textContent = "ONLINE";
      el.className = "value api-online";
    } else {
      el.textContent = `ERRO ${res.status}`;
      el.className = "value api-offline";
    }
  } catch {
    el.textContent = "OFFLINE";
    el.className = "value api-offline";
  } finally {
    clearTimeout(timer);
  }
}

async function render() {
  const statusEl = document.getElementById("status")!;
  const urlEl = document.getElementById("url")!;
  const severityEl = document.getElementById("severity")!;
  const rulesEl = document.getElementById("rules")!;
  const confidenceEl = document.getElementById("confidence")!;
  const apiEl = document.getElementById("api")!;

  // Independente da análise de URL — corre em paralelo, sem bloquear.
  void checkApi(apiEl);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || tab.url.startsWith("chrome://")) {
      statusEl.textContent = "Página do navegador — sem análise";
      statusEl.className = "safe";
      urlEl.textContent = tab?.url ?? "—";
      return;
    }

    urlEl.textContent = tab.url;
    const analysis = analyzeUrlRisk(tab.url);

    if (analysis.rulesTriggered.length === 0) {
      statusEl.textContent = "✅ Seguro";
      statusEl.className = "safe";
      severityEl.textContent = "LOW";
      rulesEl.textContent = "Nenhuma regra suspeita detectada.";
      confidenceEl.textContent = `${Math.round(analysis.confidence * 100)}%`;
    } else {
      statusEl.textContent = `⚠️ ${analysis.severity.toUpperCase()} RISCO`;
      statusEl.className = `risk-${analysis.severity}`;
      severityEl.textContent = analysis.severity.toUpperCase();
      rulesEl.textContent = analysis.rulesTriggered.join(", ");
      confidenceEl.textContent = `${Math.round(analysis.confidence * 100)}%`;
    }
  } catch {
    statusEl.textContent = "Erro ao analisar";
    statusEl.className = "";
  }
}

document.addEventListener("DOMContentLoaded", render);
