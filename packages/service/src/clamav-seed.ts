/** Packaged offline database, consumed read-only. NEVER copies into the profile.
 * Trust boundary: application resources are trusted installation bytes, not a
 * defence against an administrator or malware able to replace this application's
 * code/resources. Static links are rejected; no adversarial path-race guarantee.
 * Freshclam owns definitions/clamav exclusively and never receives this path.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const CLAMAV_SEED_MANIFEST_FILENAME = "SEED-MANIFEST.json";
export const CLAMAV_SEED_SCHEMA = "cybersafe.clamav-seed/v1";
export const CLAMAV_SEED_FILES = ["main.cvd", "daily.cld", "bytecode.cvd"] as const;
// Same release pins as scripts/clamav-seed-bundle.mjs; parity is tested.
export const CLAMAV_SEED_PINS: Record<string, { bytes: number; sha256: string }> = {
  "main.cvd": { bytes: 89072577, sha256: "0b2182d229f46981ec8f535382222f7c9dfdd656b250ad47988b910a8d302365" },
  "daily.cld": { bytes: 86543360, sha256: "b93e7f501ac1cf9cc5858393609a8a7a683e770e02cf0d8e89dcdfa15bf88e00" },
  "bytecode.cvd": { bytes: 281702, sha256: "6d4aa01f219e988060fc419f495d07f27e0cdf1a2cccc065971da922c76f7ffb" },
  "COPYING.txt": { bytes: 18738, sha256: "0c4fd2fa9733fc9122503797648710851e4ee6d9e4969dd33fcbd8c63cd2f584" },
};
export type ClamavSeedResult =
  | { status: "not-provided"; reason: string }
  | { status: "readonly-ready"; databaseDir: string }
  | { status: "invalid"; reason: string };
export interface ClamavSeedOptions {
  seedDir?: string | null;
  definitionsDir: string;
  log?: (message: string) => void;
}

/** Validate all bytes on each probe; never changes mtimes or mutable DBs. */
export async function seedClamavDatabase(options: ClamavSeedOptions): Promise<ClamavSeedResult> {
  if (!options.seedDir?.trim()) return { status: "not-provided", reason: "Semente empacotada não configurada" };
  try {
    if (!path.isAbsolute(options.seedDir)) throw new Error("Caminho da semente não absoluto");
    const dir = path.resolve(options.seedDir);
    for (let parent = dir; ; parent = path.dirname(parent)) {
      const stat = await fs.lstat(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Raiz/parent da semente não regular");
      if (path.dirname(parent) === parent) break;
    }
    const allowed = [CLAMAV_SEED_MANIFEST_FILENAME, ...Object.keys(CLAMAV_SEED_PINS)].sort();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink()) ||
        JSON.stringify(entries.map(entry => entry.name).sort()) !== JSON.stringify(allowed)) {
      throw new Error("Conjunto da semente não é plano/exacto");
    }
    const manifest = JSON.parse(await fs.readFile(path.join(dir, CLAMAV_SEED_MANIFEST_FILENAME), "utf8"));
    if (manifest.schema !== CLAMAV_SEED_SCHEMA || manifest.engine !== "ClamAV" || manifest.binaryVersion !== "1.5.4" ||
        manifest.license?.file !== "COPYING.txt" || manifest.license?.sha256 !== CLAMAV_SEED_PINS["COPYING.txt"].sha256 ||
        !Array.isArray(manifest.files) || manifest.files.length !== 3) throw new Error("Manifesto da semente inválido");
    const seen = new Set<string>();
    for (const entry of manifest.files) {
      const pin = CLAMAV_SEED_FILES.includes(entry?.name) ? CLAMAV_SEED_PINS[entry.name] : null;
      if (!pin || seen.has(entry.name) || entry.bytes !== pin.bytes || entry.sha256 !== pin.sha256) throw new Error("Pins do manifesto divergentes");
      seen.add(entry.name);
    }
    for (const [name, pin] of Object.entries(CLAMAV_SEED_PINS)) {
      const file = path.join(dir, name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.bytes) throw new Error(`Recurso inválido: ${name}`);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      if (hash.digest("hex") !== pin.sha256) throw new Error(`SHA-256 divergente: ${name}`);
    }
    return { status: "readonly-ready", databaseDir: dir };
  } catch {
    // No user paths, contents, tokens or raw filesystem errors in logs.
    return { status: "invalid", reason: "Semente empacotada ausente, ilegível ou sem integridade; fallback recusado" };
  }
}
