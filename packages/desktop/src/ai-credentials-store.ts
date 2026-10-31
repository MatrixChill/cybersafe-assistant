import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface AiCredentialsEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface AiCredentialsStore {
  hasKey(): boolean;
  getProvider(): string;
  readKey(): string | null;
  writeKey(key: unknown, provider?: unknown): void;
  clear(): void;
}

const validApiKey = (key: unknown): key is string =>
  typeof key === "string" && key.trim().length >= 16 && key.trim().length <= 512 && !/[\r\n\x00]/.test(key);

const validProvider = (p: unknown): p is string =>
  typeof p === "string" && ["groq", "openai"].includes(p);

/**
 * Armazenamento seguro de credenciais de IA (Groq/OpenAI) usando safeStorage / DPAPI do Windows.
 * - Nunca grava em texto limpo.
 * - Ficheiro binário cifrado isolado em secrets/ai-credentials.bin.
 * - Recusa links simbólicos ou diretórios malformados.
 * - O renderer NUNCA recebe a chave de volta via read (apenas status booleano hasKey e provider).
 */
export function createAiCredentialsStore(userData: string, encryption: AiCredentialsEncryption): AiCredentialsStore {
  const directory = path.join(userData, "secrets");
  const file = path.join(directory, "ai-credentials.bin");
  let memoryKey: string | null = null;
  let memoryProvider = "groq";

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
  }

  return {
    hasKey() {
      if (memoryKey) return true;
      check();
      if (!fs.existsSync(file) || !encryption.isEncryptionAvailable() || fs.statSync(file).size > 32768) return false;
      try {
        const raw = encryption.decryptString(fs.readFileSync(file));
        const parsed = JSON.parse(raw);
        return validApiKey(parsed.apiKey) && validProvider(parsed.provider);
      } catch {
        return false;
      }
    },
    getProvider() {
      this.readKey();
      return memoryProvider;
    },
    readKey() {
      // Uso exclusivo do processo Main para passar à API local no arranque/recarregamento
      if (memoryKey) return memoryKey;
      check();
      if (!fs.existsSync(file) || !encryption.isEncryptionAvailable()) return null;
      if (fs.statSync(file).size > 32768) return null;
      try {
        const raw = encryption.decryptString(fs.readFileSync(file));
        const parsed = JSON.parse(raw);
        if (validApiKey(parsed.apiKey) && validProvider(parsed.provider)) {
          memoryKey = parsed.apiKey;
          if (validProvider(parsed.provider)) memoryProvider = parsed.provider;
          return memoryKey;
        }
        return null;
      } catch {
        return null;
      }
    },
    writeKey(key: unknown, provider: unknown = "groq") {
      if (!validApiKey(key)) {
        throw new TypeError("Chave de API inválida (deve ter entre 16 e 512 caracteres).");
      }
      if (!validProvider(provider)) throw new TypeError("Fornecedor não permitido.");
      const prov = provider;
      check();
      if (!encryption.isEncryptionAvailable()) {
        throw new Error("A proteção DPAPI/safeStorage não está disponível neste sistema.");
      }

      const payload = JSON.stringify({ apiKey: key.trim(), provider: prov, savedAt: Date.now() });
      const encrypted = encryption.encryptString(payload);

      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      check();

      const temporary = path.join(directory, ".ai-" + randomUUID() + ".tmp");
      let fd: number | undefined;
      try {
        fd = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(fd, encrypted);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        guard(file, false);
        fs.renameSync(temporary, file);
        memoryKey = key.trim();
        memoryProvider = prov;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    },
    clear() {
      memoryKey = null;
      memoryProvider = "groq";
      check();
      if (fs.existsSync(file)) fs.unlinkSync(file);
    },
  };
}
