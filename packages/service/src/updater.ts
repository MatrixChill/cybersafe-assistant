import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as https from "node:https";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { compile } from "@litko/yara-x";
import {
  ensureFreshclamConfig,
  buildFreshclamArgs,
  explainFreshclamError,
  FRESHCLAM_CONFIG_FILENAME,
  type EnsureConfigResult,
} from "./clamav-config.js";
import { ClamDatabaseGate } from "./clam-database-gate.js";
import type { UpdateDenialReason } from "./clam-database-gate.js";

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

/**
 * O adiamento, escrito pela CAUSA certa.
 *
 * CODEX (2026-10-03), oitava ronda. Antes havia uma frase única para os três
 * casos, e ela era falsa em dois deles. Um adiamento por scans activos pede
 * tempo; um adiamento porque já está outro update a escrever pede outra
 * coisa; um adiamento porque o serviço está a encerrar não pede nada — quem
 * Reinicia resolve.
 */
function descreverAdiamento(reason: UpdateDenialReason | undefined, orcamentoMs: number): string {
  switch (reason) {
    case "busy-scans":
      return (
        `actualizacao adiada: ha scans ClamAV activos que nao drenaram dentro do orcamento ` +
        `(${orcamentoMs} ms). A base actual continua valida.`
      );
    case "outro-escritor":
      return "actualizacao adiada: ja ha outra actualizacao de assinaturas em curso. A base actual continua valida.";
    case "servico-a-encerrar":
      return "actualizacao adiada: o servico de proteccao esta a encerrar. A base actual continua valida.";
    default:
      return "actualizacao adiada: a base de assinaturas esta ocupada. A base actual continua valida.";
  }
}

export class DefinitionUpdater {
  private readonly definitionsDir: string;
  private readonly yaraPath: string;
  private readonly hashesPath: string;
  private readonly metaPath: string;
  private timer: NodeJS.Timeout | null = null;
  /**
   * P1-1 (1) — QUANDO A BASE DE ASSINATURAS ESTÁ A SER TROCADA.
   *
   * MEDIDO: `checkAndUpdate` e o scan não tinham NENHUMA coordenação. O scan
   * aponta `--database=<defs>/clamav` e o freshclam escreve no MESMO directório.
   * Um clamscan que começa durante a troca pode ler a base a meio — e o
   * resultado é um veredicto sobre uma base que não existia em nenhum momento.
   *
   * A coordenação é uma JANELA, não um lock: o update declara que a base está a
   * mudar, e o scan que chega durante a janela responde `unavailable`. Não há
   * espera, não há fila, não há deadlock — um clamscan bloqueado à espera de
   * outro a terminar era um deadlock esperando a acontecer, e a vaga do
   * semáforo do core não pode ser usada aqui porque o update não passa por ela.
   *
   * `unavailable` é a resposta honesta: o utilizador vê "motor indisponível" e
   * o scan seguinte, já com a base parada, funciona. Um scan que finge ter
   * lido uma base em metamorfose é pior que um scan que não aconteceu.
   *
   * ── SUBSTITUÍDO PELO GATE (2026-10-03) ──────────────────────────────────────
   *
   * O que estava aqui era `clamDbSwapDepth`: um contador e uma janela
   * DECLARATIVA, consultada pelo scan com `isDatabaseSwapping()`. Isso era um
   * CHECK, e um check separado do uso não fecha uma corrida bidireccional:
   *
   *   scan lê `false` → (await) → freshclam arranca → scan entra na base
   *   scan já activo   → freshclam escreve por cima dele
   *
   * A autoridade passou a ser `ClamDatabaseGate` (`clam-database-gate.ts`): a
   * lease que o scan segura é o ÚNICO ponto de decisão, e o update só escreve
   * depois de todas as leases libertarem. O mecanismo antigo foi REMVIDO para
   * não deixar duas autoridades independentes para o mesmo estado — o que é a
   * forma mais segura de reintroduzir o bug que acabámos de fechar.
   *
   * A window de troca é agora o gate, e a sua janela é mais correcta: abre
   * ANTES de o freshclam nascer (quando o update é pedido) e fecha DEPOIS de
   * ele morrer, o que inclui o `spawn` a lançar.
   */
  /**
   * P1-1 (2) — o que fazer DEPOIS de uma troca, seja ela de onde vier.
   *
   * MEDIDO: `updateDefinitions()` (manual) chamava `isAvailable(true)`, mas o
   * scheduler — que corre de 6 em 6 horas e é o caminho normal — nunca o
   * fazia. Ou seja: o caminho que actualiza quase sempre deixava o motor a
   * reportar o estado de ANTES, que é exactamente o defeito que o parâmetro
   * `force` do `isAvailable` foi criado para fechar.
   *
   * Regra: só corre quando o freshclam REALMENTE correu com sucesso. Se o
   * freshclam não nasceu (drain falhado) ou falhou, não há base nova para
   * reavaliar — e re-sondar nesse caso seria publicar um estado que ninguém
   * pediu.
   */
  private afterSwap?: (result: UpdateResult) => Promise<void> | void;

  /**
   * O gate da base de assinaturas. Uma instância por serviço, partilhada com o
   * `ClamavBridge` pelo motor — é a MESMA instância nos dois lados, que é o que
   * faz a coordenação ser real e não duas autoridades concordando por sorte.
   */
  readonly gate: ClamDatabaseGate;
  /** Como o `freshclam` é criado. Ver a nota no construtor. */
  private readonly spawnFreshclam: typeof spawn;

  constructor(
    definitionsDir: string,
    options: {
      afterSwap?: (result: UpdateResult) => Promise<void> | void;
      gate?: ClamDatabaseGate;
      /**
       * Seam de teste: como o `freshclam` é criado. A produção nunca injecta
       * nada; é `spawn` do `node:child_process`.
       *
       * Existe pela mesma razão que o `createSpawnClamav` existe no core: a
       * decisão que interessa — se `error` devolve a posse ou se espera pelo
       * `close` — só se prova com um filho que NÃO MORRE, e um freshclam real
       * que se recusa a morrer não se fabrica. Sem este seam, o teste teria de
       * substituir o `runFreshclam` inteiro, e então passaria a provar o
       * dublê em vez do código.
       */
      spawnFreshclam?: typeof spawn;
    } = {},
  ) {
    this.definitionsDir = definitionsDir;
    this.yaraPath = path.join(definitionsDir, "yara", "default.yar");
    this.hashesPath = path.join(definitionsDir, "hashes", "default.json");
    this.metaPath = path.join(definitionsDir, ".update-meta.json");
    this.gate = options.gate ?? new ClamDatabaseGate();
    this.spawnFreshclam = options.spawnFreshclam ?? spawn;
    DefinitionUpdater.liveGates.add(this.gate);
    // P1-1 (2) — o gancho é do CICLO, não do update manual: quem o regista é o
    // motor, e tanto o scheduler como o `updateDefinitions` o atravessam. Por
    // isso é uma opção do construtor e não um método — não há caminho que o
    // instale num caso e o esqueça no outro.
    this.afterSwap = options.afterSwap;
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

    // P1-1 (2) — O GANCHO SÓ CORRE QUANDO A BASE MUDOU DE VERDADE.
    //
    // `clamUpdated` é a prova de que o freshclam nasceu E saiu com 0. Sem ele —
    // freshclam ausente, drain falhado, exit != 0 — não há base nova para
    // reavaliar, e re-sondar seria publicar um estado que ninguém mudou.
    //
    // O gancho corre no FIM do ciclo, tanto no caminho manual como no periódico:
    // é o MESMO `checkAndUpdate` nos dois, que é o que evita dois caminhos
    // parallelos com comportamentos diferentes.
    //
    // Uma falha aqui NÃO apaga o facto de que o update ocorreu. `clamUpdated`
    // continua true; o que se regista é um erro pós-update, e o health do motor
    // é que tem de continuar honesto.
    if (this.afterSwap && result.clamUpdated) {
      try {
        await this.afterSwap(result);
      } catch (err: any) {
        result.errors.push(`pos-update: ${err.message}`);
        console.warn("[Updater] Pós-update falhou:", err.message);
      }
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
        // Validação: regras YARA devem conter "rule " e compilar com YARA-X.
        // Só escrevemos no disco se o conteúdo for YARA válido.
        if (!content.includes("rule ") || content.includes("<!DOCTYPE html>")) {
          throw new Error("Conteúdo baixado não parece ser YARA válido.");
        }
        try {
          compile(content);
        } catch (compileErr: any) {
          throw new Error(`Regras baixadas não compilam com YARA-X: ${compileErr?.message ?? "unknown"}`);
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
    // P1-1 — o gate tem de fechar MESMO que nenhum `close` chegue.
    //
    // O `dispose` mata o filho por fora. Nao ha garantia de que o `close` do
    // Node seja emitido depois de um SIGKILL — e sem `close`, o `release` da
    // posse nunca corria e o gate ficava `updateActive = true` para
    // sempre. O preco de um gate preso e o motor ClamAV indisponivel ate ao
    // reinicio do servico, com scans a receber `unavailable` sem razao.
    // CODEX (2026-10-03), achado 10: aqui NAO se declara `scansConfirmadosMortos`.
    //
    // O `dispose` matou os freshclam de `activeProcesses` — e o `close` de cada
    // um devolve a posse por conta propria. Mas ele NAO matou os clamscans:
    // esses vivem na bridge, noutro dono. Declarar os scans mortos aqui era uma
    // confirmacao que ninguem deu, e o efeito era um freshclam a nascer por
    // cima de um clamscan vivo. O `reset` sem opcoes e a posicao honesta.
    for (const gate of DefinitionUpdater.liveGates) {
      try { gate.reset(); } catch {}
    }
    DefinitionUpdater.liveGates.clear();
  }

  /**
   * Os gates vivos, para o `dispose` estatico os poder fechar.
   *
   * O `dispose` e estatico e o gate e de instancia: sem este registo, o
   * shutdown nao saberia que gates existem. E' uma estrutura de WeakRef seria
   * mais limpa, mas `Set` com remocao no `dispose` e' mais simples e a
   * dimensao e o numero de updaters vivos (um por servico).
   */
  private static liveGates = new Set<ClamDatabaseGate>();

  private updateClamAV(options: { diagnostic?: boolean } = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const clamDbDir = path.join(this.definitionsDir, "clamav");
      fs.mkdirSync(clamDbDir, { recursive: true });

      // Config GERIDA, ao lado da base que aponta. Sem isto o freshclam aborta
      // no arranque: o pacote Chocolatey nao traz freshclam.conf, so o .sample
      // em conf_examples/. Ver clamav-config.ts para a medicao.
      let config: EnsureConfigResult;
      try {
        config = ensureFreshclamConfig(
          path.join(clamDbDir, FRESHCLAM_CONFIG_FILENAME),
          { databaseDirectory: clamDbDir },
        );
        console.log(`[Updater] freshclam.conf ${config.reason}: ${config.configFile}`);
      } catch (err: any) {
        reject(new Error(`nao foi possivel preparar a config do freshclam: ${err.message}`));
        return;
      }

      const args = buildFreshclamArgs({
        configFile: config.configFile,
        databaseDirectory: clamDbDir,
        diagnostic: options.diagnostic,
      });

      // P1-1 — O GATE, e não uma janela local.
      //
      // `beginUpdate()` regista o pedido ANTES do primeiro await (fecha a
      // admissão de scans novos), adquire a posse (exclusiva), espera os scans
      // com lease activa drenarem, e só então devolve a POSSE. Devolver `null`
      // significa: a troca não pode acontecer com honestidade — os scans não
      // drenaram dentro do orçamento, ou o serviço está a sair — e por isso o
      // freshclam NÃO NASCE. A base actual fica intacta e o scan que estava a
      // correr continua: não se mata trabalho de utilizador para actualizar
      // assinaturas.
      //
      // A posse volta num ÚNICO sítio, o `release` idempotente do lease. Com
      // sucesso, com falha, com `spawn` a lançar, com `error` ou com exit != 0.
      void this.gate
        .beginUpdateComMotivo()
        .then(({ lease: posse, refusal }) => {
          if (!posse) {
            // CODEX (2026-10-03), oitava ronda: a causa do adiamento VEM no
            // resultado. A versão anterior escrevia sempre "ha scans ClamAV
            // activos que nao drenaram" — e depois de um shutdown, ou com outro
            // escritor a segurar a vez, isso era mentira com zero scans a correr.
            // O utilizador lia essa frase no painel.
            reject(new Error(descreverAdiamento(refusal?.reason, this.gate.drainBudgetMs)));
            return;
          }
          // CODEX (2026-10-03), achado 2: `beginUpdate` pode resolver e o
          // `reset` do shutdown correr na microtarefa SEGUINTE, antes de esta
          // linha. O gate estava certo; o spawn é que ia na mesma, numa base de
          // um serviço a parar. A posse é reconfirmada no próprio sítio que vai
          // escrever — um `.then` não é o dono da decisão.
          if (!posse.valid) {
            reject(new Error("actualizacao cancelada: o serviço esta a encerrar antes de o freshclam nascer"));
            return;
          }
          this.runFreshclam(args, clamDbDir, config.configFile, resolve, reject, options, posse);
        })
        .catch((err) => {
          // Sem posse não há nada a devolver: o pedido nunca chegou a ter a vez.
          reject(err);
        });
    });
  }

  /**
   * O freshclam a correr DEPOIS do gate ter dado luz verde.
   *
   * A posse volta por `posse.release()`, que é IDEMPOTENTE. Não há contador
   * para descer de propósito nem flag para não descer duas vezes: um duplo
   * `release` desligaria a posse do update SEGUINTE, que já a tinha recebido por
   * passagem de vez — que é exactamente o bug que a posse por token veio
   * fechar.
   */
  private runFreshclam(
    args: string[],
    clamDbDir: string,
    configFile: string,
    resolve: () => void,
    reject: (err: Error) => void,
    options: { diagnostic?: boolean },
    posse: NonNullable<Awaited<ReturnType<ClamDatabaseGate["beginUpdate"]>>>,
  ): void {
    try {
      const child = this.spawnFreshclam("freshclam", args, {
        stdio: "pipe",
        windowsHide: true,
        timeout: 120_000, // 2 min timeout
        // cwd explicito: sem isto o freshclam herdaria o do do servico e
        // procuraria a config num sitio imprevisivel.
        cwd: clamDbDir,
      });
      DefinitionUpdater.activeProcesses.add(child);

      let stderr = "";
      let stdout = "";
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      // O freshclam vai MESMO escrever. Só agora `updateActive` é verdade, e
      // só agora o snapshot diz a verdade. O `markWriting` só corre se a posse
      // ainda for válida — se o shutdown entretanto levou a gate, o spawn nem
      // chega a acontecer.
      if (!posse.valid) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* nunca chegou a correr */
        }
        DefinitionUpdater.activeProcesses.delete(child);
        reject(new Error("actualizacao cancelada: o servico esta a shuts down antes do freshclam nascer"));
        return;
      }
      posse.markWriting();

      // A posse volta num ÚNICO sítio, e o `release` é idempotente.
      const fecharGate = () => posse.release();

      // CODEX (2026-10-03), achado 1: `error` NAO É PROVA DE MORTE.
      //
      // O Node emite `error` também quando não consegue MATAR o filho — não
      // só quando o spawn falha. Devolver a posse aqui admitia um scan e um
      // segundo update por cima de um freshclam que continuava vivo a escrever
      // na base: exactamente a corrida que o gate existe para fechar.
      //
      // A distinção é o PID: sem `child.pid` o processo nunca chegou a nascer e
      // nada está a escrever, logo a posse pode voltar. Com `child.pid` há
      // processo, e a prova de que acabou é o `close`.
      child.on("error", (err) => {
        const semPid = child.pid === undefined;
        if (semPid) {
          fecharGate();
          DefinitionUpdater.activeProcesses.delete(child);
        } else {
          // Ainda a escrever, ou pelo menos sem prova de que parou. Tenta-se
          // matar uma vez; se o `close` não vier, a posse fica presa — que é o
          // estado honesto, e o mesmo pelo qual a vaga fica envenenada no
          // clamscan. O `dispose` do serviço fecha o gate à mesma.
          try {
            child.kill("SIGKILL");
          } catch {
            /* ja morreu, ou nunca chegou a nascer */
          }
        }
        reject(new Error(`freshclam não encontrado ou falhou: ${err.message}`));
      });

      child.on("close", (code) => {
        fecharGate();
        DefinitionUpdater.activeProcesses.delete(child);
        if (code === 0) resolve();
        else {
          // O `--quiet` e omitido em diagnostico, por isso o stderr tem o erro
          // real. Traduzir em vez de despejar o bruto no log.
          const detail = explainFreshclamError(stderr, configFile);
            const extra = options.diagnostic && stdout.trim() ? ` (stdout: ${stdout.trim().slice(0, 400)})` : "";
          reject(new Error(`freshclam exit code ${code}: ${detail}${extra}`));
        }
      });
    } catch (err: any) {
      // O `spawn` a lançar é o caminho que faltava no mecanismo antigo, e é o
      // que com mais probabilidades de acontecer numa máquina sem freshclam.
      posse.release();
      DefinitionUpdater.activeProcesses.clear();
      reject(new Error(`freshclam não encontrado ou falhou: ${err.message}`));
    }
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
        if (res.statusCode && res.statusCode !== 200) {
          reject(new Error(`MalwareBazaar HTTP ${res.statusCode}`));
          return;
        }
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
