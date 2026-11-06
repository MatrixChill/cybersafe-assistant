import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * v0.2.2 — «o primeiro botão de restauro não funciona» (reproduzido com cliques
 * reais no laboratório da QuarantinePage). O handler funcionava: o botão da
 * linha abria uma confirmação por baixo, com OUTRO botão também chamado
 * «Restaurar», sem mover o foco nem marcar o primeiro como aberto. Para o
 * utilizador, o primeiro clique não fazia nada.
 *
 * A confirmação obrigatória mantém-se (restaurar devolve um ficheiro suspeito
 * ao disco). O que se fixa é que os dois passos são distinguíveis.
 */
const src = readFileSync(new URL("../src/pages/QuarantinePage.tsx", import.meta.url), "utf8");

test("o botão que executa diz «Confirmar restauro», não repete «Restaurar»", () => {
  assert.doesNotMatch(src, /\{aConfirmar === "delete" \? "Eliminar" : "Restaurar"\}/);
  assert.doesNotMatch(src, /\{lote\.acao === "delete" \? "Eliminar" : "Restaurar"\}/);
  assert.match(src, /Confirmar restauro/);
  assert.match(src, /Confirmar eliminação/);
});

test("abrir a confirmação leva o foco ao botão que confirma (linha e lote)", () => {
  const autoFocus = src.match(/autoFocus/g) ?? [];
  assert.ok(autoFocus.length >= 2, "confirmação da linha e do lote");
});

test("o botão da linha diz que abriu a confirmação e um segundo clique fecha-a", () => {
  assert.match(src, /aria-expanded=\{aConfirmar === "restore"\}/);
  assert.match(src, /if \(aConfirmar === "restore"\) setPending\(null\); else setPending\(\{ id: entry\.id, action: "restore" \}\)/);
});

test("a pergunta de restauro diz para onde o ficheiro volta", () => {
  assert.match(src, /Restaurar «\$\{entry\.fileName\}» para \$\{entry\.originalPath\}\?/);
});

test("PT-PT: sem textos visíveis sem acentos nesta página", () => {
  for (const bad of ["Limpar selecao", "Sem ligacao ao servico", "acao e irreversivel", "A comunicar o lote ao servico", "Retirar da selecao"]) {
    assert.ok(!src.includes(bad), bad);
  }
});
