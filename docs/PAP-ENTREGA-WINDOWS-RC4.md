# CyberSafe Assistant — entrega técnica da PAP

## Artefacto e execução

A edição académica é a pré-release Windows x64 0.2.0-rc.4, commit 8e4d7687944f100c20a0481729ea8c857989ebac. [Release e Setup Orbital B](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/v0.2.0-rc.4). O download público foi verificado com 279.340.203 bytes e SHA-256 5ee8375e7ba8d1427933a6f6fb52d6222425dee74a01f46119639774eb1176bc. A instalação é manual e o Setup está sem Authenticode. O backup frio da instalação anterior foi preservado localmente.

## Arquitetura e funcionalidades

A interface React/TypeScript corre no renderer Electron. A bridge de preload liga a interface ao processo principal. O desktop coordena janela, tray e ciclo de vida; comunica com o serviço Windows por named pipe autenticado. A API Node/Express em loopback trata sessões, treino e consentimento. SQLite guarda dados estruturados; histórico e quarentena têm armazenamento local próprio. O serviço coordena análise manual, watcher, políticas e telemetria. O core agrega ClamAV, YARA clássico, HashDB e motor nativo C++ com estados explícitos de inconclusivo. MATRIX combina informação local com um fornecedor opcional sujeito a consentimento. O Orbital B Win32 apresenta o fluxo de instalação executado por NSIS.

## Aceitação física RC4

| Percurso | Resultado e fonte |
| --- | --- |
| Instalação e abertura | Orbital B exit 0, Registo RC4 e app.asar igual ao payload. Abertura confirmada pelo proprietário. |
| Scanner | Proprietário confirmou 3/3 benignos, 0 falhas, 0 inconclusivos, cerca de 13 s. Amostra funcional, sem extrapolação de desempenho. |
| Histórico e Dashboard | Proprietário confirmou a entrada e atualização de «Última análise». |
| MATRIX, PC Center e Gestor de Tarefas | Proprietário confirmou respostas, métricas e funcionamento das vistas. A origem das respostas MATRIX observadas não foi capturada. |
| SQLite e encerramento | 13/13 quick_check em modo só de leitura a frio, incluindo SharedStorage. Sem reduções nas contagens comparadas com o backup, processos remanescentes observados ou listener na porta 4000. |
| Tray | Saída normal confirmada pelo estado posterior dos processos. Duplo clique não tem confirmação individual nesta evidência. |

## Timeout ClamAV e limites

O proprietário observou degradação transitória por timeout e recuperação posterior para Ativo. A mensagem prevista é «Um scan do ClamAV excedeu o tempo limite e foi terminado.» A execução física não deixou uma transcrição identificada nem informação suficiente para atribuir causa, tipo de operação ou orçamento. Nesta revisão, 19 testes dirigidos de contrato e recuperação passaram. A fixture reproduz timeout seguido de recuperação com veredicto válido e confirma que abortos, falha de arranque ou veredictos ausentes não recuperam indevidamente. O incidente físico não foi reproduzido e não motivou alteração do Scanner.

O watcher emitiu um sinal de perda; a cobertura integral não está confirmada. O WFP não estava provisionado neste perfil. A origem local e a do fornecedor MATRIX têm rótulos distintos no código; a resposta online na RC4 não foi verificada. O updater está implementado e desativado em produção. Passaram 164 testes de componentes e cinco de handoff LAB. Não houve atualização instalada A→B pelo GitHub. A edição académica não substitui o Defender.

## Respostas às observações do professor

| Ponto | Evidência disponível |
| --- | --- |
| EICAR | Ensaios automatizados históricos para YARA, hashes e ClamAV. O ensaio manual foi comunicado, mas o log não foi localizado. O teste benigno RC4 não prova deteção EICAR. |
| Quarentena e restauro | Suítes históricas de restauro 5/5 e segurança 6/6. O percurso EICAR → isolamento → restauro na RC4 instalada não foi demonstrado. |
| Números | Separar os 3 ficheiros RC4 do ensaio histórico de 800 considerados, com 18 inconclusivos por cobertura e 2 falhas do motor nativo. Os 315 PASS e 1 FAIL dizem respeito ao conjunto dirigido de 31/10, não à suíte completa ou à RC4. |
| training_results | A rota atual grava o resultado sem userId e consulta o histórico global. O contrato efetivo é SQLite em db.ts. Não descrever resultados por conta. |
| Usabilidade | A confirmação do proprietário é aceitação funcional. Não foi localizada evidência de um estudo com participantes, protocolo e resultados. |

A [matriz histórica do professor](../PAP-EVIDENCIAS-TECNICAS/MATRIZ-EVIDENCIAS-PROFESSOR.md) separa código, testes e observação real. Caso a escola exija ensaio manual EICAR/restauro ou estudo de usabilidade, é necessário anexar evidência real ou executar o ensaio exigido. A obrigatoriedade formal não está estabelecida pela matriz técnica consultada.

## Capturas e defesa

As capturas locais em output/windows-real-validation (setup-before.png e pc-center-installed.png) pertencem a uma validação anterior. Usar apenas com essa legenda e após revisão de dados pessoais. Para ilustrar a RC4, captar durante a defesa o Dashboard, o Scanner com pasta sintética, o Histórico e o PC Center. Não incluir credenciais, lista pessoal de processos nem caminhos privados.

1. Mostrar a release pública, a versão e a verificação do hash.
2. Abrir a RC4 já instalada. Explicar o Dashboard e a distinção entre disponibilidade do motor e cobertura.
3. Analisar três ficheiros benignos preparados para a defesa. Mostrar a contagem real, a entrada de histórico e «Última análise».
4. Mostrar o PC Center e o Gestor de Tarefas em modo de consulta. No MATRIX usar uma pergunta local sintética e indicar a origem apresentada.
5. Explicar EICAR e restauro com a evidência automatizada, e encerrar normalmente pela tray. Fechar com os limites e com a distinção entre pré-release manual e atualizador de produção.
