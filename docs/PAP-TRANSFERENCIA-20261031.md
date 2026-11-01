# Transferência para a revisão do relatório PAP

**Data:** 2026-10-31
**Objetivo:** dar ao revisor do relatório o que pode ser afirmado, o que não pode, onde está a prova
e que capítulos precisam de atualização. Não substitui os oito documentos de evidência — aponta
para eles.

> **Base de código:** `MatrixChill/cybersafe-assistant` @ `212cb64c39f74f547d4ebc6c8bff7cc5bcbcdf56`
> **Candidata ensaiada:** `0.1.10-internal.pap-r5.20261031` — SHA-256 `46718BCD9C5EE712D9E4C663B81AA2FED3317E65C3799F500255D33FB6E5BD75`, 491 414 411 B, `NotSigned`, `NOT_FOR_DISTRIBUTION`

> **Âmbito deste documento — lê-lo antes de citar qualquer linha.** É um instantâneo de
> 2026-10-31 sobre a base `212cb64` (que é hoje o `main` remoto) e sobre a candidata R5. Tudo o
> que aqui aparece como «defeito» ou «pendente» descreve **essa** revisão. Desde então existem
> candidatas R6 (`0.1.10-internal.pap-r6.20261031`, preservada, não substituída) e a identidade
> canónica R7 (`0.1.11-internal.pap-r7.20261031`), com código corrigido que ainda não tem
> instalador publicado. Para o estado efetivo de hoje, a fonte é `README.md` + `CHANGELOG.md`;
> este documento não foi re-medido e não deve ser usado como prova de estado atual.

---

## 1. Factos tecnicamente comprovados

Todos com prova localizável nos oito documentos (§4).

1. **A base efetiva é** `%USERPROFILE%\.cybersafe-service\cybersafe.db`, **com 7 tabelas e sem
   chaves estrangeiras físicas.** `schema.prisma` descreve 2 tabelas, está desatualizado e **não é
   usado em runtime**; o acesso é `better-sqlite3` através de um adaptador próprio.
2. **Contas, revogações, consentimentos e resultados de treino persistem em SQLite.**
   Históricos, quarentena e políticas persistem em JSON/JSONL.
3. **Registo/login usam bcrypt custo 12 e JWT HS256 de 7 dias**, com revogação por *fingerprint*
   persistida que sobrevive ao reinício do processo.
4. **O *pipe* desktop↔serviço é autenticado**: *handshake* HMAC v2 com nonce, janela de 3 s e
   credencial de 64 hex por instalação.
5. **No ensaio de 800 ficheiros, os 2 `engine-failed` são falhas do motor nativo** (ISO de
   8,95 GB por `timeout`; `.lnk` por `output`) e os **18 inconclusivos** vêm do limite de 100 MiB —
   com o motor nativo concluído nesses casos.
6. **A quarentena isola com metadados, restaura de forma controlada e aplica política de
   confiança**; os testes de restauro e de segurança passam.

## 2. Factos que o relatório NÃO deve afirmar

| Afirmação a evitar | Porquê |
|---|---|
| «O histórico de treino é por utilizador» | `training_results.userId` fica **NULL** e a leitura é global |
| «A quarentena registe o motor que detetou» | Só `detectionReason` (regras); `engine` nunca é preenchido |
| «O `schema.prisma` é o esquema da base» | Está desatualizado e não é usado em runtime |
| «A suíte de testes está 100% verde» | **315 PASS / 1 FAIL / 0 SKIP** no conjunto dirigido; a suíte completa não foi executada |
| «O ensaio de 800 ficheiros provou que o disco está limpo» | Foi uma análise rápida com 800 considerados e 20 inconclusivos |
| «A candidata 0.1.10 é o artefacto final» | O instalador mostra «0.1.8» e o renderer identifica-se como «0.1.9» (§3) |
| «O 3D falha na VM por problema de WebGL» | O perfil desliga o 3D por contagem de CPUs; não é regressão de WebGL |
| «Os ensaios manuais de EICAR/quarentena estão provados no repositório» | Foram **comunicados**; a prova versionada é automatizada (§5) |

## 3. Lacunas de correspondência (identificadas, não escondidas)

| Lacuna | Detalhe |
|---|---|
| **Versão no código ≠ versão da candidata** | Nenhum `package.json` do repositório declara `0.1.10`: a raiz e os pacotes de serviço declaram `0.1.1`; `desktop` e `app` declaram `0.1.2`. A versão `0.1.10-internal.pap-r5.20261031` é aplicada **no empacotamento**, não está versionada no código |
| **Texto do instalador** | O primeiro ecrã mostra o literal «0.1.8»: o `electron-builder.internal.json` da 0.1.10 não tem `nsis.include`, pelo que o builder usou um `installer.nsh` antigo de 5 linhas em vez do instalador desenhado (603 linhas). O defeito é anterior à 0.1.10 |
| **Identidade no renderer** | O `resources/app/dist` empacotado é o da 0.1.9 (`version: "0.1.9-internal.pap-r4.20261030"`); o `app.getVersion()` devolve 0.1.10 — duas versões no mesmo produto |
| **Compilação/código «desconhecido»** | O painel de Atualizações só recebe `version`; a árvore de desenvolvimento não é um repositório git, logo não existe commit. Não foi inventado nenhum |
| **Páginas do instalador em inglês** | `nsis.language: "2070"` só define o LCID do VERSIONINFO; a UI é multi-língua e segue a língua do Windows (inglesa na VM) |
| **Proveniência da candidata** | A pasta da 0.1.10 não tem `SOURCE-FREEZE.json` nem `SOURCE-APPROVAL.json`; a proveniência foi herdada por referência |
| **Evidência bruta não versionada** | `raw/` (cópias de bases reais) e `logs/` (caminhos com o perfil local) ficam fora do repositório. Digests em `PAP-EVIDENCIAS-TECNICAS/EVIDENCIAS-LOCAIS.sha256` |

Nenhuma destas lacunas é um defeito de produto: o delta de código da 0.1.10 face à 0.1.9 são dois
ficheiros (`resources/app/dist/main.js` e `resources/app/package.json`).

## 4. Referência dos oito documentos

| Documento | O que sustenta |
|---|---|
| `PAP-EVIDENCIAS-TECNICAS/MATRIZ-EVIDENCIAS-PROFESSOR.md` | Visão de conjunto: 19 observações com natureza da prova e estado |
| `.../ESQUEMA-REAL-SQLITE.md` | Esquema real, DDL, relações lógicas, divergência com `schema.prisma` |
| `.../DICIONARIO-DE-DADOS.md` | Colunas, nulabilidade, índices e regras de escrita |
| `.../MATRIZ-PERSISTENCIA.md` | O que persiste, onde e em que formato |
| `.../AUTENTICACAO-E-COMUNICACAO.md` | Registo, login, JWT, revogação, autenticação do *pipe* |
| `.../TREINO-ESTADO-REAL.md` | Gravação/leitura de treino e a limitação do `userId` nulo |
| `.../MOTORES-E-INCONCLUSIVOS.md` | Quatro motores, atribuição de deteções, os 18 inconclusivos |
| `.../TESTES-AUTOMATICOS-VERIFICADOS.md` | Comandos, logs, 315 PASS / 1 FAIL / 0 SKIP |

Índice e regras de leitura: `PAP-EVIDENCIAS-TECNICAS/README.md`.

## 5. Ensaios manuais: comunicado vs verificado

| Ensaio | Comunicado | Verificado no repositório |
|---|---|---|
| EICAR detetado e isolado | Sim | Testes automatizados de EICAR (YARA, hashes, ClamAV); **sem** log da execução manual |
| Restauro a partir da quarentena | Sim | `service-r5-quarantine-restore-result` 5/5, `core-quarantine-restore-safety` 6/6 |
| Persistência após reinício | Sim | `auth-session-restart` 1/1, `r6-l11-persistence` 5/5, `r7-l3-history` 17/17 |
| Encerramento sem `Object has been destroyed` | Sim | Correção `isDestroyed()` em `cancel()`/`dispose()`; suíte desktop 597/597 reportada na lane de empacotamento |
| Efeitos 3D na VM | Observado ausente | Causa no código: `gpu = webgl && !lowPower`; com ≤4 CPUs lógicas e perfil `auto`, o `CoreScene` não é montado |

## 6. Testes: esta ronda vs histórico

- **Nesta ronda (2026-10-31, fecho documental) não foi executado nenhum teste.** As alterações são
  exclusivamente de documentação (`README.md`, `docs/`, `PAP-EVIDENCIAS-TECNICAS/`), sem tocar em
  código, configuração de build ou testes.
- **Os resultados são históricos e datados.** O conjunto dirigido de **315 PASS / 1 FAIL / 0 SKIP em
  316 testes** foi executado no clone de `212cb64` em 2026-10-31 e está registado em
  `TESTES-AUTOMATICOS-VERIFICADOS.md` com os comandos e os logs.
- **Nesta ronda foi feita uma verificação de integridade dos números**, não uma reexecução: os 17
  logs com bloco de resumo TAP foram relidos e o total foi recalculado. A tabela do §3 somava 312,
  não 315 — os 3 testes que passam no ficheiro parcialmente falhado (`threat-history-storage`) não
  estavam contabilizados. O documento foi corrigido com a decomposição explícita; o valor
  **315 PASS / 1 FAIL / 0 SKIP** mantém-se.
- **O FAIL está classificado, não escondido:** `critical (hash registado numa base de teste) entra
  em this.threats` espera `size === 1` e obtém `4`, porque `SignatureDatabase.load` repõe os
  *built-ins* em falta (`ensureOfflineCoverage`) — comportamento intencional do produto. É uma
  expectativa de teste desatualizada, não uma falha de persistência.

## 7. Capítulos do relatório que precisam de atualização

Referência ao `docs/relatorio PAP/Relatorio_PAP_CyberSafe_LIVE.docx` (**não alterado** nesta tarefa).

| Capítulo | Atualização necessária |
|---|---|
| Nota de revisão e âmbito | Declarar a candidata 0.1.10 e a lacuna de versão (§3), e que a suíte completa não foi executada |
| 3.11.3 Quarentena | Registar que o motor não é persistido na quarentena (limitação real) |
| 3.13.2 Autenticação e conta | Precisar SQLite + bcrypt 12 + JWT HS256 7 dias + revogação persistida; e que o treino não é por utilizador |
| 3.14.1 Estratégia de testes e níveis de evidência | Distinguir código, teste, base real e ensaio manual (regra dos oito documentos) |
| 3.14.3 Estado atual das funcionalidades | Alinhar com o estado por área dos oito documentos |
| 3.14.4 Evidências técnicas principais | Apontar para `PAP-EVIDENCIAS-TECNICAS/` e registar 315/1/0 |
| 3.14.5 e 3.15.13 ClamAV | Manter o gate de escrita e a saúde pegajosa; não declarar motor ativo sem base carregada |
| 3.15.9 Gestor de Tarefas | Uniformizar: terminação **individual** com confirmação e proteção de processos do sistema/CyberSafe; indisponível em modo de leitura |
| 3.17 Limitações atuais | Acrescentar: treino sem `userId`, quarentena sem motor, `schema.prisma` morto, suíte não integral, 3D na VM |
| 3.19.4 Empacotamento e entrega | Registar os defeitos da 0.1.10 (texto 0.1.8, renderer 0.1.9, build/commit desconhecidos) e a necessidade de uma candidata seguinte |
| 3.15.1 Ecrã preto no Electron | Sem alteração de facto; a correção do ciclo de vida é outra (`Object has been destroyed`) |
| Anexo E — Checklist antes da entrega final | Marcar «candidata final instalada e verificada em VM» como **pendente** |

## 8. Estado final do fecho documental

| Item | Estado |
|---|---|
| Oito documentos presentes e revistos | **Feito** — sem segredos, sem dados pessoais, sem caminhos absolutos |
| Integridade dos números de teste | **Corrigida e auditável** (§6) |
| README atualizado (curso, candidata, Gestor de Tarefas, ensaios, 3D) | **Feito** |
| Documentação técnica integrada | **Feito** — índice em `docs/README.md` e `PAP-EVIDENCIAS-TECNICAS/README.md` |
| Código, arquitetura e testes alterados | **Não** — nenhuma alteração de produto |
| DOCX canónico do relatório | **Não alterado** (fora do âmbito desta tarefa) |
| Candidata final para a PAP | **Pendente** — a 0.1.10 está `BLOCKED_WITH_EVIDENCE` por defeitos de empacotamento |
| Publicação de instaladores/bases/releases | **Não** — nada foi publicado |

**Conclusão:** o repositório fica tecnicamente coerente com a evidência recolhida e sustenta o
relatório nos factos do §1. O que resta não é documental — é a candidata de empacotamento e a
validação final em VM, que continuam pendentes e estão declaradas como tal.
