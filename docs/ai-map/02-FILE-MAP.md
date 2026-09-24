# 02 — FILE MAP

## Raiz
| Caminho | Responsabilidade |
|---|---|
| `package.json` | workspaces `packages/*`; scripts `dev`, `build:all`, `build:native`, `lint`, `typecheck`, `memory:report`, `drivers:check`, `scanner:probe`, `scanner:benchmark` |
| `tsconfig.base.json` | config TS partilhada + aliases `@cybersafe/*` |
| `AGENTS.md` | índice/regras para agentes |
| `scripts/` | `sync-branding.mjs`, `check-release-drivers.mjs`, `memory-report.mjs`, `scanner-runtime-probe.mjs`, `scanner-benchmark.mjs`, `stage-renderer.mjs` |
| `docs/` | mapas + `RELEASE_DRIVER_CHECK.md` |

## `packages/shared-types` (`@cybersafe/shared-types`)
| Ficheiro | Responsabilidade |
|---|---|
| `src/index.ts` | tipos partilhados (PcState, HealthAlert, temas/design tokens) + lógica pura `buildHealthAlerts`, `buildHealthAlertsFromSnapshot`, `IMPORTANT_WINDOWS_SERVICES`, categorias audit/eventos |

## `packages/core` (`@cybersafe/core`) — motor
| Ficheiro | Responsabilidade |
|---|---|
| `src/index.ts` | barrel/orkestration pública |
| `src/analysis.ts` | análise de artefactos/PEMs |
| `src/exclusions.ts` / `.js` / `.d.ts` | regras de exclusão persistidas |
| `src/definitions.ts` | definições de assinaturas/atualização |
| `src/signatures.ts` | assinaturas YARA/malware |
| `src/yara.ts` | integração `@litko/yara-x` (regras + scan) |
| `src/clamav.ts` | scan ClamAV (adicionado em 2026-09) |
| `src/pcstate.ts` | **PcStateEngine** — recomendações proteção (hardware/disk/ram/service, dedup com native-windows) |
| `src/hardware.ts` + `gpu-selection.ts` | monitorização HW, temperatura GPU |
| `src/temperature.ts` + `temperature-provider.ts` | temperaturas CPU/GPU (múltiplos providers) |
| `src/response.ts` | modelo de resposta a alertas |
| `test/` | `engine-integrity`, `pcstate`, `stress-index`, `exclusions`, `hardware-gpu`, `temperature-providers`, `process-kill` |

## `packages/native-windows` (`@cybersafe/native-windows`)
| Ficheiro | Responsabilidade |
|---|---|
| `src/index.ts` | barreira Windows + `normalizeTopProcesses` (exclui PID 0), `buildRecommendations` (reusa `IMPORTANT_WINDOWS_SERVICES`) |
| `src/powershell.ts` | execução PS (Win32_Process.WorkingSetSize = bytes → MB) |
| `src/wfp-filter.ts` | filtro firewall WFP |
| `test/` | `windows-health-logic`, `powershell-normalize`, `watcher-errors` |

## `packages/service` (`@cybersafe/service`) — fundo headless
| Ficheiro | Responsabilidade |
|---|---|
| `src/index.ts` | entry; switch de **tópicos** do named pipe (ver 03) |
| `src/engine.ts` | coordenador, eventBus, snapshots, tópicos, `process.analyze` |
| `src/process-monitor.ts` | deteção de processos novos/saída/bloqueio (eventos `process.*`) |
| `src/scan-manager.ts` + `scan-error.ts` | scans iniciados/cancelados/curso |
| `src/windows-service.ts` | instalar/desinstalar como serviço Windows (node-windows) |
| `src/updater.ts` | auto-atualização de definições/programa |
| `src/native-engine-bridge.ts` | ligação ao scanner C++ |
| `test/` | `scan-manager`, `scan-pipeline`, `scan-error`, `shutdown`, `process-kill` |

## `packages/desktop` (`@cybersafe/desktop`) — shell Electron
| Ficheiro | Responsabilidade |
|---|---|
| `src/main.ts` | janela principal, spawn/seguimento do serviço, named pipe, IPC handlers, tray, segundo instância |
| `src/preload.ts` | API IPC `window.electron.*` (canais `service:get-*`; ver 03) |
| `src/service-client.ts` | cliente do named pipe (JSON com `topic`/`payload`/`id`) |
| `src/exit-confirmation.ts` | dialogo de confirmação de saída |
| `src/ipc-guard.ts` | guarda de canais IPC |
| `src/tray-menu.ts` | menu de bandeja |
| `bridge-sim*.mjs` | simuladores de bridge/teste (não entram no build) |
| `test/` | testes `.test.mjs` |

## `packages/app` (`@cybersafe/app`) — frontend React+Vite
| Ficheiro | Responsabilidade |
|---|---|
| `src/App.tsx` | roteamento, passa `pcState` a Dashboard/PCCenter |
| `src/main.tsx` + `index.css` | entry + tokens (cyber-red/yellow/green/cyan) |
| `src/electron.d.ts` | tipagem da API `window.electron` |
| `src/pages/` | DashboardPage, PCCenterPage (banner via `overallStatusMeta`), FileScannerPage, TaskManagerPage, OtimizarPage, RegisterPage, ReportsPage, BusinessSecurityCenter, SettingsPage |
| `src/components/` | ProtectionDetails, PCHealthSection (evidence em `<details>`), AIAssistant, MatrixAvatar, Sidebar, ExitConfirmDialog, OnboardingOverlay, Skeleton, TelemetrySparkline |
| `src/lib/` | `protectionHealth.ts`, `processActions.ts`, `scanSession.ts`, `shutdownState.ts`, `exitConfirm.ts`, `onboarding.ts`, `temperature.ts`, `appearance.ts`, `featureControl.ts`, `business-network-utils.ts` |
| `test/` | `*.test.ts` (tsx --test) |

## `packages/api` (`api`) — REST + IA
| Ficheiro | Responsabilidade |
|---|---|
| `src/index.ts` | Express (porta 4000), auth JWT, `/api/ai/chat|stream|status`, `/api/events|dashboard|file-scan|training-score`, uploads |
| `src/ai.ts` | cliente OpenAI-compatible + **PERSONA Matrix** + limites contexto (`maxHistory:16`, `maxTokens:400`) |
| `.env.example` | config (DATABASE_URL, JWT_SECRET, CYBERSAFE_AI_*, GROQ/OPENAI/VIRUSTOTAL keys — sem valores reais) |
| `test/ai-policy.test.js` | valida a **política** do prompt (não respostas literais) |

## `packages/native-engine`
| Ficheiro | Responsabilidade |
|---|---|
| `CMakeLists.txt` + `src/` | scanner C++ (build nativa, raiz: `npm run build:native`) |

## Nota
Ficheiros podem incluir pares `.js`/`.d.ts` gerados (ex.: `core/src/exclusions.js`) — não editar o `.js` gerado, editar o `.ts`.

## Revisão
- 2026-09-23 — a partir de manifestos e `glob` real.