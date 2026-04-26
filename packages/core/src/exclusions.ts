import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export interface ExclusionConfig {
  paths: string[];
  extensions: string[];
  files: string[];
}

export class ExclusionManager {
  private config: ExclusionConfig;

  constructor(config?: Partial<ExclusionConfig>) {
    const home = os.homedir();
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

    this.config = {
      paths: config?.paths || [
        'C:\\Games',
        path.join(home, 'Downloads'),
        'C:\\ProgramData\\chocolatey\\lib',
        'C:\\SteamLibrary',
        path.join(localAppData, 'Programs', 'Opera GX')
      ],
      extensions: config?.extensions || ['.tmp', '.log', '.cache', '.bak', '.dat'],
      files: config?.files || ['node.exe', 'npm.cmd', 'choco.exe', 'taskmgr.exe']
    };
  }

  /**
   * Verifica se um arquivo deve ser ignorado pela varredura.
   */
  public isExcluded(filePath: string): boolean {
    if (!filePath) return true;
    
    const normalizedPath = path.normalize(filePath);
    const lowerPath = normalizedPath.toLowerCase();
    const ext = path.extname(lowerPath);
    const fileName = path.basename(lowerPath);

    // 1. Verifica Caminhos Completos ou Pastas Pai
    if (this.config.paths.some(ex => lowerPath.startsWith(ex.toLowerCase()))) {
      return true;
    }

    // 2. Verifica Extensões
    if (this.config.extensions.includes(ext)) {
      return true;
    }

    // 3. Verifica Nomes Exatos de Arquivo
    if (this.config.files.includes(fileName)) {
      return true;
    }

    return false;
  }

  /**
   * Atualiza as exclusões em runtime.
   */
  public updateConfig(newConfig: Partial<ExclusionConfig>) {
    this.config = { ...this.config, ...newConfig };
  }

  public getConfig(): ExclusionConfig {
    return { ...this.config };
  }
}
