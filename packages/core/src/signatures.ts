import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import type { EngineSubsystemHealth } from "@cybersafe/shared-types";

export interface SignatureRecord {
  sha256: string;
  family: string;
  severity: "low" | "medium" | "high" | "critical";
  source: string;
}

/** Regras mínimas embutidas para funcionar offline, mesmo sem feeds remotos. */
export const BUILTIN_HASH_SIGNATURES: SignatureRecord[] = [
  {
    sha256: "44d88612fea8a8f36de82e1278abb02f2b8d6f66b0f0455d8f4f0d5dce9d734a",
    family: "EICAR-Test-File",
    severity: "critical",
    source: "built-in",
  },
  {
    sha256: "24d004a104d4d54034dbcffc2a4b19a11f39008a575aa614ea04703480b1022c",
    family: "WannaCry-Ransomware",
    severity: "critical",
    source: "built-in",
  },
  {
    sha256: "ed01ebfbc9eb5bbea545af4d01bf5f1071661840480439c6e5babe8e080e41aa",
    family: "Emotet-Trojan",
    severity: "critical",
    source: "built-in",
  },
  {
    sha256: "71b6a493388e7d0b40c83ce903bc6b04d1b59f386d5ebbf117a4c7e6c43310ce",
    family: "TrickBot",
    severity: "high",
    source: "built-in",
  },
];

export class SignatureDatabase {
  private records = new Map<string, SignatureRecord>();
  private _health: EngineSubsystemHealth = { status: "unavailable", detail: "Not loaded" };
  private loadedFrom: string | null = null;

  get health(): EngineSubsystemHealth {
    return this._health;
  }

  get size(): number {
    return this.records.size;
  }

  get source(): string | null {
    return this.loadedFrom;
  }

  /**
   * Carrega a base de assinaturas. Se o ficheiro local não existir ou estiver
   * corrompido, carrega a base embutida (offline). A base remota é apenas uma
   * atualização opcional — nunca um requisito para funcionar.
   */
  async load(filePath: string) {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as SignatureRecord[];
      if (!Array.isArray(parsed)) throw new Error("Formato inválido: esperado array.");
      this.records = new Map(parsed.map((record) => [record.sha256.toLowerCase(), record]));
      this.loadedFrom = filePath;
      this._health = {
        status: "active",
        detail: `Loaded ${this.records.size} signature(s) from ${filePath}`,
      };
      console.log(`[Hashes] ${this.records.size} assinaturas carregadas de ${filePath}`);
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        this.loadBuiltin();
      } else if (error instanceof SyntaxError) {
        console.warn(`[Hashes] Ficheiro ${filePath} corrompido (JSON inválido). Usando base embutida.`);
        this.loadBuiltin();
      } else {
        console.error(`[Hashes] Erro ao carregar ${filePath}:`, error);
        this._health = { status: "error", detail: error?.message ?? "unknown" };
      }
    }
  }

  /** Carrega a base embutida quando o ficheiro ou o feed remoto falham. */
  private loadBuiltin() {
    this.records = new Map(BUILTIN_HASH_SIGNATURES.map((s) => [s.sha256.toLowerCase(), s]));
    this.loadedFrom = "built-in";
    this._health = {
      status: this.records.size > 0 ? "degraded" : "unavailable",
      detail: `Offline built-in signatures (${this.records.size} records). Remote feed unavailable.`,
    };
    console.log(`[Hashes] Usando base embutida offline (${this.records.size} registos).`);
  }

  async save(filePath: string) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify(Array.from(this.records.values()), null, 2),
      "utf-8",
    );
  }

  /** Garante que existe pelo menos a base embutida num ficheiro. */
  async ensureFile(filePath: string) {
    if (existsSync(filePath)) return;
    await this.save(filePath);
    this.loadedFrom = filePath;
    this._health = { status: "active", detail: `Seeded ${this.records.size} built-in signature(s)` };
  }

  match(sha256: string): SignatureRecord | undefined {
    return this.records.get(sha256.toLowerCase());
  }

  add(record: SignatureRecord) {
    this.records.set(record.sha256.toLowerCase(), record);
  }
}