import * as https from "node:https";

const MAX_YARA_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 5;

type HttpsGet = typeof https.get;

export function downloadYaraRulesText(
  source: string,
  requestGet: HttpsGet = https.get,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Download da fonte YARA cancelado."));
  }
  let origin: string;
  try {
    const parsed = new URL(source);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return Promise.reject(new Error("A fonte YARA tem de usar HTTPS sem credenciais."));
    }
    origin = parsed.origin;
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error("URL da fonte YARA inválido."),
    );
  }

  return requestSource(source, origin, 0, requestGet, signal);
}

function requestSource(
  source: string,
  origin: string,
  redirects: number,
  requestGet: HttpsGet,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = requestGet(source, { timeout: 30_000, signal }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location;
        response.destroy();
        if (!location) {
          reject(new Error("Redirecionamento YARA sem destino."));
          return;
        }
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error("Limite de redirecionamentos YARA excedido."));
          return;
        }

        let target: URL;
        try {
          target = new URL(location, source);
        } catch {
          reject(new Error("Destino de redirecionamento YARA inválido."));
          return;
        }
        if (target.protocol !== "https:" || target.origin !== origin || target.username || target.password) {
          reject(new Error("Redirecionamento HTTPS para origem diferente não permitido."));
          return;
        }
        requestSource(target.toString(), origin, redirects + 1, requestGet, signal).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} ao baixar fonte YARA.`));
        response.destroy();
        return;
      }

      const declaredLength = response.headers["content-length"];
      let declaredBytes: number | undefined;
      if (declaredLength !== undefined) {
        const length = Number(declaredLength);
        if (!Number.isSafeInteger(length) || length < 0) {
          reject(new Error("Tamanho declarado da fonte YARA inválido."));
          response.destroy();
          return;
        }
        if (length > MAX_YARA_SOURCE_BYTES) {
          reject(new Error(`Fonte YARA excede o limite de ${MAX_YARA_SOURCE_BYTES} bytes.`));
          response.destroy();
          return;
        }
        declaredBytes = length;
      }

      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      response.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += bytes.length;
        if (receivedBytes > MAX_YARA_SOURCE_BYTES) {
          fail(new Error(`Fonte YARA excede o limite de ${MAX_YARA_SOURCE_BYTES} bytes.`));
          response.destroy();
          request.destroy();
          return;
        }
        chunks.push(bytes);
      });
      response.on("end", () => {
        if (settled) return;
        // Uma resposta HTTP completa tem de entregar exatamente os bytes que
        // declarou. Um "end" antes do fim declarado é uma transferência
        // truncada: aceitá-la publicaria um corpus parcial (por exemplo, só a
        // primeira regra do ficheiro) como se fosse o corpus completo.
        if (declaredBytes !== undefined && receivedBytes !== declaredBytes) {
          settled = true;
          reject(
            new Error(
              `Resposta YARA truncada: ${receivedBytes} de ${declaredBytes} bytes declarados.`,
            ),
          );
          return;
        }
        settled = true;
        resolve(Buffer.concat(chunks, receivedBytes).toString("utf8"));
      });
      // Uma ligação cortada antes do "end" nunca pode ficar pendente: sem este
      // caminho, a promessa ficava suspensa até ao timeout do pedido.
      response.on("aborted", () => {
        fail(new Error("Ligação interrompida durante o download da fonte YARA."));
      });
      response.on("close", () => {
        if (!settled) {
          fail(new Error("Ligação YARA fechada antes do fim da resposta."));
        }
      });
      response.on("error", fail);
    });

    request.on("error", reject);
    request.on("timeout", () => {
      const error = new Error("Timeout ao baixar fonte YARA.");
      request.destroy(error);
      reject(error);
    });
  });
}
