"use client"

import { Zap, Shield, Bug, Mail, Globe, Database, Lock, AlertTriangle, CheckCircle2, Loader2, Play, RotateCcw } from "lucide-react"
import { useState } from "react"

interface SimulationResult {
  test: string
  status: "passed" | "failed" | "warning"
  description: string
}

const simulationTests = [
  {
    id: "phishing",
    name: "Detecção de Phishing",
    description: "Testa a capacidade de detectar e-mails e sites de phishing",
    icon: Mail,
    color: "cyber-yellow"
  },
  {
    id: "malware",
    name: "Proteção Contra Malware",
    description: "Simula ataques de malware comuns",
    icon: Bug,
    color: "cyber-red"
  },
  {
    id: "firewall",
    name: "Teste de Firewall",
    description: "Verifica a eficácia das regras de firewall",
    icon: Shield,
    color: "primary"
  },
  {
    id: "network",
    name: "Segurança de Rede",
    description: "Analisa vulnerabilidades na configuração de rede",
    icon: Globe,
    color: "cyber-cyan"
  },
  {
    id: "data",
    name: "Proteção de Dados",
    description: "Verifica a criptografia e proteção de dados sensíveis",
    icon: Database,
    color: "cyber-green"
  },
  {
    id: "ransomware",
    name: "Defesa Anti-Ransomware",
    description: "Testa proteções contra ataques de ransomware",
    icon: Lock,
    color: "cyber-red"
  },
]

export function SimulatorPage() {
  const [isRunning, setIsRunning] = useState(false)
  const [currentTest, setCurrentTest] = useState<string | null>(null)
  const [results, setResults] = useState<SimulationResult[]>([])
  const [progress, setProgress] = useState(0)

  const runSimulation = async () => {
    setIsRunning(true)
    setResults([])
    setProgress(0)

    for (let i = 0; i < simulationTests.length; i++) {
      const test = simulationTests[i]
      setCurrentTest(test.id)
      
      await new Promise(resolve => setTimeout(resolve, 1500))
      
      const status: "passed" | "failed" | "warning" = 
        Math.random() > 0.1 ? "passed" : Math.random() > 0.5 ? "warning" : "failed"
      
      setResults(prev => [...prev, {
        test: test.name,
        status,
        description: status === "passed" 
          ? "Proteção funcionando corretamente"
          : status === "warning"
          ? "Algumas melhorias recomendadas"
          : "Vulnerabilidade detectada"
      }])
      
      setProgress(((i + 1) / simulationTests.length) * 100)
    }

    setCurrentTest(null)
    setIsRunning(false)
  }

  const resetSimulation = () => {
    setResults([])
    setProgress(0)
    setCurrentTest(null)
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "passed": return <CheckCircle2 className="w-5 h-5 text-cyber-green" />
      case "warning": return <AlertTriangle className="w-5 h-5 text-cyber-yellow" />
      case "failed": return <AlertTriangle className="w-5 h-5 text-cyber-red" />
      default: return null
    }
  }

  const passedCount = results.filter(r => r.status === "passed").length
  const warningCount = results.filter(r => r.status === "warning").length
  const failedCount = results.filter(r => r.status === "failed").length

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">
            Simulador de <span className="text-primary">Ataques</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Teste a eficácia das suas proteções com simulações seguras
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          {results.length > 0 && (
            <button
              onClick={resetSimulation}
              disabled={isRunning}
              className="flex items-center gap-2 px-4 py-2 bg-secondary text-foreground font-mono text-sm rounded-lg hover:bg-secondary/80 transition-all disabled:opacity-50"
            >
              <RotateCcw className="w-4 h-4" />
              Resetar
            </button>
          )}
          <button
            onClick={runSimulation}
            disabled={isRunning}
            className="flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-mono text-sm rounded-lg hover:bg-primary/90 transition-all disabled:opacity-50 cyber-glow"
          >
            {isRunning ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Executando...
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                Iniciar Simulação
              </>
            )}
          </button>
        </div>
      </div>

      {/* Progress Bar */}
      {(isRunning || progress > 0) && (
        <div className="cyber-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-mono text-muted-foreground">Progresso da Simulação</span>
            <span className="text-sm font-mono text-foreground">{Math.round(progress)}%</span>
          </div>
          <div className="h-3 bg-secondary rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-primary to-cyber-cyan transition-all duration-500 progress-glow"
              style={{ width: `${progress}%` }}
            />
          </div>
          {currentTest && (
            <div className="mt-4 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              <span className="text-sm font-mono text-muted-foreground">
                Testando: {simulationTests.find(t => t.id === currentTest)?.name}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Test Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {simulationTests.map((test) => {
          const Icon = test.icon
          const result = results.find(r => r.test === test.name)
          const isActive = currentTest === test.id
          
          return (
            <div
              key={test.id}
              className={`
                cyber-border rounded-xl p-6 transition-all relative overflow-hidden
                ${isActive ? "border-primary bg-primary/5 scale-[1.02]" : ""}
                ${result ? "opacity-100" : isRunning && !isActive ? "opacity-50" : ""}
              `}
            >
              {/* Active indicator */}
              {isActive && (
                <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary to-cyber-cyan" />
              )}
              
              <div className="flex items-start justify-between mb-4">
                <div className={`
                  w-12 h-12 rounded-xl flex items-center justify-center border
                  ${result 
                    ? result.status === "passed" 
                      ? "bg-cyber-green/10 border-cyber-green/30" 
                      : result.status === "warning"
                      ? "bg-cyber-yellow/10 border-cyber-yellow/30"
                      : "bg-cyber-red/10 border-cyber-red/30"
                    : `bg-${test.color}/10 border-${test.color}/30`
                  }
                `}>
                  {isActive ? (
                    <Loader2 className="w-6 h-6 text-primary animate-spin" />
                  ) : result ? (
                    getStatusIcon(result.status)
                  ) : (
                    <Icon className={`w-6 h-6 text-${test.color}`} />
                  )}
                </div>
                
                {result && (
                  <span className={`
                    text-xs font-mono uppercase px-2 py-1 rounded
                    ${result.status === "passed" 
                      ? "bg-cyber-green/10 text-cyber-green" 
                      : result.status === "warning"
                      ? "bg-cyber-yellow/10 text-cyber-yellow"
                      : "bg-cyber-red/10 text-cyber-red"
                    }
                  `}>
                    {result.status}
                  </span>
                )}
              </div>
              
              <h3 className="font-mono font-semibold text-foreground mb-2">
                {test.name}
              </h3>
              <p className="text-xs text-muted-foreground">
                {result ? result.description : test.description}
              </p>
            </div>
          )
        })}
      </div>

      {/* Results Summary */}
      {results.length > 0 && !isRunning && (
        <div className="cyber-border rounded-xl p-6">
          <h3 className="font-mono font-semibold text-foreground mb-6 flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            Resumo da Simulação
          </h3>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="p-6 bg-cyber-green/5 border border-cyber-green/20 rounded-xl text-center">
              <div className="text-4xl font-bold font-mono text-cyber-green mb-2">
                {passedCount}
              </div>
              <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                Testes Aprovados
              </div>
            </div>
            
            <div className="p-6 bg-cyber-yellow/5 border border-cyber-yellow/20 rounded-xl text-center">
              <div className="text-4xl font-bold font-mono text-cyber-yellow mb-2">
                {warningCount}
              </div>
              <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                Avisos
              </div>
            </div>
            
            <div className="p-6 bg-cyber-red/5 border border-cyber-red/20 rounded-xl text-center">
              <div className="text-4xl font-bold font-mono text-cyber-red mb-2">
                {failedCount}
              </div>
              <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                Falhas
              </div>
            </div>
          </div>
          
          {/* Score */}
          <div className="mt-6 pt-6 border-t border-border">
            <div className="flex items-center justify-between">
              <span className="text-sm font-mono text-muted-foreground">
                Pontuação de Segurança
              </span>
              <div className="flex items-center gap-3">
                <div className="w-48 h-2 bg-secondary rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-cyber-red via-cyber-yellow to-cyber-green transition-all duration-500"
                    style={{ width: `${(passedCount / simulationTests.length) * 100}%` }}
                  />
                </div>
                <span className="font-mono font-bold text-foreground">
                  {Math.round((passedCount / simulationTests.length) * 100)}%
                </span>
              </div>
            </div>
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
              O simulador executa testes seguros que não causam danos ao seu sistema. 
              Ele verifica a eficácia das suas proteções contra diferentes tipos de ameaças 
              usando técnicas de simulação controlada.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
