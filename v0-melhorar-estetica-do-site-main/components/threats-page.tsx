"use client"

import { AlertTriangle, Shield, Search, Filter, ChevronDown, Clock, CheckCircle2, XCircle, AlertCircle } from "lucide-react"
import { useState } from "react"

const mockThreats = [
  {
    id: 1,
    name: "Trojan.GenericKD.46829321",
    type: "Trojan",
    severity: "high",
    status: "blocked",
    path: "C:\\Users\\Downloads\\setup.exe",
    detectedAt: "2026-03-22 14:32:15",
  },
  {
    id: 2,
    name: "PUP.Optional.SearchManager",
    type: "PUP",
    severity: "medium",
    status: "quarantined",
    path: "C:\\Program Files\\SearchManager\\sm.dll",
    detectedAt: "2026-03-21 09:15:42",
  },
  {
    id: 3,
    name: "Adware.BrowserModifier.Win32",
    type: "Adware",
    severity: "low",
    status: "removed",
    path: "C:\\AppData\\Local\\Temp\\installer.exe",
    detectedAt: "2026-03-20 18:45:00",
  },
]

export function ThreatsPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [filterSeverity, setFilterSeverity] = useState("all")

  const filteredThreats = mockThreats.filter(threat => {
    const matchesSearch = threat.name.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesSeverity = filterSeverity === "all" || threat.severity === filterSeverity
    return matchesSearch && matchesSeverity
  })

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "high": return "text-cyber-red bg-cyber-red/10 border-cyber-red/30"
      case "medium": return "text-cyber-yellow bg-cyber-yellow/10 border-cyber-yellow/30"
      case "low": return "text-cyber-green bg-cyber-green/10 border-cyber-green/30"
      default: return "text-muted-foreground bg-secondary"
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "blocked": return <XCircle className="w-4 h-4 text-cyber-red" />
      case "quarantined": return <AlertCircle className="w-4 h-4 text-cyber-yellow" />
      case "removed": return <CheckCircle2 className="w-4 h-4 text-cyber-green" />
      default: return null
    }
  }

  return (
    <div className="p-8 space-y-8">
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
            <span className="text-sm font-mono text-foreground font-bold">{mockThreats.length}</span>
          </div>
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
          filteredThreats.map((threat) => (
            <div
              key={threat.id}
              className="cyber-border rounded-xl p-6 hover:border-primary/50 transition-all group"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-lg bg-cyber-red/10 border border-cyber-red/30 flex items-center justify-center">
                    <AlertTriangle className="w-5 h-5 text-cyber-red" />
                  </div>
                  
                  <div>
                    <h3 className="font-mono font-semibold text-foreground group-hover:text-primary transition-colors">
                      {threat.name}
                    </h3>
                    <p className="text-xs font-mono text-muted-foreground mt-1">
                      {threat.path}
                    </p>
                    
                    <div className="flex items-center gap-3 mt-3">
                      <span className={`px-2 py-1 rounded text-xs font-mono border ${getSeverityColor(threat.severity)}`}>
                        {threat.severity.toUpperCase()}
                      </span>
                      <span className="px-2 py-1 rounded text-xs font-mono bg-secondary text-muted-foreground">
                        {threat.type}
                      </span>
                    </div>
                  </div>
                </div>
                
                <div className="flex flex-col items-end gap-2">
                  <div className="flex items-center gap-2">
                    {getStatusIcon(threat.status)}
                    <span className="text-xs font-mono text-muted-foreground capitalize">
                      {threat.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    <span className="font-mono">{threat.detectedAt}</span>
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
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="cyber-border rounded-xl p-6 text-center">
          <div className="text-3xl font-bold font-mono text-cyber-red mb-2">
            {mockThreats.filter(t => t.severity === "high").length}
          </div>
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            Alta Severidade
          </div>
        </div>
        
        <div className="cyber-border rounded-xl p-6 text-center">
          <div className="text-3xl font-bold font-mono text-cyber-yellow mb-2">
            {mockThreats.filter(t => t.severity === "medium").length}
          </div>
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            Média Severidade
          </div>
        </div>
        
        <div className="cyber-border rounded-xl p-6 text-center">
          <div className="text-3xl font-bold font-mono text-cyber-green mb-2">
            {mockThreats.filter(t => t.status === "removed").length}
          </div>
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            Removidas
          </div>
        </div>
      </div>
    </div>
  )
}
