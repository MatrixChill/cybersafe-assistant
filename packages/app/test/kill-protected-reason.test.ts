import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mapKillResult,
  runKillProcess,
  KILL_PROTECTED_ERROR,
  KILL_PROTECTED_REASON_MESSAGE,
} from "../src/lib/processActions";
import type { ProcessKillResult } from "@cybersafe/shared-types";

/**
 * Kill result UX — o `protectedReason` que o serviço ja envia e que o renderer
 * nao mostrava.
 *
 * A correcao ja provada: o contrato estruturado JA EXISTE. `engine.ts` devolve
 * `success`/`status`/`pid`/`protectedReason`/`error`, e `classifyKillTarget`
 * sabe distinguir CINCO razoes (`self`, `ancestor`, `internal`, `system-pid`,
 * `fallback-name`). O renderer sobe isso e deita fora: os cinco casos colapsam
 * na MESMA frase, "Processo protegido do CyberSafe/sistema: nao pode ser
 * terminado."
 *
 * E a diferenca nao e academica. O utilizador que clica "Terminar" num PID
 * protegido recebe a mesma frase five vezes, e nao fica a saber se o produto
 * recusou porque o alvo E o proprio CyberSafe (nunca deve ser morto), porque e
 * um processo de sistema do Windows (nao se resolve com Repetir), ou porque o
 * nome bateu por fallback (talvez outra app). O dado ja esta no contrato e
 * nao aparece.
 *
 * Este ficheiro e o lado VERMELHO: falha antes do patch, porque a razao
 * especifica nao existe e o mapa a deita fora.
 */

function result(overrides: Partial<ProcessKillResult> = {}): ProcessKillResult {
  return {
    success: false,
    status: "failed",
    pid: 4242,
    ...overrides,
  };
}

describe("KILL-UX T1 — cada protectedReason tem a sua mensagem", () => {
  test("as cinco razoes do contrato tem texto proprio e diferente", () => {
    const razoes = ["self", "ancestor", "internal", "system-pid", "fallback-name"] as const;
    const textos = new Set<string>();
    for (const razao of razoes) {
      const outcome = mapKillResult(result({ status: "protected", protectedReason: razao }));
      assert.equal(outcome.status, "protected");
      assert.equal(outcome.protectedReason, razao, `a razao tem de chegar ao desfecho: ${razao}`);
      assert.ok(outcome.message, `tem de haver mensagem: ${razao}`);
      assert.equal(outcome.message, KILL_PROTECTED_REASON_MESSAGE[razao], `texto proprio: ${razao}`);
      textos.add(outcome.message!);
    }
    // Cinco razoes, cinco textos. Se duas partilhassem, o bug volta.
    assert.equal(textos.size, 5, `esperava 5 textos distintos, obtive ${textos.size}`);
  });

  test("cada texto diz o que NAO pode ser feito, e nao e a frase generica", () => {
    for (const [razao, texto] of Object.entries(KILL_PROTECTED_REASON_MESSAGE)) {
      assert.notEqual(texto, KILL_PROTECTED_ERROR, `${razao} nao pode ser a frase generica`);
      assert.match(texto, /n[ãa]o pode ser terminado|n[ãa]o o pode terminar|nunca pode ser terminado/i, `${razao}: ${texto}`);
    }
  });
});

describe("KILL-UX T2 — o protectedReason chega ao desfecho, nao e engolido", () => {
  test("o desfecho expoe a razao (antes so havia status/pid/success/message)", () => {
    const outcome = mapKillResult(result({ status: "protected", protectedReason: "internal" }));
    assert.equal(outcome.protectedReason, "internal");
  });

  test("sem protectedReason continua a haver orientacao (nao inventa razao)", () => {
    const outcome = mapKillResult(result({ status: "protected" }));
    assert.equal(outcome.protectedReason, undefined, "nao pode inventar uma razao");
    assert.equal(outcome.message, KILL_PROTECTED_ERROR, "sem razao, a frase generica honesta");
  });
});

describe("KILL-UX T3 — o resto do contrato nao regrediu", () => {
  test("killed nao ganha motivo de erro nem razao, e tem feedback de sucesso", () => {
    const outcome = mapKillResult(result({ success: true, status: "killed" }));
    assert.equal(outcome.success, true);
    assert.equal(outcome.protectedReason, undefined);
    // `message: null` era o bug do sucesso silencioso. O que interessa aqui e
    // que ele NAO seja um erro: nao pode ser o texto de protected nem o de
    // falha. A igualdade com a constante de sucesso vive em A1.
    assert.ok(outcome.message, "o sucesso tem feedback");
    assert.doesNotMatch(outcome.message!, /protegid|falha|n[aã]o pode/i, `nao e um erro: ${outcome.message}`);
  });

  test("access-denied continua a preferir o erro real do backend", () => {
    const outcome = mapKillResult(result({ status: "access-denied", error: "Access is denied. (os=5)" }));
    assert.equal(outcome.message, "Access is denied. (os=5)");
  });

  test("o erro do backend em 'protected' nao vaza cru: o ecrã e PT-PT", () => {
    // O engine manda hoje `error: "Cannot terminate protected CyberSafe/system
    // process"`. Se o renderer passasse a mostrar `error` cru, o utilizador
    // passava a ler ingles tecnico no meio de uma app PT-PT.
    const outcome = mapKillResult(result({
      status: "protected",
      protectedReason: "self",
      error: "Cannot terminate protected CyberSafe/system process",
    }));
    assert.notEqual(outcome.message, "Cannot terminate protected CyberSafe/system process");
    assert.equal(outcome.message, KILL_PROTECTED_REASON_MESSAGE.self);
  });
});

describe("KILL-UX T4 — o caminho real (runKillProcess) tambem mostra a razao", () => {
  test("o service devolve protected/self -> a UI ve a razao especifica", async () => {
    const outcome = await runKillProcess({
      pid: 1,
      kill: async () => result({ pid: 1, status: "protected", protectedReason: "self" }),
    });
    assert.equal(outcome.status, "protected");
    assert.equal(outcome.protectedReason, "self");
    assert.equal(outcome.message, KILL_PROTECTED_REASON_MESSAGE.self);
  });

  test("a razao sobrevive ao caminho completo, sem inventar texto", async () => {
    for (const razao of ["ancestor", "internal", "system-pid", "fallback-name"] as const) {
      const outcome = await runKillProcess({
        pid: 9,
        kill: async () => result({ pid: 9, status: "protected", protectedReason: razao }),
      });
      assert.equal(outcome.protectedReason, razao, `razao perdida em ${razao}`);
      assert.equal(outcome.message, KILL_PROTECTED_REASON_MESSAGE[razao], `texto perdido em ${razao}`);
    }
  });
});

describe("KILL-UX T5 — PT-PT com acentos, sem ingles cru e sem emoji", () => {
  test("as cinco mensagens sao PT-PT com acentos, sem PT-BR e sem emoji", () => {
    for (const [razao, texto] of Object.entries(KILL_PROTECTED_REASON_MESSAGE)) {
      for (const errado of ["terminar o processo" + "o usuario", "nao pode ser", "arquivo", "memoria"]) {
        assert.ok(!texto.includes(errado), `${razao} contem "${errado}": ${texto}`);
      }
      assert.ok(
        !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(texto),
        `${razao} tem emoji: ${texto}`,
      );
      // PT-PT: "nao" sem acento nao entra; "não" com acento sim.
      assert.ok(!/\bnao\b/.test(texto), `${razao}: "nao" sem acento: ${texto}`);
    }
  });

  test("o contraste: o padrao apanha a forma sem acento e deixa passar a com acento", () => {
    const semAcento = /\bnao\b|\baccao\b|\bmemoria\b|\bdeteccao\b/i;
    assert.ok(semAcento.test("nao pode ser terminado"), "tem de apanhar a forma sem acento");
    assert.ok(!semAcento.test("Não pode ser terminado."), "nao pode acusar a forma com acento");
  });
});
