import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  BENIGN_PROBE_BUFFER,
  avDenialSkipReason,
  isYaraBufferTargetDenied,
  positiveControlMatchOrSkip,
  yaraDenialDetail,
} from "./fixtures/yara-av-denial.js";

/**
 * HARNESS DO POSITIVO DE CONTROLO vs. ANTIVÍRUS DA MÁQUINA.
 *
 * O que está em causa é a honestidade da asserção: cinco testes do core falham
 * nesta máquina porque o antivírus nega ao `yara64.exe` a leitura do alvo
 * temporário com conteúdo EICAR. O harness só pode saltar quando essa causa é
 * MEDIDA; caso contrário o defeito real tem de continuar a dar FAIL.
 *
 * As formas de mensagem abaixo são as medidas com o binário vendorizado e o
 * canário do produto (logs `probe-av.txt` / `probe-variants.txt`):
 *   alvo negado:  "error scanning <...>\\target.bin: could not open file"
 *   regras ilegíveis: "error: could not open file: <...>.yar"   ← NÃO é o caso
 *   prazo:        "YARA scan falhou (prazo/processo/output); ...: SIGKILL"
 */

/** Reproduz o embrulho real: `scanBuffer` lança, `YaraEngine.match` re-lança. */
function denialFrom(innerMessage) {
  return new Error("YARA could not scan the buffer.", { cause: new Error(innerMessage) });
}

const DENIAL_MESSAGE =
  "YARA scan falhou (prazo/processo/output); ficheiro NÃO avaliado: 1 — yara: " +
  "error scanning C:\\Users\\teste\\AppData\\Local\\Temp\\cybersafe-yara-buffer-Ab12Cd\\target.bin: could not open file";

function recorder() {
  const skipped = [];
  return { skipped, skip(message) { skipped.push(message); } };
}

/** Motor falso com comportamento por buffer: só interessa o contrato do harness. */
function fakeEngine({ control, benign }) {
  const calls = [];
  return {
    calls,
    match(buffer) {
      calls.push(buffer === BENIGN_PROBE_BUFFER ? "benign" : "control");
      const behaviour = buffer === BENIGN_PROBE_BUFFER ? benign : control;
      if (typeof behaviour === "function") throw behaviour();
      return behaviour;
    },
  };
}

describe("harness — detectar a negação de leitura do alvo", () => {
  test("reconhece a forma medida pelo produto (cadeia de cause incluída)", () => {
    assert.equal(isYaraBufferTargetDenied(denialFrom(DENIAL_MESSAGE)), true);
    assert.match(
      yaraDenialDetail(denialFrom(DENIAL_MESSAGE)),
      /^error scanning .*target\.bin: could not open file$/,
    );
  });

  test("não confunde regras ilegíveis, prazo, sinal, output-limit nem scanner ausente", () => {
    const notDenials = [
      // O ficheiro de REGRAS é que não abre: o scan nunca começou.
      "YARA scan falhou (prazo/processo/output); ficheiro NÃO avaliado: 1 — yara: error: could not open file: C:\\corpus.yar",
      // Prazo morto pelo próprio adapter (sem stderr util).
      "YARA scan falhou (prazo/processo/output); ficheiro NÃO avaliado: SIGKILL",
      "YARA terminou com erro; ficheiro NÃO avaliado.",
      "YARA output excedeu o limite; ficheiro NÃO avaliado.",
      "YARA scanner is unavailable; buffer was not evaluated.",
    ];
    for (const message of notDenials) {
      assert.equal(
        isYaraBufferTargetDenied(denialFrom(message)),
        false,
        `não devia ser lida como negação do alvo: ${message}`,
      );
    }
  });

  test("o motivo do skip nomeia a causa, cita o stderr medido e nunca diz que passou", () => {
    const reason = avDenialSkipReason(denialFrom(DENIAL_MESSAGE));
    assert.match(reason, /^SKIP \(ambiente, não produto\)/);
    assert.match(reason, /antivírus da máquina/);
    assert.match(reason, /error scanning .*target\.bin: could not open file/);
    assert.match(reason, /NÃO foi executada/);
    assert.doesNotMatch(reason, /pass|aprovad/i, "SKIP não pode ser redigido como aprovação");
  });
});

describe("harness — positiveControlMatchOrSkip", () => {
  test("sem interferência: devolve os matches e não salta nada", () => {
    const t = recorder();
    const engine = fakeEngine({ control: [{ ruleId: "CyberSafe_Canary_EICAR" }], benign: [] });
    const matches = positiveControlMatchOrSkip(t, engine, Buffer.from("POSITIVO-DE-CONTROLO"));
    assert.deepEqual(matches, [{ ruleId: "CyberSafe_Canary_EICAR" }]);
    assert.deepEqual(t.skipped, []);
  });

  test("negação medida + pipeline benigno vivo: salta com motivo e devolve null", () => {
    const t = recorder();
    const engine = fakeEngine({
      control: () => denialFrom(DENIAL_MESSAGE),
      benign: [],
    });
    const matches = positiveControlMatchOrSkip(t, engine, Buffer.from("POSITIVO-DE-CONTROLO"));
    assert.equal(matches, null, "null é o sinal de 'não executado', nunca 'zero matches'");
    assert.equal(t.skipped.length, 1);
    assert.match(t.skipped[0], /^SKIP \(ambiente, não produto\)/);
    // Ordem medida: o positivo primeiro, a prova benigna só para discriminar.
    assert.deepEqual(engine.calls, ["control", "benign"]);
  });

  test("se nem o buffer benigno scanneia, NÃO há skip: a falha propaga-se", () => {
    const t = recorder();
    const engine = fakeEngine({
      control: () => denialFrom(DENIAL_MESSAGE),
      benign: () => denialFrom(DENIAL_MESSAGE),
    });
    assert.throws(
      () => positiveControlMatchOrSkip(t, engine, Buffer.from("POSITIVO-DE-CONTROLO")),
      (error) => {
        assert.match(error.message, /nem o buffer benigno/);
        assert.equal(t.skipped.length, 0, "um motor partido não pode obter SKIP");
        return true;
      },
    );
  });

  test("falha que não é negação do alvo propaga-se intacta (defeito real = FAIL)", () => {
    const t = recorder();
    const original = denialFrom("YARA scan falhou (prazo/processo/output); ficheiro NÃO avaliado: SIGKILL");
    const engine = fakeEngine({ control: () => original, benign: [] });
    assert.throws(
      () => positiveControlMatchOrSkip(t, engine, Buffer.from("POSITIVO-DE-CONTROLO")),
      (error) => {
        assert.equal(error, original, "o harness não pode embrulhar nem engolir o erro real");
        assert.equal(t.skipped.length, 0);
        return true;
      },
    );
    assert.deepEqual(engine.calls, ["control"], "a prova benigna não é gasta numa falha real");
  });

  test("o contexto do node:test expõe skip() — o SKIP é reportado, não inventado", (t) => {
    assert.equal(typeof t.skip, "function");
  });
});
