import { analyzeUrlRisk } from "@cybersafe/shared-types";

(function () {
  const url = window.location.href;
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return;

  const analysis = analyzeUrlRisk(url);
  if (analysis.rulesTriggered.length === 0) return;

  // Inject warning banner
  const banner = document.createElement("div");
  banner.id = "cybersafe-warning-banner";

  const severityColors: Record<string, { bg: string; border: string; text: string }> = {
    low:      { bg: "rgba(52,211,153,0.08)", border: "#34d399", text: "#34d399" },
    medium:   { bg: "rgba(251,191,36,0.1)",  border: "#fbbf24", text: "#fbbf24" },
    high:     { bg: "rgba(248,113,113,0.1)", border: "#f87171", text: "#f87171" },
    critical: { bg: "rgba(167,139,250,0.1)", border: "#a78bfa", text: "#a78bfa" },
  };

  const colors = severityColors[analysis.severity] || severityColors.medium;

  banner.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2147483647;
    background: ${colors.bg};
    backdrop-filter: blur(12px);
    border-bottom: 2px solid ${colors.border};
    color: ${colors.text};
    font-family: -apple-system, system-ui, sans-serif;
    font-size: 14px;
    font-weight: 600;
    padding: 10px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.3);
    animation: cybersafe-slide-in 0.3s ease-out;
  `;

  const rulesText = analysis.rulesTriggered.join(", ");

  banner.innerHTML = `
    <span>
      ⚠️ <strong>CyberSafe:</strong> 
      ${analysis.severity.toUpperCase()} risco detectado — ${rulesText}
    </span>
    <button id="cybersafe-dismiss" style="
      background: transparent;
      border: 1px solid ${colors.border};
      color: ${colors.text};
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      flex-shrink: 0;
    ">Fechar</button>
  `;

  // Add animation keyframes
  const style = document.createElement("style");
  style.textContent = `
    @keyframes cybersafe-slide-in {
      from { transform: translateY(-100%); opacity: 0; }
      to   { transform: translateY(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);
  document.body.prepend(banner);

  // Dismiss handler
  document.getElementById("cybersafe-dismiss")?.addEventListener("click", () => {
    banner.style.animation = "none";
    banner.style.transition = "transform 0.25s ease, opacity 0.25s ease";
    banner.style.transform = "translateY(-100%)";
    banner.style.opacity = "0";
    setTimeout(() => banner.remove(), 300);
  });
})();
