# Continuação Freebuff R7 — 01/11/2026

## Ambiente e limites
- Base: `2e3f311fb8d49e0355458766dfa0b64f98cfcf22`; branch `freebuff/r7-final-integration-20261101`.
- Caminho: `C:\Users\caioc\.cybersafe-integration\freebuff-r7-continuacao-20261101\repo`.
- Auditoria: INDEX e documentos 01–11 lidos. Veredito histórico: HOLD JUSTIFICADO.
- `git ls-remote origin refs/heads/main`: `21fefa69352516c188f99c665966d4443588aa2b`; base 4 à frente / 0 atrás.
- Commits Qoder preservados: eef82ba, c6b5d14, e026353, 2e3f311.
- Histórico Freebuff: 2dae912, ancestral da base (58 commits). Nenhuma edição nesse worktree.
- Novo worktree começou limpo; comparação de HEAD/status/diff e SHA-256 dos 11 ficheiros WIP Qoder idêntica antes/depois: `preservation.json`.
- Sem push, instalação, serviços Windows, Defender, chaves de produção ou aprovação de freeze.

## Matriz curta Core (evidência Codex; classificação após reprodução dirigida)
Fonte: auditoria `evidence/core-full-post-yara.log.failures.txt`; original `qoder-goal-final-20261101/logs/core-full-post-yara.log`.

| ID | Teste / linha original | Esperado | Observado no log histórico | Estado |
|---|---|---|---|---|
| C1 | clamav-slot-backpressure.test.js:119 | Fila background atinge teto e recusa extra honestamente | waitFor(fila de background cheia) 5000 ms | Fixture inválida: o filho load-proof ocupava o portão, não a análise; fixture corrigida |
| C2 | clamav-slot-priority.test.js:149 | Utilizador recebe próxima vaga | bg-001 em vez de bg-901 | Fixture/load-proof e sincronização: esperar filas medidas antes de libertar a vaga |
| C3 | clamav-slot-priority.test.js:238 | Dispose drena scans em espera | waitFor(fila de background) 5000 ms | Fixture inválida: o filho load-proof ocupava o portão, não a análise; fixture corrigida |
| C4 | clamav-slot-priority.test.js:272 | Aborto durante writeFile impede spawn | Lista temporária nunca aparece em 10000 ms | Fixture/load-proof bloqueava a chegada à escrita; janela agora controlada com bytes reais e barreira |

Os números Core 1064 PASS / 4 FAIL / 30 SKIP / 1 TODO pertencem ao log antigo, não a execução Freebuff.

## Causa e correção da Fase 1
- C1: o primeiro filho observado era a prova de carga. Os scans esperavam por `isAvailable()` e não pelo semáforo; a fila nunca atingia o teto.
- C2: a libertação fazia avançar a prova, não o scan ativo pressuposto. Esperas fixas não comprovavam entrada das classes na fila. A fixture responde à prova com o helper partilhado e espera os contadores reais.
- C3: mesma pré-condição inválida, comprovada individualmente: o dispose nem era atingido. Com prova concluída e fila real de três jobs, a drenagem passa.
- C4: prova pendurada impedia chegar ao `writeFile`; polling do temporário dependia ainda do disco. O teste agora aguarda uma escrita REAL concluída mas cuja promessa está retida, aborta nesse await e prova ausência de spawn, erros por ficheiro e remoção da lista.
- Produção: nenhum ficheiro em `src/` alterado. Prova de carga, leases, cap, poison, bloqueio legado de terminação e guardas de cancelamento intactos.
- Testes: respondem à prova pelo seam de subprocesso existente; não desligam load-proof nem simulam o semáforo. Registo dos jobs pendentes melhora o cleanup mesmo em falha.
- Revisão: diff inspecionado; nenhuma alteração a dependências, lockfile, versão, trust ou documentação WIP do Qoder.

## Verificação (novas execuções Freebuff)
- Bootstrap por lock: `npm ci --workspace @cybersafe/core --workspace @cybersafe/shared-types --include-workspace-root=false --ignore-scripts --no-audit --no-fund` → exit 0. Scripts de instalação não executados; só dependências necessárias a esta fase.
- `npm run build -w @cybersafe/shared-types && npm run build -w @cybersafe/core` → exit 0, antes da reprodução; fontes de produção não mudaram depois.
- RED: `node --test --test-concurrency=1 packages/core/test/clamav-slot-backpressure.test.js packages/core/test/clamav-slot-priority.test.js` → 2 PASS / 4 FAIL / 0 SKIP / 0 TODO, exit 1, mesmas quatro falhas Codex (`core-slots-red.log`).
- Backpressure isolado após correção → 1 PASS / 0 FAIL / 0 SKIP / 0 TODO, exit 0.
- Prioridade isolada após correção → 5 PASS / 0 FAIL / 0 SKIP / 0 TODO, exit 0. Uma tentativa intermédia teve erro de sintaxe na edição via adaptador; corrigido antes desta execução.
- Mutação só no artefacto derivado `dist/clamav.js`, nunca no source: inverter prioridade → teste falha na ordem; remover guarda pós-escrita → teste falha por scan cancelado pendurado. Cada execução: 0 PASS / 1 FAIL / 0 SKIP / 0 TODO, exit 1 esperado. Artefacto reposto byte a byte em `finally` antes da regressão final.
- Regressão conjunta final: EM VERIFICAÇÃO; não executar suíte completa nesta fase.
- Logs locais nesta pasta são ignorados pelo Git; o resumo/hash será guardado em `TESTES.json`.

## Estado e próxima ação
- Fase 1: alterações concluídas; falta ler resultado conjunto final e criar commit.
- Próxima fase: nove falhas `p1-1-clam-db-gate` e agrupamentos Service pela evidência Codex; não reativar kill legado.
- Restante missão R7 continua em HOLD: degradação instalada ClamAV/Native desconhecida, segurança e contratos Service/YARA por validar, confiança de produção não aprovada, freeze/instalador/VM/publicação pendentes.
- Não há setup R7 nem aprovação de source freeze. Não foram alterados Windows/Defender/serviços nem dados pessoais.

## Fecho verificado desta sessão (prevalece sobre os estados intermédios acima)
- Regressão conjunta final: **6 PASS / 0 FAIL / 0 SKIP / 0 TODO**, exit 0, 51084.1705 ms; `core-slots-green.log`.
- Duas mutações negativas detetadas (exit 1 esperado): prioridade invertida e guarda de aborto pós-escrita removida. Artefacto compilado reposto byte a byte antes da regressão conjunta.
- Quatro falhas Core classificadas e corrigidas no harness; nenhuma alteração de produção. Isto não certifica estabilidade de ClamAV na instalação real nem substitui a futura regressão integrada.
- `git diff --check`: exit 0. Lockfile e manifests de dependências sem alterações.
- **COMMIT PENDENTE**: o adaptador recusou o comando combinado de registo de evidência/staging com `Use request_elevation; direct privilege wrappers are refused`, apesar de não haver wrapper de elevação. Não foi repetida a operação recusada nem pedida elevação para contornar a recusa. Staging vazio; HEAD continua 2e3f311fb8d49e0355458766dfa0b64f98cfcf22. TESTES.json não foi criado.
- Estado final: dois testes modificados + PROGRESSO.md e preservation.json novos; logs locais presentes e ignorados pelo Git. Nenhum push.
- Worktree histórico continua limpo. Qoder continua em 2e3f311, README/CHANGELOG e nove documentos WIP preservados; hashes comparados sem mudança após as edições.
- Próxima ação no novo projeto Freebuff: concluir commit da Fase 1 quando o adaptador permitir escrita Git; depois reproduzir as nove falhas p1-1 e prosseguir pelos agrupamentos Service. Não executar suítes completas nem build de distribuição antes dos gates previstos.

## Continuação — Fase 1 fechada e primeiro conjunto Service
- Fase 1 commitada com permissões normais em **b42f497d191b9b6928c8e32665daf03e65ecd196**. Só os quatro ficheiros da fase; árvore limpa após commit. Não foi necessária elevação. Core não reexecutado; hashes dos dois testes iguais aos da entrega anterior.
- Fase 2: nove falhas históricas p1-1 reproduzidas isoladamente: filtro YARA/reference/conflito = 0 PASS/8 FAIL; warning isolado = 0 PASS/1 FAIL. Todas recusadas por pin antes da asserção/seam pretendido; não foi contaminação do gate nesta reprodução.
- Correção: pins das fixtures pelo seam yaraPin já existente, revision fixa, SHA-256 dos bytes servidos e classes explícitas. Pins/configuração/código de produção intactos; compilador e motor YARA clássicos reais, transporte simulado e sem rede.

| Caso original | Classificação e prova após correção |
|---|---|
| :531 publicação falhada | Fixture; rename atingido uma vez, erro simulado e corpus anterior intacto, sem temporários |
| :568 rollback reload | Fixture; candidato carregado e detetado, falha simulada, duas recargas, bytes anteriores restaurados, motor disponível, só marcador anterior detetado |
| :618 rollback irrecuperável | Fixture; duas recargas, disco restaurado, motor indisponível/error e match recusado |
| :664 publicação completa | Fixture; novo corpus e canary publicados sem temporários |
| :700 agregação | Fixture; test/production incluídas, reference excluída |
| :745 warnings | Fixture; slow-scan reportado como warning, não erro |
| :788 módulos | Fixture; módulo inválido recusado e fonte compatível publicada |
| :835 reference | Fixture; referência fora do merge, sem conflito artificial |
| :882 conflito | Fixture; production conflituosa recusada, fonte anterior aceite preservada e manifesto coerente |

- Nove dirigidos após correção: **9 PASS/0 FAIL/0 SKIP/0 TODO**, exit 0, service-p11-nine-green.log.
- Regressão: `node --test --test-concurrency=1 packages/service/test/p1-1-clam-db-gate.test.js packages/service/test/yara-pin-verificado.test.js` → **46 PASS/0 FAIL/0 SKIP/0 TODO**, exit 0, service-p11-regression.log. Nenhuma suíte completa executada.
- Dependências dos quatro workspaces necessárias ao Service instaladas por lock, ignore-scripts; builds shared-types/core/native-windows/service sequenciais exit 0. Lock/manifests não alterados.
- SHA-256 logs: RED oito 6b176e2157c6128ad8db19c61596e92bc3adde71b74641b46c66d632693b4702; RED warning dbd5aea38e233f620fdb6d5ce3d39acc0c5326914bf0fd7a70f4d846d4d72e26; GREEN nove 284c4f08b79bb95811d4da6a1015aa93ba9637f550cad659004e92e60f81e01b; regressão 9470b056eb2a2a62e67c80af504e97c97d26c15493651d27ac4785c1712e95b8.
- Descoberta concreta: lista yaraPin vazia mantém disco e não descarrega, mas runCheckAndUpdate anuncia yaraUpdated=true. Inconsistência de estado/contrato; não prova execução insegura nem bloqueio do instalador. Próximo conjunto: teste dirigido e correção fail-closed, em commit separado.
- Limites: não prova eficácia antimalware nem instalação R7; outras famílias Service continuam por classificar. ClamAV real/freshclam não executados nem bases pessoais alteradas. Sem push/Release/serviços Windows/freeze.

## Segundo conjunto Service — estado honesto quando não há pins
- Conjunto anterior commitado em **cc4b3539daac16d2afabad3a3d67e184267a5c13** (nove fixtures p1-1 e checkpoint); árvore limpa após commit.
- Ativo protegido: corpus e estado de atualização. Entrada: configuração vazia; nenhum conteúdo remoto autorizado. Alcance da correção: impedir falso sucesso/frescura/reload, não ampliar acesso ou confiança. Sem novas permissões, rede, dependências ou segredos.
- Defeito de produção confirmado: updateYaraRules retornava normalmente com erro na lista, logo ambos os chamadores anunciavam sucesso sem corpus novo. Correção mínima: lançar a recusa e usar os catches existentes (ciclo regista falha/backoff; recuperação devolve false).
- Teste existente reforçado: yaraUpdated=false, sem reload, sem timestamp de sucesso, uma falha em backoff, zero descargas e bytes anteriores intactos. Novo teste: refreshYaraCorpus=false com lista vazia, preservando os bytes; flags locais repostas no cleanup.
- RED dirigido dos dois caminhos: **0 PASS/2 FAIL/0 SKIP/0 TODO**, exit 1; service-empty-pin-red.log SHA-256 626b0a6d88599ad585a819ba891f6beba6da160bd5ec36bb3b9d17de87ef0b1f.
- `npm run build -w @cybersafe/service`: exit 0 após a alteração. Regressão `node --test --test-concurrency=1 packages/service/test/yara-pin-verificado.test.js packages/service/test/rc22-engines-yara-recovery-guard.test.js`: **10 PASS/0 FAIL/0 SKIP/0 TODO**, exit 0; service-empty-pin-green.log SHA-256 9739582dcb89e7a5af945bdabb6c4872ed9086df3139c981435a1c7d66e41abb. Não somar com as execuções anteriores sobrepostas.
- Classificação: inconsistência real de estado (P2), não demonstrado novo bloqueador de instalação ou execução de conteúdo não verificado; corrigida antes de avançar. Revisão do diff: sem alterações ao gate, hashes, trust nem políticas de terminação.
- Preservação reconfirmada: histórico/Qoder com mesmos HEAD/status; os 11 hashes WIP Qoder iguais ao registo inicial. Core permanece byte a byte igual ao commit b42f497. Sem push, Release, setup, aprovação de freeze ou alterações ao host.
- Próximo passo: restantes famílias Service já agrupadas pelo Codex, começando pelos cinco casos de safe/inconclusive e respetiva proveniência Native/prefetch; manter recusa de kill legado. Não declarar resolvidos os restantes 54 FAIL históricos sem classificação e prova própria.

## P0 motores — Native compilado e resolução no serviço embutido
- Preservação: branch/HEAD iniciais confirmados em 3998dfd; b42f497/cc4b353/3998dfd presentes, sem WIP anterior. Core não repetido.
- Build sequencial: `cmake -S packages/native-engine -B packages/native-engine/build -A x64 && cmake --build packages/native-engine/build --config Release` exit 0 (MSVC 19.51, Visual Studio 18 2026). PE machine=8664 (x64), 324096 bytes, SHA-256 f08789d6739da74710525f88248259a0b634f6729298f980b4e9356222a62e3f. CMake usa /MT; nenhum binário antigo importado.
- Prova inicial real: `node --test --test-concurrency=1 packages/native-engine/test/hash-vectors.test.js packages/service/test/rc22-native-regressao.test.js` → 31 PASS/0 FAIL/0 SKIP/0 TODO. Vetores SHA-256, benignos e erro honesto por alvo inexistente. Log native-built-runtime.log (ignorado).
- Defeito controlável: serviço filho pode não expor process.resourcesPath; resolutor só conhecia resourcesPath/árvore DEV/cwd. Acrescentado candidato relativo a process.execPath, antes de DEV, conforme extraResources já existente. Nenhuma variável privilegiada ou pin de confiança novo.
- RED da fixture de instalação com espaços/acentos: 0 PASS/1 FAIL/0 SKIP/0 TODO; escolheu árvore DEV, não binário junto do anfitrião. GREEN com binário real compilado, mesmo hash do alvo e zero filhos pendentes.
- `npm run build -w @cybersafe/service` exit 0. Regressão `node --test --test-concurrency=1 packages/service/test/rc22-native-regressao.test.js packages/service/test/rc22-motores-native.test.js packages/service/test/r7-native-probe-singleflight.test.js packages/service/test/rc22-native-init-guard.test.js` → 23 PASS/0 FAIL/0 SKIP/0 TODO; inclui timeout, recuperação posterior, cancelamento prévio, pipeline scanArtifact e guardas de modo. Um caso condicional de ausência não exercita ausência porque o binário está presente; essa cobertura não é alegada.
- Revisão do diff/check aprovadas; teste RED já remove a nova regra de resolução e demonstra a regressão. Sem novos pacotes, sem alterações a Windows/Defender/serviços/trust/versão. Build e logs ignorados não commitados.
- Limites: estrutura empacotada simulada com binário atual real, não Electron instalado nem NSIS/VM. Causa específica na VM R6 ainda não atribuída a esta lacuna. Inclusão extraResources existente, artefacto instalável não produzido.
- Próxima ação: cache ClamAV sem expiração (primeira falha persiste sem force); RED/GREEN de revalidação limitada e prova com base local benigna, sem ler bases pessoais.

## P0 motores — revalidação da cache ClamAV
- Native do conjunto anterior commitado em a0b5314. Nenhuma conclusão sobre instalação VM.
- Causa demonstrada: probePromise guardava para sempre o primeiro resultado; sem force, uma base que chegasse após falha inicial nunca era recolhida, e uma saúde positiva também não expirava.
- RED (fixture corrigida para incluir daily e efetivamente exigir carga): `node --test --test-concurrency=1 packages/core/test/clamav-probe-cache-recovery.test.js` → 0 PASS/3 FAIL/0 SKIP/0 TODO; falha permanente, saúde positiva permanente e sonda após dispose. Primeiro ensaio detetou ausência de daily na fixture; corrigida antes do RED válido, não relaxada a asserção.
- Correção localizada: validade de 30 s quando não active, 5 min quando active; revalida na próxima chamada (não cria timers nem sondas periódicas), single-flight/force preservados, dispose recusa sonda. Lease, semáforo, poison e prova de carga intactos.
- `npm run build -w @cybersafe/core` exit 0. Cache + clamav-health-recovery: 16 PASS/0 FAIL/0 SKIP/0 TODO. Mantém degradação por bases antigas/aborto/sem veredicto e recuperação só com evidência.
- Teste real adicional com clamscan do ambiente e .ndb criada nesta área: base ausente → chegada → revalidação sem force → benigno clean → marcador benigno detected. `node --test --test-concurrency=1 packages/core/test/clamav-probe-cache-recovery.test.js` final: 4 PASS/0 FAIL/0 SKIP/0 TODO. Não há EICAR, amostras malware, rede nem leitura de bases pessoais; .ndb continua cobertura limitada/degraded.
- Scanner/Native contrato existente: `node --test --test-concurrency=1 packages/service/test/qa3-native-result.test.js` → 12 PASS/0 FAIL/0 SKIP/0 TODO, incluindo indisponibilidade real forçada na fronteira de fs, resultados inconclusivos e deteções preservadas.
- Limites: renovação da cache é acionada por chamadas/scans, não por simples leitura de health; recuperação autónoma em repouso ainda não acrescentada. Base oficial/freshclam e VM não certificados. Não somar execuções sobrepostas. Logs clam-cache-{red,green,real-green}.log e scanner-native-qa3.log locais/ignorados.
- Revisão: diff/check aprovados; sem dependências/versão/pins/chaves/Windows. Próxima prioridade independente: Scanner (cinco falhas históricas safe/inconclusive), quarentena/restauro e exclusões.
