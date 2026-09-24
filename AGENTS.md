# CyberSafe Assistant — Guia de Agentes

Monorepo npm (workspaces em `packages/*`). Produto: consola Electron + serviço de fundo + API REST + IA Matrix.

## Arquitetura resumida

- `packages/shared-types` — tipos + lógica pura partilhada (compila de `src/index.ts`; ex. `buildHealthAlerts`).
- `packages/core` — motor: scan, quarentena, exclusions, definições, PC state (`pcstate.ts`), hardware/GPU.
- `packages/native-windows` — atributos Windows/PS nativos (`normalizeTopProcesses`, WFP, health).
- `packages/service` — serviço de fundo headless; protocolo named-pipe JSON (topics em `service/src/engine.ts`).
- `packages/desktop` — shell Electron; `src/preload.ts` expõe a API IPC ao renderer.
- `packages/app` — UI React+Vite; **só importa `@cybersafe/shared-types`**.
- `packages/api` — REST (porta 4000) + IA Matrix (OpenAI-compatible); config via `.env` (ver `.env.example`).
- `packages/native-engine` — scanner C++/CMake (`build:native` na raiz).

## Contexto (mapas em `docs/ai-map/`)

Abre **só** o mapa relevante para a tarefa:

- planeamento/visão geral → `00-START-HERE.md`
- ficheiros e responsabilidades → `02-FILE-MAP.md`
- fluxos críticos / protocolo / IPC → `03-CRITICAL-FLOWS.md`
- comandos de validação → `04-TEST-COMMANDS.md`
- estado atual e infra → `05-CURRENT-STATE.md`
- roles da equipa → `06-AGENT-ROLES.md`

## Validação (Shell, sem LLM)

- `npm run typecheck` · `npm run lint` · `npm run build:all` (raiz)
- por workspace: `npm test -w @cybersafe/<pkg>` · `npx git diff --check`
- detalhes em `docs/ai-map/04-TEST-COMMANDS.md`

## Regras obrigatórias

1. Verifica o **código real** antes de afirmar comportamento; nunca inventes caminhos nem funcionalidades.
2. **Proibido sem autorização explícita**: `git reset`, `git restore`, `git checkout --`, `git clean`, `git stash`, `force push`.
3. Nunca exponhas tokens/API keys em código, comandos, ficheiros ou logs; nunca comites `.env`.
4. Não recrutes vários agentes a editar a mesma worktree; usa floors/worktrees isolados.
5. Preserva alterações existentes do utilizador; tarefas pequenas e delimitadas.
6. Depois de alterar ficheiros, reporta: ficheiros tocados + testes executados + resultados.