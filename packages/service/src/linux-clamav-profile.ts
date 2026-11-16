import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** No automatic daemon activation. A per-user, private opt-in is shared by
 * GUI-started and systemd-started services; absent/invalid means economy. */
export function readLinuxClamavProfile(file = path.join(os.homedir(), ".config/cybersafe-assistant-linux-lite/clamav-profile.json")): { socketPath: string; databaseDirectory: string } | undefined {
  if (process.platform !== "linux") return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077) || stat.size > 4096) return undefined;
    const data = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (data.mode !== "performance" || typeof data.socketPath !== "string" || !path.isAbsolute(data.socketPath)
      || /[\r\n\0]/.test(data.socketPath) || data.socketPath.length > 100) return undefined;
    const databaseDirectory = data.databaseDirectory ?? "/var/lib/clamav";
    if (typeof databaseDirectory !== "string" || !path.isAbsolute(databaseDirectory) || /[\r\n\0]/.test(databaseDirectory)) return undefined;
    return { socketPath: data.socketPath, databaseDirectory };
  } catch { return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
