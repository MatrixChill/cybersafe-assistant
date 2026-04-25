import { AlertTriangle, Shield, Search, ChevronDown, Clock, Trash2, CheckCircle2, XCircle, AlertCircle, Globe, FileCode } from "lucide-react"
import { useState } from "react"
import type { ThreatEvent } from "@cybersafe/shared-types"
import { cn } from "@/lib/utils"

interface ThreatsPageProps {
  events: ThreatEvent[]
  onClear: () => void
  isClearing: boolean
}

export default function ThreatsPage({ events, onClear, isClearing }: ThreatsPageProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [filterSeverity, setFilterSeverity] = useState("all")

  const filteredThreats = events.filter(threat => {
    const matchesSearch = threat.domain.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          threat.url.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesSeverity = filterSeverity === "all" || threat.severity === filterSeverity
    return matchesSearch && matchesSeverity
  })

  const formatTime = (iso: string) => {
    try {
        return new Date(iso).toLocaleString("pt-BR", { 
            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" 
        })
    } catch { return iso }
  }

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical": return "text-cyber-red bg-cyber-red/10 border-cyber-red/30"
      case "high": return "text-cyber-yellow bg-cyber-yellow/10 border-cyber-yellow/30"
      case "medium": return "text-cyber-cyan bg-cyber-cyan/10 border-cyber-cyan/30"
      default: return "text-cyber-green bg-cyber-green/10 border-cyber-green/30"
    }
  }

  const getStatusIcon = (severity: string) => {
    switch (severity) {
      case "critical": return <XCircle className="w-5 h-5 text-cyber-red" />
      case "high": return <AlertCircle className="w-5 h-5 text-cyber-yellow" />
      default: return <CheckCircle2 className="w-5 h-5 text-cyber-green" />
    }
  }

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">
            Ameaças <span className="text-primary">Detectadas</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Histórico de ameaças identificadas e bloqueadas
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-4 py-2 bg-secondary rounded-lg">
            <span className="text-sm font-mono text-muted-foreground">Total:</span>
            <span className="text-sm font-mono text-foreground font-bold">{events.length}</span>
          </div>
          <button 
            onClick={onClear}
            disabled={isClearing || events.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-destructive/10 border border-destructive/30 text-destructive font-mono text-xs rounded-lg hover:bg-destructive/20 transition-all disabled:opacity-50"
          >
            <Trash2 className="w-3 h-3" />
            {isClearing ? "LIMPANDO..." : "LIMPAR LOGS"}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <div className="flex-1 relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Buscar ameaças..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-secondary border border-border rounded-lg pl-11 pr-4 py-3 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all"
          />
        </div>
        
        <div className="relative">
          <select
            value={filterSeverity}
            onChange={(e) => setFilterSeverity(e.target.value)}
            className="appearance-none bg-secondary border border-border rounded-lg px-4 py-3 pr-10 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary cursor-pointer"
          >
            <option value="all">Todas</option>
            <option value="critical">Crítica</option>
            <option value="high">Alta</option>
            <option value="medium">Média</option>
            <option value="low">Baixa</option>
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        </div>
      </div>

      {/* Threats List */}
      <div className="space-y-4">
        {filteredThreats.length > 0 ? (
          filteredThreats.map((threat, idx) => (
            <div
              key={idx}
              className="cyber-border rounded-xl p-6 hover:border-primary/50 transition-all group"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className={cn(
                      "w-10 h-10 rounded-lg flex items-center justify-center border",
                      threat.severity === 'critical' ? "bg-cyber-red/10 border-cyber-red/30" : 
                      threat.severity === 'high' ? "bg-cyber-yellow/10 border-cyber-yellow/30" : 
                      "bg-cyber-cyan/10 border-cyber-cyan/30"
                  )}>
                    {getStatusIcon(threat.severity)}
                  </div>
                  
                  <div>
                    <h3 className="font-mono font-semibold text-foreground group-hover:text-primary transition-colors">
                        {threat.domain}
                    </h3>
                    <p className="text-xs font-mono text-muted-foreground mt-1 truncate max-w-md">
                      {threat.url}
                    </p>
                    
                    <div className="flex items-center gap-3 mt-3">
                      <span className={`px-2 py-1 rounded text-xs font-mono border ${getSeverityColor(threat.severity)}`}>
                        {threat.severity.toUpperCase()}
                      </span>
                      {threat.rulesTriggered.map(rule => (
                        <span key={rule} className="px-2 py-1 rounded text-xs font-mono bg-secondary text-muted-foreground">
                           {rule}
                        </span>
                      ))}
                      {threat.rulesTriggered.length === 0 && (
                          <span className="px-2 py-1 rounded text-xs font-mono bg-cyber-green/5 text-cyber-green border border-cyber-green/20">
                            Procedural Pass
                          </span>
                      )}
                    </div>
                  </div>
                </div>
                
                <div className="flex flex-col items-end gap-2">
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <span className="text-muted-foreground">Confidence:</span>
                    <span className="text-foreground font-bold">{Math.round(threat.confidence * 100)}%</span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground font-mono">
                    <Clock className="w-3 h-3" />
                    <span>{formatTime(threat.createdAt)}</span>
                  </div>
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="cyber-border rounded-xl p-12 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center mb-4">
              <Shield className="w-8 h-8 text-primary" />
            </div>
            <p className="text-muted-foreground text-sm">
              Nenhuma ameaça encontrada com os filtros atuais.
            </p>
          </div>
        )}
      </div>

      {/* Stats Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
        <div className="cyber-border rounded-xl p-6 text-center">
          <div className="flex items-center justify-center mb-3">
            <Shield className="w-5 h-5 text-primary" />
          </div>
          <div className="text-3xl font-bold font-mono text-foreground mb-2">
            {events.length}
          </div>
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            Total Threats
          </div>
        </div>

        <div className="cyber-border rounded-xl p-6 text-center">
          <div className="flex items-center justify-center mb-3">
            <AlertTriangle className="w-5 h-5 text-cyber-red" />
          </div>
          <div className="text-3xl font-bold font-mono text-cyber-red mb-2">
            {events.filter(e => e.severity === 'high' || e.severity === 'critical').length}
          </div>
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            Alta Severidade
          </div>
        </div>

        <div className="cyber-border rounded-xl p-6 text-center">
          <div className="flex items-center justify-center mb-3">
            <Globe className="w-5 h-5 text-cyber-cyan" />
          </div>
          <div className="text-3xl font-bold font-mono text-cyber-cyan mb-2">
            {events.filter(e => e.source === 'extension').length}
          </div>
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            Web Origins
          </div>
        </div>

        <div className="cyber-border rounded-xl p-6 text-center">
          <div className="flex items-center justify-center mb-3">
            <FileCode className="w-5 h-5 text-cyber-yellow" />
          </div>
          <div className="text-3xl font-bold font-mono text-cyber-yellow mb-2">
            {events.filter(e => e.source === 'dashboard' || e.source === 'download-monitor').length}
          </div>
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            Local Origins
          </div>
        </div>
      </div>
    </div>
  )
}
