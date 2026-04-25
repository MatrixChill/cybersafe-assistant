"use client"

import { Activity, Cpu, HardDrive, Wifi, Globe, Shield, Clock, TrendingUp, TrendingDown } from "lucide-react"
import { useEffect, useState } from "react"

interface ProcessInfo {
  name: string
  cpu: number
  memory: number
  status: "safe" | "warning" | "unknown"
}

export function MonitorPage() {
  const [cpuUsage, setCpuUsage] = useState(0)
  const [memoryUsage, setMemoryUsage] = useState(0)
  const [networkIn, setNetworkIn] = useState(0)
  const [networkOut, setNetworkOut] = useState(0)
  const [uptime, setUptime] = useState("0h 0m")
  const [processes, setProcesses] = useState<ProcessInfo[]>([
    { name: "chrome.exe", cpu: 12, memory: 450, status: "safe" },
    { name: "code.exe", cpu: 8, memory: 320, status: "safe" },
    { name: "node.exe", cpu: 5, memory: 180, status: "safe" },
    { name: "explorer.exe", cpu: 2, memory: 85, status: "safe" },
    { name: "svchost.exe", cpu: 1, memory: 45, status: "unknown" },
  ])

  useEffect(() => {
    const interval = setInterval(() => {
      setCpuUsage(Math.floor(Math.random() * 40) + 15)
      setMemoryUsage(Math.floor(Math.random() * 25) + 45)
      setNetworkIn(Math.floor(Math.random() * 500) + 100)
      setNetworkOut(Math.floor(Math.random() * 200) + 50)
      
      setProcesses(prev => prev.map(p => ({
        ...p,
        cpu: Math.max(1, p.cpu + (Math.random() - 0.5) * 4),
        memory: Math.max(10, p.memory + (Math.random() - 0.5) * 20),
      })))
    }, 2000)

    // Update uptime
    const uptimeInterval = setInterval(() => {
      const now = new Date()
      const hours = now.getHours()
      const minutes = now.getMinutes()
      setUptime(`${hours}h ${minutes}m`)
    }, 60000)

    setUptime(`${new Date().getHours()}h ${new Date().getMinutes()}m`)

    return () => {
      clearInterval(interval)
      clearInterval(uptimeInterval)
    }
  }, [])

  const getStatusColor = (status: string) => {
    switch (status) {
      case "safe": return "text-cyber-green"
      case "warning": return "text-cyber-yellow"
      case "unknown": return "text-muted-foreground"
      default: return "text-muted-foreground"
    }
  }

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">
            System <span className="text-primary">Monitor</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Monitoramento em tempo real do sistema
          </p>
        </div>
        
        <div className="flex items-center gap-2 px-4 py-2 bg-secondary rounded-lg">
          <Clock className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-mono text-muted-foreground">Uptime:</span>
          <span className="text-sm font-mono text-foreground font-bold">{uptime}</span>
        </div>
      </div>

      {/* Main Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <MetricCard
          label="CPU"
          value={cpuUsage}
          unit="%"
          icon={Cpu}
          trend={cpuUsage > 30 ? "up" : "down"}
        />
        <MetricCard
          label="Memória"
          value={memoryUsage}
          unit="%"
          icon={HardDrive}
          trend={memoryUsage > 60 ? "up" : "down"}
        />
        <MetricCard
          label="Rede IN"
          value={networkIn}
          unit=" KB/s"
          icon={Wifi}
          trend="up"
        />
        <MetricCard
          label="Rede OUT"
          value={networkOut}
          unit=" KB/s"
          icon={Globe}
          trend="down"
        />
      </div>

      {/* Live Graph Visualization */}
      <div className="cyber-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="font-mono font-semibold text-foreground flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            Atividade do Sistema
          </h3>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-primary" />
              <span className="text-xs font-mono text-muted-foreground">CPU</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-cyber-cyan" />
              <span className="text-xs font-mono text-muted-foreground">Memória</span>
            </div>
          </div>
        </div>
        
        {/* Simulated Graph */}
        <div className="h-48 bg-secondary/30 rounded-lg relative overflow-hidden">
          <div className="absolute inset-0 flex items-end justify-around gap-1 p-4">
            {Array.from({ length: 30 }).map((_, i) => (
              <div
                key={i}
                className="flex-1 flex flex-col gap-1"
              >
                <div
                  className="bg-primary/60 rounded-t transition-all duration-500"
                  style={{ 
                    height: `${Math.random() * 60 + 20}%`,
                    opacity: 0.3 + (i / 30) * 0.7
                  }}
                />
              </div>
            ))}
          </div>
          
          {/* Grid lines */}
          <div className="absolute inset-0 flex flex-col justify-between p-4 pointer-events-none">
            {[100, 75, 50, 25, 0].map((val) => (
              <div key={val} className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-muted-foreground w-8">{val}%</span>
                <div className="flex-1 border-t border-border/30" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Active Processes */}
      <div className="cyber-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="font-mono font-semibold text-foreground flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" />
            Processos Ativos
          </h3>
          <span className="text-xs font-mono text-muted-foreground">
            {processes.length} processos monitorados
          </span>
        </div>
        
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">
                  Processo
                </th>
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">
                  CPU
                </th>
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">
                  Memória
                </th>
                <th className="text-left py-3 px-4 text-xs font-mono text-muted-foreground uppercase tracking-wider">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {processes.map((process, index) => (
                <tr 
                  key={index} 
                  className="border-b border-border/50 hover:bg-secondary/30 transition-colors"
                >
                  <td className="py-3 px-4">
                    <span className="font-mono text-sm text-foreground">{process.name}</span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-2 bg-secondary rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-primary transition-all duration-500"
                          style={{ width: `${Math.min(process.cpu * 3, 100)}%` }}
                        />
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">
                        {process.cpu.toFixed(1)}%
                      </span>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <span className="font-mono text-sm text-muted-foreground">
                      {process.memory.toFixed(0)} MB
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <span className={`font-mono text-xs uppercase ${getStatusColor(process.status)}`}>
                      {process.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Network Connections */}
      <div className="cyber-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="font-mono font-semibold text-foreground flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" />
            Conexões de Rede
          </h3>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 bg-secondary/30 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono text-muted-foreground">Conexões Ativas</span>
              <span className="text-lg font-bold font-mono text-cyber-green">24</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Todas as conexões verificadas
            </div>
          </div>
          
          <div className="p-4 bg-secondary/30 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono text-muted-foreground">Conexões Bloqueadas</span>
              <span className="text-lg font-bold font-mono text-cyber-red">0</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Nenhuma ameaça de rede detectada
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

interface MetricCardProps {
  label: string
  value: number
  unit: string
  icon: React.ElementType
  trend: "up" | "down"
}

function MetricCard({ label, value, unit, icon: Icon, trend }: MetricCardProps) {
  const TrendIcon = trend === "up" ? TrendingUp : TrendingDown
  const trendColor = trend === "up" ? "text-cyber-red" : "text-cyber-green"

  return (
    <div className="cyber-border rounded-xl p-6 relative overflow-hidden group">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
      
      <div className="flex items-center justify-between mb-4">
        <Icon className="w-5 h-5 text-primary" />
        <TrendIcon className={`w-4 h-4 ${trendColor}`} />
      </div>
      
      <div className="text-3xl font-bold font-mono text-foreground mb-1">
        {value}<span className="text-lg text-muted-foreground">{unit}</span>
      </div>
      
      <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
        {label}
      </div>
      
      {/* Mini graph */}
      <div className="mt-4 h-8 flex items-end gap-0.5">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="flex-1 bg-primary/30 rounded-sm transition-all"
            style={{ height: `${Math.random() * 80 + 20}%` }}
          />
        ))}
      </div>
    </div>
  )
}
