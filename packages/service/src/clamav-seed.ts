/**
 * Automatic offline seeding is deliberately unavailable.
 *
 * 327fe12 used access()+rename(), which can replace a concurrently created
 * destination. Its rollback removed published paths without retaining ownership;
 * a freshclam/other-process replacement could therefore be deleted.
 *
 * Node's path-based fs calls cannot bind all source/parent/destination operations
 * to verified directory handles on Windows. lstat/realpath checks or a JS mutex
 * do not close adversarial junction swaps or coordinate another freshclam.
 * Until a reviewed native, handle-relative publisher and interprocess protocol
 * exist, deny BEFORE reading paths, creating temporaries or touching a database.
 * This is a safety stop, NOT an implemented offline-seed capability.
 */
export const CLAMAV_SEED_MANIFEST_FILENAME = "SEED-MANIFEST.json";
export const CLAMAV_SEED_SCHEMA = "cybersafe.clamav-seed/v1";
export const CLAMAV_SEED_FILES = ["main.cvd", "daily.cld", "bytecode.cvd"] as const;
export const CLAMAV_SEED_BLOCK_REASON =
  "CLAMAV_SEED_NATIVE_BOUNDARY_REQUIRED: semente automática bloqueada; publicação nativa segura ainda não implementada.";

export type ClamavSeedResult =
  | { status: "not-provided"; reason: string }
  | { status: "invalid"; reason: string };

export interface ClamavSeedOptions {
  seedDir?: string | null;
  definitionsDir: string;
  log?: (message: string) => void;
}

export async function seedClamavDatabase(options: ClamavSeedOptions): Promise<ClamavSeedResult> {
  if (!options.seedDir?.trim()) {
    return { status: "not-provided", reason: "CYBERSAFE_CLAMAV_SEED_DIR não definido" };
  }
  return { status: "invalid", reason: CLAMAV_SEED_BLOCK_REASON };
}
