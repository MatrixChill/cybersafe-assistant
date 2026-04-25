import { 
  FileWarning, AlertTriangle, ArrowRight, 
  CheckCircle, XCircle, Trophy, Target, Key,  
  Zap, Brain, GraduationCap
} from "lucide-react"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { 
  PASSWORD_CHALLENGES, ATTACHMENT_CHALLENGES, 
  DECISION_SCENARIOS, ALERT_RESPONSE_SCENARIOS
} from "@cybersafe/shared-types"

type GameType = "menu" | "password" | "attachments" | "decisions" | "alerts"

interface PasswordGameState {
  currentIndex: number
  showAnswer: boolean
  score: number
  answers: boolean[]
}

interface AttachmentGameState {
  currentIndex: number
  showAnswer: boolean
  score: number
  answers: boolean[]
}

interface DecisionGameState {
  currentIndex: number
  showAnswer: boolean
  score: number
  answers: boolean[]
}

interface AlertGameState {
  currentIndex: number
  showAnswer: boolean
  score: number
  answers: boolean[]
}

export default function EducationalGamesPage() {
  const [gameType, setGameType] = useState<GameType>("menu")
  
  const [passwordState, setPasswordState] = useState<PasswordGameState>({
    currentIndex: 0, showAnswer: false, score: 0, answers: []
  })
  const [attachmentState, setAttachmentState] = useState<AttachmentGameState>({
    currentIndex: 0, showAnswer: false, score: 0, answers: []
  })
  const [decisionState, setDecisionState] = useState<DecisionGameState>({
    currentIndex: 0, showAnswer: false, score: 0, answers: []
  })
  const [alertState, setAlertState] = useState<AlertGameState>({
    currentIndex: 0, showAnswer: false, score: 0, answers: []
  })

  const resetPasswordGame = () => {
    setPasswordState({ currentIndex: 0, showAnswer: false, score: 0, answers: [] })
  }
  const resetAttachmentGame = () => {
    setAttachmentState({ currentIndex: 0, showAnswer: false, score: 0, answers: [] })
  }
  const resetDecisionGame = () => {
    setDecisionState({ currentIndex: 0, showAnswer: false, score: 0, answers: [] })
  }
  const resetAlertGame = () => {
    setAlertState({ currentIndex: 0, showAnswer: false, score: 0, answers: [] })
  }

  const goToMenu = () => {
    setGameType("menu")
  }

  if (gameType === "menu") {
    return <GameMenu onSelectGame={setGameType} />
  }

  if (gameType === "password") {
    return (
      <PasswordGame 
        state={passwordState} 
        setState={setPasswordState}
        onBack={goToMenu}
        onRestart={resetPasswordGame}
      />
    )
  }

  if (gameType === "attachments") {
    return (
      <AttachmentGame 
        state={attachmentState} 
        setState={setAttachmentState}
        onBack={goToMenu}
        onRestart={resetAttachmentGame}
      />
    )
  }

  if (gameType === "decisions") {
    return (
      <DecisionGame 
        state={decisionState} 
        setState={setDecisionState}
        onBack={goToMenu}
        onRestart={resetDecisionGame}
      />
    )
  }

  if (gameType === "alerts") {
    return (
      <AlertResponseGame 
        state={alertState} 
        setState={setAlertState}
        onBack={goToMenu}
        onRestart={resetAlertGame}
      />
    )
  }

  return null
}

function GameMenu({ onSelectGame }: { onSelectGame: (game: GameType) => void }) {
  const games = [
    { id: "password" as GameType, icon: Key, title: "Fortaleza de Senhas", desc: "Teste a força das senhas e aprenda a criar senhas seguras", color: "cyan", count: PASSWORD_CHALLENGES.length },
    { id: "attachments" as GameType, icon: FileWarning, title: "Ameaças Ocultas", desc: "Identifique arquivos perigosos只看表面", color: "red", count: ATTACHMENT_CHALLENGES.length },
    { id: "decisions" as GameType, icon: Brain, title: "Decisões Críticas", desc: "Escolha a melhor ação em situações de risco", color: "yellow", count: DECISION_SCENARIOS.length },
    { id: "alerts" as GameType, icon: AlertTriangle, title: "Resposta a Alertas", desc: "Aprenda a responder corretamente aos avisos do antivírus", color: "purple", count: ALERT_RESPONSE_SCENARIOS.length },
  ]

  const colors: Record<string, string> = {
    cyan: "text-cyber-cyan border-cyber-cyan/30 bg-cyber-cyan/5 hover:bg-cyber-cyan/10",
    red: "text-cyber-red border-cyber-red/30 bg-cyber-red/5 hover:bg-cyber-red/10",
    yellow: "text-cyber-yellow border-cyber-yellow/30 bg-cyber-yellow/5 hover:bg-cyber-yellow/10",
    purple: "text-primary border-primary/30 bg-primary/5 hover:bg-primary/10"
  }

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tight">
          Jogos <span className="text-primary">Educativos</span>
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Aprenda segurança digital de forma interativa e divertida
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {games.map((game) => (
          <button
            key={game.id}
            onClick={() => onSelectGame(game.id)}
            className={cn(
              "cyber-border rounded-xl p-6 text-left transition-all group hover:scale-[1.02]",
              colors[game.color]
            )}
          >
            <div className="flex items-start gap-4">
              <div className={cn(
                "w-14 h-14 rounded-xl flex items-center justify-center shrink-0 border",
                colors[game.color]
              )}>
                <game.icon className="w-7 h-7" />
              </div>
              <div className="flex-1">
                <h3 className="font-mono font-semibold text-foreground mb-2 flex items-center gap-2">
                  {game.title}
                  <ArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {game.desc}
                </p>
                <div className="mt-3 flex items-center gap-2 text-xs font-mono text-muted-foreground">
                  <Target className="w-3 h-3" />
                  {game.count} desafios
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="cyber-border rounded-xl p-6 bg-primary/5">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-lg bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0">
            <GraduationCap className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h4 className="font-mono font-semibold text-foreground mb-1">
              Aprenda Brincando
            </h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Estes jogos são projetados para melhorar sua compreensão sobre segurança digital. 
              Cada jogo foca em uma skill diferente: criação de senhas, identificação de arquivos perigosos, 
              tomada de decisões seguras e resposta a alertas. Complete todos para se tornar um experto em segurança!
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function PasswordGame({ 
  state, setState, onBack, onRestart 
}: { 
  state: PasswordGameState
  setState: React.Dispatch<React.SetStateAction<PasswordGameState>>
  onBack: () => void
  onRestart: () => void
}) {
  const challenge = PASSWORD_CHALLENGES[state.currentIndex]
  const total = PASSWORD_CHALLENGES.length
  const progress = ((state.currentIndex) / total) * 100

  const handleAnswer = (isStrong: boolean) => {
    const correct = (isStrong && challenge.strength === "strong") || (!isStrong && challenge.strength !== "strong")
    const newScore = correct ? state.score + 1 : state.score
    setState(prev => ({
      ...prev,
      score: newScore,
      showAnswer: true,
      answers: [...prev.answers, correct]
    }))
  }

  const next = () => {
    setState(prev => ({
      currentIndex: prev.currentIndex + 1,
      showAnswer: false,
      score: prev.score,
      answers: prev.answers
    }))
  }

  if (state.currentIndex >= total) {
    const percentage = Math.round((state.score / total) * 100)
    return (
      <div className="p-8 space-y-8">
        <div className="flex items-center justify-between">
          <button onClick={onBack} className="text-muted-foreground hover:text-foreground">← Voltar</button>
        </div>
        <div className="cyber-border rounded-xl p-8 text-center">
          <div className={cn(
            "w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 border-4",
            percentage >= 80 ? "border-cyber-green bg-cyber-green/10" : 
            percentage >= 50 ? "border-cyber-yellow bg-cyber-yellow/10" : 
            "border-cyber-red bg-cyber-red/10"
          )}>
            <Trophy className={cn(
              "w-12 h-12",
              percentage >= 80 ? "text-cyber-green" : percentage >= 50 ? "text-cyber-yellow" : "text-cyber-red"
            )} />
          </div>
          <h2 className="text-2xl font-bold font-mono text-foreground mb-2">
            {percentage >= 80 ? "Excelente!" : percentage >= 50 ? "Bom trabalho!" : "Continue praticando"}
          </h2>
          <p className="text-lg font-mono text-primary mb-6">{percentage}% de acerto</p>
          <button onClick={onRestart} className="px-6 py-3 bg-primary text-primary-foreground font-mono rounded-lg hover:bg-primary/90">
            Jogar Novamente
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground flex items-center gap-2">
          ← Voltar aos Jogos
        </button>
        <span className="font-mono text-sm text-muted-foreground">{state.score}/{state.currentIndex + (state.showAnswer ? 1 : 0)}</span>
      </div>

      <div className="cyber-border rounded-xl p-8">
        <div className="flex items-center justify-between mb-6">
          <span className="font-mono text-sm text-muted-foreground">Desafio {state.currentIndex + 1}/{total}</span>
          <div className="w-32 h-2 bg-secondary rounded-full overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="text-center mb-8">
          <div className="inline-block p-4 bg-secondary/50 rounded-xl border border-border/50 mb-4">
            <code className="text-2xl font-mono text-foreground tracking-wider">{challenge.password}</code>
          </div>
          <p className="text-muted-foreground">Esta senha é forte ou fraca?</p>
        </div>

        {!state.showAnswer ? (
          <div className="grid grid-cols-2 gap-4">
            <button
              onClick={() => handleAnswer(false)}
              className="p-4 rounded-xl border-2 border-cyber-red/30 bg-cyber-red/5 hover:bg-cyber-red/10 transition-all"
            >
              <span className="font-mono font-semibold text-cyber-red">Fraca</span>
            </button>
            <button
              onClick={() => handleAnswer(true)}
              className="p-4 rounded-xl border-2 border-cyber-green/30 bg-cyber-green/5 hover:bg-cyber-green/10 transition-all"
            >
              <span className="font-mono font-semibold text-cyber-green">Forte</span>
            </button>
          </div>
        ) : (
          <div className={cn(
            "p-4 rounded-xl border animate-in fade-in",
            challenge.strength === "strong" ? "bg-cyber-green/5 border-cyber-green/30" : "bg-cyber-red/5 border-cyber-red/30"
          )}>
            <div className="flex items-center gap-2 mb-3">
              {challenge.strength === "strong" ? (
                <CheckCircle className="w-5 h-5 text-cyber-green" />
              ) : (
                <XCircle className="w-5 h-5 text-cyber-red" />
              )}
              <span className={cn(
                "font-mono font-bold",
                challenge.strength === "strong" ? "text-cyber-green" : "text-cyber-red"
              )}>
                Senha {challenge.strength === "strong" ? "Forte" : "Fraca"}
              </span>
            </div>
            <ul className="space-y-1">
              {challenge.reasons.map((r, i) => (
                <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                  <Zap className="w-3 h-3 text-primary shrink-0 mt-1" />
                  {r}
                </li>
              ))}
            </ul>
            <button onClick={next} className="mt-4 w-full py-2 bg-primary text-primary-foreground font-mono rounded-lg">
              {state.currentIndex + 1 >= total ? "Ver Resultado" : "Próximo"}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function AttachmentGame({ 
  state, setState, onBack, onRestart 
}: { 
  state: AttachmentGameState
  setState: React.Dispatch<React.SetStateAction<AttachmentGameState>>
  onBack: () => void
  onRestart: () => void
}) {
  const challenge = ATTACHMENT_CHALLENGES[state.currentIndex]
  const total = ATTACHMENT_CHALLENGES.length
  const progress = ((state.currentIndex) / total) * 100

  const handleAnswer = (isDangerous: boolean) => {
    const correct = isDangerous === challenge.isDangerous
    const newScore = correct ? state.score + 1 : state.score
    setState(prev => ({
      ...prev,
      score: newScore,
      showAnswer: true,
      answers: [...prev.answers, correct]
    }))
  }

  const next = () => {
    setState(prev => ({
      currentIndex: prev.currentIndex + 1,
      showAnswer: false,
      score: prev.score,
      answers: prev.answers
    }))
  }

  if (state.currentIndex >= total) {
    const percentage = Math.round((state.score / total) * 100)
    return (
      <div className="p-8 space-y-8">
        <div className="flex items-center justify-between">
          <button onClick={onBack} className="text-muted-foreground hover:text-foreground">← Voltar</button>
        </div>
        <div className="cyber-border rounded-xl p-8 text-center">
          <div className={cn(
            "w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 border-4",
            percentage >= 80 ? "border-cyber-green bg-cyber-green/10" : 
            percentage >= 50 ? "border-cyber-yellow bg-cyber-yellow/10" : 
            "border-cyber-red bg-cyber-red/10"
          )}>
            <Trophy className={cn(
              "w-12 h-12",
              percentage >= 80 ? "text-cyber-green" : percentage >= 50 ? "text-cyber-yellow" : "text-cyber-red"
            )} />
          </div>
          <h2 className="text-2xl font-bold font-mono text-foreground mb-2">
            {percentage >= 80 ? "Excelente!" : percentage >= 50 ? "Bom trabalho!" : "Continue praticando"}
          </h2>
          <p className="text-lg font-mono text-primary mb-6">{percentage}% de acerto</p>
          <button onClick={onRestart} className="px-6 py-3 bg-primary text-primary-foreground font-mono rounded-lg hover:bg-primary/90">
            Jogar Novamente
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground flex items-center gap-2">
          ← Voltar aos Jogos
        </button>
        <span className="font-mono text-sm text-muted-foreground">{state.score}/{state.currentIndex + (state.showAnswer ? 1 : 0)}</span>
      </div>

      <div className="cyber-border rounded-xl p-8">
        <div className="flex items-center justify-between mb-6">
          <span className="font-mono text-sm text-muted-foreground">Desafio {state.currentIndex + 1}/{total}</span>
          <div className="w-32 h-2 bg-secondary rounded-full overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="text-center mb-8">
          <div className="inline-block p-4 bg-secondary/50 rounded-xl border border-border/50 mb-4">
            <FileWarning className={cn(
              "w-12 h-12 mx-auto mb-2",
              challenge.isDangerous ? "text-cyber-red" : "text-cyber-green"
            )} />
            <code className="text-lg font-mono text-foreground">{challenge.filename}</code>
          </div>
          <p className="text-muted-foreground">Este arquivo é perigoso?</p>
        </div>

        {!state.showAnswer ? (
          <div className="grid grid-cols-2 gap-4">
            <button
              onClick={() => handleAnswer(true)}
              className="p-4 rounded-xl border-2 border-cyber-red/30 bg-cyber-red/5 hover:bg-cyber-red/10 transition-all"
            >
              <span className="font-mono font-semibold text-cyber-red">Perigoso</span>
            </button>
            <button
              onClick={() => handleAnswer(false)}
              className="p-4 rounded-xl border-2 border-cyber-green/30 bg-cyber-green/5 hover:bg-cyber-green/10 transition-all"
            >
              <span className="font-mono font-semibold text-cyber-green">Seguro</span>
            </button>
          </div>
        ) : (
          <div className={cn(
            "p-4 rounded-xl border animate-in fade-in",
            challenge.isDangerous ? "bg-cyber-red/5 border-cyber-red/30" : "bg-cyber-green/5 border-cyber-green/30"
          )}>
            <div className="flex items-center gap-2 mb-3">
              {challenge.isDangerous ? (
                <XCircle className="w-5 h-5 text-cyber-red" />
              ) : (
                <CheckCircle className="w-5 h-5 text-cyber-green" />
              )}
              <span className={cn(
                "font-mono font-bold",
                challenge.isDangerous ? "text-cyber-red" : "text-cyber-green"
              )}>
                {challenge.isDangerous ? "PERIGOSO" : "SEGURO"}
              </span>
            </div>
            <p className="text-sm text-muted-foreground mb-3">{challenge.explanation}</p>
            {challenge.redFlags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {challenge.redFlags.map((flag, i) => (
                  <span key={i} className="text-xs font-mono px-2 py-1 bg-cyber-red/10 text-cyber-red rounded">
                    {flag}
                  </span>
                ))}
              </div>
            )}
            <button onClick={next} className="mt-4 w-full py-2 bg-primary text-primary-foreground font-mono rounded-lg">
              {state.currentIndex + 1 >= total ? "Ver Resultado" : "Próximo"}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function DecisionGame({ 
  state, setState, onBack, onRestart 
}: { 
  state: DecisionGameState
  setState: React.Dispatch<React.SetStateAction<DecisionGameState>>
  onBack: () => void
  onRestart: () => void
}) {
  const challenge = DECISION_SCENARIOS[state.currentIndex]
  const total = DECISION_SCENARIOS.length
  const progress = ((state.currentIndex) / total) * 100

  const handleAnswer = (index: number) => {
    const correct = index === challenge.correctIndex
    const newScore = correct ? state.score + 1 : state.score
    setState(prev => ({
      ...prev,
      score: newScore,
      showAnswer: true,
      answers: [...prev.answers, correct]
    }))
  }

  const next = () => {
    setState(prev => ({
      currentIndex: prev.currentIndex + 1,
      showAnswer: false,
      score: prev.score,
      answers: prev.answers
    }))
  }

  if (state.currentIndex >= total) {
    const percentage = Math.round((state.score / total) * 100)
    return (
      <div className="p-8 space-y-8">
        <div className="flex items-center justify-between">
          <button onClick={onBack} className="text-muted-foreground hover:text-foreground">← Voltar</button>
        </div>
        <div className="cyber-border rounded-xl p-8 text-center">
          <div className={cn(
            "w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 border-4",
            percentage >= 80 ? "border-cyber-green bg-cyber-green/10" : 
            percentage >= 50 ? "border-cyber-yellow bg-cyber-yellow/10" : 
            "border-cyber-red bg-cyber-red/10"
          )}>
            <Trophy className={cn(
              "w-12 h-12",
              percentage >= 80 ? "text-cyber-green" : percentage >= 50 ? "text-cyber-yellow" : "text-cyber-red"
            )} />
          </div>
          <h2 className="text-2xl font-bold font-mono text-foreground mb-2">
            {percentage >= 80 ? "Excelente!" : percentage >= 50 ? "Bom trabalho!" : "Continue praticando"}
          </h2>
          <p className="text-lg font-mono text-primary mb-6">{percentage}% de acerto</p>
          <button onClick={onRestart} className="px-6 py-3 bg-primary text-primary-foreground font-mono rounded-lg hover:bg-primary/90">
            Jogar Novamente
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground flex items-center gap-2">
          ← Voltar aos Jogos
        </button>
        <span className="font-mono text-sm text-muted-foreground">{state.score}/{state.currentIndex + (state.showAnswer ? 1 : 0)}</span>
      </div>

      <div className="cyber-border rounded-xl p-8">
        <div className="flex items-center justify-between mb-6">
          <span className="font-mono text-sm text-muted-foreground">Desafio {state.currentIndex + 1}/{total}</span>
          <div className="w-32 h-2 bg-secondary rounded-full overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="mb-8">
          <div className="p-4 bg-primary/5 rounded-xl border border-primary/20 mb-6">
            <Brain className="w-6 h-6 text-primary mb-3" />
            <p className="text-foreground font-medium">{challenge.situation}</p>
          </div>

          {!state.showAnswer ? (
            <div className="space-y-3">
              {challenge.options.map((option, i) => (
                <button
                  key={i}
                  onClick={() => handleAnswer(i)}
                  className="w-full p-4 rounded-xl border-2 border-border/50 bg-secondary/30 hover:bg-secondary/50 hover:border-primary/30 text-left transition-all"
                >
                  <span className="font-mono text-sm text-foreground">{option}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="p-4 rounded-xl border bg-cyber-yellow/5 border-cyber-yellow/30">
              <div className="flex items-center gap-2 mb-3">
                {challenge.options.map((opt, i) => {
                  if (i === challenge.correctIndex) {
                    return (
                      <span key={i} className="text-sm font-mono text-cyber-yellow">
                        ✓ {opt}
                      </span>
                    )
                  }
                  return null
                })}
              </div>
              <p className="text-sm text-muted-foreground">{challenge.explanation}</p>
              <button onClick={next} className="mt-4 w-full py-2 bg-primary text-primary-foreground font-mono rounded-lg">
                {state.currentIndex + 1 >= total ? "Ver Resultado" : "Próximo"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function AlertResponseGame({ 
  state, setState, onBack, onRestart 
}: { 
  state: AlertGameState
  setState: React.Dispatch<React.SetStateAction<AlertGameState>>
  onBack: () => void
  onRestart: () => void
}) {
  const challenge = ALERT_RESPONSE_SCENARIOS[state.currentIndex]
  const total = ALERT_RESPONSE_SCENARIOS.length
  const progress = ((state.currentIndex) / total) * 100

  const handleAnswer = (index: number) => {
    const correct = index === challenge.correctIndex
    const newScore = correct ? state.score + 1 : state.score
    setState(prev => ({
      ...prev,
      score: newScore,
      showAnswer: true,
      answers: [...prev.answers, correct]
    }))
  }

  const next = () => {
    setState(prev => ({
      currentIndex: prev.currentIndex + 1,
      showAnswer: false,
      score: prev.score,
      answers: prev.answers
    }))
  }

  if (state.currentIndex >= total) {
    const percentage = Math.round((state.score / total) * 100)
    return (
      <div className="p-8 space-y-8">
        <div className="flex items-center justify-between">
          <button onClick={onBack} className="text-muted-foreground hover:text-foreground">← Voltar</button>
        </div>
        <div className="cyber-border rounded-xl p-8 text-center">
          <div className={cn(
            "w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 border-4",
            percentage >= 80 ? "border-cyber-green bg-cyber-green/10" : 
            percentage >= 50 ? "border-cyber-yellow bg-cyber-yellow/10" : 
            "border-cyber-red bg-cyber-red/10"
          )}>
            <Trophy className={cn(
              "w-12 h-12",
              percentage >= 80 ? "text-cyber-green" : percentage >= 50 ? "text-cyber-yellow" : "text-cyber-red"
            )} />
          </div>
          <h2 className="text-2xl font-bold font-mono text-foreground mb-2">
            {percentage >= 80 ? "Excelente!" : percentage >= 50 ? "Bom trabalho!" : "Continue praticando"}
          </h2>
          <p className="text-lg font-mono text-primary mb-6">{percentage}% de acerto</p>
          <button onClick={onRestart} className="px-6 py-3 bg-primary text-primary-foreground font-mono rounded-lg hover:bg-primary/90">
            Jogar Novamente
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground flex items-center gap-2">
          ← Voltar aos Jogos
        </button>
        <span className="font-mono text-sm text-muted-foreground">{state.score}/{state.currentIndex + (state.showAnswer ? 1 : 0)}</span>
      </div>

      <div className="cyber-border rounded-xl p-8">
        <div className="flex items-center justify-between mb-6">
          <span className="font-mono text-sm text-muted-foreground">Desafio {state.currentIndex + 1}/{total}</span>
          <div className="w-32 h-2 bg-secondary rounded-full overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="mb-8">
          <div className="p-4 bg-cyber-yellow/10 rounded-xl border border-cyber-yellow/30 mb-6">
            <AlertTriangle className="w-6 h-6 text-cyber-yellow mb-3" />
            <p className="text-foreground font-mono text-sm">{challenge.alertMessage}</p>
            <div className="mt-2">
              <span className="text-xs font-mono text-cyber-yellow uppercase">{challenge.alertType}</span>
            </div>
          </div>

          {!state.showAnswer ? (
            <div className="space-y-3">
              {challenge.options.map((option, i) => (
                <button
                  key={i}
                  onClick={() => handleAnswer(i)}
                  className="w-full p-4 rounded-xl border-2 border-border/50 bg-secondary/30 hover:bg-secondary/50 hover:border-primary/30 text-left transition-all"
                >
                  <span className="font-mono text-sm text-foreground">{option}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="p-4 rounded-xl border bg-primary/5 border-primary/20">
              <div className="flex items-center gap-2 mb-3">
                {challenge.options.map((opt, i) => {
                  if (i === challenge.correctIndex) {
                    return (
                      <span key={i} className="text-sm font-mono text-primary">
                        ✓ {opt}
                      </span>
                    )
                  }
                  return null
                })}
              </div>
              <p className="text-sm text-muted-foreground">{challenge.explanation}</p>
              <button onClick={next} className="mt-4 w-full py-2 bg-primary text-primary-foreground font-mono rounded-lg">
                {state.currentIndex + 1 >= total ? "Ver Resultado" : "Próximo"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}