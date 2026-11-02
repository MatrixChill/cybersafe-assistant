# §9 «Auditoria»: o que fica em disco quando um isolamento acontece

Cortes anteriores: `p3-quarentena-restauro-permissoes.md` (Restauro, Destino
existente, Permissões, Identidade) e `p3-quarentena-montagens.md` (Caminhos
protegidos, Links simbólicos, Mount points).

O §9 encerra com «Auditoria». Os cortes anteriores provaram recusas e
movimentos olhando para os **eventos** publicados no `SecurityEventBus` e para o
`manifest.json`. Os eventos vivem enquanto o processo vive: um `quarantine.added`
de há três dias não se lê em lado nenhum. A auditoria é o outro lado — o que fica
em `<baseDir>/history.jsonl` depois de a operação acabar e depois de a janela
ser fechada. Este corte mede isso.

## O que o código faz, por linha

`requestQuarantine` (packages/service/src/engine.ts:2374) tem três destinos de
registo em disco e um quarto que não é registo:

| Caminho | Linha | Vai para o ficheiro? |
|---|---|---|
| Recusa no portão (protegido / montagem / tabela ilegível) | 2392 | sim — `{type:"quarantine.failed", artifactPath, fileName, sha256, authorization, reason, timestamp}` |
| «foi pedido» antes do movimento | 2395 | **não** — `quarantine.requested` só existe como evento |
| Isolamento confirmado | 2404 | sim — `{type:"quarantine.added", artifactPath, fileName, sha256, authorization, entry, timestamp}` |
| Isolamento não confirmado ou exceção | 2408 | sim — `{type:"quarantine.failed", ...evidence, timestamp}` |

A linha de sucesso existia no `HEAD` com `{type, entry, timestamp}` apenas. O
`entry` traz `id`, `sha256` e `originalPath`, por isso o registo já dizia *o que*
foi isolado; não dizia *quem autorizou*. As duas linhas de recusa já levavam
`authorization`. Uma auditoria onde só as falhas identificam a origem do pedido
não permite responder, dias depois, se o ficheiro foi movido porque o utilizador
pediu ou porque o motor decidiu — que é exatamente a pergunta que o §9 faz ao
exigir isolamento apenas com consentimento. Foi essa assimetria que o corte
corrigiu, espalhando o mesmo `evidence` já construído na linha 2375.

## O que foi medido

`packages/service/test/p3-quarantine-audit-engine.test.js`, cinco casos sobre o
`ProtectionEngineService` real. **Não faz stub a `logHistory`** — fazer stub ao
destino da auditoria para testar a auditoria seria medir o substituto. As linhas
são lidas do ficheiro. Os alvos são ficheiros benignos num diretório temporário
separado do `baseDir` do motor, porque dentro dele seriam caminho protegido e a
recusa correta seria lida como comportamento esperado.

| Caso | O que afirma |
|---|---|
| linha que nomeia o mesmo objeto do manifesto | uma linha de sucesso; `linha.entry.id === manifesto[0].id`; `linha.entry.sha256` = digest dos bytes movidos; `originalPath` = o ficheiro; original vazio; cópia isolada existe onde a linha diz; instante analisável |
| a linha de sucesso diz quem autorizou | `linha.authorization === "manual"` |
| recusa por caminho protegido é auditada com o motivo | `reason === "protected-path"`, `artifactPath`, `authorization`; nenhuma linha de sucesso; `antes.ino === depois.ino` (nada se moveu); um evento e uma linha |
| isolamento não confirmado regista a falha | `quarantine.quarantine` devolve `null` → linha de falha com `authorization:"automatic"` e o `sha256` a que o pedido dizia respeitar; ficheiro intacto |
| repetir o pedido sobre o mesmo alvo | exatamente uma linha de sucesso e uma de falha — o segundo pedido não inventa um segundo isolamento |

O quarto caso usa um `stub`. É o único ponto deste ficheiro em que o motor do
isolamento é substituído, e serve para produzir um resultado que o
`QuarantineManager` efetivamente devolve (a recusa interna devolve `null`) sem
ter de corromper o manifesto para chegar lá. O que se mede é o registo, não o
manager.

## Uma característica do registo, não um defeito deste corte

Todas as chamadas são `void this.logHistory(...)` — o motor não espera pelo
`appendFile`. Ler o ficheiro imediatamente a seguir à chamada é uma corrida, e é
por isso que os casos usam um helper que espera até a linha aparecer, com prazo
de 3 s e mensagem que diz quantas linhas vieram. Não se afirma aqui que a escrita
é síncrona: afirma-se que aparece. O que fica por medir é o que acontece quando o
`baseDir` está num disco cheio ou o `appendFile` falha — o corpo de `logHistory`
é `try { await fs.appendFile(...) } catch { // Ignore }` (engine.ts:5456-5461),
pelo que uma auditoria pode ficar muda sem que nada o diga ao utilizador. Isso é
um diagnóstico em dívida, não uma passagem.

## Resultados, por plataforma

Windows 10 (build 26300), Node v26.3.0, `packages/service`:

```
ℹ tests 21
ℹ pass 21
ℹ fail 0
ℹ skipped 0
```

(vem com os 16 casos de `recovery-security-pipeline.test.js` no mesmo comando.)

WSL2, não-root, Node v22.23.4, temporário em ext4 (`TMPDIR=$HOME/tmp-cs`):

```
1000
v22.23.4
exit=0
# tests 21
# pass 21
# fail 0
# skipped 0
```

Os cinco casos novos passam nas duas plataformas. Nenhum é `skip`ado: a
diferença do corte de modos POSIX, o que aqui se afirma (linhas JSON, campos,
contagens) não depende de bits de permissão.

## Regressão Windows do `engine.ts` mexido

A linha de sucesso é código partilhado: o `engine.ts` deste clone é o mesmo que o
Windows executa, por isso o §16 obriga a correr o suite do serviço no clone
isolado. `npm test` em Windows, depois das alterações:

```
ℹ tests 987
ℹ pass 978
ℹ fail 8
ℹ skipped 1
```

As oito falhas são o conjunto já conhecido como vermelho, listado nos cortes
anteriores: sete de `p1-3-prefetch-isolation.test.js` e uma de
`engine-batch-cache-lookup.test.js` («os 6 ficheiros do batch sao resolvidos pelo
veredicto em cache…»). Nenhuma é de quarentena, nenhuma é nova, e o ficheiro
deste corte está dentro das 978 passadas. O que esta corrida tinha de provar era
que acrescentar campos à linha de sucesso não parte nenhum outro consumidor do
`history.jsonl` — e não parte.

## Duas falhas que não eram deste corte, e um teste que ninguém corria

Ao correr o ficheiro novo no mesmo comando que `recovery-security-pipeline.test.js`
— os dois instalam o `ProtectionEngineService`, faz sentido correrem juntos —
apareceram duas falhas nesse segundo: «C explicit automatic opt-in…» e «manual
authorization includes digest…». Provei que não vinham de mim reconstruindo o
`engine.ts` do `HEAD` e correndo só esse ficheiro:

```
HEAD-sem-minha-linha  exit=1   ℹ tests 16   ℹ pass 14   ℹ fail 2
```

As mesmas duas. Depois restaurei a minha versão e o ficheiro ficou outra vez
como estava. A causa é a armadilha que já tinha encontrado no corte anterior,
agora apanhada por um teste que já existia: a fixtura criava o ficheiro **dentro**
do `baseDir` e instalava o motor no mesmo diretório, e o `baseDir` é uma raiz
protegida. O portão recusava corretamente, e o teste lia a recusa como se fosse o
comportamento à espera — os dois casos que afirmavam isolamento de verdade
falhavam, e os outros catorze passavam porque não perguntavam pelo movimento.
A correção foi separar os dois papéis na fixtura (motor em `<dir>/service`,
alvo em `<dir>`) sem tocar em nenhuma asserção.

**A origem não é deste branch.** Li o `requestQuarantine` em `d486f5b~1`, antes
de qualquer portão meu, e a recusa já lá estava, com o `baseDir` dentro das
raízes protegidas:

```
const caminhoPermitido = !isProtectedQuarantinePath(analysis.artifactPath, { baseDir: this.baseDir, execPath: process.execPath })
  && await hasReparseFreePath(analysis.artifactPath);
```

Ou seja, estes dois casos estão vermelhos desde que o `isProtectedQuarantinePath`
passou a receber o `baseDir` do motor — código da era Windows. O que os tornava
invisíveis é a segunda parte: `recovery-security-pipeline.test.js` **não está na
lista enumerada do `scripts.test`** (`grep -c` sobre o `package.json` dá 0), por
isso corre apenas em `npm run test:full` ou à mão. Foi ao juntá-lo ao grupo para
medir a auditoria que as duas falhas apareceram. Não as atribuo a mim, e não as
deixei passar: ficam corrigidas neste corte.

## Ainda não é dito

- **não é o percurso completo.** A auditoria medida aqui começa em
  `requestQuarantine`. O pedido que chega pelo IPC (`quarantine.ts`, canal do
  `requestQuarantine` manual) continua por medir de ponta a ponta, incluindo o
  que o `actions.log` escreve nesses pedidos — este ficheiro não afirma nada
  sobre `<baseDir>/logs/actions.log`, só sobre `history.jsonl`.
- **o restauro não tem linha de auditoria própria.** O §9 pede auditoria à
  quarentena; o `restore()` publicado no corte anterior move o ficheiro de volta
  e reescreve o manifesto, mas não há aqui nada que prove que a linha de restauro
  exista no `history.jsonl`. Antes de afirmar «auditado», é preciso medir o
  `restore` pelo motor, não só pelo manager.
- **«foi pedido» não fica no ficheiro.** A linha 2395 publica o evento e não
  regista. Se o processo morrer entre o pedido e o movimento, o `history.jsonl`
  não tem rasto nenhum da tentativa. O único rasto durável pré-movimento é o
  `isolationStatus:"recovery-required"` escrito no manifesto antes do `rename`,
  que é outra coisa e é coberto noutro corte.
- **política por omissão.** Continua `warn`. Nada neste ficheiro torna a
  quarentena automática operacional; o caso `authorization:"automatic"` mede o
  registo de um pedido feito nesse modo, não a decisão de o fazer.
- **ambiente**: Windows 10 e WSL2 sem interface gráfica. §15 pede validação numa
  Ubuntu/Mint de desktop; a montagem de pen USB continua por medir.

## Como voltar a correr

```bash
# Windows — os cinco casos de auditoria com o pipeline que partilha o motor
cd packages/service && npm run build && node --test --test-concurrency=1 \
  test/recovery-security-pipeline.test.js test/p3-quarantine-audit-engine.test.js

# WSL2, temporário em ext4 e sem root
cd /mnt/c/.../packages/service && TMPDIR=$HOME/tmp-cs node --test --test-concurrency=1 \
  test/recovery-security-pipeline.test.js test/p3-quarantine-audit-engine.test.js

# Regressão do serviço inteiro (é o que o §16 pede quando se mexe no engine.ts)
cd packages/service && npm test
```
