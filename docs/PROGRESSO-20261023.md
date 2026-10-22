# Progresso do CyberSafe Assistant — 23/10/2026

**Documento preparado a 21/10/2026 para o marco de progresso de 23/10/2026; revisto a
22/10/2026 para o pacote final de documentação.**
Não houve nova execução: os dados são um instantâneo de 21/10/2026 e não foram atualizados depois.

| Campo | Valor |
|---|---|
| Projeto | CyberSafe Assistant (PAP) |
| Marco | 23/10 — progresso; 31/10 — entrega final |
| Âmbito | Documentação de evidência. Nenhum ficheiro de produto alterado |
| Estado global | Progresso real, com gates humanos e de host ainda abertos |

### Nota de leitura (júri)

- **Os números são de 21/10/2026.** Foram medidos nessa sessão e não foram repetidos para este
  documento; não há valores atualizados nem estimados.
- **Cada linha distingue prova de intenção.** «Observado», «testes verdes», «validado
  estaticamente» e «integrado» não são sinónimos neste documento.
- **As referências do índice (§10) são etiquetas internas de evidência.** Apontam para a área de
  integração preservada fora do Git; não são diretórios nem downloads desta entrega pública.
- **Uma candidata não é uma instalação.** O setup de 21/10 foi gerado e verificado estaticamente;
  nunca foi instalado nem executado.
- **Não há capturas.** As capturas humanas da sessão m1b não foram recebidas; nenhuma imagem foi selecionada para publicação. A lacuna está
  declarada e não foi preenchida com material antigo.

## 1. Resumo executivo

1. **A aplicação em DEV funciona e foi observada por um utilizador.** Login, arranque, Painel,
   PC Center, Gestor de Tarefas, CPU, RAM, discos, rede e processos têm prova humana correlacionada
   com uma sessão técnica de 19 ciclos.
2. **A candidata de instalação de 21/10 foi gerada e validada estaticamente, mas não foi instalada
   nem executada.** Gerar um setup não é validar um produto instalado.
3. **Três correções entraram desde 16/10:** prontidão de arranque baseada em factos, acessibilidade
   dos gráficos de telemetria e o bloqueio permanente do painel de Atualizações. O arranque foi
   confirmado visualmente pelo utilizador (m1b); das correções posteriores, o updater e o P0A rev2
   continuam sem reteste de GUI.
4. **A reserva de 16/10 está preservada byte a byte.** A candidata 151509 (16/10) mantém o gate
   humano pendente e não herdou nem transferiu resultados.
5. **O caminho para 31/10 está bloqueado num ponto concreto:** o pacote/instalação está
   `BLOCKED_HOST` por 9 colisões de host. Não se pede uma VM; o trabalho continua em DEV isolado.
   Sem resolver essas colisões, não há validação de instalação.

## 2. Cronologia: de 16/10 a 21/10

| Data | Entrega | Estado |
|---|---|---|
| 16/10 | Reserva `135401` e candidata `151509`, relatório de reteste manual | Preservadas; 151509 sem gate humano transferido |
| 18–19/10 | Camada de isolamento de DEV, runner bounded e provas de runtime | Integrada; runner externo ao Git |
| 20/10 | A4 (canário YARA read-only) e A5 (resumo de cancelamento e observabilidade) | A4 positivo em GUI (R2); A5 com dois cancelamentos em GUI (R4) e relato humano; escopo limitado |
| 20–21/10 | P0A rev2 — recusa de kill pela fronteira Windows read-only | Integrado em U; candidata contém o literal do patch; GUI pendente |
| 21/10 | Prontidão de arranque (Boot) e acessibilidade dos sparklines | Boot confirmado visualmente pelo utilizador; testes 62/62; leitor de ecrã pendente |
| 21/10 | Correção terminal do painel de Atualizações | Integrada; 55/55 testes; runtime pendente |
| 21/10 | Candidata `20261021-223423-21a34fcd` | Gerada; não instalada, não executada |
| 21/10 | Validação estática da candidata, gate de segredos e inputs de packaging | Concluída com limites declarados |

## 3. Prova humana (sessão de 21/10)

Sessão manual assistida, com perfil temporário, pipe própria e encerramento por prazo. O freeze de
U ficou inalterado. Isto é evidência da sessão, não uma garantia geral de que qualquer arranque
local fique isolado do perfil pessoal.

| Evidência | Resultado |
|---|---|
| Janela DEV | `CyberSafe Assistant - Painel de Segurança`, arrancada após API, renderer e pipe |
| Prontidão | **2 890 ms** |
| Ciclos de leitura | **19**, cadência de 20 s; máximo de 814 ms por ciclo |
| Navegação humana | Login, Painel, Scanner (página aberta, sem scan), Monitor, PC Center, Gestor de Tarefas, Configurações |
| CPU / RAM | CPU `available`; RAM medida a **68 %**, `available` |
| Discos | Quatro discos lidos: **82 %, 64 %, 0 %, 60 %** |
| Processos | **374** em cada uma de duas enumerações; **26/26 PIDs próprios** marcados |
| Proteção | `protectionEnabled: false` em todos os ciclos, lido como booleano |
| Recusa read-only | `FronteiraWindowsReadOnlyError: efeito_negado_por_modo_leitura`; nenhum processo morto por esse caminho |
| Freeze do código | `380/5c2496cbde34`, inalterado antes e depois |

O relato humano confirma login, navegação, arranque rápido, Dashboard e PC Center com CPU/RAM/
discos/rede e processos reais no Gestor. Também regista observações por resolver: erro ao terminar
processo, consulta de atualizações sem fim, linguagem técnica no Monitor, zeros de CPU/RAM
ambíguos e saúde a 100 % no PC Center. As capturas referidas pelo utilizador **não foram
recebidas**; não são citadas nem reproduzidas.

## 4. Prova técnica integrada

| Lote | Testes | Build/typecheck | Limite |
|---|---|---|---|
| Prontidão de arranque | **62/62**, exit 0 | `tsc -b` exit 0 | Boot confirmado visualmente em m1b; «READY FOR MANUAL TEST» não é reteste |
| Acessibilidade dos sparklines | **90/90**, exit 0 | `tsc -b` exit 0 | SSR; leitor de ecrã real não testado |
| Painel de Atualizações | **55/55** + 25/25 vizinhos, exit 0 | `tsc -b` exit 0 | Correção posterior; GUI/runtime pendentes |
| P0A rev2 | Testes de guarda e recusa | Integrado | Correção posterior; GUI pendente |
| A4 canário YARA | Testes focados verdes | Serviço compila | Positivo em GUI (R2), escopo limitado |
| A5 cancelamento/observabilidade | Testes focados verdes | Serviço compila | Dois cancelamentos em GUI (R4) + relato humano, escopo limitado |

Os artefactos estáticos são independentes e não foram reexecutados nesta fase de documentação; os
resultados citados vêm dos lotes já revistos e integrados.

A correção do painel de Atualizações merece a nota honesta: o ciclo que prendia o painel
(`start → dispose → start`) é um comportamento de **desenvolvimento** causado pelo duplo efeito do
StrictMode, não uma regressão demonstrada em produção. A correção também introduziu um prazo
finito para a leitura inicial, que fecha o painel em erro terminal em vez de o deixar a carregar
para sempre.

## 5. Candidata de 21/10 e reserva de 16/10

### Candidata nova

| Campo | Valor |
|---|---|
| Identificador | `20261021-223423-21a34fcd` |
| Artefacto | `CyberSafe Assistant-0.1.1-candidate-20261021-223423-21a34fcd-setup.exe` |
| Tamanho | **171 650 785 bytes** |
| SHA-256 | `1c0648d557b74fc79ba5137a5cb58ee1212c362715ea7c7f38cff79e6eecb1f3` |
| Assinatura | **NotSigned** (sem certificado configurado) |
| Gate de identidade | **12 PASS, 0 FAIL**, 6 INFO, 3 UNKNOWN |
| ASAR | 17 154 245 bytes; `ea5285287ac60724041c62ab1ddc8e63472035c99dfd1ba936eb561e6e5607f` |
| Gate de segredos | 0 correspondências; **cobertura 0/0**, portanto não prova ausência de segredos |
| Estado | **Gerada, não instalada, não executada**; log completo do build não entregue |

O gate de identidade confirma nome, produto, empresa e versão 0.1.1; o serviço dentro do ASAR; o
ícone de origem; e o `scan-engine.exe` e o bundle ClamAV tratados como motores externos. As três
incógnitas declaradas são o publisher (não há assinatura), o ícone embutido no PE e os processos
filhos em runtime.

O gate de segredos comparou contra **zero** ficheiros de configuração locais: o resultado 0/0 é
vazio por cobertura, não uma prova de que a build não contém segredos.

### Reserva de 16/10

| Campo | Valor |
|---|---|
| Ficheiro | `CyberSafe Assistant-0.1.1-candidate-20261016-135401-103cf015-setup.exe` |
| Tamanho | 171 661 062 bytes |
| SHA-256 | `a840e56e4ff23834d9c5189b4cdbe0483e1aace8cf8b580e1f5145069d9f076b` |
| Estado | **Preservada, byte-idêntica ao registo** |

A reserva e a candidata nova são builds diferentes (SHA e tamanho distintos), como esperado depois
do P0A. A candidata `151509` continua separada: existe metadata de build, mas o gate humano não foi
transferido de `135401` para ela.

## 6. O que não está provado

- Instalação, primeira execução e funcionamento do produto empacotado.
- Atualização contra um feed real: descoberta, download, verificação, instalação e rollback.
- Matrix/IA online. O cliente é compatível com a API OpenAI e o modelo por omissão é
  **`openai/gpt-oss-120b`** (Groq). **Não é Llama 3.1**; o modelo anterior deixou de ser servido.
- Utilização de GPU, temperaturas e SMART. A temperatura está `unavailable` neste host.
- Scans completos pela GUI. A4 prova um canário positivo em GUI (R2) e A5 prova dois cancelamentos
  em GUI (R4), ambos em escopo limitado; a sessão m1b abriu o Scanner sem iniciar scan. Isto não é
  um scan completo nem substitui o reteste das correções posteriores.
- Reteste de GUI do updater e do P0A rev2, que são correções posteriores.
- Acessibilidade com leitor de ecrã real e revisão de teclado/foco em runtime.
- Assinatura Authenticode e reputação do instalador.
- Capturas de ecrã: não foram fornecidas capturas humanas; nenhuma foi inventada.

## 7. Segurança e governação

- **Zero escritas no repositório de produto (U)** nesta documentação. Nada foi commitado, copiado
  para U ou publicado; o acesso remoto não foi alterado.
- **Nenhum push.** O `main` remoto está em `5e61845` (5/10). O HEAD local é `090efa6`, sobre WIP
  não commitado; a árvore local não é o remoto.
- **Nenhuma credencial, chave ou caminho pessoal** é reproduzido nestes documentos.
- **O runner de GUI Windows read-only é externo ao Git.** Vive na área de integração e evidência;
  não é uma dependência do produto nem um comando prometido pelo README.
- **Curadoria do histórico:** o repositório contém histórico de bases de dados e
  checkpoints/referências de agentes, incluindo material fora do HEAD atual. A curadoria é um gate
  do Root; não se declara o histórico limpo. A auditoria tem achados restritos, sem valores
  reproduzidos aqui. Qualquer expansão de publicação ou novo push fica bloqueada até essa curadoria
  terminar.

## 8. Riscos e bloqueios

| Risco / bloqueio | Impacto | Estado |
|---|---|---|
| 9 colisões de host | Não é possível instalar e validar o setup neste host; não se pede VM | **`BLOCKED_HOST`** |
| Log completo do build não entregue | Avisos de build ficam «não confirmados», não «zero avisos» | Aberto |
| Candidata sem assinatura | SmartScreen e confiança do utilizador | Aberto |
| Gate de segredos com cobertura 0/0 | Não prova ausência de segredos na build | Limite declarado |
| Histórico por curar (DB e checkpoints) | Impede publicação/expansão de acesso | Gate do Root |
| Observações humanas por corrigir | Terminar processo, updater, linguagem do Monitor, zeros ambíguos, saúde a 100 % | Aberto |
| Updater/P0A sem reteste; acessibilidade em runtime pendente | Correções posteriores provadas apenas por testes/SSR | Aberto |

## 9. Próximos passos até 31/10

1. **Host:** resolver as 9 colisões que mantêm a instalação em `BLOCKED_HOST` e só depois instalar
   a candidata e registar primeira execução, arranque, login e leituras reais. Não pedir VM; o
   trabalho continua em DEV isolado.
2. **Reteste humano focado:** updater e P0A rev2, terminar processo, Gestor de Tarefas, linguagem
   do Monitor e estados vazios/zero. Confirmar que nenhuma correção recente regrediu.
3. **Fechar a documentação:** decidir a versão final do README, remover credenciais históricas e
   curar o histórico antes de qualquer novo push.
4. **Fechar o empacotamento:** obter o log do build, confirmar avisos e decidir sobre assinatura ou
   aceitação explícita de `NotSigned`.
5. **Preparar a entrega final:** índice de evidência, versão congelada, candidata identificada e
   declaração clara do que foi e do que não foi provado.

## 10. Índice de evidência

- `output/manual-retest/DELIVERY-20261016/` — reserva, candidata 151509 e relatório de 16/10.
- `delivery-20261023/BASELINE-16-PRESERVADA.json` — SHA e tamanho da reserva.
- `delivery-20261023/validation-candidate-20261021-223423-21a34fcd/` — validação estática,
  identidade, segredos e limites.
- `delivery-20261023/build-candidate/` — decisão de cache, hashes e handoff do build.
- `delivery-20261023/packaging-inputs/` — ClamAV 1.5.4 (47 ficheiros, 139 225 801 bytes) e
  `scan-engine.exe` (85 504 bytes, SHA `4747A040…`); gate de inputs `ok`.
- `session-windows-functional-20261021/manual-ui-readonly/` — sessão manual m1b.
- `session-windows-functional-20261021/freebuff-boot-implementation/` — prontidão de arranque.
- `session-windows-functional-20261021/freebuff-telemetry-a11y/` — acessibilidade dos sparklines.
- `session-windows-functional-20261021/post-manual-p0/TP-POSTMANUAL-P0-UPDATES-TERMINAL/` — painel
  de Atualizações.
- `task-packets/TP-RUNDEV-FINAL-20261020/` — A4, A5 e gate de integração.
- `github-progress/SECURITY-TREE-HISTORY.json` — relatório de segurança sem valores (restrito).

## 11. Declaração final

A 21/10/2026 o CyberSafe Assistant tem uma aplicação DEV funcional observada por um utilizador, uma
candidata de instalação gerada e verificada estaticamente, e testes verdes nos lotes corrigidos.
Não tem uma instalação validada, não tem atualização real provada e não tem reteste de GUI para as
correções posteriores (updater e P0A rev2) nem revisão de acessibilidade em runtime.

Para 23/10, o estado correto é **progresso demonstrável, com limites declarados**. Para 31/10, a
entrega final depende de resolver as colisões de host, do reteste humano e da curadoria do
histórico. Nenhum desses gates foi saltado ou dado como concluído por inferência.

Nota de publicação: o índice acima referencia evidência interna preservada fora do Git, não diretórios incluídos nesta entrega pública. Não expõe logs, contas ou credenciais. O júri recebe este resumo e a demonstração; capturas sanitizadas serão incluídas apenas após seleção e revisão. Nenhuma referência interna deve ser interpretada como um download público disponível.
