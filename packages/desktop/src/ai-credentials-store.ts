import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  classificaMecanismoCredenciais,
  mecanismoPermiteCifra,
  type MecanismoCredenciais,
  type OrigemCredencial,
} from "./mecanismo-credenciais.js";

export interface AiCredentialsEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  /**
   * `safeStorage.getSelectedStorageBackend()` do Electron 33 — só tem significado
   * em Linux. Ausente ⇒ não afirmamos que a cifra é segura (fail closed).
   */
  getSelectedStorageBackend?(): string;
}

export interface AiCredentialsStore {
  hasKey(): boolean;
  getProvider(): string;
  readKey(): string | null;
  writeKey(key: unknown, provider?: unknown): void;
  writeKeyLocalProtegido(key: unknown, provider?: unknown, consentido?: unknown): void;
  estado(): AiCredentialsEstado;
  clear(): void;
}

export interface AiCredentialsEstado {
  hasKey: boolean;
  provider: string;
  /** Como a chave ativa está em repouso; `null` quando não há chave. */
  origem: OrigemCredencial | null;
  mecanismo: MecanismoCredenciais;
}

export type CodigoRecusaArmazenamento =
  | "mecanismo-insuficiente"
  | "sem-consentimento"
  | "cifra-segura-disponivel";

/** Recusa de escrita que o IPC traduz num estado honesto no ecrã. */
export class RecusaArmazenamento extends Error {
  constructor(
    readonly codigo: CodigoRecusaArmazenamento,
    mensagem: string,
    readonly mecanismo?: MecanismoCredenciais,
  ) {
    super(mensagem);
    this.name = "RecusaArmazenamento";
  }
}

const validApiKey = (key: unknown): key is string =>
  typeof key === "string" && key.trim().length >= 16 && key.trim().length <= 512 && !/[\r\n\x00]/.test(key);

const validProvider = (p: unknown): p is string =>
  typeof p === "string" && ["groq", "openai"].includes(p);

/**
 * Armazenamento de credenciais de IA (Groq/OpenAI).
 * - A cifra é o mecanismo da plataforma (`safeStorage`: DPAPI em Windows,
 *   Keychain em macOS, gestor de segredos em Linux) e só é usada quando esse
 *   mecanismo está confirmado — ver `mecanismo-credenciais.ts`.
 * - Ficheiro binário cifrado isolado em secrets/ai-credentials.bin.
 * - Sem mecanismo confirmado, a única alternativa é o ficheiro local 0600 SEM
 *   CIFA, e só com confirmação explícita do utilizador. Não existe fallback
 *   silencioso a texto puro.
 * - Recusa links simbólicos, hard links e diretórios malformados.
 * - O renderer NUNCA recebe a chave de volta via read (apenas presença,
 *   provider, origem e mecanismo).
 */
export function createAiCredentialsStore(
  userData: string,
  encryption: AiCredentialsEncryption,
  opcoes: { plataforma?: NodeJS.Platform; mecanismo?: MecanismoCredenciais } = {},
): AiCredentialsStore {
  const plataforma = opcoes.plataforma ?? process.platform;
  const mecanismo =
    opcoes.mecanismo ??
    classificaMecanismoCredenciais({
      plataforma,
      cifradoDisponivel: encryption.isEncryptionAvailable(),
      backend: plataforma === "linux" ? encryption.getSelectedStorageBackend?.() ?? null : null,
    });
  const directory = path.join(userData, "secrets");
  const file = path.join(directory, "ai-credentials.bin");
  const localFile = path.join(directory, "ai-credentials.local");
  let memoryKey: string | null = null;
  let memoryProvider = "groq";
  let memoryOrigem: OrigemCredencial | null = null;

  function guard(target: string, directoryExpected: boolean) {
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (directoryExpected ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
        throw new Error("Armazenamento de credenciais inseguro.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  function check() {
    guard(userData, true);
    guard(directory, true);
    guard(file, false);
    guard(localFile, false);
  }

  /** Escrita atómica, idêntica para os dois destinos possíveis. */
  function gravaBytes(destino: string, dados: Buffer) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    check();
    const temporary = path.join(directory, ".ai-" + randomUUID() + ".tmp");
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, dados);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      guard(destino, false);
      fs.renameSync(temporary, destino);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  function leCifrado(): { apiKey: string; provider: string } | null {
    if (!fs.existsSync(file) || !encryption.isEncryptionAvailable()) return null;
    if (fs.statSync(file).size > 32768) return null;
    try {
      const parsed = JSON.parse(encryption.decryptString(fs.readFileSync(file)));
      return validApiKey(parsed.apiKey) && validProvider(parsed.provider)
        ? { apiKey: parsed.apiKey.trim(), provider: parsed.provider }
        : null;
    } catch {
      return null;
    }
  }

  function leLocal(): { apiKey: string; provider: string } | null {
    if (!fs.existsSync(localFile)) return null;
    if (fs.statSync(localFile).size > 32768) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(localFile, "utf8"));
      return validApiKey(parsed.apiKey) && validProvider(parsed.provider)
        ? { apiKey: parsed.apiKey.trim(), provider: parsed.provider }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * A cifra tem prioridade: se o utilizador arrumar um keyring depois de ter
   * aceite o ficheiro sem cifra, passa a contar a versão cifrada — e o
   * `estado()` diz qual está ativa.
   */
  function carrega(): { apiKey: string; provider: string; origem: OrigemCredencial } | null {
    check();
    const cifrado = leCifrado();
    if (cifrado) return { ...cifrado, origem: "cifrado" };
    const local = leLocal();
    return local ? { ...local, origem: "local-protegido" } : null;
  }

  const recusaCifra = () =>
    new RecusaArmazenamento(
      "mecanismo-insuficiente",
      `Sem mecanismo seguro de armazenamento: ${mecanismo.rotulo} — ${mecanismo.explicacao}` +
        (mecanismo.remedio ? ` ${mecanismo.remedio}` : ""),
      mecanismo,
    );

  function validaNasce(key: unknown, provider: unknown): { apiKey: string; provider: string } {
    if (!validApiKey(key)) {
      throw new TypeError("Chave de API inválida (deve ter entre 16 e 512 caracteres).");
    }
    if (!validProvider(provider)) throw new TypeError("Fornecedor não permitido.");
    return { apiKey: key.trim(), provider };
  }

  return {
    hasKey() {
      if (memoryKey) return true;
      const carregada = carrega();
      if (!carregada) return false;
      memoryKey = carregada.apiKey;
      memoryProvider = carregada.provider;
      memoryOrigem = carregada.origem;
      return true;
    },
    getProvider() {
      this.readKey();
      return memoryProvider;
    },
    readKey() {
      // Uso exclusivo do processo Main para passar à API local no arranque/recarregamento
      if (memoryKey) return memoryKey;
      const carregada = carrega();
      if (!carregada) return null;
      memoryKey = carregada.apiKey;
      memoryProvider = carregada.provider;
      memoryOrigem = carregada.origem;
      return memoryKey;
    },
    writeKey(key: unknown, provider: unknown = "groq") {
      const entrada = validaNasce(key, provider);
      if (!mecanismoPermiteCifra(mecanismo)) throw recusaCifra();
      gravaBytes(
        file,
        encryption.encryptString(
          JSON.stringify({ apiKey: entrada.apiKey, provider: entrada.provider, savedAt: Date.now() }),
        ),
      );
      memoryKey = entrada.apiKey;
      memoryProvider = entrada.provider;
      memoryOrigem = "cifrado";
    },
    writeKeyLocalProtegido(key: unknown, provider: unknown = "groq", consentido: unknown = false) {
      const entrada = validaNasce(key, provider);
      if (consentido !== true) {
        throw new RecusaArmazenamento(
          "sem-consentimento",
          "A guarda sem cifra exige confirmação explícita de que a chave fica em texto puro neste computador.",
          mecanismo,
        );
      }
      if (mecanismoPermiteCifra(mecanismo)) {
        throw new RecusaArmazenamento(
          "cifra-segura-disponivel",
          `Existe um mecanismo seguro (${mecanismo.rotulo}); a chave é guardada cifrada, não em texto puro.`,
          mecanismo,
        );
      }
      gravaBytes(
        localFile,
        Buffer.from(JSON.stringify({ apiKey: entrada.apiKey, provider: entrada.provider, savedAt: Date.now() }), "utf8"),
      );
      memoryKey = entrada.apiKey;
      memoryProvider = entrada.provider;
      memoryOrigem = "local-protegido";
    },
    estado() {
      const hasKey = this.hasKey();
      return {
        hasKey,
        provider: hasKey ? memoryProvider : "groq",
        origem: hasKey ? memoryOrigem : null,
        mecanismo,
      };
    },
    clear() {
      memoryKey = null;
      memoryProvider = "groq";
      memoryOrigem = null;
      check();
      if (fs.existsSync(file)) fs.unlinkSync(file);
      if (fs.existsSync(localFile)) fs.unlinkSync(localFile);
    },
  };
}
