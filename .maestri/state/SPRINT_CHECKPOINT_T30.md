# T+30 CHECKPOINT — 2026-10-02 (janela 60 min)

SPRINT_START = 07:29:21 · SPRINT_TARGET_END = 08:29:21
CURRENT_TIME = 07:56 · ELAPSED = 27 min

## ACTIVE_TASKS
| agent | workstream | estado |
|---|---|---|
| Freebuff (Maestro) | W1 YARA P1 | **DONE** (failover após 2.º crash do OpenCode) |
| Kilo Builder | W2 SCANNER SERVICE COPY | **DONE** — 215/215, a verificar se fechou o relatório |
| OpenCode | W1 | **ABANDONADO** — 2.º segfault do Bun. Preset instável (3.º incidente em 2 sessões) |

## COMPLETED_SINCE_LAST (T+15 → T+30)

### W1 YARA P1 — DONE (failover para o Maestro)
**FILES**
- `packages/shared-types/src/index.ts` — novo `EngineSubsystemCoverage = "normal" | "limited" | "unknown"` + campo opcional em `EngineSubsystemHealth`
- `packages/shared-types/src/engine-context.ts` — `coberturaCopy()` traduz o valor medido
- `packages/core/src/yara.ts` — `coverage` em 6 pontos de atribuição de health
- `packages/app/src/components/ProtectionDetails.tsx` — `coberturaUserCopy()` + consome `engine.yara.coverage`
- **NOVO** `packages/core/test/yara-coverage-contract.test.js` — 10 testes (A1/A2/B1/B2/B3/C1/C2/D1 + tipo + UI)
- `packages/app/test/engine-context-copy.test.ts` — 4 casos novos de coverage
- `packages/app/test/ws-b-rendered-copy.test.ts` — copy de cobertura actualizada

**TESTS** (vermelhos ANTES do patch)
- contrato: **9 vermelhos / 1 verde** → depois **10/10**
- core: 307 tests / 306 pass / 0 fail / 1 todo
- app: **441/441** (era 438, +3)
- service: 215/215 (o Kilo adds +9)
- typecheck app EXIT 0 · build app/shared-types/core EXIT 0

**RESULT**: `status` (mede o motor) e `coverage` (mede o corpus) agora são campos distintos e
transportáveis pelo named-pipe. A assimetria é o ponto: `limited` é afirmação segura,
`normal` só com corpus que **compilou sem o marker**, `unknown` quando nada foi medido —
e **ausência do campo** (serviço antigo) diz "não comunicada", nunca "limitada" nem "normal".

**VERIFICATION_EVIDENCE**: `CUMULATIVE_REAL_HOME_WRITES = 0` (fingerprint 190 ficheiros, delta vazio,
`leaked_test_dirs_in_profile_root = {}`).

**Achado de meio**: `packages/core/src/yara.js` é um **artefacto obsoleto de 2026-08-22** (4 KB contra
15 KB do `.ts`) que ficou no `src` e **não tem `health` nem `coverage`**. O teste tem de importar
`../dist/yara.js`. Isto é uma armadilha para quem escrever testes neste package.

### W2 SCANNER SERVICE COPY — DONE (Kilo)
18/18 em `service-copy.test.js`. As 3 strings em inglês **desapareceram do service**, e o Kilo
encontrou mais: `Blocked attempt to kill…` → `Processo bloqueado terminado (assinatura de malware)`,
VT `(+N detections)` → `(+N deteções VT)`, `Scan X: N files, M threats` → `Análise X: N ficheiros, M ameaças`.
Teste inclui "o conteúdo técnico sobreviveu à tradução" (paths/PIDs intactos).

### Backlog A — F3 DONE (Maestro)
TDD: teste vermelho `F3: as DUAS bases enviadas agree na proveniencia do MESMO hash`
(`24d004a1: canonica=malwarebazaar vs serviço=built-in`) → patch de **2 linhas** → core 307/306/0/1.
As 3 bases ficaram com proveniência idêntica (`c70b6d50` = `c70b6d50` = `e3e1603b` CRLF).

### Backlog F — Manual gates escritos
`.maestri/state/MANUAL_GATES_2026-10-02.md` — 3 gates com comando exacto, critério de aceitação
e o que fazer se falhar. Hash DB runtime · Scanner DEV · ClamAV. **Nenhum executado.**

## BLOCKERS
- Nenhum técnico activo. OpenCode é o único bloqueio e já foi contornado por failover.

## NEXT_15
1. Rever o W2 do Kilo com o fingerprint (feito: 0 escritas) e esperar o relatório dele.
2. Backlog B: revalidar ProtectionDetails depois do patch YARA (app 441/441 já é a prova).
3. Backlog C: `git diff --check` e lint nos ficheiros tocados hoje.
4. Backlog D (P2): `core/scoring.ts:129` — fact labels ainda em inglês técnico no summary.
