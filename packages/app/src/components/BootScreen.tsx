import type { BootReadiness } from "../lib/bootReadiness";
import { BOOT_COPY } from "../lib/bootReadiness";
import { BOOT_BODY_COPY } from "../lib/loadingStates";
import { BrandLogo } from "./BrandLogo";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

/**
 * Ecrã de arranque — apresentação de um facto já derivado por
 * `lib/bootReadiness`. Este componente NÃO decide se o arranque acabou: recebe
 * `readiness` e desenha só o que é verdade no estado recebido.
 *
 * Duas regras visuais que vêm do contrato:
 *   · Em UNKNOWN não há passos, spinner nem verde: o tempo esgotou-se sem
 *     confirmação, e continuar é um clique explícito («Continuar para o painel»)
 *     com a limitação escrita ao lado.
 *   · A copy do arranque vive numa só fonte (`BOOT_BODY_COPY`), como o resto da
 *     linguagem de estados.
 *
 * A moldura (auth-page, logo, título, subtítulo) é a mesma de
 * `AuthLoadingScreen`: sessão e arranque lêem-se como um único ecrã.
 */

export interface BootStep {
  label: string;
  status: "done" | "active" | "pending";
}

export interface BootScreenProps {
  readiness: BootReadiness;
  steps: BootStep[];
  /** Entrada explícita em modo limitado — só oferecida em UNKNOWN. */
  onEnterLimited?: () => void;
}

export function BootScreen({ readiness, steps, onEnterLimited }: BootScreenProps) {
  const unknown = readiness.state === "UNKNOWN";

  return (
    <div className="auth-page relative overflow-hidden">
      <div className="auth-bg-gradient" />
      <div className="absolute inset-0 cyber-grid opacity-20 pointer-events-none" />
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-primary/8 rounded-full blur-[150px] pointer-events-none" />

      <div className="flex flex-col items-center gap-5 w-full max-w-sm relative z-10">
        <div className="relative">
          <div className="auth-logo-icon animate-pulse">
            {/* Logótipo oficial (BrandLogo, arte final do produto), não um escudo genérico.
                Tamanho md = 40 px, igual ao que estava: dimensões e proporções preservadas.
                O escudo lucide saiu daqui; a marca vive num só sítio. */}
            <BrandLogo size="md" variant="auto" label="" />
          </div>
          <div className="absolute -inset-4 rounded-full border border-primary/20 animate-ping opacity-30" />
        </div>

        <div className="text-center">
          <h1 className="text-2xl font-bold font-mono tracking-tight text-foreground">CyberSafe</h1>
          <p className="text-[11px] text-muted-foreground font-mono mt-1 tracking-wide">Centro Inteligente de Segurança e Saúde do PC</p>
        </div>

        <p className="text-xs text-muted-foreground font-mono">{BOOT_BODY_COPY}</p>

        {!unknown && (
          <div className="w-full space-y-3 mt-1">
            {steps.map((step, i) => (
              <div key={i} className="flex items-center gap-3">
                {step.status === "done" ? (
                  <CheckCircle2 className="w-4 h-4 text-cyber-green shrink-0" />
                ) : step.status === "active" && readiness.busy ? (
                  <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
                ) : (
                  <div className="w-4 h-4 rounded-full border border-muted-foreground/30 shrink-0" />
                )}
                <span className={`text-xs font-mono transition-colors duration-300 ${
                  step.status === "done" ? "text-cyber-green" :
                  step.status === "active" && readiness.busy ? "text-foreground" :
                  "text-muted-foreground/70"
                }`}>
                  {step.label}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Região viva: o motivo do estado é anunciado uma vez, não por frame. */}
        <p
          role="status"
          aria-live="polite"
          data-boot-state={readiness.state}
          data-boot-ready={readiness.claimsReady ? "true" : "false"}
          className={`text-center text-xs font-mono ${
            unknown ? "text-foreground" : "text-muted-foreground"
          }`}
        >
          {readiness.text}
        </p>

        {unknown && (
          <div className="w-full p-3 rounded border border-border bg-secondary/40 text-muted-foreground text-xs font-mono flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
            <div className="flex-1 min-w-0">
              <p className="leading-snug">{readiness.detail}</p>
              <p className="mt-1 leading-snug opacity-90">{readiness.limitation}</p>
            </div>
          </div>
        )}

        {unknown && onEnterLimited && (
          <button
            type="button"
            onClick={onEnterLimited}
            className="px-4 py-2 bg-secondary border border-border text-foreground font-mono text-xs rounded-lg hover:bg-secondary/80 transition-all"
          >
            {BOOT_COPY.limitedEntry}
          </button>
        )}
      </div>
    </div>
  );
}

export default BootScreen;
