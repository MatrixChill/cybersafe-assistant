import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Display/copy boundary only: never changes the source diagnostic or logs. */
export function redactDiagnostic(text: string): string {
  return text
    .replace(/(-----BEGIN [^-]*PRIVATE KEY-----)[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[CREDENCIAL REMOVIDA]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REMOVIDO]")
    .replace(/(["']?(?:password|passwd|palavra-passe|token|api[_-]?key|secret|authorization|credential)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;<>]+)/gi, "$1[REMOVIDO]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[CREDENCIAL REMOVIDA]")
    .replace(/\b[0-9a-f]{64}\b/gi, "[VALOR SENSÍVEL REMOVIDO]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REMOVIDO]@");
}

export function TechnicalDiagnostic({ summary, details }: { summary: string; details?: string | null }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const safeDetails = details ? redactDiagnostic(details) : null;
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText || !safeDetails) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(safeDetails);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  return (
    <div className="min-w-0 max-w-full text-xs leading-relaxed [overflow-wrap:anywhere]">
      <p className="text-muted-foreground">{redactDiagnostic(summary)}</p>
      {safeDetails && (
        <details data-testid="technical-diagnostic" className="mt-2 min-w-0 max-w-full">
          <summary className="cursor-pointer text-primary font-medium">Ver mais detalhes</summary>
          <div className="mt-2 min-w-0 max-w-full rounded-md border border-border bg-secondary/40 p-3">
            <pre tabIndex={0} aria-label="Detalhes técnicos" className="max-h-48 min-w-0 max-w-full overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] text-muted-foreground">{safeDetails}</pre>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => { void copy(); }}>Copiar detalhes</Button>
              <span role="status" className="text-xs text-muted-foreground">
                {copyState === "copied" ? "Detalhes copiados." : copyState === "failed" ? "Não foi possível copiar. Selecione o texto para o copiar manualmente." : ""}
              </span>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
