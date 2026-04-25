"use client"

import { Shield, AlertTriangle, Download, Activity, CheckCircle2, Clock, Cpu, HardDrive, Wifi } from "lucide-react"
import { useEffect, useState } from "react"

export function Dashboard() {
  const [riskScore, setRiskScore] = useState(0)
  const [cpuUsage, setCpuUsage] = useState(0)
  const [memoryUsage, setMemoryUsage] = useState(0)
  const [networkActivity, setNetworkActivity] = useState(0)

  useEffect(() => {
    // Animate risk score
    const interval = setInterval(() => {
      setRiskScore(prev => {
        if (prev >= 95) {
          clearInterval(interval)
          return 95
        }
        return prev + 5
      })
    }, 50)

    // Simulate system metrics
    const metricsInterval = setInterval(() => {
      setCpuUsage(Math.floor(Math.random() * 30) + 10)
      setMemoryUsage(Math.floor(Math.random() * 20) + 40)
      setNetworkActivity(Math.floor(Math.random() * 50) + 20)
    }, 2000)

    return () => {
      clearInterval(interval)
      clearInterval(metricsInterval)
    }
  }, [])

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">
            System <span className="text-primary">Status</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Visão geral da sua segurança digital em tempo real
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-4 py-2 bg-cyber-green/10 border border-cyber-green/30 rounded-full">
            <div className="w-2 h-2 bg-cyber-green rounded-full cyber-pulse" />
            <span className="text-sm font-mono text-cyber-green uppercase tracking-wider">
              Sistema Protegido
            </span>
          </div>
        </div>
      </div>

      {/* Main Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* Risk Score Card */}
        <div className="lg:col-span-1 cyber-border rounded-xl p-6 relative overflow-hidden group">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-4">
            Risk Score
          </div>
          
          <div className="flex items-center justify-center">
            <div className="relative w-32 h-32">
              {/* Background circle */}
              <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-secondary"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="url(#gradient)"
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={`${(riskScore / 100) * 251.2} 251.2`}
                  className="transition-all duration-500"
                />
                <defs>
                  <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="oklch(0.7 0.2 145)" />
                    <stop offset="100%" stopColor="oklch(0.75 0.18 175)" />
                  </linearGradient>
                </defs>
              </svg>
              
              {/* Center text */}
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-4xl font-bold font-mono text-foreground">{riskScore}</span>
                <span className="text-xs font-mono text-cyber-green uppercase tracking-wider">Seguro</span>
              </div>
            </div>
          </div>
        </div>

        {/* Events Detected */}
        <StatCard
          label="Eventos Detectados"
          value="0"
          description="Total de ameaças registradas"
          icon={AlertTriangle}
          color="cyan"
        />

        {/* Severe Threats */}
        <StatCard
          label="Ameaças Severas"
          value="0"
          description="High + Critical"
          icon={Shield}
          color="green"
        />

        {/* Download Risk */}
        <StatCard
          label="Risco de Downloads"
          value="LOW"
          description="Baseado na atividade recente"
          icon={Download}
          color="green"
          isText
        />
      </div>

      {/* System Metrics */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <MetricBar label="CPU" value={cpuUsage} icon={Cpu} />
        <MetricBar label="Memória" value={memoryUsage} icon={HardDrive} />
        <MetricBar label="Rede" value={networkActivity} icon={Wifi} />
      </div>

      {/* Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Alerts Section */}
        <div className="cyber-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-mono font-semibold text-foreground flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />
              Alertas Recentes
            </h3>
            <span className="text-xs font-mono text-muted-foreground">
              Última verificação: agora
            </span>
          </div>
          
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-16 h-16 rounded-full bg-cyber-green/10 border border-cyber-green/30 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-8 h-8 text-cyber-green" />
            </div>
            <p className="text-muted-foreground text-sm">
              Nenhum alerta crítico no momento.
            </p>
            <p className="text-cyber-green text-sm font-mono mt-1">
              Tudo seguro!
            </p>
          </div>
        </div>

        {/* Threats Section */}
        <div className="cyber-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-mono font-semibold text-foreground flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              Ameaças Recentes
            </h3>
            <button className="text-xs font-mono text-primary hover:text-primary/80 transition-colors">
              Ver todas
            </button>
          </div>
          
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center mb-4">
              <Shield className="w-8 h-8 text-primary" />
            </div>
            <p className="text-muted-foreground text-sm">
              Nenhuma ameaça detectada ainda.
            </p>
            <p className="text-primary text-sm font-mono mt-1">
              Sistema limpo
            </p>
          </div>
        </div>
      </div>

      {/* Quick Scan Section */}
      <div className="cyber-border rounded-xl p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center">
              <Shield className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h3 className="font-mono font-semibold text-foreground">
                Verificação Rápida
              </h3>
              <div className="flex items-center gap-2 mt-1">
                <Clock className="w-3 h-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  Última verificação: há 2 horas
                </span>
              </div>
            </div>
          </div>
          
          <button className="px-6 py-3 bg-primary text-primary-foreground font-mono text-sm rounded-lg hover:bg-primary/90 transition-all cyber-glow">
            Iniciar Scan
          </button>
        </div>
      </div>
    </div>
  )
}

interface StatCardProps {
  label: string
  value: string
  description: string
  icon: React.ElementType
  color: "cyan" | "green" | "red" | "yellow"
  isText?: boolean
}

function StatCard({ label, value, description, icon: Icon, color, isText }: StatCardProps) {
  const colorClasses = {
    cyan: "text-cyber-cyan",
    green: "text-cyber-green",
    red: "text-cyber-red",
    yellow: "text-cyber-yellow",
  }

  return (
    <div className="cyber-border rounded-xl p-6 relative overflow-hidden group">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
      
      <div className="flex items-start justify-between mb-4">
        <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
          {label}
        </span>
        <Icon className={`w-4 h-4 ${colorClasses[color]}`} />
      </div>
      
      <div className={`${isText ? "text-2xl" : "text-4xl"} font-bold font-mono ${colorClasses[color]} mb-2`}>
        {value}
      </div>
      
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  )
}

interface MetricBarProps {
  label: string
  value: number
  icon: React.ElementType
}

function MetricBar({ label, value, icon: Icon }: MetricBarProps) {
  const getColor = (val: number) => {
    if (val < 30) return "bg-cyber-green"
    if (val < 60) return "bg-cyber-yellow"
    return "bg-cyber-red"
  }

  return (
    <div className="cyber-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-primary" />
          <span className="font-mono text-sm text-foreground">{label}</span>
        </div>
        <span className="font-mono text-sm text-muted-foreground">{value}%</span>
      </div>
      
      <div className="h-2 bg-secondary rounded-full overflow-hidden">
        <div 
          className={`h-full ${getColor(value)} transition-all duration-500 progress-glow`}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  )
}
