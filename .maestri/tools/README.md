# .maestri/tools — verificação mecânica do Maestri

Infraestrutura **fora do produto**. Nada aqui escreve em `packages/`, `assets/` ou source.
Requer Python 3 e o CLI `maestri` no PATH. Sem dependências externas, sem daemon.

Comando único de validação (últimos 5 minutos de qualquer janela):

```bash
python .maestri/tools/maestro.py selfcheck
```

| Comando | O que faz | Saída útil |
|---|---|---|
| `selfcheck` | skills + capacidades + suite de packets + ownership + roles | `RESULT: OK` ou lista de falhas |
| `packet-validate <f.json>` | valida um Task Packet (skills, gates, campos) | `PACKET_VALID` / `PACKET_INVALID` + exit code |
| `route <f.json>` | routing determinístico por `TYPE` | agente + skills + avisos de perfil |
| `routing-eval` | 8 cenários fictícios: writer/reviewer/skills/Luna/premium | tabela + `PERFIL:` se algo não bate |
| `ownership-check <scope> <writer>` | 1 writer por scope | `CONFLITO` + exit 1 se outro writer ativo |
| `ownership-claim <t.json>` | reserva ownership (TASK/WRITER/REVIEWER/FILES) | `OWNERSHIP_CLAIMED` |
| `ownership-transfer <task> <writer> "motivo"` | reassign explícito do Maestro | `OWNERSHIP_TRANSFERRED` |
| `ownership-show` | estado de ownership | JSON |
| `health` | presença sob demanda (`maestri check` por agente) | CONNECTED / IDLE / **WORKING só se output mudou** |
| `event <EVENT> <task> <agent> "<evidencia>"` | ledger `.maestri/state/events.jsonl` | recusa `WORK_STARTED/DONE` sem evidence |
| `ledger [n]` | últimos eventos | uma linha JSON por evento |
| `skills-audit` | spec Agent Skills + drift de mirrors + manifesto | `spec_problems`, `stale_mirrors` |
| `agent-skills` | matriz AGENT → skills | lista + skills inexistentes |
| `state-write` / `state-show` | estado operacional machine-readable | `.maestri/state/maestro-state.json` |
| `git-sync` | estado Git/remote read-only: ahead/behind/dirty, security preflight, COMMIT_PLAN | `SYNC_STATE`, `SYNC_READY`, `COMMIT_PLAN` |
| `session-checkpoint` | checkpoint de fecho de sessao (sync + tasks + blockers + Luna) | protocolo curto para o proximo Maestro |
| `guardrail-resolve "<cmd>"` | resolve a policy bash do OpenCode **sem executar** | ALLOW/DENY/ASK + regra aplicada |
| `failover-show` | cadeia de failover + classes de custo | 2 fallbacks por agente |

## Ficheiros de estado (fonte authoritative)

- `.maestri/state/maestro-state.json` — estado operacional (agentes, ownership, Luna, blockers, `updatedAt`)
- `.maestri/state/ownership.json` — 1 writer por scope
- `.maestri/state/events.jsonl` — ledger de eventos (append-only)
- `.maestri/state/skills-manifest.json` — checksums, spec e mirrors das skills
- `.maestri/state/health.json` — último output observado por agente

A Note `MAESTRI_STATE` é a vista humana renderizada a partir do JSON. Se divergirem, **o JSON ganha**.

## Notas de uso

- Estados: `REGISTERED CONNECTED IDLE WORKING BLOCKED RATE_LIMITED PARKED DEAD EXTERNAL_READY`
- `CONNECTED != WORKING`. `WORKING` exige output mudou face ao snapshot anterior.
- Nunca escrever `WORK_STARTED`/`DONE` sem evidence: o comando recusa.
- Packets de teste em `.maestri/tools/packets/` (`F-*` é o caso negativo esperado).