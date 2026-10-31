/**
 * CacheFileSystem REAL sobre node:fs (TP-UPDATE-ADAPTERS item 2, endurecido em
 * TP-UPDATE-CACHE-HARDEN).
 *
 * Vive numa diretório DEDICADO (root) e NUNCA sai dele. Nada de userData real aqui:
 * o root é injetado; em produção seria uma subpasta da cache do updater, nos testes
 * é um mkdtemp criado pelo próprio teste. publisher/installer permanecem bloqueados —
 * este módulo só move BYTES para a cache.
 *
 * Política de contenção (defesa em profundidade):
 *  - `path.resolve` + verificação de PREFIXO com fronteira de separador ⇒ bloqueia
 *    travessia `..` (path-escape).
 *  - `lstat` no componente final ⇒ recusa SYMLINK (não segue) e recusa diretório onde
 *    se espera ficheiro.
 *  - `realpath` do alvo e do root ⇒ um SYMLINK/JUNCTION em qualquer componente intermédio
 *    que aponte para fora de root é detetado (o caminho canónico sai do root).
 *  - `writeAtomic` (endurecido): temp exclusivo (`O_EXCL`) + fsync + UMA única `rename`.
 *    Se `rename` falhar, NÃO apagamos o destino para tentar de novo (isso destruiria o
 *    artefacto bom anterior); limpamos só o nosso temp e FALHAMOS FECHADO. Nunca
 *    chamamos `rm+rename` de "atómico"; preferimos rejeitar a sobrescrita.
 *  - `readFile` (endurecido): em POSIX usa handle `O_NOFOLLOW` + `fstat` (no-follow
 *    atómico do componente final). Em Windows lê o caminho canónico validado, com o
 *    TOCTOU restante DOCUMENTADO no corpo deste ficheiro (não resolvido por
 *    lstat+realpath sozinhos).
 *
 * LIMITAÇÃO honesta: `O_NOFOLLOW` não é suportado em Windows; a contenção em Windows
 * assenta em lstat+realpath+prefixo, que são verificações NÃO-atómicas sobre o caminho
 * (janela TOCTOU de componente intermédio/final trocado após a verificação). O teste de
 * symlink/junction só prova o que o SO/host permitir criar; se a criação for recusada,
 * o teste declara UNSUPPORTED (não finge PASS).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { CacheFileSystem } from "./types.ts";

export class CacheFsError extends Error {
  readonly kind: "escape" | "symlink" | "not-regular" | "missing" | "io";
  constructor(kind: CacheFsError["kind"], message: string) {
    super(message);
    this.name = "CacheFsError";
    this.kind = kind;
  }
}

/** `child` resolvido está DENTRO de `root` resolvido (com fronteira de separador). */
function isWithin(root: string, child: string): boolean {
  if (child === root) return true;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(withSep);
}

/**
 * No-follow ATÓMICO pelo HANDLE, quando o SO o suporta.
 *
 * Em POSIX, `O_RDONLY | O_NOFOLLOW` faz `open` FALHAR (ELOOP) se o COMPONENTE FINAL
 * for um symlink, e o `fstat` sobre o handle confirma ficheiro-regular sem nova
 * resolução de caminho ⇒ não há janela entre "verificar" e "ler" no último segmento
 * (elimina o TOCTOU do componente final que `lstat`+`realpath`+ler-por-caminho deixa
 * aberto). O `O_NOFOLLOW` NÃO cobre componentes INTERMÉDIOS (esses são seguidos pelo
 * open); a contenção intermédia continua a assentar no `realpath` do `guard`.
 *
 * Em Windows `O_NOFOLLOW` NÃO é suportado pelo Node ⇒ `handleNoFollowSupported` é
 * false e caímos no caminho realpath (ver `readFile`). TOCTOU RESTANTE no Windows,
 * documentado sem fingir que está resolvido:
 *   (a) um symlink/junction INTERMÉDIO pode ser trocado DEPOIS do `realpath` do guard
 *       e antes do `open`, levando a leitura para fora de root; e
 *   (b) o componente FINAL pode ser trocado por um link entre o `lstat`/`realpath` do
 *       guard e o `open`, porque em Windows o `CreateFile` segue reparse points e não
 *       há flag de no-follow. Nem `lstat` nem `realpath` SOZINHOS fecham estas janelas —
 *       são verificações não-atómicas sobre o caminho, não uma garantia do kernel na
 *       abertura. A mitigação real seria abrir por handle com no-follow (só POSIX) ou
 *       usar uma API Windows com `SecurityInformation`/`FILE_FLAG_OPEN_REPARSE_POINT`,
 *       que o `fs` do Node não expõe. Por isso o caminho de produção permanece bloqueado.
 */
const handleNoFollowSupported: boolean =
  typeof fs.constants.O_NOFOLLOW === "number" && process.platform !== "win32";

/** Lê um ficheiro-regular sem seguir o componente final (POSIX), via handle. */
async function readRegularByHandleNoFollow(
  fsp: typeof import("node:fs").promises,
  abs: string,
): Promise<Uint8Array | null> {
  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    // ELOOP = final é symlink (recusado); ENOENT = inexistente. Ambos ⇒ null.
    if (code === "ELOOP" || code === "ENOENT") return null;
    throw error;
  }
  try {
    const st = await handle.stat(); // fstat: atómico ao handle aberto
    if (!st.isFile()) return null;
    const chunks: Buffer[] = [];
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buf.buffer, buf.byteOffset, bytesRead));
    }
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

export interface NodeCacheFsOptions {
  /** Sobrescreve fs para testes de controlo; default node:fs/promises. */
  fs?: typeof import("node:fs").promises;
}

export function createNodeCacheFileSystem(root: string, options: NodeCacheFsOptions = {}): CacheFileSystem {
  const fsp = options.fs ?? fs.promises;
  const resolvedRoot = path.resolve(root);

  /** Root canónico (resolve links no próprio root). Falha se root não existir. */
  async function canonicalRoot(): Promise<string> {
    return await fsp.realpath(resolvedRoot);
  }

  /**
   * Valida um caminho de destino/origem: prefixo sob root + lstat sem symlink final +
   * realpath permanece sob root (deteta symlink/junction intermédio que fuja).
   * `mustExist=false` permite caminhos ainda não criados (para escrita), desde que o
   * respetivo DIRECTÓRIO canónico esteja contido.
   */
  async function guard(target: string, mustExist: boolean): Promise<{ abs: string; canonical: string }> {
    const abs = path.resolve(target);
    if (!isWithin(resolvedRoot, abs)) {
      throw new CacheFsError("escape", `fora do diretório de cache: ${abs}`);
    }
    const rootReal = await canonicalRoot();

    if (mustExist) {
      let st: fs.Stats;
      try {
        st = await fsp.lstat(abs);
      } catch {
        throw new CacheFsError("missing", `inexistente: ${abs}`);
      }
      if (st.isSymbolicLink()) {
        throw new CacheFsError("symlink", `é um symlink (recusado sem seguir): ${abs}`);
      }
      const real = await fsp.realpath(abs);
      if (!isWithin(rootReal, real)) {
        throw new CacheFsError("escape", `resolvido fora de cache (junction/symlink intermédio): ${real}`);
      }
      return { abs, canonical: real };
    }

    // Não precisa existir: garante que o DIRECTÓRIO está contido e não é um link para fora.
    const dir = path.dirname(abs);
    let dirSt: fs.Stats;
    try {
      dirSt = await fsp.lstat(dir);
    } catch {
      throw new CacheFsError("missing", `diretório inexistente: ${dir}`);
    }
    if (dirSt.isSymbolicLink()) {
      throw new CacheFsError("symlink", `o diretório é um symlink (recusado): ${dir}`);
    }
    const dirReal = await fsp.realpath(dir);
    if (!isWithin(rootReal, dirReal)) {
      throw new CacheFsError("escape", `diretório resolvido fora de cache: ${dirReal}`);
    }
    // Se o alvo JÁ existir, também não pode ser symlink (não sobrescrevemos um link).
    try {
      const st = await fsp.lstat(abs);
      if (st.isSymbolicLink()) {
        throw new CacheFsError("symlink", `destino é um symlink (recusado): ${abs}`);
      }
      return { abs, canonical: await fsp.realpath(abs) };
    } catch (error) {
      if (error instanceof CacheFsError) throw error;
      return { abs, canonical: path.join(dirReal, path.basename(abs)) };
    }
  }

  return {
    async ensureDir(dir: string): Promise<void> {
      const abs = path.resolve(dir);
      if (!isWithin(resolvedRoot, abs) && abs !== resolvedRoot) {
        // ensureDir pode criar o próprio root; aceita dir===root ou dentro dele.
        throw new CacheFsError("escape", `ensureDir fora de cache: ${abs}`);
      }
      await fsp.mkdir(abs, { recursive: true });
    },

    async statFile(target: string): Promise<{ size: number } | null> {
      let st: fs.Stats;
      try {
        st = await fsp.lstat(path.resolve(target));
      } catch {
        return null; // inexistente ⇒ null, nunca segue.
      }
      if (st.isSymbolicLink()) return null; // recusa symlink como se não existisse.
      if (!st.isFile()) return null; // diretório/não-ficheiro não conta.
      // Confirma contenção canónica antes de reportar tamanho.
      const rootReal = await canonicalRoot();
      const real = await fsp.realpath(path.resolve(target));
      if (!isWithin(rootReal, real)) return null;
      return { size: st.size };
    },

    async readFile(target: string): Promise<Uint8Array | null> {
      let guarded: { abs: string; canonical: string };
      try {
        guarded = await guard(target, true);
      } catch (error) {
        if (error instanceof CacheFsError && (error.kind === "missing" || error.kind === "escape" || error.kind === "symlink")) {
          return null;
        }
        throw error;
      }
      // POSIX: lê pelo HANDLE com O_NOFOLLOW + fstat (sem seguir o componente final,
      // sem janela verificar→ler no último segmento). Windows: O_NOFOLLOW indisponível,
      // lemos o caminho CANÓNICO já validado pelo guard; TOCTOU restante documentado no
      // topo deste ficheiro (não alegamos que lstat+realpath o resolvem sozinhos).
      if (handleNoFollowSupported) {
        return await readRegularByHandleNoFollow(fsp, guarded.abs);
      }
      return await fsp.readFile(guarded.canonical);
    },

    async writeAtomic(destPath: string, tmpSuffix: string, data: Uint8Array): Promise<void> {
      // Publica em `destPath` com a extensão trocada (.tmp -> tmpSuffix), tal como
      // o contrato CacheStore.commitStaging espera (o fake faz o mesmo replace).
      const finalPath = path.resolve(destPath.replace(/\.tmp$/, tmpSuffix));
      const rootReal = await canonicalRoot();
      // O destino não pode já ser um symlink: validamos o dir e recusamos link no alvo.
      const dir = path.dirname(finalPath);
      const dirReal = await fsp.realpath(dir);
      if (!isWithin(rootReal, dirReal)) {
        throw new CacheFsError("escape", `destino fora de cache: ${finalPath}`);
      }
      try {
        const st = await fsp.lstat(finalPath);
        if (st.isSymbolicLink()) throw new CacheFsError("symlink", `destino é symlink: ${finalPath}`);
      } catch (error) {
        if (error instanceof CacheFsError) throw error;
        // ENOENT é ok (vamos criar).
      }

      // Escreve num temp EXCLUSIVO na mesma diretoria, faz fsync, fecha.
      const tmp = path.join(dirReal, `.${path.basename(finalPath)}.tmp-${crypto.randomUUID()}`);
      const handle = await fsp.open(tmp, "wx"); // wx: falha se existir (nunca sobrescreve).
      try {
        await handle.writeFile(data);
        await handle.sync(); // fsync dos BYTES antes de tornar visível.
      } finally {
        await handle.close();
      }

      // PUBLICAÇÃO segura: UMA única rename, SEM nunca apagar `finalPath` primeiro.
      // `rename` substitui de forma atómica quando o SO o permite (POSIX é sempre;
      // em Windows o libuv usa MoveFileEx com REPLACE_EXISTING). Se `rename` FALHAR
      // (destino bloqueado, cross-device, etc.), NÃO tentamos um delete+rename — isso
      // destruiria o artefacto bom anterior para depois falhar de novo. Em vez disso
      // limpamos APENAS o nosso temp e falhamos fechado: os bytes anteriores ficam
      // intactos e o chamador decide o que fazer (ex.: discard explícito e re-tentativa).
      try {
        await fsp.rename(tmp, finalPath);
      } catch {
        // Nunca tocamos finalPath. Remover só o nosso temp é seguro (O_EXCL nosso).
        try {
          await fsp.rm(tmp, { force: true });
        } catch {
          /* resíduo do nosso temp; finalPath permanece o artefacto anterior íntegro */
        }
        throw new CacheFsError("io", `publicação recusada (não sobrescrevemos às cegas): ${finalPath}`);
      }
    },

    async removePath(target: string): Promise<void> {
      const abs = path.resolve(target);
      if (!isWithin(resolvedRoot, abs)) {
        throw new CacheFsError("escape", `removePath fora de cache: ${abs}`);
      }
      let st: fs.Stats;
      try {
        st = await fsp.lstat(abs);
      } catch {
        return; // idempotente: nada a remover.
      }
      // É seguro: `unlink` remove o LINK em si, nunca o seu alvo externo.
      if (st.isSymbolicLink()) {
        await fsp.unlink(abs);
        return;
      }
      if (st.isDirectory()) {
        throw new CacheFsError("not-regular", `recusar apagar diretório: ${abs}`);
      }
      // Confirma contenção canónica (junction intermédio) antes de apagar.
      const rootReal = await canonicalRoot();
      const real = await fsp.realpath(abs);
      if (!isWithin(rootReal, real)) {
        throw new CacheFsError("escape", `resolvido fora de cache: ${real}`);
      }
      await fsp.unlink(abs);
    },
  };
}
