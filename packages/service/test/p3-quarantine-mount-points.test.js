// §9 Linux Lite — a quarentena respeita os pontos de montagem de Linux.
import test from "node:test";
import assert from "node:assert/strict";

import { isMountPointPath } from "../dist/quarantine-path-policy.js";
import { quarantineMountRefusal } from "../dist/quarantine-mounts.js";

const TABELA_MAQUINA = ["/", "/boot", "/home", "/media/caioc/pen", "/mnt/c", "/run", "/sys"];

test("um ponto de montagem é recusado", () => {
  assert.equal(isMountPointPath("/media/caioc/pen", TABELA_MAQUINA), true);
  assert.equal(isMountPointPath("/run", TABELA_MAQUINA), true);
});

test("a barra final não cria um caminho diferente", () => {
  assert.equal(isMountPointPath("/media/caioc/pen/", TABELA_MAQUINA), true);
  assert.equal(isMountPointPath("/media/caioc/pen//", TABELA_MAQUINA), true);
});

/**
 * O caso que torna a igualdade obrigatória: `/` está na tabela de todas as
 * máquinas. Uma comparação por prefixo diria que qualquer ficheiro do mundo é
 * uma montagem, e o isolamento deixaria de acontecer em silêncio.
 */
test("um ficheiro dentro de uma montagem não é a montagem", () => {
  assert.equal(isMountPointPath("/media/caioc/pen/malware.exe", TABELA_MAQUINA), false);
  assert.equal(isMountPointPath("/home/caioc/Documentos/ficheiro.txt", TABELA_MAQUINA), false);
  assert.equal(isMountPointPath("/etc/passwd", TABELA_MAQUINA), false);
});

test("a raiz é montagem de si própria e não de `/init` por acidente", () => {
  assert.equal(isMountPointPath("/", TABELA_MAQUINA), true);
  assert.equal(isMountPointPath("/init", ["/"]), false);
});

test("Linux distingue maiúsculas: `/MNT/C` não é `/mnt/c`", () => {
  assert.equal(isMountPointPath("/MNT/C", TABELA_MAQUINA), false);
});

test("um caminho relativo não é ponto de montagem (a outra regra já o recusa)", () => {
  assert.equal(isMountPointPath("pen", TABELA_MAQUINA), false);
  assert.equal(isMountPointPath("", TABELA_MAQUINA), false);
});

test("o motor só pergunta às montagens em POSIX, e nem abre a tabela em Windows", () => {
  let aberta = 0;
  const ler = () => {
    aberta += 1;
    return { ok: true, montagens: ["/mnt/c"], ilegiveis: 0, reason: null };
  };
  assert.equal(quarantineMountRefusal("/mnt/c", "win32", ler), null);
  assert.equal(aberta, 0, "em Windows não se lê o mountinfo: lá não há montagens POSIX");
  assert.equal(quarantineMountRefusal("/mnt/c", "linux", ler), "mount-point");
  assert.equal(aberta, 1);
});

test("fora da tabela não há recusa", () => {
  const ler = () => ({ ok: true, montagens: TABELA_MAQUINA, ilegiveis: 0, reason: null });
  assert.equal(quarantineMountRefusal("/home/caioc/veneno.bin", "linux", ler), null);
});

/**
 * O fail-closed. Não mover é uma não-ação reversível: o ficheiro fica onde
 * está, continua malicioso e o pedido fica auditado. Mover uma montagem não é
 * reversível por via nenhuma — por isso uma tabela que não se lê, ou que se lê
 * com linhas que não se entendem, recusa.
 */
test("tabela ilegível recusa o isolamento", () => {
  assert.equal(
    quarantineMountRefusal("/home/caioc/veneno.bin", "linux", () => ({ ok: false, montagens: [], ilegiveis: 0, reason: "não pude ler" })),
    "mount-table-unreadable",
  );
  assert.equal(quarantineMountRefusal("/home/caioc/veneno.bin", "linux", () => { throw new Error("EPERM"); }), "mount-table-unreadable");
});

test("tabela com linhas não interpretadas recusa, e diz porquê", () => {
  const motivo = quarantineMountRefusal("/home/caioc/veneno.bin", "linux", () => ({
    ok: true, montagens: TABELA_MAQUINA, ilegiveis: 2, reason: "2 linhas não interpretadas",
  }));
  assert.equal(motivo, "mount-table-incomplete");
});

test("a recusa aplica-se também ao caminho que seria montagem, com tabela incompleta", () => {
  // Não é o caso feliz: aqui não sabemos sequer confirmar. Importa que o
  // resultado seja uma recusa e não um `null` tranquilizador.
  const motivo = quarantineMountRefusal("/media/caioc/pen", "linux", () => ({
    ok: true, montagens: [], ilegiveis: 1, reason: "x",
  }));
  assert.equal(motivo, "mount-table-incomplete");
});
