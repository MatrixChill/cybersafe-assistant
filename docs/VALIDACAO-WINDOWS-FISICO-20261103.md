# Validação instalada no Windows físico — 3 novembro 2026

Este registo sucede à preparação offline de RELEASE-READINESS-V020.md. O proprietário autorizou expressamente substituir a RC1 pessoal após backup verificável. Não foi utilizada VM, reconstruído o setup, emitido novo freeze ou ativada a atualização de produção.

## Identidade e recuperação

- Fontes observadas: main, c895c93293763bf6f1e40e78dc742cfa938bedad.
- Artefacto instalado: candidata 78aff29341d99767dfb97b2ef458db810b049b00, versão 0.2.0-rc.1. Não é v0.2.0 estável.
- Setup preservado: packages/desktop/release/candidate-20261103-211243-99d72e39/CyberSafe Assistant-0.2.0-rc.1-candidate-20261103-211243-99d72e39-setup.exe.
- Tamanho: 278767097 bytes. SHA-256: c17111d553d75ef316ed81a062fa0ffed6b8c8827382b17618a9915a2896122b.
- ASAR instalado: SHA-256 484599a9d7fa789966c0e0a480d35840dba3c069df7cbe38c597bc7e08756dad, correspondente ao payload verificado.
- Authenticode: NotSigned; nenhuma proteção do Windows foi desativada ou política contornada.
- Backup privado fora de Git: 2261 ficheiros, 1256618916 bytes, hashes origem antes/depois/destino conferidos, permissões limitadas ao proprietário e SYSTEM. Instalação, perfis, serviço, quarentena, chaves recuperáveis, SQLite/WAL/SHM, atalhos e estado de arranque preservados.
- As 13 bases copiadas passaram quick_check; o runtime anterior também abriu as cópias. O instalador anterior foi preservado e verificado pelo SHA-256 155862f6453201d052a32f1d48fe1f349d86a1f32f517097e9ed8168133896a6.
- Recuperação documentada exige parar processos e restaurar o conjunto completo dos dados anteriores, preservando os dados novos separadamente. Reinstalar apenas o EXE não é rollback suficiente. Não foi executado rollback instalado.

## Resultados desta execução

| Percurso | Estado | Evidência e limites |
|---|---|---|
| Substituição autorizada | PASS | Novo ASAR instalado; aplicação abriu visivelmente. Houve intervenção humana no wizard; não se atribuem todos os cliques à automação. |
| Sessão pessoal | PASS | Sessão existente restaurada após instalação e novo arranque. |
| Autenticação sintética API | PASS | Registo 201, consulta autenticada 200, logout 204, token revogado 401, novo login e consulta 200. Sem logout da sessão pessoal; formulário de login não ensaiado com conta nova. |
| API e IPC | PASS | API apenas em loopback, health 200/databaseReady; consultas reais pelo IPC autenticado existente. Credencial apenas em memória. |
| Scanner benigno | PASS limitado | 6 ficheiros exteriores/357 bytes, incluindo ZIP benigno e ficheiro vazio; 6 analisados, zero inconclusivos, excluídos, falhados ou ameaças; hashes da fixture intactos. |
| Histórico Scanner | PASS | Registo do ensaio encontrado no serviço e na interface, às 22:18. Histórico anterior com resultados parciais/inconclusivos também visível. |
| Exportação PDF | NOT TESTED | Botão inicialmente desativado até expandir detalhe, conforme contrato; não é prova de defeito. Não foi gerado PDF neste ensaio. |
| Quatro motores | PASS disponibilidade | ClamAV, YARA, HashDB e Native ativos no serviço e na interface; isto não prova participação de todos em cada ficheiro nem eficácia ampla. YARA: 20 regras, cobertura desconhecida; HashDB: 3 assinaturas. |
| Proteção global | FAIL para cobertura integral | Rejeições/perdas do watcher em Temp e WFP indisponível reportados honestamente. Quatro motores ativos não equivalem a proteção integral. |
| PC Center | PASS limitado | Vistas simples/avançada navegáveis; indicadores completos a 1200 px; GPU AMD com temperatura real; CPU sem temperatura identificada como indisponível; bateria sem leitura. Não confirma identificação correta de ausência física da bateria. |
| Gestor de Tarefas | PASS leitura | Listagem real, PID e métricas atualizadas, ações protegidas preservadas. Nenhum processo terminado neste ensaio. |
| MATRIX local | PASS limitado | Seleção Local e resposta real à pergunta sintética, explicitando ausência de transmissão e falta de resposta pronta. Não é aprovação de qualidade para todas as perguntas. |
| MATRIX online | NOT TESTED pelo agente | Respostas Groq de interação humana estavam visíveis; não foram produzidas nem medidas como teste online desta execução. |
| Minimizar/segunda abertura | PASS | Restauro visível com o mesmo processo principal; sem segunda instância persistente. |
| Fechar janela/reabrir | PASS | Fecho escondeu a janela mantendo serviço/API; abrir o executável restaurou a aplicação. |
| Duplo clique tray | NOT TESTED confirmado | O proprietário confirmou que saiu pela tray, mas não confirmou separadamente o duplo clique. A ferramenta não expôs a área de notificações. |
| Sair pela tray | PASS assistido | Proprietário executou Sair; log registou confirmação e shutdown; consulta independente encontrou zero processos do produto/descendentes e zero listeners na porta 4000. |
| Novo arranque | PASS | Aplicação abriu, sessão e histórico preservados, quatro motores ativos. |
| SQLite após utilização | PASS | 13 cópias frias adicionais: quick_check ok e esquema inalterado. Não implica igualdade dos dados: ensaios acrescentaram histórico e conta sintética. |
| Autostart | PASS registo/persistência | UI criou a entrada real HKCU, reabertura releu-a; opção reposta desligada e ausência de entrada conferida. |
| Autostart após desligar e ligar | PASS observado pelo proprietário | O CyberSafe iniciou automaticamente na RC1 78aff29, build 20261103-211257, Electron 33.4.11. |
| Updater instalado A→B | NOT TESTED | Sem segunda instalação ou ativação de produção; resultados laboratoriais/CI anteriores preservados. |
| Reparação/desinstalação/rollback | NOT TESTED | Instalação pessoal atual preservada; não repetidos como se fossem ensaios descartáveis. |

## Scanner e ClamAV: medições e problemas abertos

O serviço registou 44350 ms (44 s na interface); controlador externo mediu 45305 ms, incluindo espera/polling. O ensaio não é comparável ao histórico de 594 segundos: corpus e condições diferentes. Não demonstra análise completa em cinco minutos.

Foram recolhidas seis amostras de dois processos ClamAV cuja linha de comando continha a raiz da fixture. Working Set máximo observado: 1006940160 bytes. CPU cumulativa observada: pelo menos 11546,875 ms nos dois processos. Ambos reconciliados ausentes pela identidade PID/criação após o ensaio. A amostragem não cobre o processo do conteúdo ZIP extraído, todos os intervalos ou o consumo total do Scanner. Não se confunde CPU cumulativa com duração total.

Durante a sessão existia atividade ClamAV de monitorização em paralelo. Não foi provocado stress pesado nem alterada a cobertura. O histórico persistente guarda contadores e duração, mas não disponibilizou decomposição completa por motor deste ensaio. Continua necessária instrumentação observável do runtime instalado para separar espera do arbiter, carregamento de assinaturas, análise, arquivo e concorrência do tempo real.

O estado observado reportou 1497 rejeições e 1093 caminhos distintos afetados em Temp, três sinais do watcher e 67 callbacks sem nome. Estes números não provam perda definitiva de todos esses ficheiros nem recuperação integral. Após novo arranque o aviso de perdas não estava inicialmente presente; reiniciar não reconstitui evidência de cobertura da sessão anterior.

O Dashboard manteve o resumo anterior enquanto já existia análise nova no serviço; após remontagem/reabertura mostrou o ensaio correto. O código consulta o resumo por montagem/ligação, sem invalidar pela conclusão de análise. É uma pendência de atualização do resumo, não perda do histórico. Não foi alterado o artefacto aprovado para corrigir esta diferença.

## Evidência privada e próximos gates

Os ficheiros locais em output/windows-real-validation contêm sumários sanitizados, ponteiro do backup, estado após saída, persistência/autostart, amostragem e captura do PC Center. Logs, observações completas e cópias SQLite ficam no diretório privado de backup; não publicar esse conteúdo nem credenciais.

1. Corrigir e testar a invalidação do resumo do Dashboard numa próxima iteração; novo artefacto requer o processo de aprovação aplicável.
2. Medir Scanner/ClamAV com decomposição completa e corpus comparável antes de concluir sobre os 594 segundos; investigar rejeições do watcher sem esconder contadores.
3. Confirmar manualmente duplo clique na tray e repetir autostart quando existir uma nova candidata autorizada.
4. Executar atualização A→B, recuperação, reparação e desinstalação em ambiente adequado e autorizado; não inferir a partir do CI.
5. Obter identidade Authenticode legítima e aprovação da confiança Ed25519 antes de ativar produção. Não foram criadas chaves, certificados, tags ou Release.

Veredito: PASS para instalação e utilização inicial limitada; NO-GO para declarar validação final integral ou atualizações de produção. A aplicação permanece instalada e utilizável como candidata LAB.
