# Validação instalada v0.2.0 — NÃO EXECUTADA

Este roteiro complementa VM-ACEITACAO-CANDIDATA.md. Executar apenas após autorização específica da VM e dos artefactos. Não executar no PC pessoal. A versão atual mantém-se 0.2.0-rc.1; um ensaio de upgrade exige duas versões realmente distintas e legitimamente preparadas, não apenas nomes diferentes.

## Preparação e pontos de restauro

Usar conta local sintética e VM Windows x64 sem pastas pessoais partilhadas. Desativar partilhas/clipboard do hipervisor antes de introduzir fixtures; não desativar proteção Windows. Criar snapshots no hipervisor: S0 Windows limpo, S1 versão anterior instalada e encerrada, S2 dados sintéticos persistidos e aplicação encerrada, S3 candidata validada. Guardar ID, data, versão Windows, recursos e hashes do setup em C:\lab\evidence\<run-id>. Restaurar apenas snapshots desta VM, após fechar o ensaio e copiar evidência para destino de laboratório autorizado. Snapshot não é prova de rollback implementado no produto.

Copiar o setup, checksum aprovado, versão canónica e scripts; não copiar chaves privadas. Executar o preflight do roteiro anterior passando ExpectedVersion e ExpectedSha256 reais. Preflight divergente interrompe. A recolha não aprova Authenticode. Sem publisher/certificado e manifesto legitimamente assinados, os testes do atualizador de produção ficam BLOQUEADOS; não editar release-trust.json na VM para os fazer passar.

## Matriz executável e aceitação

| Caso | Ação na VM autorizada | Resultado exigido / evidência |
|---|---|---|
| 01 Instalação limpa | Restaurar S0; executar setup interativo aprovado | Branding oficial, opções e progresso reais; binários/atalhos/Uninstall coerentes; capturas e log NSIS; nenhuma elevação inesperada |
| 02 Arranque inicial | Manter Abrir CyberSafe marcado; concluir | Janela visível e utilizável, versão correta; sem ficar apenas na tray; registar tempo real até pronto |
| 03 Fecho/abertura | Fechar janela, reabrir por atalho; terminar pela tray e reabrir | Política de fecho respeitada, sessão/dados persistem; uma instância principal; sem auxiliares órfãos |
| 04 Tray | Ocultar/minimizar; duplo clique; testar menu | Mesma janela restaurada em foreground; sem segunda instância; ações do menu preservadas |
| 05 Autostart | Ativar na UI; confirmar Windows; reiniciar VM; depois desativar e repetir | Preferência persistida e comportamento correspondente; não modificar manualmente o registo para simular êxito |
| 06 Scanner | Corpus benigno isolado, inventário SHA-256; análise personalizada; exportar PDF e histórico | Contagens/motores/causas iguais entre UI, histórico e PDF; inconclusivos nunca limpos; métricas e estado terminal |
| 07 Motores | Registar versões de runtime, base, regras e pin; iniciar e repetir lote pequeno | ClamAV carga comprovada, health e transições documentados; sem processos repetidos persistentes; YARA limitada identificada; HashDB/Native reais |
| 08 Gestor | Usar scripts/vm-process-fixture.ps1 para processo benigno; confirmar PID/creation/path; terminar pela UI | Apenas processo individual confirmado termina; protegidos recusados; auditoria correspondente; kill legado permanece bloqueado |
| 09 Upgrade | Em S2, executar percurso autorizado anterior→posterior | Consentimento, assinaturas/hash/locks, shutdown e NSIS reais; zero exit só awaiting-start; versão nova e dados prontos necessários para completed |
| 10 Configurações | Antes de S2, definir tema/acento, consentimento, atualização automática e exclusão sintética | Após upgrade e novo arranque, valores preservados; exclusão só na pasta sintética, nunca pasta protegida |
| 11 SQLite | Criar utilizador e histórico sintéticos; encerrar; guardar cópia consistente; após upgrade verificar UI e SQLite read-only | quick_check=ok, tabelas/migrações esperadas e mesmos registos/IDs essenciais; sem perda de sessão/histórico indevida; não comparar apenas hash da base migrada |
| 12 Reparação | Snapshot S3; executar modo de reparação real disponível | Componentes recompostos sem apagar dados; arranque/versão corretos; se não houver modo real, marcar bloqueado, não simular |
| 13 Desinstalação | A partir de clone S3, desinstalar pela entrada Windows | Binários/atalhos/entrada removidos; sem processos órfãos; dados conforme opção/política apresentada; não apagar manualmente para produzir PASS |
| 14 Falhas | Snapshots separados; artefacto alterado, assinatura recusada, recusa de consentimento; interrupção controlada só na VM | Recusa antes de instalação nos três primeiros; interrupção mantém evidência e recuperação necessária; sem retry automático |
| 15 Recuperação | Preservar diário e staging; relançar; testar versão divergente/dados inválidos em cópias | Estado honesto, nenhuma declaração completed; sem relançar instalador automaticamente; reinstalação/restauro só com artefacto e ação autorizados |

Para SQLite: copiar a base apenas com aplicação/API/serviço encerrados e sem escritor. Se existirem WAL/SHM, preservar o conjunto consistente ou usar API SQLite backup num ambiente de ensaio; nunca substituir a base em execução. Guardar exportação lógica sintética antes/depois, versões de esquema, quick_check e contagens. Não recolher passwords, JWT, DPAPI, API keys ou dados pessoais nos logs de entrega.

## Scanner e ClamAV

O caso dos 594 segundos só pode ser comparado com corpus, hashes, exclusões, candidatas, recursos e versões de bases equivalentes. Se o corpus não existir, apresentar medição nova, sem percentagem de melhoria histórica. Ativar CYBERSAFE_DEBUG_SCAN apenas no processo de ensaio. Recolher engine-init, PHASE_END, ENGINE_PHASE, CLAMSCAN_SPAWN_CALL_BEGIN, RESOURCE_SUMMARY e estado terminal. CPU/RSS Node não incluem filhos ClamAV/Native. Medir esses processos separadamente na VM, com PID/creation e intervalo definido; não somar percentagens de âmbitos diferentes.

Para saúde: primeiro registar carga de assinaturas e duração do arranque; depois um lote benigno pequeno, uma consulta health concorrente e novo lote. Induzir timeout apenas por fixture/configuração de laboratório autorizada, nunca corromper a seed oficial. Exigir recuperação na mesma instância quando houver evidência positiva e ausência de processos próprios órfãos. Capturar degradation reason e limites; não confundir espera pelo slot com motor morto.

## Logs, interrupção e recuperação manual

Em cada caso guardar: run-id, operador, snapshot, hora UTC, setup/hash, versão instalada, passos, esperado, observado e PASS/FAIL/BLOCKED. Copiar logs da aplicação/serviço/API do userData real, diário updater-operation.json e result.json do staging após encerrar. Redigir segredos antes de partilhar. Capturas devem mostrar versão e estado, sem credenciais.

Interromper perante hash/assinatura divergentes, acesso a caminhos fora do laboratório, perda de dados, elevação inesperada, processo errado terminado, loop de instaladores ou recursos descontrolados. Não repetir instalação nem editar/apagar diário para desbloquear. Preservar evidência; fechar processos próprios pelos meios normais; restaurar snapshot VM aprovado. Recuperação de produto pode exigir instalador verificado e restauro consistente autorizado: não existe rollback automático validado. Nunca transportar o backup de laboratório para o PC pessoal.

Aceitação final exige todos os casos aplicáveis executados, bloqueios explicitados e revisão humana. Os cinco testes nativos existentes não substituem nenhum ensaio NSIS desta matriz.
