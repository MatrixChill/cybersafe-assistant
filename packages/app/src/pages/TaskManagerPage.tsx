import { useState } from "react";
import { Activity, Shield, Trash2, Cpu, HardDrive, AlertTriangle, AlertCircle, Search, RefreshCw, X } from "lucide-react";
import type { ProcessSnapshot, ProcessAnalysisResult } from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";

interface TaskManagerPageProps {
  processes: ProcessSnapshot[];
}

export default function TaskManagerPage({ processes }: TaskManagerPageProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<"cpu" | "mem" | "name">("cpu");
  const [analyzingPid, setAnalyzingPid] = useState<number | null>(null);
  const [analysisResult, setAnalysisResult] = useState<ProcessAnalysisResult | null>(null);
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [isKilling, setIsKilling] = useState(false);

  // Filter and sort processes
  const filteredProcesses = processes
    .filter((p) => p.name.toLowerCase().includes(searchTerm.toLowerCase()) || p.pid.toString().includes(searchTerm))
    .sort((a, b) => {
      if (sortBy === "cpu") return b.cpu - a.cpu;
      if (sortBy === "mem") return b.memoryMb - a.memoryMb;
      return a.name.localeCompare(b.name);
    });

  const handleAnalyze = async (pid: number) => {
    setAnalyzingPid(pid);
    setAnalysisResult(null);
    try {
      const result = await window.electronAPI.analyzeProcess(pid);
      setAnalysisResult(result);
    } catch (e) {
      console.error(e);
    } finally {
      setAnalyzingPid(null);
    }
  };

  const handleKill = async () => {
    if (!killingPid) return;
    setIsKilling(true);
    try {
      const result = await window.electronAPI.killProcessTree(killingPid);
      if (!result.success) {
        alert("Falha ao terminar processo. Pode ser um serviço protegido do sistema.");
      }
    } catch (e) {
      console.error(e);
      alert("Erro ao terminar processo.");
    } finally {
      setIsKilling(false);
      setKillingPid(null);
    }
  };

  return (
    <div className="p-8 h-full flex flex-col space-y-6 animate-in fade-in duration-500 relative">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tight">
            Gestor de <span className="text-primary">Tarefas</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Gestão avançada de processos e análise em tempo real
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Pesquisar processo..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 pr-4 py-2 bg-secondary/50 border border-border rounded-lg text-sm font-mono focus:outline-none focus:border-primary/50 text-foreground w-64 transition-all"
            />
          </div>
          <div className="bg-secondary/50 rounded-lg p-1 flex">
            <button
              onClick={() => setSortBy("cpu")}
              className={cn("px-3 py-1.5 text-xs font-mono rounded", sortBy === "cpu" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-white/5")}
            >
              CPU
            </button>
            <button
              onClick={() => setSortBy("mem")}
              className={cn("px-3 py-1.5 text-xs font-mono rounded", sortBy === "mem" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-white/5")}
            >
              RAM
            </button>
          </div>
        </div>
      </div>

      <div className="cyber-border rounded-xl flex-1 overflow-hidden flex flex-col">
        <div className="grid grid-cols-12 gap-4 items-center p-4 border-b border-border/50 bg-sidebar/50 text-xs font-mono font-semibold text-muted-foreground uppercase tracking-wider shrink-0">
          <div className="col-span-4">Nome do Processo</div>
          <div className="col-span-2 text-center">PID</div>
          <div className="col-span-2 text-center flex items-center justify-center gap-1"><Cpu className="w-3 h-3" /> CPU</div>
          <div className="col-span-2 text-center flex items-center justify-center gap-1"><HardDrive className="w-3 h-3" /> Memória</div>
          <div className="col-span-2 text-right">Ações</div>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-hide">
          {filteredProcesses.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground space-y-4">
              <Activity className="w-12 h-12 opacity-20" />
              <p className="font-mono text-sm">Nenhum processo encontrado</p>
            </div>
          ) : (
            <div className="flex flex-col p-2 space-y-1">
              {filteredProcesses.map((process) => {
                const isCritical = process.pid <= 100 || ["svchost.exe", "explorer.exe", "csrss.exe", "lsass.exe", "wininit.exe"].includes(process.name.toLowerCase());
                
                return (
                  <div key={process.pid} className="grid grid-cols-12 gap-4 items-center p-3 rounded-lg hover:bg-white/5 border border-transparent hover:border-white/5 transition-all group">
                    <div className="col-span-4 flex items-center gap-3 min-w-0">
                      <div className={cn("w-2 h-2 rounded-full shrink-0", 
                        process.cpu > 80 ? "bg-cyber-red animate-pulse" : 
                        process.cpu > 50 ? "bg-cyber-yellow" : "bg-cyber-cyan"
                      )} />
                      <div className="truncate flex flex-col min-w-0">
                        <span className="font-mono text-sm text-foreground truncate">{process.name}</span>
                        {process.user && <span className="text-[10px] text-muted-foreground truncate">{process.user}</span>}
                      </div>
                    </div>
                    <div className="col-span-2 text-center text-xs font-mono text-muted-foreground">{process.pid}</div>
                    <div className="col-span-2 text-center">
                      <span className={cn("text-xs font-mono px-2 py-1 rounded bg-black/20", process.cpu > 80 ? "text-cyber-red" : "text-foreground")}>
                        {process.cpu.toFixed(1)}%
                      </span>
                    </div>
                    <div className="col-span-2 text-center text-xs font-mono text-muted-foreground">
                      {process.memoryMb.toFixed(0)} MB
                    </div>
                    <div className="col-span-2 flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleAnalyze(process.pid)}
                        disabled={analyzingPid === process.pid}
                        className="p-2 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
                        title="Investigar Processo"
                      >
                        {analyzingPid === process.pid ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => setKillingPid(process.pid)}
                        disabled={isCritical}
                        className={cn("p-2 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed", 
                          "bg-cyber-red/10 text-cyber-red hover:bg-cyber-red/20")}
                        title={isCritical ? "Processo crítico protegido" : "Terminar Processo"}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Analysis Modal */}
      {analysisResult && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-2xl cyber-border border-primary/50 bg-card rounded-2xl shadow-2xl flex flex-col overflow-hidden">
            <div className="p-4 border-b border-border/50 flex justify-between items-center bg-secondary/50">
              <div className="flex items-center gap-3">
                <Shield className="w-5 h-5 text-primary" />
                <h2 className="font-mono font-bold">Relatório de Análise</h2>
              </div>
              <button onClick={() => setAnalysisResult(null)} className="text-muted-foreground hover:text-foreground">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 space-y-6 overflow-y-auto max-h-[70vh]">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xl font-mono font-bold text-primary">{analysisResult.process.name}</h3>
                  <p className="text-xs font-mono text-muted-foreground mt-1">PID: {analysisResult.process.pid} | Caminho: {analysisResult.process.path}</p>
                </div>
                <div className={cn("px-4 py-2 rounded-lg border font-mono uppercase text-sm flex items-center gap-2", 
                  analysisResult.recommendation === "dangerous" ? "bg-cyber-red/10 border-cyber-red/30 text-cyber-red" :
                  analysisResult.recommendation === "suspicious" ? "bg-cyber-yellow/10 border-cyber-yellow/30 text-cyber-yellow" :
                  "bg-cyber-green/10 border-cyber-green/30 text-cyber-green"
                )}>
                  {analysisResult.recommendation === "dangerous" && <AlertTriangle className="w-4 h-4" />}
                  {analysisResult.recommendation === "suspicious" && <AlertCircle className="w-4 h-4" />}
                  {analysisResult.recommendation === "safe" && <Shield className="w-4 h-4" />}
                  {analysisResult.recommendation === "dangerous" ? "Perigoso"
                    : analysisResult.recommendation === "suspicious" ? "Suspeito"
                      : "Seguro"}
                </div>
              </div>

              {analysisResult.fileScan && (
                <div className="space-y-2">
                  <h4 className="text-sm font-mono text-muted-foreground uppercase tracking-wider">Heurística Local</h4>
                  <div className="p-4 rounded-lg bg-secondary/30 border border-white/5 space-y-3">
                     <div className="flex justify-between items-center text-sm font-mono">
                        <span className="text-muted-foreground">Severidade</span>
                        <span className={analysisResult.fileScan.overallSeverity === "low" ? "text-cyber-green" : "text-cyber-red"}>{analysisResult.fileScan.overallSeverity.toUpperCase()}</span>
                     </div>
                     <div className="flex justify-between items-center text-sm font-mono">
                        <span className="text-muted-foreground">Pontuação de Risco</span>
                        <span>{analysisResult.fileScan.riskScore}/100</span>
                     </div>
                     {analysisResult.fileScan.rulesTriggered.length > 0 && (
                        <div className="text-xs font-mono mt-2 flex flex-wrap gap-2">
                          {analysisResult.fileScan.rulesTriggered.map((r: string) => (
                             <span key={r} className="px-2 py-1 bg-white/5 rounded border border-white/10">{r}</span>
                          ))}
                        </div>
                     )}
                  </div>
                </div>
              )}

              {analysisResult.virusTotal && (
                <div className="space-y-2">
                  <h4 className="text-sm font-mono text-muted-foreground uppercase tracking-wider border-t border-white/10 pt-4 flex justify-between items-center">
                    <span>Inteligência VirusTotal</span>
                    <span className="text-xs normal-case">{new Date(analysisResult.virusTotal.scanDate).toLocaleString()}</span>
                  </h4>
                  <div className="p-4 rounded-lg bg-[#0e1adb]/10 border border-[#0e1adb]/30 space-y-4">
                     <div className="flex justify-between items-center text-sm font-mono">
                        <span className="text-muted-foreground">Detecções</span>
                        <span className={analysisResult.virusTotal.positives > 0 ? "text-cyber-red font-bold" : "text-cyber-green"}>
                          {analysisResult.virusTotal.positives} / {analysisResult.virusTotal.total} motores
                        </span>
                     </div>
                     
                     {analysisResult.virusTotal.positives > 0 && (
                       <div className="space-y-2">
                         <p className="text-[10px] text-muted-foreground uppercase">Principais Motores:</p>
                         <div className="grid grid-cols-2 gap-2">
                           {analysisResult.virusTotal.engines.slice(0, 6).map((engine: import("@cybersafe/shared-types").VirusTotalEngine) => (
                             <div key={engine.name} className="p-2 rounded bg-black/40 border border-cyber-red/20 text-xs font-mono flex flex-col">
                               <span className="text-muted-foreground">{engine.name}</span>
                               <span className="text-cyber-red truncate">{engine.result}</span>
                             </div>
                           ))}
                         </div>
                       </div>
                     )}
                     <div className="flex justify-end pt-2">
                        <a href={analysisResult.virusTotal.permalink} target="_blank" rel="noreferrer" 
                           className="text-xs font-mono text-primary hover:underline flex items-center gap-1">
                           Ver relatório completo ↗
                        </a>
                     </div>
                  </div>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-border/50 bg-secondary/30 flex justify-end gap-3">
              <button 
                onClick={() => setAnalysisResult(null)}
                className="px-4 py-2 font-mono text-sm rounded bg-white/5 hover:bg-white/10 transition-colors"
              >
                Fechar
              </button>
              {analysisResult.recommendation !== "safe" && !analysisResult.isCritical && (
                 <button 
                   onClick={() => { setKillingPid(analysisResult.process.pid); setAnalysisResult(null); }}
                   className="px-4 py-2 font-mono text-sm rounded bg-cyber-red text-white hover:bg-cyber-red/90 transition-colors"
                 >
                   Terminar Ameaça
                 </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Kill Confirmation Modal */}
      {killingPid && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-sm cyber-border border-cyber-red/50 bg-card rounded-2xl shadow-lg p-6 text-center space-y-6">
            <div className="w-16 h-16 rounded-full bg-cyber-red/10 border border-cyber-red/30 mx-auto flex items-center justify-center">
              <AlertTriangle className="w-8 h-8 text-cyber-red animate-pulse" />
            </div>
            <div>
              <h2 className="text-lg font-mono font-bold text-foreground">Terminar Processo?</h2>
              <p className="text-sm font-mono text-muted-foreground mt-2">
                O processo pode estar sendo usado por um programa ativo. Qualquer alteração não guardada será perdida.
              </p>
            </div>
            <div className="flex gap-3 justify-center">
              <button 
                disabled={isKilling}
                onClick={() => setKillingPid(null)}
                className="flex-1 px-4 py-2 font-mono text-sm rounded bg-white/5 hover:bg-white/10 transition-colors"
              >
                Cancelar
              </button>
              <button 
                disabled={isKilling}
                onClick={handleKill}
                className="flex-1 px-4 py-2 font-mono text-sm rounded bg-cyber-red text-white hover:bg-cyber-red/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isKilling ? <RefreshCw className="w-4 h-4 animate-spin" /> : "Sim, Terminar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
