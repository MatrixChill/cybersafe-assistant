/**
 * Transporte HTTPS REAL (node:https) para feed e download (TP-UPDATE-ADAPTERS, item 1).
 *
 * Estes adaptadores EXISTEM e estão IMPLEMENTADOS, mas ficam DESLIGADOS em
 * produção: `createUnconfiguredUpdater` (bridge.ts) usa os bloqueados e NÃO importa
 * daqui. Só entram em ação se/quando existir feed assinado + chave pinada + certificado,
 * coisas que hoje não há (medido no audit). Ou seja: código real, caminho não acionado.
 *
 * Contrato de segurança, verificado SEM rede (transporte injetável):
 *  - Só HTTPS; URL com credenciais é recusado ANTES de qualquer pedido.
 *  - TLS NORMAL: nunca `rejectUnauthorized:false`. A verificação de cadeia fica ON.
 *  - Um único salto: REDIRECTS SÃO REJEITADOS, não seguidos (política mais simples e
 *    sem downgrade por `Location`). O `opener` real (node:https) NÃO segue redirects por
 *    omissão; a política de rejeitar 3xx vive na lógica partilhada para ser testável por
 *    seam com um `opener` fake.
 *  - Allowlist revalidada POR SALTO (aqui só há um) no momento do pedido.
 *  - Metadata: corpo com LIMITE de bytes; excedeu ⇒ falha, nunca parse parcial.
 *  - Artifact: stream com LIMITE de bytes DURANTE a transferência (para aos primeiros
 *    bytes do excesso), `Content-Length` validado, TRUNCAMENTO ⇒ falha. Aborto/timeout
 *    (via `signal`) destrói o pedido. Qualquer falha NÃO deixa commit nem progresso falso:
 *    o sink parcial é removido e lança, e a máquina de estados descarta a staging.
 */
import https from "node:https";
import fs from "node:fs";
import { isUrlAllowed } from "./config.ts";
import type { FeedFetcher, FeedFetchResult } from "./sources.ts";
import type { ArtifactDownloader, DownloadedArtifact, UpdaterConfig } from "./types.ts";

/** Erro de transporte: o chamador (Updater) trata-o como falha de rede/integridade. */
export class TransportError extends Error {
  readonly kind: "scheme" | "credentials" | "redirect" | "status" | "limit" | "truncated" | "aborted" | "network";
  constructor(kind: TransportError["kind"], message: string) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
  }
}

/** Resposta crua exposta pela costura de abertura. `body` é iterável de bytes. */
export interface OpenedHttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Destrói o pedido/resíduo. Idempotente; chamar depois de ler tudo é inofensivo. */
  abort(): void;
}

/** Costura injetável: abre UM pedido e devolve a PRIMEIRA resposta (sem seguir redirects). */
export interface HttpStreamOpener {
  open(url: string, signal: AbortSignal): Promise<OpenedHttpResponse>;
}

/** Guarda de URL partilhada: https + sem credenciais. Lança TransportError caso contrário. */
function assertSafeUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TransportError("scheme", "URL do feed/artefacto não é válida");
  }
  if (parsed.protocol !== "https:") {
    throw new TransportError("scheme", "apenas HTTPS é permitido");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new TransportError("credentials", "URL com credenciais é recusada");
  }
  return parsed;
}

/** Rejeita qualquer 3xx: NÃO se segue `Location`. Devolve só para 2xx. */
function assertSingleHopOk(status: number): void {
  if (status >= 300 && status < 400) {
    throw new TransportError("redirect", "redirect recusado (single-hop)");
  }
}

/** Abre com node:https real. TLS verificado; NÃO segue redirects; respeita `signal`. */
export function createNodeHttpsOpener(): HttpStreamOpener {
  return {
    open(url: string, signal: AbortSignal): Promise<OpenedHttpResponse> {
      return new Promise<OpenedHttpResponse>((resolve, reject) => {
        // Guardas ANTES de tocar a rede.
        try {
          assertSafeUrl(url);
        } catch (error) {
          reject(error);
          return;
        }
        if (signal.aborted) {
          reject(new TransportError("aborted", "abortado antes de abrir"));
          return;
        }

        let settled = false;
        const req = https.get(
          url,
          // TLS NORMAL: a verificação de cadeia fica ligada. Isto NUNCA é false.
          { rejectUnauthorized: true },
          (res) => {
            settled = true;
            const headers: Record<string, string | undefined> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
            }
            const destroy = (): void => {
              try {
                res.destroy();
              } catch {
                /* já destruído */
              }
              try {
                req.destroy();
              } catch {
                /* já destruído */
              }
            };
            const onAbort = (): void => destroy();
            signal.addEventListener("abort", onAbort, { once: true });
            res.on("close", () => signal.removeEventListener("abort", onAbort));
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body: res as unknown as AsyncIterable<Uint8Array>,
              abort: destroy,
            });
          },
        );
        req.on("error", () => {
          if (!settled) reject(new TransportError("network", "falha de rede/TLS"));
        });
        // Aborto antes da resposta.
        const pre = (): void => {
          if (!settled) {
            try {
              req.destroy();
            } catch {
              /* noop */
            }
            reject(new TransportError("aborted", "abortado durante a abertura"));
          }
        };
        signal.addEventListener("abort", pre, { once: true });
      });
    },
  };
}

/** Lê um corpo iterável até `maxBytes`. Se exceder, pára e marca overflow (sem parser parcial). */
async function readCappedText(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ text: string; overflow: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of body) {
    if (signal.aborted) throw new TransportError("aborted", "abortado durante o corpo");
    const chunk = raw as Uint8Array;
    total += chunk.length;
    if (total > maxBytes) {
      return { text: "", overflow: true };
    }
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return { text: Buffer.concat(chunks).toString("utf8"), overflow: false };
}

export interface FeedFetcherOptions {
  /** LIMITE do corpo de metadata (JSON do manifesto). default 256 KiB. */
  maxMetadataBytes?: number;
}

const DEFAULT_MAX_METADATA_BYTES = 256 * 1024;

/** `FeedFetcher` real sobre a costura de abertura. Devolve status+texto; HttpsFeedSource interpreta. */
export function createHttpsFeedFetcher(
  config: UpdaterConfig,
  opener: HttpStreamOpener,
  options: FeedFetcherOptions = {},
): FeedFetcher {
  const maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
  return {
    async fetch(url: string, signal: AbortSignal): Promise<FeedFetchResult> {
      assertSafeUrl(url);
      if (!isUrlAllowed(url, config.originAllowlist)) {
        throw new TransportError("scheme", "feed fora da allowlist no momento do pedido");
      }
      const res = await opener.open(url, signal);
      try {
        assertSingleHopOk(res.status);
        const { text, overflow } = await readCappedText(res.body, signal, maxMetadataBytes);
        if (overflow) {
          throw new TransportError("limit", "corpo de metadata excedeu o limite");
        }
        return { status: res.status, bodyText: text };
      } finally {
        res.abort();
      }
    },
  };
}

/**
 * Sink de escrita injetável. A produção usa `nodeFileSink` (fs real). Nos testes usa-se
 * um sink de memória para exercitar bytes/progresso/truncamento sem disco nem rede.
 */
export interface ArtifactSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Fecho limpo (flush) — só se chama em sucesso. */
  close(): Promise<void>;
  /** Aborto: fecha e remove resíduo parcial (fail-closed: nada fica para commit). */
  discard(): Promise<void>;
}

export type ArtifactSinkFactory = (destination: string) => Promise<ArtifactSink>;

/** Sink real: escreve para `destination` via fs, removendo o parcial em falha. */
export const nodeFileSink: ArtifactSinkFactory = async (destination: string): Promise<ArtifactSink> => {
  const handle = await fs.promises.open(destination, "w");
  let closed = false;
  const ensureClosed = async (): Promise<void> => {
    if (!closed) {
      await handle.close();
      closed = true;
    }
  };
  return {
    async write(chunk: Uint8Array): Promise<void> {
      await handle.write(chunk);
    },
    async close(): Promise<void> {
      await ensureClosed();
    },
    async discard(): Promise<void> {
      await ensureClosed();
      try {
        await fs.promises.rm(destination, { force: true });
      } catch {
        /* já removido / nunca criado */
      }
    },
  };
};

export interface ArtifactDownloaderOptions {
  /** Sobrescreve o sink (testes usam memória; produção usa fs). */
  sinkFactory?: ArtifactSinkFactory;
}

/**
 * `ArtifactDownloader` REAL: stream do corpo para o sink, com cap de bytes DURANTE a
 * transferência, validação de `Content-Length` e truncamento. Em QUALQUER falha lança
 * e descarta o parcial, para que a máquina de estados NÃO commite nem mostre progresso
 * falso. Nunca segue redirect; revalida allowlist por salto (único).
 */
export function createHttpsArtifactDownloader(
  config: UpdaterConfig,
  opener: HttpStreamOpener,
  options: ArtifactDownloaderOptions = {},
): ArtifactDownloader {
  const sinkFactory = options.sinkFactory ?? nodeFileSink;
  return {
    async download(
      url: string,
      destination: string,
      signal: AbortSignal,
      onProgress: (downloadedBytes: number, totalBytes?: number) => void,
    ): Promise<DownloadedArtifact> {
      assertSafeUrl(url);
      if (!isUrlAllowed(url, config.originAllowlist)) {
        throw new TransportError("scheme", "URL do artefacto fora da allowlist");
      }
      if (signal.aborted) throw new TransportError("aborted", "abortado antes de abrir");

      const res = await opener.open(url, signal);
      let written = 0;
      let totalKnown: number | undefined;
      try {
        assertSingleHopOk(res.status);
        if (res.status < 200 || res.status >= 300) {
          throw new TransportError("status", `artefacto respondeu ${res.status}`);
        }

        const clHeader = res.headers["content-length"];
        if (clHeader !== undefined) {
          const cl = Number(clHeader);
          if (Number.isFinite(cl) && cl >= 0) {
            totalKnown = cl;
            // Cap ANTES de escrever: recusar à partida um artefacto grande demais.
            if (cl > config.maxDownloadBytes) {
              throw new TransportError("limit", "Content-Length excede o limite de download");
            }
          }
        }

        const sink = await sinkFactory(destination);
        try {
          for await (const raw of res.body) {
            if (signal.aborted) throw new TransportError("aborted", "abortado durante o stream");
            const chunk = raw as Uint8Array;
            const nextTotal = written + chunk.length;
            // Cap DURING o stream: corta aos primeiros bytes do excesso, não no fim.
            if (nextTotal > config.maxDownloadBytes) {
              throw new TransportError("limit", "fluxo excedeu o limite de bytes durante a transferência");
            }
            await sink.write(chunk);
            written = nextTotal;
            onProgress(written, totalKnown);
          }
          // Truncamento: stream fechou cedo face ao Content-Length declarado.
          if (totalKnown !== undefined && written !== totalKnown) {
            throw new TransportError("truncated", `stream truncado: ${written} ≠ ${totalKnown}`);
          }
          if (written === 0) {
            throw new TransportError("truncated", "artefacto vazio");
          }
          await sink.close();
        } catch (error) {
          await sink.discard();
          throw error;
        }
      } finally {
        res.abort();
      }

      return { path: destination, bytes: written };
    },
  };
}
