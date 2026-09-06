# Relatório da Sessão Longa — CyberSafe Assistant (PAP)

**Data:** 06/09/2026
**Branch:** `main`
**Comando para iniciar a demonstração:** `npm run dev`

---

## 1. Sumário

Sessão dedicada a colocar o CyberSafe Assistant a **correr de ponta a ponta** (service + API + app + desktop) com interface utilizável e dados reais do sistema, verificação página a página e estabilização de bugs na camada de monitorização Windows.

Resultado final: a aplicação abre no Electron, o dashboard mostra telemetria real (CPU, RAM, disco, rede, score de proteção), o PC Center mostra saúde real do Windows (serviços, firewall, alertas, recomendações), o Task Manager lista os processos reais com CPU/RAM, o Monitor apresenta o event bus em tempo real e o Simulador de Phishing está funcional.

---

## 2. URLs locais e credenciais

| Recurso | URL |
|---------|-----|
| Interface (Electron) | abre automaticamente com `npm run dev` (carrega `http://localhost:5173`) |
| App (browser) | `http://localhost:5173` |
| API REST (health) | `http://localhost:4000/health` |
| Pipe do serviço | `\\.\pipe\cybersafe-protection-dev-v2` (definido em `packages/core/src/definitions.ts`) |

Credenciais de desenvolvimento (seed):

```
admin@cybersafe.local / CyberSafe2026!
```

---

## 3. Estado por fase

| # | Fase | Resultado |
|---|------|-----------|
| 0 | Inventário e arquitetura | OK — monorepo npm (workspaces), 9 pacotes |
| 1 | Interface aberta (Electron + service + API + app) | OK — janela “CyberSafe Assistant — Security Dashboard” abre e liga ao pipe |
| 2 | Dashboard utilizável | OK — dados reais, sem banners de erro |
| 3 | Verificação página a página | OK — todas as páginas navegam e renderizam |
| 4 | Estabilização de bugs | OK — 4 áreas corrigidas (ver secção 4) |
| 5 | Verificação de dados | OK — processes, connections, health snapshot, events reais |
| 6 | Commits (máx. 6) | OK — 5 commits criados |
| 7 | Documentação | OK — este relatório + README atualizado |
| 8 | Relatório final | Este documento |

---

## 4. Bugs corrigidos nesta sessão

1. **Erro “O literal de hash estava incompleto” no PowerShell health layer** — as queries multi-linha eram unidas com `; `, partindo blocos `[PSCustomObject]@{...}`. Corrigido para junção com `\n` (`packages/native-windows/src/powershell.ts`).

2. **Mojibake/UTF-8** — o `stdout` do PowerShell era interpretado com a codificação do sistema (mojibake tipo “Servi�o”). Adicionado `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` no prefixo das queries.

3. **Lentidão na resolução de “owner” dos processos** — cada processo ativo (300+) disparava uma query CIM individual. Os top processos por CPU/RAM passaram a resolver apenas as top 8 entradas.

4. **Snapshot de saúde bloqueante** — o `WindowsHealthEngine` levava muito tempo (TTL de 5 s em queries de ~2 s) e podia correr em paralelo em bursts. TTL subido para 30 s + deduplicação de chamadas in-flight (`getSnapshot` → `collectSnapshot`).

5. **Processos com command line corrompido** — o CSV partia campos com vírgulas. `snapshotProcesses` passou a usar `ConvertTo-Json -Compress`.

6. **Conexões TCP ilegíveis** — `systeminformation.networkConnections` depende do `netstat` em inglês e falhava em locale português. `snapshotConnections` passou a usar `Get-NetTCPConnection` (estável em qualquer locale) com deduplicação e limite de 200.

7. **Sem estado de proteção ativo por omissão** — ao conectar o cliente ao pipe, o serviço agora auto-inicia a proteção residente (dados reais no Task Manager/Monitor sem interação manual) (`packages/service/src/engine.ts`).

8. **Mojibake de acentuação na UI (PC Center)** — strings duplamente codificadas (ex.: “MonitorizaÃ§Ã£o”, “VisÃ£o Simples”) corrigidas para português correto; polimento de rótulos no Monitor e Dashboard (ex.: throughput da rede em KB/s).

---

## 5. Verificação executada

| Item | Resultado |
|------|-----------|
| `http://localhost:4000/health` | `200 OK` |
| Login API (`admin@cybersafe.local`) | token JWT emitido |
| `npm run build -w @cybersafe/native-windows` | OK (0 erros) |
| `npm run typecheck --workspace @cybersafe/app` | OK (0 erros) |
| `npm run lint --workspace @cybersafe/service` | OK (0 erros) |
| Pipe — `protection.getState` | OK |
| Pipe — `windows.healthSnapshot` | services=301, topCpu=8, topRam=8, connections=50, disks=4, users=8, firewall=true, score=90, recs=1, errs=0 |
| Pipe — `processes.list` | ~157–194 processos reais |
| Pipe — `connections.list` | ~72–88 conexões reais |
| Pipe — `threats.list` | vazio (esperado) |
| Electron (CDP :9260) — navegação | Dashboard, PC Center, Ameaças, File Scanner, Task Manager, Monitor, Simulador — todas OK |
| Dashboard rende | CPU 9%, RAM 49% (15/30.9 GB), Disco 86% (821/953 GB), Rede em KB/s, Score 100 HEALTHY |
| Quick Scan (IPC real) | `{"id":"...","success":true}` |
| Event bus do Monitor | eventos reais `FILE.CREATED`/`PROCESS.STARTED`/`ARTIFACT.ANALYZED` |
| Mojibake na UI | 0 ocorrências restantes |

---

## 6. Checklist de demonstração

| Área | Estado |
|------|--------|
| Interface abre (Electron) | **SIM** |
| Dashboard | **SIM** (score, CPU, RAM, disco, rede, alertas, proteção residente) |
| Security / PC Center | **SIM** (saúde do sistema, firewall, serviços, alertas e recomendações reais) |
| Ameaças | **SIM** (vazio com estado apresentável — sem ameaças reais detectadas) |
| File Scanner | **SIM** (Quick/Full/Custom Scan) |
| Task Manager | **SIM** (processos reais, CPU/RAM, kill + analyze via IPC) |
| Network / Conexões | **SIM** (página “Monitor” — Network Containment Layer com conexões reais; PC Center tem tabela de conexões ativas) |
| Simulador de Phishing | **SIM** (desafio de identificação de links) |
| IA Assistente | **SIM** (chat integrado no canto) |
| “Optimize” | **PENDENTE** — não existe página “Optimize” na barra de navegação; remoção de temporários e otimização ficam como pendência |
| Relatórios | **PARCIAL** — funcionalidade reservada a planos “Business”; com conta PERSONAL/PREMIUM redireciona para o Dashboard |

---

## 7. Commits criados (5/6)

```
9a1df98 fix(app): correct Portuguese encoding and polish PC Center, Monitor and Dashboard
580f0b2 fix(service): auto-start resident protection on pipe client connect
59af5f7 fix(native-windows): collect processes via JSON and connections via Get-NetTCPConnection
defe05c fix(native-windows): repair PowerShell health layer (multiline queries, UTF-8, owner perf, snapshot dedupe)
```

*(o quinto commit corresponde a esta documentação + README)*

---

## 8. Pendências e limitações conhecidas

- **Motor YARA** é carregado com fallback gracioso — se `@litko/yara-x` não estiver disponível, o serviço loga “Desativando motor YARA” e continua (não bloqueia).
- **GPU** aparece como “não detetada” (a máquina usa iGPU AMD sem telemetria completa pelo `systeminformation` no Windows).
- **Disco/GPU/Rede** do hardware snapshot populam-se após os ticks do `HardwareHealthEngine` (5 s/10 s) — não ficam imediatamente disponíveis ao primeiro acesso.
- **Estado numérico das conexões TCP** (ex.: `100`, `5`) ainda é apresentado cru em algumas vistas.
- **Coluna de utilizador** dos processos ficou vazia (a resolução por processo era demasiado lenta — removida por omissão).
- **“Relatórios”** depende do plano Business (conta de demonstração é Personal Premium).
- **Página “Optimize”** não existe na side bar (pendência de produto).
- **`packages/extension`** (extensão de navegador) não é coberta por esta demonstração.
- O **directório `dist`** do `native-windows` e os logs gerados em `C:\Users\caioc\AppData\Local\Temp\opencode\*.log` são temporários e fora do controlo de versões (permite re-verificação).

---

## 9. Conclusão

O CyberSafe Assistant está **pronto para demonstração** no âmbito da PAP: abre por `npm run dev`, apresenta o dashboard com telemetria real, navega por todas as páginas sem erros e demonstra a integração Electron + service (named pipe) + camada PowerShell read-only + API.

**Método de demonstração recomendado:** executar `npm run dev` na raiz, aguardar a janela do Electron abrir, percorrer Dashboard → PC Center → Task Manager → Monitor → Simulador.

**Documento:** `docs/PAP_LONG_SESSION_REPORT.md` (este relatório).