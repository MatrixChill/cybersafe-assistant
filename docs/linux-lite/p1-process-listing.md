# P1 — Lista de processos no Linux Lite (medida)

Estado: **listagem operacional em Linux real (WSL2); terminação ainda bloqueada**
(ver «O que ainda não funciona» em baixo). Nada aqui está marcado como feito sem
medição.

## O problema medido, não assumido

O snapshot de processos do motor vinha de `ProcessMonitor`, que pertence a
`@cybersafe/native-windows` e executa `powershell.exe` com
`Get-CimInstance Win32_Process`. Em Linux isso não falha de forma ruidosa — em
WSL2 **a interop corre o PowerShell do Windows host e devolve processos do
Windows**. Medido antes desta alteração, dentro de Linux, com `process.platform
==="linux"`:

```
count=387
linha: System|pid=4|…|inicio=2026-11-02T07:06:15.6230220Z
linha: Secure System|pid=336|…
linha: Registry|pid=376|…
```

Três nomes que não existem no Linux, com PID do Windows e com `startedAt` em
formato .NET (7 dígitos fracionados). O ecrã mostraria uma lista de processos
falsa a passar por verdadeira — o pior resultado possível para um gestor de
tarefas. Esta é também uma limitação de método: **uma medição em WSL2 pode ser
contaminada pelo host Windows**. Numa VM/distro sem interop, o mesmo código
dava `spawn ENOENT` e uma lista vazia.

## A fonte agora

`packages/core/src/process-provider-posix.ts` lê `/proc` e é a fonte escolhida em
`engine.ts::enumerateProcesses()`:

| Plataforma | Fonte da foto | Fonte da revalidação |
| --- | --- | --- |
| `win32` | `ProcessMonitor` (CIM/PowerShell) — inalterado | CIM (`queryCimProcesses`) |
| POSIX | `/proc/<pid>/{stat,status,cmdline,exe}` | `/proc` (ainda não ligado ao kill) |

A escolha é feita em tempo de chamada, por `process.platform`, como no resto do
delta Linux Lite: o Windows continua a executar exatamente o mesmo caminho, e o
Linux nunca importa uma API Windows no seu.

### Campos e como são obtidos

| Campo | Fonte | Quando falta, o que aparece |
| --- | --- | --- |
| `pid`, `ppid`, `name` (`comm`), `state` | `/proc/<pid>/stat`, corte no 1.º `(` e no último `)` | linha ignorada |
| `startedAt` | `btime` de `/proc/stat` + `starttime`/`CLK_TCK` | `""` (ausência) |
| `cpu` | `utime+stime`; 1.ª foto = média da vida, seguintes = variação no intervalo | `0` |
| `memoryMb` | campo `rss` × `PAGESIZE` | `0` |
| `user` | `Uid:` de `/proc/<pid>/status` → `/etc/passwd`; senão `uid:<n>` | ausente só sem `Uid:` |
| `path` | `readlink /proc/<pid>/exe` | `""` (sem permissão) |
| `commandLine` | `/proc/<pid>/cmdline` com NUL → espaço | `""` |

Regras de honestidade embutidas:

- **`CLK_TCK`/`PAGESIZE` vêm de `getconf`.** Sem `getconf`, `startedAt` fica `""`
  e `cpu`/`memoryMb` ficam `0`. Assumir 100 Hz e 4 KiB daria números plausíveis
  e um instante de nascimento inventado — e o instante inventado é precisamente
  a âncora que a terminação usa para recusar. Um valor inventado aqui destrói a
  proteção do passo seguinte.
- **A amostra de CPU está ligada ao `starttime`.** PID reutilizado não herda a
  amostra anterior (`calcularCpuPercent` cai na média da vida), porque somar o
  CPU de um processo morto ao de um recém-nascido produziria um número falso
  alto.
- **Zero registos utilizáveis é falha, não lista vazia** — mesma política do CIM
  no Windows. `/proc` ilegível lança com a causa.
- Um PID que nasce entre o `readdir` e a leitura é ignorado; não rebenta a
  enumeração nem produz linha parcial.

## Resultados medidos

Ambiente: **WSL2, Ubuntu, kernel 6.6.114.1-microsoft-standard-WSL2, x86_64,
Node v22.23.4, uid 1000 (`caioc`), sem root**, repositório isolado
`~/cybersafe-linux-lite` na branch `experimental/linux-lite-qoder` @ `478047a`.
`getconf CLK_TCK=100`, `getconf PAGESIZE=4096`.

Fornecedor isolado, em Linux real (`scripts/linux-lite/wsl-p1-diag.sh`):

| Métrica | Valor |
| --- | --- |
| linhas na 1.ª enumeração | 28 (`startedAt` 28/28, `user` 28/28, `path` 4/28) |
| custo 1.ª / 2.ª enumeração | 7 ms / 2 ms |
| `constantes()` | `hz=100`, `pageSize=4096`, `bootMs` real |
| `path` em 24/28 porções | vazio — processos de `root` não dão `readlink` a uid 1000 (esperado, ausência mostrada como ausência) |

Serviço a responder pelo socket AF_UNIX (`scripts/linux-lite/wsl-p1-listing.sh`,
com um `sleep 600` benigno lançado pelo próprio script):

| Verificação | Resultado |
| --- | --- |
| `truth` | `{"state":"ok","servedFrom":"snapshot","attempt":{"ok":true}}` |
| `count` | 39 processos Linux reais |
| processo benigno presente | **sim** |
| linha do benigno | `pid=545 ppid=543 name="sleep" commandLine="sleep 600" user="caioc" cpu=0 ram=7.125MB startedAt=2026-11-02T08:55:37.250Z path=/usr/lib/cargo/bin/coreutils/sleep trusted="neutral"` |
| cobertura | `startedAt` 39/39, `user` 39/39, `path` 7/39 |
| nomes do Windows na lista | **nenhum** (o sintoma `System`/`Secure System`/`Registry` desapareceu) |
| `dist/engine.js` contém o ramo POSIX | sim (2 ocorrências de `posixProcessProvider`) |

Custo de uma foto completa, medido: ~6 ms (`attempt.startedAt`→`finishedAt`),
sem spawn de processo externo — contra ~0,3–2 s de um CIM no Windows.

## Regressão Windows

`engine.ts` é código partilhado, portanto foi exercitado no clone isolado:

- `npm test -w @cybersafe/core`: **1143 testes, 1111 pass, 0 fail, 31 skipped**
  (inclui os 12 novos do fornecedor POSIX).
- `npm test -w @cybersafe/service`: **943 testes, 935 pass, 8 fail**. Os 8 são
  os mesmos `P1-3 … prefetch` que já falhavam antes deste trabalho (veredicto
  `inconclusive` em `analysis.ts`) e a causa continua **não confirmada**; não
  são desta alteração e não são de terminação de processos.
- O ramo Windows de `enumerateProcesses()` continua a ser
  `this.processMonitor.list()`, sem alterações no `ProcessMonitor`.

## O que ainda não funciona (sem fingir)

A terminação **não está operacional no Linux** por duas razões independentes e
ambas reais:

1. `ProtectionEngineService.KILL_TERMINATION_DISABLED` é `true` sem olhar para a
   plataforma, por isso `killProcess` recusa logo no início com
   `status:"failed"` / razão `legacy-disabled`. É uma decisão do ramo Windows
   (identidade revalidada mas ação não atómica) que não deve ser revertida por
   mim; a sua revisão para POSIX tem de ser explícita e documentada, não um
   efeito colateral.
2. O passo «a fonte é consultada ANTES de agir, SEMPRE» chama
   `queryCimProcesses`, que não tem equivalente POSIX ligado. Em Linux isso
   daria `Identidade do processo não confirmada: a fonte CIM falhou` — recusa
   correta, mas nenhuma ação.

O módulo de terminação POSIX (`process-termination-posix.ts`, 16 testes + 8
cenários ao vivo medidos em WSL2) já existe e está correto ao nível do
processo; falta ligá-lo ao motor com uma fonte de revalidação `/proc` e decidir
a porta de entrada do sinal. Próximo passo nessa ordem.
