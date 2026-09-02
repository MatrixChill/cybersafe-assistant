import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as https from "node:https";
import * as http from "node:http";
import { spawn } from "node:child_process";

// ── Configuration ────────────────────────────────────────────────────────────
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 horas

// Fontes de regras YARA — lista de fallback
const YARA_SOURCES = [
  "https://raw.githubusercontent.com/Yara-Rules/rules/master/malware/MALW_Eicar.yar",
  "https://raw.githubusercontent.com/Yara-Rules/rules/master/packers/packer_compiler_signatures.yar",
  "https://raw.githubusercontent.com/Yara-Rules/rules/master/crypto/crypto_signatures.yar",
  "https://raw.githubusercontent.com/Yara-Rules/rules/master/malware/MALW_Ransomware_Generic.yar"
];

// MalwareBazaar API endpoint
const HASH_FEED_URL = "https://mb-api.abuse.ch/api/v1/";

export interface UpdateResult {
  yaraUpdated: boolean;
  clamUpdated: boolean;
  hashesUpdated: boolean;
  errors: string[];
  timestamp: string;
}

export class DefinitionUpdater {
  private readonly definitionsDir: string;
  private readonly yaraPath: string;
  private readonly hashesPath: string;
  private readonly metaPath: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(definitionsDir: string) {
    this.definitionsDir = definitionsDir;
    this.yaraPath = path.join(definitionsDir, "yara", "default.yar");
    this.hashesPath = path.join(definitionsDir, "hashes", "default.json");
    this.metaPath = path.join(definitionsDir, ".update-meta.json");
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Verifica se já passou o intervalo e, se sim, atualiza.
   * Retorna o resultado da operação.
   */
  async checkAndUpdate(force = false): Promise<UpdateResult> {
    const result: UpdateResult = {
      yaraUpdated: false,
      clamUpdated: false,
      hashesUpdated: false,
      errors: [],
      timestamp: new Date().toISOString(),
    };

    if (!force) {
      const lastUpdate = this.getLastUpdateTimestamp();
      if (Date.now() - lastUpdate < UPDATE_INTERVAL_MS) {
        console.log("[Updater] Definições ainda frescas, pulando atualização.");
        return result;
      }
    }

    console.log("[Updater] Iniciando atualização de definições...");

    // 1. YARA Rules
    try {
      await this.updateYaraRules();
      result.yaraUpdated = true;
      console.log("[Updater] Regras YARA atualizadas.");
    } catch (err: any) {
      result.errors.push(`YARA: ${err.message}`);
      console.error("[Updater] Falha ao atualizar YARA:", err.message);
    }

    // 2. ClamAV via freshclam
    try {
      await this.updateClamAV();
      result.clamUpdated = true;
      console.log("[Updater] ClamAV atualizado via freshclam.");
    } catch (err: any) {
      // ClamAV não é obrigatório — freshclam pode não estar instalado
      result.errors.push(`ClamAV: ${err.message}`);
      console.warn("[Updater] freshclam indisponível ou falhou:", err.message);
    }

    // 3. Hash feed
    try {
      await this.updateHashFeed();
      result.hashesUpdated = true;
      console.log("[Updater] Feed de hashes atualizado.");
    } catch (err: any) {
      result.errors.push(`Hashes: ${err.message}`);
      console.warn("[Updater] Falha ao atualizar hashes:", err.message);
    }

    // Salva timestamp somente se pelo menos algo atualizou
    if (result.yaraUpdated || result.clamUpdated || result.hashesUpdated) {
      this.saveUpdateTimestamp();
    }

    console.log("[Updater] Ciclo finalizado.", JSON.stringify(result));
    return result;
  }

  /**
   * Inicia o scheduler periódico. Roda um check imediato + setInterval.
   */
  startScheduler(): void {
    if (this.timer) return;
    console.log(`[Updater] Scheduler iniciado (intervalo: ${UPDATE_INTERVAL_MS / 3600000}h).`);

    // Check imediato (non-blocking)
    void this.checkAndUpdate().catch((err) =>
      console.error("[Updater] Erro no check inicial:", err),
    );

    this.timer = setInterval(() => {
      void this.checkAndUpdate().catch((err) =>
        console.error("[Updater] Erro no check periódico:", err),
      );
    }, UPDATE_INTERVAL_MS);
  }

  /**
   * Para o scheduler.
   */
  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── Private: YARA ──────────────────────────────────────────────────────────

  private async updateYaraRules(): Promise<void> {
    await fsPromises.mkdir(path.dirname(this.yaraPath), { recursive: true });

    // Tenta cada fonte em ordem
    let lastError: Error | null = null;
    for (const url of YARA_SOURCES) {
      try {
        const content = await this.downloadText(url);
        // Validação: regras YARA devem conter "rule "
        if (!content.includes("rule ") || content.includes("<!DOCTYPE html>")) {
          throw new Error("Conteúdo baixado não parece ser YARA válido.");
        }
        await fsPromises.writeFile(this.yaraPath, content, "utf-8");
        return; // Sucesso
      } catch (err: any) {
        lastError = err;
        console.warn(`[Updater] Fonte YARA falhou (${url}):`, err.message);
      }
    }
    throw lastError ?? new Error("Todas as fontes YARA falharam.");
  }

  // ── Private: ClamAV ────────────────────────────────────────────────────────

  public static activeProcesses = new Set<import("child_process").ChildProcess>();

  public static dispose() {
    console.log(`[Updater] Terminando ${this.activeProcesses.size} processos de update pendentes...`);
    for (const p of this.activeProcesses) {
      try { p.kill('SIGKILL'); } catch {}
    }
    this.activeProcesses.clear();
  }

  private updateClamAV(): Promise<void> {
    return new Promise((resolve, reject) => {
      const clamDbDir = path.join(this.definitionsDir, "clamav");
      fs.mkdirSync(clamDbDir, { recursive: true });

      const child = spawn("freshclam", ["--quiet", `--datadir=${clamDbDir}`], {
        stdio: "pipe",
        windowsHide: true,
        timeout: 120_000, // 2 min timeout
      });
      DefinitionUpdater.activeProcesses.add(child);

      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        DefinitionUpdater.activeProcesses.delete(child);
        reject(new Error(`freshclam não encontrado ou falhou: ${err.message}`));
      });

      child.on("close", (code) => {
        DefinitionUpdater.activeProcesses.delete(child);
        if (code === 0) resolve();
        else reject(new Error(`freshclam exit code ${code}: ${stderr.trim()}`));
      });
    });
  }

  // ── Private: Hash Feed ─────────────────────────────────────────────────────

  private async updateHashFeed(): Promise<void> {
    await fsPromises.mkdir(path.dirname(this.hashesPath), { recursive: true });

    // Download from MalwareBazaar API (requires POST)
    const content = await this.downloadMalwareBazaar();

    let remoteFeeds: any[] = [];
    try {
      const parsed = JSON.parse(content);
      if (parsed.query_status === "ok" && Array.isArray(parsed.data)) {
         remoteFeeds = parsed.data.map((item: any) => ({
             sha256: item.sha256_hash,
             family: item.signature || "Unknown",
             severity: "critical",
             source: "malwarebazaar"
         }));
      } else {
         throw new Error("Formato do MalwareBazaar não reconhecido.");
      }
    } catch {
      throw new Error("Falha ao parsear resposta do MalwareBazaar.");
    }

    let existing: any[] = [];
    try {
      const raw = await fsPromises.readFile(this.hashesPath, "utf-8");
      existing = JSON.parse(raw);
    } catch {
      // Arquivo não existe ou é inválido
    }

    const merged = this.mergeHashFeeds(existing, remoteFeeds);
    await fsPromises.writeFile(this.hashesPath, JSON.stringify(merged, null, 2), "utf-8");
  }

  private downloadMalwareBazaar(): Promise<string> {
    return new Promise((resolve, reject) => {
      const data = "query=get_recent&selector=time";
      const req = https.request(HASH_FEED_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data)
        },
        timeout: 30000
      }, (res) => {
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("end", () => resolve(body));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Timeout MalwareBazaar")); });
      req.write(data);
      req.end();
    });
  }

  private mergeHashFeeds(local: any[], remote: any[]): any[] {
    const map = new Map<string, any>();
    for (const entry of local) map.set(entry.sha256?.toLowerCase(), entry);
    for (const entry of remote) map.set(entry.sha256?.toLowerCase(), entry);
    return Array.from(map.values());
  }

  // ── Private: Metadata ──────────────────────────────────────────────────────

  private getLastUpdateTimestamp(): number {
    try {
      const raw = fs.readFileSync(this.metaPath, "utf-8");
      return JSON.parse(raw).timestamp ?? 0;
    } catch {
      return 0;
    }
  }

  private saveUpdateTimestamp(): void {
    fs.mkdirSync(path.dirname(this.metaPath), { recursive: true });
    fs.writeFileSync(
      this.metaPath,
      JSON.stringify({ timestamp: Date.now(), iso: new Date().toISOString() }),
      "utf-8",
    );
  }

  // ── Private: HTTP util ─────────────────────────────────────────────────────

  private downloadText(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;
      const request = client.get(url, { timeout: 30_000 }, (res) => {
        // Follow redirects (301/302)
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.downloadText(res.headers.location).then(resolve, reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} ao baixar ${url}`));
          return;
        }

        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => resolve(data));
        res.on("error", reject);
      });

      request.on("error", reject);
      request.on("timeout", () => {
        request.destroy();
        reject(new Error(`Timeout ao baixar ${url}`));
      });
    });
  }
}
