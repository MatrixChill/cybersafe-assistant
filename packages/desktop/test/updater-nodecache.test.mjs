import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import { createNodeCacheFileSystem, CacheFsError } from "../src/updater/node-cache-fs.ts";

/**
 * TP-UPDATE-ADAPTERS (item 2) — CacheFileSystem REAL sobre node:fs.
 *
 * TODOS os testes correm num mkdtemp CRIADO PORESTE teste e são limpos no fim; NUNCA
 * tocam userData real. Provar: escrita atómica (tmp exclusivo + fsync + rename), leitura
 * só de ficheiro regular contido, statFile honesto, contenção de travessia `..`, recusa
 * de SYMLINK (não segue), e que removePath fora de root falha fechado. Se o SO não
 * permitir CRIAR symlinks, o teste de symlink fica SKIP explícito (não finge PASS).
 */

/** Executa `fn` com uma cache num mkdtemp isolado; limpa sempre. */
function withCache(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-cache-"));
  const run = () => fn(root, createNodeCacheFileSystem(root));
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return Promise.resolve(run()).finally(cleanup);
}

function isCacheErr(err, kind) {
  return err instanceof CacheFsError && err.kind === kind;
}

describe("createNodeCacheFileSystem — ciclo happy na cache dedicada", () => {
  it("ensureDir + writeAtomic publica .tmp -> .exe, e readFile/statFile veem o final", async () => {
    await withCache(async (root, cache) => {
      await cache.ensureDir(root);
      const staging = path.join(root, "update-1.0.0-" + "a".repeat(64) + ".tmp");
      const data = Buffer.from("PAYLOAD-BYTES");
      await cache.writeAtomic(staging, ".exe", data);

      const final = path.join(root, "update-1.0.0-" + "a".repeat(64) + ".exe");
      assert.equal(fs.existsSync(final), true, "ficheiro final publicado");
      assert.equal(fs.existsSync(staging), false, "o .tmp de staging não deve ficar para trás no destino final");

      const read = await cache.readFile(final);
      assert.equal(Buffer.from(read).toString(), "PAYLOAD-BYTES");
      const st = await cache.statFile(final);
      assert.equal(st.size, data.length);
    });
  });

  it("statFile readFile devolvem null p/ inexistente (nunca inventa)", async () => {
    await withCache(async (root, cache) => {
      const missing = path.join(root, "nao-existe.exe");
      assert.equal(await cache.statFile(missing), null);
      assert.equal(await cache.readFile(missing), null);
    });
  });

  it("removePath apaga o ficheiro e é idempotente", async () => {
    await withCache(async (root, cache) => {
      const p = path.join(root, "x.tmp");
      fs.writeFileSync(p, "hello");
      await cache.removePath(p);
      assert.equal(fs.existsSync(p), false);
      await cache.removePath(p); // segunda vez: sem erro
    });
  });

  it("não deixa temp residual: só o destino final permanece", async () => {
    await withCache(async (root, cache) => {
      await cache.ensureDir(root);
      const staging = path.join(root, "update-2.0.0-" + "b".repeat(64) + ".tmp");
      await cache.writeAtomic(staging, ".exe", Buffer.from("ok"));
      const left = fs.readdirSync(root).filter((n) => n.includes(".tmp-"));
      assert.deepEqual(left, [], "temp de ingestão deve ter sido renomeado/removido");
    });
  });
});

describe("createNodeCacheFileSystem — contenção e fail-closed", () => {
  it("removePath fora do root ⇒ escape (falha fechado)", async () => {
    await withCache(async (_root, cache) => {
      const outside = path.join(os.tmpdir(), "cs-definitely-outside-cache.bin");
      await assert.rejects(() => cache.removePath(outside), (e) => isCacheErr(e, "escape"));
    });
  });

  it("travessia via .. dentro do root não escapa", async () => {
    await withCache(async (root, cache) => {
      const sneaky = path.join(root, "sub", "..", "ok.tmp");
      fs.mkdirSync(path.join(root, "sub"), { recursive: true });
      fs.writeFileSync(sneaky, "data");
      await cache.removePath(sneaky); // resolve para root/ok.tmp → dentro, ok apagar
      assert.equal(fs.existsSync(path.join(root, "ok.tmp")), false);
    });
  });

  it("travessia para FORA do root é recusada", async () => {
    await withCache(async (root, cache) => {
      const escape = path.join(root, "..", "escape.bin");
      await assert.rejects(() => cache.removePath(escape), (e) => isCacheErr(e, "escape"));
    });
  });

  it("statFile de SYMLINK (para dentro ou fora) ⇒ null, nunca segue", async () => {
    await withCache(async (root, cache) => {
      const real = path.join(root, "real.bin");
      fs.writeFileSync(real, "contents");
      const link = path.join(root, "link.bin");
      try {
        fs.symlinkSync(real, link);
      } catch {
        return "SKIP: criação de symlink não permitida neste SO/privilégio";
      }
      // lstat vê o LINK (não segue): statFile deve reportar null para um symlink.
      assert.equal(await cache.statFile(link), null);
      assert.equal(await cache.readFile(link), null);
      // removePath num symlink unlinka o LINK, não o alvo.
      await cache.removePath(link);
      assert.equal(fs.existsSync(link), false);
      assert.equal(fs.existsSync(real), true, "alvo do link permanece intacto");
    });
  });

  it("writeAtomic recusa publicar sobre um SYMLINK (não escreve através do link)", async (t) => {
    await withCache(async (root, cache) => {
      const outsideTarget = path.join(os.tmpdir(), "cs-outside-target-" + process.pid + ".bin");
      fs.writeFileSync(outsideTarget, "ORIGINAL");
      const finalName = path.join(root, "update-9.9.9-" + "c".repeat(64) + ".exe");
      try {
        fs.symlinkSync(outsideTarget, finalName);
      } catch (error) {
        fs.rmSync(outsideTarget, {force:true});
        if (["EPERM","EACCES","ENOTSUP"].includes(error.code)) {
          t.skip("criação de symlink não permitida neste SO/privilégio");
          return;
        }
        throw error;
      }
      const stagingName = finalName.replace(/\.exe$/, ".tmp");
      await assert.rejects(
        () => cache.writeAtomic(stagingName, ".exe", Buffer.from("PWNED")),
        (e) => isCacheErr(e, "symlink"),
      );
      assert.equal(fs.readFileSync(outsideTarget).toString(), "ORIGINAL", "alvo externo não foi sobrescrito");
      fs.rmSync(outsideTarget, { force: true });
    });
  });

  it("ensureDir fora do root ⇒ escape", async () => {
    await withCache(async (_root, cache) => {
      const outside = path.join(os.tmpdir(), "cs-outside-dir-" + process.pid);
      await assert.rejects(() => cache.ensureDir(outside), (e) => isCacheErr(e, "escape"));
    });
  });
});

// ── TP-UPDATE-CACHE-HARDEN ────────────────────────────────────────────────────

/** Proxy do fs REAL com um método sobrescrito (para injetar falhas sem tocar o resto). */
function fsWith(overrides) {
  return { ...fs.promises, ...overrides };
}

describe("writeAtomic — publicação segura NÃO destrói o artefacto anterior (HARDEN item 1)", () => {
  it("rename a falhar ⇒ bytes anteriores intactos, só o temp nosso é limpo, falha fechado", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-cache-"));
    try {
      // Artefacto final PRÉ-EXISTENTE com bytes conhecidos.
      const name = "update-1.0.0-" + "e".repeat(64);
      const final = path.join(root, name + ".exe");
      fs.writeFileSync(final, "OLD-GOOD-BYTES");

      // cache com rename SEMPRE a lançar (simula destino bloqueado / falha de rename).
      const cache = createNodeCacheFileSystem(root, {
        fs: fsWith({
          rename: async () => {
            throw Object.assign(new Error("rename injetada falhou"), { code: "EPERM" });
          },
        }),
      });

      const before = fs.readFileSync(final).toString();
      const beforeCount = fs.readdirSync(root).length;

      await assert.rejects(
        () => cache.writeAtomic(path.join(root, name + ".tmp"), ".exe", Buffer.from("NEW-BYTES")),
        (e) => isCacheErr(e, "io"),
      );

      // (a) bytes ANTERIORES preservados — NÃO foram apagados para "tentar de novo".
      assert.equal(fs.readFileSync(final).toString(), before, "artefacto anterior intacto");
      // (b) o temp de ingestão foi removido: contagem de ficheiros volta ao mesmo, sem `.tmp-`.
      assert.equal(fs.readdirSync(root).length, beforeCount, "sem resíduo de temp");
      assert.deepEqual(
        fs.readdirSync(root).filter((n) => n.includes(".tmp-")),
        [],
        "nenhum temp de ingestão ficou na cache",
      );
      // (c) nunca deve ter existido um delete do final: a única operação de fs sobre `final`
      //     foi open(tmp)/rename(tmp,final). rename lançou antes de substituir.
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renomear um destino INEXISTENTE ainda publica (não-regressão do caminho feliz)", async () => {
    await withCache(async (root, cache) => {
      await cache.ensureDir(root);
      const staging = path.join(root, "update-1.2.3-" + "f".repeat(64) + ".tmp");
      await cache.writeAtomic(staging, ".exe", Buffer.from("BRAND-NEW"));
      assert.equal(
        fs.readFileSync(path.join(root, "update-1.2.3-" + "f".repeat(64) + ".exe")).toString(),
        "BRAND-NEW",
      );
    });
  });
});

describe("JUNCTION real do Windows — contenção por diretório (HARDEN item 2)", () => {
  it("read/write/remove ATRAVÉS de uma junction não atingem a sentinela fora de root", async (t) => {
    if (process.platform !== "win32") {
      t.skip("junction é específica de Windows");
      return;
    }
    // AMBOS os diretórios vindos de mkdtemp DESTE teste (sem userData, sem admin).
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cs-jout-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-jroot-"));
    const link = path.join(root, "jun");
    try {
      const sentinel = path.join(outside, "SENTINEL.bin");
      fs.writeFileSync(sentinel, "DO-NOT-TOUCH");

      // junction root/jun -> outside (reparse point de diretório; não requer privilégio).
      try {
        fs.symlinkSync(outside, link, "junction");
      } catch (e) {
        t.skip("junction não criável neste host: " + ((e && e.code) || String(e)));
        return;
      }

      const cache = createNodeCacheFileSystem(root);

      // Ler ATRAVÉS da junction: o alvo canónico sai de root ⇒ null (não segue para fora).
      assert.equal(await cache.readFile(path.join(link, "SENTINEL.bin")), null);
      assert.equal(await cache.statFile(path.join(link, "SENTINEL.bin")), null);

      // Escrever ATRAVÉS da junction: o diretório do destino resolve para fora ⇒ escape.
      await assert.rejects(
        () => cache.writeAtomic(path.join(link, "update-1.0.0-" + "d".repeat(64) + ".tmp"), ".exe", Buffer.from("PWN")),
        (e) => isCacheErr(e, "escape"),
      );
      assert.equal(
        fs.existsSync(path.join(outside, "update-1.0.0-" + "d".repeat(64) + ".exe")),
        false,
        "não escreveu através da junction",
      );

      // Remover ATRAVÉS da junction: realpath fora de root ⇒ escape; sentinela intacta.
      await assert.rejects(
        () => cache.removePath(path.join(link, "SENTINEL.bin")),
        (e) => isCacheErr(e, "escape"),
      );
      assert.equal(fs.readFileSync(sentinel).toString(), "DO-NOT-TOUCH", "sentinela NÃO foi tocada");
    } finally {
      // Remover a junction (o reparse point) ANTES do rm recursivo, para nunca traversar.
      try {
        fs.rmdirSync(link);
      } catch {
        try {
          fs.unlinkSync(link);
        } catch {
          /* link pode nem ter sido criado (skip) */
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("readFile — no-follow por handle quando suportado (HARDEN item 3)", () => {
  it("ler um SYMLINK de componente final devolve null em qualquer plataforma", async () => {
    await withCache(async (root, cache) => {
      const secret = path.join(root, "secret.bin");
      fs.writeFileSync(secret, "TOP");
      const link = path.join(root, "innocent.bin");
      try {
        fs.symlinkSync(secret, link);
      } catch {
        return "SKIP: symlink não criável neste host";
      }
      // POSIX: O_NOFOLLOW no open lança ELOOP ⇒ null. Windows: guard/realpath recusa o link.
      assert.equal(await cache.readFile(link), null, "não lê através de symlink final");
      const read = await cache.readFile(secret);
      assert.equal(Buffer.from(read).toString(), "TOP", "ficheiro regular legível");
    });
  });

  it("ficheiro regular continua legível (caminho canónico / handle, conforme plataforma)", async () => {
    await withCache(async (root, cache) => {
      const p = path.join(root, "ok.bin");
      fs.writeFileSync(p, "regular-bytes");
      const data = await cache.readFile(p);
      assert.equal(Buffer.from(data).toString(), "regular-bytes");
    });
  });
});
