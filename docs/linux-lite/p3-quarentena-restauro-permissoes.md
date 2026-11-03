# P3 — quarentena em Linux: restauro, destino existente e permissões

## O que este corte fecha

O §9 lista nove alíneas que a quarentena tem de respeitar. As quatro que faltavam
medir — **Restauro**, **Destino existente**, **Permissões** e a parte de
**Identidade do ficheiro** que passa pelos elos de link — têm lógica que só
significa alguma coisa fora do caso mais simples, e essa lógica nunca tinha sido
exercitada fora de Windows:

| Alínea | O que tem de acontecer | Onde vive |
|---|---|---|
| Restauro | a entrada sobrevive ao processo, o ficheiro volta byte a byte, a cópia isolada e o registo desaparecem | `packages/core/src/response.ts:158` |
| Destino existente | se já houver qualquer coisa no destino, o restauro recusa e não substitui | `response.ts:173-178` e `response.ts:217` |
| Permissões | o isolado fica sem permissão nenhuma; o restaurado recebe o modo com que foi apanhado | `response.ts:191-199` e `response.ts:222` |
| Identidade do ficheiro | um link simbólico ou um ficheiro com mais do que um nome não pode ser isolado nem restaurado | `response.ts:69-76` e `response.ts:96-97` |

**Nenhuma linha de código de produção foi alterada.** O corte são dois
ficheiros de teste novos, `p3-quarantine-restore-posix.test.js` (quatro casos) e
`p3-quarantine-identity-guards.test.js` (três casos), ambos sobre o
`QuarantineManager` real num diretório temporário próprio. O manager lê e escreve
ficheiros de verdade — é exatamente isso que se quer medir, e é a razão por que
não há mocks aqui.

## A sequência que está a ser provada

`restore(id)` faz, por esta ordem: procura a entrada; valida o caminho original
absoluto e o digest; `lstat` no destino (se existir qualquer coisa, recusa);
`flush` do manifesto **antes** de publicar seja o que for; garante que a pasta de
destino não é um redirecionamento; abre a cópia isolada; copia para um
*staging* `0o600` com `sync`; verifica o digest **do staging**; publica com
`fs.link`; remove o staging; repõe o modo original; volta a verificar a fonte;
apaga a fonte; reescreve o manifesto sem a entrada.

Dois detalhes que os casos vão buscar:

- **A publicação é `link`, nunca `rename`.** `link` falha com `EEXIST` mesmo
  contra um destino criado depois da verificação, o que fecha a janela entre o
  `lstat` e o movimento. Uma falha de volume diferente falha também, em vez de
  cair num atalho menos seguro (`response.ts:216-218`).
- **Em POSIX o ficheiro isolado não se consegue ler.** O código abre-o, e se o
  `open` falhar com `EACCES`/`EPERM` faz `chmod 0o400`, abre, e **devolve o modo
  a `0o000` antes de copiar** — a leitura passa a ser feita pelo descritor já
  aberto. É isto que a alínea «Permissões» quer dizer: o ficheiro está fechado
  para o sistema de ficheiros, não apenas escondido da interface.

## Identidade do ficheiro: o que o `lstat` antes do movimento segura

`quarantine()` começa com `lstat` e recusa logo se o caminho não for um ficheiro
regular, for um link simbólico, ou tiver `nlink !== 1` (`response.ts:96-97`). O
segundo ficheiro de testes mede esses três elos, porque nenhum dos testes já
existentes os tocava — `recovery-quarantine.test.js` cobre o digest trocado, a
falha do manifesto antes do movimento, a falha do `rename`, a falha do `chmod`
depois do movimento e o destino alterado durante o movimento, mas sempre com
ficheiros normais de um só nome.

| Caso | O que é posto à prova | O que tem de ser verdade depois |
|---|---|---|
| link simbólico no caminho | `quarantine()` devolve `null` | o alvo continua com os bytes; o link continua a ser um link; zero entradas no manifesto |
| link físico (`nlink === 2`) com o digest certo | `quarantine()` devolve `null` | os **dois** nomes continuam lá — a recusa só pode ter vindo do `nlink`, porque o digest e o tamanho batem certo |
| link físico criado sobre a cópia já isolada | `restore()` devolve `success: false` | o destino não é escrito; a entrada continua recuperável |

A razão de medir o `nlink` não é cosmética, e vale a pena dizê-la em claro:
mover um ficheiro com dois nomes tira um nome do sítio e deixa o outro a apontar
para exatamente os mesmos bytes. O manifesto teria o digest certo, o movimento
teria acontecido, e o ficheiro malicioso continuaria alcançável pelo caminho de
sempre — o oposto do que «isolado» quer dizer. O mesmo guarda aparece do outro
lado, no `checkedSource` usado pelo restauro: se a cópia em quarentena passou a
ter mais um nome, o restauro para antes de tocar em seja o que for.

O terceiro elo do `lstat` — a segunda estatística que compara `size`, `mtimeMs`,
`ctimeMs` e `ino` com a primeira — **não é alcançável a partir da API pública**,
e diz-se aqui em vez de se fingir com um teste. As duas estatísticas acontecem
dentro da mesma chamada serializada; o que as pode separar é um movedor
concorrente, não um teste. Cobrir essa rama exigiria um ponto de injeção dentro
do `QuarantineManager`, que este corte não abriu.

## Resultados medidos

### Windows — 2 passam, 2 são skip com a razão escrita

`npm run build && node --test test/p3-quarantine-restore-posix.test.js`, Windows
10.0.26300 x64, Node v26.3.0, `TMPDIR` por omissão em NTFS:

```text
✔ isolamento e restauro devolvem o ficheiro e a entrada deixa de existir (27.9334ms)
✔ destino já existente recusa o restauro sem tocar no que lá está (11.7513ms)
﹣ POSIX: o modo original volta a ser o modo do ficheiro restaurado (0.0801ms) # o modo POSIX não é observável em NTFS
﹣ POSIX: o que está isolado não se lê, e o restauro ainda assim lê (0.0369ms) # o modo POSIX não é observável em NTFS
ℹ tests 4
ℹ pass 2
ℹ fail 0
ℹ skipped 2
```

Os dois `skip` não são os dois primeiros casos a «passar à borla»: o NTFS não
representa o bit de modo POSIX e `chmod` só mexe no bit de leitura, por isso
afirmar `0o000` ou `0o640` numa partilha NTFS seria uma asserção sobre o que o
sistema de ficheiros ignora. Ficam contados como não observáveis, com o motivo
no próprio relatório. O que o Windows prova é que a ida-e-volta e a recusa de
destino ocupado continuam a funcionar na plataforma que já os usava.

Os três casos de identidade correm no mesmo Windows e **não precisam de skip**:
a criação de links simbólicos e físicos foi permitida, por isso as guardas
foram mesmo exercitadas, e o resultado diz que também em NTFS um elo não é
isolado nem restaurado.

```text
✔ link simbólico: o isolamento recusa, e o alvo não é tocado (8.7019ms)
✔ link físico (nlink 2): recusa mesmo com o digest certo, e nenhum nome desaparece (5.1161ms)
✔ link físico sobre a cópia isolada: o restauro recusa e nada é movido (13.3849ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
ℹ skipped 0
```

### WSL2 — 4 passam, sem skip

Ubuntu em WSL2, utilizador `caioc` (uid 1000, **sem root**), Node v22.23.4, com
`TMPDIR=$HOME/tmp-cs`:

```text
1000
caioc
v22.23.4
# Subtest: isolamento e restauro devolvem o ficheiro e a entrada deixa de existir
ok 1 - isolamento e restauro devolvem o ficheiro e a entrada deixa de existir
# Subtest: destino já existente recusa o restauro sem tocar no que lá está
ok 2 - destino já existente recusa o restauro sem tocar no que lá está
# Subtest: POSIX: o modo original volta a ser o modo do ficheiro restaurado
ok 3 - POSIX: o modo original volta a ser o modo do ficheiro restaurado
# Subtest: POSIX: o que está isolado não se lê, e o restauro ainda assim lê
ok 4 - POSIX: o que está isolado não se lê, e o restauro ainda assim lê
1..4
# tests 4
# pass 4
# fail 0
# skipped 0
```

Dois factos do ambiente fazem parte do resultado, não são detalhe de execução:

- **o diretório temporário tem de estar em ext4.** Escolhido `TMPDIR` para a
  home do WSL porque o contrário invalidava o teste: em `/mnt/c` o DrvFs não
  representa os bits de modo POSIX, e os casos 3 e 4 passariam sem nada
  verificado — ou falhariam por motivo errado. O teste usa `os.tmpdir()`, pelo
  que é o diretório escolhido que decide se a asserção vale.
- **tem de ser um utilizador normal.** `0o000` não bloqueia o superutilizador.
  Como root, o quarto caso deixaria de provar que o ficheiro está de facto
  ilegível. A verificação `id -u` está impressa no resultado acima.

O terceiro e quarto caso são a mesma moeda: o isolado fica `0o000`, um
`readFile` normal rebate com `EACCES`, e ainda assim o restauro consegue lê-lo e
devolvê-lo com o modo `0o640` com que foi apanhado.

Os três casos de identidade, no mesmo WSL2 e com o mesmo `TMPDIR` em ext4:

```text
1000
ok 1 - link simbólico: o isolamento recusa, e o alvo não é tocado
ok 2 - link físico (nlink 2): recusa mesmo com o digest certo, e nenhum nome desaparece
ok 3 - link físico sobre a cópia isolada: o restauro recusa e nada é movido
# tests 3
# pass 3
# fail 0
# skipped 0
```

## Regressão do `core` em Windows, e a falha que não é deste corte

A suite completa do `core`, corrida com o glob do `package.json`
(`node --test "test/**/*.test.js"`), com a máquina parada, depois de os dois
ficheiros novos entrarem:

```text
ℹ tests 1235
ℹ pass 1201
ℹ fail 0
ℹ skipped 33
ℹ todo 1
```

A contabilidade bate certo com zero impacto nos testes que já existiam: `1228 →
1235` são os sete novos; `1196 → 1201` passados são os cinco observáveis em NTFS
(dois de restauro mais três de identidade); `31 → 33` skip são os dois casos de
modo POSIX.

Sobrou uma coisa que não é deste corte e que vale registar em vez de esconder.
Das quatro corridas completas que tenho desta branch, `hardware-disk-first-read`
falhou em duas e passou em duas:

| Corrida | Ficheiros | testes | pass | `hardware-disk-first-read` |
|---|---|---|---|---|
| suite completa, sem nenhum ficheiro novo | 114 | 1228 | 1195 | **falhou** (8,4 s) |
| suite completa, só o do restauro | 115 | 1232 | 1197 | **falhou** (10,5 s) |
| suite completa, os dois ficheiros | 116 | 1235 | 1201 | passou |
| `hardware-disk-first-read.test.js` sozinho, uma corrida | 1 | 2 | 2 | passou |

Ou seja: falhou em duas das quatro corridas completas, passou na corrida
isolada que fiz, e **não é do código nem dos testes deste corte** — a primeira
linha da tabela é a prova, porque foi corrida exatamente sem os ficheiros novos.
Não afiro estabilidade a uma única corrida isolada; o que digo é que a falha
aparece com o suite inteiro em paralelo e com ou sem estes ficheiros, e não
apareceu quando o ficheiro correu sozinho.

## O que fica como diagnóstico, não como ruído

`test/hardware-disk-first-read.test.js` afirma que a primeira leitura dos
volumes é **esperada com prazo de 4 s** para que a primeira fotografia do
`HardwareHealthEngine` já diga a verdade medida. Dentro do suite paralelo o
`getSnapshot` demorou 8–10 s nessa leitura nas corridas em que falhou, e o
primeiro snapshot saiu com
«Ainda sem leitura do armazenamento desde o arranque.» — que é precisamente o
sintoma que o teste foi escrito para apanhar, na altura em que o Dashboard e o PC
Center ficavam presos nesse texto enquanto a Saúde do Windows mostrava o C: a
89%.

Duas leituras são possíveis e **nenhuma foi medida**: ou o prazo de 4 s é curto
para o custo real de enumerar volumes num Windows com o sistema de ficheiros
carregado — e nesse caso o produto também mostra «ainda sem leitura» a utilizador
verdadeiro nos primeiros segundos — ou há contenção de CPU dentro do suite e o
prazo é razoável. O que se sabe, medido, é a frequência: duas falhas em quatro
corridas completas, zero na corrida isolada. Fica na lista de diagnósticos por
prestar, ao lado do `sha256File` que corre sem limite antes do portal de tamanho
e não observa cancelamento a meio da leitura.

## Ainda não é dito

- **nada disto é quarentena automática operacional.** A política por omissão
  continua `warn`; o isolamento automático continua a exigir `known_bad_hash`,
  `confidence >= 0.99` e consentimento literal. O que este corte mede é o
  `QuarantineManager`, chamado à mão.
- **o portão do motor não volta a ser exercitado aqui.** O corte anterior
  (`p3-quarantine-mount-engine.test.js`) cobre recusa por montagem, caminho
  protegido e movimento real fora da raiz do serviço. Este cobre a persistência
  e o modo. O `requestQuarantine`/restauro através do IPC continua por medir de
  ponta a ponta com o `quarantine.ts` real.
- **a rama de limpeza pendente não está coberta.** Quando `restore` já publicou
  mas falha a apagar a fonte ou a reescrever o manifesto, devolve
  `success: true` **com** `error` e mantém a entrada. O primeiro caso prova que
  o caminho feliz não deixa `error`; não prova que a rama de recuperação funcione.
- **identidade entre as duas estatísticas do mesmo `lstat`.** O `quarantine()` faz
  uma segunda estatística e compara `size`, `mtimeMs`, `ctimeMs` e `ino`; essa
  rama só se ativa se outro processo mover o ficheiro a meio da chamada, e não é
  alcançável pela API pública sem um ponto de injeção dentro do manager. Fica
  declarada como não coberta, não como coberta de forma aproximada.
- **auditoria do percurso completo**, com o `quarantine.ts` real e os eventos
  publicados lado a lado com o movimento, continua por medir.
- **ambiente**: tudo o que está em cima foi medido em Windows 10 e em WSL2 sem
  interface gráfica. §15 pede validação numa Ubuntu/Mint de desktop; uma montagem
  de pen USB continua por medir, e é o mesmo bloco de hardware que falta ao §10.

## Como voltar a correr

```bash
# Windows (temporário em NTFS: restauro 2 passam e 2 são skip; identidade 3 passam)
cd packages/core && npm run build && node --test test/p3-quarantine-restore-posix.test.js
node --test test/p3-quarantine-identity-guards.test.js

# WSL2, com o temporário em ext4 e sem root — é isto que faz os casos de modo valerem
cd /mnt/c/.../packages/core && TMPDIR=$HOME/tmp-cs node --test test/p3-quarantine-restore-posix.test.js
TMPDIR=$HOME/tmp-cs node --test test/p3-quarantine-identity-guards.test.js
```
