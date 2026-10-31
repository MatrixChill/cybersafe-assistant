# RESULTADOS DE TREINO (`training_results`) — ESTADO REAL

> **Código:** `MatrixChill/cybersafe-assistant` @ `212cb64c39f74f547d4ebc6c8bff7cc5bcbcdf56`
> **Candidata:** `0.1.10-internal.pap-r5.20261031` (SHA-256 `46718BCD…BD75`)
> **Natureza:** código inspecionado + base real (leitura) + ensaio E2E isolado + teste de reinício.
> **Regra:** não se declara “concluído” o que não foi provado; a limitação de atribuição é documentada, não corrigida.

---

## 1. Contrato da rota

`packages/app/src/pages/SimulatorPage.tsx` envia:

```json
{ "correctCount": <acertos>, "totalCount": <total de cenários> }
```

A rota `POST /api/training-score` (`packages/api/src/index.ts` 1090-1111):

1. calcula `score = Math.round((correctCount / totalCount) * 100)`;
2. chama `prisma.trainingResult.create` com `{ correctCount, totalCount, score, gameType: "simulator", maxScore: totalCount }`;
3. devolve 201 com o objeto do adaptador.

A leitura `GET /api/training-score` (`index.ts` 1113-1122) devolve as **últimas 20** linhas, a média e `recentResults`.

---

## 2. Contrato real de persistência

`packages/api/src/db.ts` linhas 301-309:

```ts
create: async ({ data }: any) => {
  const id = `tr-${Math.random().toString(36).substring(7)}`;
  const completedAt = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO training_results (id, userId, gameType, score, maxScore, completedAt) VALUES (?, ?, ?, ?, ?, ?)'
  );
  stmt.run(id, data.userId || null, data.gameType, data.score, data.maxScore, completedAt);
  return { ...data, id, completedAt: new Date(completedAt) };
}
```

Consequências factuais:

- `userId` **nunca** é enviado pela rota → é gravado **NULL**.
- `correctCount` e `totalCount` são **ignorados pelo adaptador** (não existem colunas); só `score` e `maxScore` são persistidos.
- O objeto devolvido inclui `correctCount`/`totalCount` porque o adaptador faz spread de `data`, apesar de não estarem na tabela. É uma diferença entre resposta e armazenamento.

---

## 3. Incompatibilidade com `schema.prisma`

`packages/api/prisma/schema.prisma` @ `212cb64` declara:

```prisma
model TrainingResult {
  id           String   @id @default(cuid())
  correctCount Int
  totalCount   Int
  score        Float
  completedAt  DateTime @default(now())
}
```

| Aspeto | Base real | `schema.prisma` | Compatível? |
|---|---|---|---|
| `correctCount` | não existe | obrigatório | **não** |
| `totalCount` | não existe | obrigatório | **não** |
| `score` | INTEGER 0-100 | Float | **não** (tipo) |
| `maxScore` | INTEGER | não existe | **não** |
| `gameType` | TEXT | não existe | **não** |
| `userId` | TEXT anulável | não existe | **não** |

**Não há incompatibilidade em runtime porque o Prisma não é usado:** `@prisma/client` está em `package.json`, mas não existe `import` em `packages/api/src`; `db.ts` usa `better-sqlite3` através de um adaptador com a forma de `prisma`. O `schema.prisma` é documentação morta/desatualizada. Se alguém executasse `prisma db push`/`migrate`, o contrato colidiria com a tabela real.

---

## 4. Prova na base real da instalação

Cópia read-only de 2026-10-31, tabela `training_results`:

| Campo | Valor observado |
|---|---|
| Linhas | 1 |
| `gameType` | `simulator` |
| `score` | 100 |
| `maxScore` | 6 |
| `userId` | NULL |
| `completedAt` | 2026-10-15 |

**Interpretação:** o caminho real de gravação **funcionou** pelo menos uma vez na instalação (linha criada pela rota, com o `gameType` que a rota impõe). Isto prova persistência; **não** prova atribuição por conta.

---

## 5. Ensaio E2E isolado (API real, base temporária)

Comando: `node PAP-EVIDENCIAS-TECNICAS/_work/e2e-api-training.mjs` (clone @ `212cb64`, `NODE_ENV=production`, porta 4317, `CYBERSAFE_DB_PATH` temporário).

| Passo | Resultado |
|---|---|
| `/health` | OK |
| Registo | **201**, token emitido |
| `POST /api/training-score` (`5/6`) | **201**, `score=83`, `maxScore=6`, `gameType=simulator` |
| `GET /api/training-score` | **200**, `totalSessions=1`, `averageScore=83` |
| Login | **200**, token emitido |
| Logout | **204** |
| Mesmo Bearer após logout | **401** |
| Linha lida da base | 1; `score=83`, `maxScore=6`, `gameType=simulator`, `userId` **NULL** |
| Linhas em `users` / `auth_revoked_tokens` | 1 / 1 |

**Resultado global: PASS.** Evidência: `raw/e2e-api/e2e-result.json`, `raw/e2e-api/e2e-server.log`.

---

## 6. Limitações reais (não corrigidas)

1. **Sem atribuição por utilizador.** A rota não passa `userId`; a coluna fica NULL. O histórico é global.
2. **Leitura global.** `GET /api/training-score` devolve as últimas 20 linhas de **todos** os utilizadores, sem filtro por conta. Num produto multifuncionário isto é uma fuga de contexto entre contas.
3. **Sem teste dedicado** de treino na suíte da API; a prova é o E2E desta auditoria e a linha real.
4. **`schema.prisma` enganador.** Não é o esquema usado; não deve ser apresentado como contrato da base.
5. **Resposta inclui campos não persistidos** (`correctCount`, `totalCount`), o que pode iludir um consumidor.

**Não se declara** que o histórico de treino seja “por conta” nem que o Simulador esteja totalmente integrado. O que está provado é: a rota grava e relê uma linha válida; a atribuição por conta não existe.
