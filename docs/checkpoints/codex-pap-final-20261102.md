# Continuidade técnica — 2026-11-02

## Fonte e limites

Pedido do proprietário e documento `CYBERSAFE_PROMPT_CODEX_FINAL.md`, lido integralmente. Trabalho diretamente no Windows, sem Maestri. Branch canónica: `codex/pap-final-integration-20261102`, derivada da R7. Versão preservada: `0.1.11-internal.pap-r7.20261031`.

Sete worktrees localizados. Base comum R7/Freebuff local: `2dae912`. A linha local tinha apenas `94ac447` exclusivo; a R7 contém alterações posteriores de saúde, recuperação, Scanner, MATRIX e instalador. Merge com dois pais em `6de1121` preserva ambas. Conflitos dos testes resolvidos mantendo as fixtures e o teste determinista de cancelamento da R7.

Remoto consultado por `git ls-remote`: R7 `83ee706e7a8cce6e9093d9e6352e6c974c0bb990`; main `21fefa69352516c188f99c665966d4443588aa2b`. Nenhum push, tag, Release ou alteração à main. Cinco BMPs modificados, `output/`, `tmp-installer-preview/` e stash preexistente preservados e fora dos commits.

## Implementação e evidência

- `6de1121`: prioridade ClamAV `user > health > background`, com `waitingHealth`, preservando defer/busy e recuperação da R7. Prioridade/backpressure: 7 PASS. Mutação da prioridade para background: novo teste falha; restaurada a implementação: PASS. Build e typecheck core: exit 0.
- Saúde/busy/cache/recuperação: 20 PASS. Inclui binário real com assinatura local benigna; não prova cobertura oficial nem instalação.
- `4521ccf`: fixtures de ciclo de vida e base truncada incluem a diária necessária para atingir a prova de carga. Antes: 8 falhas de lifecycle e 1 falha de integração real. Depois: 8 PASS + 1 PASS, com `CYBERSAFE_CLAMSCAN_PATH` apontado a `vendor/clamav/clamscan.exe`. Não se alteraram as expectativas nem se desativou qualquer guarda.
- `9acff02`: relatório consolidado conserva causas e motores dos inconclusivos, incluindo em modo anonimizado. Reutiliza normalizadores/rótulos existentes, rejeita códigos desconhecidos, distingue contagens por motor de ficheiros únicos e marca resultados parciais sem verde. Dois testes novos falham antes e passam depois. Regressão relacionada: 141 PASS. Typecheck/build app: exit 0; aviso existente de chunks acima de 500 kB. Exportação instalada e paginação visual ainda não validadas.
- Desktop: 70 PASS em terminação individual, confiança de produção e segurança/máquina de estados do atualizador. Trust de produção continua fechado.
- Serviço: build exit 0; 26 PASS em terminação individual, política/caminhos/segurança da quarentena e classificação de inconclusivos. Processos nativos simulados; não foram terminados processos pessoais.

Comandos principais:

```powershell
npm run build -w @cybersafe/core
npm run typecheck -w @cybersafe/core
node --test packages/core/test/clamav-slot-priority.test.js packages/core/test/clamav-slot-backpressure.test.js
$env:CYBERSAFE_CLAMSCAN_PATH = (Resolve-Path vendor/clamav/clamscan.exe).Path
node --test packages/core/test/clamav-positive-load-proof-lifecycle.test.js
node --test --test-name-pattern=TRUNCADO packages/core/test/clamav-load-proof-real.integration.test.js
node node_modules/tsx/dist/cli.mjs --tsconfig packages/app/tsconfig.app.json --test packages/app/test/scan-session.test.ts packages/app/test/scan-history-count-truth.test.ts packages/app/test/scan-history-cancel-coverage.test.ts packages/app/test/reports-central-sources.test.ts packages/app/test/ag36-consolidated-report.test.ts packages/app/test/inconclusive-engine-label.test.ts
npm run build -w @cybersafe/app
npm run build -w @cybersafe/service
```

O runner app exige o tsconfig para resolver `@/`; uma invocação inicial sem ele falhou na importação de dois ficheiros, corrigida usando o runner acima.

## Credencial MATRIX

Provisionada por autorização explícita através do armazenamento existente `createAiCredentialsStore` e Electron `safeStorage`/DPAPI no perfil `%APPDATA%/CyberSafe Assistant`. Verificação após reabrir: cifrada, presente, fornecedor Groq. Nenhuma credencial em ficheiros do repositório. O runtime Electron da dependência existente foi reposto com o seu instalador; não se alteraram versões/lockfile.

O pedido de teste online foi bloqueado pela política automática da ferramenta, sem motivo específico além de `blocked by policy`. Não foi contornado. Gravação protegida não equivale a ligação online validada, nem a recarga da API da aplicação já aberta. A revogação da credencial antiga continua a depender do proprietário.

## Plano de continuidade

1. Regressão da fila health na morte não confirmada concluída: falha ao remover a drenagem; PASS após restaurar. Sem spawn adicional, fila drenada e saúde degraded.
2. P1: executar carga real controlada com base oficial em ambiente isolado autorizado; usar scanner-benchmark/runtime-probe existentes. Não extrapolar os testes de fixtures para os 800 ficheiros instalados.
3. Completar taxonomia por ficheiro/fase/identidade/limites e retry seguro sem inventar causas; o relatório corrigido apenas preserva os agregados já medidos.
4. P2: prova IPC/preload/serviço da quarentena e ensaio instalado do protocolo individual de terminação, apenas com processo de teste em VM autorizada.
5. MATRIX: desbloquear prova online; preservar consentimento e minimização de dados. P4: upgrade entre candidatas, sem provisionar trust de produção por inferência.
6. Otimizar/Configurações e frontend após P0/P1. Redesign e setup sujeitos às aprovações visuais específicas; BMPs rejeitados não entram.
7. VM, freeze e pacote final continuam pendentes. Publicação, main, tag e Release exigem autorização específica. Nenhum destes estados foi declarado concluído.
