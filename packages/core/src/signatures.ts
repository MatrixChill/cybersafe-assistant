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
 *
 *  REGRA DESTE BLOCO: um hash só entra aqui se a SUA FAMÍLIA estiver provada
 *  por fonte pública citável, e o rótulo `family` tem de ser o que essa fonte
 *  diz. Não inventamos hashes e não inventamos famílias. Se não for possível
 *  provar, o hash NÃO entra — antes fica de fora.
 *
 *  Estado da base em 2026-09-30 (auditoria de proveniência):
 *   - 2 hashes WannaCry, ambos com família e ficheiro confirmados por 2 fontes.
 *   - 1 hash EICAR, que é um ficheiro de teste padronizado da indústria: valor
 *     determinístico, deteccão legítima, e é assim que se prova o pipeline.
 *   - 0 entradas sem prova. As duas entradas-placeholder que existiam aqui
 *     (rotuladas "Emotet-Trojan" e "TrickBot") foram removidas/corrigidas:
 *     a primeira era na verdade WannaCry (rótulo errado); a segunda não tem
 *     qualquer registo público e não é sequer provado que corresponda a
 *     TrickBot — muito menos a um ficheiro real.
 */
export const BUILTIN_HASH_SIGNATURES: SignatureRecord[] = [
  {
    // EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H* (68 bytes).
    // SHA-256 verificado localmente a partir do próprio texto, e é
    // determinístico por construção — ver test/signatures.test.js.
    // (MD5=44d88612fea8a8f36de82e1278abb02f. O valor de 64 hex que a base
    //  enviou antes comecava por esse MD5, mas nao reproduz nenhuma derivacao
    //  verificada: ver o motivo em RETIRED_HASH_SIGNATURES.)
    // É um canário de teste, não uma ameaça real: está aqui para que o
    // pipeline de detecção possa ser provado sem tocar em malware a sério.
    sha256: "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f",
    family: "EICAR-Test-File",
    severity: "critical",
    source: "built-in",
  },
  {
    // WannaCry / WannaCryptor — mssecsvc.exe (loader + componente worm),
    // 3 723 264 bytes, MD5 db349b97c37d22f5ea1d1841e3c89eb4.
    // Confirmado por 2 fontes independentes:
    //   - VMRay "WannaCry Ransomware | Files" (WanaDecrypt0r.bin.exe)
    //   - Mandiant "WannaCry Malware Profile" (mssecsvc.exe, mesmo MD5+tamanho)
    // TODO-EVIDENCE removido em 2026-09-30: a proveniência está provada.
    sha256: "24d004a104d4d54034dbcffc2a4b19a11f39008a575aa614ea04703480b1022c",
    family: "WannaCry-Ransomware",
    severity: "critical",
    source: "built-in",
  },
  {
    // WannaCry / WannaCryptor — tasksche.exe (loader), 3 514 368 bytes,
    // MD5 84c82835a5d21bbcf75a61706d8ab549.
    // Confirmado por 2 fontes independentes:
    //   - VMRay "WannaCry Ransomware | Files" (SHA-256 do tasksche.exe)
    //   - NJCCIC/NJ.gov, folha de perfil do WannaCry (lista este SHA-256)
    // RÓTULO CORRIGIDO em 2026-09-30: estava rotulado "Emotet-Trojan", o que
    // era FALSO. Duas fontes identificam esta amostra como WannaCry. Não há
    // Emotet nesta base. Manter um nome de malware errado num produto que diz
    // medir o que detecta é exactamente o defeito que não podemos ter.
    sha256: "ed01ebfbc9eb5bbea545af4d01bf5f1071661840480439c6e5babe8e080e41aa",
    family: "WannaCry-Ransomware",
    severity: "critical",
    source: "built-in",
  },
  // REMOVIDO em 2026-09-30:
  //   sha256 71b6a493388e7d0b40c83ce903bc6b04d1b59f386d5ebbf117a4c7e6c43310ce
  //   rotulado "TrickBot", severity high
  // Motivo: pesquisa pelo hash completo não devolve NENHUM registo de malware
  // — nem abuse.ch/MalwareBazaar, nem VirusTotal, nem qualquer vendor. Só
  // resultados irrelevantes (endereços Bitcoin com prefixo semelhante). Não
  // está provado que seja TrickBot, nem que seja o ficheiro de uma amostra
  // real. Uma entrada sem proveniência descredibiliza as que a têm, porque o
  // utilizador não tem como distinguir as duas. Se algum dia vier de uma
  // fonte citável, volta com a prova ao lado.
];

/**
 * Hashes RETIRADOS da base, por SÓ: é o SHA-256 que identifica uma amostra.
 *
 * REGRA DESTA LISTA: um hash entra aqui quando sabemos, com prova, que NÃO
 * representa o que a base dizia sobre ele. NUNCA entra um hash só porque "a
 * família parece-se com uma nossa" — `family` é metadata, não identidade, e uma
 * amostra externa legítima da mesma família tem de poder coexistir com as nossas
 * sem ser apagada. A regra antiga apagava por coincidência de família e
 * destruía entradas legítimas de terceiros.
 *
 * Retirar um hash é irreversível para o registo, por isso a lista é explícita e
 * cada entrada tem de dizer porquê.
 */
export const RETIRED_HASH_SIGNATURES: { sha256: string; reason: string }[] = [
  {
    // Motivo completo no comentário de remoção acima, em BUILTIN_HASH_SIGNATURES.
    sha256: "71b6a493388e7d0b40c83ce903bc6b04d1b59f386d5ebbf117a4c7e6c43310ce",
    reason:
      "Sem proveniencia: rotulado TrickBot, mas nenhum vendor publica esse hash. Nao esta provado que seja TrickBot nem que corresponda a um ficheiro real, e uma base em que o utilizador nao distingue a prova do chute perde credibilidade.",
  },
  {
    sha256: "44d88612fea8a8f36de82e1278abb02f2b8d6f66b0f0455d8f4f0d5dce9d734a",
    reason:
      "Valor fabricado que a base ja enviou. Verificavel: os 32 hex iniciais coincidem com o MD5 da string EICAR padrao (44d88612fea8a8f36de82e1278abb02f); o valor completo de 64 hex NAO reproduz nenhuma das derivacoes que verificamos (sha256 do hex do MD5, sha256 dos bytes do MD5, sha256 do texto EICAR, entre outras) e a sua derivacao e DESCONHECIDA. Nao corresponde a nenhum ficheiro real de amostra e nao ha proveniencia para ele. O EICAR autentico e 275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f (SHA-256 dos 68 bytes do texto EICAR).",
  },
];

/** Conjunto de consulta dos SHA-256 retirados (normalizados para minúsculas). */
const RETIRED_HASHES: Set<string> = new Set(
  RETIRED_HASH_SIGNATURES.map((record) => record.sha256.toLowerCase()),
);

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
    if (!/^[0-9a-f]{64}$/.test(hash) || unique.has(hash)) continue;
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
 * Conteúdo exato (31 bytes), SHA-256 verificado:
 * 83787f15463e771f919b8a92ed249765d41a3a581949585bb9364d5ba7e7db06
 *
 * O LITERAL não vive em src de produção. Se estivesse aqui, uma build
 * empacotada carregaria a assinatura e o scanner poderia sinalizar o próprio
 * bundle do CyberSafe. Vive apenas em fixtures de teste
 * (packages/core/test/fixtures/dev-canary.js e
 * packages/service/test/fixtures/dev-canary.js), que o registam em runtime.
 *
 * A deteção por hash (DEV_CANARY_SIGNATURE) continua em src e não contém o
 * literal. A deteção por conteúdo só existe depois de uma fixture registar o
 * conteúdo, logo é inerte numa app empacotada.
 */
let devCanaryContent = "";

/** Regista o conteúdo do canário. Só fixtures de teste devem chamar isto. */
export function setDevCanaryContent(content: string): void {
  devCanaryContent = content;
}

/** Conteúdo do canário registado; string vazia em qualquer app empacotada. */
export function getDevCanaryContent(): string {
  return devCanaryContent;
}

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

      // Um array com registos validos NAO e o mesmo que cobertura offline. Uma
      // base truncada (ou um feed que substituiu o ficheiro) pode ter entradas
      // legitimas e nao ter nenhuma das assinaturas built-in obrigatorias — o
      // EICAR incluido. Declarar `active` nesse caso dizia "a base esta boa"
      // com a deteccao offline em falta. O criterio NAO e o tamanho da base:
      // sao exactamente as assinaturas built-in cuja proveniencia esta provada.
      const missingBuiltins = REQUIRED_BUILTIN_HASHES.filter(
        (hash) => !records.some((record) => record.sha256.toLowerCase() === hash),
      );
      if (missingBuiltins.length > 0) {
        // Repor a cobertura em MEMORIA (sao registos built-in, nao inventados)
        // para nao perder deteccao; o ficheiro em disco NAO e tocado aqui —
        // load() nao escreve, e o refresh/ensureFile decidem a correcao.
        this.ensureOfflineCoverage();
        this._health = {
          status: "degraded",
          detail:
            `Base em ${filePath} com cobertura insuficiente: ${records.length} registo(s) válido(s), ` +
            `${missingBuiltins.length} built-in em falta repostos em memória (${this.records.size} no total). ` +
            `O ficheiro em disco não foi alterado.`,
        };
        console.warn(
          `[Hashes] ${filePath} sem cobertura offline completa (${missingBuiltins.length} built-in em falta). ` +
            `Cobertura reposta em memoria; base em disco preservada.`,
        );
        return;
      }

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

  /**
   * Remove APENAS hashes que a lista de retired declara (por SHA-256, nunca por
   * família). Regra: o SHA-256 é a identidade da amostra e a família é metadata.
   *
   * O que NÃO é apagado, e porquê:
   *   - um hash exterior legítimo cuja família coincida com uma de uma amostra
   *     nossa: nada prova que esteja errado, e apagá-lo seria destruir a
   *     proveniência de quem o registou (duas amostras da mesma família
   *     coexistem sem conflito);
   *   - um hash built-in com metadata desatualizada: é corrigido em
   *     ensureOfflineCoverage, nunca removido.
   *
   * Só sai daqui o que está em RETIRED_HASH_SIGNATURES, que é uma decisão com
   * prova anexa, não uma inferência a partir de um rótulo.
   */
  private healLegacyRecords(): boolean {
    let healed = false;
    for (const hash of Array.from(this.records.keys())) {
      if (RETIRED_HASHES.has(hash)) {
        this.records.delete(hash);
        healed = true;
      }
    }
    return healed;
  }

  /**
   * Garante que todos os hashes built-in (EICAR real incluído) estão presentes e
   * que a IDENTIDADE de cada um é a provada. Um hash built-in rotulado com outra
   * família (ex.: tasksche.exe como "Emotet-Trojan") é corrigido para a família
   * que duas fontes públicas confirmam: dizer "Emotet" sobre uma amostra
   * identificada como WannaCry é uma mentira sobre o que medimos.
   *
   * O `source` NÃO é tocado — é a proveniência de onde o registo veio
   * (ex.: "malwarebazaar") e continua válida depois da correção. A `severity`
   * também é preservada: é uma decisão local de política, não uma prova externa.
   */
  private ensureOfflineCoverage(): boolean {
    let changed = false;
    for (const record of SignatureDatabase.builtinRecords()) {
      const hash = record.sha256.toLowerCase();
      const existing = this.records.get(hash);
      if (!existing) {
        this.records.set(hash, record);
        changed = true;
        continue;
      }
      if (existing.family !== record.family) {
        this.records.set(hash, { ...existing, family: record.family });
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
   * Re-semeia o ficheiro em disco quando a base carregada precisa de
   * reconciliação: apaga APENAS os SHA-256 da lista RETIRED_HASH_SIGNATURES
   * (hashes que a base já enviou e não correspondem a um ficheiro real) e
   * corrige a `family` de um hash built-in que venha rotulado com outra,
   * preservando sempre o `source` (proveniência). Não apaga registos externos
   * só porque a `family` coincide com a de um built-in: a identidade é o
   * sha256, e a `family` é metadata.
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