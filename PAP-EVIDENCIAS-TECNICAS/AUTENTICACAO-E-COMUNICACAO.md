# AUTENTICAÇÃO E COMUNICAÇÃO — CÓDIGO, TESTES E LIMITAÇÕES

> **Código:** `MatrixChill/cybersafe-assistant` @ `212cb64c39f74f547d4ebc6c8bff7cc5bcbcdf56`
> **Natureza:** código inspecionado + testes automatizados em clone isolado + ensaio E2E com base temporária.
> **Segredos:** nenhum valor de segredo, chave, hash de palavra-passe ou token é reproduzido neste documento.

---

## 1. Criação de conta

| Item | Detalhe |
|---|---|
| Rota | `POST /auth/register` — `packages/api/src/index.ts` 444-535 |
| Validação | `name`, `email`, `password`, `type` têm de ser strings não vazias; `type` ∈ {`personal`,`business`}; email validado por `isValidEmailFormat`; `company` validado; email duplicado → 409 |
| Política de palavra-passe | mínimo **6 caracteres** (`index.ts` 481-484) |
| Hash | `bcrypt.hash(password, 12)` — custo **12** (`index.ts` 503) |
| Privilégios | O corpo não escolhe `plan` nem `role`: o plano é o base e `role` é forçado a `user` (`index.ts` 508-519) |
| Resposta | 201 com `{ token, user }`; `sanitizeUser` remove `passwordHash` (`index.ts` 118-121) |

**Prova automatizada:** `auth-role.test.js`, `auth-role-production.test.js`, `email-validation.test.js`, `dist-auth13-inputs.test.js`, `verify-account-migration.test.js` — todos dentro dos 204 PASS da API.
**Limitação:** 6 caracteres é um mínimo fraco para uma conta local; não foi encontrada política de complexidade ou bloqueio por tentativas no código da API (procura por `rateLimit`/`429` não devolveu implementação de limitação de login).

---

## 2. Validação de login

| Item | Detalhe |
|---|---|
| Rota | `POST /auth/login` — `index.ts` 557-585 |
| Leitura | `prisma.user.findUnique({ where: { email } })` |
| Verificação | `bcrypt.compare(password, user.passwordHash)` (`index.ts` 572) |
| Falha | Mensagem genérica `Credenciais inválidas.` para utilizador inexistente ou palavra-passe errada (401) |
| Sucesso | `signToken(user.id)` e resposta `{ token, user }` |

**Prova:** incluído nos 204 PASS; ensaio E2E obteve 200 e token.

---

## 3. Gestão de sessão

| Item | Detalhe |
|---|---|
| Algoritmo | `HS256` fixo (`index.ts` 51) |
| Validade | `7d` (`index.ts` 52) |
| Conteúdo | `sub` (id do utilizador) e `jti` aleatório (`index.ts` 93-98) |
| Segredo | mínimo 32 caracteres; segredos fracos são rejeitados; o processo aborta sem listener se o segredo for inválido (`index.ts` 55-90, 1124-1133) |
| Segredo por instalação | ficheiro `api-jwt-secret`, criado/lembrado pelo desktop (`packages/desktop/src/api-lifecycle.ts` linha 34 e `readOrCreateInstallationSecret`) |
| Verificação | `verifyToken` fixa o algoritmo, verifica revogação por fingerprint e exige `sub` utilizável (`index.ts` 100-114) |
| Autorização | `requireAuth` valida o Bearer, carrega o utilizador e define `principal {userId, role}` (`index.ts` 393-423) |
| Administração | `requireAdmin` exige `role === "admin"` (`index.ts` 430-436); usado, por exemplo, em `DELETE /api/events` |

**Prova:** `auth-jwt-secret`, `auth-api-guard`, `auth-session-restart` (1/1) e os restantes testes de auth — PASS. O `r6-l12-logout` verifica token de 7 dias e `jti`.

---

## 4. Logout e revogação

| Item | Detalhe |
|---|---|
| Rota | `POST /auth/logout` com `requireAuth` — `index.ts` 538-555 |
| Fingerprint | SHA-256 do token (`index.ts` 91) |
| Persistência | `revokeAuthToken` em `auth_revoked_tokens` (`db.ts` 26-41); limpeza de expirados; teto de 10 000 |
| Resposta | 204; 503 se a revogação não for confirmada |
| Efeito | `verifyToken` rejeita o token em pedidos seguintes |

**Prova:** `r6-l12-logout` PASS; `auth-session-restart` PASS (revogação sobrevive a reinício); E2E: logout 204 → pedido seguinte **401**, 1 linha em `auth_revoked_tokens`.
**Limitação:** não há revogação automática de outras sessões; cada logout revoga apenas o Bearer apresentado. Um token não revogado expira em 7 dias.

---

## 5. Autorização de pedidos sensíveis

Rotas privadas usam `requireAuth`: MATRIX (`/api/ai/chat`, `/api/ai/process-consent`, `/api/ai/process-consent/one-shot`, `/api/ai/status`), eventos (`/api/events`, `/api/events/stats`, `/api/dashboard`), scan de ficheiro (`POST /api/file-scan`), treino (`/api/training-score`) e stream (`/api/stream`). `DELETE /api/events` exige `requireAdmin`.
**Prova:** `auth-api-guard.test.js`, `matrix-guard.test.js`, `r6-matrix-boundaries.test.js` — PASS no conjunto de 204.
**Limitação:** o papel `admin` é provisionado fora do fluxo público (comentário em `index.ts` 511-518); o procedimento de provisionamento não é executado por esta auditoria.

---

## 6. Autenticação do pipe nomeado (desktop ↔ serviço)

| Item | Detalhe |
|---|---|
| Credencial | 32 bytes aleatórios → 64 hex por instalação; ficheiro `<userData>\secrets\pipe-credential`, modo 0600 (`pipe-credential.ts` 46-48, 144-173); recusa symlink/hardlink |
| Transporte | variável de ambiente `CYBERSAFE_PIPE_TOKEN` do processo filho; nunca pelo renderer |
| Obrigação | `pipeAuthRequired = NODE_ENV === "production" \|\| CYBERSAFE_PIPE_TOKEN !== undefined` (`engine.ts`) |
| Handshake v2 | `auth-hello(clientNonce)` → `auth-challenge(serverNonce, prova do servidor)` → `auth-response(prova do cliente)` → `{auth, ok:true}` (`engine.ts` 4553-4640) |
| Provas | HMAC com o papel no domínio (`makePipeProof`/`verifyPipeProof`); a prova do servidor não vale como prova do cliente |
| Replay | nonces de cliente vistos são recusados; frame limitado a 4096 bytes |
| Prazo | 3 segundos no cliente (`service-client.ts` 230-235) |
| Arranque | `startPipeServer` recusa token ausente/inválido em produção (`engine.ts` 4644-4663) |

**Prova:** `s4-pipe-auth.test.js` 9/9 PASS; `qa2-pipe-handshake-v2.test.js` 5/5 PASS; `core/test/pipe-auth.test.js` 20/20 PASS; `qa2-pipe-credential.test.mjs` 13/13 PASS; `service-client.ts` inspecionado.
**Limitação:** em modo DEV sem token o serviço avisa e não autentica o pipe; isso é intencional para desenvolvimento, não é o modo de produção.

---

## 7. Armazenamento local de credenciais no desktop

| Dado | Caminho | Proteção | Regra |
|---|---|---|---|
| Sessão (JWT) | `<userData>\secrets\auth-session.bin` | safeStorage/DPAPI | Guardado **apenas** com `remember=true`; caso contrário só em memória; sem fallback em claro; recusa links (`auth-session-store.ts` 22-60) |
| Credenciais de IA (Groq/OpenAI) | `<userData>\secrets\ai-credentials.bin` | safeStorage/DPAPI | Cifrado; o renderer só recebe `hasKey` e `provider`, nunca a chave (`ai-credentials-store.ts` 30-105) |

**Prova:** `auth-session-store.test.mjs` 6/6 PASS; `auth-session-ipc.test.mjs` 3/3 PASS; `qa2-pipe-credential.test.mjs` 13/13 PASS.
**Limitação:** DPAPI protege em repouso contra outros utilizadores do Windows, **não** contra software a correr na mesma conta.

---

## 8. O que está provado e o que não está

**Provado por teste automatizado (clone de `212cb64`):** registo, hash bcrypt, login, emissão/verificação de JWT, logout com revogação persistente, autorização por rota, handshake do pipe, cofres DPAPI.
**Provado por ensaio E2E (API isolada, base temporária):** registo 201 → treino 201 → leitura 200 → logout 204 → token revogado 401.
**Não testado nesta auditoria:** instalação Windows real (não foi alterada), fluxo de provisionamento de admin, resistência a força bruta (não há limitação de tentativas implementada no código da API).
**Não se declara:** que a autenticação seja suficiente para exposição na Internet. A API escuta em `127.0.0.1` (`index.ts` 1128-1132); o modelo de ameaça é local.
