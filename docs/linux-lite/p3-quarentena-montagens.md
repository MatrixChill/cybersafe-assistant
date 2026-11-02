# P3 (Linux Lite) — a quarentena e os pontos de montagem

Data do corte: 2026-11-02 · Branch `experimental/linux-lite-qoder` · Ambiente de
medição: **WSL2**, kernel `6.6.114.1-microsoft-standard-WSL2`, `x86_64`, uid 1000,
Node v22.23.4 (`$HOME/.local/node`), sem root, sem montagens criadas pela sonda.

## O que o §9 pedia e onde isto entra

O plano §9 lista o que a quarentena deve respeitar: «Caminhos protegidos. Links
simbólicos. **Mount points.** Permissões. …». Ao chegar aqui, duas das três já
existiam para Linux e a terceira não existia de todo:

| Alínea do §9 | Estado antes deste corte | Onde vive |
|---|---|---|
| Caminhos protegidos | já cobria Linux (`LINUX_PROTECTED_ROOTS`, case-sensitivity desligada fora de Windows) | `packages/service/src/quarantine-path-policy.ts` |
| Links simbólicos | já cobria, com `realpath` de igualdade | `hasReparseFreePath`, mesma fila |
| **Mount points** | **não existia** | acrescentado aqui |

Isto não era uma lacuna teórica: o corte anterior (§10) deu ao PC Center um botão
que analisa **um volume montado**. A partir daí o produto passa a ter caminhos
que são montagens nos seus alvos de análise, e o pedido de isolamento de um alvo
desses chegava ao motor sem nenhuma regra que o recusasse.

## As três réguas, separadas

| Pergunta | O que é verdade | Que regra responde |
|---|---|---|
| Este caminho pertence a uma raiz que o produto não toca? | `/usr`, `/etc`, `/sys`, a instalação, o `baseDir` | `isProtectedQuarantinePath` (prefixo normalizado) |
| Este caminho, ou um antepassado dele, é redirecionado por um link? | `realpath` ≠ caminho pedido | `hasReparseFreePath` |
| Este caminho É um sistema de ficheiros pendurado aqui? | igualdade com um campo `mount` do kernel | `isMountPointPath` (nova) |

As três são recusadas no mesmo ponto de decisão (`requestQuarantine`), cada uma
com o seu motivo no evento e no histórico. São perguntas diferentes porque as
respostas são independentes: `/media/utilizador/pen` não é raiz protegida nem
link, e é exatamente uma montagem.

**Porquê igualdade e não prefixo.** `/` está na tabela de todas as máquinas. Uma
comparação por prefixo diria que qualquer ficheiro do mundo é uma montagem e o
isolamento deixaria de acontecer em silêncio — o pior modo de falha possível
para uma proteção. A normalização é por isso separada da `norm` do módulo:
`norm("/")` devolve uma string vazia, e usar essa função sobre a tabela faria `/`
desaparecer do conjunto proibido, ou seja, abriria exatamente o buraco que a
regra existe para fechar. A prova está nos testes: `"/"` é recusado, `"/init"`
com tabela `[ "/"]` não é.

**Porquê o fail-closed.** Uma tabela que não se lê (`mount-table-unreadable`) ou
que se lê com linhas que o parser não interpreta (`mount-table-incomplete`)
recusa o isolamento. Não mover é uma não-ação reversível — o ficheiro fica onde
está, continua marcado como malicioso, a recusa é publicada e auditada. Mover uma
montagem não é reversível. A consequência fica declarada, porque é real: se um
dia o formato do `mountinfo` mudar e o parser deixar de o entender, **o
isolamento em Linux deixa de acontecer** até o parser ser atualizado. Escolheu-se
esse lado do dilema de propósito.

## Onde está o código, e porquê dividido assim

| Ficheiro | Papel | Porque é ali |
|---|---|---|
| `packages/core/src/mounts-posix.ts` — `lerPontosDeMontagem`, `lerPontosDeMontagemReais` | a fonte: todos os pontos de montagem da tabela do kernel, pseudo-FS incluídos | é este módulo que sabe o que é uma montagem; `parseMountinfo` e o desescapamento já vivem aqui |
| `packages/service/src/quarantine-path-policy.ts` — `isMountPointPath` | a regra pura, sobre uma tabela fornecida | continua sem I/O nem dependências, como as outras regras do ficheiro |
| `packages/service/src/quarantine-mounts.ts` — `quarantineMountRefusal` | a decisão por plataforma + os três modos de falha | é a única alça que precisa de ler; injectável para que o teste não responda pela máquina |
| `packages/service/src/engine.ts:2388` | o ponto de uso, no `requestQuarantine` | é onde as outras duas recusas já acontecem |

O `lerPontosDeMontagem` **inclui os pseudo-FS**, ao contrário do
`lerMontagensPosix` que alimenta o PC Center. É a mesma tabela com duas
perguntas diferentes: «que armazenamento há aqui» exclui `sysfs`/`tmpfs`; «este
caminho tem um sistema de ficheiros pendurado» não pode excluí-los — `/sys` e
`/run` são montagens, e responder «não é montagem» sobre um caminho que o kernel
declara montagem seria o defeito.

Em Windows o código não corre: `quarantineMountRefusal` devolve `null` antes de
abrir a tabela, e a sonda prova que o leitor injetado **nunca é chamado** com
`platform = "win32"` — não é só «não faz diferença», é «não faz nada».

## Testes em Windows (o contrato comum preservado)

`packages/core/test/p3-pontos-de-montagem.test.js` — 8 casos, 8 verdes. Fixtura é
o `mountinfo` real do WSL2 (repetido de propósito: duas perguntas diferentes não
devem partilhar um literal que uma alteração de uma mude a outra). Cobre: pseudo-
FS dentro da lista, `/` não-vazio, `\x20` desescapado, dedupe e ordenação, linha
ilegível contada, falha de leitura com `reason`, e tabela vazia ≠ falha. Um dos
casos afirma explicitamente a diferença entre as duas visões: `/sys` está nas
montagens e não está nos volumes.

`packages/service/test/p3-quarantine-mount-points.test.js` — 11 casos, 11
verdes, acrescentado à lista do `scripts.test`. O caso que vale o corte é o
prefixo: `/media/caioc/pen/malware.exe` com `/media/caioc/pen` na tabela **tem de
poder ser isolado**; e `/home/.../ficheiro.txt` com `/` na tabela idem.

## Medido em Linux real

```
$ wsl -e bash /tmp/p3qm.sh        # scripts/linux-lite/wsl-p3-quarentena-montagens.sh
KERNEL 6.6.114.1-microsoft-standard-WSL2 | PLATAFORMA Linux | NODE=... v22.23.4 | UID 1000
LINHAS_MOUNTINFO 40
ALVOS_FINDMNT 40
LEITURA ok=true pontos=38 ilegiveis=0 reason=—
OK   a tabela real é lida
OK   a tabela real é completa (sem linhas ilegíveis) | ilegiveis=0
FINDMNT linhas=40 unicos=38 duplicados=2 | nossos=38
OK   os caminhos do findmnt são exatamente os nossos
OK   todos os pontos de montagem reais são recusados | recusados=38/38
OK   ficheiro real não é recusado: /etc/hostname | motivo=null
OK   ficheiro real não é recusado: /usr/bin/true | motivo=null
OK   ficheiro real não é recusado: /bin/sh | motivo=null
OK   ficheiro real não é recusado: /tmp/rea-p3-quarentena-montagens.bin | motivo=null
OK   ficheiro dentro da montagem /dev não é a montagem | /dev/qualquer-coisa.txt
OK   há montagens reais que SÓ esta regra protege | 14 de 38
  EXEMPLOS_SO_NOVA ["/","/init","/mnt/c","/mnt/d","/mnt/e","/mnt/f"]
OK   win32 não abre a tabela de montagens
OK   tabela ilegível recusa (fail-closed)
OK   tabela incompleta recusa (fail-closed)
RESULTADO SEM FALHAS
```

O que isto prova, linha a linha:

1. **A leitura é completa.** 40 linhas no `mountinfo`, 40 alvos no `findmnt`, 38
   caminhos únicos dos dois lados, `ilegiveis: 0`. O par de contagens é
   verificado por caminho independente (o `findmnt` não usa o nosso parser).
   Nenhum dos modos de falha conservadora foi accionado nesta máquina — ou seja,
   o isolamento continua disponível em Linux real, não desligado por uma tabela
   que não sabemos ler.
2. **Os 14 de 38 são a cobertura nova.** `/`, `/init`, `/mnt/c`, `/mnt/d`,
   `/mnt/e`, `/mnt/f` e companhia não são raízes protegidas nem links: antes
   deste corte um pedido de isolamento de `/mnt/c` teria passado o portão de
   caminhos e chegado ao `rename`. Hoje são recusadas com `reason:
   "mount-point"`.
3. **A regra não é um botão morto.** Quatro ficheiros reais (dois deles dentro
   de montagens) continuam elegíveis, e `/dev/qualquer-coisa.txt` — filho directo
   de uma montagem — também.

**A primeira versão desta sonda estava errada, e o erro foi meu.** A asserção
original comparava *linhas*: `findmnt` 40 contra parser 38, e a sonda falhou. A
causa não era o parser — a tabela do WSL2 monta `/run/user` e `/tmp/.X11-unix`
**duas vezes cada uma** (verificado com `uniq -d`), e o `findmnt` lista as duas
ocorrências enquanto a nossa lista é de caminhos únicos. Uma igualdade de
contagens seria uma asserção sobre como o kernel duplica montagens, não sobre o
que lemos. Passou a comparação de conjuntos, com `duplicados` impresso.

## Ainda não é dito (e não deve ser lido como feito)

- **Nenhum movimento foi tentado.** A sonda não isola nada — não havia nada a
  isolar e uma montagem seria preciso desmontá-la para o provar, o que é
  proibido neste trabalho. O que está medido é a decisão no ponto do portão, não
  um `rename` sobre uma montagem.
- **O portão ao nível do motor não tem teste de integração.** O que está coberto
  é `isMountPointPath` + `quarantineMountRefusal` (unidade) e a compilação do
  `engine.ts` que os chama; não existe um teste que instale o motor e peça o
  isolamento de um caminho de montagem para observar o `quarantine.failed` com o
  motivo certo. É o próximo elo.
- **A janela entre a leitura e o movimento não é eliminada.** Uma montagem que
  apareça depois do `readFileSync` não está na tabela; o que a impede nesse
  instante é o `EXDEV`/`EPERM` do sistema de ficheiros, não esta regra. A regra
  reduz o risco, não o elimina.
- **Restam alíneas do §9 por medir em Linux**: permissões do destino, identidade
  do ficheiro entre o pedido e o movimento, restauro, destino existente, e a
  auditoria do percurso completo com o `quarantine.ts` real. A política por
  omissão continua `warn`, e o isolamento automático continua a exigir
  `known_bad_hash`, `confidence >= 0.99` e consentimento literal — nada neste
  corte aproximou o produto de «quarentena automática operacional».
- **Ambiente**: tudo o que está em cima foi medido em WSL2. Não foi medido numa
  Ubuntu/Mint desktop com ambiente gráfico (§15), e uma montagem de pen USB
  continua por medir — é o mesmo bloco de hardware que falta ao §10.

## Regressão Windows, corrida uma suite de cada vez com a máquina parada

| Suite | Resultado |
|---|---|
| `packages/core` | 1228 testes, **1196 passados, 0 falhas**, 31 skip, 1 todo |
| `packages/service` | 973 testes, 965 passados, **8 falhas** — as mesmas 8 pré-existentes deste clone (7 em `p1-3-prefetch-isolation`, 1 em `engine-batch-cache-lookup`); o número não mudou com este corte e os 11 testes novos passam |
| `packages/app` | 2897 testes, 2897 passados, 0 falhas |
| `packages/desktop` | 645 testes, 645 passados, 0 falhas |
| `tsc` de `core` e `service` | limpos (o `service` é onde o `engine.ts` alterado é compilado) |

Nota de método: as duas primeiras linhas foram corridas isoladamente, uma a
seguir à outra — é a razão por que o `hardware-disk-first-read` do `core`, que
falhou noutra corrida sob carga, aqui passou (`0` falhas em 1228).
