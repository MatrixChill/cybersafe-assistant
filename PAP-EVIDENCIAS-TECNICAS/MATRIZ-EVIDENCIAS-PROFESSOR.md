# MATRIZ DE EVIDÊNCIAS PARA O PROFESSOR

> **Código:** `MatrixChill/cybersafe-assistant` @ `212cb64c39f74f547d4ebc6c8bff7cc5bcbcdf56`
> **Candidata:** `0.1.10-internal.pap-r5.20261031` — SHA-256 `46718BCD9C5EE712D9E4C663B81AA2FED3317E65C3799F500255D33FB6E5BD75`
> **Data:** 2026-10-31
> **Regra de leitura:** cada linha indica a fonte, a versão e a **natureza** da prova (código, teste, ensaio manual/real). “Existe código” não é apresentado como “funciona na instalação”.

---

## 1. Tabela de evidências

| # | Observação / pergunta | Conclusão | Prova | Natureza | Estado |
|---|---|---|---|---|---|
| 1 | Qual é a base SQLite efetivamente usada? | `%USERPROFILE%\.cybersafe-service\cybersafe.db` (77 824 bytes) | `dev-isolation.ts` + `api-lifecycle.ts`; ficheiro real; `CYBERSAFE_DB_PATH` vazio | código + observação real | **PROVADO** |
| 2 | O esquema real coincide com o documentado? | 7 tabelas reais; `schema.prisma` só descreve 2 e está desatualizado | DDL read-only; `db.ts`; `schema.prisma`; `@prisma/client` não importado | base real + código | **PROVADO** (com divergência) |
| 3 | `training_results` está coerente? | Base real: `userId?`, `gameType`, `score INT`, `maxScore`; Prisma: `correctCount`, `totalCount`, `score Float` | DDL + `db.ts` 301-309 + `schema.prisma` | base real + código | **DIVERGENTE** |
| 4 | A gravação de treino funciona? | Sim: uma linha real e E2E 201 → leitura 200 → linha na base | linha real (score 100, maxScore 6, 2026-10-15); E2E (score 83, maxScore 6) | real + teste E2E | **PROVADO** |
| 5 | O treino é atribuído à conta? | **Não.** `userId` fica NULL e a leitura é global | rota não envia `userId`; E2E leu NULL; `findMany` sem filtro | código + ensaio | **LIMITAÇÃO REAL** |
| 6 | As contas persistem? | Sim, em SQLite; hash bcrypt 12 | código; 204 testes API; E2E | código + teste | **PROVADO** |
| 7 | As sessões/revogações sobrevivem a reinício? | Revogação sim (SQLite); token do cliente só com `remember=true` (DPAPI) | `auth-session-restart` PASS; E2E 401 após logout; `auth-session-store` | teste + ensaio | **PROVADO** |
| 8 | O histórico de scans persiste? | Sim, `scans.jsonl` (máx. 200) | `r7-l3-history` 17/17 PASS; ficheiro real com 30 linhas | teste + observação | **PROVADO** |
| 9 | A quarentena persiste? | Sim, `manifest.json` + `*.quarantine` (chmod 000) | 10/10 + 5/5 + 6/6 + 7/7 PASS | teste | **PROVADO** |
| 10 | A quarentena registe o motor? | **Não.** Só `detectionReason` (regras); `engine` nunca é preenchido | `shared-types` 326; `response.ts` 95-145 | código | **LIMITAÇÃO REAL** |
| 11 | Os consentimentos MATRIX persistem? | Sim, 2 tabelas SQLite; 3 grants reais | `process-consent` e `r6-matrix` nos 204 PASS; base real | teste + base real | **PROVADO** |
| 12 | A autenticação existe e está testada? | Sim: registo, bcrypt 12, login, JWT HS256 7d, logout com fingerprint, `requireAuth`/`requireAdmin` | código + 204 PASS + E2E | código + teste | **PROVADO** |
| 13 | O pipe desktop↔serviço está autenticado? | Sim: handshake v2 HMAC, nonce, 3 s, token 64 hex por instalação | `s4` 9/9; `handshake-v2` 5/5; core 20/20; credencial 13/13 | teste + código | **PROVADO** |
| 14 | Que motor produziu os 2 `engine-failed` do ensaio de 800? | **Motor nativo**: ISO 8,95 GB `timeout`; `.lnk` `output` | `scans.jsonl` (18 coverage + 2 engine-failed); eventos com `nativeEngine` | registo real | **PROVADO** |
| 15 | Os 18 inconclusivos são quê? | Limite de 100 MiB (`large-file-limit`), com motor nativo concluído | agregado do scan + amostra de 4 ficheiros >100 MiB | registo real | **PROVADO** (contagem agregada) |
| 16 | Uma deteção EICAR é atribuível a um motor? | Atribuível à **regra/assinatura** (`known_bad_hash`, `yara_match`, `known_malware`); **não** persistida por motor na quarentena | `analysis.ts`, `signatures.ts`, `yara.ts`, `clamav.ts`, `response.ts` | código | **PARCIAL** |
| 17 | A suíte completa passa a 100%? | **Não.** No conjunto dirigido: 315 PASS / **1 FAIL** / 0 SKIP | logs em `logs/`; FAIL em `threat-history-storage` | teste | **PROVADO QUE NÃO** |
| 18 | A instalação Windows foi alterada? | Não. Cópia read-only; nenhum ficheiro de produto/DB/quarentena alterado | método e comandos nesta pasta | processo | **PROVADO** (por método) |
| 19 | O relatório Word foi alterado? | Não. Esta auditoria só criou ficheiros em `PAP-EVIDENCIAS-TECNICAS/` | âmbito do trabalho | processo | **PROVADO** (por método) |

---

## 2. Os cinco factos que o relatório pode afirmar com segurança

1. **A base efetiva é `%USERPROFILE%\.cybersafe-service\cybersafe.db`, com 7 tabelas, sem chaves estrangeiras físicas.** (base real + código)
2. **Contas, revogações, consentimentos e resultados de treino persistem em SQLite; históricos, quarentena e políticas persistem em JSON/JSONL.** (código + testes + base real)
3. **O login/registo usam bcrypt custo 12 e JWT HS256 de 7 dias com revogação por fingerprint persistida.** (código + 204 testes + E2E)
4. **O pipe entre desktop e serviço usa um handshake HMAC v2 com nonce e credencial de 64 hex por instalação.** (código + 47 testes de pipe)
5. **No ensaio de 800 ficheiros, os 2 `engine-failed` são falhas do motor nativo; os 18 `coverage-incomplete` vêm do limite de 100 MiB.** (registo real)

## 3. Os factos que o relatório NÃO deve afirmar

1. **“O histórico de treino é por utilizador.”** Não é: `userId` fica NULL e a leitura é global.
2. **“A quarentena registe o motor que detetou.”** Não regista; só as regras.
3. **“O `schema.prisma` é o esquema da base.”** Não é; está desatualizado e não é usado em runtime.
4. **“A suíte de testes está 100% verde.”** Há 1 FAIL documentado e a suíte completa não foi executada.
5. **“O ensaio de 800 ficheiros provou que o disco está limpo.”** Foi um quick scan de 800 considerados, com 20 inconclusivos.
6. **“A candidata foi reinstalada/alterada nesta auditoria.”** Não foi.

---

## 4. Limitações globais

- **Uma instalação, um retrato.** O esquema e as contagens são desta máquina em 2026-10-31.
- **Testes no código-fonte, não no instalador.** Os testes correram no clone de `212cb64`; os registos do ensaio de 800 vêm da instalação da candidata. Não se transfere o resultado de um para o outro sem esta ressalva.
- **Dependências do clone** vieram da árvore de desenvolvimento (ver relatório de testes).
- **Dados pessoais não publicados.** Caminhos pessoais foram substituídos por `%USERPROFILE%`/`<baseDir>`/`<userData>`; emails, hashes de palavra-passe e tokens não foram exportados.
- **Nada foi corrigido.** As limitações (treino sem `userId`, quarentena sem motor, `schema.prisma` morto, palavra-passe mínima de 6) são documentadas, não alteradas.

---

## 5. Índice de reprodução

| Evidência | Ficheiro |
|---|---|
| DDL e PRAGMAs da base real | `raw/db-install/schema.sql`, `raw/db-install/schema.json` |
| Base legada (não usada) | `raw/db-legacy-programdata/` |
| Registo do ensaio de 800 | `raw/scan-800-20261030.json` |
| Factos dos 2 `engine-failed` | `raw/trial-20261030-engine-failed.json` |
| E2E de autenticação/treino | `raw/e2e-api/e2e-result.json`, `raw/e2e-api/e2e-server.log` |
| Logs dos testes | `logs/*.log`, `logs/_*-summary.txt` |
| Clone testado | `_work/clone-212cb64` (HEAD `212cb64`) |

**Versão de referência:** commit `212cb64c39f74f547d4ebc6c8bff7cc5bcbcdf56`. **Candidata:** `0.1.10-internal.pap-r5.20261031`, SHA-256 `46718BCD9C5EE712D9E4C663B81AA2FED3317E65C3799F500255D33FB6E5BD75`.
