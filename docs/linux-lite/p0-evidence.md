# Linux Lite — prova P0 (arranque da aplicação)

Ambiente desta corrida: **WSL2 · Ubuntu 26.04 · WSLg (DISPLAY=:0) · Node v22.23.4 · Electron
33.4.11 (build Chromium 130) · host Windows 10.0.26300**. WSL2 é um ambiente de teste
dirigido; **não substitui** a validação como aplicação desktop instalada numa distribuição
(missão §15). Nada aqui foi medido em Ubuntu/Mint instalado.

## O que foi medido

| Verificação | Resultado | Como foi medido |
|---|---|---|
| Janela Electron em Linux | OK — processo `electron .` com renderer `http://localhost:5173/` | `pgrep`, endpoint CDP `9229`, `/json/list` |
| Frontend React + identidade | OK — ecrã de login com logótipo, wordmark `CYBERSAFE`, título «CyberSafe Assistant — Painel de Segurança» | screenshot CDP `cybersafe-linux-renderer.png` |
| Tema escuro | OK — `<html class="dark">`, `body` fundo `rgb(7, 19, 30)`, texto `rgb(237, 243, 250)` | `getComputedStyle` via CDP |
| Navegação | OK — 11 destinos: Painel, Análise de Segurança, Ameaças, Monitor em Tempo Real, PC Center, Gestor de Tarefas, Otimizar, Simulador, Configurações, Recolher navegação, Terminar sessão | `innerText`/`nav` após login |
| Dashboard com dados reais | OK — CPU 16 %, memória, «Ainda sem análises registadas», pontuação de proteção, 4 motores com estados independentes | screenshot `cybersafe-linux-dashboard.png` + `innerText` |
| Ligação UI → motor | OK — `[ServiceClient] Connected to pipe successfully! (ligação #1)`, **0** retentativas | log `/tmp/cs-evidence.log` |
| Transporte Linux (AF_UNIX) | OK — motor à escuta em `~/.cybersafe-linux-lite-dev/engine.sock`, tipo `srwxr-xr-x` | `ls -la` |
| Persistência isolada | OK — `userData=/tmp/cybersafe-linux-lite-dev/userData`, `session=…/session`, BD `…/data/matrix.db`, raiz do motor `~/.cybersafe-linux-lite-dev` | log do desktop + `resolveServiceBaseDir()` |
| Conta/autenticação em Linux | OK — registo e login via API local (`role=user`, JWT 216 chars); sessão guardada pelo renderer | `POST /auth/register`, `POST /auth/login`, login pelo formulário |
| Erro tratado com estado honesto | OK — banner «Um componente da proteção reporta um erro. Confirmado pelo serviço: YARA (em erro).» em vez de fingir proteção | `innerText` do dashboard |
| Fallbacks não-Windows | OK — fundo da janela `pedido=solido (motivo=not-win32, backdrop_suportado=false)` | log do desktop |

## Descobertas que ficam como trabalho aberto

1. **YARA tenta executar um binário Windows no Linux.** O motor corre
   `vendor/yara/yarac64.exe` e recebe `EACCES`; o estado reportado é «Erro». O correto no
   Linux é o motor YARA ser *indisponível/não suportado* (sem spawn), não um erro de binário
   estrangeiro. (P2 Scanner.)
2. **Updater com PATH do Windows.** `freshclam` falha com `EACCES` em WSL porque o `PATH`
   herdado inclui `/mnt/c/...`. A deteção de ClamAV no Linux tem de excluir caminhos
   `/mnt/c` e reportar «indisponível» quando não existe binário Linux. (P2 Scanner.)
3. **GPU sob WSLg:** `Exiting GPU process due to errors during initialization` — o Electron
   cai para composição por software. Não bloqueia a UI; registado como limitação de ambiente.
4. **Contrato de transporte em dev (não é bug Linux):** `resolveDevProfile` só usa o
   transporte quando o runner declara `CYBERSAFE_DEV_PIPE_NAME`; sem essa variável deriva
   `<transporte>-matrixdev`, que nenhum serviço abre. O mesmo desvio existe no `npm run dev`
   do Windows. O runner Linux (`scripts/linux-lite/wsl-stack.sh`) declara o par
   `CYBERSAFE_DEV_SERVICE_DIR` + `CYBERSAFE_DEV_PIPE_NAME` para toda a árvore, que é o uso
   para o qual o código foi escrito. **Nenhum ficheiro partilhado foi alterado para a UI
   Linux ligar ao motor.**

## Como reproduzir

```bash
# Windows → WSL (os scripts vivem no repositório; correm no clone Linux)
wsl.exe -d Ubuntu -- bash -c \
  "tr -d '\\015' < /mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo/scripts/linux-lite/wsl-stack.sh > /tmp/stack.sh && bash /tmp/stack.sh"
# noutro terminal: prova de login + screenshots
wsl.exe -d Ubuntu -- bash -c \
  "tr -d '\\015' < /mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/wsl-login-probe.sh > /tmp/lp.sh && bash /tmp/lp.sh"
```

O stack precisa de `DATABASE_URL`, `JWT_SECRET` e `CYBERSAFE_API_PORT`; o runner gera o
segredo e a conta de demonstração **fora do repositório** (`/tmp/cybersafe-linux-lite-dev`),
que nunca são commitados.
