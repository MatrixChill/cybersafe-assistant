import path from "node:path";
import os from "node:os";
export class ExclusionManager {
    config;
    constructor(config) {
        const home = os.homedir();
        const cybersafeDir = path.join(home, ".cybersafe-service");
        this.config = {
            paths: config?.paths || [
                cybersafeDir,
            ],
            extensions: config?.extensions || [".tmp", ".log", ".cache", ".bak", ".dat"],
            files: config?.files || [],
        };
    }
    isExcluded(filePath) {
        if (!filePath)
            return true;
        const normalizedPath = path.normalize(filePath);
        const lowerPath = normalizedPath.toLowerCase();
        const ext = path.extname(lowerPath);
        const fileName = path.basename(lowerPath);
        if (this.config.paths.some(ex => lowerPath.startsWith(ex.toLowerCase()))) {
            return true;
        }
        if (this.config.extensions.includes(ext)) {
            return true;
        }
        if (this.config.files.includes(fileName)) {
            return true;
        }
        return false;
    }
    exclusionReason(filePath) {
        if (!filePath)
            return "empty path";
        const normalizedPath = path.normalize(filePath);
        const lowerPath = normalizedPath.toLowerCase();
        const ext = path.extname(lowerPath);
        const fileName = path.basename(lowerPath);
        for (const ex of this.config.paths) {
            if (lowerPath.startsWith(ex.toLowerCase())) {
                return `path matches exclusion: ${ex}`;
            }
        }
        if (this.config.extensions.includes(ext)) {
            return `extension excluded: ${ext}`;
        }
        if (this.config.files.includes(fileName)) {
            return `filename excluded: ${fileName}`;
        }
        return null;
    }
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }
    getConfig() {
        return { ...this.config };
    }
}
