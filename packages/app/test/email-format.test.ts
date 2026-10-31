import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";

/**
 * EMAIL-16-10 — o caso `gmail.c` no ecrã de registo.
 *
 * A validação do formulário usa a MESMA função que a API
 * (@cybersafe/shared-types / isValidEmailFormat) para as duas condutas não
 * divergirem outra vez. Este teste fixa entradas reais — subdomínios,
 * `+alias`, TLD completo — e garante que formatos incompletos deixam de
 * passar nos dois lados.
 *
 * Formato válido não é email confirmado: a mensagem do ecrã fala de formato,
 * nunca de verificação.
 */

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { validarRegisto } = await import("../src/pages/RegisterPage");
const { isValidEmailFormat } = await import("@cybersafe/shared-types");

const dados = {
  name: "Ana Sousa",
  email: "",
  password: "segura123",
  confirmPassword: "segura123",
  accountType: "personal" as const,
  companyName: "",
};

describe("EMAIL-16-10 — formato de email no registo (app)", () => {
  const VALIDOS = [
    "ana@exemplo.pt",
    "a+alias@sub.dominio.co.uk",
    "Nome.Sobrenome@GMAIL.com",
    "user@exemplo.xn--p1ai",
  ];

  const INVALIDOS = [
    "caioc@gmail.c",
    "gmail.c",
    "a@gmail",
    "a@.com",
    "a@com.",
    "a..b@x.com",
    ".a@x.com",
    "a.@x.com",
    "a@b..com",
    "a@-b.com",
    "a@b-.com",
    "a b@x.com",
    "a@@x.com",
    "a@x.c0m",
  ];

  for (const email of VALIDOS) {
    test(`formulário aceita ${email}`, () => {
      assert.equal(validarRegisto({ ...dados, email }).email, undefined);
      assert.equal(isValidEmailFormat(email), true);
    });
  }

  for (const email of INVALIDOS) {
    test(`formulário recusa ${JSON.stringify(email)}`, () => {
      assert.equal(
        validarRegisto({ ...dados, email }).email,
        "O formato do email não é válido.",
      );
      assert.equal(isValidEmailFormat(email), false);
    });
  }

  test("a mensagem fala de formato, nunca de confirmação", () => {
    const msg = validarRegisto({ ...dados, email: "caioc@gmail.c" }).email ?? "";
    assert.doesNotMatch(msg, /verificad|confirmad/i);
  });
});
