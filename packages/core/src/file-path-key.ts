/** Absolute POSIX paths are case-sensitive on Linux. Keep legacy Windows
 * path fixtures comparable even when a parser test runs on a Linux host. */
export function platformFileKey(file: string): string {
  if (process.platform === "linux" && file.startsWith("/")) return file;
  return file.replace(/\//g, "\\").toLowerCase();
}
