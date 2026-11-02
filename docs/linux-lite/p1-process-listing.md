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

Actualizado após `b0368de`. As duas razões que impediam a terminação em Linux
foram tratadas e **medidas a funcionar**: `KILL_TERMINATION_DISABLED` deixou de
ser aplicada às plataformas POSIX (a recusa passou a ser por cadeia de
identidade, com o motivo nomeado) e o passo «a fonte é consultada ANTES de agir»
usa agora `consultarFonteIdentidade` → `/proc` fora do Windows. `process.killTree`
termina hoje um processo benigno real em WSL2 e recusa o PID 1 sem qualquer
efeito — resultados e método em `p1-process-termination.md`, secção «Estado
frente ao motor».

O que continua em falta:

1. **O botão do Gestor de Tarefas não usa `killTree`.** Usa o protocolo de
   bilhete `process.termination.prepare`/`confirm`, cujo `open` é
   `openIndividualProcess` — o abridor de handle do Windows. Medido: `prepare`
   responde `Sessão não autenticada` a um pedido por socket cru e nunca chega ao
   abridor. Enquanto o bilhete não tiver um equivalente POSIX, a terminação está
   operacional ao nível do motor, **não** ao nível da GUI.
2. SIGKILL como operação separada e explicitamente confirmada não tem pedido
   próprio no contrato partilhado.

## Falhas de teste pré-existentes que não são deste ramo

A regressão Windows do pacote `@cybersafe/service` neste clone: **943 testes,
935 passam, 8 falham**. As 8 falhas são todas da família de cache/prefetch do
ClamAV (`p1-3-prefetch-isolation`, `engine-batch-cache-lookup`,
`scan-post-batch-no-double-clamav`), com o mesmo sintoma: um veredicto `clean`
em cache produz `inconclusive` em vez de `safe`, com as regras
`dangerous_file_extension,suspicious_location` aplicadas ao ficheiro de
temporário do teste. **Não são causadas pelas alterações Linux**: as mesmas 8
reproduzem-se com o `engine.ts` de `HEAD` (revertido, recompilado e testado) e
reproduzem-se isoladamente. Os suites de processo e terminação, corridos em
separado neste clone Windows (`kill-contract`, `processes-list-contract`,
`individual-process-termination`, `kill-blocked-log`, `auto-kill-guard`,
`pid-reuse-real-identity`, `dev-windows-readonly`): **141 testes, 141 passam, 0
falham** — incluindo o protocolo de bilhete, que é código Windows intocado.
Fica registado como defeito do caminho de análise a reportar, não como efeito
colateral deste trabalho.
