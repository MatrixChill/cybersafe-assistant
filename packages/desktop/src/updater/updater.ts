/**
 * Máquina de estados do updater (TP-UPDATE-01, revisto).
 *
 * Segurança verificável sem rede/disco/instalador:
 *  - `unconfigured`/`unsupported` mandam antes de tudo (falha fechada).
 *  - O MANIFESTO é AUTENTICADO (ed25519, chave pinada) no `check`, ANTES de
 *    `available` e antes de qualquer download: assinatura inválida ⇒ 0 downloads
 *    e as `notes` de upstream NÃO são promovidas.
 *  - `download`: só origem na allowlist, só HTTPS, cap de bytes, progresso com
 *    bytes reais; valida INTEGRIDADE (SHA-256) do ficheiro lido.
 *  - `install`: exige `confirmed` + `expectedVersion` igual + scan **idle
 *    CONFIRMADO** (`running`/`unknown` bloqueiam; `protectionEnabled` NÃO prova
 *    inatividade) e REVALIDA SHA + tamanho REAL + publisher imediatamente antes,
 *    porque a cache pode ter mudado desde o download. Nunca silencioso, nunca
 *    auto-restart aqui.
 *  - `busy` rejeita operações concorrentes SEM mutar a fase/canInstall da
 *    operação legítima em curso. Qualquer exceção de fs/probe/instalador/verificador
 *    ou timeout torna-se um Result de erro (falha fechada), nunca rejeição solta.
 */
import path from "node:path";
import { artifactFinalPath, CacheStore } from "./cache.ts";
import { isUrlAllowed, type ConfigResolution } from "./config.ts";
import { sha256Hex } from "./crypto.ts";
import { canonicalManifestBytes, validateManifest } from "./manifest.ts";
import { isDowngrade, isUpgrade } from "./semver.ts";
import {
  SourceError,
  type Clock,
  type Installer,
  type Logger,
  type ScanState,
  type UpdateErrorCode,
  type UpdateSnapshot,
  type UpdaterConfig,
  type UpdaterResult,
  type ValidatedManifest,
  type VersionInfo,
} from "./types.ts";
import { NOOP_LOGGER, SYSTEM_CLOCK } from "./types.ts";
import type { UpdaterDeps } from "./deps.ts";

function baseSnapshot(installed: VersionInfo, automatic: boolean): UpdateSnapshot {
  return { phase: "idle", channel: "stable", installed, canInstall: false, automaticCheckEnabled: automatic };
}

export class Updater {
  private readonly deps: UpdaterDeps;
  private readonly resolvedConfig?: UpdaterConfig;
  private readonly cache: CacheStore;
  private snapshot: UpdateSnapshot;
  private validated?: ValidatedManifest;
  private artifactPath?: string;
  private busy = false;
  private controller?: AbortController;
  private abortReason?: "timeout" | "cancel";
  private timer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<(s: UpdateSnapshot) => void>();

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
    this.cache = new CacheStore(deps.cacheFs, deps.config.ok ? deps.config.config.cacheDir : path.resolve("."));
    const automatic = deps.config.ok ? deps.config.config.automaticCheckEnabled : false;
    if (deps.config.ok) this.resolvedConfig = deps.config.config;
    this.snapshot = { ...baseSnapshot(deps.installed, automatic), manualDownloadOnly: deps.manualDownloadOnly === true };
    if (!deps.runtimeSupported) {
      this.snapshot = { ...this.snapshot, phase: "unsupported", error: { code: "unsupported", message: "runtime portable/dev: atualização não suportada" } };
    } else if (!deps.config.ok) {
      this.snapshot = { ...this.snapshot, phase: "unconfigured", error: { code: "unconfigured", message: deps.config.unconfigured.reason } };
    }
  }

  snapshotCopy(): UpdateSnapshot {
    return JSON.parse(JSON.stringify(this.snapshot)) as UpdateSnapshot;
  }

  onState(listener: (s: UpdateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void {
    const copy = this.snapshotCopy();
    for (const listener of [...this.listeners]) {
      try { listener(copy); } catch { /* um listener que rebenta não rebenta o updater */ }
    }
  }

  private set(patch: Partial<UpdateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private fail(code: UpdateErrorCode, message: string): UpdaterResult {
    this.set({ phase: "error", canInstall: false, error: { code, message } });
    (this.deps.logger ?? NOOP_LOGGER).warn("updater falhou", { code, message });
    return { ok: false, error: code, snapshot: this.snapshotCopy() };
  }

  private ok(): UpdaterResult {
    return { ok: true, snapshot: this.snapshotCopy() };
  }

  /** Ocupado: devolve Result SEM tocar no snapshot da operação em curso. */
  private busyResult(): UpdaterResult {
    return { ok: false, error: "busy", snapshot: this.snapshotCopy() };
  }

  private gate(): UpdaterResult | null {
    if (!this.deps.runtimeSupported) return { ok: false, error: "unsupported", snapshot: this.snapshotCopy() };
    if (!this.resolvedConfig) return { ok: false, error: "unconfigured", snapshot: this.snapshotCopy() };
    return null;
  }

  private startOp(): AbortSignal {
    const controller = new AbortController();
    this.controller = controller;
    this.abortReason = undefined;
    this.timer = setTimeout(() => { this.abortReason = "timeout"; controller.abort(); }, this.resolvedConfig!.timeoutMs);
    return controller.signal;
  }

  private endOp(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller = undefined;
    // `abortReason` NÃO é limpo aqui: mantém-se para classificar um abort que
    // chegou tarde (depois de a promise ter resolvido). É reposto no próximo startOp.
  }

  private classifyAbort(): UpdateErrorCode {
    return this.abortReason === "timeout" ? "timeout" : "cancelled";
  }

  async cancel(): Promise<UpdaterResult> {
    if (this.controller) { this.abortReason = "cancel"; this.controller.abort(); }
    return this.ok();
  }

  async setAutomaticCheck(enabled: boolean): Promise<UpdaterResult> {
    const blocked = this.gate();
    if (blocked) return blocked;
    this.set({ automaticCheckEnabled: enabled }); // NÃO dispara check.
    return this.ok();
  }

  async defer(): Promise<UpdaterResult> {
    const blocked = this.gate();
    if (blocked) return blocked;
    if (this.busy) return this.busyResult();
    this.set({ phase: "deferred", canInstall: false });
    return this.ok();
  }

  async check(): Promise<UpdaterResult> {
    const blocked = this.gate();
    if (blocked) return blocked;
    if (this.busy) return this.busyResult();
    this.busy = true;
    try {
      this.set({ phase: "checking", error: undefined });
      const op = this.startOp();
      let outcome;
      try {
        outcome = await this.deps.source.fetchLatest(op);
      } catch (error) {
        if (op.aborted) return this.fail(this.classifyAbort(), "pedido ao feed abortado");
        if (error instanceof SourceError) return this.fail(error.code, error.message);
        return this.fail("internal", "erro inesperado a contactar o feed");
      } finally {
        this.endOp();
      }

      // Abort tardio: a promise resolveu mas o sinal já estava abortado — NÃO se
      // promove estado a partir de uma resposta que o utilizador cancelou/atrasou.
      if (op.aborted) return this.fail(this.classifyAbort(), "pedido ao feed abortado (tardio)");

      const checkedAt = this.deps.clock?.iso?.() ?? SYSTEM_CLOCK.iso();

      if (outcome.kind === "none") {
        this.validated = undefined;
        this.artifactPath = undefined;
        this.set({ phase: "upToDate", latest: undefined, canInstall: false, checkedAt, error: undefined, progress: undefined });
        return this.ok();
      }

      const validation = validateManifest(outcome.manifest);
      if (!validation.ok) return this.fail("invalid-manifest", validation.message);
      const manifest = validation.manifest;

      // AUTENTICAR O MANIFESTO ANTES de promover a release / permitir download.
      // Assinatura inválida ⇒ NOTAS não confiáveis nunca são mostradas e NÃO há download.
      try {
        const sig = await this.deps.signatureVerifier.verify(
          canonicalManifestBytes(manifest),
          manifest.signature.value,
          manifest.signature.signedByFingerprint,
        );
        if (!sig.ok) {
          this.validated = undefined;
          return this.fail("untrusted-metadata", `assinatura do manifesto rejeitada na origem (${sig.reason ?? "?"})`);
        }
      } catch {
        this.validated = undefined;
        return this.fail("untrusted-metadata", "verificador de assinatura falhou (fail-closed)");
      }

      if (isDowngrade(manifest.version, this.deps.installed.version)) {
        this.validated = undefined;
        return this.fail("downgrade", `versão ${manifest.version} é anterior à instalada ${this.deps.installed.version}`);
      }
      if (!isUpgrade(manifest.version, this.deps.installed.version)) {
        this.validated = undefined;
        this.set({ phase: "upToDate", latest: undefined, canInstall: false, checkedAt, error: undefined });
        return this.ok();
      }

      this.validated = manifest;
      this.artifactPath = undefined;
      this.set({
        phase: "available",
        latest: { version: manifest.version, publishedAt: manifest.publishedAt, notes: manifest.notes, sizeBytes: manifest.file.sizeBytes },
        canInstall: false,
        checkedAt,
        error: undefined,
        progress: undefined,
      });
      return this.ok();
    } catch {
      return this.fail("internal", "erro inesperado no check");
    } finally {
      this.busy = false;
    }
  }

  async download(): Promise<UpdaterResult> {
    const blocked = this.gate();
    if (blocked) return blocked;
    const config = this.resolvedConfig!;
    if (this.busy) return this.busyResult();
    const manifest = this.validated;
    if (!manifest) return this.fail("invalid-manifest", "nada para descarregar (faça check primeiro)");
    if (this.snapshot.phase === "downloaded" && this.artifactPath) return this.ok();

    if (!isUrlAllowed(manifest.file.url, config.originAllowlist)) {
      return this.fail("untrusted-metadata", "URL do artefacto fora da allowlist");
    }
    if (manifest.file.sizeBytes > config.maxDownloadBytes) {
      return this.fail("integrity", "artefacto excede o limite de tamanho permitido");
    }

    this.busy = true;
    let staging: string | undefined;
    try {
      try {
        await this.cache.prepare();
        staging = await this.cache.stagingPath(manifest.version, manifest.file.sha256);
      } catch {
        return this.fail("internal", "cache indisponível");
      }
      if (staging === undefined) return this.fail("internal", "caminho de cache indefinido");
      this.set({ phase: "downloading", error: undefined, canInstall: false, progress: { downloadedBytes: 0, totalBytes: manifest.file.sizeBytes } });

      const op = this.startOp();
      try {
        await this.deps.downloader.download(manifest.file.url, staging, op, (bytes, total) => {
          this.set({ progress: { downloadedBytes: bytes, totalBytes: total ?? manifest.file.sizeBytes } });
        });
      } catch (error) {
        await this.safeDiscard(manifest);
        if (op.aborted) return this.fail(this.classifyAbort(), "download abortado");
        return this.fail("offline", "falha na transferência");
      } finally {
        this.endOp();
      }
      // Abort tardio: resolveu mas o sinal estava abortado → não promover estado.
      if (op.aborted) { await this.safeDiscard(manifest); return this.fail(this.classifyAbort(), "download abortado (tardio)"); }

      this.set({ phase: "verifying" });

      // INTEGRIDADE sobre os BYTES LIDOS (não o contador do downloader).
      let data: Uint8Array | null;
      try {
        data = await this.deps.cacheFs.readFile(staging);
      } catch {
        await this.safeDiscard(manifest);
        return this.fail("integrity", "falha a ler o artefacto transferido");
      }
      if (!data) { await this.safeDiscard(manifest); return this.fail("integrity", "artefacto ausente após download"); }

      if (data.length !== manifest.file.sizeBytes || data.length > config.maxDownloadBytes) {
        await this.safeDiscard(manifest);
        return this.fail("integrity", `tamanho real ${data.length} ≠ declarado ${manifest.file.sizeBytes}`);
      }
      if (sha256Hex(data) !== manifest.file.sha256.toLowerCase()) {
        await this.safeDiscard(manifest);
        return this.fail("integrity", "SHA-256 do artefacto não corresponde ao manifesto");
      }

      try {
        await this.cache.commitStaging(staging, data);
      } catch {
        await this.safeDiscard(manifest);
        return this.fail("integrity", "falha ao publicar o artefacto na cache");
      }
      const finalPath = artifactFinalPath(config.cacheDir, manifest.version, manifest.file.sha256);
      this.artifactPath = finalPath;

      if (this.deps.manualDownloadOnly === true) {
        this.set({ phase: "downloaded", canInstall: false, progress: { downloadedBytes: data.length, totalBytes: data.length }, error: undefined });
        return this.ok();
      }

      try {
        const publisher = await this.deps.publisherVerifier.verify(finalPath, config.expectedPublisherName);
        if (!publisher.ok) {
          await this.safeDiscard(manifest);
          this.artifactPath = undefined;
          return this.fail("publisher", `editor não verificado (${publisher.reason ?? "?"})`);
        }
      } catch {
        await this.safeDiscard(manifest);
        this.artifactPath = undefined;
        return this.fail("publisher", "verificador de editor falhou (fail-closed)");
      }

      this.set({ phase: "downloaded", canInstall: true, requiresElevation: manifest.requiresElevation, progress: { downloadedBytes: data.length, totalBytes: manifest.file.sizeBytes }, error: undefined });
      return this.ok();
    } catch {
      return this.fail("internal", "erro inesperado no download");
    } finally {
      this.busy = false;
    }
  }

  /** Revalidates bytes before revealing a folder. Never executes the file. */
  async revealVerifiedDownload(reveal: (file: string) => void): Promise<UpdaterResult> {
    const blocked = this.gate();
    if (blocked) return blocked;
    if (this.busy) return this.fail("busy", "operação em curso");
    if (!this.deps.manualDownloadOnly || this.snapshot.phase !== "downloaded" || !this.validated || !this.artifactPath) return this.fail("installation", "nenhuma transferência manual validada");
    this.busy = true;
    try {
      const bytes = await this.deps.cacheFs.readFile(this.artifactPath);
      if (!bytes || bytes.length !== this.validated.file.sizeBytes || sha256Hex(bytes) !== this.validated.file.sha256.toLowerCase()) return this.fail("integrity", "o ficheiro foi alterado; abertura da pasta recusada");
      reveal(this.artifactPath);
      return this.ok();
    } catch { return this.fail("internal", "não foi possível abrir a pasta"); }
    finally { this.busy = false; }
  }

  async install(request: { confirmed: boolean; expectedVersion: string }): Promise<UpdaterResult> {
    if (this.deps.manualDownloadOnly) return this.fail("publisher", "instalação automática indisponível: instalador sem assinatura Authenticode validada");
    const blocked = this.gate();
    if (blocked) return blocked;
    if (this.busy) return this.busyResult();
    const manifest = this.validated;
    const artifactPath = this.artifactPath;

    if (this.snapshot.phase !== "downloaded" || !manifest || !artifactPath || !this.snapshot.canInstall) {
      return this.fail("installation", "nada validado para instalar");
    }
    if (request.confirmed !== true) return this.fail("installation", "instalação requer confirmação explícita do utilizador");
    if (request.expectedVersion !== manifest.version) return this.fail("installation", "expectedVersion não corresponde ao artefacto validado");

    // busy ANTES de qualquer await: rejeita double-install sem tocar no resto.
    this.busy = true;
    try {
      // 1) REVALIDAR integridade imediatamente antes de instalar: a cache pode ter
      //    mudado desde o download (outro processo, disco, etc.). Lê os BYTES reais.
      let data: Uint8Array | null;
      try {
        data = await this.deps.cacheFs.readFile(artifactPath);
      } catch {
        return this.fail("installation", "falha a reler o artefacto antes de instalar");
      }
      if (!data) return this.fail("installation", "artefacto desapareceu da cache");
      if (data.length !== manifest.file.sizeBytes) return this.fail("installation", `tamanho mudou (${data.length} ≠ ${manifest.file.sizeBytes})`);
      if (sha256Hex(data) !== manifest.file.sha256.toLowerCase()) return this.fail("installation", "SHA-256 mudou desde a verificação");

      // 2) RE-VERIFICAR o editor (Authenticode) antes de executar.
      try {
        const publisher = await this.deps.publisherVerifier.verify(artifactPath, this.resolvedConfig!.expectedPublisherName);
        if (!publisher.ok) return this.fail("publisher", `editor não verificado antes de instalar (${publisher.reason ?? "?"})`);
      } catch {
        return this.fail("publisher", "verificador de editor falhou (fail-closed)");
      }

      // 3) scan CONFIRMADO IDLE como ÚLTIMO gate antes de executar. Revalidação de
      //    integridade/editor acima são leituras puras da cache; colocar o probe de
      //    análise AGORA, logo antes do `installer`, REDUZ a janela em que um estado
      //    `idle` lido cedo poderia ter passado a `running` sem nos darmos conta.
      //    HONESTO: isto NÃO fecha a corrida — entre esta leitura e o arranque real do
      //    instalador o scan pode ainda iniciar; só o SO/instalador podem serializar
      //    isso, e o `Installer` injetado deve RE-cplicar no momento da execução.
      //    `running`/`unknown`/probe-que-lança bloqueiam (proteção ON ≠ idle).
      let scanState: ScanState;
      try {
        scanState = await this.deps.scanProbe();
      } catch {
        return this.fail("installation", "estado da análise desconhecido (probe falhou)");
      }
      if (scanState !== "idle") {
        return this.fail("installation", `análise (${scanState}) não está idle; instalação bloqueada`);
      }

      this.set({ phase: "installing", canInstall: true });
      try {
        const res = await this.deps.installer.install({
          artifactPath, manifest, expectedVersion: request.expectedVersion, confirmed: true, scanState,
        });
        if (!res.ok) return this.fail("installation", res.message ?? "instalador reportou falha");
      } catch {
        return this.fail("installation", "instalador lançou (fail-closed)");
      }
      // Sucesso: mantemos `installing`; o re-start é decisão do main (nunca auto aqui).
      return this.ok();
    } catch {
      return this.fail("internal", "erro inesperado no instalar");
    } finally {
      this.busy = false;
    }
  }

  /** Descartar sem deixar uma rejeição solta se o fs falhar. */
  private async safeDiscard(manifest: ValidatedManifest): Promise<void> {
    try { await this.cache.discard(manifest.version, manifest.file.sha256); } catch { /* melhor engolir aqui; a operação já vai falhar */ }
  }
}

export function createUpdater(deps: UpdaterDeps): Updater {
  return new Updater(deps);
}

/** Instalador fail-closed por omissão: sem injeção explícita, NADA é executado. */
export const BLOCKED_INSTALLER: Installer = {
  async install() { return { ok: false, message: "nenhum instalador configurado (main deve injetar)" }; },
};
