import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  PIPE_AUTH_VERSION,
  generatePipeNonce,
  isPipeNonce,
  makePipeProof,
  verifyPipeProof,
} from "../dist/pipe-auth.js";

// MAC de referência calculado de forma independente neste teste, para fixar o
// contrato: chave = Buffer.from(token,'hex'); mensagem UTF-8 do domínio v2.
// Se a implementação mudar o domínio, a chave ou a ordem dos campos, isto falha.
const macEsperado = (token, role, cliente, servidor) =>
  crypto
    .createHmac("sha256", Buffer.from(token, "hex"))
    .update(`cybersafe-pipe-v2:${role}:${cliente}:${servidor}`, "utf8")
    .digest("hex");

const TOKEN = "a".repeat(64);
const OUTRO_TOKEN = "b".repeat(64);
// Nonces com letras: "1".repeat(64).toUpperCase() seria igual, e um teste de
// maiúsculas com nonce só de dígitos não provaria nada.
const NONCE_C = "a1".repeat(32);
const NONCE_S = "b2".repeat(32);
const NONCE_S2 = "c3".repeat(32);

describe("PIPE_AUTH_VERSION", () => {
  it("é 2", () => {
    assert.equal(PIPE_AUTH_VERSION, 2);
  });
});

describe("generatePipeNonce / isPipeNonce — formato", () => {
  it("devolve 64 hex minúsculos (32 bytes)", () => {
    for (let i = 0; i < 50; i++) {
      const nonce = generatePipeNonce();
      assert.match(nonce, /^[0-9a-f]{64}$/);
      assert.equal(nonce.length, 64);
      assert.equal(Buffer.from(nonce, "hex").length, 32);
      assert.equal(isPipeNonce(nonce), true);
    }
  });

  it("não repete nonces consecutivos", () => {
    const vistos = new Set();
    for (let i = 0; i < 200; i++) vistos.add(generatePipeNonce());
    assert.equal(vistos.size, 200);
  });

  it("isPipeNonce aceita apenas 64 hex minúsculos", () => {
    const invalidos = [
      "A".repeat(64), // maiúsculas
      "a".repeat(63),
      "a".repeat(65),
      `${"a".repeat(63)}g`,
      "",
      " ",
      ` ${"a".repeat(63)}`,
      null,
      undefined,
      0,
      123,
      true,
      {},
      [],
      ["a".repeat(64)],
      Buffer.alloc(32),
      Buffer.from(TOKEN, "hex"),
      Symbol("nonce"),
      () => TOKEN,
    ];
    for (const valor of invalidos) {
      assert.equal(isPipeNonce(valor), false, `deveria rejeitar ${String(typeof valor)}`);
    }
  });
});

describe("makePipeProof — contrato do MAC", () => {
  it("bate com HMAC-SHA256 independente (role server)", () => {
    assert.equal(makePipeProof(TOKEN, "server", NONCE_C, NONCE_S), macEsperado(TOKEN, "server", NONCE_C, NONCE_S));
  });

  it("bate com HMAC-SHA256 independente (role client)", () => {
    assert.equal(makePipeProof(TOKEN, "client", NONCE_C, NONCE_S), macEsperado(TOKEN, "client", NONCE_C, NONCE_S));
  });

  it("devolve 64 hex minúsculos e é determinístico", () => {
    const a = makePipeProof(TOKEN, "server", NONCE_C, NONCE_S);
    const b = makePipeProof(TOKEN, "server", NONCE_C, NONCE_S);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, b);
  });

  it("domínios distintos: prova de server não serve como prova de client (anti-reflexão)", () => {
    const provaServer = makePipeProof(TOKEN, "server", NONCE_C, NONCE_S);
    const provaClient = makePipeProof(TOKEN, "client", NONCE_C, NONCE_S);
    assert.notEqual(provaServer, provaClient);
  });
});

describe("verifyPipeProof — correto/incorreto", () => {
  it("aceita a prova correta nos dois papéis", () => {
    assert.equal(verifyPipeProof(TOKEN, "server", NONCE_C, NONCE_S, makePipeProof(TOKEN, "server", NONCE_C, NONCE_S)), true);
    assert.equal(verifyPipeProof(TOKEN, "client", NONCE_C, NONCE_S, makePipeProof(TOKEN, "client", NONCE_C, NONCE_S)), true);
  });

  it("rejeita prova feita com outra chave", () => {
    const prova = makePipeProof(OUTRO_TOKEN, "server", NONCE_C, NONCE_S);
    assert.equal(verifyPipeProof(TOKEN, "server", NONCE_C, NONCE_S, prova), false);
  });

  it("rejeita se o nonce do cliente mudou", () => {
    const prova = makePipeProof(TOKEN, "server", "4".repeat(64), NONCE_S);
    assert.equal(verifyPipeProof(TOKEN, "server", NONCE_C, NONCE_S, prova), false);
  });

  it("rejeita se o nonce do servidor mudou", () => {
    const prova = makePipeProof(TOKEN, "server", NONCE_C, NONCE_S2);
    assert.equal(verifyPipeProof(TOKEN, "server", NONCE_C, NONCE_S, prova), false);
  });

  it("rejeita prova de server apresentada no papel de client (role trocado)", () => {
    const provaServer = makePipeProof(TOKEN, "server", NONCE_C, NONCE_S);
    assert.equal(verifyPipeProof(TOKEN, "client", NONCE_C, NONCE_S, provaServer), false);
  });

  it("rejeita prova adulterada (1 nibble trocado)", () => {
    const prova = makePipeProof(TOKEN, "server", NONCE_C, NONCE_S);
    const adulterada = (prova[0] === "0" ? "1" : "0") + prova.slice(1);
    assert.equal(verifyPipeProof(TOKEN, "server", NONCE_C, NONCE_S, adulterada), false);
  });

  it("rejeita formatos de prova inválidos sem lançar", () => {
    const prova = makePipeProof(TOKEN, "server", NONCE_C, NONCE_S);
    const invalidas = [
      prova.toUpperCase(),
      prova.slice(0, 63),
      `${prova}0`,
      `${prova.slice(0, 63)}g`,
      "",
      null,
      undefined,
      0,
      true,
      {},
      [],
      Buffer.from(prova, "hex"),
    ];
    for (const invalida of invalidas) {
      assert.equal(verifyPipeProof(TOKEN, "server", NONCE_C, NONCE_S, invalida), false);
    }
  });

  it("replay com nonces novos falha (helper não guarda estado — o protocolo é que os renova)", () => {
    const prova = makePipeProof(TOKEN, "server", NONCE_C, NONCE_S);
    // Mesma prova, ligação diferente (server nonce novo): não valida.
    assert.equal(verifyPipeProof(TOKEN, "server", NONCE_C, NONCE_S2, prova), false);
    // A mesma prova continua a validar enquanto os nonces forem os mesmos: a
    // repetição dentro da mesma ligação tem de ser travada pela fase do
    // handshake (Qoder), não por este helper puro.
    assert.equal(verifyPipeProof(TOKEN, "server", NONCE_C, NONCE_S, prova), true);
  });
});

describe("verifyPipeProof — entradas inválidas devolvem false (nunca lança)", () => {
  it("token, nonces ou role inválidos", () => {
    const prova = makePipeProof(TOKEN, "server", NONCE_C, NONCE_S);
    const casos = [
      [TOKEN.toUpperCase(), "server", NONCE_C, NONCE_S, prova],
      [TOKEN.slice(0, 63), "server", NONCE_C, NONCE_S, prova],
      ["", "server", NONCE_C, NONCE_S, prova],
      [null, "server", NONCE_C, NONCE_S, prova],
      [undefined, "server", NONCE_C, NONCE_S, prova],
      [123, "server", NONCE_C, NONCE_S, prova],
      [TOKEN, "Server", NONCE_C, NONCE_S, prova],
      [TOKEN, "admin", NONCE_C, NONCE_S, prova],
      [TOKEN, "", NONCE_C, NONCE_S, prova],
      [TOKEN, null, NONCE_C, NONCE_S, prova],
      [TOKEN, undefined, NONCE_C, NONCE_S, prova],
      [TOKEN, "server", NONCE_C.toUpperCase(), NONCE_S, prova],
      [TOKEN, "server", NONCE_C.slice(0, 63), NONCE_S, prova],
      [TOKEN, "server", null, NONCE_S, prova],
      [TOKEN, "server", NONCE_C, "", prova],
      [TOKEN, "server", NONCE_C, undefined, prova],
    ];
    for (const args of casos) {
      assert.equal(verifyPipeProof(...args), false);
    }
  });
});

describe("makePipeProof — rejeita entradas inválidas sem ecoar valores", () => {
  const tokenMau = "C".repeat(64); // maiúsculas
  const nonceMau = "Z".repeat(64);
  const roleMau = "Server";

  it("lança TypeError", () => {
    const casos = [
      [tokenMau, "server", NONCE_C, NONCE_S],
      [TOKEN.slice(0, 63), "server", NONCE_C, NONCE_S],
      ["", "server", NONCE_C, NONCE_S],
      [null, "server", NONCE_C, NONCE_S],
      [TOKEN, roleMau, NONCE_C, NONCE_S],
      [TOKEN, "admin", NONCE_C, NONCE_S],
      [TOKEN, "", NONCE_C, NONCE_S],
      [TOKEN, "server", nonceMau, NONCE_S],
      [TOKEN, "server", NONCE_C, nonceMau],
      [TOKEN, "server", NONCE_C.slice(0, 63), NONCE_S],
      [TOKEN, "server", NONCE_C, null],
    ];
    for (const args of casos) {
      assert.throws(() => makePipeProof(...args), TypeError);
    }
  });

  it("a mensagem de erro não contém token, nonce nem role recebidos", () => {
    const casos = [
      [tokenMau, "server", NONCE_C, NONCE_S],
      [TOKEN, roleMau, NONCE_C, NONCE_S],
      [TOKEN, "server", nonceMau, NONCE_S],
      [TOKEN, "server", NONCE_C, nonceMau],
    ];
    for (const args of casos) {
      let mensagem = "";
      try {
        makePipeProof(...args);
        assert.fail("deveria lançar");
      } catch (erro) {
        assert.equal(erro instanceof TypeError, true);
        mensagem = String(erro.message);
      }
      for (const valor of args) {
        if (typeof valor !== "string" || valor.length < 8) continue;
        assert.equal(mensagem.includes(valor), false, "a mensagem não pode ecoar o valor recebido");
      }
      // também não pode conter o token válido usado noutras chamadas
      assert.equal(mensagem.includes(TOKEN), false);
    }
  });
});

describe("sem estado partilhado entre chamadas", () => {
  it("verify não altera o resultado de chamadas seguintes", () => {
    const prova = makePipeProof(TOKEN, "client", NONCE_C, NONCE_S);
    assert.equal(verifyPipeProof(TOKEN, "client", NONCE_C, NONCE_S, prova), true);
    assert.equal(verifyPipeProof(TOKEN, "client", NONCE_C, NONCE_S, "0".repeat(64)), false);
    assert.equal(verifyPipeProof(TOKEN, "client", NONCE_C, NONCE_S, prova), true);
    assert.equal(makePipeProof(TOKEN, "client", NONCE_C, NONCE_S), prova);
  });
});
