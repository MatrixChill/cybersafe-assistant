# TESTES AUTOMÁTICOS VERIFICADOS — COMANDOS, LOGS E RESULTADOS

> **Código testado:** `MatrixChill/cybersafe-assistant` @ `212cb64c39f74f547d4ebc6c8bff7cc5bcbcdf56`
> **Candidata:** `0.1.10-internal.pap-r5.20261031` (SHA-256 `46718BCD…BD75`) — **não** reinstalada nem alterada
> **Natureza:** execução real de testes em clone isolado; logs em `PAP-EVIDENCIAS-TECNICAS/logs/`.
> **Regra:** PASS, FAIL e SKIP são declarados separadamente. **Não se apresenta a suíte completa como 100% aprovada.**

---

## 1. Isolamento

| Item | Detalhe |
|---|---|
| Clone | `PAP-EVIDENCIAS-TECNICAS/_work/clone-212cb64` |
| Commit verificado | `git rev-parse HEAD` = `212cb64c39f74f547d4ebc6c8bff7cc5bcbcdf56` |
| Dependências | `node_modules` ligado por *junction* à árvore de desenvolvimento, com `node_modules/@cybersafe/*` **re-apontado para os pacotes do clone** |
| Garantia | `require.resolve('@cybersafe/core')` e `@cybersafe/service` resolvem para `.../clone-212cb64/packages/*` (verificado) |
| Runtime | Node v24.13.0; Windows 10.0.26300; x64 |
| Build | `shared-types`, `native-windows`, `core`, `api`, `service` — todos com **exit 0** (`logs/build-*.log`) |
| Alterações a testes | **Nenhuma.** Os ficheiros de teste não foram editados |

**Limitação do isolamento:** as dependências de terceiros vêm da árvore de desenvolvimento (mesma versão do `package-lock.json`), não de uma instalação limpa `npm ci`. O código executado é o do clone; as dependências não são o objeto do teste.

---

## 2. Comandos executados

```bash
# API — autenticação, revogação, consentimento, isolamento de DB
cd packages/api
node --test --test-concurrency=1 \
  test/auth-role.test.js test/auth-role-production.test.js test/auth-jwt-secret.test.js \
  test/auth-api-guard.test.js test/r6-l12-logout.test.js test/dev-isolation.test.js \
  test/process-consent.test.js test/process-consent-r2.test.js \
  test/provision-admin.test.js test/rotate-jwt-secret.test.js

node --test --test-force-exit --test-concurrency=1 test/auth-session-restart.test.js

# Serviço — pipe, quarentena, persistência, histórico
cd packages/service
node --test --test-force-exit --test-concurrency=1 test/<ficheiro>.test.js   # um por um

# Core — pipe auth e quarentena
cd packages/core
node --test --test-force-exit --test-concurrency=1 test/<ficheiro>.test.js

# Desktop — cofres de sessão e credenciais e credencial do pipe
cd packages/desktop
node --import tsx --test test/<ficheiro>.test.mjs
```

---

## 3. Resultados — PASS

| Grupo | Ficheiros | Tests | PASS | FAIL | SKIP | Log |
|---|---|---:|---:|---:|---:|---|
| API (lote principal) | 10 | 204 | **204** | 0 | 0 | `logs/api-auth-persistence.log` |
| API `auth-session-restart` | 1 | 1 | **1** | 0 | 0 | `logs/api-auth-session-restart.log` |
| Serviço `s4-pipe-auth` | 1 | 9 | **9** | 0 | 0 | `logs/service-s4-pipe-auth.log` |
| Serviço `qa2-pipe-handshake-v2` | 1 | 5 | **5** | 0 | 0 | `logs/service-qa2-pipe-handshake-v2.log` |
| Serviço `r6-l14-quarantine-security` | 1 | 10 | **10** | 0 | 0 | `logs/service-r6-l14-quarantine-security.log` |
| Serviço `r5-quarantine-restore-result` | 1 | 5 | **5** | 0 | 0 | `logs/service-r5-quarantine-restore-result.log` |
| Serviço `recovery-quarantine-policy` | 1 | 1 | **1** | 0 | 0 | `logs/service-recovery-quarantine-policy.log` |
| Serviço `r6-l11-persistence` | 1 | 5 | **5** | 0 | 0 | `logs/service-r6-l11-persistence.log` |
| Serviço `r7-l3-history` | 1 | 17 | **17** | 0 | 0 | `logs/service-r7-l3-history.log` |
| Core `pipe-auth` | 1 | 20 | **20** | 0 | 0 | `logs/core-pipe-auth.log` |
| Core `quarantine-restore-safety` | 1 | 6 | **6** | 0 | 0 | `logs/core-quarantine-restore-safety.log` |
| Core `recovery-quarantine` | 1 | 7 | **7** | 0 | 0 | `logs/core-recovery-quarantine.log` |
| Desktop `auth-session-store` | 1 | 6 | **6** | 0 | 0 | `logs/desktop-auth-session-store.log` |
| Desktop `auth-session-ipc` | 1 | 3 | **3** | 0 | 0 | `logs/desktop-auth-session-ipc.log` |
| Desktop `qa2-pipe-credential` | 1 | 13 | **13** | 0 | 0 | `logs/desktop-qa2-pipe-credential.log` |

**Subtotal das linhas acima:** 312 testes, 0 SKIP.

### Composição do total de 315 PASS

O total dirigido não é a soma das linhas da tabela; é a soma dessas linhas **mais** os 3 testes que passam no ficheiro parcialmente falhado (§4):

| Parcela | Testes | PASS | FAIL | SKIP |
|---|---:|---:|---:|---:|
| Linhas da tabela (§3) | 312 | 312 | 0 | 0 |
| `threat-history-storage.test.js` (§4) | 4 | 3 | 1 | 0 |
| **Total de testes únicos** | **316** | **315** | **1** | **0** |

O ficheiro `threat-history-storage.test.js` foi executado três vezes (`service-threat-history.log`, `service-threat-history-forceexit.log`, `service-threat-history-alone.log`); conta **uma vez** e o seu resultado é o determinístico (`--test-force-exit`): 3 PASS / 1 FAIL. Os logs sem bloco de resumo TAP (`service-auth-persistence-quarantine.log`, `service-threat-history-alone.log`) são prova de apoio e **não** entram na contagem. Só entram na contagem os 17 logs com resumo.

---

## 4. Resultados — FAIL

| Ficheiro | Tests | PASS | FAIL | SKIP | Exit | Log |
|---|---:|---:|---:|---:|---:|---|
| `packages/service/test/threat-history-storage.test.js` | 4 | 3 | **1** | 0 | **1** | `logs/service-threat-history-forceexit.log` |

### Teste que falha

`critical (hash registado numa base de teste) entra em this.threats`

```
AssertionError [ERR_ASSERTION]: a base de teste tem de substituir a base embutida
  actual: 4
  expected: 1
  em test/threat-history-storage.test.js:147
```

### Causa técnica (verificada no código)

- O teste grava uma base com **1** hash e chama `engine.signatures.load(dbPath)`; em seguida exige `engine.signatures.size === 1`.
- `SignatureDatabase.load` (`packages/core/src/signatures.ts` 243-287), ao detetar que a base carregada não contém os hashes built-in obrigatórios, **repõe em memória** as assinaturas built-in em falta (`ensureOfflineCoverage`) e marca a base como `degraded`. O resultado é **3 built-ins + 1 de teste = 4**.
- Ou seja: o comportamento do produto é intencional (não perder a cobertura offline, incluindo EICAR), e a expectativa do teste ficou desatualizada face a essa regra. **Não é uma falha de escrita em disco nem de persistência**; as outras três asserções do ficheiro passam.
- **Não foi alterado** o teste nem o produto para “fazer passar”. A falha é registada como falha.

### Nota de execução

Sem `--test-force-exit`, o processo de teste termina a execução e imprime o resumo, mas **não sai** (handles abertos do serviço/updater); foi inicialmente interrompido por `timeout` (exit 124). A reexecução com `--test-force-exit` devolveu o resultado determinístico acima (exit 1). Isto é um problema de *harness*, separado do FAIL funcional.

---

## 5. Resultados — SKIP

Nenhum teste foi marcado **SKIP** nestes grupos. Os ficheiros não executados **não** são declarados como SKIP: são simplesmente **não executados** (ver §7).

---

## 6. Ensaio de integração E2E (PASS)

Além dos testes, foi executada a API real do clone com base temporária:

- `NODE_ENV=production`, `CYBERSAFE_DB_PATH=<temp>/e2e-cybersafe.db`, porta 4317.
- Registo **201** → treino **201** (`score=83`, `maxScore=6`) → leitura **200** (`totalSessions=1`, `averageScore=83`) → login **200** → logout **204** → mesmo token **401**.
- Leitura read-only da base: 1 linha em `training_results` (`userId` NULL), 1 em `users`, 1 em `auth_revoked_tokens`.
- Resultado: **PASS**. Evidência: `raw/e2e-api/e2e-result.json`, `raw/e2e-api/e2e-server.log`.

---

## 7. O que NÃO foi executado (e por isso não é declarado)

- A suíte completa de `service`, `api`, `core`, `desktop`, `app` e `native-engine`.
- Testes que exigem a instalação Windows real, Defender, hardware USB, rede externa ou GUI.
- Testes de `detection-quality`, `clamav-*`, `scan-manager` completos e demais ficheiros não listados.
- `npm test` de qualquer workspace (que inclui dezenas de ficheiros não relacionados com esta missão).

**Conclusão honesta:** no conjunto dirigido, **315 PASS / 1 FAIL / 0 SKIP**. Isto **não** é “a suíte está 100% aprovada”; é o resultado do conjunto necessário para autenticação, persistência, quarentena e integração.

---

## 8. Ruído ambiental observado (não afeta os resultados acima)

- O updater tentou atualizar definições durante os testes; `MalwareBazaar HTTP 401` e adiamentos de `freshclam` apareceram nos logs. Nenhum teste dirigido depende desses feeds; as asserções relevantes passaram (exceto o FAIL documentado, cuja causa é de expectativa/código, não de rede).
- Nenhuma conta, histórico, quarentena ou ficheiro da instalação foi apagado ou alterado.
