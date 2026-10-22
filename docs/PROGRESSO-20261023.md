# Progresso do CyberSafe Assistant — 23/10/2026

**Documento de progresso para o professor orientador.**
Preparado a 21/10/2026, com as medições de uma sessão feita nesse dia. A revisão de 22/10 é
**editorial**: reorganiza e esclarece o texto, sem nova execução e sem alterar nenhuma
medição. Os números continuam a ser o instantâneo de 21/10/2026.

| Campo | Valor |
|---|---|
| Projeto | CyberSafe Assistant (PAP) |
| Entrega de progresso | 23/10/2026 |
| Entrega final e apresentação | 31/10/2026 |
| Âmbito desta revisão | Documentação. Nenhum ficheiro de produto foi alterado |

## 1. Resumo

1. **A aplicação funciona em modo de desenvolvimento e foi usada por uma pessoa.** Login,
   arranque, Painel, PC Center, Gestor de Tarefas e leituras de CPU, memória, discos, rede e
   processos foram observados numa sessão manual, com registo técnico em paralelo.
2. **O instalador de 21/10 existe, mas nunca foi executado.** Foi gerado e verificado
   estaticamente; gerar um instalador não é validar um produto instalado.
3. **Três correções entraram desde 16/10:** prontidão de arranque baseada em factos reais,
   acessibilidade dos gráficos de telemetria e correção do painel de Atualizações, que
   deixava de carregar indefinidamente. O arranque foi confirmado visualmente; as duas
   correções mais recentes continuam à espera de reteste na interface.
4. **O trabalho anterior está preservado.** A candidata de 16/10 mantém-se byte a byte igual
   ao registo, com a respetiva impressão digital SHA-256.
5. **Há um bloqueio concreto para 31/10:** neste computador de desenvolvimento, a instalação
   colide com nove elementos já existentes no sistema. Enquanto isso não for resolvido, não
   há validação de instalação.

## 2. Como o trabalho evoluiu

- **16/10 — primeira candidata de instalação e relatório de reteste manual.** Ficou
  guardada como reserva e não foi substituída.
- **18–19/10 — isolamento do ambiente de desenvolvimento.** Passou a ser possível arrancar a
  aplicação com perfil e canal de comunicação próprios, sem tocar no perfil pessoal, e
  registar provas de execução.
- **20/10 — análise e cancelamento com prova na interface.** Um ficheiro de teste com
  assinatura YARA conhecida deu resultado positivo e dois cancelamentos de análise foram
  observados na interface. Ambos os casos têm âmbito limitado: não equivalem a uma análise
  completa do computador.
- **20–21/10 — recusa de terminação de processos.** A fronteira read-only passou a recusar o
  pedido antes de chegar ao sistema; nenhum processo foi terminado por esse caminho.
- **21/10 — arranque, acessibilidade e painel de Atualizações.** A prontidão do arranque
  deixou de depender de suposições, os gráficos de telemetria ganharam descrição acessível e
  o painel de Atualizações deixou de ficar preso a carregar.
- **21/10 — nova candidata de instalação e validação estática.** Identidade do pacote
  verificada, motores externos conferidos e limites declarados.

## 3. Sessão de validação manual (21/10/2026)

Sessão assistida, com perfil temporário, canal de comunicação próprio e encerramento por
prazo. O código em análise não foi alterado durante a sessão.

| Evidência | Resultado |
|---|---|
| Janela da aplicação | `CyberSafe Assistant - Painel de Segurança`, aberta depois da API, da interface e do serviço |
| Prontidão do arranque | **2 890 ms** |
| Ciclos de leitura | **19**, a cada 20 s; máximo de 814 ms por ciclo |
| Navegação | Login, Painel, Scanner (página aberta, sem análise iniciada), Monitor, PC Center, Gestor de Tarefas, Configurações |
| CPU e memória | CPU com estado `available`; memória medida a **68 %**, `available` |
| Discos | Quatro discos lidos: **82 %, 64 %, 0 % e 60 %** |
| Processos | **374** em cada uma de duas enumerações; **26 de 26** processos da própria aplicação identificados |
| Estado da proteção | `protectionEnabled: false` em todos os ciclos, lido como booleano |
| Recusa read-only | `efeito_negado_por_modo_leitura`; nenhum processo terminado por esse caminho |

O relato da pessoa que usou a aplicação confirma login, navegação, arranque rápido, Painel e
PC Center com valores reais. Regista também problemas por corrigir: erro ao terminar um
processo, consulta de atualizações que não terminava, linguagem demasiado técnica no
Monitor, zeros de CPU e memória ambíguos e saúde a 100 % no PC Center. As capturas
referidas nesse relato não foram entregues; não são citadas nem reproduzidas.

O valor de 0 % na lista de discos é o que foi apresentado na sessão; esta documentação
não determina se corresponde a uma medição válida ou à ausência de leitura.

## 4. Testes automáticos

| Lote | Resultado | Verificação de tipos | Limite |
|---|---|---|---|
| Prontidão de arranque | **62/62** | `tsc -b` sem erros | Arranque confirmado visualmente; falta reteste por outra pessoa |
| Acessibilidade dos gráficos | **90/90** | `tsc -b` sem erros | Testes de renderização; leitor de ecrã real não testado |
| Painel de Atualizações | **55/55** + 25/25 testes vizinhos | `tsc -b` sem erros | Correção recente; interface e execução real pendentes |
| Recusa read-only | Testes de guarda e de recusa | Integrado | Interface pendente |
| Análise com YARA | Testes focados | Serviço compila | Um ficheiro de teste positivo na interface, âmbito limitado |
| Cancelamento de análise | Testes focados | Serviço compila | Dois cancelamentos observados na interface, âmbito limitado |

Estes resultados vêm dos lotes já revistos. Não foram repetidos nesta revisão de
documentação.

Sobre o painel de Atualizações, importa ser preciso: o ciclo que o prendia
(`start → dispose → start`) é um comportamento do modo de desenvolvimento, provocado pelo
duplo efeito do StrictMode, e não uma falha demonstrada no produto instalado. A correção
introduziu também um prazo para a leitura inicial, para que o painel termine em erro claro
em vez de ficar a carregar para sempre.

## 5. Instalador de 21/10 e reserva de 16/10

### Candidata de 21/10

| Campo | Valor |
|---|---|
| Identificador | `20261021-223423-21a34fcd` |
| Ficheiro | `CyberSafe Assistant-0.1.1-candidate-20261021-223423-21a34fcd-setup.exe` |
| Tamanho | **171 650 785 bytes** |
| SHA-256 | `1c0648d557b74fc79ba5137a5cb58ee1212c362715ea7c7f38cff79e6eecb1f3` |
| Assinatura | **NotSigned** (sem certificado configurado) |
| Verificação de identidade | **12 PASS, 0 FAIL**, 6 informativos, 3 incógnitas declaradas |
| Estado | **Gerada, não instalada, não executada**; registo completo do build não entregue |

A verificação de identidade confirma nome, produto, empresa e versão 0.1.1, o serviço dentro
do pacote, o ícone de origem e a presença dos motores externos. As três incógnitas são o
publicador (não há assinatura), o ícone embutido no executável e os processos filhos em
execução.

A verificação de segredos comparou contra zero ficheiros de configuração locais: o resultado
0/0 é vazio por cobertura e **não** prova que o pacote não contém segredos.

### Reserva de 16/10

| Campo | Valor |
|---|---|
| Ficheiro | `CyberSafe Assistant-0.1.1-candidate-20261016-135401-103cf015-setup.exe` |
| Tamanho | 171 661 062 bytes |
| SHA-256 | `a840e56e4ff23834d9c5189b4cdbe0483e1aace8cf8b580e1f5145069d9f076b` |
| Estado | **Preservada, byte-idêntica ao registo** |

São dois builds diferentes, como esperado depois das correções. Os resultados de um não
foram transferidos para o outro.

## 6. O que ainda não está provado

- Instalação, primeira execução e funcionamento do produto empacotado.
- Atualização a partir de um feed real: descoberta, download, verificação, instalação e
  rollback.
- Resposta válida da MATRIX a partir do fornecedor externo nesta validação. O cliente é compatível com
  a API OpenAI e o modelo por omissão é `openai/gpt-oss-120b` (Groq); não é Llama 3.1.
- Utilização de GPU, temperaturas e SMART. A temperatura apareceu indisponível na amostra recolhida, sem provar uma limitação permanente do computador.
- Análises completas pela interface. Há um ficheiro de teste positivo e dois cancelamentos,
  todos de âmbito limitado; a sessão manual abriu o Scanner sem iniciar análise.
- Reteste na interface das correções mais recentes (painel de Atualizações e recusa de
  terminação de processos).
- Acessibilidade com leitor de ecrã real e revisão de teclado e foco em execução.
- Assinatura Authenticode e reputação do instalador.
- Capturas de ecrã: não foram fornecidas capturas humanas e nenhuma foi inventada.

## 7. Publicação e histórico do repositório

- A documentação desta entrega está publicada num **ramo próprio, criado a partir de uma
  árvore limpa** (`pap/progresso-2026-10-23`). O snapshot inicial publicado é o commit
  `6965ade`; esta revisão documental acrescenta-lhe um commit, sem alterar o código.
- O ramo `main` anterior (último commit de 5/10/2026, `5e61845`) **mantém-se como estava**:
  não foi reescrito, nem apagado, nem substituído por force push. É uma linha de histórico
  separada e não descreve o estado atual do projeto.
- Esse histórico antigo contém bases de dados e registos de trabalho que exigem curadoria
  antes de qualquer divulgação alargada. A decisão é do responsável do projeto; nada nesta
  documentação declara esse histórico limpo.
- O snapshot inicial foi publicado em 22/10. A revisão da documentação é preparada
  separadamente, sem reescrever esse commit nem alterar as permissões ou a visibilidade.

## 8. Próximos passos até 31/10

1. **Instalação.** Resolver as nove colisões que bloqueiam a instalação neste computador e,
   num ambiente isolado, instalar a candidata e registar primeira execução, arranque, login
   e leituras reais.
2. **Reteste focado na interface.** Painel de Atualizações, recusa de terminação de
   processos, Gestor de Tarefas, linguagem do Monitor e estados vazios ou a zero.
3. **Atualizações reais.** Ligar o painel a um feed e provar o ciclo completo, incluindo
   rollback.
4. **Empacotamento.** Obter o registo completo do build, confirmar avisos e decidir entre
   assinatura digital e aceitação explícita de `NotSigned`.
5. **Acessibilidade.** Revisão de teclado, foco e leitura por leitor de ecrã em execução.
6. **Entrega final de 31/10.** Versão congelada, candidata identificada, capturas
   sanitizadas e uma declaração clara do que ficou provado.

## 9. Declaração final

A 21/10/2026 o CyberSafe Assistant tem uma aplicação funcional em desenvolvimento, observada
por uma pessoa, uma candidata de instalação gerada e verificada estaticamente e testes verdes
nos lotes corrigidos. A revisão de 22/10 não repetiu medições: só organizou o relato. Não tem uma instalação validada, não tem atualização real demonstrada e
não tem reteste na interface das duas correções mais recentes.

Para 23/10, o estado correto é **progresso demonstrável, com limites declarados**. Para 31/10,
a entrega final depende de resolver as colisões de instalação, do reteste humano e da
curadoria do histórico. Nenhum destes pontos foi dado como concluído por inferência.
