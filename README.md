<p align="center">
  <img src="assets/branding/generated/icon-128.png" alt="CyberSafe Assistant" width="112" height="112">
</p>

<h1 align="center">CyberSafe Assistant</h1>

<p align="center">
  Aplicação desktop de cibersegurança para Windows — análise de ficheiros com múltiplos motores,
  monitorização do sistema e resposta a ameaças, num único painel.
</p>

<p align="center">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-33-47848F">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6">
  <img alt="Node" src="https://img.shields.io/badge/Node.js-%E2%89%A520-339933">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-10%2F11-0078D4">
  <img alt="Estado" src="https://img.shields.io/badge/estado-desenvolvimento%20académico-orange">
</p>

> **Projeto académico (PAP) em desenvolvimento.** Os instaladores internos usados nos testes
> **não estão aprovados para distribuição**. O CyberSafe Assistant **não substitui** o Microsoft
> Defender nem qualquer antivírus certificado, e **não garante deteção** de todo o malware.

> **Estado de validação (2026-10-31).** O código deste repositório corresponde ao snapshot de
> desenvolvimento de 2026-10-30 e inclui a correção do ciclo de vida da janela
> (`Object has been destroyed`). A candidata interna **0.1.10** (`0.1.10-internal.pap-r5.20261031`,
> SHA-256 `46718bcd…bd75`) foi instalada e ensaiada manualmente em máquina virtual: o crash de
> encerramento **deixou de se reproduzir nesse ensaio** e arranque, motores, serviço, API e
> Gestor de Tarefas foram reportados como funcionais. Continua a ser uma candidata interna, sem
> assinatura e não publicada.
>
> A 0.1.10 **não é o artefacto final da PAP**: o primeiro ecrã do instalador mostra o texto interno
> «0.1.8», o renderer empacotado identifica-se como «0.1.9» e o painel de Atualizações mostra
> «Compilação desconhecida»/«Código desconhecido». São defeitos de **empacotamento e proveniência**,
> não de produto: o delta de código face à 0.1.9 são dois ficheiros
> (`resources/app/dist/main.js` e `resources/app/package.json`). A correção está identificada e
> exige uma candidata seguinte. O instalador **0.1.9 (PAP R4)** não continha a correção do ciclo de
> vida e não representa o estado atual. Este repositório não publica instaladores, bases de
> assinaturas nem releases.

---

## Índice

- [O que é](#o-que-é)
- [Funcionalidades](#funcionalidades)
- [Arquitetura](#arquitetura)
- [Tecnologias](#tecnologias)
- [Desenvolvimento](#desenvolvimento)
- [Testes](#testes)
- [Segurança e limitações](#segurança-e-limitações)
- [Melhorias futuras](#melhorias-futuras)
- [Documentação](#documentação)
- [Licença](#licença)

---

## O que é

O **CyberSafe Assistant** é uma aplicação desktop para Windows que reúne, num painel único:

- **análise de ficheiros** com vários motores independentes (YARA, base de hashes conhecidos,
  ClamAV e um motor nativo em C++);
- **monitorização** de processos, hardware e eventos de segurança do sistema;
- **quarentena** e resposta a ameaças, com histórico e relatórios exportáveis;
- **gestão do sistema** — gestor de tarefas (só leitura), PC Center, otimização e proteção USB.

O projeto nasce no âmbito do **Projeto de Aptidão Profissional (PAP)** do curso de
**Programador/a de Informática**. Serve simultaneamente como produto funcional e como evidência
do processo de engenharia: cada capacidade é implementada, testada e documentada, e o produto
**declara o que não sabe** em vez de simular estados (motores indisponíveis aparecem como
indisponíveis).

## Funcionalidades

### Implementado e coberto por testes

| Área | O que faz |
|---|---|
| **Scanner** | Análise rápida, personalizada e de ficheiro individual; progresso real, cancelamento, contagens de analisados / excluídos / inacessíveis |
| **Motores** | YARA (via `@litko/yara-x`), base de hashes maliciosos, ClamAV (binário oficial vendorizado) e motor nativo C++ (hash SHA-256, entropia, análise PE) |
| **Quarentena** | Isolamento com metadados, restauro controlado e política de confiança |
| **Histórico** | Sessões de análise persistidas com resultados, contagens e estado terminal |
| **Relatórios** | Relatório consolidado A4 exportável em PDF, com impressão como alternativa |
| **Gestor de Tarefas** | Processos com CPU/RAM; **terminação individual** de aplicações comuns, com confirmação, elegibilidade decidida pelo serviço e processos protegidos (CyberSafe e sistema) excluídos — indisponível em sessão de leitura |
| **PC Center** | Saúde do sistema: CPU, RAM, disco, bateria, GPU, temperatura e diagnósticos |
| **Monitorização** | Processos, hardware e eventos de segurança em tempo real |
| **Otimizar** | Sugestões de limpeza e otimização com base no estado medido |
| **Proteção USB** | Deteção de dispositivos, leitura apenas e análise de conteúdos |
| **MATRIX** | Assistente de segurança com consentimento explícito e chave própria (BYOK) |
| **Configurações** | Tema, identidade visual, arranque e preferências de proteção |
| **Atualizações** | Verificação de novas versões e estado honesto de disponibilidade |

### Parcialmente validado

- **Instalador NSIS personalizado** (4 ecrãs, verificação de espaço e caminho): construído e
  compilado offline, **sem execução real** — a validação final depende de instalação em VM.
- **Proteção em tempo real** (watchers e recuperação): lógica e testes automatizados presentes;
  comportamento em instalação real ainda em validação.
- **Motor nativo C++**: integrado no serviço por *bridge* com estados de saúde explícitos; a
  comparação de resultados em cenários reais continua em avaliação.

### Planeado

- Gestor de exclusões com interface própria;
- Melhor desempenho em análises profundas (varrer e classificar sem esgotar o orçamento numa pasta);
- Diagnóstico mais detalhado de resultados inconclusivos;
- Compatibilidade gráfica alargada (DPI e aceleração em hardware variado);
- Instalador com validação completa em máquina limpa.

## Arquitetura

Monorepo npm (`packages/*`) com separação entre interface, orquestração, motores e serviço:

```
┌──────────────────────────────────────────────────────────────┐
│  packages/app        React + Vite + Tailwind (renderer)      │
└───────────────▲──────────────────────────────────────────────┘
                │ IPC seguro (contextBridge / preload)
┌───────────────┴──────────────────────────────────────────────┐
│  packages/desktop    Electron: main, preload, tray, splash   │
└───────────────▲──────────────────────────────────────────────┘
                │ named pipe JSON-RPC
┌───────────────┴──────────────────────────────────────────────┐
│  packages/service    orquestra scans, quarentena, USB,       │
│                      monitorização, histórico, atualizações  │
└───────▲───────────────▲──────────────▲───────────────▲───────┘
        │               │              │               │
 @cybersafe/core   native-windows   ClamAV         scan-engine.exe
 (YARA, hashes,    (PowerShell      (vendorizado)  (C++: hash,
  heurística,       read-only)                      entropia, PE)
  scoring)
```

| Pacote | Responsabilidade |
|---|---|
| `packages/app` | Interface (React 19, Vite, Tailwind), shell V2 e páginas |
| `packages/desktop` | Shell Electron, preload, IPC, tray, arranque e ciclo de vida |
| `packages/service` | Serviço Node: pipeline de análise, quarentena, USB, watchdog |
| `packages/core` | Motor lógico: YARA, hashes, heurística, scoring, ClamAV, hardware |
| `packages/native-windows` | Camada PowerShell **read-only** e watchers do Windows |
| `packages/native-engine` | Executável C++ (CMake): SHA-256, entropia, parsing PE |
| `packages/api` | API REST (Express + Prisma/SQLite) para contas e assistente |
| `packages/shared-types` | Contratos TypeScript partilhados (comandos/respostas do serviço) |
| `packages/extension` | Extensão de navegador para consciencialização de downloads |

Princípios aplicados no código:

- **veredictos não derivam de exit codes** — resultam de evidência medida;
- **estados incertos nunca são apresentados como seguros** (`unknown` ≠ `off` ≠ `protected`);
- **operações destrutivas** (terminar processos, eliminar ficheiros) passam por política explícita;
- **sem segredos no repositório** — chaves vivem em configuração local do utilizador.

## Tecnologias

| Camada | Tecnologias |
|---|---|
| Desktop | Electron 33, Vite, electron-builder (NSIS) |
| Interface | React 19, TypeScript 5.9, Tailwind CSS 4, Framer Motion, Radix UI |
| Serviço | Node.js (≥ 20), named pipes JSON-RPC, `node-windows` |
| Análise | `@litko/yara-x` (YARA), hashes SHA-256, ClamAV, motor nativo C++17 |
| Windows | PowerShell read-only, CIM/WMI, `systeminformation` |
| API | Express, Prisma + SQLite, JWT (bcrypt), SSE |
| Inteligência artificial | Fornecedor configurável pelo utilizador (chave BYOK) |
| Qualidade | `node --test`, `tsx`, TypeScript `--noEmit`, ESLint |

## Desenvolvimento

### Requisitos

- **Node.js ≥ 20** (recomendado 20 LTS ou superior)
- **Windows 10/11** — a monitorização e o serviço são específicos do Windows
- **CMake + compilador C++17** — apenas para o motor nativo
- **ClamAV para Windows** — obtido pelo script de vendorização (não é versionado)

### Instalação

```bash
npm install
```

### Executar em desenvolvimento

```bash
# Serviço, API, app e desktop em conjunto
npm run dev

# Ou individualmente
npm run dev:service
npm run dev:api
npm run dev:app
npm run dev:desktop
```

A janela Electron abre com o renderer servido pelo Vite; a API fica em `http://localhost:4000`.

### Build

```bash
npm run build:all          # pacotes pela ordem de dependências
npm run build:native       # motor C++ (CMake, Release)
npm run dist -w @cybersafe/desktop   # empacotamento Windows (local)
```

> O empacotamento gera instaladores **internos** (`NOT_FOR_DISTRIBUTION`). Não estão aprovados
> para distribuição e não devem ser publicados.

### ClamAV (vendorização)

O binário do ClamAV **não** está no repositório. O script `scripts/vendor-clamav.mjs` obtém o
pacote portátil oficial (Cisco/Talos), valida assinatura e digests, e prepara `vendor/clamav/`.
Sem esse passo, o motor ClamAV apresenta-se como indisponível — e o produto diz exatamente isso.

## Testes

Os testes usam o runner nativo do Node (`node --test`), com `tsx` onde há TypeScript.

```bash
npm test -w @cybersafe/core
npm test -w @cybersafe/service
npm test -w @cybersafe/app
npm test -w @cybersafe/desktop
npm test -w @cybersafe/native-windows
npm test -w api

npm run typecheck
npm run lint
```

Cada suíte cobre contratos reais do produto (pipeline de análise, quarentena, honestidade de
estados, segurança de *pipes*, ciclo de vida do arranque). Testes que dependem de hardware,
motores externos ou de uma instalação real estão fora do que a CI consegue provar — e são
marcados como validação manual.

**Estado dos testes.** No conjunto dirigido de autenticação, persistência, quarentena e *pipe*
(documentado em `PAP-EVIDENCIAS-TECNICAS/TESTES-AUTOMATICOS-VERIFICADOS.md`): **315 PASS / 1 FAIL /
0 SKIP** em 316 testes. O FAIL está identificado e explicado: a expectativa de
`threat-history-storage.test.js` ficou desatualizada face à reposição de assinaturas embutidas
(`ensureOfflineCoverage`), que é comportamento intencional do produto. **A suíte completa não foi
executada** e não é declarada como aprovada.

### Ensaios manuais em máquina virtual (candidata 0.1.10)

A tabela separa **o que foi comunicado** por quem executou o ensaio manual do **que está
verificado por evidência neste repositório**. Nenhum resultado manual é apresentado como
verificado quando não existe registo.

| Ensaio | Resultado comunicado (manual, VM) | Evidência verificável neste repositório |
|---|---|---|
| EICAR detetado e enviado para quarentena | Detetado e isolado | Testes automatizados de EICAR em YARA, base de hashes e ClamAV (`packages/core/test/*eicar*`, `clamav-*`, `yara-*`); **não** existe log da execução manual |
| Restauro a partir da quarentena | Ficheiro restaurado | `service-r5-quarantine-restore-result` 5/5 e `core-quarantine-restore-safety` 6/6 (logs em `PAP-EVIDENCIAS-TECNICAS/logs/`) |
| Persistência após reinício (conta, histórico, quarentena, consentimentos) | Mantida | `auth-session-restart` 1/1, `r6-l11-persistence` 5/5, `r7-l3-history` 17/17, `core/recovery-quarantine` 7/7 |
| Encerramento sem `Object has been destroyed` | Deixou de se reproduzir | Correção no ciclo de vida da janela (`isDestroyed()` em `cancel()`/`dispose()`) e suíte desktop 597/597 reportada na lane de empacotamento |
| Motores, serviço, API e Gestor de Tarefas | Funcionais | Testes por área (ver `PAP-EVIDENCIAS-TECNICAS/`); a execução no instalador não tem log neste repositório |

**Efeitos 3D na máquina virtual — limitação real, não defeito.** O `CoreScene` só é montado quando
`gpu` está ligado (`gpu = webgl && !lowPower`). Com o perfil de desempenho em `auto` e **4 ou menos
CPUs lógicas** — o caso da VM usada nos ensaios — o perfil é tratado como económico, o `gpu` fica
desligado e a cena 3D **nunca é montada**: fica o orbital estático, sem mensagem de erro. Não é uma
regressão de WebGL; se o WebGL falhasse com `gpu` ligado, apareceria «Variante estática · 3D
indisponível». O comportamento não foi alterado antes da PAP e continua por explicar na interface.

## Segurança e limitações

- **Não é um antivírus certificado.** Não substitui o Microsoft Defender e não oferece garantia
  de deteção; a ausência de deteções não prova que um ficheiro seja seguro.
- **Windows-only.** A monitorização, o serviço e o empacotamento assumem Windows.
- **Chaves externas** (VirusTotal, fornecedor de IA) são configuradas localmente pelo utilizador;
  nunca são incluídas no repositório.
- **Operações destrutivas** (terminar processos, eliminar/quarentenar) são limitadas por política;
  um administrador malicioso continua a poder contornar a proteção em *user-mode*.
- **Limites de cobertura:** orçamento de ficheiros por análise, exclusões de sistema e formatos
  não suportados são declarados nos resultados (analisados / excluídos / inacessíveis).
- **Instaladores internos** não são distribuíveis e não substituem um processo de assinatura.

Se encontrares um problema de segurança, não abras uma issue pública com detalhes sensíveis.

## Melhorias futuras

1. Gestor de exclusões com interface dedicada;
2. Otimização do pipeline de análise (orçamento distribuído, menos trabalho repetido);
3. Melhor cobertura de formatos e heurísticas;
4. Diagnóstico explícito de resultados inconclusivos;
5. Atualizações seguras com verificação de integridade fim-a-fim;
6. Compatibilidade gráfica e DPI em hardware variado;
7. Instalador final validado em máquina limpa, com assinatura.

## Documentação

- [Arquitetura](docs/ARCHITECTURE.md) — camadas, fluxos e contratos
- [Roadmap](docs/ROADMAP.md) — fases e prioridades honestas
- [FAQ de entrega](docs/FAQ-ENTREGA-PROFESSOR.md) — perguntas típicas sobre o projeto
- [Transferência para revisão da PAP](docs/PAP-TRANSFERENCIA-20261031.md) — factos comprovados, lacunas e o que o relatório pode afirmar
- [Evidências técnicas da PAP](PAP-EVIDENCIAS-TECNICAS/README.md) — oito documentos com provas, limitações e índice de reprodução
- [Camada PowerShell / Windows](docs/POWERSHELL-WINDOWS-LAYER.md)
- [Toolchain C++ no Windows](docs/TOOLCHAIN-CPP-WINDOWS.md)
- [Motor nativo](packages/native-engine/README.md) — compilar e testar o `scan-engine`
- [Índice da documentação](docs/README.md)

## Licença

MIT. Ver [`package.json`](package.json). Componentes de terceiros mantêm as respetivas licenças
(ver `assets/licenses/`).
