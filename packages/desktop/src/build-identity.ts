/**
 * Identidade REAL da build instalada, lida do carimbo produzido pelo staging
 * do renderer (`dist/build-identity.json`).
 *
 * Porque existe: a secção de Atualizações mostrava «Compilação desconhecida» e
 * «Código desconhecido» mesmo numa instalação empacotada. O main só conhecia
 * `app.getVersion()` (versão), portanto o snapshot do updater não tinha build
 * nem commit. O carimbo é escrito no build a partir do `__BUILD__` real do
 * renderer (mesma fonte que o ecrã «Sobre»), nunca inventado em runtime.
 *
 * Fail-closed: ficheiro ausente/ inválido ⇒ campos ausentes ⇒ a UI diz
 * «desconhecida/desconhecido», como antes. Nada é inferido do nome do ficheiro
 * nem de `process.env`.
 */
import fs from "node:fs";
import path from "node:path";

export interface InstalledBuildIdentity {
  version?: string;
  build?: string;
  commit?: string;
}

export function parseBuildIdentity(raw: unknown): InstalledBuildIdentity {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  const version = typeof record.version === "string" && record.version.trim() ? record.version.trim() : undefined;
  const build = typeof record.buildId === "string" && record.buildId.trim() ? record.buildId.trim() : undefined;
  const commit = typeof record.commit === "string" && /^[0-9a-f]{7,40}$/.test(record.commit) ? record.commit : undefined;
  return { version, build, commit };
}

export function readBuildIdentity(
  appPath: string,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): InstalledBuildIdentity {
  try {
    return parseBuildIdentity(JSON.parse(readFile(path.join(appPath, "dist", "build-identity.json"))));
  } catch {
    return {};
  }
}
