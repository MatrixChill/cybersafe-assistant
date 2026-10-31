import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CAUSA_USB_READONLY,
  TEXTO_USB_READONLY_INDISPONIVEL,
  classificarRecusaUsbReadOnly,
  criarOrquestradorUsb,
  type ModeloUsb,
} from "../src/lib/usbProtection";

/**
 * P0 GUI-TEST 01 — a recusa readOnly de `configure-usb-protection` tem de
 * chegar ao ecrã como indisponibilidade de sessão, nunca como o envelope cru
 * do Electron.
 *
 * O que foi medido no relato humano: ao ligar a monitorização USB, a guarda
 * read-only do main recusou o canal antes do serviço:
 *   Error occurred in handler for 'service:configure-usb-protection':
 *   FronteiraWindowsReadOnlyError: dev_windows_readonly: efeito_negado_por_modo_leitura
 * O painel mostrava este texto técnico e o botão voltava a bater na mesma
 * guarda. Estes testes fixam a mensagem PT-PT, o reconhecimento estrito e a
 * ausência de RPC repetido — sem tocar na guarda nem inventar capability.
 */

/** Envelope exacto que o `ipcRenderer.invoke` entrega quando o main rejeita. */
const ENVELOPE_ELECTRON =
  "Error occurred in handler for 'service:configure-usb-protection': FronteiraWindowsReadOnlyError: " +
  CAUSA_USB_READONLY;

const SNAPSHOT = {
  enabled: false,
  monitorStatus: "operational" as const,
  updatedAt: "2026-10-23T07:00:00.000Z",
  devices: [],
};

interface Harness {
  orquestrador: ReturnType<typeof criarOrquestradorUsb>;
  modelo: () => ModeloUsb;
  chamadas: () => number;
}

function montar(configurar: () => Promise<unknown>): Harness {
  let ultimo: ModeloUsb | null = null;
  let chamadas = 0;
  const orquestrador = criarOrquestradorUsb({
    obterEstado: async () => SNAPSHOT,
    configurar: async () => {
      chamadas += 1;
      return configurar();
    },
    agendar: () => () => {},
    aoModelo: (modelo) => {
      ultimo = modelo;
    },
  });
  return {
    orquestrador,
    modelo: () => {
      if (!ultimo) throw new Error("o orquestrador não emitiu modelo");
      return ultimo;
    },
    chamadas: () => chamadas,
  };
}

describe("P0 USB — classificação da recusa readOnly", () => {
  it("reconhece o envelope exacto do Electron e a mensagem nua da fronteira", () => {
    assert.equal(classificarRecusaUsbReadOnly(new Error(ENVELOPE_ELECTRON)), "dev_windows_readonly");
    assert.equal(classificarRecusaUsbReadOnly(new Error(CAUSA_USB_READONLY)), "dev_windows_readonly");
  });

  it("NÃO reconhece rede, permissões, erro genérico nem outra recusa da fronteira", () => {
    for (const mensagem of [
      "connect ECONNRESET 127.0.0.1:pipe-cybersafe",
      "process.configureUsbProtection: access denied",
      "Error occurred in handler for 'service:configure-usb-protection': TypeError: payload inválido",
      "dev_windows_readonly: metodo_nao_e_leitura_permitida_neste_modo",
      "Error occurred in handler for 'service:kill-process-tree': FronteiraWindowsReadOnlyError: " +
        CAUSA_USB_READONLY,
      "",
    ]) {
      assert.equal(classificarRecusaUsbReadOnly(new Error(mensagem)), null, `falsa correspondência: ${mensagem}`);
    }
    assert.equal(classificarRecusaUsbReadOnly(undefined), null);
    assert.equal(classificarRecusaUsbReadOnly({ mensagem: ENVELOPE_ELECTRON }), null);
  });
});

describe("P0 USB — o que o utilizador lê e quantos RPC são feitos", () => {
  it("o envelope cru vira «indisponível nesta sessão de leitura»", async () => {
    const h = montar(async () => {
      throw new Error(ENVELOPE_ELECTRON);
    });
    h.orquestrador.iniciar();
    await h.orquestrador.alternarOptIn(true);

    const feedback = h.modelo().feedback;
    assert.equal(feedback.tipo, "indisponivel");
    assert.equal(feedback.tipo === "indisponivel" ? feedback.mensagem : "", TEXTO_USB_READONLY_INDISPONIVEL);
    assert.match(feedback.tipo === "indisponivel" ? feedback.mensagem : "", /indisponível nesta sessão de leitura/i);
    assert.doesNotMatch(feedback.tipo === "indisponivel" ? feedback.mensagem : "", /FronteiraWindowsReadOnlyError|service:configure-usb-protection|dev_windows_readonly/);
    assert.equal(h.modelo().aConfigurar, false, "o botão não pode ficar preso em «a configurar»");
    h.orquestrador.parar();
  });

  it("depois da recusa, outro gesto entrega a mesma mensagem sem novo RPC", async () => {
    const h = montar(async () => {
      throw new Error(ENVELOPE_ELECTRON);
    });
    h.orquestrador.iniciar();
    await h.orquestrador.alternarOptIn(true);
    assert.equal(h.chamadas(), 1);

    await h.orquestrador.alternarOptIn(false);
    assert.equal(h.chamadas(), 1, "a ação já recusada voltou a bater na guarda");
    assert.equal(h.modelo().feedback.tipo, "indisponivel");
    assert.match(
      h.modelo().feedback.tipo === "indisponivel" ? h.modelo().feedback.mensagem : "",
      /indisponível nesta sessão de leitura/i,
    );
    h.orquestrador.parar();
  });

  it("erro real de rede/permissões continua `erro` e não é engolido nem recuperado como leitura", async () => {
    for (const mensagem of ["connect ECONNRESET 127.0.0.1:pipe-cybersafe", "access denied"]) {
      const h = montar(async () => {
        throw new Error(mensagem);
      });
      h.orquestrador.iniciar();
      await h.orquestrador.alternarOptIn(true);
      assert.equal(h.modelo().feedback.tipo, "erro", `«${mensagem}» foi mascarado`);
      assert.match(h.modelo().feedback.tipo === "erro" ? h.modelo().feedback.mensagem : "", new RegExp(mensagem.split(" ")[0]));
      h.orquestrador.parar();
    }
  });

  it("só a recusa nomeada trava a repetição; um erro real ainda pode ser tentado", async () => {
    let chamadas = 0;
    const h = montar(async () => {
      chamadas += 1;
      if (chamadas === 1) throw new Error("connect ECONNRESET 127.0.0.1:pipe-cybersafe");
      return { ...SNAPSHOT, enabled: true };
    });
    h.orquestrador.iniciar();
    await h.orquestrador.alternarOptIn(true);
    assert.equal(h.modelo().feedback.tipo, "erro");

    await h.orquestrador.alternarOptIn(true);
    assert.equal(h.chamadas(), 2, "um erro real não pode bloquear a nova tentativa");
    assert.equal(h.modelo().feedback.tipo, "ok");
    h.orquestrador.parar();
  });
});
