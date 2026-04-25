"use client"

import { FileSearch, Upload, Folder, File, CheckCircle2, AlertTriangle, Loader2, X } from "lucide-react"
import { useState, useCallback } from "react"

interface ScanResult {
  name: string
  size: string
  status: "clean" | "infected" | "scanning"
  threats?: string[]
}

export function FileScannerPage() {
  const [isDragging, setIsDragging] = useState(false)
  const [scanResults, setScanResults] = useState<ScanResult[]>([])
  const [isScanning, setIsScanning] = useState(false)

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
    
    const files = Array.from(e.dataTransfer.files)
    simulateScan(files.map(f => ({ name: f.name, size: formatFileSize(f.size) })))
  }, [])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    simulateScan(files.map(f => ({ name: f.name, size: formatFileSize(f.size) })))
  }, [])

  const simulateScan = (files: { name: string; size: string }[]) => {
    setIsScanning(true)
    const results: ScanResult[] = files.map(f => ({
      ...f,
      status: "scanning" as const
    }))
    setScanResults(results)

    // Simulate scanning each file
    files.forEach((file, index) => {
      setTimeout(() => {
        setScanResults(prev => prev.map((r, i) => {
          if (i === index) {
            return {
              ...r,
              status: Math.random() > 0.9 ? "infected" : "clean",
              threats: Math.random() > 0.9 ? ["Trojan.Generic.Win32"] : undefined
            }
          }
          return r
        }))
        
        if (index === files.length - 1) {
          setIsScanning(false)
        }
      }, (index + 1) * 1500)
    })
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const clearResults = () => {
    setScanResults([])
  }

  return (
    <div className="p-8 space-y-8">
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
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          cyber-border rounded-xl p-12 transition-all cursor-pointer
          ${isDragging ? "border-primary bg-primary/5 scale-[1.02]" : "hover:border-primary/50"}
        `}
      >
        <input
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
          id="file-upload"
        />
        <label htmlFor="file-upload" className="cursor-pointer">
          <div className="flex flex-col items-center justify-center text-center">
            <div className={`
              w-20 h-20 rounded-2xl flex items-center justify-center mb-6 transition-all
              ${isDragging ? "bg-primary/20 border-primary" : "bg-primary/10 border-primary/30"}
              border
            `}>
              {isDragging ? (
                <Upload className="w-10 h-10 text-primary animate-bounce" />
              ) : (
                <FileSearch className="w-10 h-10 text-primary" />
              )}
            </div>
            
            <h3 className="text-lg font-mono font-semibold text-foreground mb-2">
              {isDragging ? "Solte os arquivos aqui" : "Arraste arquivos ou clique para selecionar"}
            </h3>
            <p className="text-sm text-muted-foreground max-w-md">
              Suportamos todos os tipos de arquivo. Os arquivos serão analisados localmente e não serão enviados para nenhum servidor.
            </p>
            
            <div className="flex items-center gap-4 mt-6">
              <div className="flex items-center gap-2 px-4 py-2 bg-secondary rounded-lg">
                <File className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs font-mono text-muted-foreground">Arquivos</span>
              </div>
              <div className="flex items-center gap-2 px-4 py-2 bg-secondary rounded-lg">
                <Folder className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs font-mono text-muted-foreground">Pastas</span>
              </div>
            </div>
          </div>
        </label>
      </div>

      {/* Scan Results */}
      {scanResults.length > 0 && (
        <div className="cyber-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-mono font-semibold text-foreground flex items-center gap-2">
              <FileSearch className="w-4 h-4 text-primary" />
              Resultados da Análise
            </h3>
            <div className="flex items-center gap-4">
              {isScanning && (
                <div className="flex items-center gap-2 text-primary">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-xs font-mono">Analisando...</span>
                </div>
              )}
              <button
                onClick={clearResults}
                className="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
              >
                <X className="w-3 h-3" />
                Limpar
              </button>
            </div>
          </div>
          
          <div className="space-y-3">
            {scanResults.map((result, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-4 bg-secondary/50 rounded-lg border border-border"
              >
                <div className="flex items-center gap-3">
                  <File className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="font-mono text-sm text-foreground">{result.name}</p>
                    <p className="text-xs text-muted-foreground">{result.size}</p>
                  </div>
                </div>
                
                <div className="flex items-center gap-2">
                  {result.status === "scanning" && (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-primary" />
                      <span className="text-xs font-mono text-primary">Analisando</span>
                    </>
                  )}
                  {result.status === "clean" && (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-cyber-green" />
                      <span className="text-xs font-mono text-cyber-green">Limpo</span>
                    </>
                  )}
                  {result.status === "infected" && (
                    <>
                      <AlertTriangle className="w-4 h-4 text-cyber-red" />
                      <span className="text-xs font-mono text-cyber-red">Ameaça detectada</span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          
          {/* Summary */}
          {!isScanning && scanResults.length > 0 && (
            <div className="mt-6 pt-6 border-t border-border">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <div className="text-2xl font-bold font-mono text-foreground">
                    {scanResults.length}
                  </div>
                  <div className="text-xs font-mono text-muted-foreground">Total</div>
                </div>
                <div>
                  <div className="text-2xl font-bold font-mono text-cyber-green">
                    {scanResults.filter(r => r.status === "clean").length}
                  </div>
                  <div className="text-xs font-mono text-muted-foreground">Limpos</div>
                </div>
                <div>
                  <div className="text-2xl font-bold font-mono text-cyber-red">
                    {scanResults.filter(r => r.status === "infected").length}
                  </div>
                  <div className="text-xs font-mono text-muted-foreground">Infectados</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <button className="cyber-border rounded-xl p-6 text-left hover:border-primary/50 transition-all group">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
              <Folder className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h3 className="font-mono font-semibold text-foreground group-hover:text-primary transition-colors">
                Scan de Pasta
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                Analise uma pasta inteira recursivamente
              </p>
            </div>
          </div>
        </button>
        
        <button className="cyber-border rounded-xl p-6 text-left hover:border-primary/50 transition-all group">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-cyber-cyan/10 border border-cyber-cyan/30 flex items-center justify-center group-hover:bg-cyber-cyan/20 transition-colors">
              <FileSearch className="w-6 h-6 text-cyber-cyan" />
            </div>
            <div>
              <h3 className="font-mono font-semibold text-foreground group-hover:text-cyber-cyan transition-colors">
                Análise Profunda
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                Verificação detalhada com heurística avançada
              </p>
            </div>
          </div>
        </button>
      </div>
    </div>
  )
}
