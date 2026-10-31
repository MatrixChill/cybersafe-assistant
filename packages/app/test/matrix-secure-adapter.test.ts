/**
 * TP-MATRIX-UI-SECURE-ADAPTER-20261024 — o adaptador seguro fala em
 * `provider_unavailable` (5xx do fornecedor) e `provider_rejected` (4xx que o
 * fornecedor recusou). Nenhum dos dois existia na máquina de estado: caíam os
 * dois em «desconhecido», e a UI tratava-os como falha de rede — repetia um
 * pedido que o fornecedor já tinha recusado, e dizia «não foi possível
 * contactar» quando a verdade era «o fornecedor está em baixo» ou «recusou».
 *
 * Estes testes fixam a separação que o gate humano exige:
 *  - 5xx → indisponível (o fornecedor não está a servir; tentar mais tarde);
 *  - 4xx → recusado PELO FORNECEDOR (estável; repetir o mesmo não resolve) e
 *    sem a frase «nada foi enviado», que só é verdade para recusas pré-envio;
 *  - em nenhum dos casos a mensagem pode aparecer como resposta da IA.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CODIGOS_INDISPONIVEIS,
  CODIGOS_RECUPERAVEIS,
  classeDeErro,
  codigoDeStatusHttp,
  estadoDoPedido,
  matrixStateLabel,
  mensagemDeRecusaDoFornecedor,
  bloqueioDeConsentimentoAplica,
  revalidarAntesDoEnvio,
  traceDePedido,
} from "../src/lib/matrixRequestMachine.ts";
import { estadoDoResultado, originDaResposta } from "../src/lib/matrixConversation.ts";

describe("adaptador seguro — classificação de códigos", () => {
  test("provider_unavailable é indisponibilidade do fornecedor, não falha de rede", () => {
    assert.equal(classeDeErro("provider_unavailable"), "indisponivel");
    assert.ok((CODIGOS_INDISPONIVEIS as readonly string[]).includes("provider_unavailable"));
    assert.equal((CODIGOS_RECUPERAVEIS as readonly string[]).includes("provider_unavailable"), false);
  });

  test("provider_rejected é uma recusa estável", () => {
    assert.equal(classeDeErro("provider_rejected"), "recusado");
  });

  test("estado final: 5xx indisponível, 4xx recusado sem culpar a rede", () => {
    assert.equal(estadoDoPedido({ motivo: null, pediuProvider: true, ok: false, code: "provider_unavailable" }), "indisponivel");
    assert.equal(estadoDoPedido({ motivo: null, pediuProvider: true, ok: false, code: "provider_rejected" }), "recusado-pelo-fornecedor");
  });

  test("o rótulo do fornecedor não diz «nada foi enviado»", () => {
    const rotulo = matrixStateLabel("recusado-pelo-fornecedor") ?? "";
    assert.match(rotulo, /recebeu o pedido/i, "o pedido saiu da máquina: o rótulo tem de o dizer");
    assert.match(rotulo, /recusou/i);
    assert.doesNotMatch(rotulo, /nada foi enviado/i, "o pedido chegou ao fornecedor e foi ele que o recusou");
    assert.equal(matrixStateLabel("pedido-recusado"), "Pedido recusado — nada foi enviado ao fornecedor");
  });

  test("nenhum destes estados é apresentado como resposta da IA", () => {
    assert.equal(originDaResposta({ pediuProvider: true, ok: false, code: "provider_unavailable" }), "local");
    assert.equal(originDaResposta({ pediuProvider: true, ok: false, code: "provider_rejected" }), "local");
    assert.equal(estadoDoResultado({ motivo: null, pediuProvider: true, ok: false, code: "provider_unavailable" }), "indisponivel");
    assert.equal(estadoDoResultado({ motivo: null, pediuProvider: true, ok: false, code: "provider_rejected" }), "recusado-pelo-fornecedor");
  });

  test("o trace só aceita códigos conhecidos (5xx e recusa deixam de sair como desconhecido)", () => {
    assert.match(traceDePedido({ errorCode: "provider_unavailable" }), /errorCode=provider_unavailable/);
    assert.match(traceDePedido({ errorCode: "provider_rejected" }), /errorCode=provider_rejected/);
  });
});

describe("recusa ANTES do envio vs recusa DEPOIS do envio", () => {
  test("são estados e rótulos diferentes, e só o pré-envio faz uma alegação de privacidade", () => {
    const preEnvio = matrixStateLabel("pedido-recusado") ?? "";
    const posEnvio = matrixStateLabel("recusado-pelo-fornecedor") ?? "";
    assert.notEqual(preEnvio, posEnvio);
    assert.match(preEnvio, /nada foi enviado/i, "a recusa do NOSSO serviço acontece antes de sair da máquina");
    assert.doesNotMatch(posEnvio, /nada foi enviado/i, "o fornecedor recebeu o pedido; dizer o contrário seria falso");
    assert.doesNotMatch(posEnvio, /local|diagnóstico/i, "não é um diagnóstico local nem uma resposta da IA");
  });

  test("a mensagem do fornecedor assume o envio e não promete privacidade", () => {
    const propria = mensagemDeRecusaDoFornecedor();
    assert.match(propria, /recebeu o pedido/i);
    assert.match(propria, /recusou/i);
    assert.doesNotMatch(propria, /nada foi enviado|não saiu da máquina|ficou em casa/i);

    const doServico = mensagemDeRecusaDoFornecedor("O modelo recusou o conteúdo.");
    assert.equal(doServico, "O modelo recusou o conteúdo.", "a mensagem do serviço é usada tal como veio");
    assert.equal(mensagemDeRecusaDoFornecedor("   "), propria, "mensagem vazia não vira alegação nenhuma");
  });

  test("a MATRIX usa a mensagem de recusa do fornecedor, não a de pré-envio", () => {
    const ai = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");
    const uso = ai.indexOf("mensagemDeRecusaDoFornecedor(result.message)");
    assert.ok(uso > 0, "a mensagem da recusa do fornecedor tem de vir da função própria");
    const trecho = ai.slice(Math.max(0, uso - 160), uso + 160);
    assert.match(trecho, /provider_rejected/, "o uso é no ramo do fornecedor");
    assert.doesNotMatch(trecho, /Nada foi enviado ao fornecedor/, "essa frase é da recusa pré-envio");
  });
});

describe("adaptador seguro — status HTTP sem código no corpo", () => {
  test("5xx do fornecedor viram provider_unavailable", () => {
    for (const status of [500, 502, 520, 522, 524, 529]) {
      assert.equal(codigoDeStatusHttp(status), "provider_unavailable", String(status));
    }
  });

  test("4xx não classificados são recusa estável, nunca falha de rede", () => {
    for (const status of [409, 410, 413, 422, 451]) {
      assert.equal(codigoDeStatusHttp(status), "invalid_request", String(status));
    }
  });

  test("os códigos já mapeados não mudam de significado", () => {
    assert.equal(codigoDeStatusHttp(400), "invalid_request");
    assert.equal(codigoDeStatusHttp(401), "auth");
    assert.equal(codigoDeStatusHttp(403), "auth");
    assert.equal(codigoDeStatusHttp(404), "model_unavailable");
    assert.equal(codigoDeStatusHttp(408), "timeout");
    assert.equal(codigoDeStatusHttp(429), "rate_limited");
    assert.equal(codigoDeStatusHttp(503), "no_provider");
    assert.equal(codigoDeStatusHttp(504), "timeout");
    assert.equal(codigoDeStatusHttp(200), undefined);
  });
});

describe("guarda de envio — consentimento e identidade", () => {
  test("o bloqueio de telemetria não fecha o chat geral", () => {
    assert.equal(bloqueioDeConsentimentoAplica(true, true), true, "pedido com medições fica bloqueado");
    assert.equal(bloqueioDeConsentimentoAplica(true, false), false, "chat geral não leva telemetria: continua utilizável");
    assert.equal(bloqueioDeConsentimentoAplica(false, true), false);
    assert.equal(bloqueioDeConsentimentoAplica(false, false), false);
  });

  const base = {
    anexarContexto: true,
    bloqueado: false,
    abortado: false,
    vigente: true,
    contaActual: "user_1",
    contaDoPedido: "user_1",
  } as const;

  test("pedido privado segue só com abort/vigência/bloqueio/conta coerentes", () => {
    assert.deepEqual(revalidarAntesDoEnvio({ ...base }), { enviar: true });
  });

  test("abort e pedido substituído param antes do fetch", () => {
    const abortado = revalidarAntesDoEnvio({ ...base, abortado: true });
    assert.equal(abortado.enviar, false);
    if (!abortado.enviar) assert.equal(abortado.code, "aborted");

    const substituido = revalidarAntesDoEnvio({ ...base, vigente: false });
    assert.equal(substituido.enviar, false);
    if (!substituido.enviar) assert.equal(substituido.code, "pedido_substituido");
  });

  test("revogação pendente bloqueia o privado e nunca o geral", () => {
    const privado = revalidarAntesDoEnvio({ ...base, bloqueado: true });
    assert.equal(privado.enviar, false);
    if (!privado.enviar) {
      assert.equal(privado.code, "process_consent_grant_invalid");
      assert.match(privado.message, /Nada foi enviado/i);
    }

    assert.deepEqual(revalidarAntesDoEnvio({ ...base, anexarContexto: false, bloqueado: true }), { enviar: true });
  });

  test("sem sessão ou com conta trocada a meio do GET, o privado não sai", () => {
    const semSessao = revalidarAntesDoEnvio({ ...base, contaActual: null });
    assert.equal(semSessao.enviar, false);
    if (!semSessao.enviar) assert.equal(semSessao.code, "process_consent_grant_invalid");

    const trocada = revalidarAntesDoEnvio({ ...base, contaActual: "user_2" });
    assert.equal(trocada.enviar, false);
    if (!trocada.enviar) {
      assert.equal(trocada.code, "process_consent_grant_invalid");
      assert.match(trocada.message, /Nada foi enviado/i);
    }

    // Sem medições, uma troca de conta não impede uma pergunta geral.
    assert.deepEqual(revalidarAntesDoEnvio({ ...base, anexarContexto: false, contaActual: null }), { enviar: true });
  });
});

describe("adaptador seguro — cablagem na MATRIX", () => {
  const ai = readFileSync(new URL("../src/components/AIAssistant.tsx", import.meta.url), "utf8");

  test("4xx do fornecedor não entra no ciclo de retries", () => {
    const inicioRecusa = ai.indexOf("result.code === \"credential_blocked\"");
    assert.ok(inicioRecusa > 0, "a lista de recusas estáveis mudou de forma");
    const bloco = ai.slice(inicioRecusa, inicioRecusa + 400);
    assert.match(bloco, /provider_rejected/, "sem isto o 4xx cai no retry e vira «erro de rede»");
    assert.match(ai, /\"recusado-pelo-fornecedor\" as const/);
  });

  test("5xx do fornecedor é indisponibilidade, com texto de tentar de novo", () => {
    const inicioIndisponivel = ai.indexOf("result.code === \"no_provider\"");
    assert.ok(inicioIndisponivel > 0, "o ramo de indisponibilidade mudou de forma");
    const bloco = ai.slice(inicioIndisponivel, inicioIndisponivel + 300);
    assert.match(bloco, /provider_unavailable/);
  });

  test("a MATRIX revalida depois do GET e antes de cada fetch", () => {
    assert.match(ai, /bloqueioDeConsentimentoAplica\(consentimentoBloqueadoRef\.current, anexarContexto\)/);
    const chamadas = (ai.match(/revalidarAntesDoEnvio\(/g) ?? []).length;
    assert.ok(chamadas >= 2, `esperava revalidação depois do GET e antes do fetch; encontrei ${chamadas}`);
    assert.match(ai, /contaIdRef\.current/, "a conta vem da sessão actual, não do grant");
    assert.doesNotMatch(ai, /validado\.grant\?\.userId/, "não se valida o dono com o próprio grant");
    assert.match(ai, /decidirConsentimentoDeEnvio\(validado, modoDoEnvio \?\? \"persistente\", contaIdRef\.current/);
  });

  test("o chat geral continua sem consentimento de processo nem telemetria", () => {
    assert.doesNotMatch(ai, /camposDeConsentimentoNoChat/);
    assert.match(ai, /processPayload\(/);
    assert.match(ai, /anexarContexto \? processContext : null/);
  });
});
