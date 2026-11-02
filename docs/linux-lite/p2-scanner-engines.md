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

## Ainda não medido (não dar por feito)

- **ClamAV em Linux não foi medido nesta sessão.** O código já é sensível à
  plataforma (`clamavBinaryName` devolve `clamscan` fora de Windows), mas não
  há aqui resultado observado de detecção, de base de assinaturas ou de uma
  análise real com `clamscan`/`clamd` neste host.
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
wsl.exe -- bash -lc "tr -d '\015' < /mnt/c/…/scripts/linux-lite/wsl-p2-yara-linux.sh > /tmp/yara-linux.sh && bash /tmp/yara-linux.sh"
wsl.exe -- bash -lc "tr -d '\015' < /mnt/c/…/scripts/linux-lite/wsl-p2-yara-contar.sh > /tmp/contar.sh && bash /tmp/contar.sh"
```
