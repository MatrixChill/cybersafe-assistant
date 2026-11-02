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
