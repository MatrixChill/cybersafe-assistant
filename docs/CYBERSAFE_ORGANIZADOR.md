# CyberSafe Assistant — Organizador

> **Fonte:** espelho em Markdown de `docs/cybersafe-organizador-pap-v2-editavel.html` (a lista de tarefas e os `id` são exatamente os mesmos, para não haver duplicação) **+ atualizações confirmadas da Sprint 3 (2026-09-25)**.
> Regra editorial: só fica marcado como concluído aquilo que está implementado e testado (manual quando necessário). Tarefa implementada mas ainda à espera de validação manual fica **Em curso**. Não se descreve como pronto o que não existe.

## Legenda

| Estado | Significado |
|---|---|
| ✅ **Concluído** | Implementado e testado (validação manual feita quando era necessária) |
| 🟡 **Em curso** | Implementado mas ainda precisa de validação manual, ou descoberta nova ainda não resolvida |
| ⚪ **Planeado** | Ideia futura / ainda não iniciada |
| ⛔ **Bloqueado** | Impedido por algo externo |

---

## Registo da Sprint 3 — 2026-09-25

**Foco:** P0-A (bug do scanner: toast `THREAT.DETECTED` mas "0 ameaças").

**Causa raiz confirmada** (evidência: `~/.cybersafe-service/logs/security-events.log`, 2026-09-24 21:34):

- **D2 — contrato inconsistente:** `engine.ts` publica `threat.detected` sempre que `finalSeverity !== "low"` (inclui `medium`), mas `scan-manager.ts` só contava ameaça se `highRiskCount > 0 || severity high/critical` → toast sim, contador 0.
- **D1 — base de hashes em disco estagnada:** `~/.cybersafe-service/definitions/hashes/default.json` tinha um hash EICAR **fabricado** (`44d88612…`, MD5+zeros) e `ensureFile()`/`seedDefinitions()` só semeiam se o ficheiro **faltar**, logo a correção nunca chegava ao runtime. O EICAR real nunca dava match.

**Correções entregues (builder) e verificadas de forma independente (Maestro):**

- **D2:** critério único de "ameaça" no loop principal e em `scanZipWithSafety` — `highRiskCount > 0 || severity ∈ {high, critical, medium}` — alinhado com o `engine.ts`. Regra documentada em comentário no código.
- **D1:** `BUILTIN_HASH_SIGNATURES` com o SHA-256 **real** do EICAR (`275a021b…`); novo `refreshBuiltinIfStale()` chamado no `init()` do serviço (re-semeia a base em disco quando contém registos legados); `packages/service/definitions/hashes/default.json` empacotado pela primeira vez.
- **Infra de teste:** canário dev-only (`DEV_CANARY_SIGNATURE` / `DEV_CANARY_CONTENT`, `family: CyberSafe-Test-File`, severidade `medium`, ativo só fora de `NODE_ENV=production`) para testar o pipeline E2E **sem depender do EICAR real** (que dispara o Windows Defender).

**Validação manual (utilizador) — PASS:** scan de `test-canary/cybersafe-e2e-canary.txt` na UI → 1 ficheiro verificado, 1 ameaça encontrada, toast `THREAT.DETECTED`, scan terminou normalmente, **sem quarentena** (comportamento pretendido: `medium`/`logged`).

**Verificação de logs pelo Maestro (2026-09-25 07:45:56Z / 08:45:56 local):**

- `threat.detected` emitido — confirmado (`evt-1790322356449-292`, `severity medium`, `confidence 0.99`, `riskScore 55`, `action logged`), também em `history.jsonl`.
- Deteção por `dev_canary_signature` com o SHA-256 real do ficheiro.
- **Importante:** a deteção valida o **canário dev**, não o EICAR real. A deteção do EICAR real ponta-a-ponta ainda **não foi observada** (a base em disco já foi migrada, o que valida a migração do D1).
- **Limitação de observabilidade descoberta:** `scan.progress` / payload `completed` são IPC-only e **nunca** são persistidos (0 eventos `scan.*` em 72 634 linhas de log) — por isso o contador `threatsFound` não é verificável a partir dos logs; o sintoma P0-A era invisível na evidência persistida.

**Delta revisto depois da primeira revisão** (o builder continuou a trabalhar): `shared-types` (nova regra `dev_canary_signature`), `core/signatures.ts`, `core/scoring.ts` (peso 55 → banda `medium`), `core/analysis.ts` (deteção do canário também por conteúdo e exclusão do `known_bad_hash`), `desktop/main.ts` (`NODE_ENV=production` no spawn do serviço), `service/package.json`, novo `packages/service/test/dev-canary.test.js`.

**Testes (corridos pelo Maestro sobre o código atual):**

| Comando | Resultado |
|---|---|
| `npm test -w @cybersafe/core` | ✅ 128/128 PASS |
| `npm test -w @cybersafe/service` | ✅ 53/53 PASS (inclui 2 E2E do canário) |
| `node --test packages/service/test/dev-canary.test.js` | ✅ 2/2 PASS |
| `npm run typecheck` | ✅ PASS (todos os workspaces) |
| `git diff --check` | ✅ limpo |

**Estado:** D1 e D2 marcados como concluídos. Sem commit e sem push (a pedido). WIP não commitado preservado; branch `main`, HEAD `5e276aa`, ahead 5.

**Alterações feitas neste ficheiro nesta sprint:** `scan-file-runtime` → Concluído; `scan-threat-counter` (nova) → Concluído; `rep-e2e-canary` (nova) → Concluído; `scan-zip-nested-count` (nova), `scan-observability` (nova), `arch-log-hygiene` (nova), `health-taskmanager` (nova) → Em curso; notas atualizadas em `scan-runtime-quality`, `scan-full-smoke`, `prot-hash`, `prot-hash-update`, `pap-testing`. Nada foi removido.

O organizador visual oficial é `docs/cybersafe-organizador-pap-v2-editavel.html`; a partir desta sprint toda a mudança de tarefa (nova tarefa, estado ou nota) é aplicada **nos dois ficheiros** com os mesmos ids. Sprint P0 Gestor de Tarefas (2026-09-25, builder qoder): `health-taskmanager` mantém-se Em curso com o patch pronto e à espera de validação manual (nenhuma tarefa nova criada — a existente foi atualizada). O HTML mantém-se funcional e editável e o seu layout não foi alterado. Ao sincronizar, subir também o `DATA_VERSION` no HTML: os estados são guardados por `id` no `localStorage` do browser e, sem isso, o browser continua a mostrar estados antigos mesmo com o ficheiro correto. Validação de fecho de sprint: comparar nº de tarefas, ids (comuns/faltantes/duplicados) e estados/rótulos/notas entre os dois ficheiros, e reportar o bloco `ORGANIZADOR SYNC` (detalhe na nota Maestri "REGRA ORGANIZADOR (PERMANENTE)").

**Sprint 4 (2026-09-25, maestro Qoder):** **Nota honesta sobre o backend local:** o alias `qwen3-coder` foi criado com `ollama cp qwen2.5-coder:latest qwen3-coder` — é **Qwen 2.5 Coder atrás de um alias de compatibilidade**, não evidência de Qwen 3 real. `health-taskmanager` revisto — diff confirmado sem regressão, testes focados verdes (core 140, service 66, app 147, desktop 29), mantém **READY FOR MANUAL TEST** (validação manual do utilizador pendente). Nova `ui-degraded-copy` concluída (tray + ReportsPage sem "Degradada" visível). `scan-zip-nested-count` delegada a **kiro** (builder auto; aprovações de leitura confiadas por diretório). `arch-log-hygiene`/`scan-observability` ficam sem builder esta sprint: Aider/Goose/Continue dependem do provider local `127.0.0.1:11434` (em baixo), Kilo presa num diálogo de update, Freebuff/Crush/OpenCode/Codex/Antigravity indisponíveis. **Shell Tester** operacional como executor de probes. Estado real ProtectionHealth (LIVE probe 2026-09-25 via `scripts/protection-state-probe.mjs` com serviço dev ativo): yara=**active** (1 regra), hashDb=**active** (4 assinaturas), nativeEngine=**active** (scan-engine.exe), clamav=**degraded** — instalado via Chocolatey mas database dir ilegível (correr `freshclam`; corrigir leitura da pasta em `C:\ProgramData\chocolatey\lib\clamav\...\database`), firewall=**unavailable** (WFP filter não arrancado — esperado sem serviço elevado a admin). *Correção honesta à nota anterior da Sprint 4: o binário ClamAV EXISTE (via choco); o que falha é a base de assinaturas.*

---

## Fundação
_Arquitetura & Base do Produto — estrutura técnica que sustenta o CyberSafe._

- ✅ `arch-monorepo` — Monorepo TypeScript com React + Electron + Vite + Node.js
- ✅ `arch-flow` — Arquitetura React → Electron/Preload/IPC → Serviço local → Core/Windows/Motores
- ✅ `arch-pipe` — Comunicação local por named pipe / RPC
- ✅ `arch-shared` — Contratos partilhados em shared-types
- ✅ `arch-packages` — Packages app, desktop, service, core, api, native-windows, native-engine, shared-types e extension
- ✅ `arch-truth` — Princípio de verdade: indisponível/degradado/erro quando um motor ou sensor não funciona
- ✅ `arch-personal-business` — Distinção de conta Personal vs Business
- 🟡 `arch-build` — Build, typecheck e suites de testes como gate de qualidade — _Typecheck, build e as suites por workspace estao a funcionar como gate (o Maestro corre-o centralmente; 2026-09-26: typecheck verde, app 182/182, core 179/179, service 110/110). **Duas dividas pre-existentes registadas sem suprimir regras:** (a) `npm run lint` na raiz falhava porque `packages/desktop` nao tinha script `lint` - o gate de lint estava incompleto, nao era um problema do codigo; (b) `packages/app` tem 13 erros eslint pre-existentes (8 `no-explicit-any`, 3 `react-hooks` comportamentais, 1 `no-unused-vars`, 1 `no-empty`) - ficam como follow-up, nenhuma regra foi desligada nem escondida._
- 🟡 `arch-clean` — Eliminar warnings/runtime noise recorrente que atrapalha diagnóstico (watchers EPERM, etc.) — _Não bloqueia o produto, mas ainda aparece no runtime._
- ✅ `arch-log-hygiene` — NOVO (2026-09-25) — Higiene dos logs de runtime do serviço (rotação/limite de tamanho) — _Descoberta 2026-09-25: `error.log` com 3,4 GB e `boot-debug.log` com 3,2 GB em `~/.cybersafe-service`, sem rotação. Risco de disco e de diagnóstico. 2026-09-25 (Qoder): delegada a Kilo Builder após recovery do pool (Matrix Local reanimado via Ollama + alias `qwen3-coder`; Kilo auto no free gateway); write scope `log-writer`/`index`/`engine` (só logging), proibido `scan-manager` (kiro). DONE (Kilo entregou, Qoder reviu): causa raiz = `appendFileSync` cru sem rotação + ciclo de realimentação EPIPE (`console.error` dentro do handler de `uncaughtException` reentrava no próprio handler, ~600 B de stack por iteração); fix = rotação por tamanho + retenção real (unlink), `safeWrite` + guarda `inCrashHandler`, reclaim de emergência no próximo boot (trunca 3,3/3,1 GB para a cauda — único ponto de perda de histórico, só acima do orçamento), dedupe `xN`, orçamento 32 MB; 24 testes novos; service 95/95, typecheck/lint/build:all OK._

## Antivírus & Análise de Segurança
_Scanner real, análise rápida/profunda, ficheiro, pasta e ZIP._

- ✅ `scan-name` — Renomear “Scanner de Ficheiros” para “Análise de Segurança”
- ✅ `scan-quick-name` — “Análise Rápida do Computador” com descrição clara para utilizadores leigos
- ✅ `scan-deep-name` — “Análise Profunda do Computador” em vez de “Análise Completa”
- ✅ `scan-file` — Analisar um Ficheiro com picker nativo e UX própria
- ✅ `scan-folder` — Analisar uma Pasta com picker openDirectory e progresso por pasta
- ✅ `scan-zip` — ZIP inspecionado por conteúdo (não apenas como blob/nome)
- ✅ `scan-zip-safety` — Proteções ZIP: zip-slip, depth, entries, bytes extraídos, ratio/bomb, corrupt archive, cleanup e cancelamento
- ✅ `scan-pipeline` — Pipeline end-to-end start → scanId → progresso → terminal com buffer de eventos precoces
- ✅ `scan-resync` — getActiveScan / ressincronização ao sair da página e voltar
- ✅ `scan-one` — Um clique = um scan; single active scan também protegido no backend
- ✅ `scan-cancel` — Cancelamento real no backend + estado terminal cancelado
- ✅ `scan-zero` — Pasta/scan com 0 ficheiros termina explicitamente
- ✅ `scan-exclusions` — Corrigir exclusões perigosas: .exe/.dll/.zip/.lnk/.msi/.sys/.ps1 chegam aos motores; Downloads não é trusted
- ✅ `scan-quick-scope` — Quick Scan por risco/recência, depth 2, budget 800 e diretórios prioritários
- ✅ `scan-file-targetkind` — targetKind file/directory + nome do ficheiro disponível desde o início
- ✅ `scan-file-runtime` — Confirmação visual manual final do scan de ficheiro único no Electron — _Concluído 2026-09-25: manual test PASS na UI (1 ficheiro verificado, 1 ameaça, toast `THREAT.DETECTED`, sem quarentena), confirmado por `threat.detected` no log. Alvo usado: canário dev._
- ✅ `scan-threat-counter` — NOVO (2026-09-25) — Coerência entre o toast `THREAT.DETECTED` e o contador `threatsFound` (P0-A) — _Causa raiz: `engine.ts` publicava `medium` e o `scan-manager.ts` só contava `high/critical` → toast 1, contador 0. Corrigido com um critério único (`highRiskCount > 0 || severity high/critical/medium`) alinhado entre os dois. Validado manualmente e por testes._
- 🟡 `scan-deep-scope` — Auditar/ajustar scope real da Análise Profunda para que a copy não prometa “todo o computador” sem ser verdade — _Precisamos confirmar volumes/paths/limites reais antes de fechar._
- 🟡 `scan-safe-copy` — Trocar “Ficheiros Seguros” por copy mais honesta (“Sem ameaças detetadas” / “Sem deteções”)
- 🟡 `scan-full-smoke` — Smoke test manual final: Rápida → Profunda → Ficheiro → Pasta → ZIP → Cancelar → navegar e voltar — _Falta o manual test com o EICAR real (`eicar_com2.zip`): a deteção do EICAR real ainda não foi observada ao vivo (só o canário dev)._
- ✅ `scan-runtime-quality` — Corrigir progresso, contadores e desempenho da Análise Profunda — _A parte dos contadores foi fechada em `scan-threat-counter` (2026-09-25). **DONE 2026-09-26:** auditado com teste em vez de patch - 8 testes novos em `packages/service/test/scan-runtime-quality.test.js`, registados no script `test` do service; service 110/110. A evidencia nao pediu alteracao em `scan-manager`, `engine` nem `analysis`, por isso nao foram tocados (nada de patch especulativo). **O que fica por validar manualmente pertence a `scan-full-smoke`** (scan completo + cancelamento ao vivo), que se mantem Em curso._
- ✅ `scan-zip-nested-count` — NOVO (2026-09-25) — Corrigir contagem em ZIPs aninhados — _A recursão conta as entradas internas **e** o próprio ZIP aninhado (possível contagem dupla) e `nestingDepth > ZIP_MAX_NESTING` com guarda `<` permite 4 níveis (off-by-one). Descoberta da revisão independente. 2026-09-25 (Qoder): delegada a kiro (builder auto) — scope limitado a `service/scan-manager.ts` + `test/scan-manager.test.js`. DONE (kiro entregou, Qoder reviu): dupla contagem corrigida (scanArtifact só no else quando não há recursão), guarda `>= ZIP_MAX_NESTING` consistente, params mortos removidos, 5 testes novos (AdmZip in-memory, sem zip bomb); verificação combinada: service 95/95, `git diff --check` limpo._
- ✅ `scan-observability` — NOVO (2026-09-25) — Tornar a sessão de scan observável (persistir/registar progresso e resultado terminal) — _`scan.progress` e o payload `completed` são IPC-only e nunca são persistidos: o contador `threatsFound` não é auditável e o sintoma P0-A era invisível nos logs. DONE (com arch-log pela Kilo): `scanId` no topo do `scan.progress` e nas linhas de scan; só eventos úteis em `security-events.log` (file.*/process.*/scan.progress fora do disco, broadcast à UI mantido); log por ficheiro excluído exige `CYBERSAFE_DEBUG_BRIDGE=1`._

## Motores de Segurança & Protection Health
_Camadas reais do antivírus e respetivo estado de saúde._

- ✅ `prot-yara` — YARA-X funcional com regras válidas e testes
- ✅ `prot-hash` — Hash DB com SHA-256 e fallback offline — _2026-09-25: hash EICAR fabricado (MD5+zeros) substituído pelo SHA-256 real (`275a021b…`) e base empacotada pela primeira vez em `packages/service/definitions/hashes/default.json`._
- ✅ `prot-clam-state` — ClamAV reporta degraded/unavailable quando não está funcional
- ✅ `prot-native-state` — Native Engine reporta unavailable quando não está disponível
- ✅ `prot-firewall` — Estado do Firewall integrado no ProtectionHealth
- ✅ `prot-health` — ProtectionHealth centralizado sem fingir motores ativos
- ✅ `ui-degraded-copy` — Copy "Degradada" removida da UI visível (tray + ReportsPage); enum técnico interno mantido — _2026-09-25 (Qoder): tray "Proteção: Precisa de atenção · N/100" e relatório "Proteção precisa de atenção"; desktop 29/29 PASS._
- ✅ `entitlement-premium-leak` — NOVO (2026-09-25) — Personal premium recebe features business-only — _Confirmado no ramo premium de `getUserFeatures` (`...Object.values(FEATURES)` sem filtro de conta). Delegado a **kiro** (scope `featureControl.ts` + `business-feature-control.test.ts`) após **non-delivery da Continue** (reportou "completed" sem tocar no código — verificar sempre diffs dos locais antes de dar por feito). DONE (kiro): premium filtra BUSINESS_SPECIFIC_FEATURES quando accountType!=='business' (Set para dedupe); 4 testes novos (personal-premium sem USB/REPORTS/DEVICE_MANAGEMENT; business-premium intacto; personal mantém as suas; free/pro iguais). Gate final Qoder: core 140, service 95, app 151, desktop 29 — 0 falhas; typecheck PASS; `git diff --check` limpo._
- ✅ `prot-score` — Separação correta Protection Score ≠ PcState
- ✅ `prot-eicar` — Testes de integridade com EICAR / regras YARA
- ✅ `prot-quarantine` — Quarentena: mover, restaurar, apagar e metadados/manifest
- ✅ `prot-defs` — Updater/scheduler de definições
- 🟡 `prot-clam-config` — Fechar configuração/distribuição do ClamAV para funcionar sem setup manual frágil — _Já houve falha de freshclam/config no ambiente de desenvolvimento. **Diagnostico fechado 2026-09-26 (honesto, DONE na parte do estado):** nao existe base de assinaturas em lado nenhum - `definitions/clamav` vazio, diretorio do Chocolatey vazio e `C:\ProgramData\ClamAV` vazio, e o `freshclam` nao popula; o binario existe mas sem base nao ha varrimento. Logo o estado **degraded do ClamAV esta correto** e e isso que os motores reportam (`prot-clam-state` ✅ mantem-se). **Falta (bloqueia o FECHO, nao o estado):** distribuir as definitions no pacote ou correr freshclam com rede, e so ai `prot-clam` passa a active._
- ✅ `prot-hash-update` — Robustecer atualização da base de hashes / tratamento de falhas do feed — _2026-09-25: `refreshBuiltinIfStale()` re-semeia a base em disco no `init()`; migração confirmada no ambiente real (~/.cybersafe-service/.../default.json atualizado às 07:25:08Z com o EICAR real). **DONE 2026-09-26:** a base offline de referência (EICAR) nunca desaparece com feed parcial ou inválido — o refresh só substitui quando o payload é válido e não retira os registos embutidos. Evidência: `hash-db-refresh` 18/18, regressão combinada `engine-integrity` + `signatures` 29/29, `tsc` do core exit 0. **Pendente (não é desta tarefa, fica registado):** `applyRemoteRecords()` existe mas não é chamado por `engine.ts` nem `updater.ts` — o feed remoto ainda não aplica registros; só a defesa contra feed mau está provada._
- 🟡 `prot-history` — Histórico consolidado de deteções, ações e quarentena

## Proteção em Tempo Real & Windows
_Monitorização contínua de ficheiros, processos, serviços e defesas do Windows._

- ✅ `rt-watcher` — Watcher de Downloads/Desktop/Documents/Temp/Startup
- ✅ `rt-process` — ETW de processos / infraestrutura de eventos nativos
- ✅ `rt-amsi` — AMSI em modo user-space/simulação claramente identificado
- ✅ `rt-firewall` — Leitura/health do Firewall do Windows
- ✅ `rt-health` — Windows Health: serviços, firewall, processos, rede, discos, utilizadores e registo
- 🟡 `rt-epperm` — Tratar junctions/reparse points e reduzir spam EPERM dos watchers
- ⚪ `rt-defender` — Estado do antivírus/Windows Security via SecurityCenter/Defender quando aplicável
- ⚪ `rt-events` — Auditoria de eventos críticos do Windows (energia, disco, sistema)
- 🟡 `rt-filearrival` — Detetar novos ficheiros fora do browser com monitorização nativa e analisar quando relevante
- ⚪ `rt-motw` — Usar Mark of the Web (Zone.Identifier) quando disponível como contexto de risco
- ⚪ `rt-lowlevel-validation` — Validar ETW, AMSI e WFP com testes controlados — _ETW/AMSI podem ser testados no PC real; WFP preferencialmente em VM quando houver bloqueio real._

## Saúde do PC & Telemetria
_Hardware, desempenho, sensores, discos e estado geral do computador._

- ✅ `health-cpu` — Telemetria CPU real
- ✅ `health-ram` — Telemetria RAM real
- ✅ `health-disk` — Uso/capacidade de armazenamento
- ✅ `health-network` — Telemetria de rede
- ✅ `health-gpu` — Telemetria GPU por systeminformation quando disponível
- ✅ `health-ring` — Ring buffer (~60 amostras) + sparklines sem persistência
- ✅ `health-pccenter` — PC Center: hardware, processos, rede, sensores e saúde do sistema
- ✅ `health-findings` — PcState/findings com severidades e categorias
- 🟡 `health-temp` — Temperaturas reais CPU/GPU/NVMe/board/fans via provider robusto — _Prioridade seguinte após fechar o Scanner._
- ⚪ `health-lhm` — Helper persistente LibreHardwareMonitor, cache curto e lifecycle limpo
- ⚪ `health-temp-bundle` — Bundlar helper/sensores no CyberSafe sem download silencioso nem instalação manual
- ⚪ `health-smart` — S.M.A.R.T. de SSD/HDD (vida útil, health/warnings)
- 🟡 `health-stress` — Rever Stress Index para representar pressão instantânea real e explicar “Como é calculado?”
- ✅ `health-diskfinding` — Pouco espaço em disco como finding de saúde, separado de stress instantâneo
- ⚪ `health-thermal-actions` — Alertas térmicos + ação segura/opt-in em vez de desligamento automático por defeito
- 🟡 `health-taskmanager` — NOVO (2026-09-25) — Task Manager (PC Center): lista de processos e terminação de processos — _PATCH FEITO (qoder, 2026-09-25), READY FOR MANUAL TEST. Causa LIST confirmada: `processes.list` devolvia só o cache de eventos com cap silencioso de 200 — ~139 de 331-339 processos invisíveis; agora `listProcesses()` reconcilia on-demand com a verdade do SO (TTL 2s, fallback cache, sem cap). Causa KILL confirmada: `taskkill` corria com `stdio ignore` (stdout/stderr descartados) e só mapeava 0/128 — exit 5 vira `access-denied` com a mensagem real; `exitCode/stdout/stderr` propagados até à UI; `actions.log` com Cmd/Status/Exit/Stdout/Stderr. Live no pipe real: 339 processos com proteção OFF; notepad (WMI) visível → killed exit 0 → PID ausente no tasklist → sem stale; System#4 e explorer recusados ANTES do taskkill. Testes: core 136/136, service 61/61 (8 novos), app 147/147 (3 novos), desktop 29/29, typecheck PASS, `git diff --check` limpo. Falta: validação manual na UI (terminar um notepad; tentar matar um serviço protegido e ver a mensagem de acesso negado com o diagnóstico real). REVISÃO QODER 2026-09-25: diff confirmado sem regressão (chain `access-denied` core→types→service→app com testes); focados core 140/140, service 66/66, app 147/147, desktop 29/29 PASS._
  _**REABERTO 2026-09-26 - bug reproduzido pelo utilizador - READY FOR MANUAL TEST.** Sintoma: o caminho sem pesquisa (U) divergia do caminho com pesquisa (F) - no U a area principal ficava praticamente vazia/escura, a resposta ao clique era inconsistente, havia muito loading e num caso o processo nem foi terminado; no F (pesquisa notepad) o fluxo era normal. RAIZ EM DUAS CAMADAS: (1) `snapshotProcesses` engolia o erro da enumeracao e devolvia um mapa vazio, pelo que `listProcesses()` esvaziava o cache, carimbarva-o como fresco e mostrava uma lista vazia enquanto o aviso do kill dizia sucesso; (2) o modal de confirmacao do Gestor de Tarefas nao identificava o processo e a lista reordenava por CPU a cada refresh - as linhas mudavam de sitio sob o cursor e o utilizador confirmava um PID que nunca viu. FIXES ENTREGUES: a fronteira passou a lancar no falhanço da enumeracao primaria e o servico serve o cache em vez de uma lista vazia (`native-windows/src/index.ts` langa Enumeracao de processos indisponivel; `engine.ts` mantem cache e TTL no catch); o modal passou a mostrar nome, PID, utilizador e memoria; a ordenacao e deterministica (metrica, depois nome, depois PID); o overlay fecha com o resultado terminal do kill e o refetch passa a correr em segundo plano. Prova do defeito no codigo anterior por `git show HEAD` do modal: zero ocorrencias de nome/PID; e do `handleKill`: `await refreshProcesses()` dentro do try antes do finally que fechava o overlay. **AINDA EM ABERTO:** P6 e P7, o refetch ainda e o fetchSnapshot de 7 pedidos do `App.tsx` e um snapshot mais velho pode sobrepor-se a um mais novo; e falta a validacao manual do caminho sem pesquisa pelo utilizador. **KILL-BUDGET ENTREGUE (correcao a esta nota, que estava errada):** o servico passou a ter UM orcamento total de 12 s (`KILL_TOTAL_BUDGET_MS`, `engine.ts:188`) com `remaining()` por etapa - `killDeadline` (1368), `step(ceiling)` (1371), orcamento esgotado devolve `timeout` sem chegar a disparar o taskkill (1403-1408), `runTaskkill` recebe `timeoutMs: remaining()` (1412) e o reap e limitado por `Math.min(killReapDeadlineMs, remaining())` com piso (1509-1510). 12 s fica abaixo dos 15 s do prazo do renderer, que era exatamente o objectivo do P4. Testes desta ronda: task-manager-page 16 novos + task-kill-flow, 38/38; service 110/110; typecheck verde._
  _**P0-A 2026-09-26 (Fast Builder/qoder) - READY FOR MANUAL TEST.** Patch aplicado nos 4 pontos diagnosticados: **P1** tombstones + epoca no servico (`engine.ts`) - um PID confirmado morto nunca volta por uma enumeracao em voo nem por um `process.started` velho, e o TTL so se re-arma se nada mudou entretanto; **P2** probe pelo CIM - o OpenProcess diz vivo a um processo ja terminado enquanto houver handles (caso classico do Notepad), entao a morte confirma-se por duas ausencias consecutivas no Win32_Process e a query-alvo passou a ser rate-limited (antes ate ~33 PowerShell num kill lento); **P3** desfecho terminal invalida sempre a janela de frescura (`reused` tira a entrada do dono antigo sem tombstone; `still-running` nao mente para baixo mas força nova leitura); **P5** `alias-stub` no renderer - o desfecho existia no servico e nos tipos mas caia no erro generico e nao fazia refetch (era o um run nunca acabou). Evidencia: service 110/110, app 182/182, `process-kill` 32/32, typecheck verde, `git diff --check` limpo. **Pendentes:** P4 (orcamento do kill) **ja foi entregue** a 2026-09-26 com um budget total de 12 s no servico, restando P6-P9 (sequenciacao de snapshots no App/PC Center, polling do Gestor de Tarefas, head-of-line no socket, timeout no ServiceClient), P11 (identidade com CreationDate), e os 4 passos de validacao manual do utilizador (matar notepad e nao voltar; alias-stub com PID real; processo com handle pendurado; cronometrar o clique)._

## Matrix AI & Experiência Inteligente
_Traduz dados técnicos em significado, prioridade e orientação simples._

- ✅ `mx-context` — Respostas contextuais curtas e orientadas ao estado real do PC
- ✅ `mx-format` — Modelo DADO TÉCNICO → SIGNIFICADO → PRIORIDADE → ORIENTAÇÃO
- ✅ `mx-findings` — Matrix explica findings sem obrigar utilizador comum a interpretar PID/hash/portas
- ✅ `mx-policy` — Testes de grounding e brevidade
- ✅ `mx-phishing` — Pedir contexto quando necessário (ex.: phishing)
- ✅ `mx-truth` — Estado ONLINE/LOCAL verdadeiro, sem fingir disponibilidade
- ✅ `mx-model` — Provider Groq / groq/compound integrado
- ✅ `mx-onboarding` — Onboarding overlay em 3 passos com persistência
- ✅ `mx-moods` — Assets/moods Matrix (safe/guide/alert/success/happy/defender/avatar/mini)
- ⚪ `mx-business` — Matrix Business para explicar eventos de rede e anomalias de egress

## CyberSafe Business
_Visibilidade de rede, eventos empresariais e futura gestão multi-endpoint._

- ✅ `biz-access` — Conta Business dá acesso ao Business Security Center independentemente do plano
- ✅ `biz-center` — Business Security Center Phase 1
- ✅ `biz-udp` — UDP marcado “Indisponível” quando não há recolha real
- ✅ `biz-dest` — Métrica “Destinos únicos” sem fingir que todos são externos
- 🟡 `biz-tcp-map` — Corrigir/validar mapeamento real Get-NetTCPConnection (state, ::, listeners, portas)
- 🟡 `biz-proc` — Correlação PID → processo confiável
- ⚪ `biz-inventory` — Network Inventory de dispositivos da rede
- ⚪ `biz-iphelper` — Usar IP Helper API / GetIpNetTable2 / GetExtendedTcpTable/GetExtendedUdpTable
- ⚪ `biz-etw` — ETW para telemetria/fluxos de rede em tempo real
- ⚪ `biz-baseline` — Traffic Baseline por dispositivo/processo
- ⚪ `biz-egress` — Egress Anomaly Detection sem afirmar “data theft” com um único sinal
- ⚪ `biz-wfp` — WFP para controlo/bloqueio de tráfego no endpoint
- ⚪ `biz-downloads` — Associar downloads/eventos ao deviceId do endpoint
- ⚪ `biz-agentconsole` — Arquitetura Agent por PC → Business Console
- ⚪ `biz-multi` — Gestão de múltiplos endpoints
- ⚪ `biz-policies` — Políticas centrais e alertas empresariais
- ⚪ `biz-rgpd` — Privacy-by-design: local-first, minimização, metadata-first, sem payload por defeito
- ⚪ `biz-deviceid` — deviceId pseudónimo + separação opcional da identidade do funcionário
- ⚪ `biz-retention` — Retenção configurável + limpeza automática de dados empresariais
- ⚪ `biz-rbac` — RBAC e audit log para consola Business
- ⚪ `biz-mtls` — Canal seguro Agent ↔ Console (TLS/mTLS quando multi-endpoint existir)
- ⚪ `biz-onprem` — Opção on-premise para clientes empresariais
- ⚪ `biz-networkwide` — Integrações futuras com routers/firewalls (UniFi/pfSense/OPNsense/Fortinet/Cisco/MikroTik)

## Extensão do Navegador
_Proteção complementar no browser e ponte para eventos de segurança._

- ✅ `ext-mv3` — Extensão Manifest V3 com background/content/popup
- ✅ `ext-phishing` — Heurísticas de phishing/URL
- ✅ `ext-http` — Deteção de HTTP inseguro
- ✅ `ext-downloads` — Heurísticas/eventos de downloads
- ✅ `ext-badge` — Badge por severidade
- ✅ `ext-privacy` — Privacidade: sem recolha sensível por defeito
- 🟡 `ext-agent` — Ligação robusta extensão → agente CyberSafe para analisar downloads no endpoint
- ⚪ `ext-business` — Eventos de browser minimizados para o Business Center (domínio/origem em vez de conteúdo)

## Interface, Temas & Interaction Polish
_Clareza primeiro; efeitos visuais apenas quando ajudam a compreender estado ou ação._

- ✅ `ux-core` — Tema CyberSafe Core
- ✅ `ux-neon` — Tema CyberSafe Neon
- ✅ `ux-matrix` — Tema Matrix Terminal
- ✅ `ux-red` — Tema Red Belbete (dark burgundy/ruby + light rose/ice)
- ✅ `ux-lightfix` — Correção de accent no Light Mode
- 🟡 `ux-liquid` — Tema CyberSafe Liquid experimental
- ✅ `ux-semantic` — Cores semânticas independentes do tema
- 🟡 `ux-dashboard-polish` — NOVO (2026-09-26) — Painel: pergunta central, hierarquia de estado e menos ruido visual — _Sem redesign, sobre a versao atual. Hero compactado (padding, anel 28 para 68 px, Matrix de xl para md, categorias em linha) a responder a uma so pergunta: O meu computador esta bem? com resposta curta por nivel (`answer`/`answerDetail` em protectionHealth); Protection Score com numero, estado e nota de definicoes em hierarquia clara; CPU/RAM/Disco/Rede como metricas principais e GPU/VRAM reduzidas a uma linha secundaria; disco passa a mostrar espaco LIVRE, o que significa e o que fazer (`describeDiskSpace`, duas regras: GB absolutos e percentagem); acoes do Scanner agrupadas num painel com uma primaria e duas secundarias; empty states de ameacas e alertas de uma linha; fim das repeticoes de aviso (o hero nao repete a lista de prioridades, os cartoes de metrica deixaram de imprimir o alerta vermelho que ja la estava, rotulos de severidade em PT); menos cyan decorativo (icones para muted, glow da Sidebar removido, hexagonos 0.03 para 0.02 e cyber-grid 4% para 3%, scrollbar global fina coerente com o ProtectionDetails). **Bug real corrigido:** o cartao Quarentena mostrava `pcState.findings.length` (recomendacoes, nao quarentena) e passou a chamar-se Recomendacoes - nao se inventou contagem de quarentena porque `DashboardSummary` nao traz esse campo. Evidencia: `dashboard-layout` 14/14 e `protection-health` 13/13, gate do Maestro typecheck verde + app 182/182. **Falta:** validacao visual em 3 larguras (o hero usa flex-wrap com order) e contagem real de quarentena exige campo novo no `DashboardSummary` (backend)._
- ⚪ `ux-scanner-steps` — Adaptar Multi Step Loader/step indicator para fases reais do Scanner
- ⚪ `ux-statebutton` — Stateful Button para ações assíncronas (quarentena, corrigir, restaurar, atualizar)
- ⚪ `ux-circular` — Circular Progress para Protection Score / métricas quando fizer sentido
- ⚪ `ux-alertlist` — Animated List / Central de Alertas
- ⚪ `ux-expand` — Expandable Cards para mostrar detalhes técnicos só quando o utilizador pedir
- ⚪ `ux-filetree` — File Tree para resultado de pasta/ZIP quando útil
- ⚪ `ux-dragdrop` — Drag & drop para analisar ficheiros, mantendo picker nativo
- ⚪ `ux-notificationbell` — Notification Bell com contador e histórico
- ⚪ `ux-numberticker` — Number Ticker discreto para métricas que não atualizam freneticamente
- ⚪ `ux-glow` — Border Beam / Glow apenas para estados ativos ou urgentes
- ⚪ `ux-reducedmotion` — prefers-reduced-motion / acessibilidade das animações

## Notificações & Respostas Inteligentes
_O CyberSafe não deve apenas mostrar dados; deve orientar e agir com controlo do utilizador._

- ✅ `not-toggle` — Toggle de notificações
- ⚪ `not-scan` — Notificação de scan concluído
- ⚪ `not-protection` — Notificação quando ProtectionHealth fica degradado
- ⚪ `not-extension` — Alertas vindos da extensão
- ⚪ `not-business` — Alertas Business (novo dispositivo, egress anómalo, etc.)
- ⚪ `not-thermal` — Alerta térmico sustentado antes de qualquer ação automática
- ⚪ `not-shutdown` — Encerramento por temperatura apenas opt-in e com critérios seguros
- ⚪ `not-smart` — SMART warning → recomendar backup, sem upload automático sem consentimento
- ⚪ `not-center` — Central de Alertas com prioridade e histórico

## Conta, API & Autenticação
_Conta local/API e diferenciação de contexto Personal/Business._

- ✅ `auth-register` — Register/Login/Me local com bcrypt/JWT/Prisma
- ✅ `auth-pages` — Páginas Login/Register
- ✅ `auth-accounttype` — Tipo de conta Personal/Business no modelo e registo
- ⚪ `auth-email` — Confirmação por e-mail — _Não implementada atualmente; não deve ser descrita como pronta._
- ⚪ `auth-business-rbac` — Permissões Business/RBAC futuras

## Empacotamento, Arranque & Distribuição
_Transformar o projeto num produto instalável e repetível._

- ✅ `dist-electron` — Desktop Electron funcional em desenvolvimento
- 🟡 `dist-autostart` — Autostart com Windows / iniciar minimizado — _Implementado, mas falta validação final em build empacotado._
- ⚪ `dist-installer` — Gerar instalador final CyberSafe-Setup.exe
- ⚪ `dist-helper` — Bundlar temperature helper/dependências necessárias no instalador
- ⚪ `dist-clam` — Bundlar/configurar motores externos necessários sem downloads silenciosos em runtime
- ⚪ `dist-cleanvm` — Teste de instalação e primeiro arranque em Windows/VM limpa
- 🟡 `dist-upgrade` — Estratégia de atualização do aplicativo e definições
- ⚪ `dist-sign` — Assinatura de código/installer para distribuição real

## Relatórios & Evidências
_Relatórios A4, dados técnicos explicados e evidências úteis para utilizador e PAP._

- ✅ `rep-a4` — Relatório A4 com cabeçalho, ameaças, quarentena, motores, hardware e findings
- 🟡 `rep-score` — Garantir que relatório consome PcState/ProtectionHealth corretos em vez de score próprio antigo — _**READY FOR MANUAL TEST 2026-09-26:** o relatorio interno passa a consumir PcState e ProtectionHealth em vez de calcular score proprio; nao ha metrica paralela; a ausencia de dados aparece como indisponivel e nunca como zero nem como saudavel. Evidencia: 17/17 testes focados. **Falta:** validar o PDF A4 impresso (layout) e confirmar que o espelho do build reflete o `core dist`._
- ✅ `rep-export` — Impressão/PDF do relatório
- ✅ `rep-e2e-canary` — NOVO (2026-09-25) — Teste E2E do pipeline de deteção sem EICAR real (canário dev-only) — _`packages/service/test/dev-canary.test.js`: scan real → deteção → `threat.detected` → `threatsFound`, com o mesmo contrato do `engine.ts`, e o caso inverso em `NODE_ENV=production` (0 deteções). Permite validar o pipeline sem disparar o Windows Defender._
- ⚪ `rep-business` — Relatório Business de eventos/risco de rede
- ⚪ `rep-privacy` — Relatório/explicação “o que o CyberSafe monitoriza” para transparência Business

## PAP — Relatório, Documentação & Apresentação
_Tudo o que precisa estar preparado para apresentar o projeto de forma fiel ao estado real._

- ✅ `pap-definition` — Definição do projeto: “CyberSafe Assistant — Centro Inteligente de Segurança e Saúde do PC”
- ✅ `pap-origin` — Explicar evolução: começou como antivírus e cresceu para centro integrado de segurança + saúde
- ✅ `pap-cycle` — Ciclo conceptual Monitorizar → Detetar → Priorizar → Proteger → Corrigir → Verificar
- 🟡 `pap-architecture` — Documentar arquitetura React → Electron → Service → Core/Windows/Motores
- ✅ `pap-realstate` — Regra editorial: só descrever como implementado aquilo que realmente existe/testado
- 🟡 `pap-scanner` — Capítulo do Scanner/Antivírus com Quick, Profunda, ficheiro, pasta, ZIP e motores
- 🟡 `pap-health` — Capítulo Saúde do PC / PC Center / PcState
- 🟡 `pap-matrix` — Capítulo Matrix AI e tradução de dados técnicos
- 🟡 `pap-business` — Business: separar claramente Phase 1 implementada de funções futuras
- ⚪ `pap-privacy` — Privacidade/RGPD Business: local-first, minimização, transparência e limitações
- 🟡 `pap-testing` — Reunir evidências de testes, probes, builds e screenshots finais — _2026-09-25: nova evidência disponível (manual test do canário + suites core 128/128, service 53/53, typecheck limpo) e o registo da Sprint 3 no topo do ficheiro `CYBERSAFE_ORGANIZADOR.md`. **SPRINT 4 GATE FINAL (Qoder, após kiro+Kilo):** core 140/140, service 95/95, app 151/151, desktop 29/29, typecheck PASS, `git diff --check` limpo; novo `scripts/protection-state-probe.mjs` (live pipe: yara active, hashDb active, native active, clamav degraded→freshclam, firewall unavailable em dev). Falta: manual test Task Manager (Notepad) pelo utilizador._
- ⚪ `pap-usability` — Realizar testes estruturados com utilizadores reais e documentar os resultados — _Orientação do Professor Edgar Costa: tarefas reais, tempos, dificuldades, feedback e melhorias._
- ⚪ `pap-manual` — Manual do utilizador
- ⚪ `pap-diagrams` — Diagramas de arquitetura e fluxos
- ⚪ `pap-licenses` — Referências/licenças de dependências e componentes externos
- 🟡 `pap-docx` — Documento final da PAP em DOCX baseado no modelo da escola
- ⚪ `pap-presentation` — Apresentação final da PAP
- ⚪ `pap-demo` — Roteiro de demonstração ao vivo com fallback para imprevistos
- ⚪ `pap-screens` — Capturas finais do Dashboard, Protection, Scanner, PC Center, Matrix e Business

## Ideias Futuras / Parking Lot
_Boas ideias que não devem roubar prioridade aos bugs e funções essenciais._

- ⚪ `future-router` — Integração opcional com router/firewall para visibilidade além dos endpoints Windows
- ⚪ `future-onprem` — Business Console on-premise
- ⚪ `future-multios` — Agentes para outros sistemas operativos (se a PAP evoluir após Windows)
- ⚪ `future-home` — Inspiração de automação tipo Home Assistant sem transformar isso em dependência
- ⚪ `future-grafana` — Usar ideias de Grafana/Prometheus como referência de observabilidade, sem obrigar o utilizador a instalá-los
- ⚪ `future-smartactions` — Ações automáticas seguras e opt-in baseadas em risco/saúde
- ⚪ `future-motion` — Microinterações MotionSites / Rare UI / Magic UI / Aceternity depois da funcionalidade estar fechada
