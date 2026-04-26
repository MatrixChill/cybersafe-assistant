import path from "node:path";
import os from "node:os";
export class ExclusionManager {
    config;
    constructor(config) {
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
    isExcluded(filePath) {
        if (!filePath)
            return true;
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
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }
    getConfig() {
        return { ...this.config };
    }
}
