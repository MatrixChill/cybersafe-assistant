#!/usr/bin/env node
/**
 * dev-isolated-auth-probe.mjs — TP-REAL-AUTH-NAV (owner=qoder).
 *
 * Sonda de AUTENTICAÇÃO isolada contra a API do runner (por omissão
 * http://127.0.0.1:4000). Percorre a rota NORMAL register → /me → logout →
 * /me(401) → login → /me com uma conta SINTÉTICA dedicada (.invalid) e
 * credencial EFÉMERA gerada em memória.
 *
 * Segurança de dados:
 *   - NÃO imprime nem persiste o token, a password, nem o email identificável.
 *   - O email é gerado aleatório com domínio `.invalid` (RFC 2606, nunca
 *     entregável) — não é pessoal e não é ecoado.
 *   - Só emite um resumo estruturado de STATUS HTTP e booleanos por camada.
 *   - Se o fluxo exigir email externo / segredo / provedor indisponível, reporta
 *     o BLOQUEIO e NÃO envia correio nem faz rede externa para além do loopback.
 *
 * Nenhuma dependência nova; usa `fetch` global do Node. Loopback apenas.
 */
import { randomBytes, randomUUID } from "node:crypto";

const BASE = (process.env.PROBE_BASE || "http://127.0.0.1:4000").replace(/\/$/, "");

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

const out = { base: BASE, steps: {}, overall: "UNKNOWN" };
function record(name, ok, detail) { out.steps[name] = { ok, ...detail }; }

async function main() {
  // 0) health — confirma que é a API cybersafe (contrato index.ts:577).
  const health = await req("GET", "/health");
  const healthOk = health.status === 200 && health.json?.status === "ok" && health.json?.service === "cybersafe-api";
  record("health", healthOk, { status: health.status });
  if (!healthOk) { out.overall = "BLOCKED:api-not-ready"; return; }

  // credenciais sintéticas efémeras (nunca impressas).
  const email = `auth-probe-${randomUUID()}@auth-probe.invalid`;
  const password = randomBytes(18).toString("hex");
  const name = "Sonda Auth";

  // 1) register (rota normal; o backend NÃO envia email nem exige verified).
  const reg = await req("POST", "/auth/register", { body: { name, email, password, type: "personal" } });
  const regToken = reg.json?.token;
  record("register", reg.status === 201 && !!regToken, { status: reg.status, gotToken: !!regToken });
  if (reg.status === 500 && /email|smtp|provider|verif/i.test(reg.json?.message || "")) { out.overall = "BLOCKED:external-email-required"; return; }
  if (!regToken) { out.overall = "FAIL:register"; return; }

  // 2) /me com o token do registo → deve devolver o MESMO utilizador.
  const me1 = await req("GET", "/auth/me", { token: regToken });
  const meMatches = me1.status === 200 && me1.json?.user?.email === email;
  record("me_authenticated", me1.status === 200, { status: me1.status, emailMatches: meMatches });

  // 3) logout → 204.
  const logout = await req("POST", "/auth/logout", { token: regToken });
  record("logout", logout.status === 204, { status: logout.status });

  // 4) /me com o MESMO token após logout → 401 (token revogado).
  const meAfter = await req("GET", "/auth/me", { token: regToken });
  record("me_after_logout_401", meAfter.status === 401, { status: meAfter.status });

  // 5) login com as mesmas credenciais → novo token (prova que a password ficou
  //    corretamente guardada/verificável na DB isolada).
  const login = await req("POST", "/auth/login", { body: { email, password } });
  const loginToken = login.json?.token;
  record("login", login.status === 200 && !!loginToken, { status: login.status, gotToken: !!loginToken });
  if (loginToken) {
    const me2 = await req("GET", "/auth/me", { token: loginToken });
    record("me_after_login", me2.status === 200 && me2.json?.user?.email === email, { status: me2.status });
    await req("POST", "/auth/logout", { token: loginToken }); // limpa a sessão de teste
  }

  // login com password errada → 401 (não aceita credencial errada).
  const badLogin = await req("POST", "/auth/login", { body: { email, password: password + "x" } });
  record("login_wrong_password_401", badLogin.status === 401, { status: badLogin.status });

  const allOk = Object.values(out.steps).every((s) => s.ok);
  out.overall = allOk ? "PASS" : "FAIL:see-steps";
  // NUNCA imprimir email/password/token.
  console.log(JSON.stringify(out, null, 2));
}

main().then(() => process.exit(out.overall === "PASS" ? 0 : 1)).catch((e) => { console.error("probe error:", e.message); process.exit(2); });
