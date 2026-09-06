import { FileSearch, Upload, File, Loader2, ShieldAlert, Zap, Folder, X } from "lucide-react"
import { useState, useCallback, useRef, useEffect } from "react"
import { cn } from "@/lib/utils"
import type { ScanState } from "@cybersafe/shared-types"

export default function FileScannerPage() {
  const [isDragging, setIsDragging] = useState(false)
  const [selectedFile, setSelectedFile] = useState<{ name: string; path: string; size: number } | null>(null)
  const [error, setError] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Real-time scan tracking
  const [activeScanId, setActiveScanId] = useState<string | null>(null)
  const [scanProgress, setScanProgress] = useState<ScanState | null>(null)
  const [scanLog, setScanLog] = useState<string[]>([])
  const scanUnsubscribeRef = useRef<(() => void) | null>(null)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (scanUnsubscribeRef.current) {
        scanUnsubscribeRef.current()
      }
    }
  }, [])

  // Listen for scan progress
  useEffect(() => {
    if (!activeScanId) return

    if (scanUnsubscribeRef.current) {
      scanUnsubscribeRef.current()
    }

    const unsubscribe = window.electronAPI?.onScanProgress((state: ScanState) => {
      if (state.id === activeScanId) {
        setScanProgress(state)

        // Add log entry for status changes
        if (state.status === "completed" || state.status === "cancelled" || state.status === "failed") {
          setScanLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] Scan ${state.status}: ${state.filesScanned}/${state.progress}% - ${state.threatsFound} threats`])
        } else if (state.filesScanned % 50 === 0) {
          // Log every 50 files to avoid spam
          setScanLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] Scanned ${state.filesScanned} files (${state.progress}%) - ${state.threatsFound} threats`])
        }
      }
    })

    scanUnsubscribeRef.current = unsubscribe
    return () => {
      unsubscribe?.()
    }
  }, [activeScanId])

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
      setError("API do Electron não disponível")
      return
    }
    try {
      const filePath = await window.electronAPI.openFileDialog()
      if (filePath) {
        const name = filePath.split(/[/\\]/).pop() || filePath
        setSelectedFile({ name, path: filePath, size: 0 })
      }
    } catch (err: any) {
      setError("Erro ao abrir diálogo: " + err.message)
    }
  }

  const startScan = async () => {
    if (!selectedFile) return
    setError("")
    setScanLog([])

    try {
      const data = await window.electronAPI.scanFile(selectedFile.path)
      setScanLog([
        `[${new Date().toLocaleTimeString()}] Arquivo analisado: ${selectedFile.name}`,
        `Resultado: ${data ? (data.overallSeverity && data.overallSeverity !== "critical" && data.overallSeverity !== "high" ? 'SEGURO' : 'AMEAÇA DETECTADA') : 'ERRO'}`,
        data ? `Riscos encontrados: ${data.highRiskCount}` : 'Falha ao processar'
      ])
    } catch (err: any) {
      setError("Erro ao processar arquivo: " + err.message)
    }
  }

  const startQuickScan = async () => {
    setError("")
    setScanLog([])
    setScanProgress(null)

    try {
      const result = await window.electronAPI.startScan("quick")
      if (result.success) {
        setActiveScanId(result.id)
        setScanLog([`[${new Date().toLocaleTimeString()}] Análise rápida iniciada (Downloads, Ambiente de Trabalho, Documentos, Arranque)`])
      }
    } catch (err: any) {
      setError("Erro ao iniciar scan: " + err.message)
    }
  }

  const startFullScan = async () => {
    setError("")
    setScanLog([])
    setScanProgress(null)

    try {
      const result = await window.electronAPI.startScan("full")
      if (result.success) {
        setActiveScanId(result.id)
        setScanLog([`[${new Date().toLocaleTimeString()}] Análise completa iniciada (diretório HOME + ProgramData)`])
      }
    } catch (err: any) {
      setError("Erro ao iniciar scan: " + err.message)
    }
  }

  const startCustomScan = async () => {
    if (!selectedFile) return

    setError("")
    setScanLog([])
    setScanProgress(null)

    try {
      const result = await window.electronAPI.startScan("custom", selectedFile.path)
      if (result.success) {
        setActiveScanId(result.id)
        setScanLog([`[${new Date().toLocaleTimeString()}] Análise personalizada iniciada para: ${selectedFile.path}`])
      }
    } catch (err: any) {
      setError("Erro ao iniciar scan: " + err.message)
    }
  }

  const cancelScan = async () => {
    if (!activeScanId) return
    try {
      await window.electronAPI.cancelScan(activeScanId)
      setScanLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] Scan cancelado pelo usuário`])
    } catch (err: any) {
      setError("Erro ao cancelar scan: " + err.message)
    }
  }

  const clear = () => {
    setSelectedFile(null)
    setScanLog([])
    setScanProgress(null)
    setActiveScanId(null)
    setError("")
  }

  const isScanning = !!activeScanId && scanProgress?.status !== "completed" && scanProgress?.status !== "cancelled" && scanProgress?.status !== "failed"

  return (
    <div className="p-8 space-y-8 animate-in fade-in duration-500 overflow-y-auto max-h-[calc(100vh-100px)]">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tight">
          Scanner de <span className="text-primary">Ficheiros</span>
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Análise de arquivos com progresso em tempo real
        </p>
      </div>

      {/* Live Scan View */}
      {isScanning && scanProgress && (
        <div className="cyber-border rounded-xl p-6 bg-gradient-to-br from-primary/5 to-transparent">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-primary animate-spin" />
              <div>
                <h3 className="font-mono font-semibold text-foreground">Scan em Andamento</h3>
                <p className="text-xs text-muted-foreground">{scanProgress.type.toUpperCase()} SCAN</p>
              </div>
            </div>
            <button
              onClick={cancelScan}
              className="px-4 py-2 bg-cyber-red/20 text-cyber-red border border-cyber-red/50 font-mono text-xs rounded-lg hover:bg-cyber-red/30 transition-all flex items-center gap-2"
            >
              <X className="w-4 h-4" />
              Cancelar
            </button>
          </div>

          {/* Progress Bar */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-mono text-foreground">Progresso</span>
              <span className="text-sm font-mono font-bold text-primary">{scanProgress.progress}%</span>
            </div>
            <div className="w-full h-2 bg-secondary rounded-full overflow-hidden border border-border">
              <div
                className="h-full bg-gradient-to-r from-primary to-cyan-500 transition-all duration-300"
                style={{ width: `${scanProgress.progress}%` }}
              />
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-black/20 rounded-lg p-3 border border-white/5">
              <div className="text-xs text-muted-foreground uppercase mb-1">Arquivos Analisados</div>
              <div className="text-xl font-mono font-bold text-foreground">{scanProgress.filesScanned}</div>
            </div>
            <div className="bg-black/20 rounded-lg p-3 border border-white/5">
              <div className="text-xs text-muted-foreground uppercase mb-1">Ameaças Encontradas</div>
              <div className="text-xl font-mono font-bold text-cyber-red">{scanProgress.threatsFound}</div>
            </div>
            <div className="bg-black/20 rounded-lg p-3 border border-white/5">
              <div className="text-xs text-muted-foreground uppercase mb-1">Status</div>
              <div className="text-xl font-mono font-bold text-primary capitalize">{scanProgress.status}</div>
            </div>
            <div className="bg-black/20 rounded-lg p-3 border border-white/5">
              <div className="text-xs text-muted-foreground uppercase mb-1">Tempo Decorrido</div>
              <div className="text-xl font-mono font-bold text-foreground">
                {scanProgress.startTime
                  ? Math.floor(
                    (new Date().getTime() - new Date(scanProgress.startTime).getTime()) / 1000
                  )
                  : 0}s
              </div>
            </div>
          </div>

          {/* Scan Log */}
          <div className="bg-black/40 rounded-lg border border-white/5 p-4 max-h-48 overflow-y-auto">
            <div className="text-xs font-mono space-y-1 text-muted-foreground font-mono">
              {scanLog.map((log, idx) => (
                <div key={idx}>{log}</div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Scan Completed View */}
      {!isScanning && scanProgress && (scanProgress.status === "completed" || scanProgress.status === "cancelled" || scanProgress.status === "failed") && (
        <div className={cn(
          "cyber-border rounded-xl p-6",
          scanProgress.status === "completed"
            ? "bg-gradient-to-br from-cyber-green/5 to-transparent"
            : "bg-gradient-to-br from-cyber-red/5 to-transparent"
        )}>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="font-mono font-semibold text-foreground">Scan Concluído</h3>
              <p className="text-xs text-muted-foreground">{scanProgress.type.toUpperCase()} SCAN</p>
            </div>
            <span className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-mono uppercase border",
              scanProgress.status === "completed"
                ? "bg-cyber-green/10 text-cyber-green border-cyber-green/30"
                : scanProgress.status === "cancelled"
                  ? "bg-cyber-yellow/10 text-cyber-yellow border-cyber-yellow/30"
                  : "bg-cyber-red/10 text-cyber-red border-cyber-red/30"
            )}>
              {scanProgress.status.toUpperCase()}
            </span>
          </div>

          {/* Final Stats */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-black/20 rounded-lg p-4 border border-white/5 text-center">
              <div className="text-xs text-muted-foreground uppercase mb-2">Total Analisado</div>
              <div className="text-3xl font-mono font-bold text-foreground">{scanProgress.filesScanned}</div>
            </div>
            <div className="bg-black/20 rounded-lg p-4 border border-white/5 text-center">
              <div className="text-xs text-muted-foreground uppercase mb-2">Limpos</div>
              <div className="text-3xl font-mono font-bold text-cyber-green">{scanProgress.filesScanned - scanProgress.threatsFound}</div>
            </div>
            <div className="bg-black/20 rounded-lg p-4 border border-white/5 text-center">
              <div className="text-xs text-muted-foreground uppercase mb-2">Ameaças</div>
              <div className="text-3xl font-mono font-bold text-cyber-red">{scanProgress.threatsFound}</div>
            </div>
          </div>

          {/* Duration */}
          {scanProgress.startTime && scanProgress.endTime && (
            <div className="text-center text-sm font-mono text-muted-foreground mb-6">
              Tempo total: {Math.floor(
                (new Date(scanProgress.endTime).getTime() - new Date(scanProgress.startTime).getTime()) /
                1000
              )}s
            </div>
          )}

          <button
            onClick={clear}
            className="w-full py-3 bg-primary text-primary-foreground font-mono text-sm rounded-lg hover:bg-primary/90 transition-all"
          >
            Nova Análise
          </button>
        </div>
      )}

      {/* Upload Zone */}
      {!activeScanId && !scanProgress && (
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
          <input ref={fileInputRef} type="file" onChange={handleFileSelect} className="hidden" />
          <div className="flex flex-col items-center justify-center text-center">
            <div className={cn(
              "w-20 h-20 rounded-2xl flex items-center justify-center mb-6 transition-all border",
              isDragging ? "bg-primary/20 border-primary" : "bg-primary/10 border-primary/30"
            )}>
              {isDragging ? (
                <Upload className="w-10 h-10 text-primary animate-bounce" />
              ) : selectedFile ? (
                <File className="w-10 h-10 text-primary" />
              ) : (
                <FileSearch className="w-10 h-10 text-primary" />
              )}
            </div>

            <h3 className="text-lg font-mono font-semibold text-foreground mb-2">
              {selectedFile ? selectedFile.name : isDragging ? "Solte os arquivos aqui" : "Arraste arquivos ou clique para selecionar"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-md">
              {selectedFile
                ? `${(selectedFile.size / 1024).toFixed(1)} KB`
                : "Suportamos todos os tipos de arquivo. Análise local e segura."}
            </p>

            <div className="flex items-center gap-3 mt-6 flex-wrap justify-center">
              {!selectedFile ? (
                <>
                  <button
                    onClick={(e) => { e.stopPropagation(); openFileDialog(); }}
                    className="flex items-center gap-2 px-4 py-2 bg-secondary rounded-lg hover:bg-secondary/80 transition-all font-mono text-sm"
                  >
                    <File className="w-4 h-4" />
                    Arquivo
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); openFileDialog(); }}
                    className="flex items-center gap-2 px-4 py-2 bg-secondary rounded-lg hover:bg-secondary/80 transition-all font-mono text-sm"
                  >
                    <Folder className="w-4 h-4" />
                    Pasta
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); startQuickScan(); }}
                    className="px-6 py-2.5 bg-cyber-cyan/20 text-cyber-cyan border border-cyber-cyan/50 font-mono text-sm rounded-lg hover:bg-cyber-cyan/30 transition-all cyber-glow"
                  >
                    Análise Rápida
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); startFullScan(); }}
                    className="px-6 py-2.5 bg-cyber-magenta/20 text-cyber-magenta border border-cyber-magenta/50 font-mono text-sm rounded-lg hover:bg-cyber-magenta/30 transition-all cyber-glow"
                  >
                    Análise Completa
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={(e) => { e.stopPropagation(); startScan(); }}
                    className="px-6 py-2.5 bg-primary text-primary-foreground font-mono text-sm rounded-lg hover:bg-primary/90 transition-all cyber-glow"
                  >
                    Analisar Arquivo
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); startCustomScan(); }}
                    className="px-6 py-2.5 bg-cyber-cyan/20 text-cyber-cyan border border-cyber-cyan/50 font-mono text-sm rounded-lg hover:bg-cyber-cyan/30 transition-all"
                  >
                    Analisar Pasta
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
          </div>
        </div>
      )}

      {error && (
        <div className="text-cyber-red text-xs font-mono p-4 cyber-border bg-cyber-red/5 rounded-lg">{error}</div>
      )}

      {/* Tips */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="cyber-border rounded-xl p-6 hover:border-primary/50 transition-all group">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
              <ShieldAlert className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h3 className="font-mono font-semibold text-foreground">Dica de Segurança</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Analise arquivos baixados de fontes desconhecidas ou executáveis inesperados.
              </p>
            </div>
          </div>
        </div>

        <div className="cyber-border rounded-xl p-6 hover:border-primary/50 transition-all group">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-cyber-cyan/10 border border-cyber-cyan/30 flex items-center justify-center group-hover:bg-cyber-cyan/20 transition-colors">
              <Zap className="w-6 h-6 text-cyber-cyan" />
            </div>
            <div>
              <h3 className="font-mono font-semibold text-foreground">Análise em Tempo Real</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Scanner independente continua mesmo ao trocar de página. ZIPs analisados recursivamente.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
