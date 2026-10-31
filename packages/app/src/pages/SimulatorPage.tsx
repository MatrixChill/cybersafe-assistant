import { getAuthToken } from "../lib/authSession";
import { Shield, ExternalLink, CheckCircle2, XCircle, Trophy, RotateCcw, ArrowRight, Sparkles, Star, Target } from "lucide-react"
import { useState, useEffect } from "react"
import { TRAINING_SCENARIOS, type TrainingScenario } from "@cybersafe/shared-types"
import { cn } from "@/lib/utils"
import { MatrixAvatar } from "../components/MatrixAvatar"

type Answer = "safe" | "dangerous" | null

interface ScenarioResult {
  scenario: TrainingScenario
  userAnswer: Answer
  correct: boolean
}

// S3: a API local só escuta em loopback IPv4 e /api/training-score é uma rota
// privada. 127.0.0.1 (nunca "localhost", que pode resolver para ::1) e o token
// da sessão lido do armazenamento local, sem credenciais no código.
//
// A porta NÃO é fixa: o runner publica a base isolada da sessão em
// `window.__CYBERSAFE_API_BASE__` (o mesmo preload que AuthContext/AIAssistant
// usam). Hardcodar 4000 fazia a leitura/gravação falhar em silêncio nas sessões
// isoladas (p. ex. 4100).
export function simulatorApiBase(
  win: { __CYBERSAFE_API_BASE__?: string } | undefined = typeof window !== "undefined"
    ? (window as unknown as { __CYBERSAFE_API_BASE__?: string })
    : undefined,
): string {
  const publicado = typeof win?.__CYBERSAFE_API_BASE__ === "string"
    ? win.__CYBERSAFE_API_BASE__.trim()
    : "";
  return (publicado || "http://127.0.0.1:4000").replace(/\/+$/, "")
}
/**
 * O placar do cenário: acertos sobre o TOTAL do desafio.
 *
 * Antes era `score/currentIndex + (respondida ? 1 : 0)`: no primeiro cenário,
 * antes de responder, o ecrã mostrava «0/0» — uma fração sem denominador, ou
 * seja um zero por ausência de resposta apresentado como medição. O total do
 * desafio é conhecido desde o início, por isso é ele o denominador; sem
 * cenários não há placar nenhum e diz-se «—».
 */
export function placarCenarios(acertos: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "—";
  const seguros = Number.isFinite(acertos) ? Math.max(0, Math.min(acertos, total)) : 0;
  return `${seguros}/${total}`;
}



function authHeaders(): Record<string, string> {
  try {
    const token = getAuthToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch {
    return {}
  }
}

export default function SimulatorPage() {
  const [gameState, setGameState] = useState<"menu" | "playing" | "result">("menu")
  const [currentIndex, setCurrentIndex] = useState(0)
  const [selectedAnswer, setSelectedAnswer] = useState<Answer>(null)
  const [showExplanation, setShowExplanation] = useState(false)
  const [results, setResults] = useState<ScenarioResult[]>([])
  const [pastScores, setPastScores] = useState<{ score: number; completedAt: string }[]>([])
  const [scenarios, setScenarios] = useState<TrainingScenario[]>([])

  // Load past scores
  useEffect(() => {
    fetch(`${simulatorApiBase()}/api/training-score`, { headers: authHeaders() })
      .then(r => r.json())
      .then(data => {
        if (data.recentResults) setPastScores(data.recentResults.slice(0, 5))
      })
      .catch(() => {})
  }, [gameState])

  const startGame = () => {
    // Shuffle scenarios and pick 6
    const shuffled = [...TRAINING_SCENARIOS].sort(() => Math.random() - 0.5)
    setScenarios(shuffled.slice(0, 6))
    setCurrentIndex(0)
    setResults([])
    setSelectedAnswer(null)
    setShowExplanation(false)
    setGameState("playing")
  }

  const handleAnswer = (answer: Answer) => {
    if (selectedAnswer || !answer) return
    setSelectedAnswer(answer)

    const scenario = scenarios[currentIndex]
    const correct = (answer === "safe" && scenario.isSafe) || (answer === "dangerous" && !scenario.isSafe)
    
    setResults(prev => [...prev, { scenario, userAnswer: answer, correct }])
    
    // Show explanation after a short delay
    setTimeout(() => setShowExplanation(true), 400)
  }

  const nextScenario = () => {
    if (currentIndex + 1 >= scenarios.length) {
      const finalCorrect = results.filter(r => r.correct).length
      
      fetch(`${simulatorApiBase()}/api/training-score`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ correctCount: finalCorrect, totalCount: scenarios.length }),
      }).catch(() => {})

      setGameState("result")
    } else {
      setCurrentIndex(prev => prev + 1)
      setSelectedAnswer(null)
      setShowExplanation(false)
    }
  }

  const score = results.filter(r => r.correct).length
  const total = scenarios.length
  const percentage = total > 0 ? Math.round((score / total) * 100) : 0

  // ── MENU SCREEN ──
  if (gameState === "menu") {
    return (
      <div className="p-8 space-y-8 animate-in fade-in duration-500">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">
            Simulador de <span className="text-primary">Phishing</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Treina a tua capacidade de identificar ligações perigosas
          </p>
        </div>

        {/* Hero Card */}
        <div className="cyber-border rounded-xl p-8 text-center relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-cyber-cyan/5 pointer-events-none" />

          {/* Matrix guide */}
          <div className="flex items-center gap-4 text-left mb-6 p-4 rounded-xl bg-black/20 border border-border">
            <MatrixAvatar mood="guide" size="sm" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              <span className="font-mono text-primary font-bold">Matrix</span>: "Vou treinar contigo! Lembra-te: desconfia de domínios estranhos, falta de HTTPS e pedidos urgentes de login. Boa sorte!"
            </p>
          </div>

          <div className="w-20 h-20 rounded-2xl bg-primary/10 border border-primary/30 flex items-center justify-center mx-auto mb-6">
            <Target className="w-10 h-10 text-primary" />
          </div>
          
          <h2 className="text-xl font-bold font-mono text-foreground mb-3">
            Desafio de Identificação de Phishing
          </h2>
          <p className="text-sm text-muted-foreground max-w-lg mx-auto mb-8 leading-relaxed">
            Vais receber 6 URLs reais para analisar. Em cada uma, decide se é
            <span className="text-cyber-green font-semibold"> segura</span> ou 
            <span className="text-cyber-red font-semibold"> perigosa</span>. 
            Depois de cada resposta, recebes uma explicação detalhada.
          </p>

          <button
            onClick={startGame}
            className="px-8 py-3 bg-primary text-primary-foreground font-mono text-sm rounded-lg hover:bg-primary/90 transition-all cyber-glow inline-flex items-center gap-2"
          >
            <Sparkles className="w-4 h-4" />
            Iniciar Desafio
          </button>

          <div className="grid grid-cols-3 gap-4 mt-8 max-w-sm mx-auto">
            <div className="text-center">
              <div className="text-2xl font-bold font-mono text-primary">6</div>
              <div className="text-[10px] font-mono text-muted-foreground uppercase">Cenários</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold font-mono text-cyber-yellow">~3min</div>
              <div className="text-[10px] font-mono text-muted-foreground uppercase">Duração</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold font-mono text-cyber-green">Educativo</div>
              <div className="text-[10px] font-mono text-muted-foreground uppercase">Objetivo</div>
            </div>
          </div>
        </div>

        {/* Past Scores */}
        {pastScores.length > 0 && (
          <div className="cyber-border rounded-xl p-6">
            <h3 className="font-mono font-semibold text-foreground flex items-center gap-2 mb-4">
              <Trophy className="w-4 h-4 text-cyber-yellow" />
              Os teus resultados anteriores
            </h3>
            <div className="space-y-2">
              {pastScores.map((s, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-secondary/30 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      "w-8 h-8 rounded-lg flex items-center justify-center border",
                      s.score >= 80 ? "bg-cyber-green/10 border-cyber-green/30" : s.score >= 50 ? "bg-cyber-yellow/10 border-cyber-yellow/30" : "bg-cyber-red/10 border-cyber-red/30"
                    )}>
                      <Star className={cn("w-4 h-4", s.score >= 80 ? "text-cyber-green" : s.score >= 50 ? "text-cyber-yellow" : "text-cyber-red")} />
                    </div>
                    <span className="text-xs font-mono text-muted-foreground">
                      {new Date(s.completedAt).toLocaleDateString("pt-PT")}
                    </span>
                  </div>
                  <span className={cn(
                    "text-lg font-bold font-mono",
                    s.score >= 80 ? "text-cyber-green" : s.score >= 50 ? "text-cyber-yellow" : "text-cyber-red"
                  )}>
                    {s.score}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Info Card */}
        <div className="cyber-border rounded-xl p-6 bg-primary/5">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0">
              <Shield className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h4 className="font-mono font-semibold text-foreground mb-1">
                Sobre o Simulador
              </h4>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Este simulador educativo utiliza cenários reais de phishing para ensinar a identificar 
                URLs maliciosas. Aprende a reconhecer domínios lookalike, falta de HTTPS, 
                engenharia social e outros padrões de ataque.
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── PLAYING SCREEN ──
  if (gameState === "playing") {
    const scenario = scenarios[currentIndex]
    const isCorrect = selectedAnswer 
      ? (selectedAnswer === "safe" && scenario.isSafe) || (selectedAnswer === "dangerous" && !scenario.isSafe)
      : null

    return (
      <div className="p-8 space-y-8 animate-in fade-in duration-300">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold font-mono tracking-tight">
              Cenário <span className="text-primary">{currentIndex + 1}/{scenarios.length}</span>
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              Analisa o URL e decide se é seguro ou perigoso
            </p>
          </div>
          
          {/* Progress */}
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              {scenarios.map((_, i) => (
                <div 
                  key={i}
                  className={cn(
                    "w-3 h-3 rounded-full transition-all",
                    i < currentIndex ? (results[i]?.correct ? "bg-cyber-green" : "bg-cyber-red") :
                    i === currentIndex ? "bg-primary cyber-pulse" : "bg-secondary"
                  )}
                />
              ))}
            </div>
            <span className="text-sm font-mono text-muted-foreground tabular-nums">
              {placarCenarios(score, scenarios.length)}
            </span>
          </div>
        </div>

        {/* URL Card */}
        <div className={cn(
          "cyber-border rounded-xl p-8 transition-all relative overflow-hidden",
          selectedAnswer && (isCorrect ? "border-cyber-green/50" : "border-cyber-red/50")
        )}>
          {/* Result overlay */}
          {selectedAnswer && (
            <div className={cn(
              "absolute top-0 left-0 right-0 h-1",
              isCorrect ? "bg-cyber-green" : "bg-cyber-red"
            )} />
          )}

          <div className="flex items-start gap-4 mb-6">
            <div className={cn(
              "w-12 h-12 rounded-xl flex items-center justify-center border",
              selectedAnswer 
                ? isCorrect ? "bg-cyber-green/10 border-cyber-green/30" : "bg-cyber-red/10 border-cyber-red/30"
                : "bg-primary/10 border-primary/30"
            )}>
              <ExternalLink className={cn(
                "w-6 h-6",
                selectedAnswer 
                  ? isCorrect ? "text-cyber-green" : "text-cyber-red"
                  : "text-primary"
              )} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">URL para Analisar</div>
              <div className="p-3 bg-black/30 rounded-lg border border-border/50 overflow-x-auto">
                <code className="text-sm font-mono text-foreground break-all">{scenario.url}</code>
              </div>
            </div>
          </div>

          <p className="text-sm text-foreground leading-relaxed mb-6 pl-16">
            {scenario.description}
          </p>

          {/* Answer Buttons */}
          {!selectedAnswer && (
            <div className="grid grid-cols-2 gap-4 pl-16">
              <button
                onClick={() => handleAnswer("safe")}
                className="p-4 rounded-xl border-2 border-cyber-green/30 bg-cyber-green/5 hover:bg-cyber-green/10 hover:border-cyber-green/60 transition-all group"
              >
                <div className="flex items-center justify-center gap-3">
                  <CheckCircle2 className="w-6 h-6 text-cyber-green group-hover:scale-110 transition-transform" />
                  <span className="font-mono font-semibold text-cyber-green">SEGURO</span>
                </div>
              </button>
              
              <button
                onClick={() => handleAnswer("dangerous")}
                className="p-4 rounded-xl border-2 border-cyber-red/30 bg-cyber-red/5 hover:bg-cyber-red/10 hover:border-cyber-red/60 transition-all group"
              >
                <div className="flex items-center justify-center gap-3">
                  <XCircle className="w-6 h-6 text-cyber-red group-hover:scale-110 transition-transform" />
                  <span className="font-mono font-semibold text-cyber-red">PERIGOSO</span>
                </div>
              </button>
            </div>
          )}

          {/* Result Feedback */}
          {selectedAnswer && (
            <div className={cn(
              "ml-16 p-4 rounded-xl border animate-in fade-in slide-in-from-bottom-4 duration-500",
              isCorrect ? "bg-cyber-green/5 border-cyber-green/30" : "bg-cyber-red/5 border-cyber-red/30"
            )}>
              <div className="flex items-center gap-2 mb-2">
                {isCorrect ? (
                  <CheckCircle2 className="w-5 h-5 text-cyber-green" />
                ) : (
                  <XCircle className="w-5 h-5 text-cyber-red" />
                )}
                <span className={cn(
                  "font-mono font-bold text-sm",
                  isCorrect ? "text-cyber-green" : "text-cyber-red"
                )}>
                  {isCorrect ? "Correto!" : "Incorreto!"}
                </span>
                <span className="text-xs font-mono text-muted-foreground ml-2">
                  Este site é {scenario.isSafe ? "SEGURO" : "PERIGOSO"}
                </span>
              </div>
              
              {showExplanation && (
                <p className="text-sm text-muted-foreground leading-relaxed mt-2 animate-in fade-in duration-300">
                  {scenario.explanation}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Next Button */}
        {selectedAnswer && showExplanation && (
          <div className="flex justify-end animate-in fade-in slide-in-from-bottom-2 duration-300">
            <button
              onClick={nextScenario}
              className="flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-mono text-sm rounded-lg hover:bg-primary/90 transition-all cyber-glow"
            >
              {currentIndex + 1 >= scenarios.length ? "Ver Resultado" : "Próximo Cenário"}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    )
  }

  // ── RESULT SCREEN ──
  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tight">
          Resultado <span className="text-primary">Final</span>
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Vê como te saíste no desafio de phishing
        </p>
      </div>

      {/* Score Card */}
      <div className="cyber-border rounded-xl p-8 text-center relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-cyber-cyan/5 pointer-events-none" />
        
        <div className={cn(
          "w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 border-4",
          percentage >= 80 ? "border-cyber-green bg-cyber-green/10" : 
          percentage >= 50 ? "border-cyber-yellow bg-cyber-yellow/10" : 
          "border-cyber-red bg-cyber-red/10"
        )}>
          <span className={cn(
            "text-3xl font-bold font-mono",
            percentage >= 80 ? "text-cyber-green" : percentage >= 50 ? "text-cyber-yellow" : "text-cyber-red"
          )}>
            {percentage}%
          </span>
        </div>
        
        <h2 className="text-xl font-bold font-mono text-foreground mb-2">
          {percentage >= 80 ? "Excelente! 🎉" : percentage >= 50 ? "Bom trabalho! 👍" : "Continua a praticar 💪"}
        </h2>
        <p className="text-sm text-muted-foreground mb-6">
          Acertaste <span className="text-primary font-bold">{score}</span> de <span className="text-primary font-bold">{total}</span> cenários
        </p>

        {/* Score Bar */}
        <div className="max-w-xs mx-auto">
          <div className="h-3 bg-secondary rounded-full overflow-hidden">
            <div 
              className={cn(
                "h-full transition-all duration-1000 progress-glow",
                percentage >= 80 ? "bg-cyber-green" : percentage >= 50 ? "bg-cyber-yellow" : "bg-cyber-red"
              )}
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>
      </div>

      {/* Detailed Results */}
      <div className="cyber-border rounded-xl p-6">
        <h3 className="font-mono font-semibold text-foreground mb-4 flex items-center gap-2">
          <Target className="w-4 h-4 text-primary" />
          Detalhes por Cenário
        </h3>
        <div className="space-y-3">
          {results.map((r, i) => (
            <div key={i} className={cn(
              "p-4 rounded-lg border transition-colors",
              r.correct ? "bg-cyber-green/5 border-cyber-green/20" : "bg-cyber-red/5 border-cyber-red/20"
            )}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  {r.correct ? (
                    <CheckCircle2 className="w-5 h-5 text-cyber-green shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-5 h-5 text-cyber-red shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0">
                    <code className="text-xs font-mono text-foreground break-all block">{r.scenario.url}</code>
                    <p className="text-[11px] text-muted-foreground mt-1">{r.scenario.explanation}</p>
                  </div>
                </div>
                <span className={cn(
                  "text-[10px] font-mono uppercase px-2 py-1 rounded shrink-0",
                  r.scenario.isSafe ? "bg-cyber-green/10 text-cyber-green" : "bg-cyber-red/10 text-cyber-red"
                )}>
                  {r.scenario.isSafe ? "Seguro" : "Perigoso"}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-center gap-4">
        <button
          onClick={() => setGameState("menu")}
          className="flex items-center gap-2 px-6 py-3 bg-secondary text-foreground font-mono text-sm rounded-lg hover:bg-secondary/80 transition-all"
        >
          <RotateCcw className="w-4 h-4" />
          Voltar ao Menu
        </button>
        <button
          onClick={startGame}
          className="flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-mono text-sm rounded-lg hover:bg-primary/90 transition-all cyber-glow"
        >
          <Sparkles className="w-4 h-4" />
          Jogar Novamente
        </button>
      </div>
    </div>
  )
}
