import { useEffect, useState } from "react";
import { X, ShieldAlert } from "lucide-react";
import type {
  EngineHealth,
  EngineSubsystemHealth,
  EngineSubsystemStatus,
} from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";
import { levelMeta, type ProtectionLevel } from "../lib/protectionHealth";

interface ProtectionDetailsProps {
  engine?: EngineHealth;
  level: ProtectionLevel;
  open: boolean;
  onClose: () => void;
  /** Pontuação de proteção (0–100) mostrada no Dashboard — mesma fonte. */
  score?: number;
}

const ENGINE_ROWS: { key: "yara" | "hashDb" | "clamav" | "nativeEngine" | "firewall"; label: string }[] = [
  { key: "yara", label: "YARA" },
  { key: "hashDb", label: "Hash DB" },
  { key: "clamav", label: "ClamAV" },
  { key: "nativeEngine", label: "Native Engine" },
  { key: "firewall", label: "Firewall" },
];

const STATUS_META: Record<EngineSubsystemStatus, { text: string; cls: string }> = {
  active: { text: "ACTIVE", cls: "text-success border-success/40 bg-success/10" },
  degraded: { text: "DEGRADED", cls: "text-warning border-warning/40 bg-warning/10" },
  unavailable: { text: "UNAVAILABLE", cls: "text-muted-foreground border-border bg-secondary/40" },
  error: { text: "ERROR", cls: "text-danger border-danger/40 bg-danger/10" },
};

/**
 * Explicação da pontuação com os pesos REAIS do backend.
 * Espelha exatamente `effectiveRiskScore()` (@cybersafe/core):
 * risco efetivo = max(ameaças recentes, piso por motores de análise ativos),
 * piso = 75 (0 ativos) | 45 (1–2 ativos) | 20 (3–4 com algum degraded) | 0.
 * Pontuação apresentada = 100 − risco efetivo.
 */
const CORE_ENGINES: (keyof EngineHealth)[] = ["yara", "hashDb", "clamav", "nativeEngine"];

function explainScore(engine: EngineHealth | undefined, score: number) {
  const reported = CORE_ENGINES
    .map((key) => engine?.[key])
    .filter((sub): sub is EngineSubsystemHealth => !!sub);
  const active = reported.filter((sub) => sub.status === "active").length;
  const total = reported.length > 0 ? reported.length : CORE_ENGINES.length;
  const hasDegraded = reported.some((sub) => sub.status === "degraded");
  const riskFloor = active === 0 ? 75 : active <= 2 ? 45 : hasDegraded ? 20 : 0;
  const maxPossible = 100 - riskFloor;
  const threatPenalty = Math.max(0, maxPossible - score);
  return { active, total, maxPossible, threatPenalty };
}

/** Um clique no estado geral abre os PROTECTION DETAILS. */
export default function ProtectionDetails({ engine, level, open, onClose, score }: ProtectionDetailsProps) {
  const [technical, setTechnical] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const meta = levelMeta(level);
  const reasons = engine?.degradedReasons ?? [];
  const scoreInfo = typeof score === "number" ? explainScore(engine, score) : null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="cyber-border rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto bg-card p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center shrink-0">
              <ShieldAlert className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h3 className="font-mono font-bold text-foreground">Estado da Proteção</h3>
              <p className="text-xs text-muted-foreground">Informação de saúde dos motores</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
            aria-label="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Linguagem simples (utilizador comum) */}
        <div className={cn("mt-5 p-4 rounded-xl border", meta.chipClass)}>
          <p className={cn("text-sm font-mono font-semibold uppercase tracking-wider", meta.textClass)}>
            {meta.label}
          </p>
          <p className="text-sm text-foreground mt-1 leading-relaxed">{meta.summary}</p>
        </div>

        {/* Explicação da pontuação — usa os pesos reais do backend (effectiveRiskScore). */}
        {scoreInfo && (
          <div className="mt-4 p-4 rounded-xl border border-border bg-secondary/30">
            <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Porquê {score}/100?
            </p>
            <ul className="mt-2 space-y-1.5 text-sm text-foreground">
              <li>• Motores de análise ativos: <b>{scoreInfo.active} de {scoreInfo.total}</b>.</li>
              <li>• Com {scoreInfo.active} ativo(s), a pontuação máxima possível é <b>{scoreInfo.maxPossible}/100</b>.</li>
              {scoreInfo.threatPenalty > 0 ? (
                <li>• Ameaças recentes reduziram a pontuação em mais <b>{scoreInfo.threatPenalty}</b> pontos.</li>
              ) : (
                <li>• Nenhuma ameaça recente reduziu a pontuação — o limite vem dos componentes indisponíveis.</li>
              )}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
              A pontuação é 100 menos o risco efetivo: o maior valor entre as ameaças recentes
              e o piso de confiança definido pelos motores de análise ativos.
            </p>
          </div>
        )}

        <button
          onClick={() => setTechnical((v) => !v)}
          className="mt-4 px-4 py-2 rounded-lg text-xs font-mono uppercase tracking-wider bg-secondary hover:bg-secondary/70 text-secondary-foreground transition-colors"
        >
          {technical ? "Ocultar detalhes técnicos" : "Ver detalhes técnicos"}
        </button>

        {technical && (
          <div className="mt-4 space-y-2">
            {ENGINE_ROWS.map(({ key, label }) => {
              const sub = engine?.[key];
              const status: EngineSubsystemStatus = sub?.status ?? "unavailable";
              const detail = sub?.detail;
              return (
                <div key={key} className="flex items-center justify-between p-3 rounded-lg bg-secondary/40 border border-border">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-foreground">{label}</span>
                    {detail && (
                      <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[180px]">— {detail}</span>
                    )}
                  </div>
                  <span className={cn("text-[10px] font-mono uppercase px-2 py-1 rounded border", STATUS_META[status].cls)}>
                    {STATUS_META[status].text}
                  </span>
                </div>
              );
            })}

            {reasons.length > 0 && (
              <div className="mt-4 p-3 rounded-lg bg-danger/5 border border-danger/20">
                <p className="text-[10px] font-mono uppercase tracking-wider text-danger mb-2">Motivos da degradação</p>
                <ul className="space-y-1">
                  {reasons.map((reason, i) => (
                    <li key={i} className="text-xs font-mono text-muted-foreground">• {reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}