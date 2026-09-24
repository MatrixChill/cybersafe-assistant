import { fromFile, compile, type YaraX } from "@litko/yara-x";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { EngineSubsystemHealth } from "@cybersafe/shared-types";

export interface YaraMatch {
  ruleId: string;
  label: string;
  severity: "high" | "critical";
}

const FALLBACK_RULES = `
rule Basic_Suspicious_Check
{
  strings:
    $s1 = "powershell.exe" nocase
    $s2 = "cmd.exe /c" nocase
  condition:
    any of them
}
`;

export class YaraEngine {
  private scanner: YaraX | null = null;
  private rulesPath: string;
  private _health: EngineSubsystemHealth = { status: "unavailable", detail: "Not initialized" };
  private _ruleCount = 0;

  constructor(rulesPath?: string) {
    this.rulesPath = rulesPath || path.join(process.cwd(), "definitions", "yara", "default.yar");
  }

  get health(): EngineSubsystemHealth {
    return this._health;
  }

  get ruleCount(): number {
    return this._ruleCount;
  }

  get isAvailable(): boolean {
    return this.scanner !== null;
  }

  async load(filePath: string) {
    this.rulesPath = filePath;
    await this.ensureRules();
  }

  private async ensureRules(): Promise<void> {
    let ruleSource: "file" | "fallback" | null = null;
    let shouldWriteFallback = false;
    let ruleContent: string | null = null;

    if (existsSync(this.rulesPath)) {
      try {
        const content = await fs.readFile(this.rulesPath, "utf-8");

        // Rejeita conteúdo JSON (ex.: default.json carregado acidentalmente como regras)
        // e conteúdo HTML (download corrompido). JSON válido começa com "[" ou "{".
        const trimmed = content.trim();
        const looksLikeJson = trimmed.startsWith("[") || trimmed.startsWith("{");
        if (
          trimmed === "" ||
          content.includes("<!DOCTYPE html>") ||
          content.includes("<html") ||
          looksLikeJson
        ) {
          console.warn(`[YARA] Conteúdo de ${this.rulesPath} não parece YARA válido. Correção por fallback.`);
          shouldWriteFallback = true;
        } else if (content.includes("rule ")) {
          ruleSource = "file";
          ruleContent = content;
        } else {
          shouldWriteFallback = true;
        }
      } catch {
        shouldWriteFallback = true;
      }
    } else {
      shouldWriteFallback = true;
    }

    if (shouldWriteFallback) {
      try {
        await fs.mkdir(path.dirname(this.rulesPath), { recursive: true });
        await fs.writeFile(this.rulesPath, FALLBACK_RULES, "utf-8");
        ruleSource = "fallback";
        ruleContent = FALLBACK_RULES;
        console.log("[YARA] Regras fallback escritas em", this.rulesPath);
      } catch (err) {
        console.error("[YARA] Não foi possível escrever fallback:", err);
      }
    }

    if (!ruleContent) {
      this._health = { status: "error", detail: "No rules content available" };
      this.scanner = null;
      return;
    }

    try {
      // 1. Tenta fromFile (o nativo lê diretamente o ficheiro).
      this.scanner = fromFile(this.rulesPath);
    } catch (fileErr: any) {
      // 2. Fallback: compile a partir do conteúdo lido via Node fs (contorna
      //    problemas de leitura de path nativo, ex.: dentro de ASAR).
      try {
        this.scanner = compile(ruleContent);
        console.warn("[YARA] fromFile falhou; scanner criado via compile(string).", fileErr?.message);
      } catch (compileErr: any) {
        console.error("[YARA] Erro fatal ao carregar YARA-X (fromFile e compile):", compileErr?.message ?? compileErr);
        this.scanner = null;
        this._health = { status: "error", detail: `YARA-X load failed: ${compileErr?.message ?? "unknown"}` };
        return;
      }
    }

    this._ruleCount = await this.countRules(this.rulesPath);
    this._health = {
      status: ruleSource === "fallback" ? "degraded" : "active",
      detail: ruleSource === "fallback"
        ? "Using built-in fallback rules (remote feeds unavailable)"
        : `Loaded ${this._ruleCount} rule(s) from file`,
    };
    console.log(`[YARA] Scanner carregado (${ruleSource}). Regras: ${this._ruleCount}`);
  }

  private async countRules(filePath: string): Promise<number> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const matches = content.match(/^rule\s+\w+/gm);
      return matches ? matches.length : 0;
    } catch {
      return 0;
    }
  }

  match(buffer: Buffer): YaraMatch[] {
    if (!this.scanner) return [];

    try {
      const results = this.scanner.scan(buffer);
      return results.map(r => ({
        ruleId: r.ruleIdentifier,
        label: r.ruleIdentifier,
        severity: "high" as const,
      }));
    } catch (error) {
      console.error("[YARA] Erro no scan de buffer:", error);
      return [];
    }
  }

  async scanFile(filePath: string): Promise<YaraMatch[]> {
    if (!this.scanner) {
      await this.ensureRules();
    }
    if (!this.scanner) return [];

    try {
      const matches = await this.scanner.scanFileAsync(filePath);
      return matches.map(r => ({
        ruleId: r.ruleIdentifier,
        label: r.ruleIdentifier,
        severity: "high" as const,
      }));
    } catch (error) {
      console.error(`[YARA] Falha no scan do arquivo ${filePath}:`, error);
      return [];
    }
  }
}
