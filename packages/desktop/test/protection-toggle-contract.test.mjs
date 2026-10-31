import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  interpretProtectionToggle,
  motivoDaRejeicao,
  protectionFailToast,
  requestProtectionToggle,
} from "../src/protection-toggle-result.ts";

/**
 * P0 CONTRATO (15/10, HIGH-1/HIGH-2 da auditoria independente OpenCode + packet
 * do único Maestro): a ponte do desktop não pode afirmar estado que o serviço
 * não confirmou.
 *
 * O defeito original era uma linha — `protectionEnabled: ... ? ... : true` — que
 * transformava uma resposta INCOMPLETA em "proteção ATIVA". Com um botão de
 * proteção, isso não é um bug de apresentação: é o utilizador a acreditar que a
 * máquina está vigiada quando ninguém o disse.
 *
 * Duplos benignos apenas: nenhum motor, nenhum pipe, nenhuma API do Windows.
 */

const CAUSA_MOTOR = [{ label: "watcher", reason: "Error: acesso negado em C:\\Users\\<utilizador>" }];

describe("monitor.start valido", () => {
  it("ok:true com protectionEnabled booleano real confirma ATIVO e preserva a degradacao", () => {
    const res = interpretProtectionToggle(
      { ok: true, protectionEnabled: true, degraded: [{ label: "wfpFilter", reason: "filtro de rede do CyberSafe não aplicado" }] },
      "start",
    );
    assert.deepEqual(res, {
      ok: true,
      protectionEnabled: true,
      degraded: [{ label: "wfpFilter", reason: "filtro de rede do CyberSafe não aplicado" }],
    });
  });

  it("degradacao malformada e ignorada, nunca inventada", () => {
    const res = interpretProtectionToggle(
      { ok: true, protectionEnabled: true, degraded: [{ label: "wfpFilter" }, null, "x"] },
      "start",
    );
    assert.equal(res.ok, true);
    assert.equal(res.degraded, undefined, "entradas sem label+reason nao podem chegar ao ecra como degradacao");
  });
});

describe("monitor.stop valido", () => {
  it("ok:true com protectionEnabled:false confirma DESLIGADO", () => {
    const res = interpretProtectionToggle({ ok: true, protectionEnabled: false }, "stop");
    assert.equal(res.ok, true);
    assert.equal(res.protectionEnabled, false);
    assert.equal(res.degraded, undefined, "parar nao declara degradacao: o eixo e do arranque");
  });
});

describe("resposta incompleta ou sem resposta: NAO CONFIRMADO (nunca true, nunca OFF inventado)", () => {
  const casos = [
    ["sem protectionEnabled (o caso HIGH-2)", { ok: true }, "start"],
    ["sem ok", { protectionEnabled: true }, "start"],
    ["ok nao booleano", { ok: "true", protectionEnabled: true }, "start"],
    ["protectionEnabled null", { ok: true, protectionEnabled: null }, "start"],
    ["protectionEnabled string", { ok: true, protectionEnabled: "true" }, "start"],
    ["resposta vazia", {}, "start"],
    ["sem resposta (undefined)", undefined, "start"],
    ["resposta nula", null, "stop"],
    ["resposta primitiva", "ok", "stop"],
  ];

  for (const [rotulo, raw, pedido] of casos) {
    it(`${rotulo}: ok:false + protectionEnabled:null`, () => {
      const res = interpretProtectionToggle(raw, pedido);
      assert.equal(res.ok, false, rotulo);
      assert.equal(res.protectionEnabled, null, `${rotulo} — null e "nao confirmado"; true mentiria`);
      assert.equal(typeof res.reason, "string", "tem de haver frase para o toast");
      assert.match(res.reason ?? "", /confirm|completa|resposta|contradit/i, "o motivo tem de dizer o que faltou");
    });
  }

  it("ok:true com estado que CONTRADIZ o pedido tambem nao e confirmacao", () => {
    const startContraditorio = interpretProtectionToggle({ ok: true, protectionEnabled: false }, "start");
    const stopContraditorio = interpretProtectionToggle({ ok: true, protectionEnabled: true }, "stop");
    assert.equal(startContraditorio.protectionEnabled, null);
    assert.equal(stopContraditorio.protectionEnabled, null);
    assert.match(startContraditorio.reason ?? "", /contradit/i);
  });
});

describe("recusa confirmada pelo motor: o estado dele e uma confirmacao, nao uma suposicao", () => {
  it("ok:false com failures[] leva a causa e o protectionEnabled real", () => {
    const res = interpretProtectionToggle({ ok: false, protectionEnabled: false, failures: CAUSA_MOTOR }, "start");
    assert.equal(res.ok, false);
    assert.equal(res.protectionEnabled, false, "aqui o motor desmontou tudo e OFOI: confirmado, nao inventado");
    assert.equal(res.reason, "watcher: Error: acesso negado em C:\\Users\\<utilizador>");
    assert.ok(!res.reason?.includes("caioc"), "o caminho pessoal nao pode chegar ao toast");
  });

  it("ok:false sem failures tem frase honesta de recusa", () => {
    const res = interpretProtectionToggle({ ok: false, protectionEnabled: true }, "start");
    assert.equal(res.ok, false);
    assert.equal(res.protectionEnabled, true, "o motor disse que continua ligado: nao e ao desktop para inventar o contrario");
    assert.match(res.reason ?? "", /recusou/i);
  });
});

describe("toast de falha distingue 'nao confirmou' de 'confirmou que nao'", () => {
  it("sem confirmacao: diz que o ecran e ultima leitura, nao confirmao", () => {
    const t = protectionFailToast("ativar", { ok: false, protectionEnabled: null, reason: "Resposta incompleta de a ativação: faltou `protectionEnabled` booleano." });
    assert.equal(t.title, "Não foi possível ativar a proteção");
    assert.match(t.body, /não confirmou o estado/);
    assert.match(t.body, /última leitura válida/);
    assert.ok(!/continua como estava/.test(t.body), "sem confirmacao nao se pode prometer o estado anterior");
  });

  it("com confirmacao: devolve o estado que o servico confirmou", () => {
    const desligada = protectionFailToast("desativar", { ok: false, protectionEnabled: false });
    assert.match(desligada.body, /proteção desligada/);
    const ligada = protectionFailToast("ativar", { ok: false, protectionEnabled: true, reason: "watcher: indisponível" });
    assert.match(ligada.body, /proteção ligada/);
    assert.match(ligada.body, /watcher: indisponível/, "a causa do motor tem de chegar ao toast");
  });
});

/**
 * P0-B (parecer OpenCode 9.8, 15/10): a auditoria anterior tinha LIDO o `catch`
 * do `main.ts` por regex, sem o executar. Aqui o caminho assíncrono de produção
 * (`requestProtectionToggle`) corre com um `request` injetado — exatamente o que
 * o `main.ts` injeta com o `client.request` real — sem Electron e sem efeitos de
 * arranque. O `main.ts` não tem versão própria da guarda (ver
 * `protection-contract-map.test.mjs`), por isto ser prova do código em uso.
 */
describe("caminho de producao com request injetado: rejeicao NAO e confirmacao", () => {
  const rejeitar = (err) => async () => {
    throw err;
  };

  it("Error com caminho pessoal no meio: ok:false, protectionEnabled:null, motivo seguro", async () => {
    const res = await requestProtectionToggle(
      rejeitar(new Error("pipe fechado ao aceder a C:\\Users\\caioc\\AppData\\Local\\x")),
      true,
    );
    assert.equal(res.ok, false);
    assert.equal(res.protectionEnabled, null, "sem resposta nao ha estado para afirmar");
    assert.ok(!res.reason.includes("caioc"), `o nome do utilizador nao pode sair: ${res.reason}`);
    assert.match(res.reason, /C:\\Users\\<utilizador>/);
    assert.match(res.reason, /O serviço não aceitou o pedido/);
    assert.ok(res.reason.length <= 240, `motivo sem teto: ${res.reason.length}`);
  });

  it("TimeoutError tem frase propria de tempo, nao de falha", async () => {
    const timeout = Object.assign(new Error("a espera expirou"), { name: "TimeoutError" });
    const res = await requestProtectionToggle(rejeitar(timeout), true);
    assert.equal(res.ok, false);
    assert.equal(res.protectionEnabled, null);
    assert.match(res.reason, /não respondeu dentro do tempo previsto/);
    assert.match(res.reason, /TimeoutError/, "o tipo de erro tem de sobreviver no motivo");
  });

  it("rejeicao que nao e Error (string crua) continua nao-confirmada", async () => {
    const res = await requestProtectionToggle(rejeitar("pipe partiu"), false);
    assert.equal(res.ok, false);
    assert.equal(res.protectionEnabled, null);
    assert.match(res.reason, /pipe partiu/);
  });

  it("o erro rejeitado e reencaminhado para o log, nao engolido", async () => {
    const err = new Error("boom");
    const registados = [];
    await requestProtectionToggle(rejeitar(err), true, (e) => registados.push(e));
    assert.deepEqual(registados, [err]);
  });

  it("o pedido vai ao TOPICO certo consoante a acao", async () => {
    const topicos = [];
    const fake = async (cmd) => {
      topicos.push(cmd);
      return { ok: true, protectionEnabled: cmd === "monitor.start" };
    };
    await requestProtectionToggle(fake, true);
    await requestProtectionToggle(fake, false);
    assert.deepEqual(topicos, ["monitor.start", "monitor.stop"]);
  });

  it("resposta valida pelo caminho assincrono: ativação confirmada com degradacao", async () => {
    const res = await requestProtectionToggle(
      async () => ({ ok: true, protectionEnabled: true, degraded: [{ label: "wfpFilter", reason: "filtro de rede do CyberSafe não aplicado" }] }),
      true,
    );
    assert.equal(res.ok, true);
    assert.equal(res.protectionEnabled, true);
    assert.equal(res.degraded?.[0]?.label, "wfpFilter");
  });

  it("resposta INCOMPLETA pelo caminho assincrono: null, nunca true", async () => {
    const res = await requestProtectionToggle(async () => ({ ok: true }), true);
    assert.equal(res.ok, false);
    assert.equal(res.protectionEnabled, null, "era exatamente aqui que o HIGH-2 afirmava ATIVO");
  });

  it("resposta sem payload (undefined) pelo caminho assincrono: null", async () => {
    const res = await requestProtectionToggle(async () => undefined, false);
    assert.equal(res.ok, false);
    assert.equal(res.protectionEnabled, null);
  });
});

describe("motivoDaRejeicao: forma do motivo que chega ao ecra", () => {
  it("colapsa whitespace e mantem teto no comprimento", () => {
    const motivo = motivoDaRejeicao(new Error(`a  b\n c ${"x".repeat(400)}`));
    assert.ok(!/  /.test(motivo), "espaços múltiplos não chegam ao ecrã");
    assert.ok(motivo.length <= 240, `motivo sem teto: ${motivo.length}`);
  });

  it("erro sem mensagem continua a dar frase utilizavel", () => {
    assert.match(motivoDaRejeicao(new Error("")), /não aceitou o pedido/);
  });
});
