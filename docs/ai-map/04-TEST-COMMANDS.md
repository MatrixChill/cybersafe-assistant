# 04 — TEST COMMANDS

Validação primária **sem LLM** (Shell como Test Runner). Corre na raiz do monorepo salvo indicação.

## Raiz
| Comando | O que faz |
|---|---|
| `npm run typecheck` | typecheck em todos os workspaces |
| `npm run lint` | lint em todos os workspaces |
| `npm run build:all` | build de todos os workspaces |
| `npm run build:native` | build scanner C++ (CMake → `packages/native-engine/build`) |
| `npx git diff --check` | spançoes whitespace/erros de patch |
| `npm run memory:report` / `drivers:check` / `scanner:probe` / `scanner:benchmark` | scripts de estado/drivers |

## Por workspace
| Workspace | Teste | Typecheck | Lint |
|---|---|---|---|
| `@cybersafe/core` | `npm test -w @cybersafe/core` (build + `node --test test/*.test.js`; incl. pcstate, hardware-gpu, exclusions, stress-index, process-kill) | `tsc -p tsconfig.json --noEmit` | `tsc --noEmit` (igual) |
| `@cybersafe/native-windows` | `npm test -w @cybersafe/native-windows` (windows-health-logic, powershell-normalize, watcher-errors) | idem (tsc --noEmit) | idem |
| `@cybersafe/service` | `npm test -w @cybersafe/service` (build + `node --test test/scan-manager|scan-pipeline|scan-error|shutdown|process-kill`) | delegado a core/native-windows | `tsc --noEmit` |
| `@cybersafe/desktop` | `npm test -w @cybersafe/desktop` (`node --test test/*.test.mjs`) | delegado a app/core | (sem lint dedicado) |
| `@cybersafe/shared-types` | (sem testes dedicados; validado via build/typecheck) | `tsc -p tsconfig.json --noEmit` | idem |
| `@cybersafe/app` | `npm test -w @cybersafe/app` (`tsx --test test/*.test.ts`) | `tsc -b --pretty false` | `eslint .` |
| `api` | `npm test -w api` (build + `node --test test/ai-policy.test.js`) | `tsc -p tsconfig.json --noEmit` | idem |

## Dev
| Comando | O que faz |
|---|---|
| `npm run dev` | sobe service + api + app + desktop em paralelo (concurrently) |
| `npm run dev:app` / `dev:api` / `dev:service` / `dev:desktop` | desenvolvimento individual |

## Fluxo recomendado para qualquer alteração
1. `npm run typecheck` na raiz.
2. `npm test -w <pkg>` do(s) pacotes tocado(s).
3. `npm run lint` na raiz (se aplicável).
4. `npx git diff --check` antes de concluir.
5. Build: `npm run build:all` (ou `npm run build:native` para scanner C++).

## Notas
- Testes usam `node --test` (Node ≥ 20; máquina: Node v24.13.0) — sem jest/vitest no monorepo.
- App usa `tsx --test`. Desktop usa `vite build` para o bundle (com `stage-renderer.mjs` pré-build).
- O serviço e o desktop delegam typecheck aos pacotes de baixo — ver `package.json` de cada um.

## Revisão
- 2026-09-23 — extraído de `package.json` de cada workspace + verificação de ambiente.