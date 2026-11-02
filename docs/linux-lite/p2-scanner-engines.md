# P2 — Scanner Linux: estados reais dos motores

Documento do Linux Lite. Cada linha «medido» foi observada neste host; o que
não foi observado está marcado como em falta, não como concluído.

## Âmbito medido nesta alteração

A resolução dos binários do motor YARA clássico era **cega à plataforma**. O
efeito foi medido antes de qualquer alteração, em WSL2:

```
platform=linux
RESOLVIDO={"yara":"…/vendor/yara/yara64.exe","yarac":"…/vendor/yara/yarac64.exe",
           "dir":"…/vendor/yara"}
  yara:   magic="MZ" tam=2426368 mode=0o644
  yarac:  magic="MZ" tam=2371584 mode=0o644
```

Ou seja: no Linux o `YaraEngine` **declarava-se disponível** com dois
executáveis Windows. O repositório traz `vendor/yara/yara64.exe`,
`yarac64.exe` e `vcruntime140.dll`, e o resolutor subia a partir do módulo
compilado até `vendor/yara` sem perguntar em que sistema corria. Pior: com
interop do WSL, um PE com bit de execução *executa* — o Scanner Linux estaria
a analisar ficheiros com um binário de Windows, contra
`Não reutilizar executáveis Windows`/`Não os executar no Linux`.

## O que passou a ser o critério

`packages/core/src/yara-classic.ts`:

| Plataforma | Nomes aceites | Origens procuradas | Critério de aceitação |
|---|---|---|---|
| `win32` | `yara64.exe`, `yarac64.exe` | `CYBERSAFE_YARA_BIN_DIR` → `resources/yara` → `vendor/yara/<versão>` → `vendor/yara` | ficheiro existe (contrato histórico, intacto) |
| POSIX | `yara`, `yarac` | as mesmas **e depois** `/usr/bin`, `/usr/local/bin`, `/snap/bin`, `/opt/homebrew/bin` + entradas do `PATH` | existe **e** tem bit de execução **e** não é `.exe` **e** o magic não é `MZ` |

Regras que não podem ser violadas por conveniência:

- `CYBERSAFE_YARA_BIN_DIR` continua **autoritativo nos dois sistemas**: com ele
  definido, nem o `vendor` nem o `PATH` são considerados. Um directório
  indicado sem binários utilizáveis é indisponibilidade declarada.
- Em POSIX, um `.exe` ou uma imagem `MZ` nunca é motor, mesmo chamado `yara`.
  Isto é o que fecha o caso WSL com `/mnt/c/...` dentro do `PATH` — medido: com
  o `PATH` real do WSL (que inclui directórios Windows) o resolutor devolve
  `null`.
- `origem` passa a ser declarada (`explicito | pacote | vendor | sistema`).
  `sistema` quer dizer «instalado fora do pacote, versão não pinada por nós»;
  não se confunde com o binário vendorizado cujo `VENDOR.json` publica sha256.
- A separação da `PATH` POSIX é fixada em `:`, não no separador do host, para
  que a resolução POSIX seja testável numa máquina Windows.

## Medido depois da alteração (WSL2, `Linux 6.6.114.1-microsoft-standard-WSL2 x86_64`, node v22.23.4, uid 1000, sem root)

| Observação | Resultado |
|---|---|
| `resolveYaraClassicBinaries()` com o ambiente real do WSL | `null` |
| `nomesExecutaveisYara('linux')` | `{yara:"yara", yarac:"yarac"}` |
| `descricaoProcuraYara()` | `… (procura em yara e yarac); em POSIX os binários de Windows não são aceites` |
| `YaraEngine.isAvailable` | `false` |
| `YaraEngine.health` | `{"status":"error","coverage":"unknown"}` com o detalhe a nomear a plataforma e as origens procuradas |
| `scanFile(ficheiro benigno)` | `YaraScanError: YARA scanner is unavailable; file was not evaluated.` |
| Testes dos motores YARA corridos **nativamente** no Linux | `# tests 13 # pass 13 # fail 0` (a suite de binários Windows fica com skip motivado, não passa em falso) |

A linha do `scanFile` é a que importa para
`Nunca apresentar um ficheiro como limpo apenas porque um motor estava
indisponível`: sem motor não há lista vazia, há recusa. Esse comportamento já
existia no `YaraEngine` (`status: "unavailable"`, `coverage: "unknown"`); o que
estava partido era a *chegada* a ele, porque o motor se fingia disponível.

## Regressão Windows (clone isolado, host win32)

- `@cybersafe/core`: `# tests 1172 # pass 1140 # fail 0 # skipped 31`.
- `@cybersafe/service`: `tsc` sem erros.
- Os nomes `.exe`, a ordem de procura e o critério em Windows não mudaram; há
  um teste que o afirma com binários reais no disco
  (`Windows: o contrato histórico é preservado`).
- Uma asserção Windows existente (`…/não encontrado/` no diagnóstico de motor
  ausente) foi mantida: a frase continua a conter `não encontrado`, agora com a
  plataforma e as origens procuradas.

## Testes acrescentados

`packages/core/test/yara-classic-posix.test.js` (13 casos, deterministas em
qualquer host porque injectam o leitor de disco): nomes por plataforma; `.exe`
vendorizado não é motor em Linux; par POSIX válido resolve com origem `vendor`;
falta de bit de execução recusa; `MZ` com nome POSIX recusa; YARA instalado
entra pela `PATH` com origem `sistema`; o override por ambiente não cai para a
`PATH`; contrato Windows preservado; origens candidatas por plataforma; cada
razão de recusa nomeada; a frase de procura; o diagnóstico de indisponibilidade.

## ClamAV medido neste host (mesmo ambiente WSL2)

Sonda: `scripts/linux-lite/wsl-p2-clamav-probe.sh`. Nada estava instalado
(`clamscan`, `clamdscan`, `freshclam`, `clamconf` = AUSENTE). O que foi
observado:

| Observação | Resultado |
|---|---|
| `clamavBinaryName('linux')` | `clamscan` (sem `.exe`) — o nome já era sensível à plataforma |
| candidatos com o ambiente real | 68; fontes `path` e `unix` |
| candidatos dentro de `/mnt/c` | **56** (o `PATH` do WSL traz directórios Windows) |
| `firstExistingClamavBinary` | `null` |
| `ClamavBridge.isAvailable()` | `false` |
| `ClamavBridge.health` | `{"status":"unavailable","detail":"clamscan not found or failed: spawn clamscan EACCES"}` |
| `scanFile(ficheiro benigno)` | `{status:"unavailable", infected:null}` — **sem `clean`, sem lista vazia** |

A última linha é o requisito cumprido para os dois motores: a ausência de motor
produce recusa, não «limpo».

Dois factos a não esconder:

- O detalhe `spawn clamscan EACCES` não significa «não encontrado»: o `probe`
  tenta o spawn por NOME e, sob interop do WSL, esbarra numa permissão. O estado
  apresentado (`unavailable`) está certo; a *razão* é que está errada, porque
  mistura ausência com falha de execução.
- A lista de candidatos é dominada por caminhos `/mnt/c/...`. Como a escolha é
  por `existsSync`, um ficheiro **chamado** `clamscan` num directório Windows
  seria aceite como motor sem qualquer verificação de formato ou bit de execução
  — é a mesma classe de defeito que o YARA tinha. Aqui não existia nenhum, por
  isso o resultado foi `null`; **o critério de recusa é agora partilhado** —
`packages/core/src/executavel-posix.ts` é a única definição (nome `.exe`, magic
`MZ`, sem bit de execução, ilegível) e `recusaExecutavelPosix` passou a ser
reexportado a partir de lá, sem mudar o que o YARA faz.

### O mesmo critério aplicado ao ClamAV

Antes, a escolha do `clamscan` só perguntava «existe no disco?». Em WSL isso
chega: um `CYBERSAFE_CLAMSCAN_PATH` a apontar `/mnt/c/.../clamscan.exe`, ou um
PE com nome POSIX, era aceite como motor e lançado — e a interop do WSL ainda
o deixaria correr. Agora:

| ponto | o que mudou |
|---|---|
| `selecionaClamavBinario(candidatos, plataforma, leitor)` | escolha por existência **e** por proveniência; o recusado sai com `motivo`, não silenciosamente |
| `ClamavBridge.resolveBinaryPath()` | o pin explícito é verificado; recusado ⇒ segue para o PATH como se não fosse pin, e traz os motivos consigo |
| `classifyClamavHealth(… , binarioRecusado)` | o estado do motor distingue «não está» de «está e não serve»: `unavailable` com o motivo e o remédio, em vez de `clamscan not found or failed` |
| `diagnoseClamavBinary()` | campo novo `recusados: {path, source, motivo}` — «existe mas não serve» deixa de ser dito como «não encontrado» |
| Windows | `recusarBinarioNaPlataforma` devolve `null` em `win32`: a seleção continua só por existência e o `where` do DEV não mudou |

Medido no clone isolado (host Windows, runner `node --test`):
`packages/core/test/clamav-binario-posix.test.js` — 10 casos, todos passam: pin
`.exe` recusado com o motivo, PE com nome POSIX recusado pela assinatura, sem
bit de execução recusado, ELF executável escolhido, candidato recusado não tapa
o seguinte, nada no disco ⇒ `null` sem invenção, Windows escolhe por nome, o
diagnóstico distingue «recusado» de «não encontrado», e o `detail` do motor
deixa de dizer «not found» a um binário que está lá. A classificação partilhada
continua a dar exatamente o texto antigo quando não há recusa
(`clamav-db.test.js`, sem alterações).

### A recusa medida em WSL2 com o leitor real

O teste injectado prova a regra; não prova que a regra vê o disco.
`scripts/linux-lite/wsl-p2-clamav-proveniencia-medicao.mjs` corre a mesma
seleção com `leitorBinarioReal` — `statSync`, `accessSync(X_OK)` e os dois
primeiros bytes lidos do ficheiro — sobre ficheiros que existem mesmo. O binário
Windows é **copiado e lido, nunca lançado**, e os ficheiros criados pela medição
são apagados por ela própria.

Ambiente medido: `Linux 6.6.114.1-microsoft-standard-WSL2 x86_64`,
`node v22.23.4`, `uid=1000`, sem root.

| candidato real | resultado medido |
|---|---|
| `/mnt/c/Windows/System32/notepad.exe` | recusado: «é um executável Windows (.exe)» |
| os **mesmos bytes** copiados para `/tmp/cs-proveniencia-…-1` (sem extensão) | recusado: «é uma imagem PE de Windows (magic MZ)» |
| script de shell com `0644` | recusado: «não tem permissão de execução» |
| `/bin/true` | escolhido — um binário Linux não é collateral desta regra |
| pin = notepad.exe, `PATH=""`, lista completa de candidatos | `escolhido: null`, recusado com o motivo |
| `diagnoseClamavBinary` no disco real | `resolved: null`, `recusados` com o motivo, e `exists: true` na mesma linha |

Os seis casos deram `CONFORME`. A segunda linha é a que importa: um PE com nome
POSIX passa no «existe?» e só é apanhado pela assinatura — é isso que separa
«está no disco» de «é o motor desta plataforma». A última linha é o que a UI
poderá mostrar: o mesmo caminho aparece como existente **e** recusado, em vez de
simplesmente não encontrado.

Regressão Windows corrida com estas duas alterações, no mesmo clone:
`@cybersafe/core` 1190 testes, 1158 passam, 0 falham, 31 saltados (era
1180/1148 antes dos 10 casos novos); a família ClamAV do `@cybersafe/service`
(14 ficheiros, incluindo `dist-clamav-pin-no-db-integration` e
`dist-clamav-freshclam-resolve`) 116 testes, 109 passam, 6 saltados, **1
falha** — e a falha é `scan-post-batch-no-double-clamav`, uma das 8
pré-existentes já documentadas em
[`p1-process-listing.md`](./p1-process-listing.md), com o mesmo sintoma
`clean → inconclusive`.

## Ainda não medido (não dar por feito)

- O `EACCES`/`ENOEXEC` do **momento do `spawn`** de um binário que passou na
  seleção continua colapsado em `clamscan not found or failed: …`
  (`classifyClamavHealth`, `clamav.ts:2594`). A recusa por proveniência deixou
  de cair nesse texto — um pin a um `.exe` agora diz «existe no disco mas não é
  motor desta plataforma» e aponta o remédio — mas um ficheiro que parece bom e
  falha ao lançar ainda é dito como «não encontrado».
- O texto novo vai com o **nome do ficheiro, não o caminho** (o caminho
  completo fica em `diagnoseClamavBinary`, que é local). É a mesma regra que já
  protege o contexto da MATRIX (`matrixContext.ts:119`): texto livre que pode
  levar um caminho de utilizador não sai para o modelo.
- Não testado num ambiente gráfico: o `detail` chega ao ecrã pela linha técnica
  de `ProtectionDetails.tsx:354` (`technical && sub?.detail`) e por
  `ReportsPage.tsx:335`, mas falta ver isso numa janela Electron em Linux. A
  origem (`ClamavBridge.health`) está medida por teste; o percurso até ao pixel,
  não.
- Não há ClamAV instalado neste WSL, portanto só está medida a **ausência**
  reportada com honestidade e a recusa do binário Windows; não há aqui uma
  análise real com `clamscan`/`clamd` nem prova de base de assinaturas fresca em
  Linux.
- Não há `yara`/`yarac` de Linux instalados neste WSL, portanto o caminho
  `origem: "sistema"` está provado por fixture e por código, **não** por um
  motor YARA real a correr em Linux. Medir isso exige `apt install yara` (ou
  binário equivalentemente provenientado) e volta ao mesmo ponto de medida.
- YARA-X continua sem afirmação: não foi verificado runtime nem dependências.
- O estado dos motores na janela do GUI em Linux (a página do Scanner a mostrar
  «indisponível» com este detalhe) não foi validado em ambiente gráfico.

## Reproduzir

```bash
# do lado Windows, no clone isolado
npm run build -w @cybersafe/core
npm test -w @cybersafe/core
node --test packages/core/test/yara-classic-posix.test.js

# do lado WSL2 (cópia Linux em $HOME/cybersafe-linux-lite)
wsl.exe -- bash -lc "tr -d '\015' < /mnt/c/…/scripts/linux-lite/wsl-p2-clamav-proveniencia.sh > /tmp/clamav-prov.sh && bash /tmp/clamav-prov.sh"
wsl.exe -- bash -lc "tr -d '\015' < /mnt/c/…/scripts/linux-lite/wsl-p2-yara-linux.sh > /tmp/yara-linux.sh && bash /tmp/yara-linux.sh"
wsl.exe -- bash -lc "tr -d '\015' < /mnt/c/…/scripts/linux-lite/wsl-p2-yara-contar.sh > /tmp/contar.sh && bash /tmp/contar.sh"
```
