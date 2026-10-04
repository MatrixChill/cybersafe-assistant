# SESSION CHECKPOINT — 2026-10-01

Estado canónico no fecho da sessão. **Nada disto é DONE.**
Escrito pelo Maestro (Freebuff Builder) por ordem de shutdown do utilizador.

## GIT (read-only, medido no fecho)

```
BRANCH          = main
UPSTREAM        = origin/main
HEAD            = fb38ad0
REMOTE_KNOWN    = b946c30
AHEAD           = 6
BEHIND          = 0
DIRTY           = 121 (staged 1, modified 64, untracked 56)
GIT_SYNC_STATE  = CLEAN_AHEAD
SYNC_READY      = NO
AUTO_COMMIT     = NO   |  AUTO_PUSH = NO
DIFF_CHECK      = 1 trailing whitespace pré-existente em
                   packages/app/src/pages/ThreatsPage.tsx:27 (NÃO TOCAR)
SECURITY_PREFLIGHT = limpo
```
Nada foi commitado. Nada foi pushado. Nada foi revertido.
Working tree preservado integralmente.

## HASH DB F2 — IMPLEMENTED + VERIFIED

`healLegacyRecords` deixou de apagar por *family*. Agora só remove SHA-256
declarados em `RETIRED_HASH_SIGNATURES`. Regra adoptada: **SHA-256 = identidade
primária; family = metadata.**

Verificado por:
- external collision preservada (SHA externo com family de built-in sobrevive, `source` intacto)
- built-in com metadata antiga = metadata CORRIGIDA, nunca apagado
- 71b6/TrickBot removido por lista explícita de SHA, nunca por family
- 2.ª execução = delta zero, igualdade de bytes
- Kilo review: **PASS**
- G1 (MEDIUM, corrigido): a prova do EICAR fabricado afirmava "+32 zeros" —
  era falso, a derivação é desconhecida. Texto reescrito só com o verificável.

```
TESTS = core 306 tests / 305 pass / 0 fail / 1 todo
        service 198/198
        typecheck EXIT=0
```

**HASH DB GLOBAL = NOT DONE.**
Motivo: o gate de testes não é confiável enquanto o P0 de isolamento existir.

## P0 — TEST ISOLATION (NOVO, BLOQUEANTE)

```
TASK  = Isolar testes do runtime real do utilizador
ROOT  = packages/service/test/threat-history-storage.test.js cria
        new ProtectionEngineService() sem override de baseDir
        packages/service/src/engine.ts:121  baseDir = os.homedir()/.cybersafe-service
        (sem override possível)  → engine.init() corre refreshBuiltinIfStale()
        + quarantine.init() e escreve no runtime REAL
ALSO  = packages/service/test/process-kill.test.js:420 escreve em
        ~/.cybersafe-service/logs (mesma classe)

ESCRITA EM (medido por mtime nesta sessão):
  definitions/hashes/default.json       22:38  (healed durante o gate)
  quarantine/*.quarantine + manifest    22:41
  history.jsonl, logs/security-events.log 22:41
```
`boot-debug.log` confirma: último arranque do serviço = 2026-09-30T20:29.
Não foi o serviço, não foi o utilizador. Foi `npm test`.

**REGRA ATÉ O P0 SER CORRIGIDO:**
- PROIBIDO correr suites que instanciem o service contra o homedir real
- NÃO usar `npm test` indiscriminadamente
- Primeiro: baseDir injectável, definitionsDir injectável quando necessário,
  testes em tmpdir, zero escrita em ~/.cybersafe-service
- Regressão obrigatória: `TEST_RUNTIME_ISOLATED = SIM`

## RUNTIME_CONTAMINATION = CONFIRMED (NÃO limpo hoje)

```
~/.cybersafe-service/history.jsonl
~/.cybersafe-service/logs/security-events.log
~/.cybersafe-service/quarantine/
manifest de quarantine
```
Fixtures de teste presentes: `knownbad.txt`, `yara-probe.txt`, `cybersafe-e2e-canary.txt`
Próxima sessão: obter lista exacta, distinguir dados reais vs fixtures.
**Nunca apagar em bloco.**

## F5

```
F5_SYNC   = NOT AUDITED
RUNTIME   = 3 hashes, 71b6/TrickBot AUSENTE
```
Isto aconteceu como **efeito colateral do teste**, não por decisão auditada.
O resultado é o pretendido; o processo não é. Não considerar F5 validado.
Depois do P0: re-sync auditado + runtime test controlado.

Backup existente (NÃO ALTERAR):
`~/.cybersafe-service/definitions/hashes/default.json.backup-20261001-225244`

## F3 = P2 / NOT REQUIRED FOR DEMO

`source`/proveniência diverge entre os dois JSON (raiz: 2× malwarebazaar;
service: 3× built-in). SHA e família das 3 entradas coincidem.
Não affecting detecção. Ficheiros:
`definitions/hashes/default.json`, `packages/service/definitions/hashes/default.json`

## PENDENTES

```
YARA P1          = PENDING
SCANNER GATES    = PENDING
CLAMAV MANUAL    = PENDING
```

## AGENTES

```
MAESTRO = Freebuff Builder
OpenCode / Kilo / Codex / qoder / kiro / Antigravity / Shell = parados, sem trabalho em curso
LUNA = TASK_READY
```
Sem reestruturação Maestri.

## NEXT — por esta ordem exacta

1. P0 — isolar todos os testes do ~/.cybersafe-service real
2. criar/regredir teste que prove zero escrita no homedir
3. identificar contaminação exacta sem apagar
4. limpar apenas fixtures comprovadas
5. F5 re-sync auditado
6. runtime Hash DB test
7. só depois YARA P1

## GITHUB_ACTION_REQUIRED = SIM (utilizador)

6 commits por push, 121 entradas por commitar. Nada feito, por ordem.