import fs from "node:fs";
import path from "node:path";

/** Explicit per-user additions only. Discovering a mounted USB is NOT consent
 * to enumerate or watch its contents. No recursive scan is performed here. */
export function readLinuxMonitoringProfile(file: string): { directories: string[]; configured: boolean; error?: "invalid-profile" } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077) || stat.size > 8192) throw new Error();
    const data = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!Array.isArray(data.directories) || data.directories.length > 16) throw new Error();
    const directories: string[] = [];
    for (const p of data.directories) {
      if (typeof p !== "string" || !path.isAbsolute(p) || /[\r\n\0]/.test(p)) throw new Error();
      const normalized = path.resolve(p);
      if (normalized === "/" || /^\/(?:proc|sys|dev|run|etc|usr|bin|sbin|lib(?:32|64)?|boot)(?:\/|$)/.test(normalized)
        || !fs.lstatSync(normalized).isDirectory() || fs.realpathSync(normalized) !== normalized) throw new Error();
      fs.accessSync(normalized, fs.constants.R_OK | fs.constants.X_OK);
      directories.push(normalized);
    }
    return { directories: [...new Set(directories)], configured: true };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" && fd === undefined
      ? { directories: [], configured: false } : { directories: [], configured: false, error: "invalid-profile" };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
