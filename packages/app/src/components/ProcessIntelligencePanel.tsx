import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ProcessDiagnostic } from "../lib/processIntelligence";
import { resumoDoDiagnostico } from "../lib/processIntelligence";

/**
 * PACOTE C (PROCESS-UX-HUMAN-FAIL-20261014): "Diagnóstico inteligente"
 * colapsável, FECHADO por defeito. A tabela do Gestor de Tarefas JÁ é o Top5
 * por memória — o painel não o duplica: aberto, mostra os factos medidos, as
 * tendências que existem (identidade pid+instante), recomendações e limites, e
 * a porta para a MATRIX. Fecho = uma linha de resumo honesta + seta.
 *
 * Identidade congelada: "Explicar" envia pid + startedAt DA AMOSTRA MOSTRADA.
 * Um PID sozinho não é uma instância (o Windows reutiliza-o); resolver pid
 * simples no clique trocaria de processo (defeito apontado na revisão CODEX).
 */

interface Props {
  diagnostic?: ProcessDiagnostic;
  onExplain?: (pid?: number, startedAt?: string | null) => void;
}

export default function ProcessIntelligencePanel({ diagnostic, onExplain }: Props) {
  const [aberto, setAberto] = useState(false);
  const resumo = resumoDoDiagnostico(diagnostic ?? null);

  return (
    <section className="stat-card p-4 shrink-0 space-y-2" aria-label="Diagnóstico inteligente">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        className="flex w-full items-center justify-between gap-4 text-left"
      >
        <span className="min-w-0">
          <span className="block font-semibold text-sm">Diagnóstico inteligente</span>
          <span className="block text-xs text-muted-foreground mt-0.5">{resumo.linha}</span>
        </span>
        <span className="flex items-center gap-1.5 shrink-0 text-xs text-primary font-mono">
          <span aria-hidden>{aberto ? "Ocultar explicação" : "Ver explicação"}</span>
          {aberto ? <ChevronDown className="w-4 h-4" aria-hidden /> : <ChevronRight className="w-4 h-4" aria-hidden />}
        </span>
      </button>

      {aberto && (
        <div className="space-y-3 pt-2 border-t border-border/40">
          {!diagnostic && (
            <p className="text-sm text-muted-foreground">A recolher dados. Ainda não há uma amostra confirmada.</p>
          )}
          {diagnostic && (
            <>
              <p className="text-xs text-muted-foreground">
                Amostra recebida: {new Date(diagnostic.measuredAt).toLocaleTimeString("pt-PT")} · CPU global:{" "}
                {diagnostic.cpuPercent === null ? "sem leitura" : `${diagnostic.cpuPercent.toFixed(1)}%`} · RAM utilizada:{" "}
                {diagnostic.ram.usedMb === null ? "sem leitura" : `${Math.round(diagnostic.ram.usedMb)} MB`}
              </p>
              {diagnostic.observations.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {diagnostic.observations.map((o) => <li key={o} className="text-foreground">{o}</li>)}
                </ul>
              )}
              {diagnostic.trends.length > 0 && (() => {
                // UM achado, não uma lista: o ranking do diagnóstico já ordena
                // por prioridade topRAM e maior variação absoluta medida. As 5
                // linhas repetidas aqui duplicariam de novo o Top5 do PC
                // Center — o que este painel veio deixar de fazer.
                const t = diagnostic.trends[0];
                const nome = diagnostic.topProcesses.find((p) => p.pid === t.pid && (p.startedAt || null) === (t.startedAt || null))?.name
                  ?? `PID ${t.pid}`;
                return (
                  <div className="text-sm">
                    <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Achado principal (medido)</p>
                    <p className="mt-1">
                      <span className="font-medium">{nome}</span>{" "}
                      <span className="text-muted-foreground">
                        PID {t.pid} · Working Set {Math.round(t.currentMb)} MB · {t.deltaMb >= 0 ? "+" : ""}{Math.round(t.deltaMb)} MB em {Math.round(t.intervalMs / 1000)} s · {t.samples} amostras
                      </span>
                    </p>
                    {onExplain && (
                      <button
                        type="button"
                        className="mt-1 text-primary text-xs"
                        aria-label={`Explicar ${nome} na MATRIX`}
                        onClick={() => onExplain(t.pid, t.startedAt ?? null)}
                      >
                        Explicar na MATRIX
                      </button>
                    )}
                  </div>
                );
              })()}
              <div>
                <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Recomendações</p>
                <ul className="mt-1 space-y-1 text-sm">
                  {diagnostic.recommendations.map((r) => <li key={r} className="text-muted-foreground">{r}</li>)}
                </ul>
              </div>
              <div>
                <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Limites da medição</p>
                <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                  {diagnostic.limitations.map((l) => <li key={l}>{l}</li>)}
                </ul>
              </div>
              {onExplain && (
                <button type="button" className="text-sm text-primary" onClick={() => onExplain()}>
                  Explicar na MATRIX
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
