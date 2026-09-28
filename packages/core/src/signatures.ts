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

/** Regras mínimas embutidas para funcionar offline, mesmo sem feeds remotos.
 *  Cada sha256 aqui listado foi verificado contra a amostra real (ou, quando
 *  não há evidência pública fidedigna, marcado com TODO-EVIDENCE) — nunca
 *  inventamos hashes. O EICAR (68 bytes) é o único cujo valor é determinístico
 *  e pode ser regenerado a partir do próprio texto. */
export const BUILTIN_HASH_SIGNATURES: SignatureRecord[] = [
  {
    // EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H* (68 bytes).
    // SHA-256 verificado: 275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f
    // (MD5=44d88612fea8a8f36de82e1278abb02f — o value anterior era o MD5
    //  concatenado com 32 hex zeros, o que é fabricado.)
    sha256: "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f",
    family: "EICAR-Test-File",
    severity: "critical",
    source: "built-in",
  },
  {
    // TODO-EVIDENCE: o sha256 listado não foi confirmado contra uma fonte
    // pública fidedigna (ex.: hash de ficheiro específico do WannaCry).
    // Manter como placeholder até haver amostra concreta; não adivinhar.
    sha256: "24d004a104d4d54034dbcffc2a4b19a11f39008a575aa614ea04703480b1022c",
    family: "WannaCry-Ransomware",
    severity: "critical",
    source: "built-in",
  },
  {
    // TODO-EVIDENCE: sha256 não confirmado contra amostra real do Emotet.
    sha256: "ed01ebfbc9eb5bbea545af4d01bf5f1071661840480439c6e5babe8e080e41aa",
    family: "Emotet-Trojan",
    severity: "critical",
    source: "built-in",
  },
  {
    // TODO-EVIDENCE: sha256 não confirmado contra amostra real do TrickBot.
    sha256: "71b6a493388e7d0b40c83ce903bc6b04d1b59f386d5ebbf117a4c7e6c43310ce",
    family: "TrickBot",
    severity: "high",
    source: "built-in",
  },
];

/**
 * Hashes que a base offline DEVE conter sempre (nomeadamente o EICAR real).
 * Usado como critério de saúde: uma base em disco que não os contenha é
 * considerada stale/corrompida e volta a ser semeada.
 */
const REQUIRED_BUILTIN_HASHES: string[] = BUILTIN_HASH_SIGNATURES.map((s) =>
  s.sha256.toLowerCase(),
);

const VALID_SEVERITIES = new Set(["low", "medium", "high", "critical"]);

function normalizeSeverity(value: unknown): SignatureRecord["severity"] {
  return typeof value === "string" && VALID_SEVERITIES.has(value)
    ? (value as SignatureRecord["severity"])
    : "medium";
}

/**
 * Converte um payload vindo do disco ou de um feed remoto numa lista de
 * registos utilizáveis. Descarta entradas inúteis (não-objetos, sem sha256,
 * duplicadas) em vez de rebentar — um feed parcial nunca pode corromper a
 * base, no máximo fica para o que já lá estava.
 */
export function sanitizeSignatureRecords(raw: unknown): SignatureRecord[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Map<string, SignatureRecord>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Partial<SignatureRecord>;
    if (typeof record.sha256 !== "string") continue;
    const hash = record.sha256.trim().toLowerCase();
    if (!hash || unique.has(hash)) continue;
    unique.set(hash, {
      sha256: hash,
      family:
        typeof record.family === "string" && record.family.trim()
          ? record.family
          : "Unknown",
      severity: normalizeSeverity(record.severity),
      source:
        typeof record.source === "string" && record.source.trim()
          ? record.source
          : "unknown",
    });
  }
  return Array.from(unique.values());
}

/**
 * Canário benigno para teste E2E do pipeline de deteção — 100% inofensivo,
 * não executa nada e substitui o EICAR real (que dispara o Windows Defender).
 * Conteúdo exato (31 bytes): "CYBERSAFE-E2E-TEST-SIGNATURE-v1"
 * SHA-256 verificado: 83787f15463e771f919b8a92ed249765d41a3a581949585bb9364d5ba7e7db06
 *
 * Ativo SOMENTE em dev/test (NODE_ENV !== "production"). Nunca entra na base
 * `records` (logo nunca é gravado no default.json nem numa build de produção).
 */
export const DEV_CANARY_CONTENT = "CYBERSAFE-E2E-TEST-SIGNATURE-v1";

export const DEV_CANARY_SIGNATURE: SignatureRecord = {
  sha256: "83787f15463e771f919b8a92ed249765d41a3a581949585bb9364d5ba7e7db06",
  family: "CyberSafe-Test-File",
  severity: "medium",
  source: "development-test",
};

/** O canário só existe fora de produção — em NODE_ENV=production nunca deteta. */
export function isDevCanaryEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

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

  /** Cópia limpa da base embutida (normalizada, sem estado partilhado). */
  private static builtinRecords(): SignatureRecord[] {
    return BUILTIN_HASH_SIGNATURES.map((s) => ({ ...s, sha256: s.sha256.toLowerCase() }));
  }

  /**
   * Uma base só é considerada saudável se contiver TODOS os hashes built-in
   * obrigatórios (EICAR real incluído). Sem isto, um ficheiro truncado ou um
   * feed parcial passariam por "active".
   */
  private static coversOffline(records: Iterable<SignatureRecord>): boolean {
    const hashes = new Set<string>();
    for (const record of records) hashes.add(record.sha256.toLowerCase());
    return REQUIRED_BUILTIN_HASHES.every((hash) => hashes.has(hash));
  }

  /**
   * Carrega a base de assinaturas. Nunca resulta numa base vazia: se o
   * ficheiro local não existir, estiver corrompido, não for um array ou não
   * tiver registos válidos, cai sempre na base embutida (offline). A base
   * remota é apenas uma atualização opcional — nunca um requisito.
   */
  async load(filePath: string) {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        console.warn(`[Hashes] ${filePath} não é um array de assinaturas. Usando base embutida.`);
        this.loadBuiltin(`Formato inválido em ${filePath}`);
        return;
      }
      const records = sanitizeSignatureRecords(parsed);
      if (records.length === 0) {
        console.warn(`[Hashes] ${filePath} está vazio ou sem registos válidos. Usando base embutida.`);
        this.loadBuiltin(`Base vazia ou inválida em ${filePath}`);
        return;
      }
      this.records = new Map(records.map((record) => [record.sha256, record]));
      this.loadedFrom = filePath;
      this._health = {
        status: "active",
        detail: `Loaded ${this.records.size} signature(s) from ${filePath}`,
      };
      console.log(`[Hashes] ${this.records.size} assinaturas carregadas de ${filePath}`);
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        this.loadBuiltin(`Ficheiro ${filePath} ausente`);
      } else if (error instanceof SyntaxError) {
        console.warn(`[Hashes] Ficheiro ${filePath} corrompido (JSON inválido). Usando base embutida.`);
        this.loadBuiltin(`JSON inválido em ${filePath}`);
      } else {
        // Erro de I/O (permissões, disco cheio, etc.): NUNCA descartamos a base
        // já carregada — perder a base offline é sempre pior do que ficar com
        // uma base possivelmente desatualizada.
        const reason = error?.message ?? "unknown";
        console.error(`[Hashes] Erro ao carregar ${filePath}:`, error);
        if (this.records.size > 0) {
          this._health = {
            status: "degraded",
            detail: `Falha a ler ${filePath} (${reason}); base preservada em memória (${this.records.size} registos).`,
          };
        } else {
          this.loadBuiltin(`Falha a ler ${filePath} (${reason})`);
        }
      }
    }
  }

  /** Carrega a base embutida quando o ficheiro ou o feed remoto falham. */
  private loadBuiltin(reason = "Remote feed unavailable") {
    const builtin = SignatureDatabase.builtinRecords();
    this.records = new Map(builtin.map((record) => [record.sha256, record]));
    this.loadedFrom = "built-in";
    this._health = {
      status: this.records.size > 0 ? "degraded" : "unavailable",
      detail: `Offline built-in signatures (${this.records.size} records). ${reason}.`,
    };
    console.log(`[Hashes] Usando base embutida offline (${this.records.size} registos).`);
  }

  /** Lê e valida a base em disco (`ok: false` = ausente/vazio/corrompido). */
  private async readRecordsFromDisk(
    filePath: string,
  ): Promise<{ ok: true; records: SignatureRecord[] } | { ok: false; reason: string }> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      if (!raw.trim()) return { ok: false, reason: "ficheiro vazio" };
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return { ok: false, reason: "JSON inválido (esperado array)" };
      const records = sanitizeSignatureRecords(parsed);
      if (records.length === 0) return { ok: false, reason: "base sem registos válidos" };
      return { ok: true, records };
    } catch (error: any) {
      if (error?.code === "ENOENT") return { ok: false, reason: "ficheiro ausente" };
      if (error instanceof SyntaxError) return { ok: false, reason: "JSON inválido" };
      return { ok: false, reason: error?.message ?? "erro de leitura" };
    }
  }

  /** Remove hashes legados/fabricados (mesma family, sha256 diferente). */
  private healLegacyRecords(): boolean {
    const freshByFamily = new Map<string, string>();
    for (const record of BUILTIN_HASH_SIGNATURES) {
      freshByFamily.set(record.family.toLowerCase(), record.sha256.toLowerCase());
    }
    let healed = false;
    for (const [hash, record] of Array.from(this.records)) {
      const family = typeof record.family === "string" ? record.family.toLowerCase() : "";
      const fresh = freshByFamily.get(family);
      if (fresh && fresh !== hash) {
        this.records.delete(hash);
        healed = true;
      }
    }
    return healed;
  }

  /** Garante que todos os hashes built-in (EICAR real incluído) estão presentes. */
  private ensureOfflineCoverage(): boolean {
    let changed = false;
    for (const record of SignatureDatabase.builtinRecords()) {
      if (!this.records.has(record.sha256)) {
        this.records.set(record.sha256, record);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Gravação atómica: escreve num ficheiro temporário e faz rename. Um erro a
   * meio (disco cheio, permissões) deixa o ficheiro original INTACTO — nunca
   * truncamos a base offline. Recusa explicitamente gravar uma base vazia.
   */
  async save(filePath: string) {
    if (this.records.size === 0) {
      throw new Error(
        "Recusado gravar uma base de assinaturas vazia (fail-safe): a base offline seria perdida.",
      );
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload = JSON.stringify(Array.from(this.records.values()), null, 2);
    const tmpPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      await fs.writeFile(tmpPath, payload, "utf-8");
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * Garante que existe uma base offline utilizável em `filePath`:
   * - ficheiro ausente, vazio ou corrompido ⇒ re-semeia a base embutida;
   * - ficheiro válido mas sem cobertura built-in ⇒ cura e regrava;
   * - falha de escrita ⇒ propaga o erro SEM apagar nada do que já existe.
   */
  async ensureFile(filePath: string) {
    const disk = await this.readRecordsFromDisk(filePath);
    if (!disk.ok && existsSync(filePath)) {
      // existe mas está vazio/corrompido: só se substitui com uma base válida.
      console.warn(
        `[Hashes] ${filePath} inválido em disco (${disk.reason}). Re-semeando base offline.`,
      );
    }

    if (this.records.size === 0) {
      if (disk.ok) {
        this.records = new Map(disk.records.map((record) => [record.sha256, record]));
        this.loadedFrom = filePath;
      } else {
        this.loadBuiltin("Base ainda não carregada");
      }
    }

    const healed = this.healLegacyRecords();
    const covered = this.ensureOfflineCoverage();

    if (disk.ok && !healed && !covered) return; // já está bom: não mexe no ficheiro

    await this.save(filePath);
    this.loadedFrom = filePath;
    this._health = {
      status: "active",
      detail: `Seeded ${this.records.size} built-in signature(s) into ${filePath}`,
    };
  }

  /**
   * Re-semeia o ficheiro em disco quando a base carregada contém registos
   * legados/fabricados que não existem na base built-in actual (ex.: o hash
   * EICAR que era o MD5 + 32 hex zeros). Substitui registos com a mesma
   * family mas sha256 diferente pelo built-in correcto; não apaga registos
   * válidos do utilizador que não estão na base embutida.
   *
   * Reconcilia sempre com o estado do DISCO: se o ficheiro estiver ausente,
   * vazio, corrompido ou sem o EICAR, volta a ser semeado — mesmo que a base
   * em memória já esteja correta. Falha de escrita é fail-safe: mantém a base
   * em memória e degrada o health em vez de declarar "active".
   */
  async refreshBuiltinIfStale(filePath: string): Promise<boolean> {
    if (this.records.size === 0) this.loadBuiltin("Base vazia em memória");

    let changed = this.healLegacyRecords();
    if (this.ensureOfflineCoverage()) changed = true;

    const disk = await this.readRecordsFromDisk(filePath);
    const diskNeedsRewrite =
      !disk.ok || !SignatureDatabase.coversOffline(disk.records) || changed;

    if (!diskNeedsRewrite) return false;

    try {
      await this.save(filePath);
      this.loadedFrom = filePath;
      this._health = {
        status: "active",
        detail: `Refreshed ${this.records.size} signature(s) from built-in`,
      };
      return true;
    } catch (error: any) {
      // Fail-safe: a base em memória continua intacta e nada é apagado.
      this._health = {
        status: this.records.size > 0 ? "degraded" : "error",
        detail: `Refresh falhou (${error?.message ?? "unknown"}); base offline preservada em memória (${this.records.size} registos).`,
      };
      console.error(`[Hashes] Falha ao refrescar ${filePath}:`, error);
      return false;
    }
  }

  /**
   * Aplica um feed remoto de hashes de forma fail-safe (usado pelo updater):
   * um feed vazio, parcial ou corrompido NUNCA apaga a base offline. Mescla
   * o que é válido, garante a cobertura built-in (EICAR real incluído) e só
   * regrava o ficheiro com sucesso; qualquer falha reverte tudo em memória.
   */
  async applyRemoteRecords(
    filePath: string,
    incoming: unknown,
  ): Promise<{ applied: boolean; total: number; reason?: string }> {
    if (this.records.size === 0) this.loadBuiltin("Base ainda não carregada");

    const candidates = sanitizeSignatureRecords(incoming);
    if (candidates.length === 0) {
      return {
        applied: false,
        total: this.records.size,
        reason: "Feed remoto vazio ou inválido — base offline preservada.",
      };
    }

    const previous = new Map(this.records);
    this.healLegacyRecords();
    for (const record of candidates) this.records.set(record.sha256, record);
    this.ensureOfflineCoverage();

    if (this.records.size === 0) {
      this.records = previous;
      return { applied: false, total: previous.size, reason: "Feed não alterou a base." };
    }

    try {
      await this.save(filePath);
    } catch (error: any) {
      this.records = previous; // rollback completo — nada é perdido
      this._health = {
        status: "degraded",
        detail: `Feed remoto não aplicado (${error?.message ?? "unknown"}); base preservada (${previous.size} registos).`,
      };
      return {
        applied: false,
        total: previous.size,
        reason: `Falha a gravar: ${error?.message ?? "unknown"} — base preservada.`,
      };
    }

    this.loadedFrom = filePath;
    this._health = {
      status: "active",
      detail: `${this.records.size} signature(s) (feed remoto aplicado, cobertura offline preservada)`,
    };
    return { applied: true, total: this.records.size };
  }

  match(sha256: string): SignatureRecord | undefined {
    const lower = sha256.toLowerCase();
    const hit = this.records.get(lower);
    if (hit) return hit;

    // Em modo DEV/teste, reconhece o canário benigno para permitir testes E2E
    // sem disparar o bloqueio automático do Windows Defender.
    if (isDevCanaryEnabled() && lower === DEV_CANARY_SIGNATURE.sha256.toLowerCase()) {
      return DEV_CANARY_SIGNATURE;
    }

    return undefined;
  }

  add(record: SignatureRecord) {
    this.records.set(record.sha256.toLowerCase(), record);
  }
}