# 01 — ARCHITECTURE

## Visão

Monorepo npm (`workspaces: packages/*`), TypeScript estrito (config base: `tsconfig.base.json`), appId `com.cybersafe.assistant`.

```
┌───────────────────────────────┐   IPC    ┌───────────────────────────────┐
│  @cybersafe/app (React+Vite)  │ ───────► │  @cybersafe/desktop (Electron) │
│  SÓ importa @cybersafe/shared-│          │  main.ts + preload.ts          │
│  types                         │          └──────────────┬────────────────┘
│  (Dashboard, PCCenter, Task,   │                         │ named pipe (JSON)
│   AIAssistant, Otimizar, ...)  │                         ▼
└───────────────┬───────────────┘          ┌───────────────────────────────┐
                │ REST (porta 4000)        │  @cybersafe/service (headless) │
                ▼                          │  engine.ts + process-monitor + │
┌───────────────────────────────┐          │  scan-manager + updater        │
│  @cybersafe/api (Express)     │          └───────┬───────────────┬────────┘
│  auth JWT, sqlite/prisma,     │                  │               │
│  IA Matrix (OpenAI-compatible)│                  ▼               ▼
│  /api/ai/chat, /api/stream    │      @cybersafe/core   @cybersafe/native-windows
└───────────────────────────────┘      (scan,yara,pcstate)  (PS/WFP/health)
```

### Módulos nativos
- `packages/native-engine` — scanner C++/CMake; build na raiz: `npm run build:native` (gera `packages/native-engine/build/Release`).

## Fronteiras (regras)

1. `@cybersafe/app` só importa `@cybersafe/shared-types`. Nunca `@cybersafe/native-windows`, `core`, `service`, `desktop`.
2. `@cybersafe/shared-types` é lógica pura + tipos (compilado de `src/index.ts`; exporta funções ex. `buildHealthAlerts`, `buildHealthAlertsFromSnapshot`).
3. `core` depende de `shared-types`, `@litko/yara-x`, `systeminformation`, `chokidar`, `events`.
4. `service` usa `core` + `native-windows` + `shared-types`; expõe protocolo named-pipe (tópicos em `service/src/engine.ts`).
5. `desktop` usa `service`, `core`, `shared-types`; nunca fala com `app` diretamente (só via IPC + páginas estáticas).
6. `api` é independente do motor (usa `shared-types`), tem a sua própria base de dados SQLite (better-sqlite3 + Prisma) e a IA Matrix.

## Camadas de dados

- **Base de dados do produto** → `packages/api` (SQLite via `better-sqlite3`, Prisma schema; `.env` → `DATABASE_URL`).
- **Estado persistente do serviço** → pasta de dados do utilizador (exclusions, quarentena, definições — ver `core/src/exclusions.ts`, `definitions.ts`).
- **Definições de assinaturas** → `core` (yara/clama/zip) e packagings; `scripts/` sincroniza branding e drivers de release.

## IA Matrix

Persona e política em `packages/api/src/ai.ts` (constante `PERSONA`, portugês, terse, construtora de `buildMessages()`/`buildContextBlock()`). Config por ambiente (ver `.env.example`): `CYBERSAFE_AI_PROVIDER`, `CYBERSAFE_AI_BASE_URL`, `CYBERSAFE_AI_MODEL`, chave com fallback `GROQ_API_KEY`/`OPENAI_API_KEY`. Modelo atual por defeito: `groq/compound`. `aiEnabled` = presença de chave; `/api/ai/status` faz probe de reachability (cache 15s).

## Padrão de comunicação

- Renderer → preload (`service:get-*`) → main → service-client → named pipe JSON → service (`engine.ts` switch de tópicos). Eventos de volta via `service:event`.
- Página standard `Electron` preview em `packages/desktop/` vê as páginas de `app` copiadas (scripts `stage-renderer.mjs`).

## Revisão

- 2026-09-23 — criado a partir da leitura real de manifests + fontes.