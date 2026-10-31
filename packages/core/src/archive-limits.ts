/** Application limits supplement the patched ZIP parser. No extraction API is used. */
export const ARCHIVE_MAX_ENTRY_BYTES = 400 * 1024;
export const ARCHIVE_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const ARCHIVE_MAX_ENTRIES = 500;
export const ARCHIVE_MAX_RATIO = 1000;

interface ArchiveEntry {
  entryName: string;
  header: { size: number; compressedSize: number };
  getData(): Buffer;
}

/** Closed refusal classes. The consumer maps them to an HTTP status; the
 * message stays the stable code so older string-based consumers keep working. */
export type ArchiveEntryRefusalCode =
  | "ARCHIVE_ENTRY_LIMIT"
  | "ARCHIVE_ENTRY_SIZE_MISMATCH"
  | "ARCHIVE_ENTRY_REJECTED";

export class ArchiveEntryError extends Error {
  constructor(readonly code: ArchiveEntryRefusalCode) {
    super(code);
    this.name = "ArchiveEntryError";
  }
}

export function readBoundedArchiveEntry(entry: ArchiveEntry, remainingBytes: number): Buffer {
  const name = entry.entryName.replace(/\\/g, "/");
  const parts = name.split("/");
  const { size, compressedSize } = entry.header;
  const unsafeName = !name || name.startsWith("/") || /[:\u0000]/.test(name) ||
    parts.some(p => !p || p === "." || p === ".." || /[. ]$/.test(p));
  if (unsafeName) throw new ArchiveEntryError("ARCHIVE_ENTRY_REJECTED");
  // Declared sizes are validated BEFORE any decompression. The per-entry
  // budget is the same 400 KiB the Scanner applies (ARCHIVE_MAX_ENTRY_BYTES),
  // so a file accepted by one path cannot be refused by the other.
  if (!Number.isSafeInteger(size) || size < 0 ||
      !Number.isSafeInteger(compressedSize) || compressedSize < 0 ||
      !Number.isSafeInteger(remainingBytes) || remainingBytes < 0 ||
      size > Math.min(ARCHIVE_MAX_ENTRY_BYTES, remainingBytes) ||
      (size === 0 && compressedSize > 2) ||
      size / Math.max(compressedSize, 1) > ARCHIVE_MAX_RATIO) {
    throw new ArchiveEntryError("ARCHIVE_ENTRY_LIMIT");
  }
  const data = entry.getData();
  if (data.length !== size || data.length > remainingBytes || data.length > ARCHIVE_MAX_ENTRY_BYTES) {
    throw new ArchiveEntryError("ARCHIVE_ENTRY_SIZE_MISMATCH");
  }
  return data;
}
