/**
 * O walk do scanner não entra nas árvores do kernel (POSIX).
 *
 * Porque isto não é higiene: `/proc/kcore` é um ficheiro REGULAR cujo tamanho
 * declarado é o espaço de endereçamento do kernel, e `MalwareAnalyzer.analyze`
 * calcula o SHA-256 do ficheiro ANTES do portão de tamanho
 * (`core/src/analysis.ts:73` / `:77`). Uma análise de `/` sem poda ficava presa
 * nesse `await` — e o cancelamento só é verificado ENTRE ficheiros, nunca
 * dentro de uma leitura que não termina.
 *
 * O corte é o oposto do que se faz ao Windows: aqui a poda é uma diferença de
 * sistema de ficheiros, não uma preferência. Em `win32` o predicado devolve
 * sempre `false`, e por isso o caminho Windows não muda uma vírgula.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ScanManager,
  RAIZES_DO_KERNEL_POSIX,
  eRaizDoKernelPosix,
} from "../dist/scan-manager.js";

describe("eRaizDoKernelPosix: só a interface do kernel, onde ela de facto está", () => {
  it("reconhece as quatro raízes", () => {
    for (const raiz of RAIZES_DO_KERNEL_POSIX) {
      assert.equal(eRaizDoKernelPosix(raiz, "linux"), true, raiz);
    }
  });

  it("não poda por nome: a pasta de um utilizador chama-se o que lhe apetecer", () => {
    // Um teste que só provasse "/proc" deixaria passar uma poda por nome de
    // pasta, e essa tiraria do utilizador o seu `~/projetos/proc`.
    for (const caminho of [
      "/home/caioc/dev",
      "/home/caioc/projects/proc",
      "/var/run",
      "/mnt/usb/sys",
      "/opt/proc",
    ]) {
      assert.equal(eRaizDoKernelPosix(caminho, "linux"), false, caminho);
    }
  });

  it("a raiz do volume e a árvore do SO ficam: são armazenamento", () => {
    for (const caminho of ["/", "/mnt/c", "/mnt/usb", "/usr", "/etc", "/home"]) {
      assert.equal(eRaizDoKernelPosix(caminho, "linux"), false, caminho);
    }
  });

  it("compara com sensibilidade a maiúsculas: não existe /PROC", () => {
    assert.equal(eRaizDoKernelPosix("/PROC", "linux"), false);
    assert.equal(eRaizDoKernelPosix("", "linux"), false);
  });

  it("em win32 nada é podado — o contrato Windows fica intacto", () => {
    for (const raiz of RAIZES_DO_KERNEL_POSIX) {
      assert.equal(eRaizDoKernelPosix(raiz, "win32"), false, raiz);
    }
    // Um `C:\Windows\proc` de um utilizador também não é caso deste predicado.
    assert.equal(eRaizDoKernelPosix("C:\\dev", "win32"), false);
  });
});

describe("gatherFiles e gatherFilesQuick: a poda acontece antes de tocar no disco", () => {
  /**
   * Chama o método do protótipo com um `this` mínimo (`isCancelled` é o único
   * estado que ele lê antes de decidir). Assim a asserção é sobre o CAMINHO
   * real do produto, não sobre um duplicado do predicado aqui no teste.
   */
  const platformeLinux = async (fn) => {
    const descritor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      return await fn();
    } finally {
      Object.defineProperty(process, "platform", descritor);
    }
  };

  /**
   * `this` com o protótipo do produto: o walk recursa com `this.gatherFiles`,
   * por isso um objeto plano faz a recursão rebentar com `TypeError` e esse erro
   * é contar como falha de leitura — que é exatamente o que esta família de
   * casos estava a confundir. Medido em Linux real (WSL2, 2026-11-02): com o
   * protótipo ligado, uma subpasta é lida sem nenhuma falha.
   */
  const esteManager = () =>
    Object.create(ScanManager.prototype, { isCancelled: { value: new Set() } });

  for (const [nome, chamar] of [
    ["gatherFiles", (self, dir, files, stats) =>
      ScanManager.prototype.gatherFiles.call(self, dir, files, "scan-1", 50000, stats)],
    ["gatherFilesQuick", (self, dir, files, stats) =>
      ScanManager.prototype.gatherFilesQuick.call(self, dir, files, "scan-1", 0, 2, 800, stats)],
  ]) {
    it(`${nome}: /proc devolve zero ficheiros e ZERO falhas — não é um erro de leitura`, async () => {
      await platformeLinux(async () => {
        const files = [];
        const stats = { failed: 0, failedByReason: {} };
        await chamar(esteManager(), "/proc", files, stats);
        assert.deepEqual(files, []);
        // O `failed: 0` é o que distingue a poda de uma falha: um `readdir`
        // negado teria contado. A análise de um alvo todo podado acaba em
        // «Nenhum ficheiro para analisar» (falha), nunca num «limpo».
        assert.equal(stats.failed, 0);
      });
    });

    it(`${nome}: uma subpasta homónima é armazenamento e continua a ser lida`, async () => {
      await platformeLinux(async () => {
        // Caminho inexistente de propósito: o que se prova é que a função NÃO
        // podou (podar = 0 falhas; caminho mau = 1 falha contada).
        const files = [];
        const stats = { failed: 0, failedByReason: {} };
        await chamar(esteManager(), "/var/run", files, stats);
        assert.equal(stats.failed, 1, "não foi podado: encontrou o filesystem e falhou ao ler");
      });
    });

    it(`${nome}: a poda não quebra a recursão — o ficheiro dentro de uma subpasta é recolhido`, async () => {
      await platformeLinux(async () => {
        // O caso positivo que faltava: sem ele, um `this` mal montado rebenta a
        // recursão em silêncio e o walk parece estar a funcionar.
        const raiz = mkdtempSync(join(tmpdir(), "p3-alvo-"));
        try {
          mkdirSync(join(raiz, "subpasta"));
          mkdirSync(join(raiz, "node_modules"));
          writeFileSync(join(raiz, "a.txt"), "a");
          writeFileSync(join(raiz, "subpasta", "b.txt"), "b");
          writeFileSync(join(raiz, "node_modules", "c.txt"), "c");

          const files = [];
          const stats = { failed: 0, failedByReason: {} };
          await chamar(esteManager(), raiz, files, stats);

          assert.equal(stats.failed, 0, `walk limpo não pode contar falhas: ${JSON.stringify(stats.failedByReason)}`);
          assert.ok(files.includes(join(raiz, "a.txt")), `falta o ficheiro da raiz em ${JSON.stringify(files)}`);
          assert.ok(files.includes(join(raiz, "subpasta", "b.txt")), `a recursão não recolheu a subpasta: ${JSON.stringify(files)}`);
          assert.equal(files.some((f) => f.includes("node_modules")), false, "node_modules continua excluído");
        } finally {
          rmSync(raiz, { recursive: true, force: true });
        }
      });
    });
  }
});
