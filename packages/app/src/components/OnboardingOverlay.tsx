import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Shield, FileSearch, Sparkles, ArrowRight, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { markOnboardingSeen } from "../lib/onboarding";
import { MatrixAvatar } from "./MatrixAvatar";

export interface OnboardingStep {
  icon: typeof Shield;
  title: string;
  description: string;
  highlight?: string;
}

const STEPS: OnboardingStep[] = [
  {
    icon: Shield,
    title: "Proteção em tempo real",
    description:
      "O CyberSafe vigia o seu computador: processos, ficheiros, rede e estado geral. Se algo suspeito surgir, é-lhe mostrado aqui com prioridade clara.",
    highlight: "Sem promessas de \"100% protegido\" — mostramos o estado real de cada motor de segurança.",
  },
  {
    icon: FileSearch,
    title: "Análise de Segurança",
    description:
      "Analise o computador (rápida ou profundamente), um ficheiro ou uma pasta. O progresso é apresentado em tempo real, ficheiro a ficheiro.",
    highlight: "Arraste um ficheiro ou use a Análise Rápida do Computador na secção Análise de Segurança.",
  },
  {
    icon: Sparkles,
    title: "Matrix, o seu assistente",
    description:
      "Pergunte sobre o estado do seu computador em linguagem normal. A Matrix responde com base em dados reais e explica em termos simples.",
    highlight: "Clique no chat flutuante à direita para conversar a qualquer momento.",
  },
];

interface OnboardingOverlayProps {
  onDone?: () => void;
  onSkip?: () => void;
}

export function OnboardingOverlay({ onDone, onSkip }: OnboardingOverlayProps) {
  const [step, setStep] = useState(0);
  const total = STEPS.length;
  const current = STEPS[step];
  const isLast = step === total - 1;
  const Icon = current.icon;

  const finish = () => {
    markOnboardingSeen();
    onDone?.();
  };

  const skip = () => {
    markOnboardingSeen();
    onSkip?.();
  };

  const next = () => {
    if (isLast) {
      finish();
    } else {
      setStep((s) => s + 1);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/70 backdrop-blur-sm p-6">
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -16, scale: 0.97 }}
          transition={{ duration: 0.25 }}
          className="cyber-border w-full max-w-lg rounded-2xl bg-card/95 shadow-2xl overflow-hidden"
        >
          {/* Top accent line */}
          <div className="h-1 w-full bg-gradient-to-r from-primary via-primary/50 to-transparent" />

          <div className="p-8">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <MatrixAvatar mood="guide" size="sm" />
                <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
                  Boas-vindas — passo {step + 1} de {total}
                </div>
              </div>
              <button
                onClick={skip}
                aria-label="Fechar boas-vindas"
                className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center shrink-0">
                <Icon className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h2 className="font-mono font-semibold text-xl text-foreground leading-tight">
                  {current.title}
                </h2>
                <p className="text-sm text-muted-foreground mt-3 leading-relaxed">
                  {current.description}
                </p>
                {current.highlight && (
                  <p className="text-xs text-primary/90 bg-primary/5 border border-primary/15 rounded-lg px-3 py-2 mt-4 leading-relaxed">
                    {current.highlight}
                  </p>
                )}
              </div>
            </div>

            {/* Dots */}
            <div className="flex items-center gap-2 mt-8">
              {STEPS.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setStep(i)}
                  aria-label={`Ir para o passo ${i + 1}`}
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    i === step ? "bg-primary w-8" : "bg-primary/25 w-4 hover:bg-primary/40",
                  )}
                />
              ))}
            </div>

            <div className="flex items-center justify-between mt-6">
              <button
                onClick={skip}
                className="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
              >
                Agora não
              </button>
              <button
                onClick={next}
                className={cn(
                  "px-6 py-2.5 font-mono text-sm rounded-lg transition-all flex items-center gap-2",
                  isLast
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "bg-secondary text-foreground border border-border hover:bg-secondary/80",
                )}
              >
                {isLast ? (
                  <>
                    Começar <Check className="w-4 h-4" />
                  </>
                ) : (
                  <>
                    Seguinte <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}