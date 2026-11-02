# Matriz de Compatibilidade — CyberSafe Linux Lite

Fonte: inspeção do código na branch `experimental/linux-lite-qoder`, origem
`freebuff/r7-final-integration-20261101` (HEAD 83ee706). Toda a classificação
abaixo está ancorada em caminhos reais do repositório, não em presunções de
que "TypeScript é multiplataforma".

Legenda:
- **MP** — Totalmente multiplataforma (arranca em Linux sem alteração).
- **RA** — Reutilizável com pequenas adaptações (guarda de plataforma ou dado de entrada).
- **EW** — Exclusivo Windows (não deve ser importado nem executado em caminhos Linux).
- **NN** — Não necessário para o Linux Lite (fase posterior / omitido).

## 1. Pacotes

| Pacote | Veredicto | Evidência |
|---|---|---|
| `packages/shared-types` | MP | Contratos `ServiceCommandMap`; campos `win32Code`/taskkill são opcionais (`src/index.ts:243-295`, `:1027`) |
| `packages/app` (React) | MP com ajustes semânticos | Páginas OS-agnósticas; rótulos e dados Windows em `OtimizarPage.tsx` (`getWindowsHealth`), `lib/processActions.ts` (semântica taskkill), `lib/netConnectionsView.ts` (mapa de estados TCP) |
| `packages/core` | RA | Maioria portable (chokidar, hashing, ClamAV/YARA já com noção de plataforma); módulos win32: `win-kernel.ts`, `win-pdh.ts`, `win-process-termination.ts`, `adl-bridge*`, `adl-provider.ts`, `adlx-provider.ts` (koffi em `optionalDependencies`, já protegido) |
| `packages/native-windows` | EW (usa-se por trás de provider) | `taskkill` (`src/index.ts:943`), PowerShell/CIM (`src/index.ts:725`, `src/powershell.ts:58-153`, `src/usb-storage.ts:143-146`), WFP (`src/wfp-filter.ts`), AMSI/ETW são stubs (`src/amsi-provider.ts`, `src/etw-consumer.ts`); `watcher-*.ts` é chokidar (portable) |
| `packages/service` | RA | Orquestração portable; acoplamentos: pipe Windows (§3), `node-windows` legado (`src/windows-service.ts`), handlers CIM/taskkill (`src/engine.ts:4354-4613`), política de quarentena com env Windows (`src/quarantine-path-policy.ts:17-21`), lease de byte-range só Windows (`scripts/quarantine-dir-lease.mjs:42`) |
| `packages/desktop` (Electron main) | RA | Janela/tray/single-instance portables; já com guards não-win32: Mica (`window-material.ts:137`), titlebar (`titlebar-overlay.ts:69`), autostart (`main.ts:1681-1700,1786`), updater (`main.ts:1864` `runtimeSupported: isPackaged && win32`); `windowsHide` no spawn do serviço (`main.ts:517`); `safeStorage` para credenciais (DPAPI no Windows, libsecret no Linux — guard `isEncryptionAvailable()` já existe em `ai-credentials-store.ts`) |
| `packages/api` | RA | Express + better-sqlite3 (nativo, rebuild em Linux) + Prisma/sqlite; sem Windows-only detectado |
| `packages/native-engine` | RA | C++17 CMake compila fora de MSVC (branch MinGW no `CMakeLists.txt`); heurísticas de PE são específicas de artefacto Windows, não do OS anfitrião; saída `scan-engine.exe` hardcoded nos scripts |
| `assets/branding` | MP | PNGs reutilizáveis; `.ico`/bitmaps NSIS só interessam ao packaging Windows |
| `product-version.json` | MP | Lido por `scripts/app-version.mjs`; versão/ canal / codinome |

## 2. Dependências e binários exclusivamente Windows

- `koffi@3.3.4` (optionalDependency do `core`) → FFI para `kernel32.dll`, `pdh.dll` e DLLs ADL/ADLX (sensores GPU). Em Linux o load falha; o padrão "koffi opcional protegido" já é usado — manter.
- `node-windows` (`service`) → wrapper SCM legado; o caminho de produção hoje é **filho do Electron**, não SCM (`desktop/src/main.ts:486-530`). Em Linux Lite não instalar nem iniciar serviços Windows.
- `vendor/yara/` → `yara64.exe`, `yarac64.exe`, `vcruntime140.dll`. Proibido empacotar/executar em Linux. O contrato de resolução (`core/src/yara-classic.ts resolveYaraClassicBinaries()`) aceita `CYBERSAFE_YARA_BIN_DIR` → `resources/yara` → `vendor/yara` — o mesmo contrato serve binários `yara`/`yarac` Linux.
- `vendor/clamav/` (gerado por `scripts/vendor-clamav.mjs`, ClamAV portable Windows GPG-verificado). Em Linux: ClamAV do distro (`clamscan`/`clamd`/`freshclam` no PATH). `core/src/clamav.ts:2986-2987` já resolve `clamscan.exe` vs `clamscan` por plataforma e já conhece diretórios UNIX (`:2956`, `:3018-3030`) e split de PATH (`:2991`).
- `scan-engine.exe` (build MSVC `/MT`) referenciado em `service/src/native-engine-bridge.ts:79-91` e pré-requisito de `scripts/package-windows.mjs`. Linux usa binário próprio sem extensão ou omite a fase.
- Execução de shell Windows: `taskkill`, `reg query` (`service/src/windows-service.ts:~29`), `Get-CimInstance*`, `New-NetFirewallRule`, `Get-NetFirewallProfile`. Nenhum pode ser alcançado por código Linux.

## 3. Divergências de arquitetura entre OS

| Assunto | Windows hoje | Linux Lite |
|---|---|---|
| RPC app↔serviço | Named pipe `\\.\pipe\cybersafe-protection-dev-v2` (`core/src/definitions.ts:35` ← `resolvePipeName()` em `core/src/dev-isolation.ts`; servidor `net.createServer().listen(pipeName)` `service/src/engine.ts:4935,4945`; cliente `net.createConnection(this.pipeName)` `desktop/src/service-client.ts:220`) | Mesmo código `net`: Unix socket (ex. `<dir dados>/engine.sock`). Seam único: `resolvePipeName()` |
| Autenticação do canal | Nonce + HMAC (`core/src/pipe-auth.ts`) | Inalterada |
| Raiz de dados do serviço | `~/.cybersafe-service` (`dev-isolation.ts: defaultServiceBaseDir`) | `~/.cybersafe-linux-lite` — diretório dedicado, nunca partilhado com o perfil Windows |
| SQLite (API) | `~/.cybersafe-service/cybersafe.db` (`api/src/dev-isolation.ts:45`, override `CYBERSAFE_DB_PATH`) | Mesmo mecanismo sob a raiz Linux |
| Processos/métricas | CIM + PowerShell + PDH + taskkill | `systeminformation` (já dependência do core, pin 5.33.19) + `/proc` para identidade (PID+starttime) |
| Terminação segura | handle win32 + taskkill /T /F, exit codes (`shared-types:243-295`) | SIGTERM normal; SIGKILL excecional com confirmação separada; validação de identidade PID+starttime (`/proc/<pid>/stat`), `pidfd` via koffi/libc quando tecnicamente disponível; sem shell montado; recusar PID de outro utilizador/privilegiado/crítico |
| Firewall | WFP via `New-NetFirewallRule` (já reportado honestamente como indisponível quando falha) | Diagnóstico read-only: UFW / firewalld / nftables conforme presença real; ausente ≠ desligado |
| USB/armazenamento | Join CIM `Win32_DiskDrive→Partition→Volume` (`native-windows/src/usb-storage.ts`) | `/proc/mounts` + `udisks`/`lsblk` quando existirem; sem letras de unidade; nunca montar/formatar/apagar |
| Proteção em tempo real | watcher chokidar (portable) + observação de registo/tarefas agendadas (EW) | MVP: omitir fanotify (fase posterior); watcher de pastas pode reaproveitar chokidar |
| Sensores GPU/temperatura | DLLs ADL/ADLX via koffi (`win32`) | Não suportado → estados `nao-suportado`/`desconhecido`; proibido inventar temperatura |
| Autostart | `app.setLoginItemSettings` (guard win32) | `.desktop` autostart (fase posterior; gate já devolve "desativado" fora win32) |
| Updater | custom, `runtimeSupported: isPackaged && win32` (desligado em Linux por desenho) | Manter desligado no Lite; documentar |
| Credenciais MATRIX/Groq | Electron `safeStorage` → DPAPI, ficheiro `userData/secrets/ai-credentials.bin` | Mesmo `safeStorage` → libsecret/kwallet; quando `isEncryptionAvailable()` for false, UI declara "sem armazenamento seguro disponível" e pede confirmação; nunca transportar segredo do perfil Windows |
| Packaging | electron-builder NSIS x64 (`desktop/package.json build`), `package-windows.mjs` | alvo `deb` + `AppImage` em config separada; sem `.exe` no bundle |

## 4. Branching de plataforma que já existe (reutilizar, não duplicar)

- `desktop/src/main.ts:1864` — `runtimeSupported` (win32).
- `desktop/src/main.ts:1682,1691,1786` — autostart não-win32 devolve estado neutro.
- `desktop/src/window-material.ts:137` — Mica tem fallback sólido não-win32.
- `desktop/src/titlebar-overlay.ts:69,94` — overlay gated.
- `core/src/clamav.ts:2986-2991,3018-3030` — nome do binário, PATH e candidatos já por plataforma.
- `core/src/hardware-query.ts:66` — CIM só em win32; fora disso executa inline.
- `node-cache-fs.ts:77` — `O_NOFOLLOW` em não-win32.
- Testes com fixtures linux/darwin (`desktop/test/window-material.test.mjs:123`).

## 5. Costuras (seams) para os providers do Linux

Ordem de implementação proposta (cada um mantém o caminho Windows intacto):

1. **PlatformCapabilities / transporte** — `core/src/dev-isolation.ts resolvePipeName()` (socket Unix em Linux) + raiz de dados por plataforma + `quarantine-path-policy.ts` com raízes Linux (`/`, `/usr`, `/etc`, `/boot`, baseDir, dirname(execPath)).
2. **ProcessProvider + terminação** — seam já existe em `service/src/engine.ts:4354` (execução de terminação injetável por teste) e `core/src/win-process-termination.ts` vs `safe-process-termination.ts`. Linux: snapshot via `systeminformation.processes()` + validação `/proc` (starttime, uid, euid); kill por `process.kill` com dupla verificação de identidade; `pidfd_send_signal` via koffi libc quando disponível.
3. **SystemMetricsProvider** — substituir `WindowsHealthEngine` (PowerShell/CIM) por coleção `systeminformation` (CPU, RAM, disco, rede, OS, uptime) com enumeração honesta de sensores; o canal RPC `windows.healthSnapshot` ganha equivalente Linux ou é reportado como indisponível.
4. **ScannerProvider** — resolvers já funcionais por plataforma (clamav/yara/native-engine); em Linux proibir candidatos `.exe` e reportar motor indisponível em vez de "limpo" (semântica `EngineSubsystemHealth` → `pcstate.ts` já existe).
5. **FirewallProvider** — leitura diagnóstica (ufw status / firewall-cmd --state / nft list regras via interface segura), nunca alterar regras; mapear para estados existentes que já distinguem "indisponível" de "desligado".
6. **DeviceProvider** — volumes montados reais; a lógica de join do `usb-storage.ts` é puramente tabular e pode ser reimplementada sobre dados Linux.
7. **Autostart/updater/UI** — gates já devolvem estados neutros fora win32; rever rótulos "Windows" no renderer (Gestor de Tarefas, Otimizar, MATRIX config) para texto por plataforma.

## 6. Decisões de produto do Linux Lite

- Reutilizar o stack completo (Electron + React + service + api + core); nenhuma app nova.
- Persistência inteiramente isolada em `~/.cybersafe-linux-lite`; BD do Windows nunca lida.
- Funcionalidade Windows ausente é declarada indisponível com motivo; nada de botões falsos.
- Fases: P0 arranque → P1 processos/monitor → P2 scanner/MATRIX → P3 quarentena/USB → P4 otimizar/firewall → packaging/validação.
- Validação declarada por ambiente (WSL2 / VM Ubuntu / hardware real) — resultados WSL não provam GUI desktop instalada.
