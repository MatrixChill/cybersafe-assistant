# CyberSafe Assistant

O CyberSafe Assistant é uma plataforma de cibersegurança focada em monitorização, análise de ameaças e gestão de saúde do sistema Windows. Desenvolvido como projeto educacional (PAP), integra múltiplas camadas de análise — desde heurísticas locais até consulta a serviços externos — numa interface desktop moderna.

## O que é o CyberSafe Assistant

O CyberSafe Assistant é um dashboard de cibersegurança para Windows que combina:

- **Análise de ficheiros** com motor heurístico, YARA, entropia e hashing SHA-256;
- **Monitorização em tempo real** de processos, serviços, ligações de rede e firewall;
- **PC Health** — avaliação de saúde do sistema (RAM, disco, processos, serviços críticos);
- **Quarentena e resposta a ameaças** com scoring de risco e recomendações automáticas;
- **Assistente IA** para interpretação de riscos e suporte ao utilizador;
- **Interface desktop** construída com Electron + React + Tailwind CSS.

## Arquitetura

O repositório é um **monorepo npm** (`packages/*`):

| Pacote | Papel |
|--------|-------|
| `packages/app` | UI web (Vite + React + Tailwind CSS) consumida pelo desktop |
| `packages/desktop` | Shell Electron — integração IPC com o serviço e system tray |
| `packages/service` | Serviço Windows (Node.js) — orquestra scans, quarentena, monitorização |
| `packages/core` | Motor lógico (TypeScript) — YARA-X, análise heurística, scoring, client VirusTotal |
| `packages/api` | API REST (Express + SQLite) — dashboard, IA assistente, autenticação |
| `packages/native-windows` | Camada PowerShell read-only — health do Windows, processos, firewall |
| `packages/native-engine` | Executável C++ (CMake) — hash SHA-256, entropia, análise PE |
| `packages/shared-types` | Tipos TypeScript partilhados entre todos os pacotes |
| `packages/extension` | Extensão de navegador para monitorização de downloads |

```
Electron (UI)
    ↓ IPC / named pipe
Serviço Windows (Node.js — engine.ts)
    ↓
@cybersafe/core (MalwareAnalyzer, YaraEngine, VirusTotal, quarentena)
    ↓ (opcional)
scan-engine.exe (C++) — segunda opinião nativa (hash, entropia, PE)
```

## Funcionalidades implementadas

### Motor de análise e proteção
- Análise heurística de ficheiros (magic numbers, entropia, extensões perigosas, assinatura digital)
- Scan com regras YARA (via `@litko/yara-x`)
- Hash SHA-256 e base de assinaturas Known-bad
- Integração com VirusTotal (API key via variável de ambiente)
- Scoring de risco (0–100) com severidade e ação recomendada
- Quarentena com restauração e gestão de confiança (hash/publisher allowlist)
- Scan de ficheiros individuais, full system scan e scan personalizado

### Monitorização Windows (read-only)
- Processos ativos (CPU e RAM) com deteção de comportamentos suspeitos
- Serviços Windows e estado dos mesmos
- Ligações TCP ativas com resolução de processo
- Utilizadores locais do sistema
- Discos e espaço disponível
- Estado do Firewall do Windows (perfis)
- Snapshot de saúde com scoring e recomendações automáticas

### PowerShell integration
- Camada segura de execução PowerShell com queries allowlistadas
- Apenas operações de leitura (`Get-*`) — sem funcionalidades destrutivas
- Scripts fixos sem interpolação com input do utilizador

### Desktop (Electron)
- Interface com system tray, auto-start (configurável) e notificações desktop
- Splash screen e conexão automática ao serviço
- Proteção contra tentativas de kill do processo
- Gestão de eventos de segurança em tempo real

### IA Assistente
- Chatbot integrado para suporte sobre segurança digital
- Interpretação de riscos e recomendações contextualizadas
- Powered by Groq API (Llama 3.1) — chave via variável de ambiente

### API REST
- Endpoints para dashboard, eventos, estatísticas e file scan
- Autenticação JWT com registo e login
- SSE (Server-Sent Events) para eventos em tempo real
- Treino educacional (jogos de simulação de cibersegurança)

## Estado atual do projeto

O CyberSafe Assistant encontra-se em **fase ativa de desenvolvimento**. As funcionalidades centrais (análise de ficheiros, monitorização Windows, interface desktop e IA assistente) encontram-se implementadas e funcionais. O projeto continua a evoluir com foco em:

- Integração completa do motor C++ como segunda opinião nativa
- Expansão das regras heurísticas e definições YARA
- Refinamento do scoring de risco e do sistema de recomendações
- Melhoria contínua da interface e experiência do utilizador

## Segurança e gestão de credenciais

O CyberSafe Assistant utiliza chaves de API externas (VirusTotal, Groq) e segredos (JWT) que **nunca devem ser expostos no código fonte**.

- Todas as credenciais devem ser fornecidas através de variáveis de ambiente ou ficheiros `.env` locais
- O ficheiro `.env` está excluído do repositório via `.gitignore`
- Nunca inclua API keys, passwords ou tokens diretamente no código
- Em ambiente de produção, utilize um gestor de segredos adequado

Exemplo de configuração (ficheiro `.env` na raiz ou no pacote correspondente):

```
VIRUSTOTAL_API_KEY=sua_chave_aqui
GROQ_API_KEY=sua_chave_aqui
JWT_SECRET=seu_segredo_aqui
```

## Contexto PAP

O CyberSafe Assistant é desenvolvido no âmbito de um **Projeto de Aptidão Profissional (PAP)**. O projeto evolui através de ciclo iterativo de desenvolvimento, testes e documentação, com o objetivo de demonstrar competências técnicas em cibersegurança, engenharia de software e arquitetura de sistemas.

Este repositório serve como evidência do processo de desenvolvimento e das soluções técnicas implementadas.

## Como executar

Este projeto é um monorepo npm (workspaces). Para iniciar:

```bash
# 1. Instalar dependências
npm install

# 2. Iniciar todos os serviços (serviço, API, app, desktop)
npm run dev
```

Comandos individuais:

| Comando | Descrição |
|---------|-----------|
| `npm run dev:service` | Serviço Windows em background |
| `npm run dev:desktop` | Interface Electron |
| `npm run dev:app` | Aplicação frontend (React) |
| `npm run dev:api` | API REST |

### Motor nativo C++

O pacote [`packages/native-engine/`](./packages/native-engine/) contém o executável `scan-engine` (C++17/CMake). Para compilar:

```bash
npm run build:native
```

### Requisitos

- **Node.js** >= 20
- **Windows** (a monitorização PowerShell e o serviço são específicos para Windows)
- **CMake** (para compilar o motor nativo C++)

## Estrutura do repositório

```
cybersafe-assistant/
├── packages/
│   ├── app/              # Frontend React (Vite + Tailwind)
│   ├── desktop/          # Shell Electron
│   ├── service/          # Serviço Windows (Node.js)
│   ├── core/             # Motor de análise (TypeScript)
│   ├── api/              # API REST (Express)
│   ├── native-windows/   # PowerShell layer (read-only)
│   ├── native-engine/    # Motor C++ (CMake)
│   ├── shared-types/     # Tipos partilhados
│   └── extension/        # Extensão de navegador
├── definitions/          # Definições YARA e hashes
├── docs/                 # Documentação técnica
├── logs/                 # Logs de runtime
└── README.md
```

## Principais tecnologias

| Camada | Tecnologias |
|--------|-------------|
| Desktop | Electron, Vite |
| Frontend | React, Tailwind CSS, Framer Motion |
| Backend | Node.js, Express, SQLite (via Prisma) |
| Motor de análise | TypeScript, YARA-X (@litko/yara-x), ClamAV |
| Motor nativo | C++17, CMake |
| Windows | PowerShell (read-only), Named Pipes |
| IA | Groq API (Llama 3.1) |
| Outros | JWT, bcrypt, multer, SSE |

## Limitações

- A monitorização Windows (PowerShell, processos, firewall) só funciona em ambiente Windows
- O motor nativo C++ é opcional — a análise funcional sem ele é assegurada pelo motor TypeScript
- A integração VirusTotal e IA dependem de chaves API externas (plano gratuito com rate limits)
- O projeto não substitui um antivírus comercial — é uma ferramenta educacional e de monitorização
- Alguns módulos (ETW, WFP, AMSI) encontram-se em fase preliminar

## Documentação adicional

- Arquitetura detalhada: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- Roadmap: [`docs/ROADMAP.md`](./docs/ROADMAP.md)
- Resumo consolidado: [`docs/PLANO-CONSOLIDADO.md`](./docs/PLANO-CONSOLIDADO.md)
- FAQ para entrega ao professor: [`docs/FAQ-ENTREGA-PROFESSOR.md`](./docs/FAQ-ENTREGA-PROFESSOR.md)
- Motor nativo C++: [`packages/native-engine/README.md`](./packages/native-engine/README.md)

## Licença

MIT
