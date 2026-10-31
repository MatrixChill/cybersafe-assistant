# ESQUEMA REAL DA BASE DE DADOS SQLITE

> **Código de referência:** `MatrixChill/cybersafe-assistant`, `main` = `212cb64c39f74f547d4ebc6c8bff7cc5bcbcdf56`
> **Candidata ensaiada manualmente:** `0.1.10-internal.pap-r5.20261031` — SHA-256 `46718BCD9C5EE712D9E4C663B81AA2FED3317E65C3799F500255D33FB6E5BD75`
> **Data da recolha:** 2026-10-31
> **Natureza da evidência:** base de dados real (cópia read-only), código inspecionado e registos de ciclo de vida da instalação.

---

## 1. Caminho efetivo da base de dados

### Conclusão

A base de dados efetivamente usada pela instalação é:

```
%USERPROFILE%\.cybersafe-service\cybersafe.db
```

Ficheiro observado: **77 824 bytes**, última escrita **2026-10-30T21:30:59Z**.

### Prova

| Prova | Fonte | Natureza |
|---|---|---|
| O perfil de produção devolve `dbPessoalApi()` quando `CYBERSAFE_DB_PATH` não está definido. `dbPessoalApi()` = `homedir()/.cybersafe-service/cybersafe.db`. | `packages/api/src/dev-isolation.ts` (`dbPessoalApi`, ramo `modo === "producao"`) @ `212cb64` | código inspecionado |
| O processo desktop remove `CYBERSAFE_DB_PATH` do ambiente do filho da API, exceto quando um caminho é passado explicitamente, e força `NODE_ENV=production`. | `packages/desktop/src/api-lifecycle.ts` linhas 190-207 (`buildApiChildEnv`) @ `212cb64` | código inspecionado |
| `CYBERSAFE_DB_PATH` está vazio/ausente no ambiente observado. | shell da sessão de auditoria, 2026-10-31 | observação direta |
| O ficheiro existe naquele caminho, com o tamanho e data acima, e é o mesmo ficheiro a que o serviço em execução escreve. | `%USERPROFILE%\.cybersafe-service\cybersafe.db`; `api-lifecycle.jsonl` regista `listening` na porta 4000 em 2026-10-31T00:31:10Z | observação direta |

### Base legada descartada

Existe uma base em `%PROGRAMDATA%\CyberSafe\cybersafe.db` (32 768 bytes, 2026-06-13) com apenas **3 tabelas** (`threat_events`, `training_results`, `users`) e **0** linhas em `training_results`. Não corresponde ao esquema atual (7 tabelas) e não é referida pelo código de produção. É classificada como **legada e não utilizada** pela versão atual.

---

## 2. Método de inspeção (sem alterar dados)

1. A base foi **copiada** (ficheiro principal; `-wal`/`-shm` inexistentes) para `raw/db-install/db-copy/`.
2. A cópia foi aberta com `node:sqlite` `DatabaseSync` em modo **`readOnly: true`**.
3. Foram exportados: DDL (`sqlite_master`), `PRAGMA table_info`, `foreign_key_list`, `index_list`, `index_info`, `integrity_check` e contagens de linhas.
4. **Não foram exportados** valores de `email`, `passwordHash`, `name`, `companyName`, tokens, fingerprints ou quaisquer dados pessoais. O export contém apenas esquema e contagens.

Ficheiros de evidência:

- `raw/db-install/schema.sql` — DDL e PRAGMAs legíveis
- `raw/db-install/schema.json` — mesma informação em JSON
- `raw/db-install/db-copy/cybersafe.db` — cópia read-only
- `_work/inspect-db.mjs` — script usado

---

## 3. Esquema real (7 tabelas)

`PRAGMA foreign_key_list` devolve **vazio em todas as tabelas**: não existem restrições de chave estrangeira físicas. As relações abaixo são **lógicas**, garantidas pelo código da aplicação, não pelo motor SQLite.

### 3.1 `users` — 8 linhas

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  passwordHash TEXT NOT NULL,
  type TEXT NOT NULL,
  plan TEXT NOT NULL,
  companyName TEXT,
  createdAt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user'
);
```

Índices: PK em `id`; único em `email`.

### 3.2 `auth_revoked_tokens` — 1 linha

```sql
CREATE TABLE auth_revoked_tokens (
  fingerprint TEXT PRIMARY KEY,
  expiresAt REAL NOT NULL
);
```

Índice: PK em `fingerprint`.

### 3.3 `threat_events` — 2 linhas

```sql
CREATE TABLE threat_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  url TEXT,
  domain TEXT,
  severity TEXT NOT NULL,
  confidence REAL,
  rulesTriggered TEXT,
  createdAt TEXT NOT NULL
);
```

Índice: PK em `id`. As 2 linhas presentes têm prefixo de id `m-` e `source` `dashboard`/`extension`, coincidindo com os dois eventos de **seed** inseridos por `packages/api/src/db.ts` (linhas 313-330) quando a tabela está vazia. São dados de demonstração, não deteções reais.

### 3.4 `training_results` — 1 linha

```sql
CREATE TABLE training_results (
  id TEXT PRIMARY KEY,
  userId TEXT,
  gameType TEXT NOT NULL,
  score INTEGER NOT NULL,
  maxScore INTEGER NOT NULL,
  completedAt TEXT NOT NULL
);
```

Índice: PK em `id`; sem índice em `userId`.

### 3.5 `app_installation` — 1 linha

```sql
CREATE TABLE app_installation (
  id TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL
);
```

### 3.6 `process_consent_grants` — 3 linhas

```sql
CREATE TABLE process_consent_grants (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  installationId TEXT NOT NULL,
  providerKey TEXT NOT NULL,
  purpose TEXT NOT NULL,
  fields TEXT NOT NULL,
  allowFutureProcesses INTEGER NOT NULL,
  persistent INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  revokedAt TEXT,
  revision INTEGER NOT NULL
);
CREATE INDEX idx_process_consent_conta
  ON process_consent_grants (userId, installationId, revokedAt);
```

### 3.7 `process_consent_one_shots` — 0 linhas

```sql
CREATE TABLE process_consent_one_shots (
  id TEXT PRIMARY KEY,
  tokenHash TEXT NOT NULL UNIQUE,
  userId TEXT NOT NULL,
  installationId TEXT NOT NULL,
  providerKey TEXT NOT NULL,
  purpose TEXT NOT NULL,
  fields TEXT NOT NULL,
  targetPid INTEGER NOT NULL,
  targetStartedAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  consumedAt TEXT,
  revokedAt TEXT
);
CREATE INDEX idx_consent_one_shot_conta
  ON process_consent_one_shots (userId, installationId, consumedAt, revokedAt);
```

Índices únicos: PK em `id`; único em `tokenHash`.

---

## 4. Diagrama entidade-relação (relações lógicas)

```mermaid
erDiagram
  users ||--o{ training_results : "userId (sem FK)"
  users ||--o{ process_consent_grants : "userId (sem FK)"
  users ||--o{ process_consent_one_shots : "userId (sem FK)"
  app_installation ||--o{ process_consent_grants : "installationId (sem FK)"
  app_installation ||--o{ process_consent_one_shots : "installationId (sem FK)"

  users {
    TEXT id PK
    TEXT email UK
    TEXT passwordHash
    TEXT type
    TEXT plan
    TEXT role
    TEXT createdAt
  }
  training_results {
    TEXT id PK
    TEXT userId FK_LOGICAL
    TEXT gameType
    INTEGER score
    INTEGER maxScore
    TEXT completedAt
  }
  process_consent_grants {
    TEXT id PK
    TEXT userId FK_LOGICAL
    TEXT installationId FK_LOGICAL
    TEXT providerKey
    TEXT purpose
    TEXT fields
    INTEGER allowFutureProcesses
    INTEGER persistent
    TEXT expiresAt
    TEXT revokedAt
    INTEGER revision
  }
  process_consent_one_shots {
    TEXT id PK
    TEXT tokenHash UK
    TEXT userId FK_LOGICAL
    TEXT installationId FK_LOGICAL
    TEXT providerKey
    TEXT purpose
    TEXT fields
    INTEGER targetPid
    TEXT targetStartedAt
    TEXT createdAt
    TEXT expiresAt
    TEXT consumedAt
    TEXT revokedAt
  }
  app_installation {
    TEXT id PK
    TEXT createdAt
  }
  threat_events {
    TEXT id PK
    TEXT source
    TEXT url
    TEXT domain
    TEXT severity
    REAL confidence
    TEXT rulesTriggered
    TEXT createdAt
  }
  auth_revoked_tokens {
    TEXT fingerprint PK
    REAL expiresAt
  }
```

> `threat_events` e `auth_revoked_tokens` não têm relação com as restantes tabelas no esquema real.

---

## 5. Comparação: base real × `packages/api/src/db.ts` × `schema.prisma`

| Elemento | Base real | `db.ts` @ `212cb64` | `prisma/schema.prisma` @ `212cb64` |
|---|---|---|---|
| `users` | presente, com `role` acrescentada por `ALTER TABLE` | criada com `role TEXT NOT NULL DEFAULT 'user'`; migração `ALTER TABLE` se ausente (linhas 57-96) | **ausente** |
| `auth_revoked_tokens` | presente | criada em `db.ts` linhas 26-29 | **ausente** |
| `threat_events` | `url`, `domain`, `confidence`, `rulesTriggered` **anuláveis** | igual à base real (linhas 70-79) | `url String`, `domain String`, `confidence Float`, `rulesTriggered Json` **obrigatórios**; índices em `createdAt`, `severity`, `source` |
| `training_results` | `userId?`, `gameType`, `score INTEGER`, `maxScore INTEGER` | igual à base real (linhas 81-88) | `correctCount Int`, `totalCount Int`, `score Float`; **sem** `userId`, `gameType`, `maxScore` |
| `app_installation` | presente | criada em `db.ts` linhas 107-111 | **ausente** |
| `process_consent_grants` | presente + índice | igual (linhas 113-130) | **ausente** |
| `process_consent_one_shots` | presente + índices | igual (linhas 140-157) | **ausente** |
| Estar em uso em runtime | sim | sim — `better-sqlite3` com um adaptador no formato Prisma | **não** |

### Diferenças relevantes

1. **`schema.prisma` está desatualizado e não é usado em runtime.** `@prisma/client` consta apenas de `package.json` como dependência; não existe `import` de `@prisma/client` em `packages/api/src`. O objeto `prisma` exportado por `db.ts` é um adaptador próprio sobre `better-sqlite3`.
2. **`training_results` diverge em colunas e tipos.** A base real guarda `score` inteiro 0-100 e `maxScore`; o schema Prisma espera `correctCount`, `totalCount` e `score Float`. `prisma generate`/`prisma db push` produziriam um contrato incompatível com a tabela real.
3. **`threat_events` diverge em nulabilidade.** O schema Prisma declara campos obrigatórios que a base real permite nulos.
4. **Tabelas de autenticação e consentimento não existem no schema Prisma.**
5. A base real tem `role` acrescentada por migração `ALTER TABLE`, o que explica a ordem da coluna no DDL exportado: a instalação nasceu antes da coluna `role` e foi migrada sem perda de dados.

---

## 6. Limitações desta conclusão

- A inspeção cobre **esta instalação Windows**. Outra instalação pode ter um histórico de migrações diferente (por exemplo, `users` já criada com `role` de origem).
- Não foi executada qualquer migração, escrita ou `VACUUM`. A cópia foi aberta read-only.
- As contagens de linhas são um retrato de 2026-10-31 e mudam com o uso normal.
- A identificação das 2 linhas de `threat_events` como seed baseia-se no padrão `m-`, nos valores `dashboard`/`extension` e na lógica de seed de `db.ts`; não foi exportado o conteúdo integral.
