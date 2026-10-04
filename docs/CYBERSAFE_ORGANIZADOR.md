# CyberSafe Assistant — Organizador

> **Fonte:** espelho em Markdown de `docs/cybersafe-organizador-pap-v2-editavel.html` (mesma lista de tarefas, mesmos `id`, para não haver duplicação). Atualizado em 2026-09-29.
> Regra do cartão: cada tarefa tem no máximo 1-2 frases (2-3 se estiver Em curso), com só o estado atual e o que falta. Cronologia, nomes de agentes, números de testes e tentativas falhadas não vivem aqui: estão no Git, nos testes e em [`ORGANIZADOR_HISTORICO.md`](ORGANIZADOR_HISTORICO.md).
> Regra editorial: só fica marcado como concluído aquilo que está implementado e testado (manual quando necessário). Tarefa implementada mas ainda à espera de validação manual fica **Em curso**. Não se descreve como pronto o que não existe.

## Legenda

| Estado | Significado |
|---|---|
| ✅ **Concluído** | Implementado e testado (validação manual feita quando era necessária) |
| 🟡 **Em curso** | Implementado mas ainda precisa de validação manual, ou descoberta nova ainda não resolvida |
| ⚪ **Planeado** | Ideia futura / ainda não iniciada |
| ⛔ **Bloqueado** | Impedido por algo externo |

---

## Números (2026-09-30, revisão 3)

| Métrica | Valor |
|---|---|
| Tarefas | **206** = 102 concluídas + 27 em curso + 77 planeadas + 0 bloqueadas |
| ROADMAP TOTAL | **56,1 %** (115,5/206) |
| PAP / Release Readiness | **77,7 %** (115/148) |
| PAP | 102 concluídas + 26 em curso + 20 por fazer |
| Pós-PAP / backlog | **58** (57 planeadas + 1 em curso) |

Pesos: DONE = 1, PROGRESS = 0,5, PLANNED/BLOCKED = 0. As tarefas marcadas
**PÓS-PAP / BACKLOG** ficam visíveis mas fora do denominador da PAP. O marcador
pode estar no subtítulo da secção ou no fim do rótulo da tarefa.

Mudança nesta revisão: 10 tarefas passaram para PÓS-PAP / BACKLOG sem mudar de
estado (a PAP subiu de 72,8 % para 78,1 % porque 9 zeros saíram do denominador),
`scan-native-spawn-monitor-loop` passou a DONE, e `prot-detection-quality` voltou
de DONE para EM CURSO depois de se provar um falso positivo real.

Mudança em 2026-09-30 (revisão 3, Maestro Freebuff): `prot-engine-context` (WS-B)
adicionada como concluída após validação humana do utilizador; `ux-protection-copy-polish`
adicionada ao PÓS-PAP / BACKLOG com os 2 apontamentos de copy da mesma validação.
Contagens recalculadas a partir da estrutura de dados do HTML (fonte de verdade):
206 ids = 102 done + 27 progress + 77 planned + 0 blocked — corrigida a inconsistência
anterior da revisão 2 (203 = 100+28+75, soma sem coerência com os ids do ficheiro).

Os contadores acima são os **do ficheiro**. As notas locais criadas no browser
pelo botão «+ Nova tarefa» aparecem no HTML marcadas como `nota local` e ficam
de fora destes números, para o ecrã não divergir do ficheiro. Para entrarem no
mapa oficial têm de ser adicionadas aos dois ficheiros.

Os contadores acima são os **do ficheiro**. As notas locais criadas no browser
pelo botão «+ Nova tarefa» aparecem no HTML marcadas como `nota local` e ficam
de fora destes números, para o ecrã não divergir do ficheiro. Para entrarem no
mapa oficial têm de ser adicionadas aos dois ficheiros.

## Registo

O histórico de sprints e rondas e a nota técnica integral de cada tarefa foram
movidos para [`ORGANIZADOR_HISTORICO.md`](ORGANIZADOR_HISTORICO.md) na compactação
de 2026-09-29. Aqui fica só o mapa visual: estado atual e o que falta. Estados e
ids não mudaram; a informação única continua no sítio, só que noutro ficheiro.

Este ficheiro e `cybersafe-organizador-pap-v2-editavel.html` são o organizador
oficial e têm de estar sincronizados: mesmos ids, estados, rótulos e notas.

Regra de sincronização: ao mudar uma tarefa nos dois ficheiros, subir o
`DATA_VERSION` do HTML, para o browser descartar os estados guardados.

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
- 🟡 `arch-build` — Build, typecheck e suites de testes como gate de qualidade — _Build, typecheck e testes principais funcionam. O lint do app continua vermelho por dívida conhecida em hooks/react-refresh; o lint do desktop ainda é cosmético. Correção adiada para depois dos itens críticos da PAP._
- 🟡 `arch-clean` — Eliminar warnings/runtime noise recorrente que atrapalha diagnóstico (watchers EPERM, etc.) — _Não bloqueia o produto, mas ainda aparece no runtime._
- ✅ `arch-log-hygiene` — Higiene dos logs de runtime do serviço (rotação/limite de tamanho) — _Logs do serviço com rotação por tamanho e retenção real; o passivo de 6,4 GB foi reduzido para 32 MB. 24 testes novos cobrem o comportamento._
- ✅ `test-tmpdir-leak` — API temp DB leak: ligação sqlite singleton a vazar diretórios em `%TEMP%` — _Corrigido o leak de ligação sqlite que vazava diretórios em %TEMP% por execução de teste. Zero diretórios vazados depois da correção._

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
- ✅ `scan-file-runtime` — Confirmação visual manual final do scan de ficheiro único no Electron — _Validação manual na UI passou: 1 ficheiro, 1 ameaça, toast de deteção e sem quarentena._
- ✅ `scan-threat-counter` — Coerência entre o toast `THREAT.DETECTED` e o contador `threatsFound` (P0-A) — _Toast e contador usam agora o mesmo critério de ameaça. Validado em scan real na UI: 800 verificados, 3 ameaças, e a página Ameaças devolve as 3._
- ✅ `scan-copy-grammar` — Copy PT-PT do resumo do scanner (excluídos pelos motores de análise) — _Frase do resumo do scanner corrigida (verbo concordado) e validada manualmente no plural. Nada alterado em scoring, motores ou contagens._
- 🟡 `scan-enum-perf` — Performance da enumeração no scan (aberto, arquitetural) — _A enumeração não é o gargalo: 800 ficheiros são selecionados em menos de 0,25 s. O principal problema de performance estava no VirusTotal síncrono e já foi separado dos scans em massa. Falta apenas validação final de performance._
- ✅ `scan-vt-blocking` — Gancho do VirusTotal síncrono no caminho do scan: ~15,5 s por ficheiro, o gargalo real da performance — _VirusTotal deixou de bloquear Quick/Deep/Custom scans. A separação foi confirmada em runtime: zero chamadas VT originadas pelo scanner. Regressão refeita e re-fechada: scan-manager voltou a chamar sem options e foi corrigido com skipVirusTotal=true em massa (Quick/Deep/Custom/Pasta/ZIP); service 143/143. DONE._
- ⚪ `vt-enrichment-design` — Enriquecimento VirusTotal: chave inválida (401) e throttle de 15,5 s por ficheiro mesmo com chave saudável — _Decisão de produto pendente sobre o enriquecimento VirusTotal: a chave é inválida (401) e o limite de 4 pedidos/minuto manteria 15,5 s por ficheiro mesmo com chave saudável. Nada implementado._
- ⚪ `scan-pk-over500-coverage` — Cobertura zero nos contentores PK com mais de 500 entradas (expansão abortada) — _Contentores com mais de 500 entradas são abortados pelo guard e o interior nunca é analisado. Decisão de produto: subir o limite ou dizer honestamente na UI que o interior não foi inspecionado._
- ⚪ `scan-lnk-analyze-fail` — `analyze()` a lançar em alguns `.lnk` (contados em `filesFailed`) — a confirmar — _Erro de analyze() em alguns .lnk observado numa probe, ainda não confirmado no serviço real. Falta reproduzir pelo caminho real e ler filesFailed antes de corrigir._
- ⚪ `scan-engine-batch-mode` — Modo batch/residente do motor nativo (`scan-engine`) para eliminar o spawn por artefacto, _PÓS-PAP / BACKLOG._ — _Modo batch/residente do motor nativo foi medido e não implementado; o teto de ganho é ~10-13% num quick scan. Exige alterar o binário e uma decisão explícita de produto._
- 🟡 `scan-deep-scope` — Auditar/ajustar scope real da Análise Profunda para que a copy não prometa “todo o computador” sem ser verdade — _Falta confirmar volumes, paths e limites reais da Análise Profunda antes de fechar._
- 🟡 `scan-safe-copy` — Trocar “Ficheiros Seguros” por copy mais honesta (“Sem ameaças detetadas” / “Sem deteções”) — _Copy honesta já implementada no código; só falta a validação humana no ecrã._
- ⚪ `ui-dead-riskgauge` — Componente morto `RiskGauge.tsx` que diz "Seguro" e não é importado por ninguém — _Componente morto que diz Seguro, sem nenhum import. Falta remover ou religar com copy honesta._
- ✅ `scan-native-spawn-monitor-loop` — Monitor de processos pode reanalisar cada scan-engine.exe e pagar VT por spawn — _Hipótese refutada em runtime: scan-engine.exe não cria loop VT. O tráfego observado vinha do watcher e do monitor de processos. Investigação encerrada._
- 🟡 `scan-full-smoke` — Smoke test manual final: Rápida → Profunda → Ficheiro → Pasta → ZIP → Cancelar → navegar e voltar — _Falta o smoke test manual com o EICAR real; a deteção do EICAR ainda não foi observada ao vivo._
- ✅ `scan-runtime-quality` — Corrigir progresso, contadores e desempenho da Análise Profunda — _Auditado com testes em vez de patch; 8 testes novos no service. Nenhuma alteração em scan-manager, engine ou analysis porque a evidência não a pediu._
- ✅ `scan-zip-nested-count` — Corrigir contagem em ZIPs aninhados — _Dupla contagem em ZIP aninhado e off-by-one de profundidade corrigidos, com 5 testes novos. service 95/95 e diff limpo._
- ✅ `clamav-resource-exhaustion` — **P0** ClamAV esgota RAM e congela o PC durante o scan (clamscan em cascata + órfãos) — _**DONE (gate automático fechado)**. Causa raiz: o ProcessMonitor via o `clamscan.exe` que o próprio CyberSafe lançava e o motor voltava a analisá-lo, nascendo outro clamscan; cada volta segurava ~981 MB. Fase 3 (cap global de 1, `killTree` real, `dispose`, cancel, identidade por ancestralidade de PID) e Fase 4 (batch: 1 invocação para N ficheiros) implementadas._ _**Sprint 2026-10-02 (3 h)**: `dev-canary` RED (10 017 ms) → GREEN (6 741 ms) **sem mexer no timeout de 10 s**; batch result integrity A–I 20/20; caracterização de recursos **medida**, não estimada: 5 ficheiros e 20 ficheiros dão ambos **RSS de pico ~960 MB (rácio 1,00x)** e **wall 7,6 s (rácio 1,00x)**, com 1 spawn e 0 órfãos. É UM processo pesado, não uma multiplicação. Gate largo: core 417 testes / 0 falhas, service 243 / 0, app 458 / 0, typecheck limpo nos 6 pacotes, `REAL_HOME_WRITES_DURING_TEST = 0`._ _**P0 adicional encontrado e corrigido na sprint**: um `error` do ClamAV era publicado como `verdict: "safe"` com badge verde e escudo na app. Agora existe `inconclusive`. **P1 adicional**: um `exit 2` por UM ficheiro ilegível marcava os restantes como error, com o detalhe do erro de outro ficheiro copiado — corrigido pela aritmética do resumo do clamscan. **P0 adicional (TASK J)**: `isAvailable(force)` — o re-probe que existe para depois do `freshclam` — nunca era chamado; depois de uma actualização bem-sucedida o serviço continuava a reportar o motor degradado até ao reinício. Corrigido._ _**Fica pendente apenas o gate manual do utilizador** (`scanner-manual-gate`), que é uma decisão dele e não nossa. Detalhe: output/p0-clamav-resource-exhaustion/._
- ✅ `clamav-eicdar-exit2` — **P1** Um ficheiro EICAR dava `exit 2` e era reportado como limpo — _**Causa raiz provada, com duas causas — uma delas nossa**._ _(1) **O fixture de teste nunca foi EICAR.** Escrevia `"...\PZX54..."`; em JavaScript `\P` não é um escape válido, a barra invertida era descartada, e o ficheiro ficava com **67 bytes em vez de 68**. O ClamAV respondia `clean` com toda a razão. Corrigido para `Buffer.from(hex)` com três asserções de guarda por byte (`length === 68`, `bytes[11] === 0x5c`, `bytes.subarray(12,20) === "PZX54(P^"`)._ _(2) **Quem apaga o ficheiro é o Windows Defender**, no instante em que o clamscan o abre. Prova causal por `Get-MpThreatDetection` lido antes e depois: `ThreatID 2147519003`, `ProcessName=...\clamscan.exe`, `Resource=<o ficheiro>`, `ActionSuccess: True`. O clamscan dá exit 2, stdout com `Scanned files: 0`, stderr `Can't open file ...: 225 / Invalid argument`, **com a base carregada** (3 628 114 virus, 6,485 s)._ _**O diagnóstico anterior era falso**: `code === 2` era lido como "não conseguiu carregar a base", numa máquina com a base impecável. É o caso genérico de ExitCode para "algo correu mal", lido como se fosse um código de diagnóstico._ _**Fix**: o veredicto passa a vir do **output**, nunca do exit code (`parseClamavOutput`), com três estados DETECTED / CLEAN / ERROR. Ordem das regras: `FOUND` no stdout (ganha sempre) → falha de base no stderr → `Can't open file X` (error, distinguindo `file-removed-during-scan` de `file-unreadable` via `fileExists`) → `Infected files>0` sem FOUND → timeout/abort → exit 0 limpo → resto error. Separador de path = **último** `": "`, porque uma regex preguiçosa parte o `C:` do Windows e atribui a detecção ao ficheiro errado. `--no-summary` foi removido (é onde vive o `Total errors`)._ _**Conformidade com as decisões do utilizador**: nunca reportar "limpo" para um ficheiro removido; preservar a detecção mesmo quando há erro; e **não mencionar o Defender sem evidência** — o detalhe diz o facto ("o ficheiro deixou de existir durante a análise"), não a hipótese._
- 🟡 `clamav-codex-review-p1` — **P1 (x9)** Achados da review independente do Codex sobre o batch do ClamAV, ainda por tratar — _**3 dos 9 foram corrigidos na retomada de 2026-10-02 (F4, F5, F6), com testes de regressão. Os restantes 6 continuam abertos, registados e não escondidos. Nenhum foi classificado como P0._ _**Corrigidos**: basename só quando inívoco, para não atribuir uma deteção ao ficheiro errado (F4); evidência parcial nunca dá `clean` — a regra passa a disparar só quando há contagem declarada **não atribuída** (F5); descodificação UTF-8 com `StringDecoder`, para um caractere multibyte partido entre chunks não transformar uma linha `FOUND` em lixo (F6)._ _**Os que importam para a honestidade do resultado** (podem dar `clean`/`safe` sem evidência suficiente): atribuição de deteção por basename quando dois ficheiros têm o mesmo nome (clamav.ts:176); erros/deteções parcialmente identificados que deixam ficheiros sem resultado em `clean` (clamav.ts:313, :339); descodificação UTF-8 independente por chunk, que pode corromper `FOUND` em `clean` (clamav.ts:663)._ _**Os que afectam o serviço** (não o veredicto): ficheiros acima de 100 MB ignoram ERROR/DETECTED do prefetch e podem sair SAFE (analysis.ts:77); ficheiro que desaparece depois do prefetch perde a deteção e conta como analisado (analysis.ts:73, engine.ts:1443, scan-manager.ts:358); prefetch global sem isolamento por scan (engine.ts:1240, scan-manager.ts:429); cancelamento antes da criação do controller perde-se e pode arrancar um batch já cancelado (engine.ts:596, scan-manager.ts:307); SIGINT/SIGTERM termina o serviço sem `dispose()` (index.ts:185); ownership aceita PIDs antigos sem limpeza (engine.ts:774)._ _**UNKNOWN, não verificado por Codex**: kill por PID reutilizado e a segurança do `freshclam` concorrente. Nenhum foi corrigido aqui._
- 🔴 `scanner-manual-gate` — **PENDING_MANUAL** Gate manual do scanner continua por fazer — _Estado deliberadamente inalterado e **inalterável por nós**: este gate só passa quando o utilizador o executa com as próprias mãos. Nenhuma medição automática o pode substituir, e o sprint não pediu nem podia pedir esse scan._ _As condições previstas ficaram prontas e verificadas por medição automática: 1 spawn, pico de 1 processo, ~7,6 s tanto para 5 como para 20 ficheiros, 0 órfãos, 5/5 clean, `REAL_HOME_WRITES_DURING_TEST = 0`. São as mesmas condições do teste manual, medidas por outro caminho — o que prova que o caminho automático funciona, não que o manual passa._ _**Nota de 2026-10-02**: o serviço e a app passaram a distinguir `inconclusive` (badge cinzento, tom `unknown`) de `safe` (badge verde). Se o utilizador vir "Seguro" por cima de um ficheiro que desapareceu, está a correr uma build antiga — e isso é informação útil, não um problema._
- ✅ `scan-observability` — Tornar a sessão de scan observável (persistir/registar progresso e resultado terminal) — _scanId nos eventos de progresso e só eventos úteis persistidos em disco; o contador de ameaças passou a ser auditável. Log por ficheiro excluído atrás de flag de debug._

## Motores de Segurança & Protection Health
_Camadas reais do antivírus e respetivo estado de saúde._

- ✅ `prot-yara` — YARA-X funcional com regras válidas e testes
- ✅ `prot-hash` — Hash DB com SHA-256 e fallback offline — _Hash EICAR real (SHA-256) e base de hashes empacotada pela primeira vez._
- ✅ `prot-clam-state` — ClamAV reporta degraded/unavailable quando não está funcional — _Estado degradado do ClamAV validado como honesto: motor instalado não é motor operacional._
- ✅ `prot-native-state` — Native Engine reporta unavailable quando não está disponível
- ✅ `prot-firewall` — Estado do Firewall integrado no ProtectionHealth — _Separação honesta entre estado do Windows Firewall e módulo WFP validada; estado desconhecido nunca é apresentado como proteção desligada._
- ✅ `prot-health` — ProtectionHealth centralizado sem fingir motores ativos
- ✅ `ui-degraded-copy` — Copy "Degradada" removida da UI visível (tray + ReportsPage); enum técnico interno mantido — _Degradada removido da UI visível (tray e relatório); o enum técnico interno mantém-se._
- ✅ `entitlement-premium-leak` — Personal premium recebe features business-only (leak em getUserFeatures) — _Conta Personal premium deixou de receber features business-only, com 4 testes novos. Nenhuma feature foi removida das contas Business._
- ✅ `prot-score` — Separação correta Protection Score ≠ PcState
- ✅ `prot-eicar` — Testes de integridade com EICAR / regras YARA
- ✅ `prot-quarantine` — Quarentena: mover, restaurar, apagar e metadados/manifest
- ✅ `prot-defs` — Updater/scheduler de definições
- 🟡 `prot-clam-config` — Fechar configuração/distribuição do ClamAV para funcionar sem setup manual frágil — _ClamAV está instalado, mas sem base de assinaturas funcional. O produto reporta corretamente estado degradado; falta configurar/distribuir as definições._
- ✅ `prot-hash-update` — Robustecer atualização da base de hashes / tratamento de falhas do feed — _A base offline de referência nunca desaparece com feed parcial ou inválido; provado por testes. O applyRemoteRecords() continua por ligar — o feed remoto ainda não aplica registos._
- ✅ `prot-history` — Histórico consolidado de deteções, ações e quarentena — _Fechado com validação manual: o histórico devolve de imediato as deteções do scan real, sem divergência entre o Scanner e a página Ameaças._
- ✅ `prot-detection-quality` — Qualidade das deteções: limpeza dos fixtures/probes de desenvolvimento — _Causa corrigida: dedup de YARA, assinatura ausente = 0 pontos, heuristica generica isolada limitada; bun.exe real 100/critical -> 35/low/safe e EICAR mantem critical/quarantine. Suites: service 143/143, core 233/233, app 283/283._
- ⚪ `prot-native-hash-trust` — Native engine hash divergence (confiança no hashDB) — _Motor nativo devolveu SHA-256 7f489a66... para o bun.exe cujo hash real é 15277c59... (confirmado por Node e Get-FileHash). Provar a causa antes de confiar em decisões hashDB neste caminho. OPEN / PRÓXIMA SESSÃO._
- ✅ `prot-engine-context` — Dashboard/Protection Details: contexto dos motores em linguagem humana — _WS-B validado por humano: Dashboard mostra ClamAV/WFP em PT-PT sem degraded/unavailable crus nem paths na copy principal; Protection Details mostra YARA Ativo (1 regra carregada, cobertura limitada), Hash DB Ativo (4 assinaturas, cobertura limitada), ClamAV com explicação humana da base ausente, Native Engine em texto humano com path só nos detalhes técnicos, Windows Firewall separado de WFP; score "3 estão ativos" com cobertura real. Detalhes técnicos crus só com a área técnica expandida (aceitável). Audit: output/sprint-audit-cde/RESULT.md._

## Proteção em Tempo Real & Windows
_Monitorização contínua de ficheiros, processos, serviços e defesas do Windows._

- ✅ `rt-watcher` — Watcher de Downloads/Desktop/Documents/Temp/Startup
- ✅ `rt-process` — ETW de processos / infraestrutura de eventos nativos
- ✅ `rt-amsi` — AMSI em modo user-space/simulação claramente identificado
- ✅ `rt-firewall` — Leitura/health do Firewall do Windows
- ✅ `rt-health` — Windows Health: serviços, firewall, processos, rede, discos, utilizadores e registo
- 🟡 `rt-epperm` — Tratar junctions/reparse points e reduzir spam EPERM dos watchers
- ⚪ `rt-defender` — Estado do antivírus/Windows Security via SecurityCenter/Defender quando aplicável
- ⚪ `rt-events` — Auditoria de eventos críticos do Windows (energia, disco, sistema), _PÓS-PAP / BACKLOG._
- 🟡 `rt-filearrival` — Detetar novos ficheiros fora do browser com monitorização nativa e analisar quando relevante
- ⚪ `rt-motw` — Usar Mark of the Web (Zone.Identifier) quando disponível como contexto de risco, _PÓS-PAP / BACKLOG._
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
- ⚪ `health-smart` — S.M.A.R.T. de SSD/HDD (vida útil, health/warnings), _PÓS-PAP / BACKLOG._
- 🟡 `health-stress` — Rever Stress Index para representar pressão instantânea real e explicar “Como é calculado?”
- ✅ `health-diskfinding` — Pouco espaço em disco como finding de saúde, separado de stress instantâneo
- ⚪ `health-thermal-actions` — Alertas térmicos + ação segura/opt-in em vez de desligamento automático por defeito, _PÓS-PAP / BACKLOG._
- ✅ `health-taskmanager` — Task Manager (PC Center): lista de processos e terminação de processos — _Gestor de Tarefas validado manualmente: lista, terminação e tombstone funcionam. Refinamentos internos restantes não bloqueiam a PAP._

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
- ⚪ `mx-business` — Matrix Business para explicar eventos de rede e anomalias de egress, _PÓS-PAP / BACKLOG._

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
- ✅ `ux-typography-stable` — Tipografia estável: Light/Dark mudam só cor, nunca font-family — _Light/Dark passou a mudar só cor; a família tipográfica deixou de variar entre modos. Regressão coberta por teste novo e validada manualmente._
- 🟡 `ux-tray-dpi` — Ícone da bandeja dimensionado ao DPI real do Windows — _Taskbar PASS. Variante B entregue: 8 tray-symbol-{active,warning}-{16,20,24,32}.png (símbolo transparente, sem placa) com escolha por slot no main.ts e fallback seguro. Validação humana: 100% PASS, 125% e 150% pendentes._
- 🟡 `ux-liquid` — Tema CyberSafe Liquid experimental, _PÓS-PAP / BACKLOG._
- ⚪ `ux-protection-copy-polish` — Polish de copy em Protection Details, _PÓS-PAP / BACKLOG._ — _"Cobertura atual: YARA: ..." pode ser melhorado estilisticamente; a frase "A nota é o contrário do risco" pode ser simplificada. Registado pelo utilizador na validação WS-B; não reabrir WS-B por polish._
- ✅ `ux-semantic` — Cores semânticas independentes do tema
- 🟡 `ux-dashboard-polish` — Painel: pergunta central, hierarquia de estado e menos ruido visual — _Painel reorganizado para responder a uma só pergunta, com hierarquia de estado e menos ruído; corrigido o cartão Quarentena que mostrava recomendações. Falta validação visual em 3 larguras e um campo real de contagem de quarentena no backend._
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
- ⚪ `dist-installer` — Gerar instalador final CyberSafe-Setup.exe — _Build de diretório validado em runtime (win-unpacked): logs privados fora do pacote (asar 276 MB → 6,87 MB), scan-engine.exe empacotado e nativeEngine=active provado. NSIS final congelado até gates A (tray 125/150) e B (scan full smoke) fecharem._
- ⚪ `dist-helper` — Bundlar temperature helper/dependências necessárias no instalador
- ⚪ `dist-clam` — Bundlar/configurar motores externos necessários sem downloads silenciosos em runtime
- ⚪ `dist-cleanvm` — Teste de instalação e primeiro arranque em Windows/VM limpa
- 🟡 `dist-upgrade` — Estratégia de atualização do aplicativo e definições
- ⚪ `dist-sign` — Assinatura de código/installer para distribuição real, _PÓS-PAP / BACKLOG._
- ✅ `rel-selfdetect-canary` — Release self-detection: dev canário dentro do bundle — _O CyberSafe empacotado detetava-se a si próprio; o literal do canário saiu do src de produção e foi medido com zero ocorrências no app.asar novo._

## Relatórios & Evidências
_Relatórios A4, dados técnicos explicados e evidências úteis para utilizador e PAP._

- ✅ `rep-a4` — Relatório A4 com cabeçalho, ameaças, quarentena, motores, hardware e findings
- 🟡 `rep-score` — Garantir que relatório consome PcState/ProtectionHealth corretos em vez de score próprio antigo — _O relatório consome PcState e ProtectionHealth em vez de score próprio; falta validar o PDF A4 impresso._
- ✅ `rep-export` — Impressão/PDF do relatório
- ✅ `rep-e2e-canary` — Teste E2E do pipeline de deteção sem EICAR real (canário dev-only) — _Teste E2E do pipeline de deteção sem EICAR real, com canário só de teste e caso inverso em produção._
- ⚪ `rep-business` — Relatório Business de eventos/risco de rede, _PÓS-PAP / BACKLOG._
- ⚪ `rep-privacy` — Relatório/explicação “o que o CyberSafe monitoriza” para transparência Business, _PÓS-PAP / BACKLOG._

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
- 🟡 `pap-testing` — Teste estruturado com utilizadores reais: tarefas propostas, tempo, dificuldades, feedback e melhorias — _Teste estruturado com utilizadores reais antes da PAP: tarefas propostas, tempo, dificuldades, feedback e melhorias. Ainda não correu, porque depende de pessoas e de agenda._
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
