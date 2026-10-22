import { fromFile } from "@litko/yara-x";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
export class YaraEngine {
    scanner = null;
    rulesPath;
    constructor(rulesPath) {
        this.rulesPath = rulesPath || path.join(process.cwd(), "definitions", "yara", "default.yar");
    }
    async load(filePath) {
        this.rulesPath = filePath;
        await this.ensureRules();
    }
    /**
     * Garante que o arquivo de regras existe. Se não existir, tenta baixar um conjunto básico.
     */
    async ensureRules() {
        let shouldDownload = !existsSync(this.rulesPath);
        if (!shouldDownload) {
            // Validar se o arquivo existente não é lixo (HTML)
            const content = await fs.readFile(this.rulesPath, "utf-8");
            if (content.includes("<!DOCTYPE html>") || content.includes("<html") || content.trim() === "") {
                console.warn(`[YARA] Regras em ${this.rulesPath} parecem corrompidas. Redownloading...`);
                shouldDownload = true;
            }
        }
        if (shouldDownload) {
            console.log(`[YARA] Tentando baixar/recuperar regras em ${this.rulesPath}...`);
            try {
                await fs.mkdir(path.dirname(this.rulesPath), { recursive: true });
                const rawUrl = "https://raw.githubusercontent.com/Yara-Rules/rules/master/Malware/MALW_YARA_RULES/MALW_Gen_Common.yar";
                await execAsync(`curl -L "${rawUrl}" -o "${this.rulesPath}"`);
                const content = await fs.readFile(this.rulesPath, "utf-8");
                if (content.includes("<!DOCTYPE html>") || content.includes("<html")) {
                    throw new Error("Downloaded file is HTML, not YARA rules.");
                }
                console.log("[YARA] Regras baixadas com sucesso.");
            }
            catch (error) {
                console.error("[YARA] Falha ao obter regras remotas, usando fallback interno.");
                const basicRule = `
          rule Basic_Suspicious_Check {
            strings:
              $s1 = "powershell.exe" nocase
              $s2 = "cmd.exe /c" nocase
            condition:
              any of them
          }
        `;
                await fs.writeFile(this.rulesPath, basicRule, "utf-8");
            }
        }
        try {
            this.scanner = fromFile(this.rulesPath);
        }
        catch (error) {
            console.error("[YARA] Erro fatal ao carregar scanner YARA-X. Desativando motor YARA.");
            this.scanner = null;
        }
    }
    /**
     * Mantendo compatibilidade com a interface antiga para Buffers
     */
    match(buffer) {
        if (!this.scanner)
            return [];
        try {
            // O yara-x scanner.scan(buffer) retorna RuleMatch[]
            const results = this.scanner.scan(buffer);
            return results.map(r => ({
                ruleId: r.ruleIdentifier,
                label: r.ruleIdentifier,
                severity: "high" // Mapeamento simplificado
            }));
        }
        catch (error) {
            console.error("[YARA] Erro no scan de buffer:", error);
            return [];
        }
    }
    /**
     * Nova funcionalidade de scan de arquivo (mais eficiente que ler o buffer)
     */
    async scanFile(filePath) {
        if (!this.scanner) {
            await this.ensureRules();
        }
        if (!this.scanner)
            return [];
        try {
            const matches = await this.scanner.scanFileAsync(filePath);
            return matches.map(r => ({
                ruleId: r.ruleIdentifier,
                label: r.ruleIdentifier,
                severity: "high"
            }));
        }
        catch (error) {
            console.error(`[YARA] Falha no scan do arquivo ${filePath}:`, error);
            return [];
        }
    }
}
