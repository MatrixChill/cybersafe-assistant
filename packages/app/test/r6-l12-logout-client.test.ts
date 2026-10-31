import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// R6-L12 — integração mínima do cliente com a revogação de token do servidor.
//
// O servidor passou a expor `POST /auth/logout` (autenticado, revoga por
// fingerprint). Sem o cliente o invocar, o endpoint fica inerte: o logout da UI
// só limpava o token local e um JWT capturado continuava válido. Este teste fixa
// o contrato do lado do cliente (asserção sobre a fonte, como as restantes
// asserções de wiring da app), para impedir que a chamada desapareça em silêncio.
//
// O comportamento real do endpoint é provado no lado da API
// (packages/api/test/r6-l12-logout.test.js, 9/9).

const source = readFileSync(new URL("../src/contexts/AuthContext.tsx", import.meta.url), "utf8");

test("o logout avisa o servidor para revogar o token", () => {
  assert.match(source, /fetch\(`\$\{API_BASE\}\/auth\/logout`/, "o logout tem de chamar POST /auth/logout");
  assert.match(source, /method:\s*"POST"/, "o pedido de logout tem de ser POST");
});

test("a chamada leva o token em Bearer, capturado ANTES de ser removido", () => {
  assert.match(source, /Authorization:\s*`Bearer \$\{token\}`/, "o logout tem de enviar o token em Bearer");
  // A remoção local tem de acontecer depois de o token ser lido para a chamada.
  const readIndex = source.indexOf("const token = getAuthToken()");
  const removeIndex = source.indexOf("void clearAuthSession()");
  assert.ok(readIndex !== -1, "o logout tem de ler o token");
  assert.ok(removeIndex !== -1, "o logout tem de remover o token local");
  assert.ok(readIndex < removeIndex, "o token tem de ser lido antes de ser removido");
});

test("o logout continua síncrono e não bloqueia a UI na rede", () => {
  const logoutBody = source.slice(source.indexOf("const logout = useCallback"));
  assert.match(logoutBody, /\}\)\.catch\(\(\)\s*=>\s*\{/, "a chamada tem de ser best-effort (com catch)");
  // Nada de `await` dentro do logout: a saída do utilizador não espera pela API.
  const bodyUntilEnd = logoutBody.slice(0, logoutBody.indexOf("}, []);"));
  assert.doesNotMatch(bodyUntilEnd, /\bawait\b/, "o logout não deve esperar pela rede");
  assert.doesNotMatch(bodyUntilEnd, /\basync\b/, "o logout mantém-se síncrono (assinatura () => void)");
});
