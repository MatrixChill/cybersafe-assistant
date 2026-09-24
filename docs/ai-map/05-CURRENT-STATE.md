# 05 — CURRENT STATE

Snapshot em 2026-09-23. Sempre confirmar com `git status`, `npm run typecheck`, `npm run build` e probes antes de concluir.

## Repositório
- Branch: `main` (últimos commits: `b946c30` fix desktop/service arranque+pipe; `16431f6` definições/seed; `302489a` IA Matrix; `dc72a2e` docs; `e1d4ba2` packaging; `2d0b1eb` pages/PDF/Otimizar).
- **Working tree com muitas alterações em curso** (dezenas de ficheiros modificados e untracked em todos os packages — AI, pcstate, protectionDetails, filmScanner, Settings, scanner scripts, testes novos). Preservar; não fazer reset/clean/checkout de nada.

## Confirmed (observado)
- Node `v24.13.0`, npm `11.6.2`, git `2.51.2`.
- Portas em listen: **4000** (node — API), **5173** (node — Vite), **8080** (httpd local). Outras livres: 20128/20129/20260/11434/1234/3000/6000/9420.

## Infraestrutura multiagente (custo €0)
- Ollama `0.21.2` instalado; modelos presentes no store: `qwen2.5-coder`, `deepseek-coder`, `llama3`. O `qwen3-8b` está presente localmente como `Qwen3-8B-Q4_K_M.gguf` em `C:\Users\caioc\AppData\Local\Matrix Code\models\Qwen3-8B-Q4_K_M.gguf` (≈4.68 GB), servido pelo runtime `C:\Users\caioc\AppData\Local\Matrix Code\runtime\llama.cpp\b10964\llama-server.exe` (llama.cpp server). Este runtime fornece um backend OpenAI-compatible local em `http://127.0.0.1:11434/v1` (compatível Ollama) ou através do Matrix Local/gateway. O servidor Ollama pode não estar em execução (porta 11434 off, embora o tray esteja aberto; `OLLAMA_HOST` vazio → default 127.0.0.1:11434), mas o runtime llama.cpp do Matrix Code está disponível como alternativa OpenAI-compatible.
- OmniRoute CLI instalado; config em `~/.omniroute` (inclui `.env` com segredo, db sqlite, call_logs, pid files de execuções passadas). **Server atualmente parado** (`omniroute health`: "Server not running"). Base URL esperada das ferramentas: `http://127.0.0.1:20128/v1`.
- 9Router CLI instalado; `-p --port` default é **20128** (conflito confirmado) → usar `20129`. Config em `%APPDATA%\9router`.
- AgentRouter: `ANTHROPIC_BASE_URL=https://agentrouter.org` + `ANTHROPIC_AUTH_TOKEN` definido (Claude Code/OpenCode usam este router, **não** Anthropic paga).
- `AIDER_OPENAI_API_BASE` vazio (aider ainda sem backend configurado); `~/.aider.conf.yml` inexistente.
- Qwen Code CLI v0.24.4: `qwen auth` removido; suporta `--openai-base-url`, `--auth-type openai|openai-responses|anthropic|qwen-oauth|gemini|vertex-ai`, `--model`. Pronto a apontar para endpoint local/OpenAI-compatible.
- Claude Code v2.1.280; `~/.claude` existe (settings.json top-level: `theme`); usa env `ANTHROPIC_BASE_URL`+token.
- `matrix` CLI (fork OpenCode, v0.0.0-dev) instalado; avisa que o gateway OmniRoute está offline (localhost:20128).
- Matrix Local: infraestrutura/runtime local; não é um agente.

## Matrix Local / Runtime Local
- `Matrix Code` (fork OpenCode v0.0.0-dev) instalado em `%APPDATA%\Matrix Code`.
- Runtime: `llama-server.exe` (llama.cpp b10964) em `C:\Users\caioc\AppData\Local\Matrix Code\runtime\llama.cpp\b10964\`.
- Modelo: `Qwen3-8B-Q4_K_M.gguf` (4.68 GB) em `C:\Users\caioc\AppData\Local\Matrix Code\models\`.
- Serve API OpenAI-compatible localmente (backend de fallback local para Qwen Code / Aider / local workers).
- Gateway: `http://127.0.0.1:20128/v1` (OmniRoute) ou porta direta do runtime.

## Equipa Maestri (recruits conectados)
| Recruit | Engine | Estado |
|---|---|---|
| OpenCode | opencode 1.18.32 | 🟢 Architect/Builder |
| Kilo Builder | kilo 7.7.7 | 🟢 operacional |
| Codex Lead | codex-cli 0.156.0 | 🔴 quota (usage limit) |
| Freebuff Builder | freebuff 0.0.185 | 🔴 freebucks insuficientes |
| Crush Reviewer | crush 0.93.1 / AIHubMix | 🔴 limite gratuito |

Só Kilo + OpenCode estão operacionais agora.

## Riscos/notas
- Não instalar/alterar nada sem confirmação (próximas fases planeadas: B workers → C novos agentes → D routers → E roles).
- Nunca imprimir valores de `~/.omniroute/.env` (contém chaves/encryption key).

## Revisão
- 2026-09-23 — inventário real (lots: versionamento, portas, dirs, `--help` dos CLIs).