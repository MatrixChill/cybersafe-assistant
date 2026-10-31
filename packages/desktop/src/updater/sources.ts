/**
 * Fontes de update (TP-UPDATE-01).
 *
 * O `HttpsFeedSource` só contém a LÓGICA (allowlist, 404 → sem update, status →
 * erro tipado, JSON → manifesto bruto). O transporte real (`node:https`, saltar
 * redirect inseguro, stream com cap de bytes) é uma `FeedFetcher` injetada — em
 * produção vem do main (no PATCH de integração), nos testes vem de um fake. Assim
 * NENHUM teste toca a rede.
 *
 * `LocalFixtureSource` é a origem LOCAL/MOCK benigna e determinística pedida na
 * fila: devolve um manifesto fixo que o chamador fornece. Não inventa updates.
 */
import { isUrlAllowed } from "./config.ts";
import {
  SourceError,
  type RawReleaseManifest,
  type SourceOutcome,
  type UpdateSource,
  type UpdaterConfig,
} from "./types.ts";

export interface FeedFetchResult {
  status: number;
  bodyText: string;
}

/** Transporte injetado. Deve respeitar `signal` e NUNCA seguir http-downgrade. */
export interface FeedFetcher {
  fetch(url: string, signal: AbortSignal): Promise<FeedFetchResult>;
}

export class HttpsFeedSource implements UpdateSource {
  private readonly config: UpdaterConfig;
  private readonly fetcher: FeedFetcher;

  constructor(config: UpdaterConfig, fetcher: FeedFetcher) {
    this.config = config;
    this.fetcher = fetcher;
  }

  async fetchLatest(signal: AbortSignal): Promise<SourceOutcome> {
    // Dupla barreira: o config já validou a origem, mas revalida-se aqui para o
    // caso de um config mutável entre a resolução e o pedido.
    if (!isUrlAllowed(this.config.feedManifestUrl, this.config.originAllowlist)) {
      throw new SourceError("untrusted-metadata", "feed fora da allowlist no momento do pedido");
    }

    let result: FeedFetchResult;
    try {
      result = await this.fetcher.fetch(this.config.feedManifestUrl, signal);
    } catch (error) {
      // Cancelamento/timeout: deixa o updater classificar (ele sabe o motivo).
      if (signal.aborted) throw error;
      throw new SourceError("offline", "falha de rede ao contactar o feed");
    }

    if (result.status === 404 || result.status === 204) {
      return { kind: "none" };
    }
    if (result.status < 200 || result.status >= 300) {
      throw new SourceError(
        result.status >= 500 ? "offline" : "invalid-manifest",
        `feed respondeu ${result.status}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.bodyText);
    } catch {
      throw new SourceError("invalid-manifest", "resposta do feed não é JSON válido");
    }
    return { kind: "latest", manifest: parsed as RawReleaseManifest };
  }
}

export class LocalFixtureSource implements UpdateSource {
  private readonly provider: () => SourceOutcome | Promise<SourceOutcome>;

  constructor(provider: () => SourceOutcome | Promise<SourceOutcome>) {
    this.provider = provider;
  }

  async fetchLatest(_signal: AbortSignal): Promise<SourceOutcome> {
    return this.provider();
  }
}
