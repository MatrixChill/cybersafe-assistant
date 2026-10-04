# CyberSafe - Organizador: historico e notas tecnicas

Ficheiro de arquivo. Gerado na compactacao de 2026-09-29, quando o
[`CYBERSAFE_ORGANIZADOR.md`](CYBERSAFE_ORGANIZADOR.md) e o
[`cybersafe-organizador-pap-v2-editavel.html`](cybersafe-organizador-pap-v2-editavel.html)
passaram a ser so o mapa visual (estado atual + o que falta).

Aqui fica tudo o que foi retirado dos cartoes: a cronologia de sprints e a
versao integral das notas tecnicas de cada tarefa. Nenhum id, estado ou
informacao unica foi apagado do mapa; so mudou de casa.

---

## Parte 1 - Registo de sprints (do HEAD do git)

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

> **Lacuna conhecida:** na versao de trabalho (nao commitada) desta secao
>-existiam ainda ~113 linhas de cronologia das rondas de 2026-09-28. Essa
> working tree nao tinha sido commitada, por isso o texto original nao foi
> recuperavel a partir do git e **nao** foi reproduzido aqui (inventar
> cronologia seria pior do que a lacuna). O conteudo tecnico dessas rondas
> continua integralmente registado na Parte 2, tarefa por tarefa.

---

## Parte 2 - Notas tecnicas integrais por tarefa

Texto completo que estava nos cartoes antes da compactacao de 2026-09-29.
Estes textos sao **historico**: nao reflecting o estado atual, que esta no
organizador oficial. Servem para nao perder o rasto de decisoes, evidencias
e pendencias que a versao curta resume.

### Fundação

#### `arch-monorepo` - ✅ DONE

Monorepo TypeScript com React + Electron + Vite + Node.js

#### `arch-flow` - ✅ DONE

Arquitetura React → Electron/Preload/IPC → Serviço local → Core/Windows/Motores

#### `arch-pipe` - ✅ DONE

Comunicação local por named pipe / RPC

#### `arch-shared` - ✅ DONE

Contratos partilhados em shared-types

#### `arch-packages` - ✅ DONE

Packages app, desktop, service, core, api, native-windows, native-engine, shared-types e extension

#### `arch-truth` - ✅ DONE

Princípio de verdade: indisponível/degradado/erro quando um motor ou sensor não funciona

#### `arch-personal-business` - ✅ DONE

Distinção de conta Personal vs Business

#### `arch-build` - 🟡 PROGRESS

Build, typecheck e suites de testes como gate de qualidade — _Typecheck, build e as suites por workspace estao a funcionar como gate (o Maestro corre-o centralmente; 2026-09-26: typecheck verde, app 182/182, core 179/179, service 110/110). **Duas dividas pre-existentes registadas sem suprimir regras:** (a) `npm run lint` na raiz falhava porque `packages/desktop` nao tinha script `lint` - o gate de lint estava incompleto, nao era um problema do codigo; (b) `packages/app` tem erros eslint pre-existentes - ficam como follow-up, nenhuma regra foi desligada nem escondida. **CORRECAO DE FACTOS (2026-09-28, verificada pelo Maestro):** (i) `packages/desktop` **já tem** script `lint`, mas é um **no-op** (`node -e "console.log('desktop lint delegated to app/core workspaces')"`) e **não existe config eslint para desktop** — o gate nesse workspace não está incompleto, é **cosmético**: reporta sucesso sem verificar nada; (ii) a contagem real em `packages/app` não era 13 mas **33 erros + 4 warnings (37 problemas)**, e não era só `any`/`react-hooks`: havia **20 `react-refresh/only-export-components`** e 3 warnings `exhaustive-deps`; (iii) o qoder corrigiu **10 com segurança, sem `eslint-disable` e sem desligar regras** (8 `any` resolvidos com `instanceof Error` e tipos precisos, 1 `no-unused-vars`, 1 `no-empty` com comentário honesto, e removeu 1 `eslint-disable` obsoleto), ficando **26 problemas (23 erros + 3 warnings)** com `npm run lint -w @cybersafe/app` ainda a sair **1** (confirmado pelo Maestro); app **283/283** · desktop **29/29** · typecheck PASS; (iv) **o gate continua vermelho** e depende de duas classes que o qoder deliberadamente não tocou, por mudarem comportamento ou serem estruturais: os **3 `react-hooks` comportamentais** (`App.tsx:141` refs lidos no timer; `BusinessSecurityCenter.tsx:101/:114` setState síncrono em effect no gate de auth) e os **20 `react-refresh`** (exigem separar exports não-componente em ~11 ficheiros, incluindo os contexts de autenticação e de aparência). Nenhuma regra foi desligada e nenhum `eslint-disable` foi acrescentado; a decisão sobre estas duas classes ficou explicitamente **pendente de decisão de produto**. **DECISÃO (2026-09-28, utilizador):** fica como **dívida aberta e documentada** — sem baixar/desligar regras, sem refactor agora e **sem mexer no gate cosmético do desktop** (que permanece conhecido e por corrigir). O gate fica **vermelho por decisão**, não por esquecimento, e o organizador passa a dizer os números certos para ninguém o contar como verde. Nota de risco: os **3 `react-hooks` comportamentais** são a parte que pode esconder bugs de runtime e devem ser a **primeira** coisa a tratar quando isto for retomado; os 20 `react-refresh` são estruturais e sem impacto em runtime._

#### `arch-clean` - 🟡 PROGRESS

Eliminar warnings/runtime noise recorrente que atrapalha diagnóstico (watchers EPERM, etc.) — _Não bloqueia o produto, mas ainda aparece no runtime._

#### `arch-log-hygiene` - ✅ DONE

NOVO (2026-09-25) — Higiene dos logs de runtime do serviço (rotação/limite de tamanho) — _Descoberta 2026-09-25: `error.log` com 3,4 GB e `boot-debug.log` com 3,2 GB em `~/.cybersafe-service`, sem rotação. Risco de disco e de diagnóstico. 2026-09-25 (Qoder): delegada a Kilo Builder após recovery do pool (Matrix Local reanimado via Ollama + alias `qwen3-coder`; Kilo auto no free gateway); write scope `log-writer`/`index`/`engine` (só logging), proibido `scan-manager` (kiro). DONE (Kilo entregou, Qoder reviu): causa raiz = `appendFileSync` cru sem rotação + ciclo de realimentação EPIPE (`console.error` dentro do handler de `uncaughtException` reentrava no próprio handler, ~600 B de stack por iteração); fix = rotação por tamanho + retenção real (unlink), `safeWrite` + guarda `inCrashHandler`, reclaim de emergência no próximo boot (trunca 3,3/3,1 GB para a cauda — único ponto de perda de histórico, só acima do orçamento), dedupe `xN`, orçamento 32 MB; 24 testes novos; service 95/95, typecheck/lint/build:all OK._

#### `test-tmpdir-leak` - ✅ DONE

NOVO (2026-09-28) — API temp DB leak: ligação sqlite singleton a vazar diretórios em `%TEMP%` — _`packages/api/src/db.ts` mantinha a ligação sqlite singleton sempre aberta; no Windows o ficheiro temporário ficava bloqueado (EPERM) e ficavam **2 diretórios** vazados em `%TEMP%` por execução de teste. Correção: novo export `closeDb` em `db.ts`, chamado no `after` dos 2 testes de auth-role. Depois da correção: **0 diretórios** vazados._

### Antivírus & Análise de Segurança

#### `scan-name` - ✅ DONE

Renomear “Scanner de Ficheiros” para “Análise de Segurança”

#### `scan-quick-name` - ✅ DONE

“Análise Rápida do Computador” com descrição clara para utilizadores leigos

#### `scan-deep-name` - ✅ DONE

“Análise Profunda do Computador” em vez de “Análise Completa”

#### `scan-file` - ✅ DONE

Analisar um Ficheiro com picker nativo e UX própria

#### `scan-folder` - ✅ DONE

Analisar uma Pasta com picker openDirectory e progresso por pasta

#### `scan-zip` - ✅ DONE

ZIP inspecionado por conteúdo (não apenas como blob/nome)

#### `scan-zip-safety` - ✅ DONE

Proteções ZIP: zip-slip, depth, entries, bytes extraídos, ratio/bomb, corrupt archive, cleanup e cancelamento

#### `scan-pipeline` - ✅ DONE

Pipeline end-to-end start → scanId → progresso → terminal com buffer de eventos precoces

#### `scan-resync` - ✅ DONE

getActiveScan / ressincronização ao sair da página e voltar

#### `scan-one` - ✅ DONE

Um clique = um scan; single active scan também protegido no backend

#### `scan-cancel` - ✅ DONE

Cancelamento real no backend + estado terminal cancelado

#### `scan-zero` - ✅ DONE

Pasta/scan com 0 ficheiros termina explicitamente

#### `scan-exclusions` - ✅ DONE

Corrigir exclusões perigosas: .exe/.dll/.zip/.lnk/.msi/.sys/.ps1 chegam aos motores; Downloads não é trusted

#### `scan-quick-scope` - ✅ DONE

Quick Scan por risco/recência, depth 2, budget 800 e diretórios prioritários

#### `scan-file-targetkind` - ✅ DONE

targetKind file/directory + nome do ficheiro disponível desde o início

#### `scan-file-runtime` - ✅ DONE

Confirmação visual manual final do scan de ficheiro único no Electron — _Concluído 2026-09-25: manual test PASS na UI (1 ficheiro verificado, 1 ameaça, toast `THREAT.DETECTED`, sem quarentena), confirmado por `threat.detected` no log. Alvo usado: canário dev._

#### `scan-threat-counter` - ✅ DONE

NOVO (2026-09-25) — Coerência entre o toast `THREAT.DETECTED` e o contador `threatsFound` (P0-A) — _Causa raiz: `engine.ts` publicava `medium` e o `scan-manager.ts` só contava `high/critical` → toast 1, contador 0. Corrigido com um critério único (`highRiskCount > 0 || severity high/critical/medium`) alinhado entre os dois. Validado manualmente e por testes. **Evidência nova 2026-09-28:** scan real na UI deu 800 verificados, 748 sem deteções, 49 excluídos e 3 ameaças; a página Ameaças devolveu logo as 3 — a divergência Scanner 1 vs Ameaças 0 está corrigida e validada manualmente pelo utilizador._

#### `scan-copy-grammar` - ✅ DONE

NOVO (2026-09-28) — Copy PT-PT do resumo do scanner (excluídos pelos motores de análise) — _Na conclusão do scan, a frase dos ficheiros ignorados pelas exclusões continha a muleta "não passou/passaram pelos motores". Corrigida em `packages/app/src/lib/scanSession.ts` com verbo concordado por número e "pelos motores de análise": "47 ficheiros foram ignorados pelas exclusões e não passaram pelos motores de análise." Número preservado; nada alterado em scoring, motores ou contagens. Evidência: `scan-session.test.ts` cobre agora a frase completa no plural e no singular; app 283/283, typecheck e build do app OK. **RONDA 2026-09-28 (validação manual): PASS** — a frase no plural está correta na conclusão do scan._

#### `scan-enum-perf` - 🟡 PROGRESS

NOVO (2026-09-28) — Performance da enumeração no scan (aberto, arquitetural) — _ABERTO. O scan rápido manual mediu **194 s** contra 97 s e 101 s das medições anteriores. **FASE 1 (2026-09-28) — hipótese de enumeração REFUTADA por medição:** descobrir os 800 ficheiros custa **214 / 139 / 154 ms** em 3 runs enumeration-only (723 diretórios, 914 ficheiros, 1637 stats; ~0,2 s), logo a descoberta **não é** o gargalo. O custo está no caminho de análise por ficheiro: `analyze` p50 ≈ 2 ms + spawn do motor nativo p50 ≈ 23 ms + hash ≈ 1 ms + ClamAV ≈ 0 ms (`degraded`) ≈ **26 ms/ficheiro**. **FASE 2 A/B 1 (réplica isolada de `scanZipWithSafety`, fora do repo, corpus fixo):** a descompressão dupla existe mas é **pequena** (16-19 ms num DOCX de 43 entradas; −14,7% com single-getData e −19,5% usando só `header.size` no DOCX, ruído nos restantes); o que domina é o **spawn de `scan-engine.exe` por entrada** — 44 spawns = 859 ms ≈ 70% do custo do DOCX, 20-25 ms por spawn, **um processo por artefacto, sem pool**. Contentores com **mais de 500 entradas** (2 VSIX medidos: 904 e 532) são **abortados pelo guard** e ficam sem cobertura interna, levando apenas o `scanArtifact` exterior (0,3-0,9 s). Acceptance do A/B 1 passou: mesmas entradas, mesmos limites e proteções (500 / 200 MB / ratio 1000 / depth 3 / nesting 3 / zip-slip / dedup), sha256 dos bytes extraídos **idêntico**, deteções idênticas (0 em todas as variantes). **Nada foi alterado em produção, nada foi reduzido em cobertura e nenhum patch foi aprovado (recomendação medida: NÃO implementar o getData agora).** **FASE 2 A/B 3 (motor nativo residente/pooled): INVIÁVEL sem alterar o binário** — o `scan-engine.exe` é **one-shot por argv** (`packages/native-engine/src/main.cpp:8-27`), sem modo servidor nem loop de stdin, 1 JSON por processo e sem request id; o timeout de 30 s é **por processo** (`native-engine-bridge.ts:117-128`) e só funciona porque 1 pedido = 1 processo. Decomposição medida: spawn puro **13,8 ms p50** (15,3 p95; `cmd.exe` de referência 17,8), carga do motor **0-1 ms**, análise **~1,0 ms** num ficheiro pequeno (escala com os bytes: 168 MB ≈ 800 ms). Teto de um pool = ~12-13 ms × ~900 spawns ≈ **11-12 s** num quick scan (**10-13%** do total) — não justifica mexer no caminho de deteção; um pool a sério seria uma **feature nova** (`scan-engine --stdin-batch` JSONL + request id + timeout/restart + testes), não um protótipo. O estado do motor é limpo (sem statics mutáveis nem temp files fixos), logo o bloqueio é de **protocolo**, não de segurança. A discrepância 26 vs 57 ms/ficheiro ficou em parte explicada: chão bruto de ~14 ms + overhead do bridge (23-44 ms por artefacto) + mistura de ficheiros grandes — **sem bug**. **FASE 2 A/B 2 (scan real, com `CYBERSAFE_DEBUG_SCAN=1`): CAUSA IDENTIFICADA.** Um quick scan real correu a **~15,5 s por ficheiro** (23 ficheiros em 391 s, intervalo uniforme; 800 ficheiros ≈ **3,4 h**) e **quase todo o tempo está DENTRO do `scanArtifact`** (`engine=344 s` de `elapsed=391 s`; o gap de 47 s inclui enumeração + pipeline PK + overhead). A/B no mesmo caminho e mesmo corpus (5 ficheiros): **com VT = 12.505 ms/ficheiro; sem VT = 33 ms/ficheiro** (~380×). O gargalo é o **gancho do VirusTotal síncrono** com o rate-limit de 15,5 s esperado em linha por ficheiro. Detalhe e evidência na task `scan-vt-blocking`. Enumeracão, `getData()` duplo e spawns nativos ficam confirmados como **secundários** a esta escala (cada um 2-3 ordens de grandeza abaixo). **FECHO DA CAUSA (2026-09-28):** confirmado que o gargalo era o **gancho VT síncrono com chave inválida (HTTP 401)** — o breaker de `scan-vt-blocking` elimina o regime de falhas (verificado end-to-end: 15.430 ms → **0 ms** por pedido após 3 falhas; no serviço real a releitura dos mesmos ficheiros deu **19 ms/ficheiro** contra 13,3 s na 1.ª leitura). **Duas coisas continuam abertas e não pertencem a este item:** o throttle de 15,5 s por ficheiro não cacheado também afeta uma chave **saudável** (`vt-enrichment-design`); e a **1.ª leitura de ficheiros recém-criados custou ~6,5 s/ficheiro** enquanto a releitura dos mesmos custou 19 ms — efeito medido, causa ainda **não provada** (candidatos: Defender em tempo real, contenção do watcher, disco frio), que ajuda a explicar a variabilidade entre scans de 97 s e 194 s. Sem patch aplicado. Bug separado registado: `analyze()` lança em alguns `.lnk` (`reading 'match'`) — não misturado com performance._

#### `scan-vt-blocking` - ✅ DONE

NOVO (2026-09-28) — Gancho do VirusTotal síncrono no caminho do scan: ~15,5 s por ficheiro, o gargalo real da performance — _Causa raiz identificada na FASE 2 (A/B 2). **Mecanismo:** `packages/core/src/virustotal.ts:8` define `RATE_LIMIT_MS = 15_500` ("~4 requests per minute, free tier") e `scanHash()` (`:52-56`) faz `await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - elapsed))` **antes** de cada pedido; o `engine.ts:883-884` chama `await this.vt.scanHash(...)` **em linha, dentro do `scanArtifact`, por ficheiro**; a chave vem do `.env` da raiz (`engine.ts:141`, `VIRUSTOTAL_API_KEY`) e a API responde **429** em cada pedido, com o `vtResult` a ficar `null` — ou seja, **paga-se 15,5 s por ficheiro sem qualquer contributo para a deteção**. **Números medidos:** quick scan real a **~15,5 s/ficheiro** (23 ficheiros em 391 s, intervalo uniforme; 800 ficheiros ≈ **3,4 h**), com `engine=344 s` de `elapsed=391 s` — o custo está **dentro** do `scanArtifact`, não na enumeração nem no pipeline PK. A/B no mesmo caminho e mesmo corpus (5 ficheiros não-PK): **com VT = 12.505 ms/ficheiro; sem VT = 33 ms/ficheiro (~380×)**, com 12 linhas `[VirusTotal] Rate limited, skipping` vs 0. **Porque nenhum harness apanhou isto:** os harnesses dos A/B 1 e 3 chamavam o motor/analyzer diretamente e não passavam pelo gancho do VirusTotal. **Não é só o 429:** mesmo com uma chave a funcionar, o limite de 4 pedidos/minuto dá 3,4 h para 800 ficheiros — o problema de fundo é fazer **enriquecimento VT síncrono no caminho crítico de um scan em massa**. Opções a decidir (nenhuma implementada): (a) fila/background não bloqueante com reconciliação posterior; (b) amostragem — só artefactos de risco alto/suspeitos; (c) desligar o enriquecimento VT em quick/deep scan e manter só no scan de ficheiro único. Se o enriquecimento passar a assíncrono, a UI tem de o dizer (princípio `arch-truth`), sem apresentar resultado parcial como final. **Nada alterado em produção, sem patch.** Nota operacional descoberta: reiniciar o serviço dev exige matar a árvore `tsx` completa — o stop do wrapper deixa o `node` filho a servir o pipe e os scans continuam a correr contra a instância antiga. **FIX MÍNIMO IMPLEMENTADO (Codex Lead, 2026-09-28) — READY FOR MANUAL TEST, sem DONE:** circuit breaker dentro do `VirusTotalClient` (`packages/core/src/virustotal.ts`): N = 3 falhas consecutivas (429, `!ok`, exceção de rede) abrem o breaker por 5 min; a cache é consultada primeiro (um hit continua a servir com o breaker aberto) e uma entrada **expirada** deixa de ser servida quando o breaker abre; `404` conta como sucesso e repõe o contador; o log sai **uma vez por abertura** em vez de por ficheiro; o throttle de 15,5 s e os **defaults de produção ficam inalterados** (há teste dedicado a isso). O construtor ganhou um 2.º parâmetro **opcional** (`rateLimitMs`/`cooldownMs`/`failureThreshold`) com defaults iguais ao comportamento antigo, para os testes serem instantâneos; o `engine.ts` **não** foi tocado. **Verificação independente do Maestro:** `npm test -w @cybersafe/core` = **222/222, 0 falhas** (12 testes novos do VT, incluindo "production defaults retain the throttle and reopen only after five minutes" e o caso da 2.ª chamada já em espera que salta o fetch quando outra abre o breaker). **PENDENTE:** medição end-to-end no serviço real — o Codex ficou bloqueado por EPERM no pipe; é o passo que fecha `scan-enum-perf`. Projeção (não medição): 800 ficheiros de ~3,4 h para ~1 min. **VERIFICADO END-TO-END (Maestro, independente do autor):** (a) cliente isolado com a chave do `.env` — pedido 1 = **358 ms**, pedido 2 = **15.430 ms**, pedido 3 = **15.684 ms**, `Circuit breaker open ... HTTP 401`, pedido 4 = **0 ms**; (b) no serviço real — **17 ×** `[VirusTotal] API error: 401`, **uma única** linha de abertura do breaker e 1 `fetch failed`, logo o log deixou de sair por ficheiro; (c) mesmos 2 ficheiros — 1.ª leitura = **13,3 s** (7,8 s + 5,5 s) contra **19 ms/ficheiro (52,6 ficheiros/s)** na releitura do mesmo diretório; (d) enumeração medida = **0,43 s** para um diretório de 2 ficheiros. Antes do fix não existia breaker: cada ficheiro não cacheado pagava ~15,5 s para sempre. **O throttle em si não foi alterado** — ver `vt-enrichment-design`. Fecho de código com medição real; a validação de UI num scan do utilizador continua READY FOR MANUAL TEST._

#### `vt-enrichment-design` - ⚪ PLANNED

NOVO (2026-09-28) — Enriquecimento VirusTotal: chave inválida (401) e throttle de 15,5 s por ficheiro mesmo com chave saudável — _Aberto, decisão de produto pendente. **Dois problemas independentes do breaker:** (a) a chave do `.env` da raiz está **inválida** — o cliente isolado devolve `HTTP 401` em todos os pedidos, logo o enriquecimento contribui **zero** para a deteção (antes era 429, agora 401: o estado degradou, não contradiz medições anteriores); (b) mesmo com uma chave a funcionar, o limite de ~4 pedidos/minuto (`RATE_LIMIT_MS = 15_500`) faz cada ficheiro **não cacheado** esperar 15,5 s **em linha** dentro do `scanArtifact` — 800 ficheiros ≈ 3,4 h. O breaker resolve o regime de **falhas**; **não** resolve o regime **saudável**. Opções (nenhuma implementada): (a) fila/background com reconciliação posterior; (b) amostragem — só artefatos de risco alto/suspeitos; (c) desligar o enriquecimento em quick/deep scan e manter só no scan de ficheiro; (d) manter e assumir o custo, dizendo-o na UI. Sem patch._

#### `scan-pk-over500-coverage` - ⚪ PLANNED

NOVO (2026-09-28) — Cobertura zero nos contentores PK com mais de 500 entradas (expansão abortada) — _Descoberto na FASE 2 do trabalho de performance (A/B 1, réplica isolada de `scanZipWithSafety`). O guard `ZIP_MAX_ENTRIES = 500` faz `return 0` **antes** de qualquer extração, logo arquivos com mais de 500 entradas ficam **sem cobertura interna**: não é só uma questão de tempo, é cobertura — os ficheiros lá dentro nunca chegam ao `scanArtifact`, corre apenas o `scanArtifact` exterior (hash + leitura integral). Medido em 2 VSIX reais: **904** e **532** entradas. Isto **não** explica os 194 s do scan (nesses contentores o custo cai para 0,3-0,9 s, só parse + exterior) e **nada** foi alterado em produção. A decisão é de produto: subir o limite, processar por lotes com progresso, ou dizer honestamente na UI que o interior do arquivo não foi inspecionado. Sem patch, sem código tocado._

#### `scan-lnk-analyze-fail` - ⚪ PLANNED

NOVO (2026-09-28) — `analyze()` a lançar em alguns `.lnk` (contados em `filesFailed`) — a confirmar — _Observado durante os probes de medição da FASE 1/2: `Cannot read properties of undefined (reading 'match')`, com o ficheiro a cair no `catch` do loop principal e a incrementar `filesFailed` (`scan-manager.ts:297-300`). **NÃO CONFIRMADO em produção** e por isso registado como ⚪ Planeado, não como bug fechado: a mesma assinatura de erro foi depois reproduzida como **artefacto do harness de medição** (um `MalwareAnalyzer` construído sem as dependências `signatures`/`trust`) e, no caminho de produção, as 4 dependências estão ligadas em `engine.ts:124-133`. Pontos de falha plausíveis a despistar se se confirmar: `analysis.ts:92` (`this.deps.signatures.match`), `yara.ts:133` (`content.match`) e `hardware.ts:103` (`release.match`). Passos: reproduzir com o caminho real do serviço (não com harness) sobre `.lnk` reais, ler `filesFailed` e o log `[ScanManager] Error scanning`, e só depois decidir a correção. Bug separado — não se mistura com performance._

#### `scan-engine-batch-mode` - ⚪ PLANNED

NOVO (2026-09-28) — Modo batch/residente do motor nativo (`scan-engine`) para eliminar o spawn por artefacto — _Ideia fechada com números na FASE 2 (A/B 3), não implementada. Hoje o `scan-engine.exe` é **one-shot por `argv[1]`** (`packages/native-engine/src/main.cpp:8-27`) e o bridge faz `spawn(binPath, [filePath])` por artefacto, com timeout de 30 s **por processo** (`native-engine-bridge.ts:117-128`): não há modo servidor, loop de stdin, request id nem timeout-por-pedido. Custo medido: spawn puro **13,8 ms p50** (15,3 p95), carga do motor **0-1 ms**, análise **~1,0 ms** num ficheiro pequeno (escala com os bytes: 168 MB ≈ 800 ms). **Teto do ganho = ~11-12 s num quick scan (10-13%)** — por si só não resolve os 194 s. O motor está limpo por dentro (sem estado global mutável nem temp files com nome fixo), logo o trabalho é de **protocolo e infraestrutura**, não de deteção. Âmbito mínimo se algum dia for feito: `--stdin-batch` com JSONL, request id por pedido, timeout por pedido + política de restart, e testes que provem equivalência de deteções pedido a pedido. **Não é protótipo de Temp — é feature de produção e precisa de decisão explícita.** Nada foi implementado._

#### `scan-deep-scope` - 🟡 PROGRESS

Auditar/ajustar scope real da Análise Profunda para que a copy não prometa “todo o computador” sem ser verdade — _Precisamos confirmar volumes/paths/limites reais antes de fechar._

#### `scan-safe-copy` - 🟡 PROGRESS

Trocar “Ficheiros Seguros” por copy mais honesta (“Sem ameaças detetadas” / “Sem deteções”) — _JÁ IMPLEMENTADO no código (verificado 2026-09-28): `packages/app/src/lib/scanSession.ts:75-82` expõe `SCAN_RESULT_LABELS.noThreatsDetected = "Sem ameaças detetadas"` a substituir o antigo "Ficheiros Seguros", com o comentário que explica a razão (nenhuma deteção não é garantia absoluta); `packages/app/src/pages/FileScannerPage.tsx:695-710` já consome esses rótulos. Continua 🟡 **só por falta de validação humana no ecrã** — não há código pendente._

#### `ui-dead-riskgauge` - ⚪ PLANNED

NOVO (2026-09-28) — Componente morto `RiskGauge.tsx` que diz "Seguro" e não é importado por ninguém — _Descoberto na ronda de arquitetura de componentes (qoder) e confirmado pelo Maestro: `packages/app/src/components/RiskGauge.tsx` não aparece em nenhum import do `src` nem dos testes (as únicas ocorrências do nome estão dentro do próprio ficheiro), mas na linha **44** atribui `statusLabel = "Seguro"` — precisamente a copy que o projeto decidiu não usar (nenhuma deteção não é garantia; ver `scan-safe-copy`). Código morto com uma promessa desonesta à espera de ser religado. Ação: confirmar ausência de consumidores, remover ou integrar com copy honesta, e só depois fechar. Nada foi alterado._

#### `scan-full-smoke` - 🟡 PROGRESS

Smoke test manual final: Rápida → Profunda → Ficheiro → Pasta → ZIP → Cancelar → navegar e voltar — _Falta o manual test com o EICAR real (`eicar_com2.zip`): a deteção do EICAR real ainda não foi observada ao vivo (só o canário dev)._

#### `scan-runtime-quality` - ✅ DONE

Corrigir progresso, contadores e desempenho da Análise Profunda — _A parte dos contadores foi fechada em `scan-threat-counter` (2026-09-25). **DONE 2026-09-26:** auditado com teste em vez de patch - 8 testes novos em `packages/service/test/scan-runtime-quality.test.js`, registados no script `test` do service; service 110/110. A evidencia nao pediu alteracao em `scan-manager`, `engine` nem `analysis`, por isso nao foram tocados (nada de patch especulativo). **O que fica por validar manualmente pertence a `scan-full-smoke`** (scan completo + cancelamento ao vivo), que se mantem Em curso._

#### `scan-zip-nested-count` - ✅ DONE

NOVO (2026-09-25) — Corrigir contagem em ZIPs aninhados — _A recursão conta as entradas internas **e** o próprio ZIP aninhado (possível contagem dupla) e `nestingDepth > ZIP_MAX_NESTING` com guarda `<` permite 4 níveis (off-by-one). Descoberta da revisão independente. 2026-09-25 (Qoder): delegada a kiro (builder auto) — scope limitado a `service/scan-manager.ts` + `test/scan-manager.test.js`. DONE (kiro entregou, Qoder reviu): dupla contagem corrigida (scanArtifact só no else quando não há recursão), guarda `>= ZIP_MAX_NESTING` consistente, params mortos removidos, 5 testes novos (AdmZip in-memory, sem zip bomb); verificação combinada: service 95/95, `git diff --check` limpo._

#### `scan-observability` - ✅ DONE

NOVO (2026-09-25) — Tornar a sessão de scan observável (persistir/registar progresso e resultado terminal) — _`scan.progress` e o payload `completed` são IPC-only e nunca são persistidos: o contador `threatsFound` não é auditável e o sintoma P0-A era invisível nos logs. DONE (com arch-log pela Kilo): `scanId` no topo do `scan.progress` e nas linhas de scan; só eventos úteis em `security-events.log` (file.*/process.*/scan.progress fora do disco, broadcast à UI mantido); log por ficheiro excluído exige `CYBERSAFE_DEBUG_BRIDGE=1`._

### Motores de Segurança & Protection Health

#### `prot-yara` - ✅ DONE

YARA-X funcional com regras válidas e testes

#### `prot-hash` - ✅ DONE

Hash DB com SHA-256 e fallback offline — _2026-09-25: hash EICAR fabricado (MD5+zeros) substituído pelo SHA-256 real (`275a021b…`) e base empacotada pela primeira vez em `packages/service/definitions/hashes/default.json`._

#### `prot-clam-state` - ✅ DONE

ClamAV reporta degraded/unavailable quando não está funcional — _RONDA 2026-09-28: honestidade do estado `degraded` validada (PASS) — motor instalado não é motor operacional; sem base de assinaturas não houve análise e o estado não pode ser lido como "ficheiro limpo"._

#### `prot-native-state` - ✅ DONE

Native Engine reporta unavailable quando não está disponível

#### `prot-firewall` - ✅ DONE

Estado do Firewall integrado no ProtectionHealth — _RONDA 2026-09-28: separação honesta entre o estado do Windows Firewall e o módulo/filtro WFP do CyberSafe — PASS. Um estado desconhecido do Windows Firewall não pode ser apresentado como proteção desligada; o módulo WFP inativo é reportado como tal, com motivo acionável._

#### `prot-health` - ✅ DONE

ProtectionHealth centralizado sem fingir motores ativos

#### `ui-degraded-copy` - ✅ DONE

Copy "Degradada" removida da UI visível (tray + ReportsPage); enum técnico interno mantido — _2026-09-25 (Qoder): tray "Proteção: Precisa de atenção · N/100" e relatório "Proteção precisa de atenção"; desktop 29/29 PASS._

#### `entitlement-premium-leak` - ✅ DONE

NOVO (2026-09-25) — Personal premium recebe features business-only — _Confirmado no ramo premium de `getUserFeatures` (`...Object.values(FEATURES)` sem filtro de conta). Delegado a **kiro** (scope `featureControl.ts` + `business-feature-control.test.ts`) após **non-delivery da Continue** (reportou "completed" sem tocar no código — verificar sempre diffs dos locais antes de dar por feito). DONE (kiro): premium filtra BUSINESS_SPECIFIC_FEATURES quando accountType!=='business' (Set para dedupe); 4 testes novos (personal-premium sem USB/REPORTS/DEVICE_MANAGEMENT; business-premium intacto; personal mantém as suas; free/pro iguais). Gate final Qoder: core 140, service 95, app 151, desktop 29 — 0 falhas; typecheck PASS; `git diff --check` limpo._

#### `prot-score` - ✅ DONE

Separação correta Protection Score ≠ PcState

#### `prot-eicar` - ✅ DONE

Testes de integridade com EICAR / regras YARA

#### `prot-quarantine` - ✅ DONE

Quarentena: mover, restaurar, apagar e metadados/manifest

#### `prot-defs` - ✅ DONE

Updater/scheduler de definições

#### `prot-clam-config` - 🟡 PROGRESS

Fechar configuração/distribuição do ClamAV para funcionar sem setup manual frágil — _Já houve falha de freshclam/config no ambiente de desenvolvimento. **Diagnostico fechado 2026-09-26 (honesto, DONE na parte do estado):** nao existe base de assinaturas em lado nenhum - `definitions/clamav` vazio, diretorio do Chocolatey vazio e `C:\ProgramData\ClamAV` vazio, e o `freshclam` nao popula; o binario existe mas sem base nao ha varrimento. Logo o estado **degraded do ClamAV esta correto** e e isso que os motores reportam (`prot-clam-state` ✅ mantem-se). **Falta (bloqueia o FECHO, nao o estado):** distribuir as definitions no pacote ou correr freshclam com rede, e so ai `prot-clam` passa a active._

#### `prot-hash-update` - ✅ DONE

Robustecer atualização da base de hashes / tratamento de falhas do feed — _2026-09-25: `refreshBuiltinIfStale()` re-semeia a base em disco no `init()`; migração confirmada no ambiente real (~/.cybersafe-service/.../default.json atualizado às 07:25:08Z com o EICAR real). **DONE 2026-09-26:** a base offline de referência (EICAR) nunca desaparece com feed parcial ou inválido — o refresh só substitui quando o payload é válido e não retira os registos embutidos. Evidência: `hash-db-refresh` 18/18, regressão combinada `engine-integrity` + `signatures` 29/29, `tsc` do core exit 0. **Pendente (não é desta tarefa, fica registado):** `applyRemoteRecords()` existe mas não é chamado por `engine.ts` nem `updater.ts` — o feed remoto ainda não aplica registros; só a defesa contra feed mau está provada._

#### `prot-history` - ✅ DONE

Histórico consolidado de deteções, ações e quarentena — _Fechado 2026-09-28 com validação manual do utilizador: no scan real de 2026-09-28 (800 verificados, 49 excluídos, 3 ameaças) a página Ameaças devolveu de imediato as 3 deteções — histórico e deteções coerentes com o resultado do scan, sem divergência entre Scanner e Ameaças. **RONDA 2026-09-28:** a divergência Scanner → Ameaças teve causa provada e fix aplicado nesta ronda; a confirmação nominal de uma deteção única dependia deste bug._

#### `prot-detection-quality` - ✅ DONE

NOVO (2026-09-28) — Qualidade das deteções: limpeza dos fixtures/probes de desenvolvimento — _Em curso, **bloqueado pela limpeza dos fixtures dos probes**. As 3 deteções que aparecem hoje no ambiente de desenvolvimento são fixtures e probes nossos em `%TEMP%` (`dev_canary_signature` + `suspicious_location`), **não** falsos positivos reais; por isso as contagens atuais do scanner não são baseline confiável enquanto os fixtures não forem removidos do caminho de análise. Bloqueia também a medição honesta de `scan-enum-perf`. Nada foi limpo até agora; nenhuma deteção foi escondida ou apagada do histórico sem decisão explícita. **DONE 2026-09-28 (fecho):** as 3 deteções do scan real de 2026-09-28 eram todas fixtures e probes nossos em `%TEMP%`; zero VS/VSIX benigno sinalizado; os 2 ficheiros-fonte dos probes continham o canário em claro e foram apagados, tal como o canário residual que estava na raiz do repo; os testes do core e do service passaram a deixar `%TEMP%` com 0 diretórios vazados. **RONDA 2026-09-28 (evidência numérica):** 46 falsos positivos reduzidos a 1 num scan real. Sem allowlist de Visual Studio e sem baixar thresholds globais._

### Proteção em Tempo Real & Windows

#### `rt-watcher` - ✅ DONE

Watcher de Downloads/Desktop/Documents/Temp/Startup

#### `rt-process` - ✅ DONE

ETW de processos / infraestrutura de eventos nativos

#### `rt-amsi` - ✅ DONE

AMSI em modo user-space/simulação claramente identificado

#### `rt-firewall` - ✅ DONE

Leitura/health do Firewall do Windows

#### `rt-health` - ✅ DONE

Windows Health: serviços, firewall, processos, rede, discos, utilizadores e registo

#### `rt-epperm` - 🟡 PROGRESS

Tratar junctions/reparse points e reduzir spam EPERM dos watchers

#### `rt-defender` - ⚪ PLANNED

Estado do antivírus/Windows Security via SecurityCenter/Defender quando aplicável

#### `rt-events` - ⚪ PLANNED

Auditoria de eventos críticos do Windows (energia, disco, sistema)

#### `rt-filearrival` - 🟡 PROGRESS

Detetar novos ficheiros fora do browser com monitorização nativa e analisar quando relevante

#### `rt-motw` - ⚪ PLANNED

Usar Mark of the Web (Zone.Identifier) quando disponível como contexto de risco

#### `rt-lowlevel-validation` - ⚪ PLANNED

Validar ETW, AMSI e WFP com testes controlados — _ETW/AMSI podem ser testados no PC real; WFP preferencialmente em VM quando houver bloqueio real._

### Saúde do PC & Telemetria

#### `health-cpu` - ✅ DONE

Telemetria CPU real

#### `health-ram` - ✅ DONE

Telemetria RAM real

#### `health-disk` - ✅ DONE

Uso/capacidade de armazenamento

#### `health-network` - ✅ DONE

Telemetria de rede

#### `health-gpu` - ✅ DONE

Telemetria GPU por systeminformation quando disponível

#### `health-ring` - ✅ DONE

Ring buffer (~60 amostras) + sparklines sem persistência

#### `health-pccenter` - ✅ DONE

PC Center: hardware, processos, rede, sensores e saúde do sistema

#### `health-findings` - ✅ DONE

PcState/findings com severidades e categorias

#### `health-temp` - 🟡 PROGRESS

Temperaturas reais CPU/GPU/NVMe/board/fans via provider robusto — _Prioridade seguinte após fechar o Scanner._

#### `health-lhm` - ⚪ PLANNED

Helper persistente LibreHardwareMonitor, cache curto e lifecycle limpo — _PÓS-PAP / BACKLOG_

#### `health-temp-bundle` - ⚪ PLANNED

Bundlar helper/sensores no CyberSafe sem download silencioso nem instalação manual

#### `health-smart` - ⚪ PLANNED

S.M.A.R.T. de SSD/HDD (vida útil, health/warnings)

#### `health-stress` - 🟡 PROGRESS

Rever Stress Index para representar pressão instantânea real e explicar “Como é calculado?”

#### `health-diskfinding` - ✅ DONE

Pouco espaço em disco como finding de saúde, separado de stress instantâneo

#### `health-thermal-actions` - ⚪ PLANNED

Alertas térmicos + ação segura/opt-in em vez de desligamento automático por defeito

#### `health-taskmanager` - ✅ DONE

NOVO (2026-09-25) — Task Manager (PC Center): lista de processos e terminação de processos — _PATCH FEITO (qoder, 2026-09-25), READY FOR MANUAL TEST. Causa LIST confirmada: `processes.list` devolvia só o cache de eventos com cap silencioso de 200 — ~139 de 331-339 processos invisíveis; agora `listProcesses()` reconcilia on-demand com a verdade do SO (TTL 2s, fallback cache, sem cap). Causa KILL confirmada: `taskkill` corria com `stdio ignore` (stdout/stderr descartados) e só mapeava 0/128 — exit 5 vira `access-denied` com a mensagem real; `exitCode/stdout/stderr` propagados até à UI; `actions.log` com Cmd/Status/Exit/Stdout/Stderr. Live no pipe real: 339 processos com proteção OFF; notepad (WMI) visível → killed exit 0 → PID ausente no tasklist → sem stale; System#4 e explorer recusados ANTES do taskkill. Testes: core 136/136, service 61/61 (8 novos), app 147/147 (3 novos), desktop 29/29, typecheck PASS, `git diff --check` limpo. Falta: validação manual na UI (terminar um notepad; tentar matar um serviço protegido e ver a mensagem de acesso negado com o diagnóstico real). REVISÃO QODER 2026-09-25: diff confirmado sem regressão (chain `access-denied` core→types→service→app com testes); focados core 140/140, service 66/66, app 147/147, desktop 29/29 PASS._ _**REABERTO 2026-09-26 - bug reproduzido pelo utilizador - READY FOR MANUAL TEST.** Sintoma: o caminho sem pesquisa (U) divergia do caminho com pesquisa (F) - no U a area principal ficava praticamente vazia/escura, a resposta ao clique era inconsistente, havia muito loading e num caso o processo nem foi terminado; no F (pesquisa notepad) o fluxo era normal. RAIZ EM DUAS CAMADAS: (1) `snapshotProcesses` engolia o erro da enumeracao e devolvia um mapa vazio, pelo que `listProcesses()` esvaziava o cache, carimbarva-o como fresco e mostrava uma lista vazia enquanto o aviso do kill dizia sucesso; (2) o modal de confirmacao do Gestor de Tarefas nao identificava o processo e a lista reordenava por CPU a cada refresh - as linhas mudavam de sitio sob o cursor e o utilizador confirmava um PID que nunca viu. FIXES ENTREGUES: a fronteira passou a lancar no falhanço da enumeracao primaria e o servico serve o cache em vez de uma lista vazia (`native-windows/src/index.ts` langa Enumeracao de processos indisponivel; `engine.ts` mantem cache e TTL no catch); o modal passou a mostrar nome, PID, utilizador e memoria; a ordenacao e deterministica (metrica, depois nome, depois PID); o overlay fecha com o resultado terminal do kill e o refetch passa a correr em segundo plano. Prova do defeito no codigo anterior por `git show HEAD` do modal: zero ocorrencias de nome/PID; e do `handleKill`: `await refreshProcesses()` dentro do try antes do finally que fechava o overlay. **AINDA EM ABERTO:** P6 e P7, o refetch ainda e o fetchSnapshot de 7 pedidos do `App.tsx` e um snapshot mais velho pode sobrepor-se a um mais novo; e falta a validacao manual do caminho sem pesquisa pelo utilizador. **KILL-BUDGET ENTREGUE (correcao a esta nota, que estava errada):** o servico passou a ter UM orcamento total de 12 s (`KILL_TOTAL_BUDGET_MS`, `engine.ts:188`) com `remaining()` por etapa - `killDeadline` (1368), `step(ceiling)` (1371), orcamento esgotado devolve `timeout` sem chegar a disparar o taskkill (1403-1408), `runTaskkill` recebe `timeoutMs: remaining()` (1412) e o reap e limitado por `Math.min(killReapDeadlineMs, remaining())` com piso (1509-1510). 12 s fica abaixo dos 15 s do prazo do renderer, que era exatamente o objectivo do P4. Testes desta ronda: task-manager-page 16 novos + task-kill-flow, 38/38; service 110/110; typecheck verde._ _**P0-A 2026-09-26 (Fast Builder/qoder) - READY FOR MANUAL TEST.** Patch aplicado nos 4 pontos diagnosticados: **P1** tombstones + epoca no servico (`engine.ts`) - um PID confirmado morto nunca volta por uma enumeracao em voo nem por um `process.started` velho, e o TTL so se re-arma se nada mudou entretanto; **P2** probe pelo CIM - o OpenProcess diz vivo a um processo ja terminado enquanto houver handles (caso classico do Notepad), entao a morte confirma-se por duas ausencias consecutivas no Win32_Process e a query-alvo passou a ser rate-limited (antes ate ~33 PowerShell num kill lento); **P3** desfecho terminal invalida sempre a janela de frescura (`reused` tira a entrada do dono antigo sem tombstone; `still-running` nao mente para baixo mas força nova leitura); **P5** `alias-stub` no renderer - o desfecho existia no servico e nos tipos mas caia no erro generico e nao fazia refetch (era o um run nunca acabou). Evidencia: service 110/110, app 182/182, `process-kill` 32/32, typecheck verde, `git diff --check` limpo. **Pendentes:** P4 (orcamento do kill) **ja foi entregue** a 2026-09-26 com um budget total de 12 s no servico, restando P6-P9 (sequenciacao de snapshots no App/PC Center, polling do Gestor de Tarefas, head-of-line no socket, timeout no ServiceClient), P11 (identidade com CreationDate), e os 4 passos de validacao manual do utilizador (matar notepad e nao voltar; alias-stub com PID real; processo com handle pendurado; cronometrar o clique)._ _**DONE 2026-09-28:** validacao manual do utilizador confirmada (listagem e terminacao de processos pelo caminho sem pesquisa, incluido o modal com nome/PID). Os itens P6-P9 e P11 continuam registados acima como refinamentos de arquitetura, sem bloquear o fecho desta tarefa. **GATE MANUAL 2026-09-28: PASS**, incluindo o comportamento de tombstone — um PID confirmado morto não volta a aparecer na lista._

### Matrix AI & Experiência Inteligente

#### `mx-context` - ✅ DONE

Respostas contextuais curtas e orientadas ao estado real do PC

#### `mx-format` - ✅ DONE

Modelo DADO TÉCNICO → SIGNIFICADO → PRIORIDADE → ORIENTAÇÃO

#### `mx-findings` - ✅ DONE

Matrix explica findings sem obrigar utilizador comum a interpretar PID/hash/portas

#### `mx-policy` - ✅ DONE

Testes de grounding e brevidade

#### `mx-phishing` - ✅ DONE

Pedir contexto quando necessário (ex.: phishing)

#### `mx-truth` - ✅ DONE

Estado ONLINE/LOCAL verdadeiro, sem fingir disponibilidade

#### `mx-model` - ✅ DONE

Provider Groq / groq/compound integrado

#### `mx-onboarding` - ✅ DONE

Onboarding overlay em 3 passos com persistência

#### `mx-moods` - ✅ DONE

Assets/moods Matrix (safe/guide/alert/success/happy/defender/avatar/mini)

#### `mx-business` - ⚪ PLANNED

Matrix Business para explicar eventos de rede e anomalias de egress

### CyberSafe Business

#### `biz-access` - ✅ DONE

Conta Business dá acesso ao Business Security Center independentemente do plano

#### `biz-center` - ✅ DONE

Business Security Center Phase 1

#### `biz-udp` - ✅ DONE

UDP marcado “Indisponível” quando não há recolha real

#### `biz-dest` - ✅ DONE

Métrica “Destinos únicos” sem fingir que todos são externos

#### `biz-tcp-map` - 🟡 PROGRESS

Corrigir/validar mapeamento real Get-NetTCPConnection (state, ::, listeners, portas)

#### `biz-proc` - 🟡 PROGRESS

Correlação PID → processo confiável

#### `biz-inventory` - ⚪ PLANNED

Network Inventory de dispositivos da rede — _PÓS-PAP / BACKLOG_

#### `biz-iphelper` - ⚪ PLANNED

Usar IP Helper API / GetIpNetTable2 / GetExtendedTcpTable/GetExtendedUdpTable — _PÓS-PAP / BACKLOG_

#### `biz-etw` - ⚪ PLANNED

ETW para telemetria/fluxos de rede em tempo real — _PÓS-PAP / BACKLOG_

#### `biz-baseline` - ⚪ PLANNED

Traffic Baseline por dispositivo/processo — _PÓS-PAP / BACKLOG_

#### `biz-egress` - ⚪ PLANNED

Egress Anomaly Detection sem afirmar “data theft” com um único sinal — _PÓS-PAP / BACKLOG_

#### `biz-wfp` - ⚪ PLANNED

WFP para controlo/bloqueio de tráfego no endpoint — _PÓS-PAP / BACKLOG_

#### `biz-downloads` - ⚪ PLANNED

Associar downloads/eventos ao deviceId do endpoint — _PÓS-PAP / BACKLOG_

#### `biz-agentconsole` - ⚪ PLANNED

Arquitetura Agent por PC → Business Console — _PÓS-PAP / BACKLOG_

#### `biz-multi` - ⚪ PLANNED

Gestão de múltiplos endpoints — _PÓS-PAP / BACKLOG_

#### `biz-policies` - ⚪ PLANNED

Políticas centrais e alertas empresariais — _PÓS-PAP / BACKLOG_

#### `biz-rgpd` - ⚪ PLANNED

Privacy-by-design: local-first, minimização, metadata-first, sem payload por defeito — _PÓS-PAP / BACKLOG_

#### `biz-deviceid` - ⚪ PLANNED

deviceId pseudónimo + separação opcional da identidade do funcionário — _PÓS-PAP / BACKLOG_

#### `biz-retention` - ⚪ PLANNED

Retenção configurável + limpeza automática de dados empresariais — _PÓS-PAP / BACKLOG_

#### `biz-rbac` - ⚪ PLANNED

RBAC e audit log para consola Business — _PÓS-PAP / BACKLOG_

#### `biz-mtls` - ⚪ PLANNED

Canal seguro Agent ↔ Console (TLS/mTLS quando multi-endpoint existir) — _PÓS-PAP / BACKLOG_

#### `biz-onprem` - ⚪ PLANNED

Opção on-premise para clientes empresariais — _PÓS-PAP / BACKLOG_

#### `biz-networkwide` - ⚪ PLANNED

Integrações futuras com routers/firewalls (UniFi/pfSense/OPNsense/Fortinet/Cisco/MikroTik) — _PÓS-PAP / BACKLOG_

### Extensão do Navegador

#### `ext-mv3` - ✅ DONE

Extensão Manifest V3 com background/content/popup

#### `ext-phishing` - ✅ DONE

Heurísticas de phishing/URL

#### `ext-http` - ✅ DONE

Deteção de HTTP inseguro

#### `ext-downloads` - ✅ DONE

Heurísticas/eventos de downloads

#### `ext-badge` - ✅ DONE

Badge por severidade

#### `ext-privacy` - ✅ DONE

Privacidade: sem recolha sensível por defeito

#### `ext-agent` - 🟡 PROGRESS

Ligação robusta extensão → agente CyberSafe para analisar downloads no endpoint

#### `ext-business` - ⚪ PLANNED

Eventos de browser minimizados para o Business Center (domínio/origem em vez de conteúdo) — _PÓS-PAP / BACKLOG_

### Interface, Temas & Interaction Polish

#### `ux-core` - ✅ DONE

Tema CyberSafe Core

#### `ux-neon` - ✅ DONE

Tema CyberSafe Neon

#### `ux-matrix` - ✅ DONE

Tema Matrix Terminal

#### `ux-red` - ✅ DONE

Tema Red Belbete (dark burgundy/ruby + light rose/ice)

#### `ux-lightfix` - ✅ DONE

Correção de accent no Light Mode

#### `ux-typography-stable` - ✅ DONE

NOVO (2026-09-28) — Tipografia estável: Light/Dark mudam só cor, nunca font-family — _Bug novo reportado pelo utilizador: ao alternar Modo Claro/Modo Escuro a família tipográfica mudava. **Raiz:** `--font-inter`/`--font-jetbrains` estavam declarados dentro de blocos acoplados ao modo de cor — `[data-theme="cybersafe-neon"]:not(.dark)` re-definia o stack e o bloco `.dark` não, deixando o Neon dark cair para o stack de `:root`; pior, o Matrix Terminal só declarava o seu monospace em `:not(.dark)`, logo perdia JetBrains Mono no modo escuro. **Fix (eixos separados):** COLOR MODE = light|dark (só cor); TYPOGRAPHY = identidade do tema. Os tokens de fonte passaram a viver exclusivamente em `:root`, com uma única exceção de identidade — bloco `[data-theme="matrix-terminal"]` sem referência ao modo, que preserva JetBrains Mono em claro **e** escuro. Nenhuma fonte nova, nenhuma cor alterada. **Evidência:** teste de regressão novo `packages/app/test/theme-typography.test.ts` (mini-cascade por tema × modo; falha se Light e Dark voltarem a ter famílias diferentes — provado por injeção temporária de `--font-inter` num bloco `.dark`); app 283/283, typecheck, build do app, `git diff --check` OK. **RONDA 2026-09-28 (validação manual): PASS** — ao alternar Modo Claro/Modo Escuro a família tipográfica mantém-se a mesma._

#### `ux-tray-dpi` - 🟡 PROGRESS

NOVO (2026-09-28) — Ícone da bandeja dimensionado ao DPI real do Windows — _**VALIDAÇÃO MANUAL DO UTILIZADOR: taskbar PASS; tray popup FAIL VISUAL** — o símbolo continua perceptivelmente menor que os vizinhos. **Ronda 2 (2026-09-28) — causa medida e variantes geradas:** a dimensão nominal já estava certa (`trayIconSizePx`); o que faltava era a **ocupação visual do glyph**. Medido: o `icon-32.png` tem alpha bbox **90,6% linear** (padding ~4% por lado, `ICON_SAFE_MARGIN = 0.04` do script de branding) — os vizinhos (NVIDIA/Razer/Windows Security) desenham praticamente edge-to-edge; a 150% isso são ~2,3 px de glyph perdido. **Achado adicional:** o `main.ts:316-320` já preferia `tray-icon-active.png`/`tray-icon-warning.png`, mas esses ficheiros **nunca tinham sido gerados** — a tray vivia sempre no fallback. **Fix (Kilo Builder, scope `scripts/generate-branding-derivatives.py` + PNGs novos):** variantes tray-specific do MESMO tile com `TRAY_SAFE_MARGIN = 0.01` — medido **96,9% linear** em 32 px; publicadas em `desktop/src/assets/cybersafe/` (nomes exatos sem sufixo + `-16`/`-32`); `icon-32.png` intacto (90,6% verificado depois), `icon.ico`, janela, logo e mestre intocados. **Provas automáticas:** desktop 29/29, typecheck PASS. **Pendente:** validação visual do utilizador a 100/125/150% (comparar screenshot antes/depois). READY FOR MANUAL TEST._

#### `ux-liquid` - 🟡 PROGRESS

Tema CyberSafe Liquid experimental

#### `ux-semantic` - ✅ DONE

Cores semânticas independentes do tema

#### `ux-dashboard-polish` - 🟡 PROGRESS

NOVO (2026-09-26) — Painel: pergunta central, hierarquia de estado e menos ruido visual — _Sem redesign, sobre a versao atual. Hero compactado (padding, anel 28 para 68 px, Matrix de xl para md, categorias em linha) a responder a uma so pergunta: O meu computador esta bem? com resposta curta por nivel (`answer`/`answerDetail` em protectionHealth); Protection Score com numero, estado e nota de definicoes em hierarquia clara; CPU/RAM/Disco/Rede como metricas principais e GPU/VRAM reduzidas a uma linha secundaria; disco passa a mostrar espaco LIVRE, o que significa e o que fazer (`describeDiskSpace`, duas regras: GB absolutos e percentagem); acoes do Scanner agrupadas num painel com uma primaria e duas secundarias; empty states de ameacas e alertas de uma linha; fim das repeticoes de aviso (o hero nao repete a lista de prioridades, os cartoes de metrica deixaram de imprimir o alerta vermelho que ja la estava, rotulos de severidade em PT); menos cyan decorativo (icones para muted, glow da Sidebar removido, hexagonos 0.03 para 0.02 e cyber-grid 4% para 3%, scrollbar global fina coerente com o ProtectionDetails). **Bug real corrigido:** o cartao Quarentena mostrava `pcState.findings.length` (recomendacoes, nao quarentena) e passou a chamar-se Recomendacoes - nao se inventou contagem de quarentena porque `DashboardSummary` nao traz esse campo. Evidencia: `dashboard-layout` 14/14 e `protection-health` 13/13, gate do Maestro typecheck verde + app 182/182. **Falta:** validacao visual em 3 larguras (o hero usa flex-wrap com order) e contagem real de quarentena exige campo novo no `DashboardSummary` (backend)._

#### `ux-scanner-steps` - ⚪ PLANNED

Adaptar Multi Step Loader/step indicator para fases reais do Scanner — _PÓS-PAP / BACKLOG_

#### `ux-statebutton` - ⚪ PLANNED

Stateful Button para ações assíncronas (quarentena, corrigir, restaurar, atualizar) — _PÓS-PAP / BACKLOG_

#### `ux-circular` - ⚪ PLANNED

Circular Progress para Protection Score / métricas quando fizer sentido — _PÓS-PAP / BACKLOG_

#### `ux-alertlist` - ⚪ PLANNED

Animated List / Central de Alertas — _PÓS-PAP / BACKLOG_

#### `ux-expand` - ⚪ PLANNED

Expandable Cards para mostrar detalhes técnicos só quando o utilizador pedir — _PÓS-PAP / BACKLOG_

#### `ux-filetree` - ⚪ PLANNED

File Tree para resultado de pasta/ZIP quando útil — _PÓS-PAP / BACKLOG_

#### `ux-dragdrop` - ⚪ PLANNED

Drag & drop para analisar ficheiros, mantendo picker nativo — _PÓS-PAP / BACKLOG_

#### `ux-notificationbell` - ⚪ PLANNED

Notification Bell com contador e histórico — _PÓS-PAP / BACKLOG_

#### `ux-numberticker` - ⚪ PLANNED

Number Ticker discreto para métricas que não atualizam freneticamente — _PÓS-PAP / BACKLOG_

#### `ux-glow` - ⚪ PLANNED

Border Beam / Glow apenas para estados ativos ou urgentes — _PÓS-PAP / BACKLOG_

#### `ux-reducedmotion` - ⚪ PLANNED

prefers-reduced-motion / acessibilidade das animações — _PÓS-PAP / BACKLOG_

### Notificações & Respostas Inteligentes

#### `not-toggle` - ✅ DONE

Toggle de notificações

#### `not-scan` - ⚪ PLANNED

Notificação de scan concluído — _PÓS-PAP / BACKLOG_

#### `not-protection` - ⚪ PLANNED

Notificação quando ProtectionHealth fica degradado — _PÓS-PAP / BACKLOG_

#### `not-extension` - ⚪ PLANNED

Alertas vindos da extensão — _PÓS-PAP / BACKLOG_

#### `not-business` - ⚪ PLANNED

Alertas Business (novo dispositivo, egress anómalo, etc.) — _PÓS-PAP / BACKLOG_

#### `not-thermal` - ⚪ PLANNED

Alerta térmico sustentado antes de qualquer ação automática — _PÓS-PAP / BACKLOG_

#### `not-shutdown` - ⚪ PLANNED

Encerramento por temperatura apenas opt-in e com critérios seguros — _PÓS-PAP / BACKLOG_

#### `not-smart` - ⚪ PLANNED

SMART warning → recomendar backup, sem upload automático sem consentimento — _PÓS-PAP / BACKLOG_

#### `not-center` - ⚪ PLANNED

Central de Alertas com prioridade e histórico — _PÓS-PAP / BACKLOG_

### Conta, API & Autenticação

#### `auth-register` - ✅ DONE

Register/Login/Me local com bcrypt/JWT/Prisma

#### `auth-pages` - ✅ DONE

Páginas Login/Register

#### `auth-accounttype` - ✅ DONE

Tipo de conta Personal/Business no modelo e registo

#### `auth-email` - ⚪ PLANNED

Confirmação por e-mail — _Não implementada atualmente; não deve ser descrita como pronta._ — _PÓS-PAP / BACKLOG_

#### `auth-business-rbac` - ⚪ PLANNED

Permissões Business/RBAC futuras — _PÓS-PAP / BACKLOG_

### Empacotamento, Arranque & Distribuição

#### `dist-electron` - ✅ DONE

Desktop Electron funcional em desenvolvimento

#### `dist-autostart` - 🟡 PROGRESS

Autostart com Windows / iniciar minimizado — _Implementado, mas falta validação final em build empacotado._

#### `dist-installer` - ⚪ PLANNED

Gerar instalador final CyberSafe-Setup.exe — _Estado real 2026-09-28 (verificado em disco): `electron-builder` está configurado no workspace desktop (target `nsis`, output `release`) e já existe build de diretório gerado — `packages/desktop/release/win-unpacked` com `CyberSafe Assistant.exe` + `builder-debug.yml`. **Não existe** `CyberSafe-Setup.exe`: o empacotamento funcional existe em modo `dir`, falta a geração e validação do instalador final. `dist-autostart` mantém-se Em curso pela mesma razão (falta validação em build empacotado, que ainda não existe)._

#### `dist-helper` - ⚪ PLANNED

Bundlar temperature helper/dependências necessárias no instalador

#### `dist-clam` - ⚪ PLANNED

Bundlar/configurar motores externos necessários sem downloads silenciosos em runtime

#### `dist-cleanvm` - ⚪ PLANNED

Teste de instalação e primeiro arranque em Windows/VM limpa

#### `dist-upgrade` - 🟡 PROGRESS

Estratégia de atualização do aplicativo e definições

#### `dist-sign` - ⚪ PLANNED

Assinatura de código/installer para distribuição real

#### `rel-selfdetect-canary` - ✅ DONE

NOVO (2026-09-28) — Release self-detection: dev canário dentro do bundle — _O literal do canário vivia em `packages/core/src/signatures.ts`, compilava para `core/dist` e o electron-builder embute `node_modules` no `app.asar` — o `app.asar` empacotado continha o literal **4 vezes**, ou seja o CyberSafe empacotado detetava-se a si mesmo. Correção: o literal saiu do src e passou para fixtures só de teste (`packages/core/test/fixtures/dev-canary.js` e `packages/service/test/fixtures/dev-canary.js`); o src de produção ficou só com a deteção por hash, que não contém a assinatura. Repackaged e medido: `app.asar` novo com **zero** ocorrências do literal; `app.asar.unpacked` também **zero**._

### Relatórios & Evidências

#### `rep-a4` - ✅ DONE

Relatório A4 com cabeçalho, ameaças, quarentena, motores, hardware e findings

#### `rep-score` - 🟡 PROGRESS

Garantir que relatório consome PcState/ProtectionHealth corretos em vez de score próprio antigo — _**READY FOR MANUAL TEST 2026-09-26:** o relatorio interno passa a consumir PcState e ProtectionHealth em vez de calcular score proprio; nao ha metrica paralela; a ausencia de dados aparece como indisponivel e nunca como zero nem como saudavel. Evidencia: 17/17 testes focados. **Falta:** validar o PDF A4 impresso (layout) e confirmar que o espelho do build reflete o `core dist`._

#### `rep-export` - ✅ DONE

Impressão/PDF do relatório

#### `rep-e2e-canary` - ✅ DONE

NOVO (2026-09-25) — Teste E2E do pipeline de deteção sem EICAR real (canário dev-only) — _`packages/service/test/dev-canary.test.js`: scan real → deteção → `threat.detected` → `threatsFound`, com o mesmo contrato do `engine.ts`, e o caso inverso em `NODE_ENV=production` (0 deteções). Permite validar o pipeline sem disparar o Windows Defender._

#### `rep-business` - ⚪ PLANNED

Relatório Business de eventos/risco de rede

#### `rep-privacy` - ⚪ PLANNED

Relatório/explicação “o que o CyberSafe monitoriza” para transparência Business

### PAP — Relatório, Documentação & Apresentação

#### `pap-definition` - ✅ DONE

Definição do projeto: “CyberSafe Assistant — Centro Inteligente de Segurança e Saúde do PC”

#### `pap-origin` - ✅ DONE

Explicar evolução: começou como antivírus e cresceu para centro integrado de segurança + saúde

#### `pap-cycle` - ✅ DONE

Ciclo conceptual Monitorizar → Detetar → Priorizar → Proteger → Corrigir → Verificar

#### `pap-architecture` - 🟡 PROGRESS

Documentar arquitetura React → Electron → Service → Core/Windows/Motores

#### `pap-realstate` - ✅ DONE

Regra editorial: só descrever como implementado aquilo que realmente existe/testado

#### `pap-scanner` - 🟡 PROGRESS

Capítulo do Scanner/Antivírus com Quick, Profunda, ficheiro, pasta, ZIP e motores

#### `pap-health` - 🟡 PROGRESS

Capítulo Saúde do PC / PC Center / PcState

#### `pap-matrix` - 🟡 PROGRESS

Capítulo Matrix AI e tradução de dados técnicos

#### `pap-business` - 🟡 PROGRESS

Business: separar claramente Phase 1 implementada de funções futuras

#### `pap-privacy` - ⚪ PLANNED

Privacidade/RGPD Business: local-first, minimização, transparência e limitações

#### `pap-testing` - 🟡 PROGRESS

Reunir evidências de testes, probes, builds e screenshots finais — _2026-09-25: nova evidência disponível (manual test do canário + suites core 128/128, service 53/53, typecheck limpo) e o registo da Sprint 3 no topo do ficheiro `CYBERSAFE_ORGANIZADOR.md`. **SPRINT 4 GATE FINAL (Qoder, após kiro+Kilo):** core 140/140, service 95/95, app 151/151, desktop 29/29, typecheck PASS, `git diff --check` limpo; novo `scripts/protection-state-probe.mjs` (live pipe: yara active, hashDb active, native active, clamav degraded→freshclam, firewall unavailable em dev). Falta: manual test Task Manager (Notepad) pelo utilizador. **RONDA 2026-09-28:** checkpoint git `fb38ad0` existe localmente (sem push); runtime `npm run dev` PASS após o shutdown esperado._

#### `pap-usability` - ⚪ PLANNED

Realizar testes estruturados com utilizadores reais e documentar os resultados — _Orientação do Professor Edgar Costa: tarefas reais, tempos, dificuldades, feedback e melhorias._

#### `pap-manual` - ⚪ PLANNED

Manual do utilizador

#### `pap-diagrams` - ⚪ PLANNED

Diagramas de arquitetura e fluxos

#### `pap-licenses` - ⚪ PLANNED

Referências/licenças de dependências e componentes externos

#### `pap-docx` - 🟡 PROGRESS

Documento final da PAP em DOCX baseado no modelo da escola

#### `pap-presentation` - ⚪ PLANNED

Apresentação final da PAP

#### `pap-demo` - ⚪ PLANNED

Roteiro de demonstração ao vivo com fallback para imprevistos

#### `pap-screens` - ⚪ PLANNED

Capturas finais do Dashboard, Protection, Scanner, PC Center, Matrix e Business

### Ideias Futuras / Parking Lot

#### `future-router` - ⚪ PLANNED

Integração opcional com router/firewall para visibilidade além dos endpoints Windows — _PÓS-PAP / BACKLOG_

#### `future-onprem` - ⚪ PLANNED

Business Console on-premise — _PÓS-PAP / BACKLOG_

#### `future-multios` - ⚪ PLANNED

Agentes para outros sistemas operativos (se a PAP evoluir após Windows) — _PÓS-PAP / BACKLOG_

#### `future-home` - ⚪ PLANNED

Inspiração de automação tipo Home Assistant sem transformar isso em dependência — _PÓS-PAP / BACKLOG_

#### `future-grafana` - ⚪ PLANNED

Usar ideias de Grafana/Prometheus como referência de observabilidade, sem obrigar o utilizador a instalá-los — _PÓS-PAP / BACKLOG_

#### `future-smartactions` - ⚪ PLANNED

Ações automáticas seguras e opt-in baseadas em risco/saúde — _PÓS-PAP / BACKLOG_

#### `future-motion` - ⚪ PLANNED

Microinterações MotionSites / Rare UI / Magic UI / Aceternity depois da funcionalidade estar fechada — _PÓS-PAP / BACKLOG_

---

### Tarefas sem nota tecnica registada

- `scan-native-spawn-monitor-loop`

### Divergencias

- Nenhuma: os dois ficheiros tem os mesmos ids.

---

## Parte 3 - Revisoes posteriores a compactacao (2026-09-29)

As notas desta parte 2 sao o texto **anterior** a compactacao. Duas foram
corrigidas pelo Professor Edgar Costa depois de a compactacao estar feita, por
terem misturado ou subestimado o que a task e. O texto vigente esta no
organizador oficial; aqui fica registada a correcao.

| Tarefa | Nota original (arquivada) | Correcao |
|---|---|---|
| `scan-native-spawn-monitor-loop` | "Hipotese refutada: scan-engine.exe nao cria loop com o monitor. O trafego VT observado vinha do watcher e do monitor de processos." | A task passou de **Planeada** a **Concluida**: a instrumentacao provou a hipotese falsa, nao ha implementacao pendente. A divida real de produto (VT automatico no watcher/monitor) continua separada em `vt-enrichment-design` e na politica cloud. |
| `pap-testing` | "Evidencias reunidas: suites por workspace verdes, typecheck limpo, probe de ProtectionHealth e checkpoint git local. Falta o teste manual do Gestor de Tarefas pelo utilizador." | **Nao e** o teste manual do Gestor de Tarefas. `health-taskmanager` esta DONE com o gate manual ja passado (incluindo kill e tombstone). `pap-testing` e o teste estruturado com utilizadores reais: tarefas propostas, tempo, dificuldades, feedback e melhorias. O rotulo tambem foi corrigido. |
| 10 tarefas | rotulo sem marcador | `scan-engine-batch-mode`, `rt-motw`, `rt-events`, `health-smart`, `health-thermal-actions`, `mx-business`, `rep-business`, `rep-privacy`, `dist-sign`, `ux-liquid` passaram a **POS-PAP / BACKLOG** sem mudar de estado. |
