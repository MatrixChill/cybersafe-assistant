import chokidar from "chokidar";
import path from "node:path";
import fs from "fs-extra";
import { YaraScanner } from "@cybersafe/core";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private yara: YaraScanner;
  private quarantinePath: string;

  constructor(yaraScanner: YaraScanner, quarantinePath?: string) {
    this.yara = yaraScanner;
    this.quarantinePath = quarantinePath || path.join(process.cwd(), "quarantine");
  }

  public async start(watchPaths: string[]) {
    await fs.ensureDir(this.quarantinePath);
    
    this.watcher = chokidar.watch(watchPaths, {
      ignored: [
        /(^|[\/\\])\../, // ignora arquivos ocultos
        "**/node_modules/**",
        "**/dist/**",
        this.quarantinePath
      ],
      persistent: true,
      ignoreInitial: true
    });

    this.watcher.on("add", (filePath) => this.handleNewFile(filePath));
    this.watcher.on("change", (filePath) => this.handleNewFile(filePath));

    console.log(`[FileWatcher] Monitorando: ${watchPaths.join(", ")}`);
  }

  private async handleNewFile(filePath: string) {
    console.log(`[FileWatcher] Analisando novo arquivo: ${filePath}`);
    
    // 1. Scan com YARA
    const yaraResult = await this.yara.scanFile(filePath);
    
    if (yaraResult.matches) {
      console.warn(`[FileWatcher] ⚠️ YARA detectou ameaça em ${filePath}!`);
      await this.quarantine(filePath, "YARA Match: " + yaraResult.rules.map(r => r.ruleIdentifier).join(", "));
      return;
    }

    // 2. Scan com ClamAV (se disponível)
    try {
      const { stdout } = await execAsync(`clamscan "${filePath}"`);
      if (stdout.includes("FOUND")) {
        console.warn(`[FileWatcher] ⚠️ ClamAV detectou ameaça em ${filePath}!`);
        await this.quarantine(filePath, "ClamAV Match");
      }
    } catch (error: any) {
      // clamscan retorna exit code 1 se encontrar vírus, o que gera um erro no execAsync
      if (error.stdout && error.stdout.includes("FOUND")) {
        console.warn(`[FileWatcher] ⚠️ ClamAV detectou ameaça em ${filePath}!`);
        await this.quarantine(filePath, "ClamAV Match");
      }
    }
  }

  private async quarantine(filePath: string, reason: string) {
    const fileName = path.basename(filePath);
    const destination = path.join(this.quarantinePath, `${Date.now()}_${fileName}.infected`);
    
    try {
      await fs.move(filePath, destination);
      // No Windows, chmod 0o000 não funciona exatamente como no Linux, 
      // mas removemos as permissões de escrita/execução onde possível.
      await fs.chmod(destination, 0o000);
      
      console.log(`[QUARENTENA] Arquivo movido: ${fileName} -> ${destination}`);
      console.log(`[QUARENTENA] Motivo: ${reason}`);
      
      // Aqui poderíamos emitir um evento para o Electron mostrar na UI
    } catch (error) {
      console.error(`[QUARENTENA] Falha ao isolar arquivo ${filePath}:`, error);
    }
  }

  public stop() {
    if (this.watcher) {
      this.watcher.close();
    }
  }
}
