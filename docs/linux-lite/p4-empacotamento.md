# P4 — Empacotamento Linux Lite (`.deb` + `.AppImage`)

Medido em **WSL2 · Ubuntu 26.04 LTS · utilizador normal (`uid=1000`)**, com
electron-builder **25.1.8** (a versão que o `package-lock.json` do projeto já
traz) e Electron 33.4.11. Não é VM de desktop instalada (§15): este documento
prova a construção e o conteúdo dos pacotes, não a instalação por `apt`.

Nada do packaging Windows foi tocado: o bloco `build` de
`packages/desktop/package.json` (NSIS, `icon.ico`, `scan-engine.exe`,
`vendor/clamav`) e `scripts/package-windows.mjs` continuam os únicos caminhos do
artefacto Windows. Este usa `packages/desktop/electron-builder.linux-lite.yml` e
`scripts/linux-lite/package-linux.mjs`.

## Como se constrói e como se prova

```bash
node scripts/linux-lite/package-linux.mjs --check   # pré-voo, sem construir
node scripts/linux-lite/package-linux.mjs           # .deb + .AppImage
node scripts/linux-lite/package-linux.mjs --verify-only
bash scripts/linux-lite/wsl-p4-pacote-gui.sh --limpar-perfil
```

O script recusa correr fora de Linux: um `.deb` gerado noutro sistema operativo
não pode ser chamado artefacto validado (§14). Não publica nada — `--publish
never` vai no comando. O `--verify-only` abre o que está em `release-linux/`:
`dpkg-deb --info`/`--contents` para o `.deb`, e `--appimage-extract` para o
AppImage (o `unsquashfs` do sistema não conseguiu ler o `offset` squashfs
declarado no cabeçalho ELF — medido: `-b` inválido e `-o` sem super-bloco —,
portanto é o runtime do próprio pacote a desembrulhar-se num diretório
temporário). O que não puder ser lido sai `DESCONHECIDO`, nunca «sem .exe».

## Cinco obstáculos estruturais, todos medidos antes da correção

| Obstáculo | Evidência | Correção (só no caminho Linux) |
|---|---|---|
| `node_modules` nascido em Windows não tem binários de Linux | `ENOENT` no `app-builder-bin/linux/x64/app-builder`; `@rolldown/binding-linux-x64-gnu` em falta; `electron/dist/electron` era PE | préflight verifica ELF mágico (`7f454c46`), o binding e o `app-builder` ANTES de gastar minutos |
| O electron-builder corre `npm install --production` com `cwd` no `packages/desktop`, o npm resolve o worktree para a RAIZ e reificá-a | `node_modules/app-builder-lib/out` desapareceu a meio do build e o passo seguinte falhou no binário que ele próprio chamava | `npmRebuild: false` — em `packager.js:405` (25.1.8) isso devolve antes de `installOrRebuild` |
| Os `@cybersafe/*` são links de workspace; o `realpath` escapa do `appDir` | `packages/core/definitions/yara/default.yar must be under packages/desktop/` (`util/filter.js:28`) | `materializarWorkspaces()` copia o fecho de workspaces como diretórios reais dentro de `packages/desktop/node_modules` (só artefacto de build; nada em `packages/*` é tocado) |
| O `.deb` exige `Homepage` e e-mail do autor | erro de validação do `FpmTarget` (`:59-66`) | `extraMetadata.homepage` = o `origin` que o próprio repositório declara; `linux.maintainer: CyberSafe Team` — nenhum e-mail inventado |
| Metadados errados saíam para o pacote | `Section: default` (não é secção Debian), `Comment=` genérico, linhas inválidas `entryName=`/`comment=` no `.desktop`, e `MimeType=x-scheme-handler/cybersafe` sem registo nenhum | `linux.packageCategory: utils` ( → `--category` do fpm, `FpmTarget.js:138-140`), descrição em `extraMetadata`, bloco `desktop:` eliminado, `mimeTypes` retirado |

`@cybersafe/native-windows` continua DENTRO do pacote: é importação estática em
`packages/service/src/engine.ts:86` e em `usb-detection-adapter.ts:27`, tirá-lo
partia o `require` no arranque. É JavaScript puro — as negações `!**/*.exe` e
`!**/*.dll` retiram os binários Windows, e a verificação confirma 0 `.exe` e 0
`.dll` dentro de ambos os artefactos.

## O `.desktop` que sai do pacote

```
Name=CyberSafe Assistant Linux Lite
Exec="/opt/CyberSafe Assistant Linux Lite/cybersafe-assistant-linux-lite" %U
Type=Application  Icon=cybersafe-assistant-linux-lite  Categories=System;
Comment=Assistente de segurança do CyberSafe para Linux (edição Linux Lite)
StartupWMClass=CyberSafe Assistant Linux Lite
```

`Exec` é montado em `LinuxTargetHelper.js:92-104` (`installPrefix/produto/
executableName`, entre aspas porque contém espaços, com `%U`); `StartupWMClass`
é o `productName` por decisão do próprio electron-builder (`:117`), e **não foi
medido contra o `WM_CLASS` real** — precisa de uma janela aberta com ferramenta
que o leia. Não tem `MimeType`: sem `setAsDefaultProtocolClient` nem handler
`open-url` no produto (grep em `packages/`), declará-lo seria anunciar ao
ambiente gráfico uma capacidade que não existe.

Lacuna que eu julgava medida, e não era: o `dpkg-deb --contents` não mostra
nenhuma entrada em `/usr/bin`, e eu escrevi isso como «o lançador de consola não
existe». O `postinst` do próprio pacote (27 linhas, lido a `7ae8b24`) faz
exatamente o contrário:

```
update-alternatives --install '/usr/bin/cybersafe-assistant-linux-lite' \
  'cybersafe-assistant-linux-lite' '/opt/CyberSafe Assistant Linux Lite/cybersafe-assistant-linux-lite' 100 \
  || ln -sf '/opt/CyberSafe Assistant Linux Lite/cybersafe-assistant-linux-lite' '/usr/bin/cybersafe-assistant-linux-lite'
```

Ou seja: a entrada é criada à INSTALAÇÃO, não faz parte do arquivo — a mesma
classe de erro que a janela vazia de logo abaixo (ler o contentor em vez do
conteúdo). O que fica por medir é a instalação real: se o `postinst` corre numa
`apt install` num desktop Ubuntu/Mint, e se `/usr/bin/cybersafe-assistant-linux-lite`
fica de pé depois disso. Continua `não validado`, mas como instalação por
testar, não como falta de lançador.

## Conteúdo verificado

Corrida em `f3ee956` (mesmo binário do `refuseLinks` que destravou o arranque do
serviço empacotado), WSL2 · Ubuntu 26.04 LTS · uid 1000 · `DISPLAY=:0`:

| Artefacto | Bytes | SHA-256 |
|---|---|---|
| `CyberSafe Assistant Linux Lite-0.1.2-linux-amd64.deb` | 81 158 286 | `1ee8a3ecebaae65cf42b8543eefa7a7035f96c92ca56c9795ba48a629d8ec92d` |
| `CyberSafe Assistant Linux Lite-0.1.2-linux-x86_64.AppImage` | 117 321 763 | `52057e44c478c46807be866d46ab23bb0df5a05d94a1b573901013c684d7c755` |

Conteúdo lido (`dpkg-deb --contents`, `--appimage-extract`): `.deb` 160 entradas
com **0 `.exe`**, `.AppImage` 162 ficheiros com **0 `.exe` e 0 `.dll`**, `AppRun`
presente. No `control`: `Section: utils`, `Homepage` correta, `Depends: libgtk-3-0,
libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1,
libsecret-1-0`, `Recommends: libappindicator3-1`. `usrBin: []` — a lacuna do
lançador de consola confirmada nesta construção.

### O binário do pacote, executado

A pergunta do §14/§15 é se o artefacto funciona, não se empacota. Medido a
correr `linux-unpacked/cybersafe-assistant-linux-lite` com o perfil de dados
removido antes (`--limpar-perfil`):

- 8 processos vivos, incluindo o motor: `…/resources/app.asar/node_modules/@cybersafe/service/dist/index.js`.
- `[Electron] Serviço sinalizou service-ready via IPC.` e `[ServiceClient] Connected to pipe successfully! (ligação #1)` — a primeira vez que o serviço arranca a partir do pacote; antes disto falhava em `credencial do pipe indisponível` porque o `nlink=2` de uma diretoria POSIX recién-criada era lido como partilha.
- `stat` confirma `secrets nlink=2` no diretório aceito, e o `--user-data-dir` dos filhos é `~/.config/cybersafe-assistant-linux-lite` — a raiz de dados própria do pacote (§9), não a do dev.
- CDP do renderer devolveu o alvo `{type: "page", title: "CyberSafe Desktop", url: "file:///…/resources/…"}`: existe uma página carregada do asar. Só isso — o conteúdo estava vazio, como mostra a secção «a janela empacotada estava VAZIA».
- `[Electron] API local não arrancou (skipped): API não encontrada no artefacto` — ver §«API local HTTP fora do Linux Lite» abaixo; é escolha de âmbito, não falha.

### API local HTTP: fora do pacote, e porquê

O Windows empacota `@cybersafe/api` como recurso extra
(`scripts/package-windows.mjs:106,115`); a config Linux declara
`extraResources: []`, por isso `resolveApiEntryPath` não encontra a entrada e
`startLocalApi` devolve `{status: "skipped", reason: "API não encontrada no
artefacto"}` — caminho não-throwing por construção (`api-lifecycle.ts:333-349`:
a proteção não depende da API). Verificado que nenhuma funcionalidade da
interface depende dela: `grep` a `packages/app/src` por `apiBase`/`localhost:`
não devolve qualquer ficheiro. Consequência medida: o Linux Lite não abre
servidor HTTP em `127.0.0.1`; o único canal local é o socket Unix do serviço.
Se uma integração externa vier a precisar da API, isso é trabalho novo com
contrato próprio, não uma bandeira para ligar.

### Encerramento: a primeira leitura estava errada, e o instrumento tinha a culpa

A corrida de `f3ee956` deu `apos_SIGTERM_remanescentes=0`, que lido sozinho
parece encerramento limpo. Mas o log dessa mesma corrida fechava com
`GPU process launch failed: error_code=1002` e
`FATAL:gpu_data_manager_impl_private.cc(423)] GPU process isn't usable.
Goodbye.`, e a shell reportou `Trace/breakpoint trap` no processo principal. Um
processo que colapsa antes de o sinal chegar não demonstra nada sobre o sinal.

Duas medições separadas, ambas no `linux-unpacked` do `3be47af` para a frente:

1. **Sobrevivência sem sinal** (`--observar 90`): 8 processos vivos a cada 5 s
   até aos 90 s, `morreu_antes_de_esgotar=NAO`. O `rc` final é 137 (128+SIGKILL)
   porque foi o próprio script a desfazer-se do que ainda estava de pé. Ou
   seja: a aplicação não morre sozinha — o FATAL anterior veio do `pkill -TERM`
   da sonda, que apanhava o filho GPU do Chromium.
2. **SIGTERM só no navegador** (o processo cujo `cmdline` não tem `--type=`):
   `processo_principal=2028`, `principal_saiu_em=3s`,
   `apos_SIGTERM_remanescentes=0`. A última linha do log é
   `[Electron] Processo do Serviço encerrou com código: 0` — o motor foi
   parado pelo próprio desktop, com código 0, e nenhuma criança ficou órfã. Não
   houve FATAL nem trap quando o pedido foi feito a quem devia.

É isto que o §15 chama encerramento: sinal ao processo certo, os filhos a
terminarem por via da aplicação, zero resíduo. O caminho anterior (sinal a toda
a família) deixa de ser apresentado como prova de encerramento em lado nenhum.

Lacuna que sobra, e não é pequena: a janela estar aberta e responder ao CDP não
prova que o *conteúdo* do dashboard é o correto a partir do pacote. A captura de
ecrã do empacotado ainda não faz parte desta sonda.

## O CDP mentiu por omissão: a janela empacotada estava VAZIA

Ao acrescentar a leitura do DOM à sonda (`cdp-shot.mjs`), o pacote de `f3ee956`
respondeu:

```
DOM {"root":-1,"body":0,"texto":"","scripts":[]}
EXCECOES 0 []
```

Sem `#root`, sem qualquer `<script>`, sem texto, e sem uma única exceção. A
captura de ecrã pelo DevTools confirmou: um retângulo preto uniforme. Ou seja,
tudo o que a secção acima afirmou de verdade — processo, socket, janela, alvo
`file://` com título — era verdade sobre o *shell*, não sobre a interface. Um
alvo CDP existe mesmo que a página não tenha nada.

Causa, lida no código: o `vite build` do desktop produz apenas o shell
(main + preload); o `packages/desktop/index.html` é `<body></body>` por origem, e
é `scripts/stage-renderer.mjs` que compila `@cybersafe/app` e copia o renderer
por cima do `dist/index.html` (linhas 21-39: build do desktop, build da app,
`cpSync` e o `build-identity.json`). O `package-linux.mjs` nunca correu esse
pré-passo, e o seu préflight só perguntava se `dist/index.html` **existia** — o
que era sempre verdadeiro, vazio ou não.

Correção em `34e879a` e `1d3b8ab`, toda ela no caminho Linux:

- `construir()` passa a correr `node scripts/stage-renderer.mjs` antes do
  electron-builder;
- logo a seguir ao staging, e antes de qualquer escrita, `estadoRenderer()`
  exige o contentor `#root` e o `src` do script no `dist/index.html` **e**
  confere a identidade embutida no bundle com `verifyBuiltRenderer` — a mesma
  verificação que o pipeline Windows já usa, por isso não há critério paralelo
  inventado aqui. Falhando, sai `STAGING_SEM_RENDERER <motivo>` e nada é
  escrito;
- o préflight não reprova por isso (um `--check` não compila nada): reporta o
  estado do `dist` como nota, com o motivo medido;
- `package-linux.mjs` passou a ser importável (CLI atrás de `isMain`), e
  `scripts/test/linux-lite-package-renderer-guard.test.mjs` exerce a
  configuração exata deste bug — casca com `<body></body>` e versão certa no
  `main.js` — e prova que o guarda dispara com o motivo nomeado. 6 testes, 6
  passes, medidos em Windows e em Linux.

O `stage-renderer.mjs` é o mesmo do Windows e não foi alterado.

## A interface voltou: medido no pacote com o renderer dentro

Ambiente: WSL2 · Ubuntu · uid 1000 · `DISPLAY=:0` · node v22 · pacote
`linux-unpacked` construído a `1d3b8ab`, lido pela sonda CDP (`cdp-shot.mjs`).

```
{"type":"page","title":"CyberSafe Assistant — Painel de Segurança", ...}
DOM {"root":2,"body":1,"texto":"CYBERSAFE Assistant CYBERSAFE Inicie sessão na
     sua conta EMAIL SENHA Lembrar-me Entrar Não tem uma conta? Criar conta
     Proteção local — o estado real aparece no ","scripts":
     ["…resources/app.asar/dist/assets/index-Bt7R5Ual.js"]}
EXCECOES 0 []
SHOT_CDP_OK bytes=428844
```

Contra a mesma medição antes do staging (`root:-1`, `scripts:[]`, texto vazio,
PNG de 4 713 bytes = retângulo preto): o `#root` tem 2 filhos, há um `<script>`
carregado de dentro do `app.asar`, o texto é o ecrã real da aplicação, e a
captura passou de 4 713 para 428 844 bytes. Zero exceções de consola, outra vez
— o que confirma que a falha anterior era de conteúdo em falta, não de código
partido. O título da janela também mudou: era `CyberSafe Desktop` (o shell),
passou a `CyberSafe Assistant — Painel de Segurança` (o documento da app).

Encerramento do mesmo pacote: `processo_principal=457`,
`principal_saiu_em=3s`, `apos_SIGTERM_remanescentes=0`, última linha do log
`[Electron] Processo do Serviço encerrou com código: 0`.

## A janela abria-se sem API: `skipped` com ecrã de login

O pacote de `f62e0bf` mostrava a interface e o serviço ligados, mas o log dizia
`API local não arrancou (skipped): API não encontrada no artefacto`. Janela com
login que não autentica não é um produto — é uma maqueta.

Causa, no pipeline e não na aplicação: `package-linux.mjs` compilava os
workspaces de que o `desktop` precisa mas nunca o workspace `api`, por isso
`packages/api/dist` não existia quando `resolveApiEntryPath()`
(`desktop/src/api-lifecycle.ts:155-168`) procurava
`app.asar/node_modules/api/dist/index.js` e devolvia `null`. O pipeline Windows
já compila a `api` (`BUILD_WORKSPACES` em `scripts/package-windows.mjs`); a lista
Linux estava encurtada.

Correção (`9907c0f`): `compilarWorkspaces()` com a mesma lista do Windows e
`estadoApi()` — se a entrada não estiver no palco, o build recusa ANTES de
escrever seja o que for, porque um `.deb` sem API é exatamente o artefacto que
engana quem o testa. Protegido por
`scripts/test/linux-lite-package-api-guard.test.mjs` (3 casos, incluindo o
negativo e a verificação de que o guard e o `api-lifecycle.ts` procuram a mesma
entrada).

## O addon nativo não era do Electron: `ERR_DLOPEN_FAILED`

Com a API dentro, o filho da API morria a abrir o SQLite:

```
ERR_DLOPEN_FAILED … better_sqlite3.node: NODE_MODULE_VERSION 127 … 130 required
```

`127` é o ABI do Node com que o `npm install` trouxe o `better-sqlite3`; `130` é
o do Electron 33.4.11. No WSL não havia `g++`, `cc` nem `make` (medido:
AUSENTE), portanto reconstruir não era opção — e o pipeline Linux tem
`npmRebuild: false` precisamente para o electron-builder não reificar o worktree.

Correção (`9907c0f`): trocar o binário com o instalador do próprio addon e depois
**obrigar** a medição antes de empacotar.

```
node node_modules/prebuild-install/bin.js --runtime=electron \
     --target=33.4.11 --arch=x64 --platform=linux     # em node_modules/better-sqlite3
GATE_ABI ABI_OK 130 33.4.11 1                          # abre a DB dentro do Electron-as-node
```

O gate corre antes de qualquer escrita no palco; sem `ABI_OK` o build pára. É o
equivalente Linux do «rebuild nativo do pipeline» que o Windows já faz
(`scripts/package-windows.mjs:678-694`) — sem ele a ABI errada viajaria em
silêncio, como viajou.

Dependência externa a declarar: o `prebuild-install` vai buscar o binário ao
sítio do `vendor` do addon. A primeira construção de uma máquina sem cache precisa
de rede; as seguintes usam o que já está em `node_modules/better-sqlite3`.

## A raiz de dados da API não era a do Linux Lite

Medido no `.deb` de `9907c0f`, com `--user-data-dir` apontado para um perfil de
teste limpo:

```
~/linux-lite-validation/perfil-ui5/secrets          ← certo (sessão, por perfil)
  FORA_DO_PROFILE: api-lifecycle.jsonl              ← ~/.cybersafe-service/
  FORA_DO_PROFILE: cybersafe.db                    ← ~/.cybersafe-service/
```

O serviço Linux Lite escreve em `~/.cybersafe-linux-lite` (é o que
`core/dev-isolation.ts:43` e `defaultServiceBaseDir()` decidem por plataforma); a
API tinha o nome fixo no seu próprio módulo — `dbPessoalApi()` devolvia
`path.join(os.homedir(), ".cybersafe-service", "cybersafe.db")`. Consequência
concreta: os utilizadores registados e o registo de ciclo de vida do pacote Linux
iam para a raiz com o nome do produto Windows — §1 proíbe partilhar bases entre
versões, §9 pede raiz exclusiva.

Correção: `dbPessoalApi()` passa a construir a partir de
`defaultServiceBaseDir()` (o único ponto que descreve `~` + nome), mantendo o
caminho de Windows e macOS byte-idêntico. Testes em
`packages/api/test/dev-isolation.test.js`: `win32`/`darwin` =
`.cybersafe-service`, `linux` = `.cybersafe-linux-lite` e sem a substring
Windows, mais o negativo de sempre (DEV a apontar para a DB pessoal da plataforma
atual é recusado pela razão certa). Regressão do caminho partilhado: **48/48**
nesta ficha e **429/429** no workspace `api` corrido em Windows.

Reconstrução e medição depois da correção (WSL2, 19:50, mesmo `.deb` extraído):

```
NAO_EXISTE ~/.cybersafe-service                     ← não foi recriado
~/.cybersafe-linux-lite/cybersafe.db   77 824 B
~/.cybersafe-linux-lite/api-lifecycle.jsonl   394 B
```

## Artefactos do MVP (construídos em WSL2 · Ubuntu 26.04, não instalados por `apt`)

| Artefacto | Bytes | SHA-256 |
|---|---|---|
| `CyberSafe Assistant Linux Lite-0.1.11-internal.pap-r7.20261031-linux-amd64.deb` | 81 774 768 | `7846b356a3d5bf4460ae0417cc4b7d37d3083a88880726bee3eb049eefcf0730` |
| `CyberSafe Assistant Linux Lite-0.1.11-internal.pap-r7.20261031-linux-x86_64.AppImage` | 119 551 369 | `95f769b1e59809197e97d1c1f1ab00c548f4a612e3459c3ee97e7ff9283e89af` |

Conteúdo do `.deb` desta corrida: 160 entradas, **0 `.exe`**, `.desktop`
presente, ícone presente. O `usrBin: []` é facto medido e não lacuna escondida: o
electron-builder não cria lançador em `/usr/bin`; o `Exec=` do `.desktop` aponta
para `/opt/CyberSafe Assistant Linux Lite/cybersafe-assistant-linux-lite`, que é
o caminho que uma instalação real usa.

Ultrapassados por estes, e mantidos aqui porque registam o que foi medido:
`256a27d0…` (0.1.11 sem API compilada), `70fe4ec3…` (0.1.11 com API, antes do
isolamento da raiz de dados), `6e23bdd1…`/`f8b69c21…` (0.1.2, versão errada).

## Como se executa o pacote (fora do repositório de desenvolvimento)

```bash
# extração para validação, sem root e sem tocar no sistema
dpkg-deb -x "CyberSafe Assistant Linux Lite-0.1.11-internal.pap-r7.20261031-linux-amd64.deb" ./extraido
./extraido/"opt/CyberSafe Assistant Linux Lite"/cybersafe-assistant-linux-lite

# instalação real (precisa de root; ainda NÃO validada — ver limitações)
sudo apt install ./extraido.deb
cybersafe-assistant-linux-lite          # ou pelo menu, via /usr/share/applications
```

O binário do pacote não depende do repositório: a única raiz de escrita é
`~/.cybersafe-linux-lite` (serviço e API) e `<userData>` do Electron (sessão em
`secrets/auth-session.bin`). A extração acima correu a jornada completa de
interface sem o clone em disco.

## A jornada de interface, medida no pacote final

`scripts/linux-lite/cdp-drive.mjs` conduz o renderer do pacote extraído pelo
canal que uma pessoa usa: ecrã de entrada → «Criar conta» → preencher o
formulário → submeter → navegar. Não há atalho: `/auth/dev/ensure-admin` foi
removido em 2026-10-09 e o condutor não chama `/auth/*` por fora — a sessão é
consequência do formulário. Ambiente: WSL2 · Ubuntu 26.04, 19:52, `.deb`
`7846b356…` extraído, perfil `--user-data-dir` limpo.

| Passo | O que o pacote devolveu |
|---|---|
| entrada | `Inicie sessão na sua conta`, campos `email/password/checkbox` |
| formulário | 4 campos obrigatórios (`O teu nome`, `o.teu@email.com`, `Mínimo 6 caracteres`, `Repete a palavra-passe`) + botões `Pessoal`, `Empresa`, `Criar conta` |
| submeter | `A criar a conta…` e, do lado do serviço, utilizador novo na DB do Linux Lite |
| Painel | `O essencial, sob controlo.` · `Proteção com limitações` · `Ainda sem análises registadas` · `Os teus motores de análise` |
| Análise de Segurança | `O que pretende analisar?` · `ESTADO ATUAL DOS MOTORES` · `Monitorização de unidades USB` |
| Monitor em Tempo Real | `Eventos de Segurança` · `Processos Ativos` — **20 linhas**, amostra `systemd ~ 1 ~ 0.9% ~ 13 MB ~ NEUTRAL`, `chronyd-starter ~ 178 ~ 0.1% ~ 2 MB`, `cron ~ 179 ~ 0.0% ~ 3 MB` |
| PC Center | `Processador` · `Memória RAM` · `Armazenamento` · `Rede Local` — `Uso de CPU ~ 23 % ~ snapshot de hardware do serviço · lido 2026-11-02T19:52:33.837Z ~ medido`; `Temperatura da CPU ~ — ~ instante não publicado ~ desconhecido` |
| Gestor de Tarefas | `Gestão avançada de processos e análise`, `Actualização automática a cada 2 s`, `Terminação individual limitada — aplicações comuns elegíveis; sujeita a confirmação` |
| MATRIX | painel MATRIX montado a partir da mesma janela |
| Otimizar | `VERIFICAÇÕES AUTOMÁTICAS`, `Espaço livre em disco`, `MANUTENÇÃO RECOMENDADA` — e os dois títulos Windows (§11, em aberto) |
| exceções | `excecoes_renderer 0` |
| encerramento | SIGTERM só no processo principal: `saiu_em=3s`, `remanescentes=0` aos 3 s e aos 8 s, `remanescentes_finais=0` |

Três coisas que só se veem quando se pergunta ao DOM em vez de adivinhar:

- **O `—` do PC Center é o estado certo.** A temperatura não é publicada no
  WSL2; a vista mostra-lhe um travessão com `desconhecido` ao lado, não um zero
  inventado (§6). É a diferença entre «não medido» e «medido a zero».
- **O `linhas:0` do Gestor de Tarefas não prova lista vazia.** A vista usa
  painéis próprios (o campo de pesquisa está lá, `campos:["text"]`); a sonda só
  conta `<table> tbody tr`, como se vê pelas 20 linhas do Monitor. Fica como
  limitação do instrumento, não como resultado da aplicação.
- **O assistente de boas-vindas tapava vistas.** Na corrida de 19:44, «Gestor de
  Tarefas» e «MATRIX» foram capturados com o passo 1 de 3 por cima, e as
  leituras vinham uma vista desalinhadas das capturas. Agora o condutor fecha o
  assistente («Agora não») e espera pela assinatura de títulos antes de capturar;
  sem mudança, diz `sem_mudanca` em vez de fingir que leu a vista certa.

O banner que aparece depois do registo está explicado e é honesto:
`Um componente da proteção reporta um erro. Confirmado pelo serviço: YARA (em
erro). Isto é um estado confirmado, não uma espera.` — ou seja, o pacote não
esconde um motor em falha atrás de um «protegido». O que ainda não se sabe é
**porque** falha o YARA neste ambiente, e isso é trabalho aberto (não se declara
motor ativo sem medir, §7).

## Limitações do que está escrito acima

- **Ambiente.** Tudo o que está nesta página foi medido em WSL2 (Ubuntu 26.04,
  `uid=1000`, WSLg para a janela). O §15 diz que WSL2 não substitui a validação
  de uma aplicação desktop instalada numa distribuição: `apt install`, `postinst`,
  a entrada no menu e o ícone visto pelo gestor de janelas continuam **não
  validados**, e não há aqui resultado nenhum a fazê-los parecer validados.
- **Lançador.** Medido: `usrBin: []`, `temLauncher: false`, `temDesktop: true`.
  O `.desktop` aponta para o binário em `/opt/...`; não há symlink em `/usr/bin`.
  A linha `sudo apt install ./…deb` deste documento é o comando a correr, não um
  resultado obtido.
- **Cópia Windows a aparecer em Linux.** A vista Otimizar mostra
  «Firewall do Windows» e «Saúde geral do Windows»; o assistente de boas-vindas
  abre com «Proteção em tempo real» e o Monitor mostra «Camada de Contenção de
  Rede» — nenhum desses mecanismos existe no Linux Lite (a proteção em tempo real
  com fanotify é §12, e o firewall do §11 ainda não é consultado). É defeito de
  estado, não lacuna de medição: está em aberto.
- **Gestor de Tarefas.** A vista monta-se e declara o contrato certo
  («Terminação individual limitada — aplicações comuns elegíveis; sujeita a
  confirmação», atualização a cada 2 s), mas a sonda não conta linhas porque a
  lista não usa `<table>`. A listagem real está medida no serviço (P1,
  `p1-process-listing.md`); a captura a partir do pacote ainda não está.
- **Scanner manual.** A vista foi lida a partir do pacote (motores, unidades
  USB, análise em segundo plano), mas uma análise de ficheiro/pasta conduzida
  pela interface do pacote ainda não foi feita: o seletor é um diálogo nativo do
  Electron e o CDP não o aciona. Enquanto não for, o §7 do plano não se pode
  dar por fechado a partir do artefacto.
- **YARA em erro.** O pacote reporta-o como em erro, e reporta-o bem. A causa
  não foi investigada; declarar o motor «ativo» sem a causa resolvida seria o
  contrário do que esta secção prova.

O que isto NÃO diz: o que se mede é o ecrã de entrada, apresentado sem qualquer
interação. O dashboard, a navegação e os painéis ficam detrás de uma sessão e
continuo a não os ter lido a partir do pacote. E WSL2 não é uma instalação: a
linha `.deb`/AppImage instalados mantém-se `não validado`.

## Versão do pacote: a fonte única, e o `.deb` que provava o contrário

Medido no pacote de `1d3b8ab`: o `.deb` chamava-se
`CyberSafe Assistant Linux Lite-0.1.2-linux-amd64.deb` e o `control` dizia
`Version: 0.1.2` — a versão interna do `packages/desktop/package.json`, que
`app-version.mjs:17-19` declara explicitamente «não é identidade do produto».
Dentro do mesmo ficheiro, o `__BUILD__` do renderer dizia
`0.1.11-internal.pap-r7.20261031`. É a divergência de três fontes que esse
módulo existe para evitar, a reproduzir-se no caminho Linux.

`7ae8b24` passa a versão canónica por `--config.extraMetadata.version` (a fonte
continua a ser uma; o YAML não é editado) e `f62e0bf` acrescenta
`identidadeDoDeb()`, que lê o `control` de volta. Reconstrução (WSL2, mesmo
ambiente):

```
DEB_IDENTIDADE {"esperado":"0.1.11-internal.pap-r7.20261031",
  "obtido":"0.1.11~internal.pap~r7.20261031","forma":"fpm:-para~","versaoOk":true,
  "homepage":"https://github.com/MatrixChill/cybersafe-assistant",
  "maintainer":"CyberSafe Team","section":"utils",
  "descricao":"Assistente de segurança do CyberSafe para Linux (edição Linux Lite)"}
```

Dois factos que não eram de saber: o fpm reescreve cada `-` extra em `~` (só um
hífen é permitido, é o separador upstream/revision) — a comparação literal teria
chamado errado a um pacote certo; e `~` ordena ANTES do fim de versão, pelo que
uma pré-lançamento fica corretamente mais antiga que a versão final. O
`Homepage`, o `Maintainer` e a `Description` do YAML continuam lá, portanto o
`--config` da linha de comandos funde sem apagar o ficheiro. O mesmo verificador,
apontado ao `.deb` antigo, diz `forma:"divergente"`, `versaoOk:false` — tem
dentes dos dois lados.

Artefactos desta corrida (`.exe`: 0 no `.deb` de 160 entradas; 0 `.exe` e 0
`.dll` no `.AppImage` de 162 ficheiros, `AppRun` presente):

| Artefacto | Bytes | SHA-256 |
|---|---|---|
| `CyberSafe Assistant Linux Lite-0.1.11-internal.pap-r7.20261031-linux-amd64.deb` | 81 744 388 | `256a27d0ef6b20e52444fa4ad464fff813cf6775541053f7c5eaedeb9a2e639f` |
| `CyberSafe Assistant Linux Lite-0.1.11-internal.pap-r7.20261031-linux-x86_64.AppImage` | 119 518 841 | `980296a31202ebc6625d14459893b67b2e89a7a86b4f686c92e9bf5c4b27c135` |

As linhas da tabela «Conteúdo verificado» lá em cima (`0.1.2`) são corridas
anteriores, ultrapassadas por esta; mantêm-se porque registam o que foi medido,
não o que hoje sairia.
