# DICIONÁRIO DE DADOS — ESQUEMA REALMENTE UTILIZADO

> **Código:** `MatrixChill/cybersafe-assistant` @ `212cb64c39f74f547d4ebc6c8bff7cc5bcbcdf56`
> **Fonte:** `%USERPROFILE%\.cybersafe-service\cybersafe.db` (cópia read-only, 2026-10-31)
> **Natureza:** base de dados real + código inspecionado. Nenhum valor pessoal é reproduzido neste documento.

Este dicionário descreve **o esquema que a instalação usa de facto**, não o `schema.prisma`. As contagens são do retrato recolhido.

---

## `users`

Contas da aplicação. Criada em `packages/api/src/db.ts` linhas 57-68; `role` acrescentada por `ALTER TABLE` nas linhas 91-96.

| Coluna | Tipo | Nulo | Chave | Significado |
|---|---|---|---|---|
| `id` | TEXT | não | PK | Identificador opaco gerado na criação da conta |
| `name` | TEXT | não | — | Nome indicado no registo |
| `email` | TEXT | não | UNIQUE | Identificador de login; normalizado pela aplicação |
| `passwordHash` | TEXT | não | — | Hash bcrypt (custo 12); **nunca** a palavra-passe |
| `type` | TEXT | não | — | `personal` ou `business` |
| `plan` | TEXT | não | — | Plano da conta; o registo público força o plano base |
| `companyName` | TEXT | sim | — | Nome da empresa, apenas para contas `business` |
| `createdAt` | TEXT | não | — | Data ISO-8601 de criação |
| `role` | TEXT | não | — | `user` por omissão; `admin` apenas por provisionamento fora do fluxo público |

**Linhas observadas:** 8.
**Privacidade:** `name`, `email`, `companyName` e `passwordHash` não foram exportados. `passwordHash` nunca é devolvido pela API (`sanitizeUser`, `packages/api/src/index.ts` linhas 118-121).

---

## `auth_revoked_tokens`

Revogações de JWT que têm de sobreviver a reinícios. Criada em `db.ts` linhas 26-29.

| Coluna | Tipo | Nulo | Chave | Significado |
|---|---|---|---|---|
| `fingerprint` | TEXT | não | PK | SHA-256 **do token**, não o token |
| `expiresAt` | REAL | não | — | Expiração do token em segundos Unix; permite limpar revogações já inúteis |

**Linhas observadas:** 1.
**Regras de escrita:** `revokeAuthToken` (`db.ts` linhas 33-41) apaga revogações expiradas antes de inserir, recusa acima de 10 000 entradas e usa `INSERT OR REPLACE`.
**Privacidade:** o valor do JWT nunca é persistido; apenas o digest.

---

## `threat_events`

Eventos de ameaça apresentados no produto. Criada em `db.ts` linhas 70-79.

| Coluna | Tipo | Nulo | Chave | Significado |
|---|---|---|---|---|
| `id` | TEXT | não | PK | Identificador; o adaptador usa prefixo `m-` |
| `source` | TEXT | não | — | Origem do evento (`dashboard`, `extension`, etc.) |
| `url` | TEXT | sim | — | URL ou URI associada, quando existir |
| `domain` | TEXT | sim | — | Domínio ou nome de ficheiro apresentado |
| `severity` | TEXT | não | — | `low` / `medium` / `high` / `critical` |
| `confidence` | REAL | sim | — | Confiança do veredicto |
| `rulesTriggered` | TEXT | sim | — | JSON serializado da lista de regras |
| `createdAt` | TEXT | não | — | Data ISO-8601 |

**Linhas observadas:** 2 — ambas correspondem ao **seed de demonstração** de `db.ts` linhas 313-330 (prefixo `m-`, origens `dashboard` e `extension`), não a deteções reais.
**Nota:** o schema Prisma declara `url`, `domain` e `confidence` obrigatórios e `rulesTriggered` como `Json`; a base real permite nulos e guarda texto JSON.

---

## `training_results`

Resultados do Simulador. Criada em `db.ts` linhas 81-88.

| Coluna | Tipo | Nulo | Chave | Significado |
|---|---|---|---|---|
| `id` | TEXT | não | PK | Identificador; prefixo `tr-` no adaptador |
| `userId` | TEXT | **sim** | — (sem FK) | Conta associada — na prática **fica NULL**, porque a rota não o envia |
| `gameType` | TEXT | não | — | Tipo de jogo; a rota grava `simulator` |
| `score` | INTEGER | não | — | Percentagem inteira 0-100 calculada pela rota |
| `maxScore` | INTEGER | não | — | Total de perguntas (`totalCount`) |
| `completedAt` | TEXT | não | — | Data ISO-8601 do registo |

**Linhas observadas:** 1 (score 100, `maxScore` 6, `gameType` `simulator`, `userId` NULL, 2026-10-15).
**Limitação real:** não existe filtro por utilizador na leitura (`db.ts` linhas 285-300) nem associação na escrita. Ver `TREINO-ESTADO-REAL.md`.

---

## `app_installation`

Identificador opaco desta instalação, usado para separar consentimentos MATRIX entre instalações. Criada em `db.ts` linhas 107-111.

| Coluna | Tipo | Nulo | Chave | Significado |
|---|---|---|---|---|
| `id` | TEXT | não | PK | UUID opaco gerado localmente; **não** é hardware ID nem derivado do utilizador |
| `createdAt` | TEXT | não | — | Data ISO-8601 |

**Linhas observadas:** 1.

---

## `process_consent_grants`

Consentimentos MATRIX persistentes. Criada em `db.ts` linhas 113-126; índice em 128-129. Guarda **metadados da escolha**, não conteúdo de conversa nem chaves.

| Coluna | Tipo | Nulo | Chave | Significado |
|---|---|---|---|---|
| `id` | TEXT | não | PK | Identificador do grant |
| `userId` | TEXT | não | — (sem FK) | Conta que autorizou |
| `installationId` | TEXT | não | — (sem FK) | Instalação onde o grant vale |
| `providerKey` | TEXT | não | — | Fornecedor como **hash**, nunca URL nem chave |
| `purpose` | TEXT | não | — | Finalidade autorizada |
| `fields` | TEXT | não | — | Lista de campos autorizados (texto) |
| `allowFutureProcesses` | INTEGER | não | — | 0/1; abrange processos futuros? |
| `persistent` | INTEGER | não | — | 0/1; grant persistente? |
| `createdAt` | TEXT | não | — | Criação |
| `expiresAt` | TEXT | não | — | Expiração |
| `revokedAt` | TEXT | sim | — | Revogação, quando existir |
| `revision` | INTEGER | não | — | Versão do grant |

**Linhas observadas:** 3.
**Índice:** `idx_process_consent_conta (userId, installationId, revokedAt)`.

---

## `process_consent_one_shots`

Autorização de **um único envio**, ligada a um processo concreto. Criada em `db.ts` linhas 140-157.

| Coluna | Tipo | Nulo | Chave | Significado |
|---|---|---|---|---|
| `id` | TEXT | não | PK | Identificador |
| `tokenHash` | TEXT | não | UNIQUE | SHA-256 do token de uso único; o token em claro **não** é guardado |
| `userId` | TEXT | não | — (sem FK) | Conta |
| `installationId` | TEXT | não | — (sem FK) | Instalação |
| `providerKey` | TEXT | não | — | Fornecedor como hash |
| `purpose` | TEXT | não | — | Finalidade |
| `fields` | TEXT | não | — | Campos autorizados |
| `targetPid` | INTEGER | não | — | Processo alvo |
| `targetStartedAt` | TEXT | não | — | Início do processo; distingue reutilização de PID |
| `createdAt` | TEXT | não | — | Criação |
| `expiresAt` | TEXT | não | — | Expiração |
| `consumedAt` | TEXT | sim | — | Consumo |
| `revokedAt` | TEXT | sim | — | Revogação |

**Linhas observadas:** 0.
**Índices:** `idx_consent_one_shot_conta (userId, installationId, consumedAt, revokedAt)`; único em `tokenHash`.

---

## O que este esquema deliberadamente não contém

- Texto de conversa com a MATRIX.
- Chaves de API (Groq/OpenAI) — vivem cifradas em `ai-credentials.bin` (DPAPI), não no SQLite.
- Métricas de processo para além de PID/início do alvo de um one-shot.
- Tokens em claro (só fingerprints/hashes).
- Palavras-passe (só hashes bcrypt).

---

## Nota de proveniência

- DDL e PRAGMAs: `raw/db-install/schema.sql` e `raw/db-install/schema.json`.
- Origem do esquema: `packages/api/src/db.ts` @ `212cb64` (código inspecionado).
- Contagens: cópia read-only de 2026-10-31.
- Nenhum valor de `email`, `passwordHash`, `name` ou `companyName` foi lido para este documento; a verificação das duas linhas de seed usou apenas `id` (prefixo), `source`, `url`, `domain` e `severity`.
