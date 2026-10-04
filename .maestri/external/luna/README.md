# Luna External Worker - Bridge Protocol

EXPERIMENTAL EXTERNAL UTILITY / OVERFLOW. Not a member of the Maestri pool.

## What this is

A file-only bridge that lets an external agent (ChatGPT / Luna, driven by a
Remote Desktop Commander on this machine) receive a Task Packet and return a
HANDOFF, without integrating into the Maestri canvas.

    Maestro -> writes TASK.md -> human hands it to the external agent
           -> agent works -> agent writes HANDOFF.md -> Maestro resumes

## What this is NOT

- Not a daemon, not a service, not an API, not a bridge daemon.
- Not integrated in `maestri list`. No role, no terminal, no canvas node.
- Not a premium brain. It never decides architecture or security.
- Not a replacement for any existing agent.

## The three files

| File | Written by | Purpose |
|---|---|---|
| `README.md` | Maestro | this protocol, the rules, the reuse recipe |
| `TASK.md` | Maestro | the Task Packet for one unit of work |
| `HANDOFF.md` | external agent | the structured result, read back by Maestro |

Never put secrets, tokens, transcripts or full agent logs in this directory.

## Task Packet format (TASK.md)

    OBJETIVO    = one sentence, the outcome, not the method
    PRIORIDADE  = P0 / P1 / P2, and why it is that
    SCOPE       = the exact files or directories allowed
    FORA DO SCOPE = everything else, named explicitly
    ACCEPTANCE  = the observable conditions that mean done
    TESTES      = the exact commands that must be run, and expected results
    RESTRIÇÕES  = hard prohibitions, always present

## Handoff format (HANDOFF.md)

    TAREFA      = what was asked
    ESTADO      = DONE / READY FOR MANUAL TEST / BLOCKED
    CONFIRMADO  = what you actually verified, with numbers
    FICHEIROS   = what you touched, or NONE
    TESTES      = commands run and their real results
    BLOQUEIO    = the exact blocker, or NONE
    PROXIMO PASSO = the single next action

Never hand back a transcript. Never hand back a claim you did not verify.

## Git safety the external worker inherits

Forbidden, without exception:

    git reset
    git restore
    git checkout --
    git clean
    git stash
    push
    force push
    automatic commit

Mandatory around any file change:

    git status           before
    focused tests        after
    git diff             after
    git diff --check     after

## Security posture for the POC

The Remote Desktop Commander has strong access to this machine. The POC assumes:

- runs as the normal user, never as Administrator
- no access to `.env` files, SSH keys, browser cookies or sessions
- never prints tokens, keys or secrets
- never changes credentials
- stays inside the CyberSafe repository
- read-only for the first test, without exception

## The governance risk, stated plainly

The external agent has the same machine access as the other eleven agents. The
only difference is cost. What it does NOT have is our ownership discipline: it
is invisible to `maestri list`, so nothing prevents it from editing a file that
a live writer owns.

Therefore: the external worker is only allowed while no writer session is active,
or only against files no live writer owns. The Maestro declares that in the
`FORA DO SCOPE` field of every packet.

## When to use it

Good fits: read-only investigation, locating an implementation, reading logs,
running tests, triaging a pile of findings, writing documentation, comparing
outputs, preparing a diagnosis or a HANDOFF for a real agent, very small and
very well delimited patches.

Bad fits: architecture, security decisions, large refactors, multi-package
dangerous changes, destructive git, push, product decisions, anything a cheap
local agent can already do.

## Reuse recipe

1. Maestro picks a task that is genuinely cheap and genuinely read-only or tiny.
2. Maestro writes `TASK.md` with the full format, naming the live writers.
3. Maestro tells the human which files are owned by an active writer.
4. Human hands `TASK.md` to the external agent.
5. Agent writes `HANDOFF.md`.
6. Human tells Maestro that the handoff is ready.
7. Maestro reads the handoff and decides: act, escalate, or discard.
8. Maestro clears `TASK.md` and `HANDOFF.md` back to template state.
