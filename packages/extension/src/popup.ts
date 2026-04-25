import { analyzeUrlRisk, type ThreatEvent } from "@cybersafe/shared-types";

async function render() {
  const statusEl = document.getElementById("status")!;
  const urlEl = document.getElementById("url")!;
  const severityEl = document.getElementById("severity")!;
  const rulesEl = document.getElementById("rules")!;
  const confidenceEl = document.getElementById("confidence")!;

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
