import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface SessionEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export interface AuthSessionStore {
  read(): string | null;
  write(token: unknown, remember: unknown): void;
  clear(): void;
}
const validToken = (token: unknown): token is string =>
  typeof token === "string" && token.length <= 16384 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

/** Bearers are kept in memory unless remembering is explicitly requested.
 * On Windows safeStorage uses DPAPI: protects at rest from other users, not
 * from software already running as this user. No plaintext fallback.
 */
export function createAuthSessionStore(userData: string, encryption: SessionEncryption): AuthSessionStore {
  const directory = path.join(userData, "secrets");
  const file = path.join(directory, "auth-session.bin");
  let memory: string | null = null;
  function guard(target: string, directoryExpected: boolean) {
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (directoryExpected ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
        throw new Error("Armazenamento de sessão inseguro.");
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  function check() { guard(userData, true); guard(directory, true); guard(file, false); }
  return {
    read() {
      if (memory) return memory;
      check();
      if (!fs.existsSync(file) || !encryption.isEncryptionAvailable()) return null;
      if (fs.statSync(file).size > 32768) return null;
      try {
        const token = encryption.decryptString(fs.readFileSync(file));
        return validToken(token) ? (memory = token) : null;
      } catch { return null; } // Corruption never establishes an identity.
    },
    write(token, remember) {
      if (!validToken(token) || typeof remember !== "boolean") throw new TypeError("Sessão inválida.");
      check();
      if (!remember) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        memory = token;
        return;
      }
      if (!encryption.isEncryptionAvailable()) throw new Error("A proteção da sessão não está disponível.");
      const encrypted = encryption.encryptString(token);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      check();
      const temporary = path.join(directory, ".auth-" + randomUUID() + ".tmp");
      let fd: number | undefined;
      try {
        fd = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        guard(file, false); fs.renameSync(temporary, file);
        memory = token;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    },
    clear() { memory = null; check(); if (fs.existsSync(file)) fs.unlinkSync(file); },
  };
}
