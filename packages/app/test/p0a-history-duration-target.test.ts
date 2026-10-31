import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { UsbDeviceState } from "@cybersafe/shared-types";
import {
  describeScanHistoryOutcome,
  describeScanTarget,
  formatDuration,
  targetNameFromPath,
  usbTargetLabel,
  TARGET_LABEL_COMPUTER,
  TARGET_LABEL_FOLDER_UNKNOWN,
} from "../src/lib/scanHistoryReport";

/**
 * P0-A-app (15/10) — as duas regras de apresentação do histórico/PDF.
 *
 * O caso que motivou isto é real e está aqui como fixture: a análise USB fechou
 * **16 421 ficheiros em 818 496 ms** e o histórico mostrava esse número. O resto
 * são casos-limite em que a resposta honesta é «não sei» — nunca um palpite.
 *
 * FIÁVEIS AQUI: só letras de unidade genéricas (H:, E:, D:). Nada de caminhos do
 * utilizador, nem sequer nos testes.
 */

const unidade = (over: Partial<UsbDeviceState> = {}): UsbDeviceState => ({
  id: "usb-1",
  rootPath: "H:\\",
  label: "PEN",
  present: true,
  status: "detected",
  ...over,
});

describe("describeScanHistoryOutcome — o histórico distingue conclusão de resultado conclusivo", () => {
  test("resultado parcial e ausência de estado dos motores não ficam verdes", () => {
    assert.deepEqual(describeScanHistoryOutcome("completed", 0), { label: null, partial: false });
    assert.deepEqual(describeScanHistoryOutcome("completed", 1), {
      label: "Parcial — 1 resultado inconclusivo",
      partial: true,
    });
    assert.deepEqual(describeScanHistoryOutcome("completed", 3), {
      label: "Parcial — 3 resultados inconclusivos",
      partial: true,
    });
    assert.deepEqual(describeScanHistoryOutcome("completed", undefined), {
      label: "Estado conclusivo dos motores não reportado",
      partial: true,
    });
  });

  test("estado cancelado ou falhado continua a usar o seu próprio estado terminal", () => {
    assert.deepEqual(describeScanHistoryOutcome("cancelled", undefined), { label: null, partial: false });
    assert.deepEqual(describeScanHistoryOutcome("failed", undefined), { label: null, partial: false });
  });
});

describe("formatDuration — a duração medida diz-se em PT-PT", () => {
  test("o caso real medido: 818 496 ms é «13 min 38 s», não um número em bruto", () => {
    assert.equal(formatDuration(818_496), "13 min 38 s");
  });

  test("abaixo de 1 s mostra-se em milissegundos", () => {
    assert.equal(formatDuration(760), "760 ms");
    assert.equal(formatDuration(0), "0 ms", "zero medido é zero: «0 ms» é uma leitura, não uma ausência");
    assert.equal(formatDuration(999), "999 ms");
  });

  test("o décimo de segundo sai com vírgula, não com ponto", () => {
    assert.equal(formatDuration(3_400), "3,4 s");
    assert.equal(formatDuration(9_999), "10,0 s");
  });

  test("minutos e horas: as fronteiras não saltam unidades", () => {
    assert.equal(formatDuration(12_500), "13 s");
    assert.equal(formatDuration(60_000), "1 min 0 s");
    assert.equal(formatDuration(3_599_000), "59 min 59 s");
    assert.equal(formatDuration(3_600_000), "1 h 0 min");
    assert.equal(formatDuration(4_500_000), "1 h 15 min");
  });

  test("ausente ou impossível diz «sem leitura» — nunca 0 ms", () => {
    for (const mau of [undefined, null, Number.NaN, -1, Number.POSITIVE_INFINITY, "818496", {}]) {
      assert.equal(formatDuration(mau), "sem leitura", `${String(mau)} não é uma duração medida`);
    }
  });
});

describe("describeScanTarget — USB só com prova, e a prova é o scanId ou a raiz", () => {
  test("alvo na raiz de uma unidade detetada: «USB (H:\\)» com o nome do volume", () => {
    const rotulo = describeScanTarget({ kind: "custom", path: "H:\\" }, [unidade({ label: "PEN DRIVE" })]);
    assert.equal(rotulo, "USB (H:\\) · PEN DRIVE");
  });

  test("sem nome de volume publicado, o rótulo não inventa um", () => {
    assert.equal(describeScanTarget({ kind: "custom", path: "h:/" }, [unidade({ label: undefined })]), "USB (H:\\)");
    assert.equal(describeScanTarget({ kind: "custom", path: "H:\\" }, [unidade({ label: "   " })]), "USB (H:\\)");
  });

  test("o histórico não guarda caminho: a ligação que resta é o scanId da unidade", () => {
    const unidades = [unidade({ id: "u-H", rootPath: "H:\\", scanId: "scan-16421", label: "PEN" })];
    // É exactamente o que o painel lhe passa: tipo + id do registo, sem caminho.
    assert.equal(describeScanTarget({ kind: "custom", scanId: "scan-16421" }, unidades), "USB (H:\\) · PEN");
    assert.equal(describeScanTarget({ kind: "custom", scanId: "scan-outro" }, unidades), TARGET_LABEL_FOLDER_UNKNOWN);
    assert.equal(describeScanTarget({ kind: "custom" }, unidades), TARGET_LABEL_FOLDER_UNKNOWN);
  });

  test("letra igual sem unidade detetada NÃO é USB: pela letra, nunca se adivinha", () => {
    assert.equal(describeScanTarget({ kind: "custom", path: "Z:\\" }, [unidade({ rootPath: "H:\\" })]), TARGET_LABEL_FOLDER_UNKNOWN);
    assert.equal(describeScanTarget({ kind: "custom", path: "H:\\" }, []), TARGET_LABEL_FOLDER_UNKNOWN);
    assert.equal(describeScanTarget({ kind: "custom", path: "H:\\" }, null), TARGET_LABEL_FOLDER_UNKNOWN);
    assert.equal(describeScanTarget({ kind: "custom", path: "H:\\" }, undefined), TARGET_LABEL_FOLDER_UNKNOWN);
  });

  test("disco detetado sem volume publicado não se apresenta como analisável", () => {
    const semVolume = unidade({ rootPath: "", awaitingVolume: true, scanId: "scan-1", label: undefined });
    assert.equal(describeScanTarget({ kind: "custom", scanId: "scan-1" }, [semVolume]), TARGET_LABEL_FOLDER_UNKNOWN);
  });

  test("o computador inteiro continua «Computador»", () => {
    assert.equal(describeScanTarget({ kind: "default" }, []), TARGET_LABEL_COMPUTER);
    assert.equal(describeScanTarget({ kind: "default", scanId: "scan-1" }, [unidade({ scanId: "scan-2" })]), TARGET_LABEL_COMPUTER);
  });

  test("pasta e ficheiro com nome conhecido dizem o nome, sem caminho nenhum", () => {
    assert.equal(describeScanTarget({ kind: "folder", path: "D:\\Relatorios\\2026" }, []), "Pasta 2026");
    assert.equal(describeScanTarget({ kind: "file", path: "D:\\Relatorios\\fatura.pdf" }, []), "Ficheiro fatura.pdf");
  });

  test("«Pasta escolhida» é o que fica quando não se sabe mais nada", () => {
    assert.equal(describeScanTarget({ kind: "custom", path: "D:\\Relatorios" }, []), TARGET_LABEL_FOLDER_UNKNOWN,
      "«custom» não se transforma em «Pasta <nome>» sem saber que é uma pasta");
    assert.equal(describeScanTarget({ kind: "folder" }, []), TARGET_LABEL_FOLDER_UNKNOWN);
    assert.equal(describeScanTarget({ kind: "folder", path: "D:\\" }, []), TARGET_LABEL_FOLDER_UNKNOWN,
      "uma raiz sem unidade detetada nao ganha um nome inventado");
    assert.equal(describeScanTarget({ kind: "file", path: "   " }, []), TARGET_LABEL_FOLDER_UNKNOWN);
    assert.equal(describeScanTarget(null, []), TARGET_LABEL_FOLDER_UNKNOWN);
    assert.equal(describeScanTarget(undefined, [unidade()]), TARGET_LABEL_FOLDER_UNKNOWN);
    assert.equal(describeScanTarget({ kind: "custom", path: "" }, []), TARGET_LABEL_FOLDER_UNKNOWN);
  });

  test("um alvo DENTRO da unidade detetada também é dessa unidade — não é uma letra adivinhada", () => {
    assert.equal(describeScanTarget({ kind: "file", path: "H:\\Documentos\\exame.pdf" }, [unidade({ label: "PEN" })]), "USB (H:\\) · PEN");
  });
});

describe("peças pequenas da mesma regra", () => {
  test("targetNameFromPath: último segmento, com separadores finais tolerados", () => {
    assert.equal(targetNameFromPath("D:\\Relatorios\\2026"), "2026");
    assert.equal(targetNameFromPath("D:\\Relatorios\\2026\\"), "2026");
    assert.equal(targetNameFromPath("D:/Relatorios/2026/"), "2026");
    assert.equal(targetNameFromPath("fatura.pdf"), "fatura.pdf");
    assert.equal(targetNameFromPath(""), null);
    assert.equal(targetNameFromPath("   D:\\   "), null);
    assert.equal(targetNameFromPath("D:\\"), null);
    assert.equal(targetNameFromPath(null), null);
    assert.equal(targetNameFromPath(42), null);
  });

  test("usbTargetLabel: a letra sobe a maiúscula, o volume só entra quando existe", () => {
    assert.equal(usbTargetLabel({ rootPath: "e:\\", label: "CARTÃO" }), "USB (E:\\) · CARTÃO");
    assert.equal(usbTargetLabel({ rootPath: "E:\\", label: "" }), "USB (E:\\)");
    assert.equal(usbTargetLabel({ rootPath: "sem letra", label: undefined }), "USB (sem letra)");
  });
});
