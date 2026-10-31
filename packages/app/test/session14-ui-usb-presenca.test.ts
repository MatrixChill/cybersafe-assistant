import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { UsbDeviceState, UsbProtectionSnapshot } from "@cybersafe/shared-types";
import {
  descreverMonitor,
  linhaDePresenca,
  normalizarSnapshot,
  resumoDePresenca,
} from "../src/lib/usbProtection";

/**
 * SESSION14-P0 — o total de unidades mostrado.
 *
 * O defeito humano: «Monitorização operacional · N unidades» usava
 * `snapshot.devices.length`, que no bounded snapshot do serviço é o
 * HISTÓRICO (terminal não podado + removidos + baseline). Com uma pen
 * desligada, o total não descia — e parecia que havia unidades ligadas que
 * não estavam.
 *
 * A correção é só de APRESENTAÇÃO. Nada aqui toca no parser
 * (`normalizarSnapshot`), no baseline, na poda ou no contrato: a lista
 * continua a mostrar o histórico, e é isso que o campo `present`
 * ("Presença confirmada na última enumeração", shared-types) decide.
 * Presença NÃO se infere de `completed`/`failed` — um `failed` presente é
 * uma unidade ligada; um `completed` ausente é histórico.
 */

const dev = (over: Partial<UsbDeviceState>): UsbDeviceState => ({
  id: "u1",
  rootPath: "E:\\",
  present: true,
  status: "detected",
  ...over,
});

const snapshot = (over: Partial<UsbProtectionSnapshot>): UsbProtectionSnapshot => ({
  enabled: true,
  monitorStatus: "operational",
  updatedAt: "2026-10-14T07:00:00.000Z",
  devices: [],
  ...over,
});

describe("SESSION14 — contagem de presença USB", () => {
  test("operational: presentes são ligados, ausentes são removidos — o total não se confunde", () => {
    const s = snapshot({
      devices: [
        dev({ id: "a", present: true, status: "detected" }),
        dev({ id: "b", present: true, status: "scanning" }),
        dev({ id: "c", present: false, status: "removed" }),
      ],
    });
    const r = resumoDePresenca(s);
    assert.equal(r.ligados, 2);
    assert.equal(r.removidos, 1);
    assert.equal(r.naoConfirmados, 0);
    assert.equal(r.total, 3);
    assert.equal(r.enumeracaoConfirmada, true);
    assert.match(linhaDePresenca(r), /^Presença: 2 ligadas · 1 removida · 0 com presença não confirmada\.$/);
  });

  test("histórico terminal NÃO é presença: failed/completed sem `present` são removidos", () => {
    const s = snapshot({
      devices: [
        dev({ id: "a", present: false, status: "failed" }),
        dev({ id: "b", present: false, status: "completed" }),
      ],
    });
    const r = resumoDePresenca(s);
    assert.equal(r.ligados, 0, "um terminal ausente contou como ligado");
    assert.equal(r.removidos, 2);
  });

  test("present:true com análise falhada é ligado — presença não se infere do status", () => {
    const s = snapshot({ devices: [dev({ id: "a", present: true, status: "failed" })] });
    assert.equal(resumoDePresenca(s).ligados, 1);
  });

  test("enumeração não confirmada (unavailable/starting/erro): anterior vira não confirmado, nunca ligado", () => {
    const s = snapshot({
      monitorStatus: "unavailable",
      error: "Enuminação falhou (CIM).",
      devices: [dev({ id: "a", present: true }), dev({ id: "b", present: false })],
    });
    const r = resumoDePresenca(s);
    assert.equal(r.enumeracaoConfirmada, false);
    assert.equal(r.ligados, 0, "a UI afirmou presença com a enumeração partida");
    assert.equal(r.removidos, 0);
    assert.equal(r.naoConfirmados, 2);
    const d = descreverMonitor(s);
    assert.match(d.detalhe, /Enuminação falhou \(CIM\)\./, "a mensagem do serviço desapareceu");
    assert.match(d.detalhe, /presença não confirmada/);
    assert.doesNotMatch(d.detalhe, /ligada/);
  });

  test("operational com `error` residual: presença tratada como não confirmada", () => {
    const s = snapshot({ devices: [dev({})], error: "qualquer coisa" });
    assert.equal(resumoDePresenca(s).naoConfirmados, 1);
  });

  test("descreverMonitor operacional: o título conta SÓ ligados confirmados; histórico em linha própria", () => {
    const s = snapshot({
      devices: [dev({ id: "a", present: true }), dev({ id: "b", present: false, status: "removed" })],
    });
    const d = descreverMonitor(s);
    assert.equal(d.titulo, "Monitorização operacional · 1 unidade ligada");
    assert.match(d.detalhe, /Presença: 1 ligada · 1 removida · 0 com presença não confirmada\./);
  });

  test("nenhum ligado: o título diz 0, não o total histórico", () => {
    const s = snapshot({
      devices: [dev({ id: "a", present: false, status: "removed" }), dev({ id: "b", present: false, status: "completed" })],
    });
    assert.equal(descreverMonitor(s).titulo, "Monitorização operacional · 0 unidades ligadas");
  });

  test("a correção não mudou o parser: o mesmo envelope entra, o mesmo snapshot sai", () => {
    const bruto = {
      enabled: true,
      monitorStatus: "operational",
      updatedAt: "2026-10-14T07:00:00.000Z",
      devices: [
        { id: "a", rootPath: "E:\\", present: true, status: "detected" },
        { id: "", rootPath: "F:\\", present: true, status: "detected" },
      ],
    };
    const lido = normalizarSnapshot(bruto);
    assert.ok(lido);
    assert.equal(lido.snapshot.devices.length, 1);
    assert.equal(lido.ignorados, 1);
    assert.equal(resumoDePresenca(lido.snapshot).ligados, 1);
  });

  test("zero unidades confirmadas continua sem garantia nova nem número inventado", () => {
    const d = descreverMonitor(snapshot({ devices: [] }));
    assert.match(d.titulo, /Nenhuma unidade de armazenamento USB confirmada/);
    assert.doesNotMatch(d.detalhe, /Presença:/, "linha de presença com zero unidades é ruído inventado");
  });
});
