/**
 * Identidade REAL da build instalada, lida do carimbo produzido pelo staging
 * do renderer (`dist/build-identity.json`).
 *
 * Porque existe: a secção de Atualizações mostrava «Compilação desconhecida» e
 * «Código desconhecido» mesmo numa instalação empacotada. O main só conhecia
 * `app.getVersion()` (versão), portanto o snapshot do updater não tinha build
 * nem commit.
 *
 * Falha fechado: carimbo ausente/ inválido/ de OUTRA versão ⇒ campos ausentes ⇒
 * a UI diz «desconhecida/desconhecido», como antes. Nada é inferido do nome do
 * ficheiro, de `process.env` ou da versão do executável.
 */
import fs from "node:fs";
import path from "node:path";

export interface InstalledBuildIdentity {
  version?: string;
  build?: string;
  commit?: string;
}

const BUILD_ID = /^[0-9A-Za-z._-]{1,64}$/;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

export function parseBuildIdentity(raw: unknown, expectedVersion?: string): InstalledBuildIdentity {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  const version = typeof record.version === "string" && record.version.trim() ? record.version.trim() : undefined;
  // Coerência: um carimbo de outra versão não descreve esta instalação.
  if (expectedVersion !== undefined && version !== expectedVersion) return {};
  const build = typeof record.buildId === "string" && BUILD_ID.test(record.buildId) ? record.buildId : undefined;
  const commit = typeof record.commit === "string" && COMMIT_SHA.test(record.commit) ? record.commit : undefined;
  return { version, build, commit };
}

export function readBuildIdentity(
  appPath: string,
  expectedVersion?: string,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): InstalledBuildIdentity {
  try {
    return parseBuildIdentity(JSON.parse(readFile(path.join(appPath, "dist", "build-identity.json"))), expectedVersion);
  } catch {
    return {};
  }
}
