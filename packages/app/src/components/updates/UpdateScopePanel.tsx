import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildAmbitoAtualizacoes, type SnapshotPrograma, type EstadoTipo } from "./updateScope";

interface UpdateScopePanelProps {
  bridgeAvailable: boolean;
  snapshot: SnapshotPrograma | null;
}

const ETIQUETA: Record<EstadoTipo, string> = {
  medido: "medido",
  "nao-configurado": "não configurado",
  "indisponivel": "indisponível",
  "desconhecido": "desconhecido",
  "nao-apresentado": "não apresentado aqui",
};

function tom(estado: EstadoTipo): string {
  if (estado === "medido") return "text-primary";
  if (estado === "nao-configurado" || estado === "indisponivel" || estado === "desconhecido") return "text-cyber-yellow";
  return "text-muted-foreground";
}

/** Âmbito das atualizações: programa vs definições vs regras. Só descritivo. */
export function UpdateScopePanel({ bridgeAvailable, snapshot }: UpdateScopePanelProps) {
  const a = buildAmbitoAtualizacoes({ bridgeAvailable, snapshot });
  return (
    <section className="mb-6 rounded-lg border border-border bg-secondary/20 p-4 space-y-3" data-testid="update-scope-panel" aria-labelledby="update-scope-titulo">
      <div className="flex items-start gap-2">
        <Info className="w-4 h-4 mt-0.5 text-primary shrink-0" aria-hidden="true" />
        <div>
          <h3 id="update-scope-titulo" className="text-sm font-semibold text-foreground">Âmbito das atualizações</h3>
          <p className="text-xs text-muted-foreground">{a.nota}</p>
        </div>
      </div>

      <ul className="space-y-2">
        {a.tipos.map((t) => (
          <li key={t.id} className="rounded-md border border-border bg-background/30 p-3 text-xs" data-testid={`update-scope-${t.id}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono font-semibold text-foreground">{t.titulo}</span>
              <span className={cn("font-mono uppercase text-[10px]", tom(t.estado))}>{ETIQUETA[t.estado]}</span>
            </div>
            <p className="mt-1 text-muted-foreground">{t.texto}</p>
            <dl className="mt-1 grid grid-cols-1 gap-0.5 text-[11px] text-muted-foreground">
              <div><dt className="inline font-mono uppercase text-foreground/80">Benefícios: </dt><dd className="inline">{t.beneficios}</dd></div>
              <div><dt className="inline font-mono uppercase text-foreground/80">Riscos: </dt><dd className="inline">{t.riscos}</dd></div>
              <div><dt className="inline font-mono uppercase text-foreground/80">Preservação: </dt><dd className="inline">{t.preservacao}</dd></div>
            </dl>
          </li>
        ))}
      </ul>

      <p className="text-[11px] text-muted-foreground" data-testid="update-scope-verificacao">{a.verificacao}</p>
      <ul className="space-y-0.5 text-[11px] text-muted-foreground/80">
        {a.avisos.map((av) => <li key={av}>• {av}</li>)}
      </ul>
    </section>
  );
}
