# P3 (Linux Lite) — descoberta de volumes montados, sem letras de unidade

Âmbito: **descobrir, medir e publicar os volumes reais de Linux** — a base do
«USB e armazenamento» do plano (§10) e do estado de armazenamento do PC Center
(§6). Está medido em máquina real e **ligado ao motor** (`hardware.ts` escolhe a
fonte por plataforma). O que ainda não está ligado — o alvo de scanner
selecionável — está declarado no fim desta página em vez de ser apresentado como
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

Regressão no clone isolado, depois de `disk.ts` e `hardware.ts` terem mudado
win32, Node 26.3.0 — este corte **altera código partilhado com o Windows**, por
isso os números abaixo são a prova, não uma nota de rodapé:

| Suite | Resultado |
|---|---|
| `@cybersafe/core` | 1220 testes, 1188 passados, **0 falhas**, 31 `skip`, 1 `todo` |
| `@cybersafe/app` | 2877 / 2877 |
| `@cybersafe/desktop` | 645 / 645 |
| `@cybersafe/service` | 951 testes, 943 passados, **8 falhas** — ver o parágrafo seguinte |
| typecheck `core` e build `service` | limpos |

As 8 falhas do `service` **não vêm deste corte**, e isso foi medido em vez de
afirmado: `p1-3-prefetch-isolation.test.js` falha 7 dos seus casos (`B tem de ler
o SEU veredicto (clean), nunca o de A — obtido "inconclusive", regras:
dangerous_file_extension,suspicious_location`) com o motor YARA real carregado
(`[YARA] Scanner carregado (file). Regras: 1`). Revertido `engine.ts` para o
estado do commit — `grep -c criarDeteccaoUsbPosix` a zero, rebuild limpo — os
mesmos 7 casos falharam da mesma maneira. Ficam registadas como estado pré-existente
da branch neste clone, não como regressão deste corte; a causa (regras de
localização/extensão a disparar sobre os caminhos do fixture) não foi
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

- **O volume escolhido pelo utilizador ainda não é alvo de scanner.** Em Linux o
  volume amovível já chega ao `UsbReadOnlyScanAdapter` pela porta do monitor (e os
  testes fixam que esse caminho corre com `readOnly: true`), mas a lista de
  montagens publicada no PC Center ainda não tem o gesto «analisar este volume»
  ligado ao pedido de análise (§10). O que falta é a escolha em interface e o
  pedido explícito, não a descoberta.
- **A deteção positiva de USB não foi medida.** `/sys/block/<dev>/removable`,
  `device/serial` e o join por `major:minor` são lidos e testados, e a máquina
  real foi interrogada (28 nós, nenhum em USB, confirmado por `/dev/disk/by-id`);
  falta a medição com uma pen ligada — deteção, serial real, `removable: 1` e uma
  análise `readOnly` de um volume amovível. Sem hardware não há esse número, e não
  se escreve um.
- **Montar, formatar, reparar ou apagar:** nada implementado, nada proposto.
- **Página Otimizar/Firewall (§11)** e quarentena/histórico (§9): por fazer.
