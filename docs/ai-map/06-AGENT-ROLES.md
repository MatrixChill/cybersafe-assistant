# 06 — AGENT ROLES

## Estado Maestri preservado (antes de qualquer alteração — 2026-09-23)

Obtido com `maestri roles list` / `maestri agents` / `maestri preset list` — configuração existente NÃO foi alterada, apenas documentada.

- **Presets do Maestri**: `Claude Code`, `Codex`, `Antigravity`, `OpenCode`, `Shell`, `kilo`.
- **Roles existentes**: `Antigravity` (Lead/Maestro), `Technical Lead / Orchestrator`, `odex Lead — CyberSafe`, `Builder — CyberSafe`, `Test Engineer — CyberSafe`, `Reviewer — CyberSafe`, `Maestro temporario`.
- **Recruits conectados**: Codex Lead (🔴 quota), Kilo Builder (🟢), Freebuff Builder (🔴 quota), Crush Reviewer (🔴 quota), OpenCode (Maestro, 🟢).

## Roles-alvo (fase E)

| Role | Naixa atual | Proposta de preenchimento | Custo |
|---|---|---|---|
| **Maestro / Lead** | existe (`Maestro temporario`, Antigravity, Technical Lead) | OpenCode (confirmado) | €0 |
| **Builder** | existe (`Builder — CyberSafe`) | Kilo | €0 |
| **Alternative Builder** | **criar** | OpenClaude / Goose / Claude Code (backend local) | €0 |
| **Reviewer** | existe (`Reviewer — CyberSafe`) | Goose (`goose review`) ou Crush (quando reposto) | €0 |
| **Security Reviewer** | **criar** | Crush/Goose com regras de segurança (AGENTS.md) | €0 |
| **Tester** | existe (`Test Engineer — CyberSafe`) | **Shell sem LLM** (typecheck/testes/build/diff) | €0 |
| **Debugger** | **criar** | Kilo / Claude Code | €0 |
| **Local Worker** | **criar** | qwen-code + aider + copilot/cn (backend local OpenAI-compatible) | €0 |
| **Documentation** | **criar** | a atribuir (Goose/OpenClaude) | €0 |

Regras:
- Testes e validações → **Shell (sem LLM)** sempre que possível.
- Nunca 2 agentes a editar a mesma worktree; edição paralela só em floors/worktrees isoladas.
- Antes de alterar config Maestri existente: preservar (este ficheiro) e pedir confirmação.

## Backends gratuitos por agente (fase B/D — decidir antes de usar)

| Agente | Router/backend | Modelo | Quota | Fallback |
|---|---|---|---|---|
| Claude Code | AgentRouter (agentrouter.org) hoje; OmniRoute (20128) opcional | routed | €0 via router | sem Anthropic paga |
| Qwen Code | Ollama `http://127.0.0.1:11434/v1` (OpenAI-compatible; server a arrancar) | `qwen2.5-coder` (local) | €0 | `deepseek-coder`/`llama3` |
| Aider | Ollama base URL (config via `--openai-api-base`) | `qwen2.5-coder` | €0 | — |
| Goose | Ollama/OpenAI-compatible | local | €0 | — |
| OpenClaude | Ollama ou reutiliza `~/.codex/auth.json` | local | €0 | — |
| Qoder CLI | cloud (sign-in) — só se free tier justificar | — | free tier | — |
| Shell | — | — | — | Test runner sem LLM |

## Prioridade custo €0

1. Ler mapa relevante + código real (nunca inventar).
2. Validar com Shell (`04-TEST-COMMANDS.md`).
3. Preferir backends locais (Ollama) → em seguida routers (OmniRoute/9Router/AgentRouter).

## Revisão
- 2026-09-23 — estado preservado antes de alterar Maestri.