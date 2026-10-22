import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ProcessAlert {
  pid: number;
  name: string;
  commandLine: string;
  timestamp: string;
}

export class ProcessMonitor {
  /**
   * Verifica processos suspeitos no Windows usando WMIC para capturar a linha de comando completa.
   */
  public async checkSuspiciousProcesses(): Promise<ProcessAlert[]> {
    try {
      // No Windows, usamos wmic para obter ProcessId, Name e CommandLine
      // O formato csv facilita o parse
      const { stdout } = await execAsync('wmic process get processid,name,commandline /format:csv');
      
      const lines = stdout.split('\n').filter(line => line.trim() !== "");
      const alerts: ProcessAlert[] = [];

      const suspiciousPatterns = [
        /powershell.*-nop.*-ep.*bypass/i,
        /powershell.*-encodedcommand/i,
        /cmd\.exe.*\/c.*del/i,
        /wscript\.exe.*vbscript:/i,
        /mshta\.exe.*http/i,
        /bitsadmin.*\/transfer/i,
        /certutil.*-urlcache.*-split.*-f/i
      ];

      // Ignora o cabeçalho (Node,CommandLine,Name,ProcessId)
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length < 4) continue;

        const commandLine = parts[1] || "";
        const name = parts[2] || "";
        const pid = parseInt(parts[3] || "0");

        if (suspiciousPatterns.some(pattern => pattern.test(commandLine))) {
          alerts.push({
            pid,
            name,
            commandLine,
            timestamp: new Date().toISOString()
          });
        }
      }

      return alerts;
    } catch (error) {
      console.error("[ProcessMonitor] Erro ao verificar processos:", error);
      return [];
    }
  }

  /**
   * Versão para Linux/macOS (usando ps)
   */
  public async checkSuspiciousProcessesUnix(): Promise<ProcessAlert[]> {
    try {
      const { stdout } = await execAsync('ps -eo pid,comm,args');
      const lines = stdout.split('\n').filter(line => line.trim() !== "");
      const alerts: ProcessAlert[] = [];
      
      // Lógica de parse similar para Unix...
      // (Omitido por brevidade, focando no Windows conforme o ambiente do usuário)
      
      return alerts;
    } catch (error) {
      return [];
    }
  }
}
