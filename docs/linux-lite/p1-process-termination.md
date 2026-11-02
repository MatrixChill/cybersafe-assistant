# P1 — Terminação de processos no Linux Lite

O que é implementado, o que é deliberadamente não implementado, e o que foi
medido. Nada aqui é inferido: cada número vem de uma execução registada.

## Contrato

A superfície é uma função só — `killProcessPlatform(pid, options)` em
`packages/core/src/process-termination-posix.ts`, reexportada por
`packages/core/src/index.ts`. O serviço usa-a no seam que em Windows era
`killProcessTree`:

| Plataforma | Ação real | Identidade revalidada por |
| --- | --- | --- |
| Windows (`win32`) | `taskkill /F /T /PID <pid>` — o mesmo código de sempre | CIM (`Win3_Process.CreationDate`) |
| POSIX | `process.kill(pid, sinal)` — sem shell, sem utilitário externo | `/proc/<pid>/stat` e `/proc/<pid>/status` |

A escolha é feita em tempo de chamada, não na importação. Por isso um teste em
Windows continua a ver `taskkill`, e um runner Linux nunca faz `spawn` de um
`.exe`.

`KillProcessResult` é o mesmo tipo nas duas plataformas, por isso o serviço não
precisa de dois caminhos de diagnóstico:

| Situação | `status` |
| --- | --- |
| processo desapareceu após o sinal | `ok` |
| processo ficou zombie (reap do pai pendente) | `ok` (dito no `stdout`) |
| PID reutilizado durante a espera | `not-found` + `pid reapareceu com identidade diferente` |
| alvo ignora o sinal até ao prazo | `timeout` + `SIGKILL exige confirmacao explicita separada` |
| recusa antes do sinal por privilégio | `access-denied` |
| recusa por identidade não provada | `failed` com o motivo nomeado |

## Recusas antes de qualquer sinal

`decidePosixTermination` corre **antes** de `process.kill`. Cada recusa tem um
nome, e o nome vai para o `error`:

| Motivo | Porque existe |
| --- | --- |
| `sem-identidade` | não há `/proc/<pid>` legível → «não consegui perguntar» ≠ «não existe» |
| `identidade-nao-confirma` | `starttime` do snapshot ≠ atual: é outro processo com o mesmo número |
| `nome-nao-corresponde` | `comm` de `/proc` sem relação com o nome selecionado (2.ª âncora; `/proc` corta o `comm` a 15 caracteres e o snapshot pode trazer o caminho, por isso comparámos a base do caminho, e prefixos só valem com 3+ caracteres) |
| `processo-zombie` / `processo-ja-terminou` | não há nada para matar |
| `thread-de-kernel` | `pid <= 2` ou `cmdline` vazio com pai ≤ 2 |
| `processo-proprio` | o serviço nunca se sinaliza a si próprio |
| `outro-utilizador` | UID efetivo diferente e não somos root — o kernel daria `EPERM`; recusar antes é mais honesto do que deixar o sinal adivinhar |

Proteção de **ancestrais e componentes do CyberSafe** não vive aqui: vive em
`classifyKillTarget` (`packages/core`), que é chamada pelo serviço antes de
qualquer query e tem a lista real de PID/caminhos internos. A medição em WSL2
mostrou porque é a divisão certa: recusar «filho direto do chamador» no guard do
sinal barrava processos legítimos do ecrã (falso positivo).

## Não implementado, de propósito

- **Escalonamento automático SIGTERM → SIGKILL.** SIGKILL é operação
  excecional e precisa de confirmação explícita separada; o pedido normal fica
  em `timeout` e diz isso mesmo.
- **Kill de grupo (`kill(-pgid)`)** — mataria o terminal ou o gestor de sessão
  de quem pediu.
- **`pidfd`.** Seria o mecanismo certo contra reutilização de PID
  (`pidfd_send_signal` prende o sinal à instância, não ao número). Node não
  expõe `pidfd_open` e não há addon nativo Linux neste projeto. O substituto
  honesto é revalidar `/proc/<pid>` imediatamente antes e depois do sinal; fica
  registado como **lacuna conhecida**, não como suporte.

## Registo (auditoria)

`actions.log` descreve o que **foi** executado. Em Windows a linha continua
byte a byte como estava (`Cmd=taskkill /F /T /PID <pid>`). Em POSIX escreve
`Cmd=kill(SIGTERM) PID=<pid>` — registar `taskkill` num sistema onde ele não
existe seria uma auditoria inventada.

## Estado das árvores de processos em Linux

A varredura de descendentes (`sweepProcessTree`) usa CIM, que é Windows. Em
POSIX o caminho do `timeout` devolve hoje uma falha explícita a dizer que a
fonte falhou — nunca um `killed` inventado. Enumerar descendentes por `/proc`
(`PPid` de cada PID) é o próximo passo e ainda não foi feito.

## Resultados medidos

Nenhum número abaixo é inferido; cada linha é uma execução com ambiente.

| Execução | Ambiente | Resultado |
| --- | --- | --- |
| `npm test -w @cybersafe/core` (suíte completa, inclui o novo módulo) | Windows 10.0.26300 x64, Node 26.3.0 | 1131 testes, **1099 pass, 0 fail** |
| `node --test test/process-termination-posix.test.js` | WSL2 · Ubuntu 26.04 LTS · kernel 6.6.114.1-microsoft-standard-WSL2 · Node 22.23.4 · uid 1000 **sem root** | 16 testes, **16 pass, 0 fail** |
| `scripts/posix-kill-live.mjs` — processos benignos reais | idem (WSL2, sem root) | **8/8 casos corretos** |
| subset de kill do serviço (`kill-contract`, `individual-process-termination`, `kill-blocked-log`, `auto-kill-guard`, `own-child-pid-identity`, `pid-reuse-real-identity`, `tp-f1-kill-disable`) | Windows (mesma máquina) | 7 ficheiros, 42 testes, **42 pass, 0 fail** |
| `npm test -w @cybersafe/service` (suíte completa) | Windows | 943 testes, 935 pass, **8 fail** — ver nota abaixo |

Dois ficheiros em `test/legacy-disabled/` (`kill-budget`, `process-kill`) **não
fazem parte** da suíte `npm test`, e falham ao importar
`../dist/engine.js` a partir da subpasta (resolvia `test/dist/engine.js`) —
defeito de caminho pré-existente, alheio a esta alteração, aqui apenas
registado.

Cenários vivos, um por um (WSL2, sem root):

1. SIGTERM num `sleep 30` filho → `status=ok` em **100 ms**, `comm=sleep`,
   `starttime=349`, e o PID desapareceu de `/proc` (`vivo-depois=nao`).
2. Snapshot com nome diferente do `comm` → recusado `nome-nao-corresponde`,
   **nenhum sinal enviado**, processo intacto.
3. Snapshot com `starttime` diferente → recusado `identidade-nao-confirma`,
   nenhum sinal, processo intacto.
4. `sh -c "trap '' TERM; sleep 30"` → `status=timeout` aos 1200 ms,
   `SIGKILL exige confirmacao explicita separada`, processo ainda vivo,
   **um único sinal enviado**.
5. O próprio PID → `processo-proprio`.
6. PID 1 (`init`) → `thread-de-kernel`.
7. PID 2 (`kthreadd`) → `thread-de-kernel`.
8. PID sem `/proc` → `sem-identidade` (recusa, não «assume que está bem»).

Nota sobre os 8 falhanços do serviço: são todos em
`test/p1-3-prefetch-isolation.test.js` e são asserções de **veredicto de scan**
(`inconclusive` com as regras `dangerous_file_extension,suspicious_location`,
produzidas em `packages/core/src/analysis.ts:209`) sobre ficheiros temporários
criados por esta máquina. Nenhum deles toca o caminho de terminação, e a causa
exata fica **por confirmar** — não é imputada a esta alteração sem prova. Os
7 ficheiros de kill acima correm todos verdes em Windows, que é o contrato que
tinha de ser preservado.

Ambiente de desenvolvimento: os testes de unidade POSIX correram em Windows
com um `/proc` falso injectável, e em Linux real com o mesmo `/proc` falso; os
cenários vivos correram só em Linux. O WSL2 **não** substitui a validação de um
desktop Linux instalado.

## Estado frente ao motor (medido, não inferido)

Desde `b0368de` o `process.killTree` **chega ao código POSIX em Linux**: a recusa
deixou de ser uma bandeira de plataforma e a revalidação passou a usar a fonte
despachada por plataforma (CIM no Windows, `/proc` no Linux).

Medido em WSL2 com `scripts/linux-lite/wsl-p1-kill.sh` — `Linux
6.6.114.1-microsoft-standard-WSL2 x86_64`, `node v22.23.4`, `uid=1000 (caioc)`,
**sem root**, serviço compilado do clone isolado, dois `sleep` benignos criados
pelo próprio script e a morte verificada por `/proc`, não pela resposta:

| pedido | resposta do motor | efeito verificado |
|---|---|---|
| `processes.list` | 95 processos | benigno presente: `name=sleep`, `user=caioc`, `path=/usr/lib/cargo/bin/coreutils/sleep`, `startedAt=2026-11-02T09:22:08.330Z` |
| `killTree {pid:1}` | `status:"protected"`, `protectedReason:"system-pid"`, `success:false` | PID 1 **vivo**; log do serviço: `Blocked attempt to kill protected process PID: 1 (system-pid)` |
| `killTree {pid:4000099}` (nunca existiu) | `status:"already-exited"`, `success:true` | sem directório `/proc`, nada sinalizado e **não** publicado `process.killed` |
| `killTree {pid:439}` (benigno) | `status:"killed"`, `target:{name:"sleep",path:"/usr/lib/cargo/bin/coreutils/sleep"}` | PID 439 **morto**; o irmão PID 440, sobre o qual nada foi pedido, continuou vivo |

O `target` devolvido vem da releitura de `/proc` imediatamente antes do sinal: o
`killed` acima é uma identidade confirmada, não um PID solto.

### O bilhete do GUI em POSIX (medido, `3fd9179`)

O ecrã não usa `killTree`: usa `process.termination.prepare` → `confirm`, cujo
`open` era o abridor de handle do Windows. Em POSIX não existe `pidfd_open`
exposto pelo Node, por isso o lease não pinha um objecto — pinha o `starttime`
lido no momento em que a seleção é aceite e relê `/proc` antes de cada leitura,
de cada decisão e antes do sinal. A garantia é mais fraca que um handle, e dizê-
lo seria mentir sobre atomicidade: a resposta vem com
`confirmation:"identity-reconfirmed"` (Windows continua `handle-signaled`).

Medido em WSL2 com `scripts/linux-lite/wsl-p1-ticket-inproc.sh` — mesmo
ambiente (`Linux 6.6.114.1-microsoft-standard-WSL2 x86_64`, `node v22.23.4`,
`uid=1000`, sem root), `/proc` real, sinais reais, dois `sleep` benignos, morte
verificada por `/proc`:

| passo | resultado medido | efeito verificado |
|---|---|---|
| linha do ecrã | `startedAt:"2026-11-02T09:57:53.0900000Z"`, sete casas, `exactCreationStamp` não-nulo | — |
| `prepare {pid,startedAt}` | `ok:true`, `target:{pid:450,name:"sleep"}` | nenhum sinal enviado |
| `confirm {ticket}` | `success:true`, `status:"killed"`, `confirmation:"identity-reconfirmed"`, `scope:"single-process"` | PID 450 **morto**; irmão 451 **vivo** |
| auditoria | `{pid:450,status:"killed",source:"user-confirmed"}` | — |
| `confirm` repetido com o mesmo bilhete | `success:false`, `status:"failed"` | nenhum segundo sinal |
| `prepare {pid:1}` | recusado antes do bilhete | PID 1 **vivo** |
| `prepare` de um processo `root` (PID 101) | `status:"protected"` | sem efeito |
| `prepare` com `starttime` adulterado numa casa | `status:"reused"` | alvo **vivo**, nenhum sinal |
| `prepare {pid:4000099}` | `status:"already-exited"` | sem efeito, sem `process.killed` |

Falta de formato que esta correção resolveu: `toISOString()` publica três
decimais e `exactCreationStamp` exige as sete do CIM, por isso uma linha Linux
morria no `prepare` por uma razão que não tinha nada a ver com o processo. A
fonte POSIX passou a emitir o mesmo corte (`criacaoPosix`), e a conversão é
lossless — `Date.parse` de `…3300000Z` e `…330Z` dá o mesmo milissegundo.

### SIGTERM e SIGKILL como duas operações, medidas em Linux

O objetivo pedia o pedido normal em SIGTERM e o SIGKILL como «operação separada,
excecional e explicitamente confirmada». Isso só é verdade se o sinal estiver
escolhido **antes** do bilhete existir, porque um `confirm {ticket}` que aceita
um sinal novo é o mesmo bilhete a fazer duas operações diferentes.

O contrato em `@cybersafe/shared-types`:

| Campo | Onde | O que fixa |
|---|---|---|
| `mode?: "sigterm" \| "sigkill"` | `ProcessTerminationSelection` | o sinal que o `prepare` vai pinar; ausente = `sigterm` |
| `mode` + `modes` | `ProcessTerminationPreparation` | o que **este bilhete** pinou e o que **esta plataforma** sabe oferecer |
| `signal?` | `ProcessTerminationResult` | o sinal efetivamente pedido; `undefined` = antes de haver bilhete |
| `modosTerminacao(plataforma)` | `@cybersafe/core` | o Windows anuncia `["sigterm"]`; POSIX anuncia os dois |

Consequências que a interface não pode esconder:

- `confirm` mantém aridade 1. Não existe parâmetro para trocar o sinal depois de
  confirmar — verificado por teste (`controller.confirm.length === 1`).
- A escalada é um **bilhete novo**: `prepare {pid, startedAt, mode:"sigkill"}` →
  `confirm {novo ticket}`. O utilizador confirma o SIGKILL uma segunda vez, com
  o nome do sinal no diálogo.
- O botão de escalada só aparece quando o bilhete anunciou `sigkill` **e** o
  pedido normal produziu `timeout`. Em Windows nenhuma das duas condições é
  alcançável, por isso a UI nunca mostra ali um botão sem mecanismo.
- A recusa de modo acontece antes de abrir seja o que for: nenhum lease, nenhum
  bilhete, nenhum sinal (`aberturas.length === 0` nos testes).

Medido em WSL2 a 2026-11-02 com `scripts/linux-lite/wsl-p1-sigkill.sh`
(`Linux 6.6.114.1-microsoft-standard-WSL2 x86_64`, `node v22.23.4`, `uid=1000`,
sem root, `hz=100`), contra um processo benigno criado pelo próprio probe
(`bash -c 'trap "" TERM INT HUP; …'`) — o único cenário que distingue as duas
operações é um alvo que **ignora** SIGTERM. Vida verificada por `/proc/<pid>/stat`:

| caso | `prepare` | `confirm` | vivo depois? |
|---|---|---|---|
| SIGTERM num processo que o ignora | `ok`, `mode:sigterm` | `timeout`, `signal:"sigterm"`, **sem `confirmation`** | **sim** — e o `timeout` declara insucesso |
| escalada SIGKILL com bilhete novo | `ok`, `mode:sigkill` | `killed`, `signal:"sigkill"`, `confirmation:"identity-reconfirmed"` | **não** |
| plataforma a anunciar só `["sigterm"]` pede `sigkill` | recusa: «A terminação imediata (SIGKILL) não está disponível nesta plataforma; nenhum bilhete foi emitido e nenhum sinal foi enviado.» | — | sim |
| modo mal formado (`"SIGKILL"`) | recusa: «Modo de terminação não reconhecido; nenhum bilhete foi emitido e nenhum sinal foi enviado.» | — | sim |

Os quatro casos saíram `CONFORME` do probe, que compara o resultado do
controlador com a vida lida no `/proc` — não com o que o código devolveu.

Um detalhe honesto do primeiro caso: o `timeout` traz o `signal` mas **não** traz
`confirmation`. A pinagem e o sinal aconteceram; a saída não aconteceu, e não há
prova de terminação a declarar. É por isso que a UI mostra «o processo continua
vivo» e oferece a escalada, em vez de um sucesso.

### O que ainda não funciona (sem fingir)

- **O bilhete ainda não foi medido através do socket.** O que está medido acima é
  o `SafeProcessTermination` + lease POSIX com o predicado de proteção do
  serviço, chamado diretamente. A viagem pelo pipe exige o handshake
  `auth-hello`/`auth-challenge`/`auth-response`; a sonda em
  `scripts/linux-lite/wsl-p1-ticket.sh` envia `{v:2}` (confirmado como número, e
  `PIPE_AUTH_VERSION === 2` nos dois lados) e recebe «Versão do protocolo do
  pipe não suportada». Causa ainda não encontrada — por isso o botão do GUI em
  Linux está **implementado e medido ao nível do motor**, não **validado na
  aplicação**. A validação real do percurso é a janela Electron num desktop
  Linux, que continua por fazer.
- O `success:true` de `already-exited` significa «o objetivo não está em
  execução», não «o CyberSafe terminou-o»; a UI não o pode mostrar como
  terminado por si.
- A escalada por `SIGKILL` está medida ao nível do motor e do contrato, mas o
  fluxo completo «SIGTERM ignora → modal oferece → segundo clique → bilhete
  novo» ainda não foi percorrido na janela Electron de um desktop Linux.

### Regressão Windows corrida com esta alteração

No clone isolado, com as alterações de cima aplicadas: `@cybersafe/core`
1159 testes, 1127 passam, 0 falham; `@cybersafe/service` compila (`tsc`) sem
erros; o subconjunto de kill/processo do serviço
(`auto-kill-guard`, `individual-process-termination`, `kill-blocked-log`,
`kill-contract`, `p1-process-truth`, `process-truth-ttl`,
`processes-list-contract`, `tp-f1-kill-disable`, `tp-f1-process-recovery`)
58 testes, 57 passam, 1 falha.

A falha é `tp-f1-process-recovery.test.js:80` —
«PID reutilizado: foto antiga + CIM com outra identidade → reused, sem
taskkill» — e espera `status:"reused"` de `engine.killProcess`, que a origem
Windows já não deixa acontecer: `packages/service/src/engine.ts` da branch de
origem tem `KILL_TERMINATION_DISABLED = true` (linha 769) e recusa no topo de
`killProcess` com `reason:"legacy-disabled"` (linhas 4149-4158, commit `a542cb4`,
ancestral de `freebuff/r7-final-integration-20261101`), devolvendo `failed`. O
caminho Windows deste teste está, portanto, morto na origem, não por este
trabalho Linux; a recusa continua a não ter efeito nenhum, que é o que o teste
também afirma.

### Regression corrida com os dois sinais (2026-11-02, host Windows, clone isolado)

| suite | resultado |
|---|---|
| `@cybersafe/core` completa | 1180 testes, **1148 passam, 0 falham**, 31 skipped (inclui os 8 novos de `safe-process-termination-modes.test.js`) |
| `@cybersafe/desktop` completa | 637 testes, **637 passam, 0 falham** (5 no ficheiro de terminação, incluindo o novo portão de modo fechado na ponte e o `mode` extraído no preload) |
| `@cybersafe/app` — `individual-process-termination.test.ts` | 10 testes, 10 passam (prova POSIX aceite, sinal trocado recusado, oferta de `sigkill` só quando anunciada, modal de escalada) |
| `@cybersafe/service` — `kill-contract` | 8 testes, 8 passam (o `killProcess` Windows continua fail-closed com `legacy-disabled`) |
| typecheck | `shared-types`, `core`, `desktop`, `service` compilam; `@cybersafe/app` `tsc -b` sem erros |

Omitir o que não é meu: a suite completa do `@cybersafe/service` termina com
**8 falhas** em caminhos de scanner/definições (`p1-3-prefetch-isolation`,
`scan-post-batch-no-double-clamav`, `engine-batch-cache-lookup` e outras, todas
`expected "safe", got "inconclusive"`). A causa foi medida, não assumida:
copiei o `engine.ts` alterado para fora, `git checkout HEAD --
packages/service/src/engine.ts`, reconstruí o serviço e corri o mesmo ficheiro —
7 das 11 falhas mantiveram-se. São, portanto, **anteriores a esta alteração**
nesta cópia isolada, e continuam por diagnosticar. Nada nesta secção afirma que
a suite do serviço está verde.
