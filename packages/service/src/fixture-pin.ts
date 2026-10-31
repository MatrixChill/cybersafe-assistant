import { createRequire } from "node:module";
import path from "node:path";
import type { SnapshotFixture } from "./dev-fixture-gate.js";

/** Only the fixture gate uses this lease. No polling, process or filesystem writes. */
export function pinFixture(snapshot: SnapshotFixture): { release(): void } {
  if (process.platform !== "win32") throw new Error("realdev_fixture_gate: locks Windows indisponíveis");
  const require = createRequire(import.meta.url);
  // Already an optional core dependency. Absence is a refusal, never a fallback
  // to stat checks or an unprotected scan. No package installation here.
  const koffi = require("koffi") as {
    load(name: string): { func(signature: string): (...args: unknown[]) => unknown };
  };
  const kernel = koffi.load("kernel32.dll");
  const open = kernel.func("void * __stdcall CreateFileW(str16 name, uint32 access, uint32 share, void *security, uint32 creation, uint32 flags, void *template)");
  const info = kernel.func("bool __stdcall GetFileInformationByHandle(void *handle, void *info)");
  const close = kernel.func("bool __stdcall CloseHandle(void *handle)");
  const handles: unknown[] = [];
  const release = () => {
    // Keep any unconfirmed handle for a subsequent release attempt.
    for (let i = handles.length - 1; i >= 0; i--) {
      if (close(handles[i])) handles.splice(i, 1);
    }
    if (handles.length) throw new Error("realdev_fixture_gate: libertação de locks não confirmada");
  };
  try {
    const paths = new Set<string>();
    // Pin the full lexical chain, not just the leaf: otherwise an ancestor
    // rename/junction would redirect the engine's later path-based open.
    for (const name of snapshot.nos.keys()) {
      let current = path.parse(name).root;
      for (const segment of path.relative(current, name).split(/[\\/]+/).filter(Boolean)) {
        current = path.join(current, segment); paths.add(current);
      }
    }
    for (const name of paths) {
      // GENERIC_READ is essential: FILE_READ_ATTRIBUTES alone does NOT enforce
      // share denial on Windows. FILE_SHARE_READ only denies WRITE and DELETE.
      // OPEN_REPARSE_POINT + BACKUP_SEMANTICS opens directories without following links.
      const handle = open(name, 0x80000000, 1, null, 3, 0x02200000, null);
      if (handle === null || handle === -1n || handle === 0xffffffffffffffffn) {
        throw new Error("realdev_fixture_gate: não foi possível bloquear o corpus");
      }
      handles.push(handle);
      const buffer = Buffer.alloc(52); // BY_HANDLE_FILE_INFORMATION, fixed Win32 layout.
      if (!info(handle, buffer) || (buffer.readUInt32LE(0) & 0x400) !== 0) {
        throw new Error("realdev_fixture_gate: reparse ou identidade de handle indisponível");
      }
      const expected = snapshot.nos.get(process.platform === "win32" ? name.toLowerCase() : name);
      if (!expected) continue; // Ancestors above fixture root have no corpus content.
      const directory = (buffer.readUInt32LE(0) & 0x10) !== 0;
      const volume = BigInt(buffer.readUInt32LE(28));
      const ino = (BigInt(buffer.readUInt32LE(44)) << 32n) | BigInt(buffer.readUInt32LE(48));
      const size = (BigInt(buffer.readUInt32LE(32)) << 32n) | BigInt(buffer.readUInt32LE(36));
      const modified = buffer.readBigUInt64LE(20) / 10000n - 11644473600000n;
      if (volume !== expected.dev || ino !== expected.ino || directory !== (expected.tipo === "dir") ||
          (!directory && (buffer.readUInt32LE(40) !== 1 || size !== expected.size || modified !== expected.mtimeMs))) {
        throw new Error("realdev_fixture_gate: objecto alterado antes do lock");
      }
    }
    return { release };
  } catch (error) {
    release();
    throw error;
  }
}
