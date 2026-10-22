# CyberSafe Assistant

Aplicação desktop de segurança para Windows que reúne análise de ficheiros, monitorização
do sistema e explicação de risco num único painel. Está a ser desenvolvida no âmbito do
Projeto de Aptidão Profissional (PAP), com entrega de progresso a 23/10/2026 e entrega
final e apresentação ao júri a 31/10/2026. A entrega de 23/10 é dirigida ao professor.

É uma ferramenta **educacional e de monitorização**. Não substitui um antivírus comercial
nem o Windows Defender, e não deve ser apresentada como proteção completa.

## Porquê este projeto

Quem suspeita de um ficheiro ou nota o computador lento costuma saltar entre vários
programas: um para analisar o ficheiro, outro para ver processos, outro para ler CPU e
memória, e nenhum explica o resultado em linguagem simples. O CyberSafe Assistant parte
dessa observação e tenta responder a uma pergunta concreta: **é possível juntar essas
leituras num só sítio, locais e sem privilégios alargados, e explicar o risco de forma
compreensível?**

Daí vêm três decisões que atravessam o projeto:

- **Várias fontes de análise, um veredicto.** Heurísticas próprias, regras YARA, ClamAV e
  VirusTotal (os dois últimos opcionais) contribuem para uma pontuação de risco que mostra
  os fatores que a fizeram subir, em vez de um número sem justificação.
- **Leituras reais em vez de valores decorativos.** A intenção é apresentar a origem e a
  disponibilidade dos dados. Nas métricas por processo ainda existem zeros ambíguos,
  identificados como limitação a corrigir, e não como medições confirmadas.
- **Testes com dados separados.** A validação Windows usou um modo específico de leitura,
  com perfil e base de dados próprios. Nesse modo, terminar processos e outras alterações
  são recusados antes de executar a operação. A aplicação tem outros modos e ações; esta
  restrição descreve a sessão controlada, não uma garantia global do produto.

## O que a aplicação faz

### Análise de ficheiros e pastas

- Análise rápida, profunda ou personalizada de um ficheiro, de uma pasta ou de zonas do
  computador; ficheiros ZIP são inspecionados pelo conteúdo e não apenas pelo nome.
- Heurísticas próprias e regras YARA executadas no serviço local; ClamAV e VirusTotal são
  motores externos opcionais.
- Segunda opinião de um motor nativo em C++ (`scan-engine.exe`), quando compilado: calcula
  SHA-256, entropia, características do formato PE e uma pontuação própria, que o serviço
  integra no resultado.
- Quarentena dos ficheiros considerados perigosos, com registo do que foi movido e porquê.
- Cancelamento de uma análise em curso, com o resultado parcial marcado como incompleto em
  vez de apresentado como definitivo.

### Monitorização do sistema

- Painel com CPU, memória, discos e rede lidos do sistema, cada um com o seu estado.
- Gestor de tarefas, usado em modo de leitura na validação: lista processos, permite pesquisar e mostra quais pertencem
  à própria aplicação.
- Estado da proteção lido como booleano a partir do serviço, sem inferência a partir de
  texto na interface.
- Monitorização de unidades USB: quando ligada, o serviço pede a análise das unidades
  ligadas depois de si, uma de cada vez; não bloqueia nem ejeta.
- Vigilância de pastas para análise automática de ficheiros novos, quando ativada.

### Painel, histórico e assistente

- Painel com o risco atual, os fatores que o compõem e o histórico de análises.
- MATRIX, assistente para perguntas sobre o estado da aplicação. Quando está configurado para responder online, o texto é enviado para
  um fornecedor externo compatível com a API OpenAI (por omissão, Groq, com o modelo
  `openai/gpt-oss-120b`); não devem ser introduzidos dados pessoais.
- Extensão de navegador (Manifest V3) para monitorização de downloads.
- Cinco identidades visuais e modo claro/escuro, com os mesmos componentes em toda a
  aplicação.

## Estado atual (22/10/2026)

- A aplicação **funciona em modo de desenvolvimento** e foi observada numa sessão manual
  com perfil isolado: login, arranque, Painel, PC Center, Gestor de Tarefas, CPU, memória,
  discos, rede e processos.
- A **candidata de instalação de 21/10 foi gerada e verificada estaticamente**, mas nunca
  foi instalada nem executada. Uma candidata gerada não é um produto validado.
- A instalação neste computador de desenvolvimento está **bloqueada por conflitos de identidade e de dados com a instalação existente**; a validação do produto empacotado continua por fazer.
- A candidata **não está assinada** (Authenticode).

## Arquitetura

Monorepo npm com nove pacotes em `packages/*`:

| Pacote | Papel |
|---|---|
| `packages/app` | Interface React (Vite + Tailwind CSS) consumida pelo desktop |
| `packages/desktop` | Shell Electron, pré-carregamento, IPC e bandeja do sistema |
| `packages/service` | Serviço local Node.js: orquestra análises, quarentena, monitorização e histórico |
| `packages/core` | Motor de análise: heurísticas, YARA-X, ClamAV, VirusTotal, pontuação e quarentena |
| `packages/api` | API REST (Express + SQLite): autenticação, painel e assistente |
| `packages/native-windows` | Providers Windows para processos, hardware e estado do sistema |
| `packages/native-engine` | Executável C++17/CMake: SHA-256, entropia e análise PE |
| `packages/shared-types` | Tipos TypeScript partilhados pelos pacotes |
| `packages/extension` | Extensão de navegador (Manifest V3) para monitorização de downloads |

`packages/manual-retest` contém documentação de sessões de teste; não é um pacote
executável.

```
Renderer (React)
    │  IPC pelo preload (contextIsolation)
Electron main
    │  named pipe do serviço
Serviço Node.js (@cybersafe/service)
    ├── @cybersafe/core (heurísticas, YARA-X, ClamAV, VirusTotal, quarentena)
    ├── @cybersafe/native-windows (providers Windows)
    └── NativeEngineBridge ── scan-engine.exe (C++, opcional)

API REST (Express + SQLite) ── autenticação, painel, assistente
```

O renderer não tem acesso direto ao Node.js nem ao sistema de ficheiros. As operações
privilegiadas passam pelo preload e pelo processo principal do Electron; autenticação e
MATRIX também comunicam por HTTP com a API local. A ponte para o motor nativo
(`NativeEngineBridge`) procura o executável no pacote ou na árvore de desenvolvimento,
expõe o estado do motor ao painel de saúde e devolve o resultado em JSON; se o binário não
existir, a análise continua apenas com o motor TypeScript.

## Requisitos

- **Windows 10/11 x64** — a monitorização, o serviço e a bandeja são específicos de Windows.
- **Node.js 20 ou superior** e **npm** (o repositório usa npm workspaces).
- **Electron 33.4.11** — versão fixada no pacote `@cybersafe/desktop`.
- **CMake** apenas para compilar o motor nativo C++ (opcional).
- **ClamAV** é um motor externo opcional; as regras YARA são definições locais carregadas
  pelo `@litko/yara-x`. Nenhum destes componentes é substituído por código do repositório.

## Como executar (execução limitada)

Instalar dependências na raiz:

```bash
npm install
```

Para ver e avaliar a interface, sem serviço, bridge ou Electron:

```bash
npm run dev:app
```

Este modo serve apenas o frontend. Não prova leituras do sistema, IPC, proteção, análises
nem qualquer comportamento do produto empacotado.

O repositório inclui um runner de isolamento cujo modo por omissão é **dry-run**: mostra o
plano sem arrancar processos.

```bash
node scripts/dev-isolated-run.mjs
```

O dry-run não é uma receita de arranque validada. O modo `--start` não é apresentado aqui
como receita: sem JWT e sem modo read-only validados, pode iniciar outra sessão. Uma sessão
Windows read-only validada exige ferramentas externas ao repositório, ainda não publicadas.

Não uses `npm run dev` como caminho normal de desenvolvimento: lança serviço, API, app e
desktop com `concurrently` contra as portas e o perfil normais, e a guarda de isolamento
recusa a porta 4000. Fica reservado a quem conhece o perfil que está a usar.

A criação da conta de desenvolvimento exige uma base de dados e uma raiz isoladas, num
procedimento externo. Não é documentada aqui como comando, e não existe credencial por
omissão.

### Comandos úteis

| Comando | Efeito |
|---|---|
| `npm run dev:app` | Apenas o frontend Vite, sem bridge nem serviço |
| `npm run build:all` | Build ordenado dos pacotes |
| `npm run typecheck` | Typecheck em todos os workspaces |
| `npm test -w @cybersafe/app` | Testes do frontend |
| `npm test -w @cybersafe/service` | Testes do serviço (inclui build) |
| `npm test -w api` | Testes da API (inclui build) |
| `npm run build:native` | Compila o motor C++ com CMake |
| `npm run test:native` | Vetores de hash do motor nativo |

Não existe um `npm test` na raiz: os testes correm por workspace. Alguns testes de serviço
e de core exigem build prévio e demoram mais.

### Empacotamento

O pipeline vive em `scripts/package-windows.mjs` e usa `electron-builder` com alvo NSIS x64:

```bash
# Verificações, sem produzir instalador
node scripts/package-windows.mjs --check

# Candidata com identificador próprio, sem sobrescrever releases anteriores
node scripts/package-windows.mjs --candidate
```

A candidata é escrita numa pasta `release/candidate-<AAAAMMDD-HHMMSS>-<8 hex>`. O processo
não assina o executável (não há certificado configurado) e não instala nada.

## Verificação já feita

- Sessão manual em desenvolvimento com 19 ciclos de leitura, prontidão em 2 890 ms e
  navegação por Painel, PC Center, Gestor de Tarefas e Configurações.
- Lotes de testes focados: prontidão de arranque 62/62, acessibilidade dos gráficos de
  telemetria 90/90 e painel de Atualizações 55/55, com `tsc -b` sem erros nos respetivos
  lotes.
- Validação estática da candidata de 21/10: identidade do pacote com 12 PASS, 0 FAIL e três
  incógnitas declaradas (publisher, ícone embutido no PE e processos filhos em runtime);
  motores externos coerentes com a fonte; 171 650 785 bytes e SHA-256
  `1c0648d557b74fc79ba5137a5cb58ee1212c362715ea7c7f38cff79e6eecb1f3`.

## Limites conhecidos

Nas métricas de CPU e RAM por processo, alguns zeros ainda não distinguem uma medição
real de um valor sem leitura. Esta limitação não deve ser confundida com os estados de
disponibilidade das leituras globais.


- A aplicação não é um antivírus completo: não tem camadas de kernel, reputação massiva nem
  equipa de resposta, e não substitui o Windows Defender.
- O produto **empacotado** não foi instalado nem executado. Instalação, primeira execução,
  arranque e comportamento do pacote continuam por provar.
- Não há atualização real demonstrada: descoberta, download, verificação, instalação e
  rollback a partir de um feed continuam por fazer.
- Utilização de GPU, temperaturas e SMART não estão comprovadas; na amostra observada, a
  temperatura apareceu como indisponível.
- Uma resposta válida do assistente a partir do fornecedor externo não foi demonstrada
  nesta entrega.
- O modo empacotado não é testável com a guarda de leitura de desenvolvimento ligada: essa
  guarda exige `!isPackaged` e reserva o teste para um ambiente isolado.
- A interface foi observada em sessão manual, mas não houve revisão de acessibilidade em
  runtime nem leitura por um leitor de ecrã real.
- A candidata está **NotSigned**; SmartScreen e confiança do utilizador ficam por resolver.
- A entrega não inclui capturas de ecrã. Nenhuma foi inventada e nenhuma foi publicada sem
  sanitização.

## Próximos objetivos

1. **Validar a instalação** num ambiente isolado e registar primeira execução, arranque,
   login e leituras reais; neste computador a instalação está bloqueada por colisões de
   host.
2. **Retestar na interface** as correções mais recentes — painel de Atualizações e recusa de
   terminação de processos — que hoje só têm prova por testes.
3. **Fechar o empacotamento**: obter o registo completo do build, confirmar avisos e decidir
   entre assinatura digital e aceitação explícita de `NotSigned`.
4. **Atualizações reais**: ligar o painel a um feed e provar descoberta, download,
   verificação, instalação e rollback.
5. **Acessibilidade em runtime** e revisão de teclado/foco.
6. **Preparar a entrega de 31/10**: versão congelada, candidata identificada, capturas
   sanitizadas e uma declaração clara do que foi e do que não foi provado.

## Documentação

- [Arquitetura](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Progresso de 23/10](docs/PROGRESSO-20261023.md)
- [Perguntas frequentes para a entrega](docs/FAQ-ENTREGA-PROFESSOR.md)
- [Capturas: estado e requisitos](docs/screenshots/README.md)
- [Motor nativo](packages/native-engine/README.md)

## Licença

O repositório não inclui atualmente um ficheiro `LICENSE`. A utilização, cópia ou
distribuição depende de autorização do autor do projeto.
