# CyberSafe Assistant — Relatório Mestre de Estado e Continuidade

**Data da auditoria:** 2026-11-01  
**Worktree:** `C:\Users\caioc\.cybersafe-integration\freebuff-r7-continuacao-20261101\repo`  
**Branch:** `freebuff/r7-final-integration-20261101`  
**HEAD:** `4073a7a11c4123fca45eed8cdd9f0bf3c6d80a2d`  
**Upstream da branch:** `origin/freebuff/r7-final-integration-20261101` @ `eff47f5` (4 commits locais não publicados)  
**`origin/main`:** `21fefa69352516c188f99c665966d4443588aa2b` — contida no HEAD; o HEAD tem 34 commits que não estão em `origin/main`  
**Estado global:** **BLOCKED_WITH_EVIDENCE**

**Atualização de execução:** 2026-11-01, HEAD `cb73d68`; ver o Apêndice de Execução no fim. As Partes I–X continuam a ser o retrato da auditoria feita em `4073a7a`.

> **Natureza deste documento.** É uma auditoria de estado. Não foi feito merge, source freeze, build de release, tag, publicação, instalação ou alteração funcional. Foram executados apenas testes leves e verificações de leitura. As alterações do instalador que já estavam no worktree foram preservadas e são aqui identificadas como não commitadas.

---

## PARTE I — RESUMO EXECUTIVO

### O que já temos

- Uma base funcional R7 substancial: serviço, Electron, Scanner, ClamAV, YARA, Native Engine, quarentena, exclusões, tempo real, histórico, MATRIX, atualizador, gestor de tarefas, packaging e documentação PAP.
- O contrato de inconclusivos foi estruturado: nove causas fechadas, cinco motores atribuíveis, persistência no histórico e apresentação na UI. Isto torna a lacuna explicável; **não** prova que a taxa de inconclusivos baixou.
- O ClamAV 1.5.4 está no payload R7 com 45 ficheiros, 139 195 536 bytes e licenças; o YARA 4.6.0 está no payload com quatro recursos e `vcruntime140.dll` app-local.
- O setup R7 existe e é internamente instalável, mas foi construído com o NSIS stock: o `builder-debug.yml` do candidato não contém o `cybersafe-installer.nsh`.
- A direção visual do instalador está **rejeitada pelo proprietário**: usa um monograma inventado, estética espacial e labels que não pintam corretamente. O protótipo novo não é candidato.
- A branch funcional está à frente de `origin/main`; não há tags, Releases, PR aberto nem workflow de release executado. A CI verde é da `main`, não desta branch.

### O que falta

- Um freeze de fontes válido para o HEAD exato e um registo de aprovadores disponível.
- Um seed ClamAV offline fornecido e verificado no pipeline corrente.
- A correção visual do setup com a marca oficial, composição própria CyberSafe e labels legíveis.
- Testes reais numa VM autorizada: instalação, login, Scanner, motores, quarentena, PDF, encerramento, GPU/3D e rollback.
- Prova de desempenho do Scanner (a meta de cinco minutos continua sem medição atual).
- Prova de terminação individual de um processo real, quarentena automática ponta-a-ponta, MATRIX com fornecedor real e atualizador online.
- Aprovação visual do Orbital Glass V3 e integração dos componentes existentes, não um frontend novo.
- Actualização da `main`, tag, Release e feed assinado — todas operações separadas e ainda não autorizadas.

### Veredito

O CyberSafe está **tecnicamente avançado, mas não está pronto para uma versão estável**. O produto tem código e testes relevantes, mas a cadeia de confiança do artefacto, a validação instalada e o design do setup ainda não estão fechados. A prioridade não é escrever mais funcionalidades: é provar os percursos existentes, corrigir a identidade do setup e fechar os gates de freeze, VM e publicação.

---

## PARTE II — HISTÓRICO CONSOLIDADO

### Base e continuidade

- A branch funcional parte do trabalho R7/R8 já integrado em `origin/main` e acrescenta 34 commits.
- O trabalho não começou num repositório vazio nem numa `main` alternativa: a `main` remota é ancestral do HEAD.
- A `main` **local** (`9b7e823`) está desatualizada face a `origin/main` (`21fefa6`) e não deve ser usada como base de decisão.
- A branch remota está em `eff47f5`. Os quatro commits locais mais recentes são:
  - `8017556` — contrato estruturado da causa dos inconclusivos;
  - `f4d2916` — motores agregados, histórico e UI;
  - `8396138` — alinhamento do teste `readonly-mode`;
  - `4073a7a` — checkpoints dos gates finais.
- A branch `freebuff/orbital-glass-v3-lab-20261101` (`e75d0da`) contém um laboratório visual isolado e **não está integrada** no HEAD.
- O worktree tem sete worktrees registados. Não foram apagados nem substituídos. Existe um `stash` antigo (`WIP on main`) que não foi tocado.
- O PR #1 (`sync/pap-2026-10-31`) está merged. Não há PR aberto. Não há tags. Não há Releases GitHub.

### Evidência documental preservada

- `docs/checkpoints/20261101-gates-finais.md`
- `docs/checkpoints/20261101-inconclusivos-estruturados.md`
- `docs/PAP-TRANSFERENCIA-20261031.md` (histórico; não é estado atual)
- `docs/CYBERSAFE-FINAL-READINESS.md` (histórico de outra candidata; não usar como prova do HEAD)
- `PAP-EVIDENCIAS-TECNICAS/` (oito documentos de evidência)
- `docs/relatorio PAP/` (DOCX/PDF da PAP)

Os números de testes antigos não foram somados aos testes executados nesta auditoria.

---

## PARTE III — INVENTÁRIO FUNCIONAL

Legenda:

- **CONCLUÍDO E VALIDADO** — implementado e comprovado no ambiente exigido.
- **IMPLEMENTADO / PENDENTE DE VALIDAÇÃO** — código e testes existem, falta runtime instalado/VM.
- **PARCIAL** — percurso incompleto.
- **COM DEFEITO** — problema reproduzido ou evidência de falha.
- **BLOQUEADO** — falta uma dependência externa comprovada.
- **NÃO IMPLEMENTADO** — não existe.
- **NÃO VERIFICADO** — não há evidência suficiente.

### 3.1 Scanner

**Estado:** IMPLEMENTADO / PENDENTE DE VALIDAÇÃO (desempenho e runtime instalado).  
**Código principal:** `packages/service/src/engine.ts`, `scan-manager.ts`, `scan-history.ts`, `packages/core/src/analysis.ts`, `archive-limits.ts`, `packages/app/src/pages/FileScannerPage.tsx`, `packages/app/src/v2/scanner/`.

**Implementado:** análise rápida, completa e personalizada; ficheiro/pasta; USB; ZIP e limites de arquivo; cancelamento; contadores; cobertura; exclusões; histórico; relatórios; vários motores.

**Testado nesta auditoria:** 62/62 testes dirigidos de Scanner/ScanManager/ScanPipeline/EngineHealth passaram, incluindo `inconclusive-classification`, após `npm run build -w @cybersafe/service` (PASS). 104/104 testes de UI dirigidos incluem razões de falha e factos por ficheiro.

**O que não está provado:** o cenário de 800 ficheiros e 830 segundos é histórico. Não foi executada uma medição equivalente neste HEAD. A meta de cinco minutos não está demonstrada. Não há instrumentação atual por etapa que permita atribuir os 830 s a ClamAV, YARA, Native, ZIP, I/O ou filas.

**Próxima ação:** correr `scripts/scanner-benchmark.mjs`/probe num ambiente controlado e instrumentar as fases. Não declarar speedup sem medição.

### 3.2 Inconclusivos

**Estado:** IMPLEMENTADO — melhoria de classificação; não é eliminação dos inconclusivos.

- `InconclusiveReason` tem nove causas: `timeout`, `engine-unavailable`, `engine-failed`, `invalid-output`, `file-changed`, `archive-incomplete`, `coverage-incomplete`, `cancelled`, `no-verdict`.
- `InconclusiveEngines` distingue `native`, `clamav`, `yara`, `archive`, `filesystem`.
- O motor atribui o código; o ScanManager agrega e o histórico valida; a UI mostra motivo e motor.
- O classificador textual continua apenas como compatibilidade para respostas antigas.
- A limitação de 100 MiB e falhas como timeout/output do motor nativo continuam a produzir lacunas reais. Classificar melhor não reduz a lacuna.

**Evidência:** testes 62/62 atuais; checkpoints de 20261101. **Não foi medido** o novo cenário de 800 ficheiros.

### 3.3 ClamAV

**Estado:** IMPLEMENTADO / PENDENTE DE VALIDAÇÃO INSTALADA.

- Bundle R7: ClamAV 1.5.4, 45 ficheiros, 139 195 536 bytes, 13 licenças, fonte correspondente incluída.
- O `--check` atual mediu `bundle.ok=true`, `version=1.5.4`, `problems=[]`.
- A correção de oscilação ACTIVE/DEGRADED/kill está no histórico (`887e2b5`) e tem testes de reprobe, batch, config e gate.
- O payload R7 contém `resources/clamav-seed` com manifesto; o `--check` corrente **sem seed explicitamente fornecido** devolve `seed.ok=false`, `not-provided`, `CLAMAV_SEED_REQUIRED`.
- Não foi executada uma análise ClamAV real nesta auditoria; não foi validada a instalação R7.

**Risco:** confundir “bundle presente” com “motor operacional na instalação”. A próxima prova tem de ser num payload instalado e com seed verificada.

### 3.4 YARA

**Estado:** IMPLEMENTADO / PENDENTE DE VALIDAÇÃO INSTALADA.

- YARA 4.6.0, quatro recursos, 4 919 333 bytes, `yara64.exe`, `yarac64.exe`, `COPYING.txt`, `vcruntime140.dll` app-local.
- O `--check` atual devolve `yara.ok=true`.
- Testes de regras, vendor, download e rollback existem.
- Não houve execução de regras contra um corpus real nesta auditoria.

### 3.5 HashDB / assinaturas locais

**Estado:** IMPLEMENTADO / PENDENTE DE VALIDAÇÃO.

- A base local está em `packages/core/src/signatures.ts`; inclui EICAR e hashes WannaCry com proveniência documentada, e uma lista explícita de hashes retirados.
- Existem testes de migração, refresh, records válidos, cobertura e integração de motor (`hash-db-migration`, `hash-db-refresh`, `qa3-hashdb-valid-records`, `rc22-motores-hashdb`, `tp-hashdb-coverage`, `session14-engine-hashdb`).
- Não foi encontrada uma implementação independente chamada “HashDB” fora desta base de assinaturas.
- **Não validado:** atualização online, credenciais, feed de produção e integridade fim-a-fim. Não dizer “quatro motores online operacionais” sem essa prova.

### 3.6 Native Engine

**Estado:** IMPLEMENTADO / PARCIALMENTE VALIDADO.

- C++ em `packages/native-engine/`; `scan-engine.exe` presente no R7 `win-unpacked/resources`.
- `npm run test:native`: **25/25 PASS, 0 FAIL, 0 SKIP** nesta auditoria (vetores SHA-256).
- O teste de vetores prova hash, não prova análise PE/entropia/cancelamento no runtime instalado.
- Build e integração de packaging têm evidência histórica; não foi executado um scan real no payload.

### 3.7 Proteção em tempo real

**Estado:** IMPLEMENTADO / PENDENTE DE VALIDAÇÃO INSTALADA.

- `process-monitor`, `realtime-file-queue`, `realtime-loss`, `realtime-recovery`, `protection-intent` e adaptadores USB.
- Correções históricas de saturação/backoff e prioridade de downloads.
- Testes existentes: `realtime-*`, `watcher-*`, `protection-*`.
- Não foi executada a instalação real nem um teste de deteção após download.
- Limitação de arquitetura: o produto observa e reage; não é um bloqueio preventivo de execução antes do arranque. Não declarar capacidade que não existe.

### 3.8 Quarentena

**Estado:** IMPLEMENTADO / PENDENTE DE VALIDAÇÃO PONTA-A-PONTA.

- `QuarantineManager`, política `warn`/`ask`/`automatic-high-confidence`, consentimento, hashes, caminhos protegidos, junctions/symlinks, lote, restauro/eliminação e histórico.
- O `quarantinePolicy` é carregado de `protection-policy.json`; a política automática exige evidência forte.
- Existem testes de segurança, restauro, política e UI; o conjunto UI dirigido passou 104/104.
- **Não provado:** deteção real → isolamento automático → confirmação → restauro/eliminação numa instalação Windows desta candidata.
- **Limitação conhecida:** o motor que detetou pode não ser persistido em todos os registos; ver `PAP-TRANSFERENCIA-20261031.md`.

### 3.9 Exclusões

**Estado:** IMPLEMENTADO / PENDENTE DE VALIDAÇÃO.

- CRUD, persistência, validação e aplicação no Scanner.
- Testes de razões de exclusão e UI.
- Não foi demonstrada aplicação no tempo real com todas as combinações nem uma migração de dados antiga.

### 3.10 Gestor de Tarefas e terminação individual

**Estado:** IMPLEMENTADO / PENDENTE DE PROVA COM PROCESSO REAL.  
**Risco:** não confundir testes com handle falso com uma terminação real de Notepad.

- O caminho protegido existe de ponta a ponta no código:
  - `packages/app/src/lib/individualProcessTermination.ts` (prepare/confirm/cancel);
  - `packages/app/src/pages/TaskManagerPage.tsx`;
  - `packages/desktop/src/preload.ts` (métodos expostos);
  - `packages/desktop/src/process-termination-ipc.ts` (canais);
  - `packages/service/src/engine.ts` (`process.termination.prepare/confirm`);
  - `packages/core/src/safe-process-termination.ts`.
- O serviço exige ticket, PID, CreationDate, identidade confirmada, confirmação explícita e proof `handle-signaled`; recusa sessão não autenticada, startup, scan, atualização, tempo real, modo read-only, processos internos e identidade não confirmada.
- `KILL_TERMINATION_DISABLED = true` mantém o caminho legado `killProcess` fechado e auditado; nenhum `taskkill` é executado. Isto é intencional e não deve ser revertido.
- Testes históricos: percurso individual 6/6; UI Gestor de Tarefas 83/83. Nesta auditoria, o subconjunto UI 104/104 incluiu `task-kill-flow`.
- O teste de serviço usa um handle nativo falso; **não** prova um processo real. O sintoma antigo do Notepad não foi revalidado.
- Os testes legados de `process-kill` continuam a ter 31 falhas por desenho, porque o caminho antigo está desativado. Não foram tornados verdes com SKIP nem reativando o caminho.

**Próxima ação:** numa VM, com conta autenticada e sem scan a correr, preparar e confirmar um processo benigno elegível, provar que o PID/CreationDate correspondem, que o processo termina e que o audit log não contém caminho nem token.

### 3.11 MATRIX

**Estado:** PARCIAL / NÃO VALIDADO COM FORNECEDOR REAL.

- O prompt de sistema é montado no servidor (`packages/api/src/ai.ts`); contexto de processo validado em `process-intelligence.ts` com `selectedProcess`, `topProcesses`, `trends`, PID + `startedAt` e limites de cinco entradas.
- O prompt diz para usar valores exatos, comparar a mesma instância e não inventar tendências.
- Existem testes de auth, guard, origem, boundaries e UI MATRIX.
- **Não foi executada** uma resposta real de fornecedor online nesta auditoria. A melhoria do prompt não está validada por resposta real; os testes provam o texto/estrutura, não a qualidade da resposta.
- Sem credenciais/fornecedor, a MATRIX deve permanecer local/declarada; não afirmar offline se não existir modelo local.

### 3.12 Atualizador

**Estado:** BLOQUEADO / NÃO OPERACIONAL PARA PUBLICAÇÃO.

- `packages/desktop/src/updater/` tem transporte, manifesto, semver, cache, crypto, GitHub e máquina de estados.
- `release-trust.json` está `enabled: false`, `publicKeyPem: ""`, `pinnedKeyFingerprint: ""`; a razão declarada é “Publication public key not provisioned”.
- Existem testes de updater core, segurança, adapters, GitHub, cache, state machine e trust.
- Não há Release GitHub, feed assinado, chave Ed25519 de produção nem Authenticode.
- O atualizador não está ativo. **Não** dizer que está “bloqueado apenas pela chave”: há também release, feed, manifesto, certificado e validação do payload.
- A atualização de ClamAV/YARA/HashDB é um caminho separado das definições; não confundir download de definições com atualização da aplicação.

### 3.13 Frontend, Orbital Glass e Configurações

**Estado:** ORBITAL GLASS — LABORATÓRIO NÃO INTEGRADO; CONFIGURAÇÕES — AINDA NÃO REORGANIZADAS.

- O núcleo 3D existe em `packages/app/src/v2/dashboard/effects/CoreScene.tsx`; `Effects.tsx` usa `BrandScene`/`OrbitingCore` e liga estados dos motores. Há fallback e `gpu`/`animate` em `AppearanceContext`.
- A branch `freebuff/orbital-glass-v3-lab-20261101` tem o protótipo, mas **não é ancestral do HEAD**.
- `labs/orbital-glass-v3/dist/index.html` é apenas um artefacto de laboratório de 489 bytes; não é a aplicação integrada.
- Não há aprovação visual, captura comparativa aprovada ou prova de FPS/GPU do novo núcleo.
- `SettingsPage.tsx` continua uma página longa com secções (Aparência, Quarentena automática, arranque, notificações, MATRIX, Sobre); não há evidência de reorganização por categorias como missão concluída.
- A UI V2 existe e é usada pelo Dashboard, mas não é equivalente ao “Orbital Glass V3 aprovado”.

### 3.14 Instalador NSIS

**Estado:** COM DEFEITO / PROTÓTIPO REJEITADO; CANDIDATO R7 AINDA COM NSIS STOCK.

- Pipeline existente: electron-builder 25.1.8 + NSIS assisted, com páginas customizáveis no `cybersafe-installer.nsh`.
- O candidato R7 `candidate-20261101-201659-9e22feb1` tem 278 623 050 bytes e SHA-256 `e558f35bd25c559b13fef994262398cb86be1d745de6cec2ad3b3d5027340164`.
- O `builder-debug.yml` desse candidato **não inclui** `cybersafe-installer.nsh`; por isso o setup R7 usa o NSIS stock.
- O worktree tem uma alteração não commitada que adiciona `nsis.include` em `packages/desktop/package.json`, e um teste estático de 11/11. Isso prova o contrato do manifesto, não o design final.
- Foi compilado um protótipo de UI em `tmp-installer-preview/ui-build/CyberSafe-UI-preview-setup.exe` (hash `e49a61d1380d012946b9eb66f4051580b6552f1e723042ec36fd2bd5861fdc41`), apenas para inspeção. Não é candidato, não está assinado e não deve ser distribuído.
- Esse protótipo mostrou:
  - fundo orbital escuro e botões reais visíveis após correção de z-order;
  - labels de texto invisíveis nas capturas (`WM_CTLCOLORSTATIC` devolveu preto/branco; o `SetCtlColors` não se aplicou como esperado);
  - arte com monograma “CS” inventado e estética espacial;
  - versão `0.1.1` no protótipo, porque foi usado o `package.json` raiz no config de teste; a versão canónica é `0.1.11-internal.pap-r7.20261031`.
- O proprietário rejeitou a direção visual. A correção de marca/composição **não foi implementada** nesta auditoria.
- O setup preserva instalação, reparação, desinstalação, dados (`deleteAppDataOnUninstall=false`), atalhos e progresso real do Nsis7z; a UI custom ainda não está validada.
- O progresso não deve ser animado com temporizador. A animação WebGL não é adequada ao instalador NSIS; a alternativa segura é arte estática, com progresso nativo real.
- A licença de terceiros foi incluída no protótipo via `THIRD-PARTY-NOTICES.txt`; o caminho `PROJECT_DIR` foi necessário porque o NSIS não normalizou `..` com barras mistas.

### 3.15 Segurança, dados e persistência

**Estado:** IMPLEMENTADO; NÃO REVALIDADO NESTA AUDITORIA.

- Evidência documental: SQLite real em `%USERPROFILE%\.cybersafe-service\cybersafe.db`, sete tabelas, sem chaves estrangeiras físicas; `schema.prisma` não é runtime.
- Autenticação: bcrypt custo 12, JWT HS256 de 7 dias, revogação persistida; pipe desktop↔serviço com HMAC e nonce.
- Históricos, quarentena e políticas persistem em JSON/JSONL; contas/consentimentos em SQLite.
- Testes de auth/persistência existem; não foram reexecutados nesta auditoria.
- Defeitos/lacunas conhecidos: `training_results.userId` nulo, leitura global; quarentena pode não guardar o motor; `schema.prisma` morto; a suite integral não está verde.

---

## PARTE IV — PROBLEMAS CONHECIDOS

### P0 — Integridade e gates de release

1. **Freeze inválido.** `scripts/source-freeze.approved.json` existe (1 802 entradas, 10 roots, digest `9eb69e...`), mas aprova o candidato `cybersafe-r7@0.1.11-internal.pap-r7.20261031+9802d04`, 16 commits antes do HEAD `4073a7a`. `CYBERSAFE_APPROVERS_FILE` não está definida; `source-freeze --verify` termina com `approver-registry-missing`. Não é um freeze do HEAD.
2. **Seed ClamAV não fornecida ao `--check`.** O candidato R7 contém um `resources/clamav-seed`, mas o pipeline corrente sem seed explícita devolve `CLAMAV_SEED_REQUIRED`; não é possível tratar o gate como passado.
3. **Instalador rejeitado e labels invisíveis.** O setup visual atual não tem a marca oficial; o protótipo não prova o NSIS final. Não pode entrar na candidata.
4. **Teste de manifesto em conflito com a nova direção.** `scripts/test/7h-packaging-manifest.test.mjs` ainda exige `nsis.include === undefined`; a alteração local introduz o include. O teste deve ser atualizado de forma deliberada quando o setup custom for a direção aprovada, não apagado às escondidas.
5. **Nenhuma candidata validada em VM.** O R7 é um artefacto interno; não há prova instalada de Scanner, motores, conta, PDF, encerramento, GPU ou rollback.

### P1 — Funcionalidades essenciais

- Scanner sem benchmark atual; meta de 5 min não demonstrada.
- Terminação individual sem prova com processo real.
- Quarentena automática sem prova ponta-a-ponta instalada.
- MATRIX sem resposta real de fornecedor.
- Atualizador sem feed/chave/release.
- Núcleo Orbital não integrado/aprovado.

### P2 — Estabilidade e testes

- `npm run test:scripts`: **425 testes, 416 PASS, 3 FAIL, 5 SKIP, 1 TODO**. Falhas: teste de `--check` sem manifesto aprovado; teste de manifesto stock NSIS; dois asserts da affordance de histórico da Dashboard (um classificado como decisão do proprietário).
- 31 falhas legadas de `process-kill` continuam; o caminho está desativado por desenho. A suite completa não está verde.
- A suite completa de app (245 ficheiros), service (157), desktop (60) e native-windows (28) não foi executada nesta auditoria; os resultados anteriores não foram somados.

### P3 — Frontend

- Orbital Glass V3 apenas em laboratório.
- Configurações não reorganizadas.
- Falta de capturas aprovadas e de medição de desempenho 3D.

### P4 — Instalador

- Identidade visual, composição, labels e versão do protótipo.
- Header/rodapé MUI brancos e página custom de 450×228; documentar a limitação em vez de fingir full-bleed.
- Teste de packaging stock desatualizado face à nova direção.

---

## PARTE V — TESTES E DESEMPENHO

### 5.1 Executados nesta auditoria

Data: 2026-11-01, HEAD `4073a7a` com alterações locais do instalador não commitadas.

| Comando | Âmbito | Resultado | Duração | Evidência |
|---|---|---|---|---|
| `npm run test:scripts` | scripts, packaging, segurança, dashboard | **425 testes: 416 PASS / 3 FAIL / 5 SKIP / 1 TODO** | 14,3 s | `tmp-installer-preview/audit-test-scripts.log` |
| app tests dirigidos | UI dirigida | **104 PASS / 0 FAIL / 0 SKIP** | 2,7 s | `tmp-installer-preview/audit-test-app.log` |
| service build + 5 testes de Scanner | Scanner/inconclusivos | **build PASS; 62 PASS / 0 FAIL / 0 SKIP** | 42,7 s | `tmp-installer-preview/audit-test-service.log` |
| `npm run test:native` | hash nativo | **25 PASS / 0 FAIL / 0 SKIP** | 0,6 s | `tmp-installer-preview/audit-test-native.log` |
| `node --test scripts/installer-theme.test.mjs` | tema/NSIS estático | **11 PASS / 0 FAIL** | 65 ms | `tmp-installer-preview/audit-test-installer.log` |
| `node scripts/package-windows.mjs --check --candidate --json` | pipeline, sem build | **exit 1**; licensing/YARA/bundle PASS; freeze/seed FAIL | — | `tmp-installer-preview/audit-package-check.json` |
| `node scripts/source-freeze.mjs --verify --json` | freeze | **exit 1**, `approver-registry-missing` | — | `tmp-installer-preview/audit-freeze-verify.json` |

**Nota:** as falhas de `test:scripts` incluem um teste que exige NSIS stock. A alteração local do instalador é a causa direta dessa falha; é uma decisão de contrato que exige atualização do teste, não um verde artificial.

### 5.2 Histórico (não reexecutado)

- Transferência PAP de 2026-10-31: 315 PASS / 1 FAIL / 0 SKIP num conjunto dirigido de 316 testes; o teste com falha era uma expectativa desatualizada de assinaturas.
- Checkpoint R7: Native + ScanManager 53/53; UI Gestor de Tarefas 83/83; percurso individual 6/6.
- Checkpoint final: `process-kill` com 31 falhas no caminho legado; não reconciliadas.
- Documentos de release: YARA/adapter, licenças, ClamAV 1.5.4, build e infraestrutura de assinatura com evidência; **não** são prova da candidata R7 final.

### 5.3 Desempenho

- Medição histórica R7: 800 considerados, 795 analisados, 772 conclusivos, 23 inconclusivos, 5 excluídos, **830 s**.
- Não existe nova medição comparável neste HEAD.
- Não há instrumentação atual por etapa (ClamAV/YARA/HashDB/Native/ZIP/I/O/filas) que explique os 830 s.
- Não há medição atual de CPU/RAM/GPU, arranque/encerramento, FPS ou custo do 3D. Não inventar percentagens.
- A meta de cinco minutos permanece **não demonstrada**.

### 5.4 O que falta testar

- VM limpa: instalação, upgrade/reparação, desinstalação, dados preservados, login, Scanner, motores, quarentena, PDF, encerramento, tray, atualizador, GPU/3D.
- Processo real: Notepad ou processo benigno elegível no Gestor de Tarefas.
- Matriz com fornecedor real e consentimento/revogação.
- Update feed assinado e rollback.
- Escalas 100/125/150% e textos longos no setup.

---

## PARTE VI — GIT, MAIN E RELEASE

### Estado atual

- HEAD `4073a7a`; branch `freebuff/r7-final-integration-20261101`.
- `origin/freebuff/r7-final-integration-20261101` = `eff47f5`; branch 4 commits à frente.
- `origin/main` = `21fefa6`, **ancestral do HEAD**; HEAD tem 34 commits além de `origin/main`.
- `main` local = `9b7e823`, desatualizada; não usar como base.
- Alterações não commitadas: 8 ficheiros do instalador + `scripts/installer-theme.test.mjs` + `tmp-installer-preview/`.
- Stash: `stash@{0}` antigo em `main`; preservado.
- Tags: **nenhuma**.
- Releases GitHub: **nenhuma**.
- PRs: #1 `sync/pap-2026-10-31` MERGED; nenhum PR aberto.
- Actions: as execuções mais recentes da `main` estão PASS; o CI **não** builda native/NSIS/payload completo e não corre nesta branch.
- Worktrees: 7; não foram removidos.

### O que falta para a `main`

1. Fechar o design do setup e os testes de contrato.
2. Corrigir os 3 FAIL atuais ou justificar cada um com decisão do proprietário, sem apagar cobertura.
3. Fechar a validação instalada/VM.
4. Aprovar o freeze exato e o payload.
5. Só depois atualizar `main` (fast-forward/merge controlado) e publicar a branch.

### O que falta para a Release

- Freeze do commit exato.
- Seed ClamAV offline validada.
- Versão única e coerente (`product-version.json`), setup com NSIS correto.
- Build único, SHA-256, manifesto, proveniência, `NOT_FOR_DISTRIBUTION` enquanto interno.
- Ed25519 de produção, fingerprint aprovado, feed assinado.
- Authenticode se houver distribuição pública.
- VM e rollback.
- Autorização separada para tag/Release.

### Versões

- Canónica: `product-version.json` = `0.1.11-internal.pap-r7.20261031`.
- Root e vários workspaces: `0.1.1`; `desktop`/`app`: `0.1.2`.
- R7 setup: `0.1.11`.
- Protótipo UI: `0.1.1` por configuração de teste; não é versão de produto.
- `0.2.0` é uma proposta; **não** está aplicada no código.

---

## PARTE VII — ARTEFACTOS

| Artefacto | Caminho | Tamanho | SHA-256 | Estado |
|---|---|---|---:|---|
| Setup R7 interno | `packages/desktop/release/candidate-20261101-201659-9e22feb1/CyberSafe Assistant-0.1.11-internal.pap-r7.20261031-candidate-20261101-201659-9e22feb1-setup.exe` | 278 623 050 B | `e558f35bd25c559b13fef994262398cb86be1d745de6cec2ad3b3d5027340164` | Candidato interno; NSIS stock; não assinado; não publicado |
| Protótipo UI | `tmp-installer-preview/ui-build/CyberSafe-UI-preview-setup.exe` | ≈266 MiB | `e49a61d1380d012946b9eb66f4051580b6552f1e723042ec36fd2bd5861fdc41` | Protótipo; versão 0.1.1; labels invisíveis; rejeitado |
| Freeze manifest | `scripts/source-freeze.approved.json` | 334 801 B | digest `9eb69e8890d3952e63f6c9067964b38efefc1e7e02c4f05bcc5a17a24ba9b323` | 1 802 entradas; aprova `+9802d04`; não é o HEAD |
| Relatório PAP LIVE DOCX | `docs/relatorio PAP/Relatorio_PAP_CyberSafe_LIVE.docx` | — | `1bc89cebf227e45383961737623c28062ac4ee65252a00204c24918c39156700` | Documento existente |
| Relatório PAP LIVE PDF | `docs/relatorio PAP/Relatorio_PAP_CyberSafe_LIVE_PREVIEW.pdf` | — | `a7ab6c8515ecc69705d82b16c251cf89fc3bc59835cc7fd016e47eb73dae5247` | Pré-visualização existente |
| R7 `win-unpacked` | `packages/desktop/release/candidate-20261101-201659-9e22feb1/win-unpacked` | — | — | Payload para inspeção; não instalar sem autorização |

Também existem logs em `.r7-evidence/` (ClamAV, freeze, packaging, updater, isolamento, YARA) e capturas do instalador em `tmp-installer-preview/`. Nenhum destes artefactos é uma Release.

---

## PARTE VIII — ROADMAP PRIORITÁRIO

### P0 — Segurança, integridade e gates

| ID | Tarefa | Ficheiros | Critério de aceitação | Dependência |
|---|---|---|---|---|
| P0-1 | Freeze do HEAD exato | `scripts/source-freeze.mjs`, registo externo de aprovadores | `--verify` PASS com digest do HEAD; sem aprovação herdada | Aprovação humana |
| P0-2 | Seed ClamAV offline verificada | `scripts/clamav-seed-bundle.mjs`, resources | `seed.ok=true` no `--check`; runtime instalado usa seed read-only | Fornecimento do seed |
| P0-3 | Corrigir setup rejeitado | `cybersafe-installer.nsh`, BMPs, package.json, testes | Marca oficial, labels legíveis, capturas reais e progresso real | Aprovação visual |
| P0-4 | Resolver contrato de testes NSIS | `scripts/test/7h-packaging-manifest.test.mjs` | Teste alinhado com o setup aprovado; nenhum teste apagado | P0-3 |
| P0-5 | Nenhuma publicação antes da VM | — | Sem tag/Release/feed até evidência | Aprovação humana |

### P1 — Funcionalidades essenciais

- P1-1 Scanner: benchmark e instrumentação por etapa; medir 800 ficheiros num ambiente controlado.
- P1-2 Terminação individual: provar Notepad/benigno real na VM; manter `KILL_TERMINATION_DISABLED`.
- P1-3 Quarentena: E2E deteção → política → isolamento → restauro/eliminação.
- P1-4 MATRIX: uma resposta real com processo/trends e revisão de qualidade.
- P1-5 Atualizador: feed/manifesto/chave/release; não ativar com fixture.
- P1-6 Núcleo Orbital: integrar o laboratório apenas após aprovação.

### P2 — Estabilidade

- P2-1 Resolver as falhas de affordance da Dashboard (limite e pointer de histórico) com decisão do proprietário.
- P2-2 Reconciliar os 31 testes legados de `process-kill` com o contrato desativado, sem reativar o caminho.
- P2-3 Correr suites completas por ambiente e registar PASS/FAIL/SKIP com commit.

### P3 — Frontend

- P3-1 Aprovar e integrar Orbital Glass V3 por evolução de `CoreScene`/`Effects`.
- P3-2 Reorganizar `SettingsPage` por categorias, preservando as opções existentes.
- P3-3 Capturas 100/125/150% e testes de texto longo.

### P4 — Instalador

- P4-1 Repor a marca oficial no setup; sem “CS” inventado nem estrelas.
- P4-2 Resolver labels/cores e z-order; documentar limites MUI (header/rodapé).
- P4-3 Preencher o espaço direito com conteúdo real; sem áreas vazias.
- P4-4 Testar versão canónica, licenças, atalhos, reparação, upgrade e desinstalação.

### P5 — Validação final

- VM limpa, snapshot, instalação, upgrade, motores, conta, Scanner, PDF, encerramento, GPU/3D, rollback.

### P6 — Distribuição

- Freeze → build único → SHA/manifesto → assinatura → tag → GitHub Release → feed → verificação de update.

### P7 — PAP

- Atualizar o DOCX/PDF com versão, evidências, limitações e capturas aprovadas. Não apresentar o protótipo como setup final.

### Paralelismo possível

Podem avançar em paralelo: benchmark do Scanner, MATRIX com fornecedor, testes de quarentena/tarefas, reorganização de Configurações e protótipo de marca. Não podem avançar antes de aprovação: freeze, build final, assinatura, merge, tag, Release.

---

## PARTE IX — DECISÕES HUMANAS

1. **Aprovar a direção visual do setup** (marca oficial, composição, ecrãs) antes de novo packaging.
2. **Fornecer/validar o registo de aprovadores** e aprovar o freeze do commit exato.
3. **Fornecer o seed ClamAV offline** e autorizar a sua utilização.
4. **Autorizar testes em VM** e a instalação do candidato; nenhuma instalação foi feita nesta auditoria.
5. **Aprovar a chave Ed25519 de produção e o fingerprint**; a chave privada nunca entra no repo.
6. **Decidir Authenticode** (certificado/ausência) e o estatuto de distribuição.
7. **Autorizar merge na `main`**, tag e GitHub Release — decisões separadas.
8. **Decidir a versão `0.2.0`**; o código ainda declara `0.1.11` canónico.
9. **Decidir a prioridade da Dashboard**: limite de itens e pointer para o histórico completo.

---

## PARTE X — CONTINUIDADE

### Próxima ação recomendada

Não começar outro packaging completo. A próxima ação é aprovar a correção de marca/composição do setup e, em paralelo, fechar o benchmark do Scanner e a validação VM. O instalador atual não deve ser promovido a candidato.

### Preservação

- Não fazer `reset`, `clean`, force push ou apagar o stash.
- Não apagar os worktrees.
- Não reativar `KILL_TERMINATION_DISABLED`.
- Não substituir a chave de testes por uma chave de produção.
- Não usar uma fixture como feed de release.
- Não declarar “PASS” de VM sem captura/log do ambiente.

### Comandos seguros de retoma

```bash
git status --short --branch
git rev-parse HEAD
git log --oneline -10
git diff -- packages/desktop/build/installer packages/desktop/package.json
node --test scripts/installer-theme.test.mjs
node scripts/source-freeze.mjs --verify --json
node scripts/package-windows.mjs --check --candidate --json
```

---

## RESPOSTAS DIRECTAS ÀS 30 PERGUNTAS

1. **Estado real:** base funcional avançada, candidata interna R7, mas não release-ready; gates de freeze, seed, design, VM e publicação abertos.
2. **100% validadas no âmbito:** apenas contratos isolados — hash nativo 25/25, tema estático 11/11, UI dirigida 104/104, Scanner/inconclusivos 62/62. Nenhum percurso instalado completo.
3. **Parciais:** Scanner em runtime, quarentena automática, MATRIX, atualizador, 3D, Configurações e setup.
4. **Com problemas:** setup rejeitado/labels invisíveis; Dashboard (afordance de histórico); testes legados de kill; packaging stock.
5. **Corrigido no código desde a R7:** causas estruturadas dos inconclusivos; agregação por motor; z-order do bitmap do instalador; include NSIS; atalho do menu Iniciar; licença real; correções de ClamAV e realtime.
6. **Ainda não chegou a instalação real:** praticamente todas as correções R7/R8; o R7 instalado é o artefacto antigo e usa NSIS stock.
7. **Scanner mais rápido?** Não demonstrado; a única medição é 830 s para o cenário de 800, sem benchmark atual.
8. **Inconclusivos resolvidos?** Não; estão melhor classificados e atribuídos. A taxa e a causa de desempenho não foram reduzidas/provadas.
9. **ClamAV deixou de oscilar?** Há correção e testes no código, mas não há prova numa instalação R7 atual.
10. **Quarentena automática segura E2E?** Não provado; código/testes existem, falta deteção → isolamento → restauro real.
11. **Gestor de Tarefas termina individualmente?** O caminho protegido está ligado no código e testado com handle falso; falta prova com Notepad/processo real. O caminho legado continua desativado.
12. **MATRIX usa dados reais/tendências?** O prompt/contrato existe; não houve resposta real de fornecedor nesta auditoria.
13. **Atualizador operacional?** Não; `enabled:false`, sem chave, feed ou Release.
14. **Orbital Glass implementado?** Não; está em laboratório e não integrado.
15. **Núcleo 3D melhorado?** Existe `CoreScene`/`Effects`; a evolução Orbital não foi integrada nem aprovada.
16. **Configurações reorganizadas?** Não; a página continua em secções longas.
17. **Setup personalizado existe?** Existe código/protótipo, mas o setup R7 é stock e o protótipo foi rejeitado.
18. **Preserva dados/reparação/upgrade?** O contrato R7 e o NSIS preservam `deleteAppDataOnUninstall=false`, reparação e upgrade; o setup custom não foi validado.
19. **Testes em falta na VM:** instalação, login, Scanner, motores, quarentena, PDF, encerramento, tray, update, GPU/3D, rollback.
20. **Falhas atuais:** 3 em `test:scripts`; 31 legadas de `process-kill`; suites completas não executadas.
21. **Falta para candidata final:** design aprovado, freeze/seed, build único, VM, SHA/manifesto e decisão de assinatura.
22. **Falta para `main`:** fechar design/testes/VM, aprovar freeze e atualizar a `main` local/remota.
23. **Falta para Release:** tudo o anterior + chave/feed/Authenticode, tag e autorização.
24. **Depende de si:** design, freeze/approvers, seed, VM, chave, certificado, versão, merge/tag/Release.
25. **Ordem eficiente:** correções de identidade/setup → testes → benchmark/VM → freeze → build/assinatura → `main` → tag/Release → PAP.
26. **Risco técnico mais importante:** publicar um artefacto cuja proveniência/freeze não corresponde ao código e cujo runtime não foi instalado. Em segundo lugar, o desempenho/cobertura do Scanner.
27. **Demonstrar na PAP:** Scanner e motores, inconclusivos explicados, quarentena, Gestor de Tarefas protegido, MATRIX, setup e histórico; apenas o que estiver validado.
28. **Limitações a assumir:** meta de 5 min, MATRIX online, updater online, Orbital, animação, VM/3D e setup custom.
29. **Próximo marco:** aprovação visual e técnica do setup + freeze exato; depois candidata e VM.
30. **Pronto para versão estável?** Não. Há código suficiente para continuar, mas faltam provas de runtime, freeze válido, seed, design aprovado e cadeia de distribuição.

---

## LIMITAÇÕES DESTA AUDITORIA

- Não foi executada a suíte completa de 245 ficheiros de app, 157 de service, 60 de desktop e 28 de native-windows.
- Não foi instalada nenhuma candidata; não houve VM, malware real, EICAR manual, scan pesado, PDF impresso, MATRIX online, update de rede ou teste 3D/GPU.
- As capturas do protótipo do instalador são evidência de um protótipo rejeitado, não do setup final.
- O `--check` foi executado sem criar staging/build; não gerou instalador.
- O freeze foi verificado; falhou por registo de aprovadores ausente e o manifesto existente é antigo.
- Nenhum segredo, chave privada ou token foi incluído neste documento; o caminho do worktree é o único caminho de ambiente registado.

**Conclusão:** o trabalho acumulado é real e substancial, mas a versão estável ainda não existe. O caminho mais seguro é corrigir a identidade e o contrato do setup, provar os percursos instalados e só depois congelar, construir, integrar e publicar.---

## APÊNDICE DE EXECUÇÃO — 2026-11-01

> Este apêndice acrescenta factos medidos depois da auditoria. Não apaga nem reescreve as Partes I–X; quando um número diverge, o valor abaixo é o que foi executado neste worktree.

### A.1 Worktree, branch e commits

- Worktree canónico: `C:\Users\caioc\.cybersafe-integration\freebuff-r7-continuacao-20261101\repo`.
- Branch: `freebuff/r7-final-integration-20261101`. Sem merge na `main`, sem tag, sem Release, sem force push.
- Commits desta continuação:
  - `eaaef77` — restaurar o acesso ao histórico completo na Dashboard;
  - `d133b0c` — não confundir manifesto presente com árvore aprovada;
  - `d40bdda` — ligar a superfície NSIS personalizada;
  - `cb73d68` — fechar a classificação dos canais de quarentena e corrigir o fixture protegido.
- Os cinco BMPs do setup rejeitado continuam modificados e **não** foram commitados. `tmp-installer-preview/` e `output/` continuam preservados como evidência local.

### A.2 Testes e medições

| Verificação | Resultado | Nota |
|---|---|---|
| Suíte desktop completa (`npm run test -w @cybersafe/desktop`) | **636 PASS / 0 FAIL / 0 SKIP** | 98 suites; inclui o typecheck do renderer. |
| Tripwires IPC dirigidos | **89 PASS / 0 FAIL** | boundary, `r6-l13` e `final-security-bridge`. |
| `npm run test:scripts` | **414 testes: 409 PASS / 5 SKIP / 0 FAIL** | Checkpoint após retirar o teste visual rejeitado de `scripts/`. |
| Quarentena | **37/37 PASS** | Checkpoint anterior; não substitui a prova instalada. |
| MATRIX local | **62/62 PASS** | Checkpoint anterior; fornecedor real continua bloqueado. |
| Atualizador | **136/137 PASS** com `node --test` | A única falha é `ERR_IMPORT_ATTRIBUTE_MISSING` por execução direta; o runner do workspace é o caminho válido. |

### A.3 ClamAV em lote

- Probe real com `vendor/clamav/clamav` 1.5.4, 730 ficheiros: **730/730 analisados, 22 408 ms, zero órfãos**, file-list de 62 780 B.
- Amostras anteriores: 5 ficheiros 13 444 ms; 20 ficheiros 13 638 ms; 100 ficheiros 14 771 ms.
- O `load-proof` cold start custa aproximadamente 6,6 s por bridge nova; não é pago por lote na mesma bridge.
- Isto prova o **batch ClamAV**. Não prova o `ScanManager` completo, a meta de cinco minutos, nem a instalação.

### A.4 Quarentena e IPC

- Foram encontrados quatro canais novos de exclusões/política: `getExclusions`, `updateExclusions`, `getQuarantinePolicy`, `setQuarantinePolicy`.
- O ledger passou de 64 para **68 handlers** e de 57 para **61 capacidades** de preload.
- `service:get-quarantine-policy` é leitura permitida no modo Windows read-only; `service:set-quarantine-policy` é escrita negada.
- A falha do teste `final-security-bridge` no modo `confirmed` não era regressão da quarentena: o fixture estava **dentro da raiz de dados do serviço**, que a política protege corretamente. O alvo passou para um diretório temporário separado; o isolamento manual volta a passar e a proteção da raiz foi preservada.
- Continua **não provado** numa instalação Windows: deteção real → política → isolamento → confirmação → restauro/eliminação.

### A.5 O que continua bloqueado

- VM autorizada para instalação limpa, upgrade, desinstalação, login, Scanner, quarentena, PDF, GPU/3D e rollback.
- Processo benigno real para o Gestor de Tarefas.
- MATRIX com fornecedor real e credencial autorizada.
- Chave Ed25519 de produção, fingerprint aprovado e feed assinado; `release-trust.json` continua `enabled:false`.
- Seed ClamAV offline e registo de aprovadores para o freeze.
- Aprovação visual do setup e do Orbital Glass V3; os BMPs rejeitados não são candidatos.
- Authenticode, merge, tag e Release exigem autorização separada.

### A.6 Próximo passo

Continuar a Fase 2 nas tarefas independentes da VM: confirmar o encaminhamento da política de quarentena até à UI, fechar os contratos do Gestor de Tarefas, melhorar as respostas MATRIX e instrumentar o Scanner por motor. Em paralelo, preparar capturas reais para a aprovação visual; não congelar, não integrar na `main` e não publicar sem essa aprovação.

### A.7 MATRIX — contexto com tendência de 24 h

- `buildMatrixContext` passou a comparar as últimas 24 h com as 24 h anteriores e a enviar uma linha `Threats in retained feed`.
- A contagem usa apenas `createdAt` com data válida e não conta datas futuras; a lista do App é limitada a 500 eventos, por isso o rótulo diz “retained feed” e não histórico completo.
- Sem amostras utilizáveis, a linha não aparece; o contexto não inventa uma tendência.
- Teste dedicado: **16/16 PASS**; suíte da app: **2 873/2 873 PASS**; `typecheck` da app: **PASS**.
- Ainda não há fornecedor real autorizado. Isto melhora o contexto factual; **não** prova a qualidade das respostas online.
