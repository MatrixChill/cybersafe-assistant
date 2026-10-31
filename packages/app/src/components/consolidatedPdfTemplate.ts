/**
 * consolidatedPdfTemplate.ts
 *
 * Gera o documento HTML profissional pronto para renderização A4 e printToPDF (AG-20).
 *
 * Regras cruciais:
 * - Capa e identidade CyberSafe Assistant profissional.
 * - Formato A4 com paginação controlada e suporte a relatórios extensos.
 * - Não inventa métricas e não transforma valores desconhecidos em zero.
 * - Sanitização de HTML estrita em todos os campos dinâmicos.
 * - Remoção de dados sensíveis quando hidePersonalData está ativo.
 */
import type { ConsolidatedScanReport } from "@/lib/consolidatedScanReport";

function esc(valor: unknown): string {
  return String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dataHora(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "data ilegível";
  return d.toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" });
}

export function generateConsolidatedPdfHtml(report: ConsolidatedScanReport): string {
  const { stats, filterApplied, entries, limitations, summaryText } = report;
  const hidePersonal = filterApplied.hidePersonalData ?? false;

  const rowsHtml = entries.map((entry, idx) => {
    const statusClass = entry.status === "completed" ? "status-ok" : entry.status === "failed" ? "status-crit" : "status-warn";
    const statusLabel = entry.status === "completed" ? (entry.isPartial ? "Parcial" : "Concluída") : entry.status === "cancelled" ? "Cancelada" : "Falhou";

    return `
      <tr>
        <td class="mono font-bold">${idx + 1}</td>
        <td class="mono">${esc(entry.id)}</td>
        <td class="uppercase">${esc(entry.type)}</td>
        <td><span class="badge ${statusClass}">${esc(statusLabel)}</span></td>
        <td class="mono">${esc(dataHora(entry.startedAt))}</td>
        <td class="mono text-right">${entry.filesConsidered ?? "—"}</td>
        <td class="mono text-right">${entry.filesAnalyzed ?? "—"}</td>
        <td class="mono text-right ${(entry.threatsFound ?? 0) > 0 ? "text-crit font-bold" : ""}">${entry.threatsFound ?? "—"}</td>
        <td class="mono text-right">${esc(entry.durationFormatted)}</td>
      </tr>
    `;
  }).join("\n");

  const limitationsBlock = limitations.length > 0
    ? `
      <div class="section-card limitacoes-box">
        <h3>Limitações Medidas de Cobertura e Motores</h3>
        <p>Durante as análises selecionadas foram reportadas as seguintes limitações pelos motores locais:</p>
        <ul>
          ${limitations.map((lim) => `<li><b>${esc(lim)}</b></li>`).join("\n")}
        </ul>
      </div>
    `
    : "";

  return `<!doctype html>
<html lang="pt-PT">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'" />
<title>CyberSafe Assistant — Relatório Consolidado de Segurança</title>
<style>
  @page {
    size: A4 portrait;
    margin: 15mm 12mm 15mm 12mm;
    @bottom-right {
      content: "Página " counter(page) " de " counter(pages);
      font-family: 'Segoe UI', system-ui, sans-serif;
      font-size: 9pt;
      color: #64748b;
    }
  }

  body {
    font-family: 'Segoe UI', -apple-system, system-ui, sans-serif;
    color: #0f172a;
    background: #ffffff;
    margin: 0;
    padding: 0;
    font-size: 10pt;
    line-height: 1.5;
  }

  /* Capa e Cabeçalho */
  .header-card {
    border-bottom: 2px solid #0284c7;
    padding-bottom: 14px;
    margin-bottom: 20px;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }

  .brand-title {
    font-size: 20pt;
    font-weight: 800;
    color: #0f172a;
    letter-spacing: -0.02em;
    margin: 0;
  }

  .brand-subtitle {
    font-size: 11pt;
    color: #0284c7;
    font-weight: 600;
    margin-top: 2px;
  }

  .report-meta {
    text-align: right;
    font-size: 8.5pt;
    color: #64748b;
    font-family: Consolas, monospace;
  }

  /* Resumo Executivo */
  .section-title {
    font-size: 12pt;
    font-weight: 700;
    color: #1e293b;
    margin: 16px 0 8px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-left: 3px solid #0284c7;
    padding-left: 8px;
  }

  .exec-summary {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 12px 14px;
    font-size: 9.5pt;
    color: #334155;
    margin-bottom: 16px;
  }

  /* Grelha de Métricas */
  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 20px;
  }

  .metric-box {
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    padding: 10px;
    text-align: center;
  }

  .metric-value {
    font-size: 16pt;
    font-weight: 800;
    font-family: Consolas, monospace;
    color: #0f172a;
  }

  .metric-label {
    font-size: 7.5pt;
    font-weight: 600;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 2px;
  }

  /* Tabela de Análises */
  table.report-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 8.5pt;
    margin-top: 8px;
    margin-bottom: 20px;
  }

  table.report-table th {
    background: #f1f5f9;
    border-bottom: 2px solid #cbd5e1;
    color: #475569;
    font-weight: 700;
    padding: 6px 8px;
    text-align: left;
    text-transform: uppercase;
    font-size: 7.5pt;
    letter-spacing: 0.03em;
  }

  table.report-table td {
    padding: 6px 8px;
    border-bottom: 1px solid #e2e8f0;
  }

  .mono {
    font-family: Consolas, monospace;
  }

  .text-right {
    text-align: right;
  }

  .font-bold {
    font-weight: 700;
  }

  .uppercase {
    text-transform: uppercase;
  }

  /* Badges */
  .badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 7.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .status-ok { background: #dcfce7; color: #166534; }
  .status-warn { background: #fef3c7; color: #92400e; }
  .status-crit { background: #fee2e2; color: #991b1b; }
  .text-crit { color: #dc2626; }

  /* Limitações */
  .limitacoes-box {
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 20px;
    font-size: 8.5pt;
  }

  .limitacoes-box h3 {
    margin: 0 0 4px;
    font-size: 9.5pt;
    color: #92400e;
  }

  .limitacoes-box ul {
    margin: 4px 0 0;
    padding-left: 18px;
    color: #78350f;
  }

  /* Rodapé Legal */
  .report-footer {
    border-top: 1px solid #cbd5e1;
    padding-top: 10px;
    margin-top: 25px;
    font-size: 7.5pt;
    color: #64748b;
    line-height: 1.4;
  }
</style>
</head>
<body>

  <!-- Cabeçalho Oficial -->
  <div class="header-card">
    <div>
      <h1 class="brand-title">CYBERSAFE ASSISTANT</h1>
      <div class="brand-subtitle">Relatório Consolidado de Segurança e Análises</div>
    </div>
    <div class="report-meta">
      <div><b>Emissão:</b> ${esc(dataHora(report.generatedAt))}</div>
      <div><b>Âmbito:</b> ${esc(hidePersonal ? "Dados pessoais ocultados" : "Completo")}</div>
      <div><b>Total de Sessões:</b> ${stats.totalScans}</div>
    </div>
  </div>

  <!-- Resumo Executivo -->
  <div class="section-title">Resumo Executivo</div>
  <div class="exec-summary">
    ${esc(summaryText)}
  </div>

  <!-- Métricas Consolidadas -->
  <div class="metrics-grid">
    <div class="metric-box">
      <div class="metric-value">${stats.completedScans}</div>
      <div class="metric-label">Concluídas</div>
    </div>
    <div class="metric-box">
      <div class="metric-value" style="color: ${stats.partialScans > 0 ? "#b45309" : "#0f172a"};">${stats.partialScans}</div>
      <div class="metric-label">Parciais / Inconclusivas</div>
    </div>
    <div class="metric-box">
      <div class="metric-value">${stats.totalFilesAnalyzed ?? "—"}</div>
      <div class="metric-label">Ficheiros Analisados</div>
    </div>
    <div class="metric-box">
      <div class="metric-value" style="color: ${(stats.totalThreatsFound ?? 0) > 0 ? "#dc2626" : "#16a34a"};">${stats.totalThreatsFound ?? "—"}</div>
      <div class="metric-label">Ocorrências de deteção</div>
    </div>
  </div>

  ${limitationsBlock}

  <!-- Tabela Cronológica de Análises -->
  <div class="section-title">Cronologia das Análises Consolidadas (${entries.length})</div>
  <table class="report-table">
    <thead>
      <tr>
        <th style="width: 24px;">#</th>
        <th>ID da Sessão</th>
        <th>Tipo</th>
        <th>Resultado</th>
        <th>Início</th>
        <th class="text-right">Considerados</th>
        <th class="text-right">Analisados</th>
        <th class="text-right">Ocorrências</th>
        <th class="text-right">Duração</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>

  <!-- Rodapé e Declaração de Metodologia -->
  <div class="report-footer">
    <p><b>Nota de Metodologia e Limites de Responsabilidade:</b></p>
    <p>Este relatório consolida os resultados medidos de sessões de análise executadas localmente pelo CyberSafe Assistant. «Ficheiros considerados» inclui ficheiros ignorados pela política de exclusão ou ilegíveis. «Ficheiros analisados» reflete exclusivamente o que foi verificado pelos motores ativos. A ausência de deteções não constitui garantia absoluta de segurança ou isenção de código malicioso.</p>
    <p>Os totais somam ocorrências entre análises; não representam ameaças nem ficheiros únicos. Campos não registados surgem como —. A participação individual dos motores só é conhecida quando o histórico a regista.</p>
    <p>CyberSafe Assistant · Prova de Aptidão Profissional · 2026</p>
  </div>

</body>
</html>`;
}
