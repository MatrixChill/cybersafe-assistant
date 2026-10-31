/**
 * Semente offline da base ClamAV.
 *
 * O payload 0.1.10-r6 levava o binário e o freshclam, mas não levava main.cvd/
 * daily.cld/bytecode.cvd. Numa primeira execução sem rede o probe ficava
 * `degraded` (sem base) e nenhum scan provava deteção. Esta semente é copiada
 * uma única vez para `<definitions>/clamav`; a partir daí o freshclam é a
 * autoridade e a cópia NUNCA sobrepõe uma base já existente.
 *
 * A cópia é fail-closed: o manifesto, os três ficheiros e a licença são
 * verificados por SHA-256 ANTES de escrever. Um seed ausente ou inválido não
 * impede o arranque — deixa o ClamAV no estado honesto `degraded`.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const CLAMAV_SEED_MANIFEST_FILENAME = "SEED-MANIFEST.json";
export const CLAMAV_SEED_SCHEMA = "cybersafe.clamav-seed/v1";
export const CLAMAV_SEED_FILES = ["main.cvd", "daily.cld", "bytecode.cvd"] as const;

const OFFICIAL_ARCHIVE_PATTERN = /\.(cvd|cld|cuv|cud)$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

type SeedEntry = { name: string; bytes: number; sha256: string };
type SeedManifest = {
  schema: string;
  engine: string;
  files: SeedEntry[];
  license: { name?: string; file: string; sha256: string };
};

export type ClamavSeedResult =
  | { status: "not-provided"; reason: string }
  | { status: "preserved-existing"; existing: string[] }
  | { status: "seeded"; files: string[] }
  | { status: "invalid"; reason: string };

export interface ClamavSeedOptions {
  /** `process.env.CYBERSAFE_CLAMAV_SEED_DIR` no serviço empacotado. */
  seedDir?: string | null;
  definitionsDir: string;
  log?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex").toLowerCase()));
  });
}

async function readRegularFile(file: string): Promise<{ size: number; sha256: string } | null> {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch {
    return null;
  }
  // O seed é publicado pelo extraResources. Um link não é um ficheiro
  // regular e não é aceite: o gate de packaging também os recusa.
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return { size: stat.size, sha256: await sha256File(file) };
}

function parseManifest(raw: string): SeedManifest | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: "manifesto não é JSON" };
  }
  if (!isRecord(value)) return { error: "manifesto não é um objecto" };
  if (value.schema !== CLAMAV_SEED_SCHEMA) return { error: `schema inesperado: ${String(value.schema)}` };
  if (value.engine !== "ClamAV") return { error: `engine inesperado: ${String(value.engine)}` };
  if (!Array.isArray(value.files) || value.files.length !== CLAMAV_SEED_FILES.length) {
    return { error: "lista de ficheiros não tem exatamente três entradas" };
  }
  const expected = new Set<string>(CLAMAV_SEED_FILES);
  const seen = new Set<string>();
  const files: SeedEntry[] = [];
  for (const entry of value.files) {
    if (!isRecord(entry)) return { error: "entrada de ficheiro inválida" };
    if (typeof entry.name !== "string" || !expected.has(entry.name)) {
      return { error: `ficheiro não permitido: ${String(entry.name)}` };
    }
    const key = entry.name.toLowerCase();
    if (seen.has(key)) return { error: `ficheiro duplicado: ${entry.name}` };
    seen.add(key);
    if (!Number.isSafeInteger(entry.bytes) || Number(entry.bytes) <= 0) {
      return { error: `tamanho inválido: ${entry.name}` };
    }
    if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
      return { error: `sha256 inválido: ${entry.name}` };
    }
    files.push({ name: entry.name, bytes: Number(entry.bytes), sha256: entry.sha256.toLowerCase() });
  }
  if (seen.size !== expected.size) return { error: "conjunto de ficheiros incompleto" };
  const license = value.license;
  if (!isRecord(license) || license.file !== "COPYING.txt" || typeof license.sha256 !== "string" || !SHA256_PATTERN.test(license.sha256)) {
    return { error: "licença COPYING.txt ausente ou sem hash" };
  }
  return {
    schema: value.schema,
    engine: value.engine,
    files,
    license: { name: typeof license.name === "string" ? license.name : undefined, file: license.file, sha256: license.sha256.toLowerCase() },
  };
}

/**
 * Copia a semente apenas quando o directório de destino ainda não tem uma base
 * oficial (.cvd/.cld/.cuv/.cud). Uma base existente, mesmo parcial, é
 * preservada por inteiro: não se misturam versões nem se inventa frescura.
 */
export async function seedClamavDatabase(options: ClamavSeedOptions): Promise<ClamavSeedResult> {
  const rawSeedDir = options.seedDir?.trim();
  if (!rawSeedDir) return { status: "not-provided", reason: "CYBERSAFE_CLAMAV_SEED_DIR não definido" };
  const seedDir = path.resolve(rawSeedDir);
  const manifestPath = path.join(seedDir, CLAMAV_SEED_MANIFEST_FILENAME);
  let text: string;
  try {
    text = await fs.readFile(manifestPath, "utf8");
  } catch {
    return { status: "invalid", reason: `manifesto ausente: ${manifestPath}` };
  }
  const manifest = parseManifest(text);
  if ("error" in manifest) return { status: "invalid", reason: manifest.error };

  const verified: Array<{ name: string; source: string; sha256: string }> = [];
  for (const entry of manifest.files) {
    const source = path.join(seedDir, entry.name);
    const measured = await readRegularFile(source);
    if (!measured) return { status: "invalid", reason: `seed ausente ou não regular: ${entry.name}` };
    if (measured.size !== entry.bytes) return { status: "invalid", reason: `tamanho divergente: ${entry.name}` };
    if (measured.sha256 !== entry.sha256) return { status: "invalid", reason: `sha256 divergente: ${entry.name}` };
    verified.push({ name: entry.name, source, sha256: measured.sha256 });
  }
  const license = await readRegularFile(path.join(seedDir, manifest.license.file));
  if (!license) return { status: "invalid", reason: "licença COPYING.txt ausente ou não regular" };
  if (license.sha256 !== manifest.license.sha256) return { status: "invalid", reason: "sha256 divergente: COPYING.txt" };

  const destination = path.join(options.definitionsDir, "clamav");
  let entries: Array<{ name: string; isFile(): boolean }> = [];
  try {
    entries = await fs.readdir(destination, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const existing = entries.filter((entry) => entry.isFile() && OFFICIAL_ARCHIVE_PATTERN.test(entry.name)).map((entry) => entry.name);
  if (existing.length > 0) {
    options.log?.(`[ClamAV] base existente preservada (${existing.length} ficheiro(s)); seed não aplicado`);
    return { status: "preserved-existing", existing };
  }

  await fs.mkdir(destination, { recursive: true });
  const temporary: Array<{ temp: string; final: string }> = [];
  const copied: string[] = [];
  try {
    for (const entry of verified) {
      const temp = path.join(destination, `.${entry.name}.${process.pid}.${Date.now()}.tmp`);
      await fs.copyFile(entry.source, temp, fsConstants.COPYFILE_EXCL);
      const copiedHash = await sha256File(temp);
      if (copiedHash !== entry.sha256) throw new Error(`cópia corrompida: ${entry.name}`);
      temporary.push({ temp, final: path.join(destination, entry.name) });
    }
    for (const item of temporary) {
      // Não sobrepõe: se o ficheiro apareceu entretanto, o temp é descartado.
      try {
        await fs.access(item.final);
        continue;
      } catch {
        /* ainda ausente */
      }
      await fs.rename(item.temp, item.final);
      copied.push(item.final);
    }
    options.log?.(`[ClamAV] semente inicial aplicada: ${copied.map((file) => path.basename(file)).join(", ")}`);
    return { status: "seeded", files: copied.map((file) => path.basename(file)) };
  } catch (error) {
    for (const item of temporary) {
      await fs.rm(item.temp, { force: true }).catch(() => undefined);
    }
    for (const file of copied) {
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
    return { status: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
}
