import { FileSearch, Upload, File, Loader2, ShieldAlert, Zap, Folder } from "lucide-react"
import { useState, useCallback, useRef } from "react"
import { cn } from "@/lib/utils"

interface ScanResult {
  fileName: string
  severity: string
  rulesTriggered: string[]
  isExecutable?: boolean
  riskScore?: number
  confidence?: number
}

export default function FileScannerPage() {
  const [isDragging, setIsDragging] = useState(false)
  const [selectedFile, setSelectedFile] = useState<{ name: string; path: string; size: number } | null>(null)
  const [isScanning, setIsScanning] = useState(false)
  const [results, setResults] = useState<ScanResult[]>([])
  const [summary, setSummary] = useState<any | null>(null)
  const [error, setError] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const files = e.dataTransfer.files
    if (files && files.length > 0) {
      const file = files[0] as any
      if (file.path) {
        setSelectedFile({ name: file.name, path: file.path, size: file.size })
      }
    }
  }, [])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] as any
    if (file && file.path) {
      setSelectedFile({ name: file.name, path: file.path, size: file.size })
    }
  }, [])

  const openFileDialog = async () => {
    if (!window.electronAPI) {
      setError("API do Electron não disponível");
      return;
    }
    try {
      const filePath = await window.electronAPI.openFileDialog();
      if (filePath) {
        const name = filePath.split(/[/\\]/).pop() || filePath;
        setSelectedFile({ name, path: filePath, size: 0 });
      }
    } catch (err: any) {
      setError("Erro ao abrir diálogo: " + err.message);
    }
  }

  const startScan = async () => {
    if (!selectedFile) return
    setIsScanning(true)
    setError("")
    setResults([])
    setSummary(null)

    try {
      const data = await window.electronAPI.scanFile(selectedFile.path)
      if (data && data.results && data.results.length > 0) {
        setResults(data.results.map((r: any) => ({
          fileName: r.fileName || selectedFile.name,
          severity: r.severity || 'low',
          rulesTriggered: r.rulesTriggered || [],
          isExecutable: r.isExecutable,
          riskScore: r.riskScore,
          confidence: r.confidence
        })))
        setSummary({
          overallSeverity: data.overallSeverity,
          highRiskCount: data.highRiskCount,
          totalFiles: data.totalFiles,
          riskScore: data.riskScore
        })
      } else {
        setResults([{
          fileName: selectedFile.name,
          severity: 'safe',
          rulesTriggered: []
        }])
        setSummary({
          overallSeverity: 'safe',
          highRiskCount: 0,
          totalFiles: 1,
          riskScore: 0
        })
      }
    } catch (err: any) {
      setError("Erro ao processar arquivo: " + err.message)
    } finally {
      setIsScanning(false)
    }
  }

  const clear = () => {
    setSelectedFile(null)
    setResults([])
    setSummary(null)
    setError("")
  }

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tight">
          File <span className="text-primary">Scanner</span>
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Analise arquivos em busca de ameaças e malware
        </p>
      </div>

      {/* Upload Zone */}
      {!summary && (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => !selectedFile && openFileDialog()}
          className={cn(
            "cyber-border rounded-xl p-12 transition-all cursor-pointer",
            isDragging ? "border-primary bg-primary/5 scale-[1.02]" : "hover:border-primary/50"
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileSelect}
            className="hidden"
          />
          <div className="flex flex-col items-center justify-center text-center">
            <div className={cn(
              "w-20 h-20 rounded-2xl flex items-center justify-center mb-6 transition-all border",
              isDragging ? "bg-primary/20 border-primary" : "bg-primary/10 border-primary/30"
            )}>
              {isScanning ? (
                <Loader2 className="w-10 h-10 text-primary animate-spin" />
              ) : isDragging ? (
                <Upload className="w-10 h-10 text-primary animate-bounce" />
              ) : selectedFile ? (
                <File className="w-10 h-10 text-primary" />
              ) : (
                <FileSearch className="w-10 h-10 text-primary" />
              )}
            </div>
            
            <h3 className="text-lg font-mono font-semibold text-foreground mb-2">
              {isScanning ? "Analisando..." : selectedFile ? selectedFile.name : isDragging ? "Solte os arquivos aqui" : "Arraste arquivos ou clique para selecionar"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-md">
              {selectedFile 
                ? `${(selectedFile.size / 1024).toFixed(1)} KB`
                : "Suportamos todos os tipos de arquivo. Análise local e segura."
              }
            </p>
            
            {!isScanning && (
              <div className="flex items-center gap-3 mt-6">
                {!selectedFile ? (
                  <>
                    <div className="flex items-center gap-2 px-4 py-2 bg-secondary rounded-lg">
                      <File className="w-4 h-4 text-muted-foreground" />
                      <span className="text-xs font-mono text-muted-foreground">Arquivos</span>
                    </div>
                    <div className="flex items-center gap-2 px-4 py-2 bg-secondary rounded-lg">
                      <Folder className="w-4 h-4 text-muted-foreground" />
                      <span className="text-xs font-mono text-muted-foreground">Pastas</span>
                    </div>
                  </>
                ) : (
                  <>
                    <button 
                      onClick={(e) => { e.stopPropagation(); startScan(); }}
                      className="px-6 py-2.5 bg-primary text-primary-foreground font-mono text-sm rounded-lg hover:bg-primary/90 transition-all cyber-glow"
                    >
                      Iniciar Scan
                    </button>
                    <button 
                      onClick={(e) => { e.stopPropagation(); clear(); }}
                      className="px-4 py-2.5 bg-secondary text-foreground font-mono text-sm rounded-lg hover:bg-secondary/80 transition-all"
                    >
                      Remover
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {error && <div className="text-cyber-red text-xs font-mono p-4 cyber-border bg-cyber-red/5 rounded-lg">{error}</div>}

      {/* Results Section */}
      {(isScanning || results.length > 0) && (
        <div className="cyber-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="font-mono font-semibold text-foreground flex items-center gap-2">
                <FileSearch className="w-4 h-4 text-primary" />
                Resultados da Análise
              </h3>
              <p className="text-xs font-mono text-muted-foreground mt-1">
                {isScanning ? "Processando binários via Heurística..." : "Análise Completa"}
              </p>
            </div>
            {summary && (
              <span className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-mono uppercase border",
                summary.overallSeverity === 'safe' 
                  ? "bg-cyber-green/10 text-cyber-green border-cyber-green/30" 
                  : "bg-cyber-red/10 text-cyber-red border-cyber-red/30"
              )}>
                STATUS: {summary.overallSeverity.toUpperCase()}
              </span>
            )}
          </div>

          <div className="space-y-3">
            {results.map((result, index) => (
              <div key={index} className="flex items-center justify-between p-4 bg-secondary/50 rounded-lg border border-border">
                <div className="flex items-center gap-3">
                  <File className={cn("w-5 h-5", result.severity === 'safe' ? "text-cyber-green" : "text-cyber-red")} />
                  <div>
                    <p className="font-mono text-sm text-foreground">{result.fileName}</p>
                    <div className="flex gap-1 mt-1">
                      {result.rulesTriggered.map(rule => (
                        <span key={rule} className="text-[9px] font-mono text-muted-foreground bg-black/20 px-1.5 rounded border border-white/5">{rule}</span>
                      ))}
                    </div>
                  </div>
                </div>
                
                <span className={cn(
                  "text-xs font-mono uppercase px-2 py-1 rounded border",
                  result.severity === 'safe' 
                    ? "bg-cyber-green/10 text-cyber-green border-cyber-green/30"
                    : "bg-cyber-red/10 text-cyber-red border-cyber-red/30"
                )}>
                  {result.severity}
                </span>
              </div>
            ))}
            {isScanning && (
              <div className="flex flex-col items-center justify-center py-8 opacity-50">
                  <Loader2 className="w-8 h-8 animate-spin text-primary mb-2" />
                  <span className="text-xs font-mono uppercase tracking-widest animate-pulse">Deep Inspection Active...</span>
              </div>
            )}
          </div>

          {/* Summary */}
          {summary && !isScanning && (
            <div className="mt-6 pt-6 border-t border-border">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div className="text-2xl font-bold font-mono text-foreground">{summary.totalFiles}</div>
                  <div className="text-xs font-mono text-muted-foreground">Total</div>
                </div>
                <div>
                  <div className="text-2xl font-bold font-mono text-cyber-green">
                    {summary.totalFiles - summary.highRiskCount}
                  </div>
                  <div className="text-xs font-mono text-muted-foreground">Limpos</div>
                </div>
                <div>
                  <div className="text-2xl font-bold font-mono text-cyber-red">{summary.highRiskCount}</div>
                  <div className="text-xs font-mono text-muted-foreground">Infectados</div>
                </div>
              </div>
              
              <button 
                onClick={clear}
                className="mt-6 w-full py-3 bg-secondary text-foreground font-mono text-sm rounded-lg hover:bg-secondary/80 transition-all"
              >
                Nova Análise
              </button>
            </div>
          )}
        </div>
      )}

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="cyber-border rounded-xl p-6 hover:border-primary/50 transition-all group cursor-pointer">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
              <ShieldAlert className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h3 className="font-mono font-semibold text-foreground group-hover:text-primary transition-colors">
                Dica de Segurança
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                Sempre analise arquivos baixados de fontes desconhecidas ou executáveis inesperados.
              </p>
            </div>
          </div>
        </div>
        
        <div className="cyber-border rounded-xl p-6 hover:border-primary/50 transition-all group cursor-pointer">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-cyber-cyan/10 border border-cyber-cyan/30 flex items-center justify-center group-hover:bg-cyber-cyan/20 transition-colors">
              <Zap className="w-6 h-6 text-cyber-cyan" />
            </div>
            <div>
              <h3 className="font-mono font-semibold text-foreground group-hover:text-cyber-cyan transition-colors">
                Análise Profunda
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                Motor de scan analisa recursivamente ZIPs com heurística avançada.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
