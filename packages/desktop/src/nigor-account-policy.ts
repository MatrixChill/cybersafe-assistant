import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const NIGOR_RESOURCES = "/opt/cybersafe-assistant-nigor/resources";
type Policy = "required" | "local-optional";
type EditionRuntime = { platform: string; packaged: boolean; resourcesPath: string };

export function isNigorInstall(runtime: EditionRuntime): boolean {
  return runtime.platform === "linux" && runtime.packaged && runtime.resourcesPath === NIGOR_RESOURCES;
}

function readManagedMarker(): unknown {
  for (let path = NIGOR_RESOURCES; ; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) return null;
    if (path === "/") break;
  }
  const fd = openSync(join(NIGOR_RESOURCES, "edition.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > 1024) return null;
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

/** Policy controls entry to the local UI. It grants no credentials or roles. */
export function resolveAccountPolicy(runtime: EditionRuntime, read = readManagedMarker): Policy {
  if (!isNigorInstall(runtime)) return "required";
  try {
    const value = read() as Record<string, unknown> | null;
    if (value?.schema === 1 && value.edition === "nigor" && value.package === "cybersafe-assistant-nigor"
      && value.accountMode === "local-optional") return "local-optional";
  } catch { /* An unreadable edition keeps the existing account requirement. */ }
  return "required";
}
