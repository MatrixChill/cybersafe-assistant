# P3 (Linux Lite) — descoberta de volumes montados, sem letras de unidade

Âmbito: **descobrir, medir, publicar e tornar analisáveis os volumes reais de
Linux** — a base do «USB e armazenamento» do plano (§10) e do estado de
armazenamento do PC Center (§6). Está medido em máquina real e **ligado ao
motor** (`hardware.ts` escolhe a fonte por plataforma), e o alvo selecionável já
existe como gesto. O que **não** está medido — a deteção positiva com uma pen
ligada — continua declarado no fim desta página em vez de apresentado como
concluído.

## Porque não o caminho do Windows

`packages/native-windows/src/usb-storage.ts` enumera USB com quatro consultas
`Get-CimInstance` em PowerShell, e os volumes chegam a `packages/core/src/disk.ts`
por `systeminformation.fsSize()`, cujo `mount` é uma letra (`C:`). Em Linux não
existe nenhuma das duas coisas: nem CIM, nem letras.

**Correção a esta página (mediação feita depois):** uma versão anterior disto
dava a entender que `si.fsSize()` não funcionava em Linux. Funciona — medido em
WSL2: `SI {"ok":true,"ms":1055,"entradas":10,…}`. A troca de fonte não é por a
bibliotecaria falhar; é por o que ela devolve não ser verdade sobre a máquina:

| O que `si.fsSize()` reporta | O que é na máquina |
|---|---|
| 10 «volumes» | 5 sistemas de ficheiros; o mesmo 9p `C:\134` sai como `/mnt/c` **e** como `/usr/lib/wsl/drivers` |
| 4 linhas `overlay` de 8 GiB (`/usr/lib/modules/…`, `/usr/lib/wsl/lib`, `/mnt/wslg/versions.txt`, `/mnt/wslg/doc`) | pseudo-FS do container, não discos |
| `/mnt/d` com `totalGiB: 0` e `usadoPct: 64.24` | leitor de cartões 9p sem cartão |
| nenhum campo de dispositivo | sem `major:minor` não há forma de saber que duas linhas são o mesmo disco |

A fonte escolhida é `/proc/self/mountinfo` — a mesma tabela que `findmnt` lê —
onde cada linha declara ponto de montagem, `major:minor`, sistema de ficheiros,
fonte e opções, e a capacidade vem de `statfs` sobre o ponto desescapado. É
também a mesma tabela onde o scanner vai voltar a procurar antes de aceitar um
alvo.

## O módulo

`packages/core/src/mounts-posix.ts` (exportado por `core/src/index.ts`, puro e
com a FS injectável, igual ao padrão de `process-provider-posix.ts`):

| Função | O que faz |
|---|---|
| `parseMountinfo(texto)` | decompõe a tabela, desescapa `\x20`/`\x09`/`\x0a`/`\x5c` e conta as linhas ilegíveis |
| `lerMontagensPosix(fs, caminho?)` | mede capacidade com `fs.statfsSync`, dedupe por `major:minor`, exclui pseudo-FS e devolve a entrada que `describeDiskRead` já sabe ler |
| `escolheMontagemPrincipal(volumes)` | em Linux o volume que representa a máquina é o que hospeda `/` |
| `lerMontagensReais(caminho?)` | a mesma leitura com o `/proc` do sistema; é a alça que o motor usa e a única que toca no disco |

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
SI {"ok":true,"ms":1055,"entradas":10,"volumes":[{"mount":"/usr/lib/modules/6.6.114.1-microsoft-standard-WSL2","fs":"overlay","totalGiB":8,"usadoPct":0},
   {"mount":"/usr/lib/wsl/drivers","fs":"9p","totalGiB":953,"usadoPct":84.61},{"mount":"/","fs":"ext4","totalGiB":1007,"usadoPct":1.63}, …,
   {"mount":"/mnt/d","fs":"9p","totalGiB":0,"usadoPct":64.24}]}
```

E a mesma tabela a sair pelo **motor ligado** (`packages/core/dist/hardware.js`,
donde o PC Center consome), não por uma função isolada:

```bash
wsl -e bash -lc 'S=/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo/scripts/linux-lite; \
  tr -d "\015" < $S/wsl-p3-motor-disco.sh > /tmp/motor.sh && bash /tmp/motor.sh'
```

```text
MOTOR {"plataforma":"linux","leitura":"ok","motivo":null,"primario":"/","usoPrimario":1.6,
  "volumes":[{"mount":"/mnt/c","fs":"9p","tipo":"working","ro":false,"uso":84.6,"livreGiB":146.6},
    {"mount":"/usr/lib/wsl/drivers","fs":"9p","tipo":"working","ro":true,"uso":84.6,"livreGiB":146.6},
    {"mount":"/mnt/f","fs":"9p","tipo":"working","ro":false,"uso":59.8,"livreGiB":191.6},
    {"mount":"/","fs":"ext4","tipo":"working","ro":false,"uso":1.6,"livreGiB":940},
    {"mount":"/mnt/e","fs":"9p","tipo":"working","ro":false,"uso":0.1,"livreGiB":595.1}],
  "alertasDisco":["Espaço em disco baixo em /mnt/c"]}
```

Do `MOTOR` tiram-se três factos que só o caminho ligado pode dar: `hardware.js`
**carrega** em Linux apesar de importar `win-kernel.js`/`win-pdh.js` (nenhum
erro de `koffi` na consola), o primário publicado é `/` a 1,6% — antes era
`/mnt/c` a 84,6% — e o alarme de espaço saiu de `/mnt/c` (gravável) e não de
`/usr/lib/wsl/drivers` (o espelho `ro` do Windows, que empata o mesmo 84,6%).

Leitura honesta do que saiu:

1. **Dedupe funcionou num caso real:** `/` e `/mnt/wslg/distro` são o mesmo
   `8:48`; a máquina tem um disco de sistema, não dois. A lista publicada traz
   um volume com `montagens: ["/", "/mnt/wslg/distro"]`.
2. **`/usr/lib/wsl/drivers` é só-leitura porque a tabela o diz** (`ro` nas
   opções de montagem). Era a única montagem `ro` da máquina e foi a única
   reportada como tal.
3. **`/mnt/d` sem suporte montado ficou de fora.** Antes do filtro de
   capacidade, a mesma máquina publicava `/mnt/d` com 0 GB totais e 64% de «uso»
   e classificava-o `system-reserved`. Isso era uma regra do Windows (partição de
   arranque de 52 MB) aplicada a um leitor de cartões vazio.
4. **O primário do Windows não serve ao Linux, e a decisão está tomada em
   código:** `pickPrimaryVolume` procurava a letra `C:`, não a encontrava e
   caía no volume mais cheio — aqui `/mnt/c`, o disco do Windows a 84,6%. Em
   `disk.ts`, depois da letra `C:` e antes da queda para «o mais cheio», passou
   a procurar a montagem `/`. Em Windows a linha extra nada faz (nenhum volume
   `fsSize()` tem montagem exatamente `/`), e há testes para os três ramos.
5. **O alarme de pouco espaço deixou de poder apontar para um volume
   só-leitura.** Não é preferência de plataforma: o texto do alarme manda
   «libertar espaço neste volume», o que é inexecutável num `ro` — em Windows o
   mesmo raciocínio vale para um DVD/ISO montado ou uma partição protegida.

## Deteção USB em Linux (`usb-posix.ts` + a porta do monitor)

O pedido de análise de um volume já tem caminho feito no serviço:
`usb-protection.ts` (o monitor), `usb-scan-adapter.ts` (força `readOnly: true`
e recusa sem contrato de leitura pura) e a porta `PortaDeteccaoUsb`. O que
faltava era a **fonte** em Linux: `engine.ts` chamava `criarDeteccaoUsbNativa()`
sem perguntar a plataforma, e essa função enumera por CIM em PowerShell. Em
Linux o resultado seria sempre uma falha de enumeração — e uma pen verdadeira
nunca chegaria a aparecer. Por isso a linha passou a ser
`process.platform === "linux" ? criarDeteccaoUsbPosix() : criarDeteccaoUsbNativa()`;
o ramo Windows é a linha exata que lá estava.

A regra espelha a do Windows — **armazenamento E transporte, nunca um atributo
só** (um `DriveType = 2` isolado não chega; `removable` isolado também não):

| Fato | Onde vive | Como é lido |
|---|---|---|
| Transporte USB | `readlink` de `/sys/block/<dev>` | um segmento `usb<N>` no caminho até à raiz do sysfs é o controlador; `usb1:1.0` (a interface) não conta |
| Volume montado | `/proc/self/mountinfo` | join pelo `major:minor` do disco **e** das partições, com os pseudo-FS de `mounts-posix.ts` excluídos |
| Identidade da inserção | `/sys/block/<dev>/device/serial` | com serial → `usb-serial:<serial>` / `sysfs-serial`; sem serial → `usb-index:<nome>` / `disk-index-fallback` |
| Amovível | `/sys/block/<dev>/removable` | `1`/`0`; ausente é `null`, não `false` |

Três decisões que este corte toma para não mentir:

- **sem serial, sem auto-scan.** `disk-index-fallback` é a proveniência que o
  monitor já recusa, porque `sdb` é reciclável entre inserções. Não inventei
  identidade estável onde o kernel não a dá — passei a recusa para Linux em vez
  de a contornar.
- **`listarPendentes` não é implementado.** O estado de espera do Windows existe
  porque um disco pode ganhar letra mais tarde, e o motivo que o monitor mostra
  nomeia essa letra («a aguardar volume (letra) do Windows»). Em Linux um disco
  sem volume não tem nada a aguardar por nós — montar seria ação privilegiada,
  que o plano proíbe. Fica em `semVolume`, declarado.
- **a raiz principal é a montagem mais curta.** Um bind de uma subpasta do mesmo
  `major:minor` não representa o volume; ordenar por profundidade evita escolher
  `/mnt/pen/docs` como raiz de análise.

### Medido em Linux real, sem pen ligada

Ambiente: WSL2, `Linux 6.6.114.1-microsoft-standard-WSL2`, uid 1000, Node
22.23.4. Reproduzir:

```bash
wsl -e bash -lc 'S=/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo/scripts/linux-lite; \
  tr -d "\015" < $S/wsl-p3-usb.sh > /tmp/usb.sh && bash /tmp/usb.sh'
```

```text
SYSBLOCK {"nome":"sdd","dev":"8:48","removivel":"0","gib":1024,"usb":false,"serie":null}
SYSBLOCK {"nome":"sda","dev":"8:0","removivel":"0","gib":0.4,"usb":false,"serie":null}  (…sdb, sdc iguais)
USB    {"ok":true,"motivo":null,"dispositivos":[],"semVolume":[],
  "naoAtribuidos":["loop0"…"ram15","sda","sdb","sdc","sdd"],"ilegiveis":0,
  "observados":[…, {"nomeBloco":"sdd","usb":false,"amovivel":false,"montagens":2}]}
PORTA  {"ok":true,"semEstadoEspera":true,"dispositivos":[]}
BYID   {"usb":[],"total":8}
KERNEL 6.6.114.1-microsoft-standard-WSL2 | PLATAFORMA Linux | UID 1000
```

O que esta medição prova e o que não prova:

1. **A leitura é real, não um zero inventado:** 28 nós de `/sys/block` lidos,
   topologia de cada um obtida por `readlink`, `ilegiveis: 0`. `sdd` aparece com
   `montagens: 2` — os dois pontos de montagem do mesmo `8:48` (`/` e
   `/mnt/wslg/distro`), a mesma deduplicação que a secção dos volumes mediu.
2. **«Não há USB» tem verificação independente:** `/dev/disk/by-id` tem 8
   entradas e nenhuma contém `usb`. O veredicto do sysfs e o do udev coincidem.
3. **Nada foi afirmado sobre uma pen.** Não há medição de deteção positiva, de
   serial real, de `removable: 1` ou de uma análise `readOnly` de um volume
   amovível. Isto precisa de hardware: ligar uma pen (ou passagem USB numa VM
   Ubuntu/Mint) e voltar a correr a mesma sonda. Até lá, «a deteção USB de Linux
   está implementada e testada contra árvores de sysfs representativas» é o que
   se pode dizer — não «pen detetada e analisada».
4. **A porta do monitor funciona em Linux:** `criarDeteccaoUsbPosix().listar()`
   correu no `dist` compilado e devolveu a lista vazia sem lançar, com o estado
   de espera declarado ausente (`semEstadoEspera: true`).

## O volume escolhido passa a ser alvo de análise (§10)

O plano pedia «permitir selecionar um volume montado e analisá-lo com os motores
disponíveis». Em Linux Lite isso é uma linha no cartão Armazenamento do PC
Center: cada volume de trabalho medido agora recebe um «Analisar» que entrega a
montagem ao funil que já existe.

**A regra está separada do desenho**, em `diskVolumeScanActions`
(`packages/app/src/lib/diskDisplay.ts`), porque a pergunta tem duas réguas e uma
delas não é do volume:

| Régua | Porquê |
|---|---|
| plataforma a `linux` | o `osInfo().platform` publicado é `"Windows"` no Windows e `"linux"` em Linux; no Windows já existe o diálogo de pastas e este alvo nunca foi medido lá |
| `readStatus === "ok"` | um ponto de montagem pode desaparecer entre leituras; oferecer análise sobre a última leitura válida seria prometer um caminho que pode já não estar montado |

Além destas, `kind !== "working"` fica de fora (partição reservada pelo sistema
não é volume do utilizador) e a montagem tem de ser caminho absoluto. **`readOnly`
não fica de fora:** a exclusão do `readOnly` no alarme de espaço existe porque o
texto manda «libertar espaço»; ler não é escrever, e uma pen montada `ro` é
justamente o que se quer analisar.

O gesto **não lança nada**. `PCCenterPage` recebe `onAnalisarVolume` opcional e
`App.tsx` liga-o a `handleScan("custom", mount)` — o mesmo caminho do Dashboard e
da bandeja: `pendingScan` → página do Scanner → `FolderConfirmationPanel`, que
mostra nome e caminho e **só arranca com o clique explícito** «Analisar esta
pasta». Do teclado só existe a recusa: `folderConfirmationKeyAction` devolve
apenas `"cancel"` (`FileScannerPage.tsx:375`) — confirmar por tecla não é
oferecido. Um botão noutro ecrã a chamar `scan.start` direto seria o defeito, não
a funcionalidade. O `mount` entregue é o valor cru do contrato (`volume.mount`),
não o rótulo redigido que aparece noutros blocos.

### O perigo que tinha de ser resolvido antes

Antes de oferecer «analisar a raiz de um volume» audiu-se o walk do scanner, e a
auditoria encontrou um caso em que o botão enforcava a análise: `/proc/kcore` é
um ficheiro **regular** cujo tamanho declarado é o espaço de endereçamento do
kernel. `MalwareAnalyzer.analyze` calcula o SHA-256 (`packages/core/src/analysis.ts:73`)
**antes** do portão de tamanho (`:77`), e `sha256File` não tem limite nem
aborta. A derivação de `targetPath` para `/` passava por `resolvePathsForScan`
sem controlo, por isso o alvo era lido como qualquer pasta.

A correção é uma poda exata, não uma heurística de nome:
`RAIZES_DO_KERNEL_POSIX = ["/proc","/sys","/dev","/run"]` e
`eRaizDoKernelPosix(caminho, plataforma)`, que devolve `false` em `win32` — o
caminho Windows fica byte-a-byte como estava. A poda é por **igualdade exata**
da raiz, não por substring: `~/projetos/proc` e `/var/run/user/1000` continuam a
ser analisados. Entra nos dois walk (`gatherFiles` e `gatherFilesQuick`), antes
de tocar no disco.

O que isto **não** resolve, declarado em vez de escondido:

- um pseudo-FS montado noutro ponto (um `tmpfs` em `/tmp`) não é apanhado, porque
  a regra seria «voltar a ler o mountinfo na derivação de alvo» — é o passo
  seguinte sensato, não foi feito neste corte;
- a poda é silenciosa: o utilizador não vê «6000 ficheiros de /proc ignorados».
  Um alvo todo podido **termina `status: "failed"`** com «Nenhum ficheiro para
  analisar no alvo selecionado.», pelo que uma poda nunca pode produzir um
  «limpo»;
- o risco de base mantém-se para qualquer pasta com um ficheiro enorme declarado:
  o SHA-256 sem limite acontece antes do portão de tamanho e não respeita o
  pedido de cancelamento entre ficheiros. Mudar isso altera o veredicto de
  «demasiado grande» para ficheiros reais, por isso fica como dívida declarada.

## Testes

`packages/core/test/p3-montes-posix.test.js` — 11 casos, com a tabela real de
WSL2 como fixture: volumes e origem `C:\134` sem letra no `mount`; dedupe por
dispositivo com as montagens registadas; `bavail` vs `bfree`; pseudo-FS excluídos
**e** contados; `statfs` falhado isolado; todas-as-montagens-sem-capacidade como
falha com motivo; tabela ilegível com motivo que nomeia a tabela; espaço escapado
desescapado **antes** do `statfs`; linha ilegível contada; leitor sem cartão fora
da lista; primário `/`.

`packages/core/test/hardware-montes-linux.test.js` — 5 casos contra o **motor
real** com `process.platform` forçado e a alça `lerMontagens()` injectável: a
lista publicada vem da tabela (3 volumes dedupados, sem `/mnt/d`, sem pseudo-FS,
livre = `bavail`); o primário é `/`; nenhum alarme de espaço aponta para um
volume `ro`; só pseudo-FS dá `unavailable` com motivo que nomeia as montagens e
`null` nos números (não 0) e esse motivo não culpa um serviço do Windows; e em
`win32` a alça POSIX não é chamada nenhuma vez.

`packages/core/test/disk-snapshot.test.js` ganhou os dois ramos que este corte
introduz em código partilhado: `/` como primário quando não há letra `C:` (com a
queda antiga para «o mais cheio» preservada quando não há nem uma nem outra), e
o volume só-leitura fora do «mais cheio» do aviso — em forma Linux e em forma
Windows.

`packages/core/test/p3-usb-posix.test.js` — 12 casos sobre uma árvore de sysfs em
memória. Um nó de `/sys/block/<dev>` é **symlink e diretório ao mesmo tempo**,
como em sysfs real; a primeira versão do fixture só era uma das coisas e os
quatro casos de partição falharam por isso — não pelo código. Cobre: transporte
pelo segmento `usb<N>` (e `usb1:1.0`, a interface, a não contar); pen com serial
com raiz mais curta e `rootPaths` completas; sem serial → índice marcado como
reciclável; não-USB em `naoAtribuidos` com a contagem de montagens verdadeira;
USB sem volume em `semVolume`; a única montagem ser `tmpfs` e isso não fazer do
disco um volume; pen montada como disco inteiro; disco ilegível contado sem apagar
os outros; cada uma das duas tabelas em falta a falhar com motivo que a nomeia;
`queue`/`device`/`holders` a não contarem como partições; `removable` ausente
como `null` e não como `false`.

`packages/service/test/p3-usb-detection-posix.test.js` — 8 casos que ligam o
detetor ao contrato que já existia: a forma publicada é a da porta
`PortaDeteccaoUsb`; não há `listarPendentes`; `ok: false` lança com o motivo em
vez de devolver lista vazia; cada pedido lê fresco (a confirmação de presença não
pode receber leitura velha); a confirmação terminal aceita o mesmo pen, recusa o
pen ausente e recusa a identidade de índice; e o `UsbReadOnlyScanAdapter` arranca
`custom` na raiz do detetor Linux sempre com `readOnly: true` e `confirmarTerminal`
ligado. O ficheiro está inscrito na lista de `scripts.test` do `@cybersafe/service`.

`packages/service/test/p3-scan-walk-pseudo-fs.test.js` — 11 casos para a poda do
walk. Além da tabela do predicado (as quatro raízes em Linux; `"/PROC"` e `""`
fora; win32 sempre `false`, incluindo `"C:\\dev"`; `/`, `/mnt/c`, `/usr`, `/etc`
e `/home` a **não** serem podido), fixa os dois lados do comportamento em cada um
dos dois walk: uma raiz do kernel recolhe `[]` **com `stats.failed === 0`** (foi
podida antes de tocar no disco — uma falha de leitura teria contado) e uma árvore
verdadeira com subpasta recolhe o ficheiro que está **dentro dela**, sem nenhuma
falha, mantendo `node_modules` de fora.

O caso positivo existe por um motivo incómodo e foi encontrado por medição em
Linux, não por leitura do teste: a primeira versão chamava os métodos com um
`this` de objeto plano, mas o walk recursa com `this.gatherFiles` — o `TypeError`
rebentava dentro do `try` e o `catch` contava-o como falha de leitura. A
afirmação `failed === 1` passava, mas pela razão errada, e a recursão nunca foi
exercida.
Agora o `this` é `Object.create(ScanManager.prototype, …)`, e o caso que prova
que a poda não custou nenhuma leitura legítima está fixado.

### Medido em Linux real: o alvo escolhido no PC Center

Ambiente: WSL2, `Linux 6.6.114.1-microsoft-standard-WSL2 x86_64`, uid 1000,
Node 22.23.4, `packages/service/dist` compilado deste branch. Reproduzir:

```bash
wsl -e bash -lc 'S=/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo/scripts/linux-lite; \
  tr -d "\015" < $S/wsl-p3-scan-alvo.sh > /tmp/alvo.sh && bash /tmp/alvo.sh'
```

```text
STAT /proc/kcore tamanhoDeclarado=140737471594496 bytes | blocosFisicos=0 x 512
IMPORT ok | exportacoesDoCorte=["eRaizDoKernelPosix","RAIZES_DO_KERNEL_POSIX"] | ScanManager=true
WALK gatherFiles      {"alvo":"/tmp/p3alvo","ficheiros":4,"falhos":0,"ms":2}
WALK gatherFiles      {"alvo":"/tmp/p3alvo/proc","ficheiros":1,"falhos":0,"ms":0}
WALK gatherFiles      {"alvo":"/proc","ficheiros":0,"falhos":0,"ms":0}  (idem /sys, /dev, /run)
WALK gatherFilesQuick {"alvo":"/tmp/p3alvo","ficheiros":4,"falhos":0,"ms":1}
WALK gatherFilesQuick {"alvo":"/proc","ficheiros":0,"falhos":0,"ms":0}   (idem as outras raízes)
```

Quatro factos que só a máquina real dá:

1. **O perigo estava medido, não imaginado:** `/proc/kcore` declara
   140737471594496 bytes (~128 TiB — o espaço de endereçamento do kernel) com
   **zero blocos físicos**. É ficheiro regular, `entry.isFile()` diz que sim, e o
   SHA-256 era calculado antes do portão de tamanho: sem poda, a análise de `/`
   ficava presa nesse `await`.
2. **A poda não custou nenhuma leitura legítima:** o mesmo walk recolhe os quatro
   ficheiros da árvore de teste — incluindo o que está dentro de uma subpasta e o
   que está numa subpasta chamada `proc` — com `falhos: 0`, e as exclusões de
   sempre (`node_modules`, `.git`, symlink) continuam a acontecer.
3. **Igualdade exata é o que distingue as duas coisas:** `/tmp/p3alvo/proc` deu
   1 ficheiro; `/proc` deu zero sem tocar no disco.
4. **O `dist` do serviço carrega em Linux** com as exportações do corte visíveis,
   pelo que isto não é um ramo de código que só existe no Windows.

O que **não** foi medido aqui: o pedido de análise com o `service` em execução e
um volume real montado, com ficheiros a passar pelos motores. Isso precisa de
sessão gráfica, como o resto da validação de GUI.

`packages/app/test/p3-volume-scan-action.test.ts` — 10 casos da regra de
eligibilidade: linha Linux analisável; Windows nunca analisável e sempre com
motivo; plataforma ausente/`"unknown"`/vazia/`"Linux"` maiúsculo não é Linux;
`stale` e `unavailable`; `system-reserved`; montagens não absolutas (`""`,
`"mnt/c"`, `"C:"`, `"  /mnt/c"`); `readOnly` **continua** analisável; ordem e
comprimento preservados; lista vazia.

`packages/app/test/p3-volume-analisar-ssr.test.ts` — 6 casos do markup do cartão
Armazenamento: dois volumes de trabalho, dois botões com o caminho no `title`;
Windows zero; sem callback zero; `stale`/`unavailable` zero; `system-reserved`
fora e o vizinho de trabalho dentro; `readOnly` dentro.

`packages/app/test/service-connection-app.test.ts` ganhou o caso da ligação: a
função entregue ao PC Center mete `{type:"custom", targetPath:"/mnt/usb"}` no
`pendingScan` do Scanner e **não** chama `scan.start` (contagem de pedidos a
zerar) — o que separa «entregar ao funil» de «disparar daqui».

Em `packages/app/test/scanner-folder-confirmation.test.ts`, o bloco
«P3-LINUX · montagem POSIX» usa o mesmo harness dos handlers reais: `/mnt/usb`
aparece no painel com nome `usb` e zero arranques até ao `onConfirm`; `/` tem
rótulo `/` (sem último componente não fica sem nome) e confirma para `/`;
`onCancel` não arranca nada.

Regressão no clone isolado, Windows 11 / Node 26.3.0. Este corte **altera código
partilhado com o Windows** (`scan-manager.ts`), por isso os números abaixo são a
prova, não uma nota de rodapé. Cada suite foi corrida **sozinha**, com as outras
fora de jogo; a razão para isso está escrita logo depois da tabela:

| Suite | Resultado (máquina sem mais nada a correr) |
|---|---|
| `@cybersafe/core` | 1220 testes, 1187 passados, **1 falha** — ver «a falha do `core`» abaixo, 31 `skip`, 1 `todo` |
| `@cybersafe/app` | 2897 / 2897 |
| `@cybersafe/desktop` | 645 / 645 |
| `@cybersafe/service` | 962 testes, 954 passados, **8 falhas** — ver o parágrafo seguinte |
| typecheck `app` (`tsc -b`), build `core` e build `service` | limpos |

**A primeira medição mentiu por minha causa, e é por isso que fica registada.**
Corridas em paralelo, quatro suites ao mesmo tempo, deram `core` 1221 / 1185 /
**4 falhas** e `service` 962 / 952 / **10 falhas**. Três das quatro de `core`
eram sondas reais do Windows a esgotar o próprio prazo — `probe CIM real` e
`reconhece o proprio filho…` com `spawnSync powershell ETIMEDOUT`, e
`adl-worker-lifecycle` como ficheiro inteiro — e as duas a mais no `service`
eram o canário `dev` com prazo de 10 s. Corridas sozinhas, **essas cinco
passaram**. Se eu tivesse publicado o primeiro número, tinha escrito «quatro
falhas de regressão» sobre o meu próprio ruído de CPU. O que vale é o da máquina
parada; o episódio fica aqui para que ninguém volte a contar uma corrida
concorrente como se fosse um veredicto.

**A falha do `core` não é deste corte e não é do `core`.** É
`hardware-disk-first-read.test.js`: a primeira leitura dos volumes espera no
máximo `DISK_FIRST_READ_TIMEOUT_MS = 4_000` (`hardware.ts:150`, em
`Promise.race` com `readDisksOnce()`), e numa suite que corre ficheiros em
paralelo com motores reais, `si.fsSize()` passou desse prazo. Medido em vez de
afirmado: o mesmo ficheiro, corrido sozinho **três vezes seguidas**, passou as
três (`✔ … (11378 ms)`, `11084 ms`, `11493 ms`, `fail 0` nas três). E `git status
--porcelain -- packages/core` está vazio — nem o motor nem o teste têm uma linha
por commitar neste corte; o ficheiro de teste foi tocado pela última vez em
`3a95692`, trabalho Windows anterior a esta linha Linux. Fica registada como
**instabilidade pré-existente do caminho real de Windows sob concorrência**, com
o prazo de 4 s como a peça sensível; aumentar o prazo é mexer no contrato de
arranque do Windows e não é decisão deste corte.

As 8 falhas do `service` **não vêm deste corte**, e isso foi medido em vez de
afirmado: concentram-se nos dois ficheiros do cache de prefetch — os casos
`P1-3-A/B/C/E/G/H/I` de `p1-3-prefetch-isolation.test.js` e os dois casos de
`scan-post-batch-no-double-clamav.test.js` — e falham com o motor YARA real
carregado (`[YARA] Scanner carregado (file). Regras: 1`). Revertido `engine.ts`
para o estado do commit — `grep -c criarDeteccaoUsbPosix` a zero, rebuild limpo —
os mesmos casos falharam da mesma maneira. Ficam registadas como estado
pré-existente da branch neste clone, não como regressão deste corte; a causa
(regras de localização/extensão a disparar sobre os caminhos do fixture) não foi
diagnosticada aqui.

O salto de 1201 para 1208 testes foram os 7 casos do corte anterior; 1208 → 1220
são os 12 casos de `p3-usb-posix.test.js`. A primeira corrida
desta mudança **rebentou 7 testes Windows** (`p0-sensor-concurrency`,
`p0-slow-read-ownership`, `pap-subprocess-budget`) com `Unexpected dependency
node:fs`: esses sandboxes carregam `hardware.ts` num `vm` com lista fechada de
dependências, e são o mecanismo que obriga uma nova alça do motor a ser
declarada. Em vez de alargar a lista com `node:fs`, a leitura do sistema de
ficheiros saiu de `hardware.ts` e passou a viver em `mounts-posix.ts`
(`lerMontagensReais`), e os três sandboxes declaram agora o stub dessa alça —
gasto no teste, a mesma garantia de antes. O caso «em Windows o motor não
consulta a fonte POSIX» fixa que o caminho Windows não toca em `/proc`.

## Ainda não feito (não declarar como feito)

- **O gesto está ligado, mas não foi percorrido com o serviço real em Linux.** As
  provas são de regra (`diskVolumeScanActions`), de markup (`StorageCard` em SSR),
  de ligação (`onAnalisarVolume` → `pendingScan`, zero `scan.start`) e de portão
  (montagem POSIX no `FolderConfirmationPanel`, handlers reais). Falta o clique
  numa sessão com o `service` ligado a um volume real — e a validação em VM
  gráfica, que este clone não tem.
- **O SHA-256 continua sem limite nem cancelamento dentro de um ficheiro.** O
  hash é calculado antes do portão de tamanho (`analysis.ts:73` vs `:77`) e o
  cancelamento só é verificado entre ficheiros. A poda das quatro raízes do
  kernel fecha o caso do `/proc/kcore`, não a classe: uma pasta com um ficheiro
  esparso grande declarado pode parar a análise pelo mesmo mecanismo.
- **A poda só conhece as raízes exatas.** Um pseudo-FS montado noutro ponto
  (p. ex. `tmpfs` em `/tmp`) não é apanhado; a alternativa era consultar o
  mountinfo na derivação do alvo, o que ainda não foi feito.
- **A poda não é reportada ao utilizador.** Não há contagem de ignorados no
  resultado da análise; só o teste distingue «podado» de «lido e falhado».
- **A deteção positiva de USB não foi medida.** `/sys/block/<dev>/removable`,
  `device/serial` e o join por `major:minor` são lidos e testados, e a máquina
  real foi interrogada (28 nós, nenhum em USB, confirmado por `/dev/disk/by-id`);
  falta a medição com uma pen ligada — deteção, serial real, `removable: 1` e uma
  análise `readOnly` de um volume amovível. Sem hardware não há esse número, e não
  se escreve um.
- **Montar, formatar, reparar ou apagar:** nada implementado, nada proposto.
- **Página Otimizar/Firewall (§11)** e quarentena/histórico (§9): por fazer.
