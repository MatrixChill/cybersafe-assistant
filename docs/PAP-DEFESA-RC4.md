# Defesa da PAP — CyberSafe Assistant RC4

| Slide | Mensagem e apoio visual |
| --- | --- |
| 1. Problema e objetivos | Reunir análise de ficheiros e leitura do estado do PC numa interface académica, explicando os limites da evidência. |
| 2. Arquitetura | React e TypeScript no renderer Electron, preload e IPC, serviço Windows por named pipe autenticado, API Express em loopback, SQLite e armazenamento local. |
| 3. Scanner e motores | ClamAV, YARA, HashDB e Native contribuem com sinais distintos. Mostrar como o resultado distingue análise concluída, falha e cobertura incompleta. |
| 4. MATRIX e monitorização | Mostrar uma pergunta local sintética e o rótulo de origem. Abrir PC Center e Gestor de Tarefas em consulta. |
| 5. Testes e resultados | RC1 → RC4 no Windows físico, Scanner 3/3 em cerca de 13 s, histórico e Dashboard atualizados, 13/13 SQLite após encerramento. |
| 6. Limites e entrega | Timeout ClamAV recuperado, cobertura watcher por confirmar, WFP não provisionado, MATRIX online por validar e updater desativado. Mostrar o hash e a pré-release manual. |

## Demonstração

Abrir a RC4 já instalada. Escolher «Análise personalizada» e apontar para [a pasta da demonstração](pap-demo/), com três ficheiros benignos. Mostrar a contagem real, abrir o histórico e voltar ao cartão «Última análise». Consultar PC Center, Gestor de Tarefas e MATRIX local sem enviar dados. Encerrar normalmente pela tray. Se o ensaio em direto não terminar, apresentar os resultados físicos anteriores com a data e o âmbito, sem atribuí-los à execução em direto.

Para EICAR e restauro, apresentar a matriz de testes históricos. A demonstração não precisa de executar ameaças, terminar processos ou alterar configurações.
