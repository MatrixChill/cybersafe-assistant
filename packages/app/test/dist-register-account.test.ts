import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * DIST-REGISTER (13/10) — a conta que se cria neste produto.
 *
 * Testa comportamento, não texto de catálogo:
 *  - o que **sai** da máquina quando alguém se registra (`corpoDeRegisto`);
 *  - o que a validação **decide** face a entradas reais (todos os inválidos de
 *    uma vez, e as mesmas condições da API, para o ecrã não recusar o que o
 *    servidor aceitaria);
 *  - o que um estado HTTP **virou frase de ecrã**, incluindo o caso em que a
 *    API leva `error: String(error)` no corpo e isso nunca pode aparecer aqui;
 *  - o markup do formulário no arranque: pessoal por defeito, sem preços, sem
 *    botão silenciosamente desativado, e com a relação label→campo→mensagem
 *    realmente resolvida por id (não basta existir `aria-describedby`: o alvo
 *    tem de estar na página).
 *
 * `AuthProvider` é o wrapper mínimo honesto: o `useAuth` da página atira sem
 * contexto, e em SSR o efeito de arranque não corre — não é preciso fingir rede.
 */

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { AuthProvider, corpoDeRegisto, mensagemDeFalhaDeAutenticacao, FALHA_DE_LIGACAO } =
  await import("../src/contexts/AuthContext");
const RegisterPage = (await import("../src/pages/RegisterPage")).default;
const { validarRegisto, primeiroCampoInvalido } = await import("../src/pages/RegisterPage");
const { getUserFeatures, canUserAccess, FEATURES, PLANS } = await import("../src/lib/featureControl");
import type { AccountType } from "../src/lib/featureControl";

const pessoal = {
  name: "Ana Sousa",
  email: "ana@exemplo.pt",
  password: "segura123",
  confirmPassword: "segura123",
  accountType: "personal" as AccountType,
  companyName: "",
};

describe("DIST-REGISTER — o que sai no POST /auth/register", () => {
  test("o corpo não escolhe plano nem role", () => {
    const corpo = corpoDeRegisto({
      name: "Ana Sousa", email: "ana@exemplo.pt", password: "segura123",
      type: "personal", plan: "premium" as never,
    } as never);
    assert.equal("plan" in corpo, false, "o register público voltou a levar plano");
    assert.equal("role" in corpo, false, "o register público voltou a levar role");
    assert.deepEqual(Object.keys(corpo).sort(), ["company", "email", "name", "password", "type"]);
  });

  test("empresa leva dados de empresa; pessoal não leva company inventada", () => {
    const business = corpoDeRegisto({
      name: "Rui", email: "rui@empresa.pt", password: "segura123", type: "business",
      company: { name: "TechCorp Lda.", size: "11-50" },
    });
    assert.deepEqual(business.company, { name: "TechCorp Lda.", size: "11-50" });

    const personal = corpoDeRegisto({
      name: "Rui", email: "rui@exemplo.pt", password: "segura123", type: "personal",
      company: { name: "Nome que a pessoa não deu" },
    });
    assert.equal(personal.company, undefined, "conta pessoal com empresa no corpo");
  });
});

describe("DIST-REGISTER — validação com entradas reais", () => {
  test("válida em pessoal: nenhum erro", () => {
    assert.deepEqual(validarRegisto(pessoal), {});
  });

  test("três campos errados de uma vez, não o primeiro", () => {
    const erros = validarRegisto({
      name: "   ", email: "não-é-email", password: "123",
      confirmPassword: "456", accountType: "personal", companyName: "",
    });
    assert.ok(erros.name, "nome só em espaços não foi assinalado");
    assert.ok(erros.email, "formato de email não foi assinalado");
    assert.ok(erros.password, "palavra-passe curta não foi assinalada");
    assert.match(erros.password ?? "", /não coincidem/, "a confirmação deixou de ser dita na mesma frase");
  });

  test("as condições são as da API (api/src/index.ts:312-341)", () => {
    // 6 caracteres é o limite da API: 5 recusa, 6 aceita.
    assert.ok(validarRegisto({ ...pessoal, password: "12345", confirmPassword: "12345" }).password);
    assert.equal(validarRegisto({ ...pessoal, password: "123456", confirmPassword: "123456" }).password, undefined);
    // O regex do email é o mesmo, incluindo o TLD com ponto.
    assert.ok(validarRegisto({ ...pessoal, email: "a@b" }).email);
    assert.equal(validarRegisto({ ...pessoal, email: "a@b.pt" }).email, undefined);
  });

  test("empresa exige nome; pessoal não exige", () => {
    assert.ok(validarRegisto({ ...pessoal, accountType: "business", companyName: "  " }).company);
    assert.equal(validarRegisto({ ...pessoal, accountType: "business", companyName: "TechCorp Lda." }).company, undefined);
  });

  test("o foco vai para o primeiro campo inválido, na ordem do formulário", () => {
    assert.equal(primeiroCampoInvalido({ company: "x", email: "y", password: "z" }), "email");
    assert.equal(primeiroCampoInvalido({ company: "x" }), "company");
    assert.equal(primeiroCampoInvalido({}), null);
  });
});

describe("DIST-REGISTER — clareza das falhas da API, sem eco", () => {
  test("409 é dito como email, e aponta o campo email", () => {
    const falha = mensagemDeFalhaDeAutenticacao(409, { message: "Este email já está registado." });
    assert.equal(falha.campo, "email");
    assert.match(falha.error, /email/i);
    assert.match(falha.error, /Inicia sessão|outro email/, "não diz o que fazer a seguir");
  });

  test("400 de senha vem traduzido para pt-PT e no campo certo", () => {
    const falha = mensagemDeFalhaDeAutenticacao(400, { message: "A senha deve ter pelo menos 6 caracteres." });
    assert.equal(falha.campo, "password");
    assert.match(falha.error, /palavra-passe/);
    assert.equal(/senha/.test(falha.error), false, "pt-BR no ecrã");
  });

  test("500 NUNCA ecoa o corpo extra: a API leva `error: String(error)`", () => {
    const segredo = "ERR stack C:\\Users\\caioc\\projetos token=eyJhbGciOi JWT_SECRET=abc123";
    const falha = mensagemDeFalhaDeAutenticacao(500, {
      message: "Erro interno ao criar conta.",
      error: segredo,
    });
    for (const parte of ["Users", "caioc", "token", "JWT_SECRET", "eyJ"]) {
      assert.equal(falha.error.includes(parte), false, `eco do servidor no ecrã: ${parte}`);
    }
    assert.match(falha.error, /estado 500/, "não diz o estado, e por isso não é verificável");
    assert.match(falha.error, /não foi confirmado/i, "afirma ou nega a criação sem prova");
  });

  test("cada estado tem a sua frase; nada é «erro genérico» silencioso", () => {
    const falha401 = mensagemDeFalhaDeAutenticacao(401, null);
    assert.equal(falha401.campo, "password", "401 de credenciais vai para o campo errado");
    assert.match(falha401.error, /palavra-passe/);

    const falha403 = mensagemDeFalhaDeAutenticacao(403, null);
    assert.equal(falha403.campo, "geral");
    assert.match(falha403.error, /permissão/);

    const falha503 = mensagemDeFalhaDeAutenticacao(503, null);
    assert.equal(falha503.campo, "geral");
    assert.match(falha503.error, /503/);

    // Estado que a API não usa hoje: tem de se dizer o número, não disfarçar.
    const falha418 = mensagemDeFalhaDeAutenticacao(418, null);
    assert.equal(falha418.campo, "geral");
    assert.match(falha418.error, /418/, "estado inesperado sem número");

    // 400 escolhe o campo pela mensagem da API (a frase é sempre pt-PT).
    assert.equal(mensagemDeFalhaDeAutenticacao(400, { message: "Formato de email inválido." }).campo, "email");
    assert.equal(mensagemDeFalhaDeAutenticacao(400, { message: "A senha deve ter pelo menos 6 caracteres." }).campo, "password");
    assert.equal(mensagemDeFalhaDeAutenticacao(400, { message: "Nome da empresa é obrigatório." }).campo, "company");
    assert.equal(mensagemDeFalhaDeAutenticacao(400, { message: "Tipo de conta inválido." }).campo, "type");
    assert.equal(mensagemDeFalhaDeAutenticacao(400, null).campo, "geral", "400 sem mensagem ficou cega");
  });

  test("sem ligação não se disfarça de recusa", () => {
    assert.match(FALHA_DE_LIGACAO.error, /não respondeu/);
    assert.equal(/não existe|falhou a criação/.test(FALHA_DE_LIGACAO.error), false,
      "afirma o resultado de um pedido que não se sabe se chegou");
  });
});

describe("DIST-REGISTER — o formulário no arranque (SSR)", () => {
  const html = renderToStaticMarkup(createElement(AuthProvider, null,
    createElement(RegisterPage, { onSwitchToLogin: () => {} })));
  const texto = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  test("pessoal é o estado visível por defeito", () => {
    assert.match(html, /aria-pressed="true"[^>]*>\s*<div class="auth-type-card-icon">\s*<svg[^>]*>.*?<\/svg>\s*<\/div>\s*<div class="auth-type-card-content">\s*<span class="auth-type-card-title">Pessoal/s,
      "o arranque não mostra uma opção activa");
    assert.equal(html.includes("aria-pressed=\"false\""), true, "a outra opção não está marcada como não escolhida");
  });

  test("não há planos à venda: nenhum controlo escolhe plano, nenhum preço na página", () => {
    // Proibir palavras no texto todo era fraco (a nota explica que não há
    // pagamentos — e diz «checkout»). O que se proíbe é comportamento de venda:
    // preço, mensalidade, e um botão que escolha plano.
    assert.equal(/R\$\s?\d/.test(texto), false, "preço em reais de volta ao registo");
    assert.equal(/\d+[.,]\d{2}\s*\/\s*mês/.test(texto), false, "mensalidade de volta ao registo");
    assert.equal(/\b€\s?\d/.test(texto), false, "preço em euros de volta ao registo");
    const rotulos = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    for (const rotulo of rotulos) {
      assert.equal(/^(Free|Personal Pro|Business Pro|Personal Premium|Business Premium|Pro|Premium)$/.test(rotulo), false,
        `voltou o seletor de plano: «${rotulo}»`);
      assert.equal(/R\$|\d+[.,]\d{2}/.test(rotulo), false, `botão com preço: «${rotulo}»`);
    }
    assert.match(texto, /gratuito/);
    assert.match(texto, /não tem pagamentos/, "a nota sobre a ausência de pagamento desapareceu");
    assert.equal((html.match(/aria-pressed=/g) ?? []).length, 2,
      "mais controlos escolhíveis do que os dois tipos de conta");
  });

  test("o submit não está silenciosamente desativado e diz o que faz", () => {
    assert.equal(/<button type="submit"[^>]*disabled/.test(html), false, "botão morto no arranque");
    assert.match(html, /<button type="submit"[^>]*class="auth-submit"/);
    assert.match(texto, /Criar conta/);
  });

  test("há uma zona de estado anunciada", () => {
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /aria-busy="false"/, "o formulário não declara quando está ocupado");
  });

  test("cada `aria-describedby` aponta para um id que existe na página", () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const descritos = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(descritos.length >= 1, "nada está ligado a uma descrição");
    for (const alvo of descritos) {
      assert.ok(ids.has(alvo), `aria-describedby aponta para ${alvo}, que não existe`);
    }
    for (const campo of ["register-name", "register-email", "register-password", "register-confirm-password"]) {
      assert.ok(ids.has(campo), `falta o id do campo ${campo}`);
      assert.ok(html.includes(`for="${campo}"`), `${campo} não tem <label for>`);
    }
  });

  test("pt-PT em todo o ecrã", () => {
    for (const br of ["Senha", "senha", "Seu ", "seu nome", "Você", "você", "usuário", "Confirmar Senha", "Tente"]) {
      assert.equal(texto.includes(br), false, `pt-BR no ecrã de registo: ${br}`);
    }
    assert.match(texto, /Palavra-passe|palavra-passe/);
  });
});

describe("DIST-REGISTER — nenhuma funcionalidade existente foi eliminada", () => {
  test("contas com plano atribuído mantêm os seus entitlements", () => {
    // O registo passou a não escolher plano; os planos continuam a existir para as
    // contas a quem a autoridade os atribuiu. E a porta do Centro de Segurança é do
    // TIPO de conta, não do plano — é  que o decide.
    assert.ok(PLANS.pro.features.includes(FEATURES.SCANNER_DEEP));
    assert.ok(getUserFeatures("personal", "premium").includes(FEATURES.REPORTS_EXPORT));
    assert.ok(getUserFeatures("personal", "free").includes(FEATURES.SCANNER));
    assert.equal(getUserFeatures("personal", "free").includes(FEATURES.SCANNER_DEEP), false);
    assert.equal(canUserAccess(FEATURES.BUSINESS_SECURITY_CENTER, { type: "business", plan: "free", role: "user" }), true,
      "a conta de empresa perdeu o centro que sempre teve");
    assert.equal(canUserAccess(FEATURES.BUSINESS_SECURITY_CENTER, { type: "personal", plan: "free", role: "user" }), false,
      "o registo gratuito passou a abrir o que era de empresa");
    assert.equal(canUserAccess(FEATURES.SCANNER_DEEP, { type: "personal", plan: "pro", role: "user" }), true,
      "conta Pro existente perdeu o que tinha");
  });
});
