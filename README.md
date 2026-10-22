# CyberSafe Assistant

O CyberSafe Assistant é uma aplicação desktop de cibersegurança para Windows, desenvolvida no
âmbito de um Projeto de Aptidão Profissional (PAP). Combina análise de ficheiros, monitorização
read-only do sistema e um painel Electron, apoiados por um serviço local que centraliza as leituras
e pelos motores de análise do projeto.

É uma ferramenta **educacional e de monitorização**. Não substitui um antivírus comercial e não
deve ser descrita como proteção completa.

## Como ler esta documentação (júri)

Este pacote documenta o **marco de progresso de 23/10/2026**. Lê-se em dois níveis: este resumo e o
[documento de progresso](docs/PROGRESSO-20261023.md), que apresenta a evidência lote a lote.

- **Cada afirmação indica o tipo de prova.** Observação humana correlacionada, teste automatizado,
  validação estática do artefacto ou apenas integração de código. São coisas diferentes e não se
  substituem: um teste verde não prova um produto instalado.
- **Uma candidata gerada não é um produto validado.** Prova que o empacotamento terminou e que o
  artefacto tem a identidade declarada. Não prova instalação, arranque, proteção nem atualização.
- **As ausências estão escritas.** Sem feed de atualização real nem resposta MATRIX online comprovada nesta sessão; utilização da GPU,
  temperaturas e SMART não comprovados; sem assinatura digital nem revisão de acessibilidade em runtime. Estão
  listadas em [O que não está provado](#o-que-não-está-provado).
- **Não há imagens neste pacote.** A entrega não inclui capturas de ecrã: nenhuma foi inventada e
  nenhuma foi publicada sem sanitização. A lacuna está declarada em
  [Capturas](docs/screenshots/README.md).
- **A demonstração é feita em DEV.** `npm run dev:app` serve apenas a interface. As leituras do
  sistema exigem o serviço e o runner externo descrito em
  [Runner externo de evidência](#runner-externo-de-evidência), que não faz parte deste repositório.

## Estado atual

O projeto encontra-se em desenvolvimento ativo. A entrega está organizada em dois marcos:
**23/10/2026 — ponto de progresso** e **31/10/2026 — entrega final**.

Documento revisto a **22/10/2026** para integração. Não houve nova execução: os dados continuam a
ser o instantâneo de 21/10/2026.

| Item | Estado a 21/10/2026 (revisto a 22/10/2026) |
|---|---|
| Aplicação em modo de desenvolvimento (DEV) | Sessão manual observada: login, arranque, Painel, PC Center, Gestor de Tarefas, leituras de CPU, RAM, discos, rede e processos |
| Candidata de instalação de 21/10 | **Gerada e validada estaticamente; nunca instalada nem executada** |
| Reserva de 16/10 | Preservada byte a byte, com SHA-256 registado |
| Candidata 151509 (16/10) | Candidata separada; o gate humano continua pendente e não foi transferido |
| Correção do painel de Atualizações | Integrada; 55/55 testes focados passaram. Ligação a um feed real e instalação continuam por provar |
| Empacotamento | Pipeline disponível e candidata produzida; sem assinatura Authenticode |
| Pacote / instalação | **`BLOCKED_HOST` por 9 colisões de host**; não instalado |

Uma candidata gerada **não** é uma instalação validada. O facto de o build ter terminado não prova
que o produto instalado arranca, protege ou atualiza.

## O que está provado

- **Arranque e navegação reais em DEV.** Uma sessão manual assistida, com perfil e pipe isolados,
  registou prontidão em 2 890 ms, 19 ciclos de leitura e navegação por Painel, PC Center, Gestor de
  Tarefas e Configurações.
- **Leituras do sistema medidas, não inferidas.** CPU e RAM com estado `available`, RAM agregada a
  68 %, quatro discos lidos, 374 processos enumerados em duas amostras e 26/26 PIDs próprios
  marcados.
- **Proteção desligada lida como booleano.** `protection.getState` devolveu `protectionEnabled:
  false` em todos os ciclos, sem inferência a partir de texto.
- **Arranque confirmado visualmente.** O utilizador confirmou o ecrã de arranque na sessão m1b;
  a política de prontidão tem 62/62 testes verdes.
- **Fronteira Windows read-only exercida.** Uma tentativa de terminar processos foi recusada com
  `efeito_negado_por_modo_leitura` antes de chegar ao handler; nenhum processo foi morto por esse
  caminho.
- **A4 e A5 com prova GUI de escopo limitado.** O canário YARA read-only deu resultado positivo na
  GUI (R2). Dois cancelamentos foram comprovados na GUI (R4) e correlacionados com relato humano.
  Isto não é prova de um scan completo.
- **Testes focados verdes.** Arranque/prontidão 62/62, acessibilidade dos sparklines 90/90 e painel
  de Atualizações 55/55, com `tsc -b` a terminar sem erros nos respetivos lotes.
- **Candidata de 21/10 verificada estaticamente.** Identidade do pacote com 12 PASS, 0 FAIL e
  três UNKNOWN declaradas (publisher, ícone no PE e filhos em runtime); os motores externos
  (scan-engine e ClamAV) batem certo com a fonte; o patch de leitura read-only está presente no
  bundle. O setup tem 171 650 785 bytes e SHA-256
  `1c0648d557b74fc79ba5137a5cb58ee1212c362715ea7c7f38cff79e6eecb1f3`.

## O que não está provado

- Execução do instalador, primeira execução e comportamento do produto empacotado.
- Utilização real de GPU, temperaturas e SMART (a temperatura continua `unavailable` neste host).
- Matrix/IA online: o cliente é compatível com a API da Groq, mas uma resposta válida do
  fornecedor não foi demonstrada nesta entrega.
- Atualização a partir de um feed real, download, instalação e rollback.
- Reteste de GUI do P0A rev2 e do painel de Atualizações, correções **posteriores** ao lote A4/A5.
  A4/A5 têm provas GUI de escopo limitado; não provam um scan completo.
- Leitura por um leitor de ecrã real e revisão de acessibilidade em runtime.
- Assinatura digital do executável: a candidata está **NotSigned**.

## Arquitetura

Monorepo npm com nove pacotes em `packages/*`:

| Pacote | Papel |
|---|---|
| `packages/app` | Interface React (Vite + Tailwind CSS), consumida pelo desktop |
| `packages/desktop` | Shell Electron, pré-carregamento, IPC e bandeja do sistema |
| `packages/service` | Serviço local Node.js: orquestra scans, quarentena, monitorização e histórico |
| `packages/core` | Motor de análise: heurísticas, YARA-X, ClamAV, VirusTotal, scoring e quarentena |
| `packages/api` | API REST (Express + SQLite): autenticação, dashboard e assistente |
| `packages/native-windows` | Camada PowerShell read-only: saúde do Windows, processos e firewall |
| `packages/native-engine` | Executável C++17/CMake: hash SHA-256, entropia e análise PE |
| `packages/shared-types` | Tipos TypeScript partilhados |
| `packages/extension` | Extensão de navegador (Manifest V3) para monitorização de downloads |

`packages/manual-retest` contém documentação de sessões de teste; não é um pacote executável.

```
Renderer (React)
    │  IPC pelo preload (contextIsolation)
Electron main
    │  named pipe do serviço
Serviço Node.js (@cybersafe/service)
    ├── @cybersafe/core (heurísticas, YARA-X, ClamAV, VirusTotal, quarentena)
    ├── @cybersafe/native-windows (PowerShell read-only)
    └── scan-engine.exe (C++, opcional, segunda opinião)
API REST (Express + SQLite) ── autenticação, dashboard, assistente
```

O renderer não recebe acesso direto ao Node.js nem ao sistema de ficheiros: as operações passam
pelo preload e pelos canais definidos no serviço. A camada Windows é limitada a consultas
allowlisted e operações de leitura.

## Requisitos

- **Windows 10/11 x64** — a monitorização, o serviço e a bandeja são específicos de Windows.
- **Node.js 20 ou superior** e **npm** (o repositório usa npm workspaces).
- **Electron 33.4.11** — versão fixada no pacote `@cybersafe/desktop`.
- **CMake** apenas para compilar o motor nativo C++ (opcional).
- O **ClamAV** é um motor externo opcional; as regras **YARA** são definições locais carregadas
  pelo `@litko/yara-x`. Nenhum destes componentes é substituído por código do repositório.

A instalação do serviço Windows exige elevação. Para desenvolvimento não é necessário instalar o
serviço nem criar uma conta de sistema.

## Desenvolvimento

Instalar dependências na raiz:

```bash
npm install
```

O repositório inclui um runner de isolamento cujo modo por omissão é **dry-run**: mostra o plano
sem arrancar processos.

```bash
node scripts/dev-isolated-run.mjs
```

O dry-run **não** é uma receita de arranque validada. O modo `--start` não é apresentado aqui como
receita: sem JWT e sem modo read-only validados, pode iniciar outra sessão. Uma sessão Windows
read-only validada exige ferramentas externas ao repositório que ainda não estão publicadas por
dependerem de portabilidade do ambiente. Sem essas ferramentas, não se promete que um arranque
local fique isolado do perfil pessoal.

Não uses `npm run dev` como caminho normal de desenvolvimento. Esse comando lança serviço, API,
app e desktop com `concurrently` contra as portas e o perfil normais; a guarda de isolamento recusa
a porta 4000 e o arranque pode ser bloqueado por desenho. Fica reservado para uma máquina
controlada e para quem conhece o perfil que está a usar.

Para avaliação visual do frontend, sem bridge, serviço ou Electron:

```bash
npm run dev:app
```

Este modo serve apenas a interface. Não prova leituras do sistema, IPC, proteção, scans ou
qualquer comportamento do produto empacotado.

A criação da conta de desenvolvimento exige uma base de dados e uma raiz isoladas, num
procedimento externo. Não é documentada aqui como comando para evitar escritas na base pessoal.
Não existe uma credencial por omissão documentada.

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

Não existe um `npm test` na raiz; os testes correm por workspace. Alguns testes de serviço e de
core exigem build prévio e são mais demorados.

### Runner externo de evidência

As sessões de GUI em Windows read-only foram conduzidas por um **runner externo ao repositório**,
mantido na área de integração e evidência, fora do Git. Não é uma dependência do produto, não é
instalado por `npm install` e não é necessário para compilar ou executar a aplicação. A receita
validada depende deste tooling externo, que ainda não foi publicado por portabilidade. Este README
não promete um comando que não exista neste repositório.

## Empacotamento

O pipeline de empacotamento vive em `scripts/package-windows.mjs` e usa `electron-builder` com
alvo NSIS x64:

```bash
# Verificações, sem produzir instalador
node scripts/package-windows.mjs --check

# Candidata com identificador próprio, sem sobrescrever releases anteriores
node scripts/package-windows.mjs --candidate
```

A candidata é escrita numa pasta `release/candidate-<AAAAMMDD-HHMMSS>-<8 hex>`. O processo não
assina o executável (sem certificado configurado) e não instala nada. Uma candidata só pode ser
considerada validada depois de executada num ambiente isolado e aprovado.

## Segurança e privacidade

- O código não deve receber chaves, tokens, palavras-passe ou ficheiros `.env` versionados.
- A conta de desenvolvimento exige um procedimento isolado; não há credenciais por omissão no
  README.
- A camada Windows é read-only por allowlist. O bloqueio de processos está desativado em DEV e é
  recusado pela fronteira read-only.
- O assistente envia o texto do utilizador para um fornecedor externo compatível com a API OpenAI
  (por omissão, Groq). Não devem ser introduzidos dados pessoais, chaves ou ficheiros sensíveis.
- O repositório contém histórico de bases de dados e checkpoints/referências de agentes, incluindo
  material fora do HEAD atual. A curadoria é um **gate do responsável do projeto**, a concluir antes
  de qualquer novo push ou divulgação alargada. Nada nesta documentação declara o histórico limpo.

## Limitações conhecidas

- A aplicação não é um antivírus completo nem substitui o Windows Defender.
- O motor nativo C++ é opcional; sem ele, mantém-se a integração TypeScript, sem garantir a mesma cobertura de análise.
- ClamAV, VirusTotal e o assistente dependem de binários, chaves e limites externos.
- O modo empacotado não é testável com a guarda de leitura de DEV ligada; essa guarda exige
  `!isPackaged` e reserva o teste para um ambiente isolado.
- A interface foi observada em sessão manual, mas não existe ainda uma revisão de acessibilidade
  em runtime nem capturas fornecidas para publicação.
- O histórico do repositório contém bases de dados e checkpoints de agentes que exigem curadoria
  antes de uma divulgação alargada.

## Documentação

- [Arquitetura](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Progresso de 23/10](docs/PROGRESSO-20261023.md)
- [FAQ para entrega](docs/FAQ-ENTREGA-PROFESSOR.md)
- [Capturas: estado e requisitos de privacidade](docs/screenshots/README.md)
- [Como ler esta documentação (júri)](#como-ler-esta-documentação-júri)
- [Motor nativo](packages/native-engine/README.md)

## Licença

O repositório não inclui atualmente um ficheiro `LICENSE`. A utilização, cópia ou distribuição
depende de autorização do autor do projeto.

