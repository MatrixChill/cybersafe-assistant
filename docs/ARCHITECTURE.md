# Arquitetura do CyberSafe Assistant

Documento de referência das camadas, contratos e fluxos do produto. Descreve o código
**como está hoje**; o que ainda não existe está assinalado como planeado.

## Visão geral

Monorepo npm (`packages/*`) com cinco camadas principais:

| Pacote | Papel |
|---|---|
| `packages/app` | Renderer React (Vite + Tailwind). Não fala com o sistema operativo diretamente. |
| `packages/desktop` | Processo principal Electron: janela, tray, splash, preload, IPC e ciclo de vida. |
| `packages/service` | Serviço Node em segundo plano: pipeline de análise, quarentena, USB, watchers, histórico, atualizações. |
| `packages/core` | Motor lógico: YARA (via `@litko/yara-x`), base de hashes, heurística, scoring, ClamAV, hardware. |
| `packages/native-windows` | Queries PowerShell **read-only** (allowlist) e watchers Windows. |
| `packages/native-engine` | Executável C++17 (`scan-engine.exe`): SHA-256, entropia, parsing PE, JSON. |
| `packages/api` | API REST (Express + Prisma/SQLite) para contas, assistente e eventos. |
| `packages/shared-types` | Contratos TypeScript partilhados (`ServiceCommandMap` / `ServiceResponseMap`). |
| `packages/extension` | Extensão de navegador (consciencialização de downloads). |

## Fluxo de um pedido

```
Renderer (React)
   │  window.cybersafe.* (contextBridge; contextIsolation ativo)
   ▼
Preload (packages/desktop/src/preload.ts)
   │  IPC do Electron (canais explícitos)
   ▼
Main (packages/desktop/src/main.ts)
   │  named pipe JSON-RPC
   ▼
Serviço (packages/service/src/engine.ts)
   ├─ @cybersafe/core .............. análise, scoring, quarentena, hardware
   ├─ native-windows ............... PowerShell read-only / watchers
   ├─ ClamAV (vendorizado) ......... segunda opinião por assinaturas
   └─ scan-engine.exe .............. segunda opinião nativa (hash, entropia, PE)
```

Regras estruturais:

- **O renderer nunca executa processos nem lê o sistema de ficheiros.** Tudo passa pelo
  preload e por canais IPC explícitos.
- **O serviço é a única autoridade sobre resultados de análise.** O renderer apresenta
  estados derivados do serviço, não os inventa.
- **Estados honestos:** cada motor reporta `active` / `degraded` / `unavailable` com detalhe;
  “desconhecido” nunca é convertido em “seguro”.

## Motores de análise

| Motor | Onde vive | O que faz |
|---|---|---|
| Heurístico + scoring | `@cybersafe/core` (`analysis.ts`) | magic numbers, entropia, extensões de risco, metadados, veredicto e severidade |
| YARA | `@cybersafe/core` + `@litko/yara-x` | regras compiladas em processo Node (biblioteca nativa Rust) |
| Base de hashes | `@cybersafe/core` | hashes conhecidos-maliciosos (`known_bad_hash`) |
| ClamAV | binário oficial vendorizado | assinaturas; batch com orçamento e estados explícitos |
| Nativo C++ | `packages/native-engine` | hash, entropia, parsing PE; invocado pela *bridge* do serviço |

A *bridge* nativa (`packages/service/src/native-engine-bridge.ts`) não simula resultados: se o
binário não existir, o estado é `unavailable` com o caminho procurado; se existir mas a invocação
não tiver sido confirmada, o estado diz exatamente isso.

## Serviço e ciclo de vida

- **Transporte:** named pipe com JSON-RPC; autenticação por credencial de pipe.
- **Scan manager:** fila de pedidos, cancelamento idempotente, contagens terminais
  (analisados / excluídos / inacessíveis) reconciliadas.
- **Quarentena:** metadados + política de restauro e confiança; nunca elimina dados do
  utilizador sem ação explícita.
- **Tempo real:** watchers com fila, *loss ledger* e recuperação; o produto declara perda de
  eventos em vez de fingir cobertura total.
- **USB:** deteção de dispositivos, leitura apenas e análise opcional.
- **Atualizações:** verificação de versão e estados de disponibilidade honestos.
- **Arranque:** `main.ts` registra tentativas e resultados do serviço; falha de serviço não é
  mascarada como sucesso.

## Electron e empacotamento

- `contextIsolation` ativo, `nodeIntegration` desligado, preload mínimo.
- Janela, tray e splash geridos no processo principal, com guardas `isDestroyed` no ciclo de
  vida (correções validadas contra `Object has been destroyed`).
- Empacotamento com electron-builder; ícone, NSIS e recursos em `packages/desktop/build/`.
  O include NSIS personalizado (`installer/cybersafe-installer.nsh`) e os recursos de
  instalação vivem em `packages/desktop/build/installer/`.
- O lado nativo C++ é compilado à parte (`npm run build:native`) e entra como recurso extra.

## Segurança aplicada

- Segredos **nunca** no repositório; chaves do utilizador (IA, VirusTotal) ficam na
  configuração local, protegidas pelo shell.
- PowerShell com queries fixas e allowlist — sem interpolação de input do utilizador.
- Operações destrutivas passam por política explícita e são registadas.
- Veredictos derivam de evidência medida; exit codes não são prova.
