/**
 * Contrato da cadencia do RENDERER (fatia 2 do P0 de latencia).
 *
 * A primeira fatia reduziu a DESCOBERTA no servico para ~2,1 s. Mas o renderer
 * so PEDE a lista de 10 em 10 s, so subia a fila quando recebia uma lista, e so
 * nesse instante a linha aparecia no ecra. O utilizador continuava a ver ~5 s.
 *
 * Estes testes fixam o numero e a unica coisa que importa alongside: que baixar
 * o poll do renderer NAO cria enumeracoes do SO novas. O poll do renderer e um
 * pedido IPC de LEITURA DE CACHE; quem decide o ritmo de enumerar e o cadence
 * adaptativo do servico.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROCESSES_POLL_MS, PROCESSES_REFRESH_COALESCE_MS } from "../src/lib/processActions";

describe("cadencia do renderer — o contrato do consumidor", () => {
  test("o poll da lista e de 2 s, alinhado com o produtor", () => {
    assert.equal(PROCESSES_POLL_MS, 2_000);
  });

  test("e mais rapido do que o ciclo de 10 s que produzia a espera que o utilizador sentia", () => {
    // Com 10 s, a espera media do processo novo no ecra e ~5 s, mesmo com o
    // servico a descobrir em 2,1 s: o renderer lia a verdade 5 vezes atrasado.
    assert.ok(PROCESSES_POLL_MS <= 2_000, `poll de ${PROCESSES_POLL_MS} ms volta a atrasar o ecrã`);
  });

  test("nao desce abaixo do que a janela de agrupamento consegue absorver", () => {
    // Uma rajada de eventos da UM pedido. Se o poll fosse mais rapido que a
    // janela, os pedidos piling up nao davam informacao nova nenhuma.
    assert.ok(PROCESSES_POLL_MS >= PROCESSES_REFRESH_COALESCE_MS * 4);
  });

  test("o numero vive so aqui: nem o App nem a TaskManagerPage escrevem o seu", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const page = readFileSync(new URL("../src/pages/TaskManagerPage.tsx", import.meta.url), "utf8");

    assert.doesNotMatch(app, /setInterval\([^)]*,\s*10_000\s*\)/, "o App nao pode ter o intervalo hardcoded");
    assert.doesNotMatch(page, /setInterval\([^)]*,\s*10_000\s*\)/, "a pagina nao pode ter o intervalo hardcoded");
    assert.match(app, /import[^;]*(PROCESSES_POLL_MS|processosPollMs)[^;]*from\s+["'].*processActions["']/,
      "o App tem de importar a cadencia da tabela, nao reescreve-la");
    assert.match(page, /PROCESSES_POLL_MS\s*\/\s*1000/, "a copy da pagina mostra o numero que vem da constante");
  });

  test("o comentario do App ja nao afirma as premissas falsas", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    // As DUAS premissas do comentario antigo passaram a ser falsas: o poll do
    // servico deixou de ser 10 s fixo, e a enumeracao custa 591 ms (nao ~800 ms).
    assert.doesNotMatch(app, /poll do servi[çc]o \(10 s\)/,
      "o poll do servico ja nao e 10 s fixo: e 2 s enquanto ha observador");
    assert.doesNotMatch(app, /enumera[çc][ãa]o custa ~800 ms/,
      "a enumeracao foi remedida: mediana 591 ms, nao ~800 ms");
    assert.doesNotMatch(app, /mais r[áa]pido seria o dobro do\s*\n?\s*trabalho/,
      "o poll do renderer nao e uma enumeracao: nao ha trabalho extra a dobrar");
    // E tem de dizer a razao certa ao lado do numero.
    assert.match(app, /CACHE|cache/,
      "o comentario tem de dizer que este poll le cache e nao enumera o SO");
  });
});
