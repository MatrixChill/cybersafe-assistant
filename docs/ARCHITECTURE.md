# Arquitetura do CyberSafe Assistant

## Visão geral

O repositório é um **monorepo npm** (`packages/*`) com:

| Pacote | Papel |
|--------|--------|
| `packages/app` | UI web (Vite + React) consumida pelo desktop |
| `packages/desktop` | Shell Electron + integração com o serviço |
| `packages/service` | Serviço Windows (Node): orquestra scan, quarentena, pipes |
| `packages/core` | Motor lógico **TypeScript**: YARA-X, análise, scoring, VT client |
| `packages/api` | API REST (Express + Prisma) |
| `packages/native-windows` | Watchers e utilitários Windows em TS |
| `packages/native-engine` | **Executável C++** opcional: hash, entropia, PE, JSON (ver README do pacote) |

## O que é “motor” hoje

1. **Motor principal em produção (orquestração + regras):** `@cybersafe/core` em **TypeScript**, chamado pelo `packages/service/src/engine.ts`.
2. **YARA-X (`@litko/yara-x`):** biblioteca nativa (Rust por baixo) invocada **a partir do Node** — acelera regras YARA, mas não substitui a arquitetura “engine C++ separada”.
3. **Motor nativo C++ (`scan-engine`):** análise estática adicional (hash SHA-256, entropia, heurísticas de PE). Deve ser invocado pelo serviço via `child_process` quando integrado (ver `ROADMAP.md`).

## Fluxo lógico (alto nível)

```
Electron (UI)
    ↓ IPC / rede
Serviço Windows (Node + engine.ts)
    ↓
@cybersafe/core (MalwareAnalyzer, YaraEngine, VT, quarentena)
    ↓ (futuro / opcional)
scan-engine.exe (C++) — mesmo ficheiro, segunda opinião nativa
```

## Separação de responsabilidades (objetivo)

- **UI:** TypeScript/React — rápido de iterar, boa UX.
- **Orquestração e política:** TypeScript — integração APIs, estado, quarentena.
- **Scan CPU-intensivo e parsing binário:** C++ — menor footprint, sem GC do Node no hot path.
- **Kernel / pre-exec:** futuro (driver + minifilter); fora de escopo imediato.

## Nota sobre “TypeScript não acessa kernel”

Forma precisa: **TypeScript sozinho** não expõe APIs de kernel. **Node** pode carregar addons nativos (C++/Rust) ou executar binários; aí o acesso de baixo nível fica **fora** do interpretador TS.
