# 00 — START HERE

Mapa de contexto para agentes no repositório **CyberSafe Assistant**.
Entrada da cadeia de contextos: 00 → 01 → 02 → 03 → 04 → 05 → 06.

Prioridade operacional: **custo €0** na infraestrutura multiagente (backends locais/OpenAI-compatible, nunca chaves pagas por defeito).

## Como usar

1. Lê este ficheiro.
2. Abre **apenas** o mapa relevante para a tarefa:
   - "onde está X no código?" → `02-FILE-MAP.md`
   - "como flui X? IPC/pipe/eventos?" → `03-CRITICAL-FLOWS.md`
   - "que comandos validam o trabalho?" → `04-TEST-COMMANDS.md`
   - "qual o estado atual do repo/infra?" → `05-CURRENT-STATE.md`
   - "quem faz o quê nesta equipa?" → `06-AGENT-ROLES.md`
3. Verifica **sempre o código real** antes de afirmar comportamento; nunca inventes caminhos.

## Âncora de arquitetura

Consola Electron (`packages/desktop`) + serviço de fundo (`packages/service`, named pipe JSON) + motor (`packages/core`) + bridge Windows (`packages/native-windows`) + UI React (`packages/app`) + API REST / IA Matrix (`packages/api`) + scanner nativo C++ (`packages/native-engine`).

## Revisão

- 2026-09-23 — criado (FASE A da reorganização multiagente, custo €0).