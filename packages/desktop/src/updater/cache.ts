/**
 * Cache dedicada do updater (TP-UPDATE-01).
 *
 * Política de caminho é PURA e testável sem disco: o nome do ficheiro deriva só
 * da versão (semver validado) e do sha256 do manifesto, e o destino é sempre
 * verificado como DENTRO do diretório de cache. Nenhum path vem do renderer.
 * A escrita/cleanup reais são delegados à porta `CacheFileSystem` (em produção,
 * node:fs; nos testes, um fake) — o módulo nunca fala com o disco sozinho.
 *
 * Contido: nada de dados de utilizador, tudo sob `cacheDir`; apagamento só de
 * caminhos que a política produziu.
 */
import path from "node:path";
import type { CacheFileSystem } from "./types.ts";

export class CachePathError extends Error {
  readonly code = "internal";
  constructor(message: string) {
    super(message);
    this.name = "CachePathError";
  }
}

/** Limpa uma string de "componente de nome" para uso seguro em ficheiros. */
function safeNamePart(value: string): string {
  // Só [A-Za-z0-9.-]; qualquer outra coisa é recusada (não "sanitizada" a calhar).
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value.includes("..")) {
    throw new CachePathError(`componente de nome inseguro: ${value}`);
  }
  return value;
}

/**
 * Caminho do artefacto dentro da cache. `version` já passou o validador semver;
 * `sha256` é hex de 64. Recusa travessia: o resultado resolvido tem de estar
 * sob `cacheDir` resolvido.
 */
export function artifactCachePath(cacheDir: string, version: string, sha256: string): string {
  const safeVersion = safeNamePart(version);
  if (!/^[0-9a-fA-F]{64}$/.test(sha256)) {
    throw new CachePathError("sha256 do manifesto inválido para nome de cache");
  }
  const base = path.resolve(cacheDir);
  const target = path.resolve(base, `update-${safeVersion}-${sha256.toLowerCase()}.tmp`);
  if (target !== path.join(base, path.basename(target))) {
    throw new CachePathError("caminho de cache fora do diretório dedicado");
  }
  return target;
}

/** Caminho final (atomic rename do `.tmp` para `.exe` validado). */
export function artifactFinalPath(cacheDir: string, version: string, sha256: string): string {
  const tmp = artifactCachePath(cacheDir, version, sha256);
  return tmp.replace(/\.tmp$/, ".exe");
}

export class CacheStore {
  private readonly fs: CacheFileSystem;
  private readonly cacheDir: string;

  constructor(fs: CacheFileSystem, cacheDir: string) {
    this.fs = fs;
    this.cacheDir = cacheDir;
  }

  async prepare(): Promise<void> {
    await this.fs.ensureDir(path.resolve(this.cacheDir));
  }

  /** Já existe um ficheiro íntegro? (tamanho = esperado) */
  async hasComplete(version: string, sha256: string, expectedBytes: number): Promise<boolean> {
    const stat = await this.fs.statFile(artifactFinalPath(this.cacheDir, version, sha256));
    return !!stat && stat.size === expectedBytes;
  }

  async stagingPath(version: string, sha256: string): Promise<string> {
    return artifactCachePath(this.cacheDir, version, sha256);
  }

  /** Escrita atómica do buffer; o fake de teste confirma que foi por tmp+rename. */
  async commitStaging(tmpPath: string, data: Uint8Array): Promise<void> {
    await this.fs.writeAtomic(tmpPath, ".exe", data);
  }

  /** Limpeza contida: apaga só o tmp/final desta versão+hash, nunca fora da cache. */
  async discard(version: string, sha256: string): Promise<void> {
    for (const p of [
      artifactCachePath(this.cacheDir, version, sha256),
      artifactFinalPath(this.cacheDir, version, sha256),
    ]) {
      await this.fs.removePath(p);
    }
  }
}
