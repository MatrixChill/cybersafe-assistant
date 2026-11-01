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
