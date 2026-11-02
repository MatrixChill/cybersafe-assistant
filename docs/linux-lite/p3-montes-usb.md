# P3 (Linux Lite) — descoberta de volumes montados, sem letras de unidade

Âmbito deste corte: **descobrir e medir os volumes reais de Linux** — a base do
«USB e armazenamento» do plano (§10) e do estado de armazenamento do PC Center
(§6). A descoberta está medida em máquina real; **ainda não está ligada ao
scanner nem ao ecrã**, e isso está declarado no fim desta página em vez de ser
apresentado como concluído.

## Porque não o caminho do Windows

`packages/native-windows/src/usb-storage.ts` enumera USB com quatro consultas
`Get-CimInstance` em PowerShell, e os volumes chegam a `packages/core/src/disk.ts`
por `systeminformation.fsSize()`, cujo `mount` é uma letra (`C:`). Em Linux não
existe nenhuma das duas coisas: nem CIM, nem letras. O que existe é
`/proc/self/mountinfo` — a mesma tabela que `findmnt` lê — onde cada linha
declara ponto de montagem, `major:minor` do dispositivo, sistema de ficheiros,
fonte e opções. É essa a fonte escolhida, porque é a mesma onde o scanner voltará
a procurar antes de aceitar um alvo.

## O módulo

`packages/core/src/mounts-posix.ts` (exportado por `core/src/index.ts`, puro e
com a FS injectável, igual ao padrão de `process-provider-posix.ts`):

| Função | O que faz |
|---|---|
| `parseMountinfo(texto)` | decompõe a tabela, desescapa `\x20`/`\x09`/`\x0a`/`\x5c` e conta as linhas ilegíveis |
| `lerMontagensPosix(fs, caminho?)` | mede capacidade com `fs.statfsSync`, dedupe por `major:minor`, exclui pseudo-FS e devolve a entrada que `describeDiskRead` já sabe ler |
| `escolheMontagemPrincipal(volumes)` | em Linux o volume que representa a máquina é o que hospeda `/` |

Regras que este módulo existe para não violar:

- **A letra não é identidade.** Um `/mnt/c` de WSL2 chega com `mount: "/mnt/c"`
  e `source: "C:\\134"`: a letra fica no campo que o kernel reportou, nunca no
  ponto de montagem nem na identidade do volume.
- **Pseudo-FS não é disco.** `proc`, `sysfs`, `devtmpfs`, `tmpfs`, `cgroup2`,
  `overlay`, `rootfs`, `debugfs` … são excluídos **e contados** (`excluidos`),
  para que «zero volumes» se distinga de «não consegui ler a tabela».
- **Livre é o que o utilizador pode escrever.** Usa-se `bavail`, não `bfree`:
  num ext4 com blocos reservados ao root, `bfree` inflaciona o espaço que a
  análise de ocupação mostra.
- **Um `statfs` que falha não apaga os outros**; o ponto de montagem fica em
  `naoMedidos` com o resto da lista publicado.
- **Capacidade medida ≠ volume utilizável.** Um `9p` de leitor de cartões sem
  cartão reporta blocos quase nulos com percentagem de «uso» alta. Não é disco
  de trabalho e a categoria Windows «reservado pelo sistema» não significa nada
  aqui, por isso fica em `semCapacidadeUtil` em vez de aparecer como disco.

## Medido em Linux real

Ambiente: WSL2, `Linux 6.6.114.1-microsoft-standard-WSL2 x86_64`, uid 1000,
Node 22.23.4, código `packages/core/dist` compilado deste branch. Reproduzir:

```bash
wsl -e bash -lc 'S=/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo/scripts/linux-lite; \
  tr -d "\015" < $S/wsl-p3-montes.sh > /tmp/montes.sh && bash /tmp/montes.sh'
```

Saída (verificada, não transcrita de memória):

```text
MONTES {"plataforma":"linux","ok":true,"motivo":null,"linhasMountinfo":40,"ilegiveis":0,
  "excluidos":[{"fileSystem":"tmpfs","montantes":16},{"fileSystem":"overlay","montantes":4},
    {"fileSystem":"cgroup2","montantes":1},{"fileSystem":"proc","montantes":1}, …],
  "naoMedidos":[], "semCapacidadeUtil":["/mnt/d"],
  "volumes":[
    {"mount":"/","fs":"ext4","source":"/dev/sdd","dev":"8:48","ro":false,"totalGiB":1007,"disponivelGiB":940,"montagens":["/","/mnt/wslg/distro"]},
    {"mount":"/mnt/c","fs":"9p","source":"C:\\134","dev":"0:70","ro":false,"totalGiB":953,"disponivelGiB":147},
    {"mount":"/mnt/e","fs":"9p","source":"E:\\134","dev":"0:72","ro":false,"totalGiB":596,"disponivelGiB":595},
    {"mount":"/mnt/f","fs":"9p","source":"F:\\134","dev":"0:73","ro":false,"totalGiB":476,"disponivelGiB":192},
    {"mount":"/usr/lib/wsl/drivers","fs":"9p","source":"drivers","dev":"0:34","ro":true,"totalGiB":953,"disponivelGiB":147}]}
DISCO {"ok":true,"volumes":[{"mount":"/mnt/c","kind":"working","uso":84.6},{"mount":"/","kind":"working","fs":"ext4","uso":1.6}, …],
  "primarioDiskTs":"/mnt/c","primarioLinux":"/"}
```

Leitura honesta do que saiu:

1. **Dedupe funcionou num caso real:** `/`, `/home` e `/mnt/wslg/distro` são o
   mesmo `8:48`; a máquina tem um disco de sistema, não três.
2. **`/usr/lib/wsl/drivers` é só-leitura porque a tabela o diz** (`ro` nas
   opções de montagem). Era a única montagem `ro` da máquina e foi a única
   reportada como tal.
3. **`/mnt/d` sem suporte montado ficou de fora.** Antes do filtro de
   capacidade, a mesma máquina publicava `/mnt/d` com 0 GB totais e 64% de «uso»
   e classificava-o `system-reserved`. Isso era uma regra do Windows (partição de
   arranque de 52 MB) aplicada a um leitor de cartões vazio.
4. **O primário do Windows não serve ao Linux:** `pickPrimaryVolume` procura a
   letra `C:`, não encontra, e devolve o volume mais cheio — aqui `/mnt/c`, o
   disco do Windows, 84,6% cheio. `escolheMontagemPrincipal` devolve `/`. Ainda
   não há decisão de produto sobre qual deve aparecer no cabeçalho do PC Center
   em WSL; os dois números são mostrados pela sonda para essa decisão se poder
   tomar com facto visto.

## Testes

`packages/core/test/p3-montes-posix.test.js` — 11 casos, com a tabela real de
WSL2 como fixture: volumes e origem `C:\134` sem letra no `mount`; dedupe por
dispositivo com as montagens registadas; `bavail` vs `bfree`; pseudo-FS excluídos
**e** contados; `statfs` falhado isolado; todas-as-montagens-sem-capacidade como
falha com motivo; tabela ilegível com motivo que nomeia a tabela; espaço escapado
desescapado **antes** do `statfs`; linha ilegível contada; leitor sem cartão fora
da lista; primário `/`.

Regressão no clone isolado (win32, Node 26.3.0): `@cybersafe/core` 1201 testes,
1169 passados, **0 falhas**, 31 `skip` e 1 `todo` — os mesmos `skip` anteriores a
este corte (dependentes de Windows/DCOM); `@cybersafe/app` 2877/2877;
`@cybersafe/desktop` 645/645. O corte não altera `disk.ts` nem `hardware.ts`, por
isso o caminho Windows está byte-a-byte igual.

## Ainda não feito (não declarar como feito)

- **Ligação ao ecrã e ao scanner.** O PC Center continua a obter volumes de
  `si.fsSize()`; `lerMontagensPosix` não é chamado por nenhum caminho de runtime.
  O passo seguinte é escolher no `engine.ts` a fonte por `process.platform` e
  decidir o primário, com medição antes e depois.
- **Nenhum volume amovível foi medido.** A máquina da medição não tinha USB
  ligado; não há leitura de `/sys/block/<dev>/removable` nem claims de
  «unidade amovível detetada». A coluna `removable` não existe neste corte
  exatamente por isso.
- **Montar, formatar, reparar ou apagar:** nada implementado, nada proposto.
- **Página Otimizar/Firewall (§11)** e quarentena/histórico (§9): por fazer.
