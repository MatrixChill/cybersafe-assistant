# P3 — quarentena em Linux: restauro, destino existente e permissões

## O que este corte fecha

O §9 lista nove alíneas que a quarentena tem de respeitar. As três que faltavam
medir — **Restauro**, **Destino existente** e **Permissões** — têm lógica que só
significa alguma coisa em POSIX, e essa lógica nunca tinha sido exercitada fora
de Windows:

| Alínea | O que tem de acontecer | Onde vive |
|---|---|---|
| Restauro | a entrada sobrevive ao processo, o ficheiro volta byte a byte, a cópia isolada e o registo desaparecem | `packages/core/src/response.ts:158` |
| Destino existente | se já houver qualquer coisa no destino, o restauro recusa e não substitui | `response.ts:173-178` e `response.ts:217` |
| Permissões | o isolado fica sem permissão nenhuma; o restaurado recebe o modo com que foi apanhado | `response.ts:191-199` e `response.ts:222` |

**Nenhuma linha de código de produção foi alterada.** O corte é um ficheiro de
teste novo, `packages/core/test/p3-quarantine-restore-posix.test.js`, com quatro
casos sobre o `QuarantineManager` real num diretório temporário próprio. O
manager lê e escreve ficheiros de verdade — é exatamente isso que se quer medir,
e é a razão por que não há mocks aqui.

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

## Regressão do `core` em Windows, e a falha que não é deste corte

A suite completa do `core`, corrida com o glob do `package.json`
(`node --test "test/**/*.test.js"`), com a máquina parada:

```text
ℹ tests 1232
ℹ suites 207
ℹ pass 1197
ℹ fail 1
ℹ skipped 33
ℹ todo 1
✖ armazenamento — o PRIMEIRO snapshot já publica a leitura (21852.013ms)
✖ a primeira leitura dos volumes é esperada e sai no primeiro snapshot (10569.3691ms)
```

A contabilidade bate certo com zero impacto: `1228 → 1232` testes são os quatro
novos; `1195 → 1197` passados são os dois casos observáveis em NTFS;
`31 → 33` skip são os dois casos POSIX. A falha não é minha e foi provada como
pré-existente, não assumida:

| Corrida | Ficheiros | testes | pass | fail |
|---|---|---|---|---|
| suite completa | 114 (sem o meu ficheiro) | 1228 | 1195 | **1** — a mesma falha |
| suite completa | 115 (com o meu ficheiro) | 1232 | 1197 | **1** — a mesma falha |
| `hardware-disk-first-read.test.js` sozinho | 1 | 2 | 2 | 0 |

Reproduziu-se em duas corridas seguidas dentro do suite e desaparece quando o
ficheiro corre isolado.

## O que fica como diagnóstico, não como ruído

`test/hardware-disk-first-read.test.js` afirma que a primeira leitura dos
volumes é **esperada com prazo de 4 s** para que a primeira fotografia do
`HardwareHealthEngine` já diga a verdade medida. Dentro do suite paralelo o `get
Snapshot` demora 8–10 s nessa leitura e o primeiro snapshot sai com
«Ainda sem leitura do armazenamento desde o arranque.» — que é precisamente o
sintoma que o teste foi escrito para apanhar, na altura em que o Dashboard e o PC
Center ficavam presos nesse texto enquanto a Saúde do Windows mostrava o C: a
89%.

Duas leituras são possíveis e **nenhuma foi medida**: ou o prazo de 4 s é curto
para o custo real de enumerar volumes num Windows com o sistema de ficheiros
carregado — e nesse caso o produto também mostra «ainda sem leitura» a utilizador
verdadeiro nos primeiros segundos — ou há contenção de CPU dentro do suite e o
prazo
é razoável. O que se sabe é o facto reprodutível: com o suite inteiro em
paralelismo falha, isolado passa. Fica na lista de diagnósticos por prestar, ao
lado do `sha256File` que corre sem limite antes do portal de tamanho e não
observa cancelamento a meio da leitura.

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
- **identidade do ficheiro entre o pedido e o movimento**, e a auditoria do
  percurso completo, continuam por medir.
- **ambiente**: tudo o que está em cima foi medido em Windows 10 e em WSL2 sem
  interface gráfica. §15 pede validação numa Ubuntu/Mint de desktop; uma montagem
  de pen USB continua por medir, e é o mesmo bloco de hardware que falta ao §10.

## Como voltar a correr

```bash
# Windows (temporário em NTFS: 2 passam, 2 são skip)
cd packages/core && npm run build && node --test test/p3-quarantine-restore-posix.test.js

# WSL2, com o temporário em ext4 e sem root — é isto que faz os casos de modo valerem
cd /mnt/c/.../packages/core && TMPDIR=$HOME/tmp-cs node --test test/p3-quarantine-restore-posix.test.js
```
