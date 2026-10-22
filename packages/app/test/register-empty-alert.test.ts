import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { AuthProvider } = await import("../src/contexts/AuthContext");
const RegisterPage = (await import("../src/pages/RegisterPage")).default;

test("o registo inicial não apresenta uma faixa de erro vazia nem erros inventados", () => {
  const html = renderToStaticMarkup(
    React.createElement(AuthProvider, null,
      React.createElement(RegisterPage, { onSwitchToLogin: () => {} })),
  );
  assert.match(html, /Criar conta/);
  assert.match(html, /register-email/);
  assert.doesNotMatch(html, /class="auth-error"/);
  assert.doesNotMatch(html, /Algo correu mal ao criar a conta|Precisa de indicar um email/);
});
