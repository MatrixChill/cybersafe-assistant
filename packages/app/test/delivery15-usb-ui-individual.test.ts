import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScanState, UsbDeviceState, UsbProtectionSnapshot } from "@cybersafe/shared-types";

/**
 * PACOTE P0 UI USB — 15/10 (Freebuff).
 *
 * O que este ficheiro prova, e porque NÃO é uma cópia do `r8-usb-painel.test.ts`:
 *
 *  · o serviço NÃO republica o desfecho de uma análise depois de a unidade ser
 *    removida e reinserida — `usb-protection.ts` («estado terminal anterior nao
 *    transita») substitui a entrada por `detected` sem `result`. Com o opt-in
 *    desligado (o default entregue) isso deixa a pen a dizer apenas «proteção USB
 *    desligada (opt-in)», e a análise anterior desaparece do ecrã. A memória de
 *    sessão deste ficheiro existe para o painel poder dizer a VERDADE: «esta
 *    unidade já foi analisada nesta sessão, neste desfecho, a esta hora» — sem
 *    presença inventada e sem resultado inventado.
 *
 *  · a análise individual a pedido (com consentimento) NÃO tem contrato IPC
 *    ainda: `usb.getState`/`usb.configure` são os únicos canais USB publicados e
 *    `scan.start` não é read-only (proibido pelo próprio motor). Até o contrato
 *    existir, o painel tem de DIZER que não está disponível em vez de mostrar um
 *    botão morto. É isso que `TEXTO_ANALISE_INDIVIDUAL_INDISPONIVEL` fixa.
 *
 * Sem DOM, sem serviço, sem USB física. Fixtures entram como `unknown` pelo
 * normalizador, exatamente como entram do IPC.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(HERE, "..", ...parts), "utf8");

const lib = read("src", "lib", "usbProtection.ts");
const painel = read("src", "components", "UsbProtectionPanel.tsx");

import {
  LIMITE_MEMORIA_USB,
  TEXTO_ANALISE_INDIVIDUAL_INDISPONIVEL,
  TEXTO_CANCELAMENTO_NAO_CONFIRMADO,
  TEXTO_PEDIDO_NAO_CONFIRMADO,
  TEXTO_SEM_ALVO_CANCELAMENTO,
  criarOrquestradorUsb,
  lerRespostaCancelamento,
  lerRespostaInicioAnalise,
  linhaDaMemoria,
  registarDesfechos,
  resumoDeHistorico,
  type MemoriaUsb,
  type ModeloUsb,
  type PortaAnaliseIndividualUsb,
} from "../src/lib/usbProtection";

const dispositivo = (extra: Partial<UsbDeviceState> = {}): UsbDeviceState => ({
  id: "usb-1",
  rootPath: "E:\\",
  present: true,
  status: "detected",
  ...extra,
});

const resultado: ScanState = {
  id: "scan-1",
  type: "custom",
  status: "completed",
  progress: 100,
  filesScanned: 4,
  threatsFound: 0,
} as ScanState;

const snapshot = (extra: Partial<UsbProtectionSnapshot> = {}): UsbProtectionSnapshot => ({
  enabled: false,
  monitorStatus: "operational",
  updatedAt: "2026-10-15T09:00:00.000Z",
  devices: [],
  ...extra,
});

function deferida<T>() {
  let resolver!: (v: T) => void;
  const promessa = new Promise<T>((r) => { resolver = r; });
  return { promessa, resolver };
}
const escorrer = async () => { for (let i = 0; i < 24; i += 1) await Promise.resolve(); };

describe("P0-USB 15/10 — memória de sessão: só desfechos publicados, nunca inventados", () => {
  test("registra só o triunvirato terminal (completed/cancelled/failed) e com a hora do snapshot", () => {
    const memoria = registarDesfechos({}, snapshot({
      updatedAt: "2026-10-15T09:10:00.000Z",
      devices: [
        dispositivo({ id: "a", status: "completed", scanId: "s-a", result: resultado }),
        dispositivo({ id: "b", status: "cancelled", scanId: "s-b" }),
        dispositivo({ id: "c", status: "failed", scanId: "s-c" }),
      ],
    }));
    assert.deepEqual(Object.keys(memoria).sort(), ["a", "b", "c"]);
    assert.equal(memoria.a.status, "completed");
    assert.equal(memoria.a.quando, "2026-10-15T09:10:00.000Z");
    assert.equal(memoria.a.scanId, "s-a");
    assert.equal(memoria.b.status, "cancelled");
    assert.equal(memoria.c.status, "failed");
  });

  test("estados NÃO terminais e os que o contrato publica sem resultado ficam de fora", () => {
    const memoria = registarDesfechos({}, snapshot({
      devices: [
        dispositivo({ id: "a", status: "detected" }),
        dispositivo({ id: "b", status: "queued" }),
        dispositivo({ id: "c", status: "scanning", scanId: "s-c" }),
        // O serviço retira `result` e marca removed/incomplete: não é um desfecho.
        dispositivo({ id: "d", status: "removed" }),
        dispositivo({ id: "e", status: "incomplete" }),
      ],
    }));
    assert.deepEqual(memoria, {});
  });

  test("é pura: não mexe no mapa recebido", () => {
    const antes: MemoriaUsb = {};
    const depois = registarDesfechos(antes, snapshot({ devices: [dispositivo({ status: "completed", scanId: "s1" })] }));
    assert.deepEqual(antes, {}, "o registo escreveu no mapa de entrada");
    assert.equal(Object.keys(depois).length, 1);
  });

  test("não esquece: a reinserção (mesma identidade, sem result) mantém o desfecho anterior", () => {
    const comResultado = registarDesfechos({}, snapshot({
      updatedAt: "2026-10-15T09:00:00.000Z",
      devices: [dispositivo({ status: "completed", scanId: "s1", result: resultado })],
    }));
    // O serviço substitui a entrada por `detected` sem `result` na reinserção.
    const depois = registarDesfechos(comResultado, snapshot({
      updatedAt: "2026-10-15T09:30:00.000Z",
      devices: [dispositivo({ status: "detected", limitation: "proteção USB desligada (opt-in)" })],
    }));
    assert.equal(depois["usb-1"].status, "completed", "a memória perdeu o desfecho na reinserção");
    assert.equal(depois["usb-1"].quando, "2026-10-15T09:00:00.000Z", "a hora passou a ser a do snapshot sem desfecho");
  });

  test("bounded: mantém os LIMITE_MEMORIA_USB mais recentes, deterministicamente", () => {
    let memoria: MemoriaUsb = {};
    for (let i = 0; i < LIMITE_MEMORIA_USB + 3; i += 1) {
      const hora = String(10 + (i % 10)).padStart(2, "0");
      memoria = registarDesfechos(memoria, snapshot({
        updatedAt: `2026-10-15T${hora}:${String(i).padStart(2, "0")}:00.000Z`,
        devices: [dispositivo({ id: `usb-${i}`, status: "completed", scanId: `s-${i}` })],
      }));
    }
    const chaves = Object.keys(memoria);
    assert.equal(chaves.length, LIMITE_MEMORIA_USB);
    assert.equal(chaves.includes("usb-0"), false, "a entrada mais antiga devia ter saído");
    assert.ok(chaves.includes(`usb-${LIMITE_MEMORIA_USB + 2}`), "a entrada mais recente desapareceu");
  });
});

describe("P0-USB 15/10 — a linha de memória diz o que aconteceu e o que o serviço não republica", () => {
  const memoria: MemoriaUsb = registarDesfechos({}, snapshot({
    updatedAt: "2026-10-15T08:15:00.000Z",
    devices: [dispositivo({ status: "completed", scanId: "s1", result: resultado })],
  }));

  test("aparece na reinserção (unidade `detected`) e explica porque não se repetiu sozinha", () => {
    const linha = linhaDaMemoria(dispositivo({ status: "detected" }), memoria);
    assert.ok(linha, "sem linha de memória a reinserção apaga o que já se sabe");
    assert.match(linha!, /já\s+foi\s+analisada/i);
    assert.match(linha!, /conclu/i);
    assert.match(linha!, /não é republicad|não republica/i);
    assert.doesNotMatch(linha!, /protegid|seguro/i, "a memória não é uma promessa de proteção");
  });

  test("não escreve por cima de um desfecho ATUAL, nem inventa para identidade desconhecida", () => {
    assert.equal(linhaDaMemoria(dispositivo({ status: "completed", scanId: "s1", result: resultado }), memoria), null);
    assert.equal(linhaDaMemoria(dispositivo({ status: "cancelled" }), memoria), null);
    assert.equal(linhaDaMemoria(dispositivo({ id: "outro" }), memoria), null);
    assert.equal(linhaDaMemoria(dispositivo({ status: "detected" }), {}), null);
  });

  test("estado `scanning` atual não recebe linha de memória (a análise a correr fala por si)", () => {
    assert.equal(linhaDaMemoria(dispositivo({ status: "scanning", scanId: "s2" }), memoria), null);
  });
});

describe("P0-USB 15/10 — resumo de histórico da sessão e estado honesto da análise individual", () => {
  test("resumo conta por desfecho e cala-se quando não há histórico", () => {
    assert.equal(resumoDeHistorico({}), null);
    const memoria = registarDesfechos({}, snapshot({
      devices: [
        dispositivo({ id: "a", status: "completed", scanId: "s1" }),
        dispositivo({ id: "b", status: "completed", scanId: "s2" }),
        dispositivo({ id: "c", status: "cancelled", scanId: "s3" }),
      ],
    }));
    const resumo = resumoDeHistorico(memoria)!;
    assert.match(resumo, /2\s+conclu/i);
    assert.match(resumo, /1\s+cancelad/i);
    assert.match(resumo, /0\s+falhad/i);
    assert.doesNotMatch(resumo, /protegid|seguro/i);
  });

  test("a análise individual a pedido declara-se indisponível sem contrato — sem botão morto", () => {
    assert.match(TEXTO_ANALISE_INDIVIDUAL_INDISPONIVEL, /análise individual|analisar uma unidade|a pedido/i);
    assert.match(TEXTO_ANALISE_INDIVIDUAL_INDISPONIVEL, /não (está )?dispon/i);
    assert.doesNotMatch(TEXTO_ANALISE_INDIVIDUAL_INDISPONIVEL, /protegid|garantid|seguro/i);
  });
});

describe("P0-USB 15/10 — orquestrador: memória sobrevive a snapshots e reinicia na montagem", () => {
  test("o modelo expõe a memória e ela acumula entre snapshots, sem a perder no recarregar", async () => {
    const ag: Array<{ fn: () => void; ms: number }> = [];
    const agendar = (fn: () => void, ms: number) => {
      ag.push({ fn, ms });
      return () => { const i = ag.findIndex((t) => t.fn === fn); if (i >= 0) ag.splice(i, 1); };
    };
    const respostas: Array<() => Promise<unknown>> = [
      () => Promise.resolve(snapshot({ updatedAt: "2026-10-15T09:00:00.000Z", devices: [dispositivo({ status: "completed", scanId: "s1", result: resultado })] })),
      () => Promise.resolve(snapshot({ updatedAt: "2026-10-15T09:30:00.000Z", devices: [dispositivo({ status: "detected" })] })),
    ];
    const modelos: ModeloUsb[] = [];
    let pedidos = 0;
    const orq = criarOrquestradorUsb({
      obterEstado: () => { pedidos += 1; return respostas[Math.min(pedidos - 1, respostas.length - 1)](); },
      aoModelo: (m) => modelos.push(m),
      agendar,
    });
    orq.iniciar();
    await escorrer();
    assert.equal(modelos.at(-1)!.memoria["usb-1"]?.status, "completed", "o primeiro desfecho não entrou na memória");
    orq.recarregar();
    await escorrer();
    assert.equal(pedidos, 2, "o recarregar não voltou a consultar");
    const ultimo = modelos.at(-1)!;
    assert.equal(ultimo.memoria["usb-1"]?.status, "completed", "a memória desapareceu no snapshot seguinte");
    const vista = ultimo.vista;
    assert.equal(vista.tipo, "snapshot");
    if (vista.tipo === "snapshot") {
      assert.equal(vista.dispositivos[0]?.status, "detected", "o snapshot atual não pode ser mascarado pela memória");
    }
  });
});

// ── análise individual a pedido (contrato ratificado pelo Codex, 15/10) ─────

function portaEspia() {
  const pedidosIniciar: Array<{ deviceId: string; requestId: string; consent: true }> = [];
  const pedidosCancelar: Array<{ deviceId: string; scanId: string }> = [];
  const respostas: Array<() => Promise<unknown>> = [];
  const responder = () => (respostas.shift() ?? (() => Promise.resolve({ ok: false, error: "sem resposta preparada" })))();
  const porta: PortaAnaliseIndividualUsb = {
    iniciar: (pedido) => { pedidosIniciar.push(pedido); return responder(); },
    cancelar: (pedido) => { pedidosCancelar.push(pedido); return responder(); },
  };
  return { porta, pedidosIniciar, pedidosCancelar, respostas };
}

function agendadorFalso() {
  const agendadas: Array<{ fn: () => void; ms: number }> = [];
  return {
    agendar(fn: () => void, ms: number) {
      agendadas.push({ fn, ms });
      return () => { const i = agendadas.findIndex((t) => t.fn === fn); if (i >= 0) agendadas.splice(i, 1); };
    },
    /** Dispara o ÚLTIMO temporizador que casa — o mais recente é o da operação. */
    dispararPor(predicado: (ms: number) => boolean) {
      let i = -1;
      for (let k = agendadas.length - 1; k >= 0; k -= 1) {
        if (predicado(agendadas[k].ms)) { i = k; break; }
      }
      if (i < 0) throw new Error("sem temporizador correspondente");
      const [t] = agendadas.splice(i, 1);
      t.fn();
      return t.ms;
    },
    get pendentes() { return agendadas.map((t) => t.ms); },
  };
}

function montarAnalise(opcoes: {
  porta?: PortaAnaliseIndividualUsb | null;
  estados?: unknown[];
  ag: ReturnType<typeof agendadorFalso>;
}) {
  const modelos: ModeloUsb[] = [];
  const lista = opcoes.estados ?? [snapshot()];
  let pedidos = 0;
  const orq = criarOrquestradorUsb({
    obterEstado: () => { pedidos += 1; return Promise.resolve(lista[Math.min(pedidos - 1, lista.length - 1)]); },
    portaAnalise: opcoes.porta ?? null,
    novoRequestId: () => `req-${pedidos + 1}-fixo`,
    aoModelo: (m) => modelos.push(m),
    agendar: opcoes.ag.agendar,
  });
  return { modelos, orq, get pedidos() { return pedidos; }, ultimo: () => modelos.at(-1)! };
}

describe("P0-USB 15/10 — envelopes do contrato: o que não é reconhecível não é sucesso", () => {
  test("usbScan: ok exige deviceId E scanId; ok:false exige motivo (senão di-lo)", () => {
    assert.deepEqual(lerRespostaInicioAnalise({ ok: true, deviceId: "d1", scanId: "s1" }), { ok: true, deviceId: "d1", scanId: "s1" });
    assert.equal(lerRespostaInicioAnalise({ ok: true, deviceId: "d1" }), null, "ok sem scanId foi aceite");
    assert.equal(lerRespostaInicioAnalise({ ok: true, scanId: "s1" }), null, "ok sem deviceId foi aceite");
    assert.equal(lerRespostaInicioAnalise({ ok: "sim" }), null);
    assert.equal(lerRespostaInicioAnalise(null), null);
    assert.match((lerRespostaInicioAnalise({ ok: false }) as { error: string }).error, /sem declarar motivo/);
    assert.equal((lerRespostaInicioAnalise({ ok: false, error: "recusado" }) as { error: string }).error, "recusado");
  });

  test("usbCancel: `ok` booleano obrigatório, motivo só quando existe", () => {
    assert.deepEqual(lerRespostaCancelamento({ ok: true }), { ok: true });
    assert.deepEqual(lerRespostaCancelamento({ ok: false, error: "já terminou" }), { ok: false, error: "já terminou" });
    assert.equal(lerRespostaCancelamento({ ok: "true" }), null);
    assert.equal(lerRespostaCancelamento(undefined), null);
  });
});

describe("P0-USB 15/10 — análise individual a pedido: consentimento, um gesto de cada vez e sem retry automático", () => {
  test("sem contrato na ponte: declara-se indisponível e o gesto não faz nada", () => {
    const ag = agendadorFalso();
    const m = montarAnalise({ porta: null, ag });
    m.orq.iniciar();
    assert.equal(m.ultimo().analise.podePedir, false);
    assert.match(m.ultimo().analise.motivoIndisponivel, /não (está )?dispon/i);
    m.orq.pedirConsentimento("usb-1");
    assert.equal(m.ultimo().analise.pedido, null, "abriu consentimento sem contrato na ponte");
    m.orq.confirmarPedido();
    assert.notEqual(m.ultimo().feedback.tipo, "ok", "sem contrato não pode haver sucesso fingido");
  });

  test("pedir consentimento gera requestId e NÃO fala com o serviço", () => {
    const ag = agendadorFalso();
    const espia = portaEspia();
    const m = montarAnalise({ porta: espia.porta, ag });
    m.orq.iniciar();
    m.orq.pedirConsentimento("usb-1");
    const pedido = m.ultimo().analise.pedido!;
    assert.equal(pedido.deviceId, "usb-1");
    assert.ok(pedido.requestId.length > 0);
    assert.equal(espia.pedidosIniciar.length, 0, "o pedido de análise saiu sem consentimento");
  });

  test("desistir limpa o pedido sem deixar rasto no serviço", () => {
    const ag = agendadorFalso();
    const espia = portaEspia();
    const m = montarAnalise({ porta: espia.porta, ag });
    m.orq.iniciar();
    m.orq.pedirConsentimento("usb-1");
    m.orq.desistirDoPedido();
    assert.equal(m.ultimo().analise.pedido, null);
    assert.equal(espia.pedidosIniciar.length, 0);
  });

  test("confirmar: `consent: true` literal, MESMO requestId, e um só pedido para o duplo clique", async () => {
    const ag = agendadorFalso();
    const espia = portaEspia();
    espia.respostas.push(() => Promise.resolve({ ok: true, deviceId: "usb-1", scanId: "scan-9" }));
    const m = montarAnalise({ porta: espia.porta, ag });
    m.orq.iniciar();
    m.orq.pedirConsentimento("usb-1");
    const pedido = m.ultimo().analise.pedido!;
    m.orq.confirmarPedido();
    m.orq.confirmarPedido();
    await escorrer();
    assert.equal(espia.pedidosIniciar.length, 1, "dois pedidos para o mesmo gesto");
    assert.equal(espia.pedidosIniciar[0].requestId, pedido.requestId, "o requestId mudou entre pedido e confirmação");
    assert.equal(espia.pedidosIniciar[0].consent, true, "o consentimento não é literal true");
  });

  test("resposta ok: diz o identificador, limpa o gesto e vai buscar o estado — sem repetir a análise", async () => {
    const ag = agendadorFalso();
    const espia = portaEspia();
    espia.respostas.push(() => Promise.resolve({ ok: true, deviceId: "usb-1", scanId: "scan-9" }));
    const m = montarAnalise({ porta: espia.porta, ag, estados: [snapshot(), snapshot({ devices: [dispositivo({ status: "queued", scanId: "scan-9" })] })] });
    m.orq.iniciar();
    await escorrer();
    m.orq.pedirConsentimento("usb-1");
    m.orq.confirmarPedido();
    await escorrer();
    const modelo = m.ultimo();
    assert.equal(modelo.feedback.tipo, "ok");
    assert.match((modelo.feedback as { mensagem: string }).mensagem, /scan-9/);
    assert.equal(modelo.analise.pedido, null, "o gesto ficou pendurado depois de confirmado");
    assert.equal(modelo.analise.emCurso, null);
    assert.equal(espia.pedidosIniciar.length, 1, "repetiu a análise por conta própria");
    assert.ok(m.pedidos >= 2, "não foi confirmar o estado ao serviço depois do pedido");
  });

  test("ok:false mostra o motivo do serviço; envelope ilegível nunca vira sucesso", async () => {
    const ag = agendadorFalso();
    const espia = portaEspia();
    espia.respostas.push(() => Promise.resolve({ ok: false, error: "sem prova read-only" }));
    espia.respostas.push(() => Promise.resolve({ ok: true }));
    const m = montarAnalise({ porta: espia.porta, ag });
    m.orq.iniciar();
    m.orq.pedirConsentimento("usb-1");
    m.orq.confirmarPedido();
    await escorrer();
    assert.equal(m.ultimo().feedback.tipo, "erro");
    assert.match((m.ultimo().feedback as { mensagem: string }).mensagem, /sem prova read-only/);
    assert.equal(m.ultimo().analise.pedido, null, "recusa definitiva devia fechar o gesto");

    m.orq.pedirConsentimento("usb-1");
    m.orq.confirmarPedido();
    await escorrer();
    assert.equal(m.ultimo().feedback.tipo, "erro");
    assert.match((m.ultimo().feedback as { mensagem: string }).mensagem, /não é reconhecível/);
    assert.notEqual(m.ultimo().feedback.tipo, "ok");
    assert.ok(m.ultimo().analise.pedido, "estado desconhecido: o gesto tem de poder ser repetido com o MESMO requestId");
  });

  test("timeout: não confirmado, sem retry automático, e o gesto mantém o requestId para repetir", async () => {
    const ag = agendadorFalso();
    const espia = portaEspia();
    const pendente = deferida<unknown>();
    espia.respostas.push(() => pendente.promessa);
    const m = montarAnalise({ porta: espia.porta, ag });
    m.orq.iniciar();
    m.orq.pedirConsentimento("usb-1");
    const pedido = m.ultimo().analise.pedido!;
    m.orq.confirmarPedido();
    await escorrer();
    ag.dispararPor((ms) => ms === 15000);
    await escorrer();
    const apos = m.ultimo();
    assert.equal(apos.feedback.tipo, "nao_confirmado");
    assert.match((apos.feedback as { mensagem: string }).mensagem, /não se sabe se chegou a arrancar|não foi confirmado/i);
    assert.equal(apos.analise.emCurso, null, "a operação ficou presa depois do prazo");
    assert.equal(apos.analise.pedido?.requestId, pedido.requestId, "o retry perdeu o requestId do gesto");
    assert.equal(espia.pedidosIniciar.length, 1, "houve retry automático da análise");
    assert.ok(m.pedidos >= 2, "não foi ver o estado antes de qualquer repetição");
    // A resposta tardia não pode reescrever o prazo.
    pendente.resolver({ ok: true, deviceId: "usb-1", scanId: "scan-9" });
    await escorrer();
    assert.equal(m.ultimo().feedback.tipo, "nao_confirmado");
  });

  test("repetir o mesmo pedido reutiliza o requestId do gesto consentido", async () => {
    const ag = agendadorFalso();
    const espia = portaEspia();
    const primeiro = deferida<unknown>();
    espia.respostas.push(() => primeiro.promessa);
    espia.respostas.push(() => Promise.resolve({ ok: true, deviceId: "usb-1", scanId: "scan-10" }));
    const m = montarAnalise({ porta: espia.porta, ag });
    m.orq.iniciar();
    m.orq.pedirConsentimento("usb-1");
    const pedido = m.ultimo().analise.pedido!;
    m.orq.confirmarPedido();
    await escorrer();
    ag.dispararPor((ms) => ms === 15000);
    await escorrer();
    m.orq.confirmarPedido();
    await escorrer();
    assert.equal(espia.pedidosIniciar.length, 2);
    assert.equal(espia.pedidosIniciar[1].requestId, pedido.requestId, "a repetição gerou um requestId novo");
    assert.equal(m.ultimo().feedback.tipo, "ok");
  });

  test("cancelar exige deviceId E o scanId da análise MOSTRADA", async () => {
    const ag = agendadorFalso();
    const espia = portaEspia();
    espia.respostas.push(() => Promise.resolve({ ok: true }));
    const m = montarAnalise({
      porta: espia.porta,
      ag,
      estados: [snapshot({ devices: [dispositivo({ status: "scanning", scanId: "scan-9" })] })],
    });
    m.orq.iniciar();
    await escorrer();
    m.orq.cancelarAnalise("usb-1");
    await escorrer();
    assert.deepEqual(espia.pedidosCancelar[0], { deviceId: "usb-1", scanId: "scan-9" });
    assert.equal(m.ultimo().feedback.tipo, "ok");
  });

  test("sem scanId publicado não se cancela nada — e a ponte não é chamada", () => {
    const ag = agendadorFalso();
    const espia = portaEspia();
    const m = montarAnalise({
      porta: espia.porta,
      ag,
      estados: [snapshot({ devices: [dispositivo({ status: "detected" })] })],
    });
    m.orq.iniciar();
    m.orq.cancelarAnalise("usb-1");
    assert.equal(espia.pedidosCancelar.length, 0, "cancelou pelo dispositivo sem identificador de análise");
    assert.equal(m.ultimo().feedback.tipo, "erro");
    assert.equal((m.ultimo().feedback as { mensagem: string }).mensagem, TEXTO_SEM_ALVO_CANCELAMENTO);
  });

  test("o prazo do cancelamento também é declarado e não afirma cancelamento físico", async () => {
    const ag = agendadorFalso();
    const espia = portaEspia();
    const pendente = deferida<unknown>();
    espia.respostas.push(() => pendente.promessa);
    const m = montarAnalise({
      porta: espia.porta,
      ag,
      estados: [snapshot({ devices: [dispositivo({ status: "scanning", scanId: "scan-9" })] })],
    });
    m.orq.iniciar();
    await escorrer();
    m.orq.cancelarAnalise("usb-1");
    await escorrer();
    ag.dispararPor((ms) => ms === 15000);
    await escorrer();
    assert.equal(m.ultimo().feedback.tipo, "nao_confirmado");
    assert.match((m.ultimo().feedback as { mensagem: string }).mensagem, /não se sabe se chegou a ser entregue/i);
    pendente.resolver({ ok: true });
    await escorrer();
    assert.equal(m.ultimo().feedback.tipo, "nao_confirmado", "a resposta tardia afirmou cancelamento");
  });

  test("textos honestos: sem promessa de proteção nem de resultado", () => {
    assert.doesNotMatch(TEXTO_PEDIDO_NAO_CONFIRMADO, /protegid|seguro|garantid/i);
    assert.doesNotMatch(TEXTO_CANCELAMENTO_NAO_CONFIRMADO, /protegid|seguro|garantid|cancelad[oa] com sucesso/i);
    assert.doesNotMatch(TEXTO_SEM_ALVO_CANCELAMENTO, /protegid|seguro|garantid/i);
  });
});

describe("P0-USB 15/10 — o painel usa as duas fontes, sem CSS novo nem canais novos", () => {
  test("o painel monta a linha de presença, a memória e o aviso de análise individual", () => {
    // A linha de presença é COMPOSTA no lib (fonte única) e o painel só a mostra.
    assert.match(lib, /presenca: linhaDePresenca\(resumoDePresenca\(snapshot\)\)/);
    assert.match(painel, /\{vista\.presenca\}/);
    assert.match(painel, /linhaDaMemoria\(/);
    assert.match(painel, /resumoDeHistorico\(/);
    assert.match(painel, /TEXTO_ANALISE_INDIVIDUAL_INDISPONIVEL/);
  });

  test("continua a não pedir canais novos nem a tocar em ações de escrita/execução", () => {
    assert.equal(/onUsb[A-Za-z]*|usb\.progress|startScan|cancelScan|shell|exec\(/.test(painel), false);
  });

  test("a análise individual passa TODA pela seam tipada do contrato ratificado", () => {
    // O painel constrói a porta a partir da ponte (se os dois métodos existirem)
    // e nunca chama usbScan/usbCancel diretamente — quem decide é o orquestrador.
    assert.match(painel, /usbScan/);
    assert.match(painel, /usbCancel/);
    assert.match(painel, /portaAnalise/);
    assert.equal(/electronAPI\.usbScan|\.usbScan\(/.test(painel), false, "o painel fala com a ponte fora da seam");
    assert.match(painel, /pedirConsentimento\(/);
    assert.match(painel, /confirmarPedido\(/);
    assert.match(painel, /cancelarAnalise\(/);
    assert.match(painel, /desistirDoPedido\(/);
  });
});
