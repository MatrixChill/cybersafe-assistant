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

### O que ainda não funciona (sem fingir)

- **O botão do GUI ainda não termina nada em Linux.** O ecrã usa o protocolo de
  bilhete (`process.termination.prepare` → `confirm`), não o `killTree`. Medido:
  `prepare` devolve `{ok:false,status:"protected",error:"Sessão não autenticada;
  nenhuma terminação foi enviada."}` — sem bilhete e sem efeito. Dois motivos
  separados: (1) o bilhete exige a sessão autenticada que só a aplicação
  Electron tem, e um pedido por socket cru não a possui; (2) mesmo com sessão,
  `SafeProcessTermination` recebe `openIndividualProcess`, o abridor de handle
  do Windows. Falta um equivalente POSIX antes de anunciar o botão como
  funcional.
- O `success:true` de `already-exited` significa «o objetivo não está em
  execução», não «o CyberSafe terminou-o»; a UI não o pode mostrar como
  terminado por si.
- O SIGKILL como operação separada e explicitamente confirmada ainda não tem
  pedido próprio no contrato — hoje só existe o pedido normal (SIGTERM).
