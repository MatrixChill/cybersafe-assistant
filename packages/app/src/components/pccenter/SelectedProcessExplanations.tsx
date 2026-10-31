import { useMemo } from "react";
import { HelpCircle, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProcessSnapshot } from "@cybersafe/shared-types";
import { buildExplicacoesProcesso, type Certeza } from "@/lib/pccenter/processExplanations";

interface SelectedProcessExplanationsProps {
  processo: ProcessSnapshot | null;
  agoraMs?: number;
  /**
   * Vem da regra EXISTENTE do produto (`isProtectedProcess`) no call-site —
   * aqui não há lista de nomes nem regra duplicada.
   */
  protegido?: boolean;
}

const ETIQUETA: Record<Certeza, string> = { medido: "medido", desconhecido: "desconhecido" };
const CLASSE: Record<Certeza, string> = { medido: "text-primary", desconhecido: "text-muted-foreground/70" };

function valorTexto(valor: string | number | null, unidade: string | null): string {
  if (valor == null) return "—";
  return unidade ? `${valor} ${unidade}` : String(valor);
}

/**
 * Explicações do processo selecionado: factos medidos, alerta conservador de
 * proteção vindo de fora, riscos e MATRIX futura. Sem ação, sem assinatura
 * inventada e sem classificar o processo a partir do nome.
 */
export default function SelectedProcessExplanations({ processo, agoraMs, protegido = false }: SelectedProcessExplanationsProps) {
  const e = useMemo(() => buildExplicacoesProcesso({ processo, agoraMs }), [processo, agoraMs]);

  return (
    <section className="bg-card cyber-border rounded-xl p-6 space-y-4" data-testid="process-explicacoes" aria-labelledby="process-explicacoes-titulo">
      <header className="flex items-center gap-2">
        <HelpCircle className="w-5 h-5 text-primary" aria-hidden="true" />
        <div>
          <h2 id="process-explicacoes-titulo" className="text-lg font-semibold">Explicações do processo</h2>
          <p className="text-xs text-muted-foreground">
            {e.alvo ? `${e.alvo.nome} · PID ${e.alvo.pid}` : "Sem processo selecionado"}
          </p>
        </div>
      </header>

      {protegido && (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-secondary/30 p-3 text-sm" data-testid="process-protegido">
          <ShieldAlert className="w-4 h-4 mt-0.5 text-primary shrink-0" aria-hidden="true" />
          Alerta conservador da regra do produto: este processo é tratado como protegido. A identidade não é
          confirmada por caminho/assinatura nesta vista e nada é encerrado automaticamente.
        </p>
      )}

      {e.fatos.length === 0 ? (
        <p className="text-sm text-muted-foreground">Selecione um processo com nome e PID medidos para ver explicações.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs uppercase text-muted-foreground font-mono">
              <tr><th className="py-1 pr-3">Facto</th><th className="py-1 pr-3">Valor</th><th className="py-1">Estado</th></tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {e.fatos.map((f) => (
                <tr key={f.id} className="border-t border-border/60">
                  <td className="py-1 pr-3 text-foreground">{f.rotulo}</td>
                  <td className="py-1 pr-3 truncate max-w-[28rem]" title={f.motivo ?? undefined}>{valorTexto(f.valor, f.unidade)}</td>
                  <td className={cn("py-1 text-xs", CLASSE[f.certeza])}>{ETIQUETA[f.certeza]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Leitura</h3>
        <p className="text-xs text-muted-foreground">
          Sem baseline nem duração acumulada, estes números não provam comportamento anormal; a guidance
          existente do produto mantém-se a fonte das regras de prioridade.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Riscos e reversibilidade</h3>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {e.riscos.map((r) => (
            <li key={r.id}><span className="text-foreground">{r.descricao}</span> {r.reversibilidade}</li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-border bg-secondary/20 p-3 space-y-1" data-testid="process-matriz">
        <p className="text-sm text-foreground">MATRIX — opção consentida</p>
        <p className="text-xs text-muted-foreground">{e.matriz.nota} Estado: <span className="font-mono">{e.matriz.estado}</span>.</p>
        <button type="button" disabled aria-disabled="true" className="mt-1 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground/70 cursor-not-allowed">
          Ativar MATRIX (requer consentimento)
        </button>
      </div>

      <ul className="space-y-1 text-xs text-muted-foreground/80">
        {e.avisos.map((a) => <li key={a}>• {a}</li>)}
      </ul>
    </section>
  );
}
