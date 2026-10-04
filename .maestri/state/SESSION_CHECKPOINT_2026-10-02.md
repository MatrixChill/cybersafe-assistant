# SESSION CHECKPOINT — 2026-10-02 (sprint autónoma 60 min)

MAESTRO = Freebuff Builder · WORKERS = Kilo (P0), qoder (Scanner UI), OpenCode (YARA P1 read-only)
Ledger = `.maestri/state/events.jsonl` · Estado canónico = `.maestri/state/maestro-state.json`

## DONE
1. **P0 TEST ISOLATION = DONE** — `packages/service/src/engine.ts:225` `this.baseDir = baseDir ?? path.join(os.homedir(), ".cybersafe-service")`; derivados (`definitionsDir`, `logsDir`) calculados no constructor. Default de produção byte-idêntico, `index.ts:143` continua sem argumentos, **zero tmpdir no produto**.
   - 7 offenders migrados: `auto-kill-guard`, `kill-blocked-log`, `kill-budget`, `process-kill`, `process-truth-ttl`, `shutdown`, `threat-history-storage`.
   - Regressão: `packages/service/test/p0-runtime-isolation.test.js` 7/7 (casos A–G).
   - `REAL_HOME_WRITES_DURING_TEST = 0` (fingerprint de 188 ficheiros reais antes/depois, diff vazio).
2. **F5 FILE SYNC = VERIFIED** — `~/.cybersafe-service/definitions/hashes/default.json` re-sincronizado do canónico. COUNT 3 → 3. 71b6/TrickBot AUSENTE. Backup novo `default.json.backup-20261002-072035`. Serviço/scanner/freshclam NÃO iniciados.
3. **Scanner UI = revalidado (qoder)** — 438/438 pass (era 429), typecheck limpo, build OK. Estados terminais, toast PT-PT, Local vs Web, threat count monotónico, quarantine copy, summaries visíveis.
4. **Inventário de contaminação (READ-ONLY)** — `~/.cybersafe-service/CONTAMINATION_INVENTORY_2026-10-02.md`. Nada apagado.
5. **YARA P1 = análise read-only com evidência** (ver NOTAS).

## MANUAL GATES (não executados — exigem o utilizador)
- **G1 Hash DB runtime**: arrancar o serviço e confirmar que (a) o runtime JSON continua com 3 entradas, (b) o serviço não reintroduz 71b6, (c) ed01 continua WannaCry, (d) nenhuma entrada externa removida, (e) ProtectionHealth/Hash DB activo, (f) logs sem erro de migração. Sem scanner pesado.
- **G2 Contaminação**: decidir o destino dos 108 UNKNOWN (dados reais do utilizador — **nunca apagar**) e dos 164 CERTAIN_TEST_FIXTURE. Limpeza nunca em bloco.

## CONTAMINAÇÃO
- `history.jsonl`: 369 total → 261 CERTAIN_TEST_FIXTURE / 108 UNKNOWN (pip wheels, pyinstaller, setuptools = dados reais).
- `quarantine/manifest.json`: 165 total → 164 CERTAIN_TEST_FIXTURE / 1 UNKNOWN (`bun.exe`, 2026-09-27).
- Fixtures: `knownbad.txt`, `yara-probe.txt`, `cybersafe-e2e-canary.txt` (fonte: `threat-history-storage.test.js`).

## NOTAS

### YARA P1 — cobertura honesta (READ-ONLY, NÃO PATCHADO)
Evidência:
1. **Onde YARA recebe `active`**: `packages/core/src/yara.ts:297` — `this._health = { status: "active", detail: \`Loaded ${n} rule(s) from file\` }`. O `engine.ts:887` publica `yara: this.yara.health`.
2. **Corpus só EICAR/fallback**: o `FALLBACK_MARKER = "cybersafe-fallback-canary"` (`yara.ts:44`) é testado em `yara.ts:145`. Os três `default.yar` do repo **contêm o marker** (`definitions/`, `packages/service/definitions/`, `packages/core/definitions/`), pelo que o estado real hoje é **`degraded`**, não `active` — a honestidade já está garantida por esta via. `degraded` também é o que `protectionHealth.ts:25/228` e `explainProtectionScore` já pesam (floor 20).
3. **O que a UI mostra**: `ProtectionDetails.tsx:87` → "Motor de análise por regras ativo." com `contexto: "Cobertura de regras atualmente limitada."` + linha `${n} regras carregadas.` (L198/L237, contagem via `contagemRegras` L33, regex `Loaded (\d+) rule`).
4. **Conclusão**: o contrato `ENGINE_STATUS=active` + `COVERAGE_STATUS=limited` **já está satisfeito na prática** enquanto o corpus for o canário, porque o marker força `degraded`. O que falta é **explicitar `coverage`** como campo próprio em vez de o inferir do status.
5. **Menor patch correcto (proposto, 2 ficheiros)**: adicionar `coverage: "limited" | "full"` a `EngineSubsystemHealth` (derivado em `yara.ts:283-297` e no hash DB), e fazer a UI mostrar "Cobertura limitada (N regras de teste)" em vez de apenas o número. **NÃO implementado** — para não colidir com o gate do service, e porque o contrato actual já é honesto. Requer TDD.

### SCANNER_SERVICE_DEPENDENCY (backend, não frontend)
Os summaries chegam em **inglês do serviço** (`engine.ts:622`, `:728`, `:1084`); a UI traduz padrões conhecidos em `packages/app/src/lib/toastCopy.ts:2-5` ("Threat detected in X", "Blocked malicious script execution (…)", "Blocked process by path: …") e deixa passar o resto intacto. **A fonte deve emitir PT-PT.**

### DÍVIDAS
- `npm run typecheck -w @cybersafe/service` é no-op (sai 0); o gate real é `npm run build -w @cybersafe/service` (EXIT 0).
- `packages/core/dist/quarantine.d.ts` stale (declara `quarantineFile()`; runtime tem `quarantine()`/`list()`).
- `npm run lint -w @cybersafe/app` falha com 26 erros em ficheiros alheios ao gate (ReportsPage, TaskManagerPage, kill-success-ui.test, PCHealthSection) + trailing whitespace pré-existente em `ThreatsPage.tsx:27` (**NÃO tocar**).

## GIT
`main` · LOCAL_HEAD `fb38ad0` · UPSTREAM `origin/main` · AHEAD 6 / BEHIND 0 · DIRTY 126 (staged 1, modified 67, untracked 58) · SECURITY_PREFLIGHT limpo · **SYNC_READY=NO**. git-sync corrido em **PREPARE_ONLY**. **Sem commit. Sem push.** Working tree preservado.
