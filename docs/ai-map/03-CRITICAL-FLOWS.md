# 03 — CRITICAL FLOWS

## A. UI → Serviço (IPC + named pipe)

1. Renderer (React) chama `window.electron.<metodo>` (API de `packages/desktop/src/preload.ts`).
2. `preload.ts` invoca `ipcRenderer.invoke(channel, ...)`.
3. `main.ts` (handler genérico) encaminha o canal para `service-client.ts`.
4. `service-client.ts` abre o named pipe e envia `{ topic, payload, id }` JSON.
5. `service/src/index.ts` faz switch do **topic** e devolve `{ ok, data }` ao mesmo pedido.

Canais `window.electron.*` (preload): `getProtectionState`, `getSecurityEvents`, `getThreatEvents`, `getProcesses`, `getConnections`, `getQuarantineFiles`, `clearThreatEvents`, `scanFile`, `scanFullSystem`, `killProcessTree`, `analyzeProcess`, `getHardwareSnapshot`, `getWindowsHealth`, `getPCState`, `restoreQuarantine`, `deleteQuarantine`, `allowHash`, `allowPublisher`, `runRestrictedAnalysis`, `updateDefinitions`, `startScan`, `getActiveScan`, `cancelScan`, `threatAction`, `openFileDialog`, `openFolderDialog`, `onEvent`, `onExitConfirm`/`exitConfirmResponse`, `getAutoStart`/`setAutoStart`, `getNotificationsEnabled`/`setNotificationsEnabled`, `openReportWindow`.

Tópicos aceites no serviço (`engine.ts`/`index.ts`): `protection.getState`, `events.list`, `threats.list`, `processes.list`, `connections.list`, `quarantine.list`, `events.clear`, `scan.artifact`, `scan.fullSystem`, `monitor.start`, `monitor.stop`, `process.killTree`, `quarantine.restore`, `quarantine.delete`, `trust.allowHash`, `trust.allowPublisher`, `definitions.update`, `analysis.restricted`, `hardware.snapshot`, `windows.healthSnapshot`, `pcstate.get`, `process.analyze`, `exclusions.get`, `exclusions.update`, `scan.start`, `scan.getActive`, `scan.cancel`, `threat.action`, `service.shutdown`.

## B. Eventos (push para a UI)

`process-monitor.ts` emite para o `eventBus` do `engine.ts`: `process.started`, `process.exited`, `process.blocked`, `process.killed` (severidade low/high/critical). O renderer ouve `service:event` (preload `onEvent`). `blocked` inclui bloqueio de PowerShell malicioso e tentativa de matar o serviço CyberSafe.

## C. Estate de proteção/PC state (dedup crítico)

- `PcStateEngine` (`core/src/pcstate.ts`) combina recomendações do serviço e do hardware.
- Recomendações `disk-critical|disk-attention|ram-high|ram-attention` do `native-windows` são **descartadas** (`WINDOWS_RECS_COVERED_BY_HARDWARE`) — os candidatos do hardware-monitor (`core`) são autoritários (thresholds mutuamente exclusivos + anti-flapping).
- `service-down` de `mpssvc` é ignorado quando `input.protection.engine.firewall.status !== "active"` (evita dupla-reportação do Windows Firewall).
- `security:engine-unavailable` conta engines com status `degraded|unavailable`; resumo é apenas contagem (sem nomes técnicos — detalhes vivem no `FindingEvidence`).
- `overall` derivado → banner no `PCCenterPage` via `overallStatusMeta()`.

## D. Scan pipeline

`startScan(type, target)` → `scan.start` (service) → `scan-manager.ts` → scanner (`core`: yara/clamav/signatures, bridge nativo C++) → eventos/quarentena/definições → UI consome `getActiveScan`/`scanSession.ts`. Cancelamento: `cancelScan(id)`. Utilitários de driver/benchmark: `npm run scanner:probe` e `scanner:benchmark` (raiz).

## E. Kill de processo (path verificável: desktop→service)

`killProcessTree(pid)` → `process.killTree` → `engine.ts` killProcess(pid):
  1. Proteção (PID≤100, self-PID, ancestry, trusted path) — não só nomes
  2. `taskkill /T /F` com timeout 10s → `KillProcessResult {success, timedOut, alreadyTerminated, exitCode, error}`
  3. Reconciliação autoritativa: remove de `this.processes` imediatamente após kill
  4. Só publica `process.killed` APÓS confirmar desaparecimento (PID reuse guard)
  5. `process.exited` publicado pelo ProcessMonitor quando sai (FIX: agora publica evento)

## F. IA Matrix

- `app/src/components/AIAssistant.tsx` → REST `POST /api/ai/chat` (`packages/api`) (SSE via `/api/stream`).
- `api/src/ai.ts`: cliente OpenAI-compatible (`baseURL` do `.env`) + `PERSONA` (português, terse, regra de ouro "responde ao pedido", 1–3 frases por defeito, defensivo).
- `/api/ai/status`: `enabled` = probe live (`client.models.list`, cache 15s); NUNCA devolve a chave.
- Sem chave ⇒ MODO LOCAL gracioso (fallback sem IA).

## G. Arranque/exit do desktop

`main.ts` spawna/starts serviço headless, aguarda named pipe (lease `wait-on dist/main.js` + handshake), janela única (segunda instância), confirmação de saída (`exit-confirmation.ts`), serviço como windows-service opcional (`npm run service:install -w @cybersafe/service`).

## Revisão
- 2026-09-23 — verificado em `preload.ts`, `service/src/engine.ts`, `core/src/pcstate.ts`, `api/src/index.ts`.