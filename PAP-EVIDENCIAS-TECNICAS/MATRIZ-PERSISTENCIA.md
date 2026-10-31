# MATRIZ DE PERSISTÊNCIA — PROVAS DE ESCRITA, LEITURA E REINÍCIO

> **Código:** `MatrixChill/cybersafe-assistant` @ `212cb64c39f74f547d4ebc6c8bff7cc5bcbcdf56`
> **Candidata:** `0.1.10-internal.pap-r5.20261031` (SHA-256 `46718BCD…BD75`)
> **Natureza:** código inspecionado + testes automatizados em clone isolado + ensaio de ponta a ponta + observação da instalação.
> **Regra aplicada:** não se assume que tudo está no SQLite. Cada domínio indica o formato e o caminho reais.

Legenda de caminhos:
- `<baseDir>` = `%USERPROFILE%\.cybersafe-service` em produção (`packages/service/src/log-writer.ts` linhas 304-309).
- `<userData>` = diretório `userData` do Electron (`%APPDATA%\<aplicação>`), obtido por `app.getPath("userData")`.

---

## 1. Contas e credenciais

| Campo | Valor |
|---|---|
| Componente | API (`packages/api/src/db.ts`) |
| Caminho real | `<baseDir>\cybersafe.db` (SQLite) |
| Formato | Tabela `users`; `passwordHash` bcrypt custo 12 |
| Escrita | `POST /auth/register` → `prisma.user.create` (`index.ts` 506-529); hash em `index.ts` 503 |
| Leitura | `POST /auth/login` → `findUnique` + `bcrypt.compare` (`index.ts` 557-585); `requireAuth` → `findUnique` (`index.ts` 410-416) |
| Reinício | **Persiste** — é um ficheiro SQLite; a conta mantém-se após reinício do serviço/API |
| Prova | Código; testes API (204 PASS); ensaio E2E: registo 201 e leitura posterior da linha em `users` |

**O que não se afirma:** não foi feita alteração à base pessoal; o ensaio E2E usou uma base temporária.

---

## 2. Sessões e revogações

| Campo | Valor |
|---|---|
| Componente | API + desktop |
| Caminho real (servidor) | `<baseDir>\cybersafe.db`, tabela `auth_revoked_tokens` |
| Caminho real (cliente) | `<userData>\secrets\auth-session.bin` (DPAPI/safeStorage) |
| Formato | JWT HS256, 7 dias, com `sub` e `jti`; servidor guarda apenas SHA-256 do token e expiração; cliente guarda o token cifrado |
| Escrita | login/registo devolvem token; `POST /auth/logout` insere fingerprint (`index.ts` 538-555); desktop grava no cofre apenas com `remember=true` |
| Leitura | `verifyToken` verifica assinatura, algoritmo fixo, revogação e `sub` (`index.ts` 100-114); `requireAuth` |
| Reinício | **Revogação persiste** (SQLite). **Token do cliente:** persiste se `remember=true`; caso contrário fica só em memória |
| Prova | `api/test/auth-session-restart.test.js` 1/1 PASS; `r6-l12-logout` incluído nos 204 PASS; E2E: logout 204 e pedido seguinte com o mesmo Bearer devolve **401**; linha em `auth_revoked_tokens` = 1 |

**Limitação:** o JWT é *stateless*; a revogação só existe quando o cliente chama `logout`. Um token roubado continua válido até expirar (máx. 7 dias) se não for revogado.

---

## 3. Histórico de análises (scanner)

| Campo | Valor |
|---|---|
| Componente | Serviço (`packages/service/src/scan-history.ts`) |
| Caminho real | `<baseDir>\scans.jsonl` |
| Formato | JSON Lines, uma linha por análise terminal (`completed`, `cancelled`, `failed`) |
| Escrita | Finalização de scan; retenção máxima **200** entradas (`CYBERSAFE_SCAN_HISTORY_MAX`) |
| Leitura | IPC de histórico do serviço / UI |
| Reinício | **Persiste** — ficheiro append-only com compactação para o teto |
| Prova | `packages/service/test/r7-l3-history.test.js` 17/17 PASS; ficheiro real com 30 linhas em 2026-10-31; registo do ensaio de 800 ficheiros presente |
| Privacidade | `target` é `default`/`custom`, não o caminho pessoal; não guarda caminhos de ficheiros |

---

## 4. Histórico de ameaças

| Campo | Valor |
|---|---|
| Componente | Serviço (`packages/service/src/engine.ts`) |
| Caminho real | `<baseDir>\history.jsonl` |
| Formato | JSON Lines; eventos `threat.detected`, `quarantine.added`, `quarantine.failed`, etc. |
| Escrita | `logHistory` → `fs.appendFile` (`engine.ts` 4948) |
| Leitura | histórico de ameaças/quarentena exposto pelo serviço |
| Reinício | **Persiste** |
| Prova | `threat-history-storage.test.js`: 3/4 PASS, **1 FAIL documentado** (ver `TESTES-AUTOMATICOS-VERIFICADOS.md`); o FAIL é de expectativa de teste, não de escrita em disco |

---

## 5. Quarentena e manifestos

| Campo | Valor |
|---|---|
| Componente | Core (`packages/core/src/response.ts`) |
| Caminho real | `<baseDir>\quarantine\manifest.json` + `<id>.quarantine` |
| Formato | Manifesto JSON com entradas (`originalPath`, `quarantinePath`, `fileName`, `sha256`, `verdict`, `riskScore`, `detectionReason`, `quarantinedAt`, `originalMode`, `isolationStatus`); ficheiro isolado com `chmod 000` |
| Escrita | `requestQuarantine` → `QuarantineManager.quarantine` (rename + verificação de digest + confirmação no manifesto); escrita atómica temp+rename |
| Leitura | listagem/restauro; restauro repõe modo original e valida hash |
| Reinício | **Persiste** — manifesto é relido no arranque |
| Prova | `r6-l14-quarantine-security` 10/10 PASS; `r5-quarantine-restore-result` 5/5 PASS; testes core `quarantine-restore-safety` 6/6 e `recovery-quarantine` 7/7 PASS |
| Privacidade | O manifesto contém **caminhos originais** dos ficheiros. Não foi exportado para os relatórios. |

**Limitação de atribuição:** `QuarantineEntry.engine` existe no tipo (`shared-types/src/index.ts` linha 326) mas **nunca é preenchido**; só `detectionReason` (lista de regras) é guardado.

---

## 6. Definições, preferências e políticas

| Dado | Caminho real | Formato | Escrita / leitura | Reinício |
|---|---|---|---|---|
| Preferências da app | `<userData>\settings.json` | JSON (`notificationsEnabled`, opcional `windowMaterial`) | `main.ts` 134-173 | Persiste |
| Política de quarentena | `<baseDir>\protection-policy.json` | JSON | `engine.ts` 938 | Persiste |
| Intenção de proteção | `<baseDir>\protection-intent.json` | JSON (`intencao`), escrita atómica `wx` 0600 | `protection-intent.ts` 94-146 | Persiste |
| Configuração USB | `<baseDir>\usb-protection.json` | JSON | `usb-protection-runtime.ts` 108-110; `UsbConfigStore` | Persiste |
| Definições YARA/ClamAV/hashes | `<baseDir>\definitions\` | Ficheiros de regras e bases | updater/serviço | Persiste |
| Logs | `<baseDir>\error.log`, `logs\*.log`, `api-lifecycle.jsonl` | Texto/JSONL | serviço/API | Persiste (rotação) |

**Prova:** código inspecionado; a existência dos ficheiros foi observada em `<baseDir>` (por exemplo `protection-intent.json`). Não foram alterados.

---

## 7. Consentimentos MATRIX

| Campo | Valor |
|---|---|
| Componente | API + MATRIX |
| Caminho real | `<baseDir>\cybersafe.db`, tabelas `process_consent_grants` e `process_consent_one_shots` |
| Formato | Metadados: fornecedor em hash, finalidade, campos, datas, revisão; token de one-shot só como SHA-256 |
| Escrita | `POST /api/ai/process-consent` e `POST /api/ai/process-consent/one-shot` (`index.ts` 828-886) |
| Leitura | `GET /api/ai/process-consent`; validação em cada envio |
| Reinício | **Persiste** (SQLite) |
| Prova | `process-consent.test.js` e `process-consent-r2.test.js` incluídos nos 204 PASS; base real tem 3 grants e 0 one-shots |
| Privacidade | Sem texto de conversa, sem chaves de API, sem URL do fornecedor |

---

## 8. Resultados de treino (Simulador)

| Campo | Valor |
|---|---|
| Componente | API (`packages/api/src/index.ts` + `db.ts`) |
| Caminho real | `<baseDir>\cybersafe.db`, tabela `training_results` |
| Formato | `id`, `userId` (NULL na prática), `gameType`, `score` inteiro, `maxScore`, `completedAt` |
| Escrita | `POST /api/training-score` (`index.ts` 1090-1111) → `prisma.trainingResult.create` (`db.ts` 301-309) |
| Leitura | `GET /api/training-score` (`index.ts` 1113-1122): últimas 20, **globais** |
| Reinício | **Persiste** |
| Prova | Base real com 1 linha; ensaio E2E: POST 201, GET `totalSessions=1`, `averageScore=83`, linha lida da base com `userId` NULL |
| Limitação | Sem atribuição por conta e leitura global — ver `TREINO-ESTADO-REAL.md` |

---

## 9. Resumo

| Domínio | Persiste após reinício? | Onde |
|---|---|---|
| Contas/credenciais | Sim | SQLite `users` |
| Revogação de sessão | Sim | SQLite `auth_revoked_tokens` |
| Token no cliente | Só com `remember=true` | `auth-session.bin` (DPAPI) |
| Histórico de scans | Sim | `scans.jsonl` |
| Histórico de ameaças | Sim | `history.jsonl` |
| Quarentena | Sim | `quarantine\manifest.json` + `*.quarantine` |
| Preferências/políticas | Sim | `settings.json`, `protection-*.json`, `usb-protection.json` |
| Consentimentos MATRIX | Sim | SQLite (2 tabelas) |
| Resultados de treino | Sim | SQLite `training_results` |

**Não se declara** que estes dados sejam todos SQLite: apenas contas, revogações, consentimentos e treino o são. Históricos, quarentena e políticas são ficheiros JSON/JSONL.
