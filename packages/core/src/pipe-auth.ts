import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Autenticação do named pipe (v2) — helper PURO, sem estado, sem I/O.
 *
 * Contrato (ver TP-QA2-PIPE-AUTH):
 *  - token, nonces e prova são 32 bytes em hex minúsculo (exatamente 64 chars);
 *  - a prova é HMAC-SHA256 com chave `Buffer.from(token,'hex')` sobre a mensagem
 *    UTF-8 `cybersafe-pipe-v2:<role>:<clientNonce>:<serverNonce>`;
 *  - o domínio inclui o papel, por isso a prova de servidor não serve como prova
 *    de cliente (anti-reflexão); ambos os nonces entram na mensagem, por isso
 *    provas de outra ligação não validam.
 *
 * O que este ficheiro NÃO faz: gerar/guardar nonces de ligação, decidir fases do
 * handshake, travar replay dentro da mesma ligação ou ler o token de onde quer
 * que seja. Isso é do handshake (serviço/cliente) — aqui não há segredo em
 * memória global, `process.env`, ficheiros, rede nem logs.
 */

export const PIPE_AUTH_VERSION = 2;

export type PipeProofRole = "server" | "client";

const DOMINIO = "cybersafe-pipe-v2";
const HEX_32_BYTES = /^[0-9a-f]{64}$/;

const isHex32 = (value: unknown): value is string =>
  typeof value === "string" && HEX_32_BYTES.test(value);

const isRole = (value: unknown): value is PipeProofRole =>
  value === "server" || value === "client";

/** Novo nonce de 32 bytes (hex minúsculo). Não guarda nada. */
export function generatePipeNonce(): string {
  return randomBytes(32).toString("hex");
}

/** `true` apenas para string de 64 chars hex minúsculos (32 bytes). */
export function isPipeNonce(value: unknown): value is string {
  return isHex32(value);
}

// Mensagens de erro fixas: nunca incluem o valor recebido (segredo/nonce).
const exigirHex32 = (value: unknown, campo: "token" | "clientNonce" | "serverNonce"): string => {
  if (!isHex32(value)) throw new TypeError(`pipe-auth: ${campo} inválido`);
  return value;
};

const exigirRole = (value: unknown): PipeProofRole => {
  if (!isRole(value)) throw new TypeError("pipe-auth: role inválido");
  return value;
};

const mensagem = (role: PipeProofRole, clientNonce: string, serverNonce: string): string =>
  `${DOMINIO}:${role}:${clientNonce}:${serverNonce}`;

/**
 * Prova HMAC-SHA256 do papel indicado. Lança `TypeError` (mensagem sem valores)
 * para token/role/nonces inválidos — não devolve prova parcial.
 */
export function makePipeProof(
  token: string,
  role: PipeProofRole,
  clientNonce: string,
  serverNonce: string,
): string {
  const chave = exigirHex32(token, "token");
  const papel = exigirRole(role);
  const cliente = exigirHex32(clientNonce, "clientNonce");
  const servidor = exigirHex32(serverNonce, "serverNonce");

  return createHmac("sha256", Buffer.from(chave, "hex"))
    .update(mensagem(papel, cliente, servidor), "utf8")
    .digest("hex");
}

/**
 * Verifica a prova em tempo constante. Qualquer entrada inválida (token, role,
 * nonces, prova de formato errado, comprimento diferente) devolve `false` — não
 * lança e não distingue o motivo.
 */
export function verifyPipeProof(
  token: string,
  role: PipeProofRole,
  clientNonce: string,
  serverNonce: string,
  proof: unknown,
): boolean {
  if (!isHex32(proof)) return false;

  let esperado: string;
  try {
    esperado = makePipeProof(token, role, clientNonce, serverNonce);
  } catch {
    return false;
  }

  const esperadoBuf = Buffer.from(esperado, "hex");
  const provaBuf = Buffer.from(proof, "hex");
  if (esperadoBuf.length !== 32 || provaBuf.length !== esperadoBuf.length) return false;

  return timingSafeEqual(esperadoBuf, provaBuf);
}
