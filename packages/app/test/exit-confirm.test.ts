import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_CONFIRM_CANCEL_LABEL,
  EXIT_CONFIRM_CONFIRM_LABEL,
  EXIT_CONFIRM_DESCRIPTION,
  EXIT_CONFIRM_TITLE,
  exitConfirmKeyAction,
  exitConfirmResponse,
  hasInternalTerms,
  nextFocusIndex,
} from "../src/lib/exitConfirm";

/**
 * Regressão da confirmação de saída.
 *
 * O diálogo nativo branco do Windows foi substituído por um modal CyberSafe.
 * A copy e as decisões (ESC = cancelar, Cancelar nunca encerra) vivem num
 * módulo puro para poderem ser testadas sem renderer.
 */

describe("confirmação de saída — copy do utilizador", () => {
  test("não expõe detalhes internos (watcher/updater/pipe/service/engine)", () => {
    for (const text of [
      EXIT_CONFIRM_TITLE,
      EXIT_CONFIRM_DESCRIPTION,
      EXIT_CONFIRM_CANCEL_LABEL,
      EXIT_CONFIRM_CONFIRM_LABEL,
    ]) {
      assert.equal(hasInternalTerms(text), false, `"${text}" não pode conter detalhes internos`);
    }
  });

  test("diz exatamente o que vai acontecer", () => {
    assert.equal(EXIT_CONFIRM_TITLE, "Sair do CyberSafe?");
    assert.match(EXIT_CONFIRM_DESCRIPTION, /proteção em tempo real/i);
    assert.equal(EXIT_CONFIRM_CANCEL_LABEL, "Cancelar");
    assert.equal(EXIT_CONFIRM_CONFIRM_LABEL, "Sair");
  });
});

describe("confirmação de saída — decisões", () => {
  test("ESC cancela", () => {
    assert.equal(exitConfirmKeyAction("Escape"), "cancel");
    assert.equal(exitConfirmResponse("cancel"), false);
  });

  test("outras teclas não decidem nada (Enter é do botão focado)", () => {
    for (const key of ["Tab", "Enter", "a", " "]) {
      assert.equal(exitConfirmKeyAction(key), "none");
    }
    assert.equal(exitConfirmResponse("none"), null);
  });

  test("confirmar é a única ação que encerra", () => {
    assert.equal(exitConfirmResponse("confirm"), true);
    assert.notEqual(exitConfirmResponse("cancel"), true);
    assert.notEqual(exitConfirmResponse("none"), true);
  });
});

describe("confirmação de saída — focus trap", () => {
  test("alterna entre os botões com wrap-around", () => {
    assert.equal(nextFocusIndex(0, 2, false), 1);
    assert.equal(nextFocusIndex(1, 2, false), 0);
    assert.equal(nextFocusIndex(0, 2, true), 1);
    assert.equal(nextFocusIndex(1, 2, true), 0);
  });

  test("sem foco conhecido cai no primeiro botão (Cancelar)", () => {
    assert.equal(nextFocusIndex(-1, 2, false), 0);
    assert.equal(nextFocusIndex(-1, 2, true), 0);
  });

  test("sem botões não há índice", () => {
    assert.equal(nextFocusIndex(0, 0, false), -1);
  });
});
