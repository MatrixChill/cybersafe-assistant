import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import type { UsbDeviceState, UsbProtectionSnapshot } from "@cybersafe/shared-types";
import {
  PRAZO_CONSULTA_MS,
  TEXTO_PRAZO_CONSULTA,
  criarOrquestradorUsb,
  linhaDeEsperaVolume,
  normalizarDispositivo,
  normalizarSnapshot,
  type ModeloUsb,
} from "../src/lib/usbProtection";

/**
 * PACOTE A (P0 scan-usb, qoder) — lacunas de UI do USB corrigidas:
 *  · timeout BOUNDED: `PRAZO_CONSULTA_MS` (15 s, o teto do CIM por lote do
 *    serviço) encerra a consulta como «não confirmada» — nunca como sucesso
 *    nem como falha física do serviço;
 *  · resposta ANTIGA ignorada depois do prazo (o `finally`/`then` do pedido
 *    expirado não escreve estado);
 *  · retry FUNCIONAL: «Recarregar» com um pedido em voo invalida-o (geração)
 *    e emite UM novo — bounded, nunca dois simultâneos;
 *  · estado "a aguardar volume" transportado do snapshot e dito com as
 *    palavras do contrato (sem volume não há alvo de análise);
 *  · recuperar sem sair da página.
 *
 * Tudo com agendador e promises emprestados — sem relógio real, sem DOM, sem
 * USB física, sem serviço. Nada aqui prova toast/Windows: prova decisão.
 */

function agendadorFalso() {
  const agendadas: Array<{ fn: () => void; ms: number }> = [];
  return {
    agendar(fn: () => void, ms: number) {
      agendadas.push({ fn, ms });
      return () => {
        const i = agendadas.findIndex((t) => t.fn === fn);
        if (i >= 0) agendadas.splice(i, 1);
      };
    },
    dispararMaisAntigo() {
      const t = agendadas.shift();
      if (!t) throw new Error("sem temporizador");
      t.fn();
      return t.ms;
    },
    dispararPrazo() {
      const i = agendadas.findIndex((t) => t.ms === PRAZO_CONSULTA_MS);
      if (i < 0) throw new Error("sem prazo agendado");
      const [t] = agendadas.splice(i, 1);
      t.fn();
    },
    get pendentes() {
      return agendadas.map((t) => t.ms);
    },
  };
}

function deferida<T>() {
  let resolver!: (v: T) => void;
  const promessa = new Promise<T>((r) => { resolver = r; });
  return { promessa, resolver };
}

const escorrer = async () => { for (let i = 0; i < 24; i += 1) await Promise.resolve(); };

const snapshotOk = (extra: Partial<UsbProtectionSnapshot> = {}): UsbProtectionSnapshot => ({
  enabled: false,
  monitorStatus: "operational",
  updatedAt: "2026-10-14T12:10:00.000Z",
  devices: [],
  ...extra,
});

const dispositivo = (extra: Partial<UsbDeviceState> = {}): UsbDeviceState => ({
  id: "usb-1", rootPath: "E:\\", present: true, status: "detected", ...extra,
});

function montar(respostas: Array<() => Promise<unknown>>, ag: ReturnType<typeof agendadorFalso>) {
  const modelos: ModeloUsb[] = [];
  let pedidos = 0;
  const orq = criarOrquestradorUsb({
    obterEstado: () => { pedidos += 1; return respostas[pedidos - 1](); },
    aoModelo: (m) => modelos.push(m),
    agendar: ag.agendar,
  });
  return { modelos, orq, get pedidos() { return pedidos; } };
}
describe("pacote A — prazo bounded da consulta USB", () => {
  test("prazo expira: vista de erro honesta, sem sucesso nem falha inferida, e retoma o tick", async () => {
    const ag = agendadorFalso();
    const pendente = deferida<unknown>();
    const { modelos, orq } = montar([() => pendente.promessa], ag);
    orq.iniciar();
    await escorrer();
    ag.dispararPrazo();
    await escorrer();
    const vista = modelos.at(-1)!.vista;
    assert.equal(vista.tipo, "erro");
    assert.equal(vista.tipo === "erro" && vista.mensagem, TEXTO_PRAZO_CONSULTA);
    assert.match(TEXTO_PRAZO_CONSULTA, /não foi confirmada/);
    assert.doesNotMatch(TEXTO_PRAZO_CONSULTA, /o serviço falhou|seguro|protegido|está em baixo/i);
    // sem esperaProlongada pendurada por cima do erro
    assert.equal(modelos.at(-1)!.esperaProlongada, false);
    // recuperar sem sair: o tick voltou a ser agendado
    assert.ok(ag.pendentes.length >= 1, "expirado o prazo, a página ficou parada para sempre");
  });

  test("resposta ANTIGA depois do prazo é deitada fora; snapshot não é sobrescrito", async () => {
    const ag = agendadorFalso();
    const pendente = deferida<unknown>();
    const { modelos, orq } = montar([() => pendente.promessa], ag);
    orq.iniciar();
    await escorrer();
    ag.dispararPrazo();
    await escorrer();
    const erroVista = modelos.at(-1)!.vista.tipo;
    pendente.resolver(snapshotOk({ devices: [dispositivo()] }));
    await escorrer();
    assert.equal(modelos.at(-1)!.vista.tipo, erroVista, "a resposta do pedido expirado escreveu por cima do prazo");
    // mas o tick seguinte já é pedido NOVO e vale
    const respostaNova = deferida<unknown>();
    ag.dispararMaisAntigo();
    await escorrer();
    respostaNova.resolver(snapshotOk({ devices: [dispositivo()] }));
    await escorrer();
  });
});

describe("pacote A — recarregar funcional com geração e cooldown honesto", () => {
  test("clique ANTES da espera prolongada é deitado fora (cooldown sem estado novo)", async () => {
    const ag = agendadorFalso();
    const primeira = deferida<unknown>();
    const m = montar([() => primeira.promessa], ag);
    m.orq.iniciar();
    await escorrer();
    m.orq.recarregar();
    await escorrer();
    assert.equal(m.pedidos, 1, "um clique precoce re-emtiu pedido: o cooldown não segura a tempestade");
  });

  test("retry após a espera: invalida o antigo por geração, emite UM novo, resposta antiga não manda", async () => {
    const ag = agendadorFalso();
    const antiga = deferida<unknown>();
    const nova = deferida<unknown>();
    const m = montar([() => antiga.promessa, () => nova.promessa], ag);
    m.orq.iniciar();
    await escorrer();
    assert.equal(m.pedidos, 1);
    ag.dispararMaisAntigo(); // a espera de 5 s: declara a apresentação E abre janela de retry
    await escorrer();
    m.orq.recarregar();
    await escorrer();
    assert.equal(m.pedidos, 2, "o retry não emitiu novo pedido");
    // a nova resposta pinta; a antiga (geração invalidada) não sobrescreve
    nova.resolver(snapshotOk({ devices: [dispositivo({ id: "novo" })] }));
    await escorrer();
    assert.equal(m.modelos.at(-1)!.vista.tipo, "snapshot");
    antiga.resolver(snapshotOk({ devices: [dispositivo({ id: "velho" })] }));
    await escorrer();
    const vista = m.modelos.at(-1)!.vista;
    assert.equal(vista.tipo, "snapshot");
    if (vista.tipo === "snapshot") {
      assert.equal(vista.dispositivos[0]?.id, "novo", "a resposta da geração antiga voltou a mandar");
    }
  });

  test("retry depois do prazo expira e volta a consultar (recuperação sem sair)", async () => {
    const ag = agendadorFalso();
    const pendente = deferida<unknown>();
    const boa = deferida<unknown>();
    const m = montar([() => pendente.promessa, () => boa.promessa], ag);
    m.orq.iniciar();
    await escorrer();
    ag.dispararPrazo();
    await escorrer();
    assert.equal(m.modelos.at(-1)!.vista.tipo, "erro");
    // sem cancelamento real: o pedido antigo resolve no bridge DEPOIS do prazo
    // e a UI deita-o fora — é o limite documentado, não um bug a esconder.
    pendente.resolver(snapshotOk({ devices: [dispositivo({ id: "velho" })] }));
    await escorrer();
    assert.notEqual(m.modelos.at(-1)!.vista.tipo, "snapshot", "a resposta tardia escreveu por cima do prazo");
    m.orq.recarregar();
    await escorrer();
    assert.equal(m.pedidos, 2);
    boa.resolver(snapshotOk({ devices: [dispositivo({ id: "novo" })] }));
    await escorrer();
    const vista = m.modelos.at(-1)!.vista;
    assert.equal(vista.tipo, "snapshot");
    if (vista.tipo === "snapshot") assert.equal(vista.dispositivos[0]?.id, "novo");
  });
});

describe("pacote A — estado «a aguardar volume»", () => {
  test("normalizador transporta awaitingVolume EXATO true e ignora lixo", () => {
    const limpo = normalizarDispositivo({ id: "a", rootPath: "", present: true, status: "detected", awaitingVolume: true }) as UsbDeviceState;
    assert.equal(limpo.awaitingVolume, true);
    assert.equal(normalizarDispositivo({ id: "a", rootPath: "", present: true, status: "detected", awaitingVolume: "sim" as unknown })!.awaitingVolume, undefined);
    assert.equal(normalizarDispositivo({ id: "a", rootPath: "", present: true, status: "detected" })!.awaitingVolume, undefined);
  });

  test("linha de espera só para quem espera; diz que sem volume não há análise", () => {
    const linha = linhaDeEsperaVolume(dispositivo({ awaitingVolume: true, rootPath: "" }))!;
    assert.match(linha, /a aguardar volume/i);
    assert.match(linha, /não há nada para analisar|não há alvo/i);
    assert.equal(linhaDeEsperaVolume(dispositivo()), null);
  });

  test("snapshot completo com disco em espera passa o normalizador", () => {
    const bruto = {
      enabled: false,
      monitorStatus: "operational",
      updatedAt: "2026-10-14T12:20:00.000Z",
      devices: [
        { id: "usb-1", rootPath: "E:\\", present: true, status: "detected" },
        { id: "usb-2", rootPath: "", present: true, status: "detected", awaitingVolume: true, limitation: "dispositivo detetado — a aguardar volume (letra) do Windows" },
      ],
    };
    const r = normalizarSnapshot(bruto)!;
    assert.equal(r.ignorados, 0);
    assert.equal(r.snapshot.devices[1].awaitingVolume, true);
    const linha = linhaDeEsperaVolume(r.snapshot.devices[1])!;
    assert.match(linha, /aguardar volume/);
  });
});
