import { useMemo, useState } from "react";
import type { QuarantineEntry } from "@cybersafe/shared-types";
import { AlertCircle, Archive, RotateCcw, Trash2, ChevronDown, ChevronRight, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { quarantinePolicyLabel } from "@/lib/quarantineDisplay";

interface QuarantinePageProps {
  entries: QuarantineEntry[];
  /** Recarrega a lista a partir do serviço depois de uma ação confirmada. */
  onChanged: () => void | Promise<void>;
  /**
   * Politica EFETIVA de quarentena reportada pelo servico
   * (ProtectionStats.quarantinePolicy, P0-3). Sem valor = "desconhecido".
   */
  quarantinePolicy?: unknown;
  /**
   * Dentro da aba Quarentena de Ameaças: o cabeçalho de página e o padding
   * pertencem ao contentor-pai, aqui só interessa a lista e os seus estados.
   */
  embedded?: boolean;
}

type Pending = { id: string; action: "restore" | "delete" } | null;

const VERDICT_LABEL: Record<string, string> = {
  malicious: "Malicioso",
  suspicious: "Suspeito",
  safe: "Seguro",
  unknown: "Desconhecido",
};

function formatDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-PT");
}

/**
 * RECOVERY-SECURITY-20261014: `isolationStatus` vem do QuarantineManager e
 * so vale `confirmed` depois de destino/digest/manifest verificados. A UI
 * nao pode escrever "em quarentena desde" ao que nao esta confirmado —
 * `recovery-required` e o legado sem estado dizem-no explicitamente.
 */
function isolationLine(entry: QuarantineEntry): { text: string; warn: boolean } {
  if (entry.isolationStatus === "recovery-required") {
    return { text: "Isolamento não confirmado; recuperação necessária", warn: true };
  }
  if (entry.isolationStatus === undefined) {
    return { text: "Registo anterior; isolamento não verificado nesta versão", warn: false };
  }
  return { text: `em quarentena desde ${formatDate(entry.quarantinedAt)}`, warn: false };
}

/**
 * Gestão real da Quarentena.
 *
 * Uma decisão, uma confirmação: restaurar e eliminar são irreversíveis o
 * suficiente para nunca acontecerem num clique só. A linha só desaparece da
 * lista depois de o BACKEND confirmar (`success: true`); se o backend recusar
 * (destino ocupado, ficheiro ausente, sem permissão) a razão real é mostrada e
 * a entrada fica onde está.
 */
export default function QuarantinePage({ entries, onChanged, embedded = false, quarantinePolicy }: QuarantinePageProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [okId, setOkId] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...entries].sort((a, b) => (a.quarantinedAt < b.quarantinedAt ? 1 : -1)),
    [entries],
  );

  const run = async (entry: QuarantineEntry, action: "restore" | "delete") => {
    const api = window.electronAPI;
    setPending(null);
    setError(null);
    setOkId(null);
    if (!api) {
      setError({ id: entry.id, message: "Serviço indisponível." });
      return;
    }
    setBusyId(entry.id);
    try {
      const result =
        action === "restore"
          ? await api.restoreQuarantine(entry.id)
          : await api.deleteQuarantine(entry.id);
      if (result?.success) {
        setOkId(entry.id);
        await onChanged();
      } else {
        // O backend recusou: dizemos exatamente porquê, sem "Restaurado".
        setError({ id: entry.id, message: result?.error || "O serviço não confirmou a operação." });
      }
    } catch (err) {
      setError({ id: entry.id, message: err instanceof Error ? err.message : "Falha de comunicação com o serviço." });
    } finally {
      setBusyId(null);
    }
  };

  const total = entries.length;
  // O resumo conta POR ESTADO: chamar "isolados" a tudo era a mentira do
  // cabeçalho (RECOVERY-SECURITY-20261014).
  const counts = useMemo(
    () => ({
      confirmed: entries.filter((e) => e.isolationStatus === "confirmed").length,
      recovery: entries.filter((e) => e.isolationStatus === "recovery-required").length,
      legacy: entries.filter((e) => e.isolationStatus === undefined).length,
    }),
    [entries],
  );

  const summaryChip =
    total === 0 ? null : (
      <span className="text-xs font-mono text-muted-foreground bg-muted/40 border border-border rounded px-3 py-1.5">
        {counts.confirmed} {counts.confirmed === 1 ? "confirmado" : "confirmados"} ·{" "}
        {counts.recovery} a recuperar · {counts.legacy} por verificar
      </span>
    );

  return (
    <div className={cn("space-y-6", embedded ? "max-w-none" : "p-6 max-w-5xl mx-auto")}>
      {/* P0-3 (15/10): o estado REAL da politica de quarentena, dito pelo
          servico — visivel antes de qualquer lista. */}
      <p role="status" className={cn("text-xs font-mono", quarantinePolicyLabel(quarantinePolicy).tone === "auto" ? "text-cyber-yellow" : "text-muted-foreground")}>
        {quarantinePolicyLabel(quarantinePolicy).text}
      </p>
      {embedded ? (
        <div className="flex items-center justify-end">{summaryChip}</div>
      ) : (
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10 border border-primary/30">
            <Archive className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold font-mono text-foreground">Quarentena</h1>
            <p className="text-xs text-muted-foreground font-mono">
              Registos da quarentena. O isolamento só é afirmado quando confirmado; restaurar ou eliminar é permanente.
            </p>
          </div>
        </div>
        {summaryChip}
      </header>
      )}

      {total === 0 ? (
        <div className="cyber-border rounded-xl p-10 text-center">
          <Archive className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm font-mono text-muted-foreground">A quarentena está vazia.</p>
          <p className="text-[11px] text-muted-foreground/70 font-mono mt-1">
            Os ficheiros removidos por uma deteção aparecem aqui.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {sorted.map((entry) => {
            const verdictLabel = VERDICT_LABEL[entry.verdict] ?? entry.verdict;
            const risky = entry.verdict === "malicious" || entry.verdict === "suspicious";
            const isolation = isolationLine(entry);

            return (
              <li key={entry.id} className="cyber-border rounded-xl bg-card/60 overflow-hidden">
                <div className="p-4 flex items-start gap-3">
                  <button
                    onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                    className="mt-0.5 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={expanded === entry.id ? "Fechar detalhes" : "Ver detalhes"}
                  >
                    {expanded === entry.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-foreground font-mono truncate">{entry.fileName}</span>
                      <span
                        className={cn(
                          "text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border",
                          risky
                            ? "text-cyber-red border-cyber-red/40 bg-cyber-red/10"
                            : "text-muted-foreground border-border bg-muted/30",
                        )}
                      >
                        {verdictLabel}
                        {typeof entry.riskScore === "number" ? ` · risco ${entry.riskScore}` : ""}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground font-mono mt-1 truncate" title={entry.originalPath}>
                      {entry.originalPath}
                    </p>
                    <p className={cn("text-[10px] font-mono mt-0.5", isolation.warn ? "text-cyber-red" : "text-muted-foreground")}>
                      {isolation.text}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      disabled={busyId !== null}
                      onClick={() => { setError(null); setPending({ id: entry.id, action: "restore" }); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono rounded-lg border border-border hover:border-primary hover:text-primary transition-colors disabled:opacity-40"
                    >
                      <RotateCcw className="w-3.5 h-3.5" /> Restaurar
                    </button>
                    <button
                      disabled={busyId !== null}
                      onClick={() => { setError(null); setPending({ id: entry.id, action: "delete" }); }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono rounded-lg border border-cyber-red/40 text-cyber-red hover:bg-cyber-red/10 transition-colors disabled:opacity-40"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Eliminar
                    </button>
                  </div>
                </div>

                {expanded === entry.id && (
                  <div className="px-4 pb-4 pt-0 border-t border-border/40 mt-1">
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-[11px] font-mono pt-3">
                      <div className="flex flex-col">
                        <dt className="text-muted-foreground/70">Caminho original</dt>
                        <dd className="text-foreground break-all">{entry.originalPath}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Ficheiro em quarentena</dt>
                        <dd className="text-foreground break-all">{entry.quarantinePath}</dd>
                      </div>
                      {entry.detectionReason && (
                        <div>
                          <dt className="text-muted-foreground">Motivo da deteção</dt>
                          <dd className="text-foreground">{entry.detectionReason}</dd>
                        </div>
                      )}
                      {entry.engine && (
                        <div>
                          <span className="text-muted-foreground">Motor: </span>
                          <span className="text-foreground">{entry.engine}</span>
                        </div>
                      )}
                      <div>
                        <span className="text-muted-foreground">SHA-256: </span>
                        <span className="text-foreground break-all">{entry.sha256 || "não disponível"}</span>
                      </div>
                      {entry.restoredAt && (
                        <div>
                          <span className="text-muted-foreground">Restaurado: </span>
                          <span className="text-foreground">
                            {formatDate(entry.restoredAt)}
                            {entry.restoredBy ? ` por ${entry.restoredBy}` : ""}
                          </span>
                        </div>
                      )}
                    </dl>
                  </div>
                )}

                {pending?.id === entry.id && (
                  <div
                    className={cn(
                      "px-4 py-3 border-t flex items-center justify-between gap-3",
                      pending.action === "delete"
                        ? "border-cyber-red/30 bg-cyber-red/5"
                        : "border-primary/30 bg-primary/5",
                    )}
                  >
                    <p className="text-xs font-mono text-foreground">
                      {pending.action === "delete"
                        ? "Eliminar permanentemente? Esta ação é irreversível."
                        : "Restaurar este ficheiro para o local original?"}
                    </p>
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => setPending(null)}
                        className="px-3 py-1.5 text-xs font-mono rounded-lg border border-border hover:bg-muted/30 transition-colors"
                      >
                        Cancelar
                      </button>
                      <button
                        onClick={() => void run(entry, pending.action)}
                        className={cn(
                          "px-3 py-1.5 text-xs font-mono rounded-lg text-primary-foreground transition-colors",
                          pending.action === "delete" ? "bg-cyber-red hover:bg-cyber-red/90" : "bg-primary hover:bg-primary/90",
                        )}
                      >
                        {pending.action === "delete" ? "Eliminar" : "Restaurar"}
                      </button>
                    </div>
                  </div>
                )}

                {busyId === entry.id && (
                  <div className="px-4 py-2 border-t border-border/30 flex items-center gap-2 text-xs font-mono text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> A comunicar com o serviço...
                  </div>
                )}

                {error?.id === entry.id && (
                  <div className="px-4 py-3 border-t border-destructive/40 bg-destructive/10 flex items-start gap-2 text-xs font-mono text-destructive">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{error.message}</span>
                  </div>
                )}

                {okId === entry.id && (
                  <div className="px-4 py-2 border-t border-cyber-green/40 bg-cyber-green/10 flex items-center gap-2 text-xs font-mono text-cyber-green">
                    <CheckCircle2 className="w-4 h-4" /> Operação confirmada pelo serviço.
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}