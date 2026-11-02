# CyberSafe Assistant Linux Lite — README

Edição experimental do CyberSafe Assistant para Linux, na branch
`experimental/linux-lite-qoder` do repositório isolado em
`C:\Users\caioc\.cybersafe-integration\qoder-linux-lite\repo`. Não é um produto
novo: reutiliza o Electron, o React, o `packages/app`, o motor do
`packages/service` e os tipos partilhados do Windows, com providers de Linux
onde o código era especificamente Windows.

**O que isto não é:** não substitui nem altera a versão Windows (o trabalho da
PAP Windows continua no worktree do Codex, intocado por esta branch); não há
merge para `main`, nem Release, nem publicação. Nada aqui foi instalado numa
VM Ubuntu/Mint com ambiente gráfico de desktop — ver «Ambiente».

## Ambiente de cada resultado

Todos os resultados deste diretório foram medidos em **WSL2 · Ubuntu 26.04 LTS ·
WSLg (`DISPLAY=:0`) · utilizador normal (`uid=1000`), sem root**. A missão §15
diz que o WSL2 serve para testes dirigidos mas não substitui a validação de uma
aplicação desktop instalada numa distribuição: cada página declara o seu
ambiente, e o que não foi medido está marcado como em falta.

## Isolamento

| Coisa | Windows | Linux Lite |
|---|---|---|
| Branch | R7 / `main` (Codex) | `experimental/linux-lite-qoder` |
| Working copy | worktree do Codex | clone próprio + cópia WSL em `~/cybersafe-linux-lite` (origem: `/mnt/c/.../qoder-linux-lite/repo`) |
| Raiz de dados do serviço | `~/.cybersafe-service` | `~/.cybersafe-linux-lite` (produção) / `~/.cybersafe-linux-lite-dev` (dev) |
| Canal app↔serviço | named pipe | socket Unix (`engine.sock`) |
| Credenciais MATRIX | `safeStorage`/DPAPI | `safeStorage` com mecanismo declarado no ecrã; nada transportado do perfil Windows |

Nenhuma base de dados, cache ou credencial do Windows é lida, copiada ou
partilhada. O empacotamento Windows (`build` de `packages/desktop/package.json`,
NSIS, `scripts/package-windows.mjs`) não é tocado por este caminho.

## Comandos

Tudo corre em Linux. O `wsl-bootstrap.sh` instala Node 22 em `~/.local/node`;
os restantes assumem-no no `PATH`.

```bash
bash scripts/linux-lite/wsl-bootstrap.sh          # Node em Linux (uma vez)
bash scripts/linux-lite/wsl-sync-build.sh         # clone → branch, build core/service, provas P1
bash scripts/linux-lite/wsl-stack.sh              # service + api + app + desktop com CDP 9229
bash scripts/linux-lite/wsl-dev-gui.sh            # arranque GUI completo no perfil isolado
bash scripts/linux-lite/wsl-evidence.sh           # prova do dashboard com conta local sintética
bash scripts/linux-lite/wsl-service-boot.sh       # só o serviço, a verificar o socket
node scripts/linux-lite/package-linux.mjs --check # pré-voo do empacotamento, sem construir
node scripts/linux-lite/package-linux.mjs         # .deb + .AppImage (recusa correr fora de Linux)
node scripts/linux-lite/package-linux.mjs --verify-only  # abrir os pacotes já escritos
bash scripts/linux-lite/wsl-p4-pacote-gui.sh      # o binário do pacote abre janela? encerra com SIGTERM?
```

Testes por pacote: `npm test -w @cybersafe/core`, `-w @cybersafe/service`,
`-w @cybersafe/desktop`. Quando uma alteração toca código partilhado, é essa a
regressão Windows que se corre — no clone isolado, nunca nos worktrees Windows.

## Dependências externas em Linux

- **Tempo de execução** (o que o `.deb` declara em `Depends`): `libgtk-3-0`,
  `libnotify4`, `libnss3`, `libxss1`, `libxtst6`, `xdg-utils`,
  `libatspi2.0-0`, `libuuid1`, `libsecret-1-0`; `Recommends: libappindicator3-1`.
- **Para analisar:** ClamAV do sistema (`clamscan`/`clamd`, base de assinaturas
  atualizada por `freshclam` ou pelo gestor da distribuição). Sem base
  instalada o motor está presente mas degradado — é o que a UI diz.
- **YARA:** binário `yara`/`yarac` de Linux no `PATH` ou em diretório indicado
  por `CYBERSAFE_YARA_BIN_DIR`. Os `.exe` de `vendor/yara` nunca são usados.
- **Para construir os pacotes:** Linux, `dpkg-deb`, `mksquashfs`, e os binários
  de plataforma que um `node_modules` nascido em Windows não traz
  (`app-builder-bin/linux/x64/app-builder`, `@rolldown/binding-linux-x64-gnu`,
  o `dist` Linux do Electron).

Um AppImage não instala serviços, daemon de análise, base de ClamAV nem
firewall. Isso é instalação de sistema, não arranque de aplicação.

## Estado dos módulos

Cada linha aponta para a página onde foi medida. O que não tem página não está
feito.

| Módulo | Estado | Onde está a prova |
|---|---|---|
| Arranque em Linux (janela, React, tema, identidade) | medido em WSL2/WSLg | `p0-evidence.md` |
| Matriz de compatibilidade do código | concluída | `compatibility-matrix.md` |
| Lista de processos (CPU/RAM/utilizador/identidade `/proc`) | medido | `p1-process-listing.md` |
| Terminação segura (PID+starttime, bilhete, SIGTERM/SIGKILL, recusas) | medido; `pidfd` como está | `p1-process-termination.md` |
| Scanner: resolução de motores por plataforma, estados reais | medido | `p2-scanner-engines.md` |
| MATRIX: onde a chave repousa e o que o ecrã pode afirmar | medido | `p2-matrix-credenciais.md` |
| Quarentena: recusas, montagem, restauro, permissões, auditoria em disco | medido em percursos validados; **não** declarada automática | `p3-quarentena-*.md` |
| Volumes montados / armazenamento sem letras de unidade | medido e ligado ao motor; **deteção positiva com pen física ainda não medida** | `p3-montes-usb.md` |
| Otimizar e firewall (UFW/firewalld/nftables) | **não validado** — nenhuma medição do firewall nesta branch. Medido no pacote, e é um defeito: a vista mostra «Firewall do Windows» e «Saúde geral do Windows» em Linux | `p4-empacotamento.md` |
| Empacotamento `.deb` e `.AppImage` | construído e aberto em Linux; API compilada dentro do pacote e addon na ABI do Electron com gate obrigatório (`9907c0f`); encerramento limpo (SIGTERM no processo certo, resíduo 0 aos 3 s e aos 8 s); a versão do pacote vem de `product-version.json` desde `7ae8b24` | `p4-empacotamento.md` |
| Interface **a partir do pacote** | **medido** desde `34e879a`: `#root` com conteúdo, `<script>` do `app.asar`, texto do ecrã de entrada, 0 exceções, PNG de 428 kB (contra 4,7 kB de vazio antes do staging) | `p4-empacotamento.md` |
| Dashboard e painéis **a partir do pacote** | **medido** em `7846b356…`: registo pelo formulário real → sessão → Painel, Análise de Segurança, Monitor (20 processos com PID/CPU/RAM), PC Center (`Uso de CPU ~ 23 % ~ medido`, temperatura `— ~ desconhecido`), Gestor de Tarefas, MATRIX, Otimizar; 0 exceções. YARA reportado em erro pelo próprio pacote; análise de ficheiro conduzida pela interface ainda não feita | `p4-empacotamento.md` |
| Raiz de dados do pacote | **medido**: a API escrevia em `~/.cybersafe-service` (raiz do produto Windows); com a resolução por plataforma, `~/.cybersafe-service` não é recriado e a DB fica em `~/.cybersafe-linux-lite` | `p4-empacotamento.md` |
| Instalação do `.deb` por `apt` num sistema real | **não testado** — precisa de root e de desktop nativo; o `usrBin: []` medido é facto do pacote, não resultado de instalação | — |

## Testes automatizados por plataforma

Medido em `c637a68`, cada número com o comando que o produziu:

| Suite | Ambiente | Resultado |
|---|---|---|
| `node --import tsx --test packages/desktop/test/*.test.mjs` | WSL2 Ubuntu 26.04 | 646 testes, **644 pass, 0 fail, 2 skipped** |
| `node --import tsx --test test/dev-windows-readonly-boundary.test.mjs` | Windows 10 (repo isolado) | 74 testes, 74 pass, 0 fail, **0 skipped** |
| `npm test -w api` (regressão do caminho partilhado, depois de `dbPessoalApi` passar a depender da plataforma) | Windows 10 (repo isolado) | 429 testes, **429 pass, 0 fail** |
| `node --test packages/api/test/dev-isolation.test.js` | Windows 10 | 48 testes, **48 pass, 0 fail** — inclui `win32`/`darwin` byte-idênticos e `linux` em `.cybersafe-linux-lite` |
| `npm run test:scripts` | Windows 10 | 423 testes, **410 pass, 0 fail**, 13 com `todo`/salto de plataforma — inclui os 3 casos do guard `linux-lite-package-api-guard` |

Os dois saltos de Linux não são funcionalidade escondida: um é o caso de
fronteira que só existe com semântica de caminho Windows (o guarda usa o `path`
do anfitrião), o outro já estava marcado no próprio teste. No Windows o mesmo
ficheiro corre os 74 casos todos — a gate é `path.sep === "\\"`, pelo que lá
nenhum caso é saltado. A suite continua a não cobrir o GUI renderizado a
partir do pacote: para isso existe a sonda `wsl-p4-pacote-gui.sh`.

## Limitações honestas

- Nada foi validado como aplicação desktop instalada numa distro; o ambiente é
  WSL2/WSLg.
- Os runners de desenvolvimento (`wsl-stack.sh`, `wsl-dev-gui.sh`) passam
  `--no-sandbox` ao Electron. É uma bandeira de conveniência em WSLg, não uma
  configuração de produto; a sonda do pacote empacotado não passa nenhuma
  bandeira que desative proteções.
- O lançador de consola `/usr/bin/cybersafe-assistant-linux-lite` é criado pelo
  `postinst` do `.deb` (com `update-alternatives` e queda em `ln -sf`), não faz
  parte do arquivo — por isso `dpkg-deb --contents` não o mostra. Se a
  instalação real o deixa de pé continua por medir numa VM Ubuntu/Mint.
- `StartupWMClass` sai com o nome do produto (espaços incluídos), como o
  electron-builder faz; se corresponde ao `WM_CLASS` real só se mede com uma
  janela aberta por uma ferramenta que o leia — ainda não medido.
- O estado «ausente» de um motor nunca é apresentado como «limpo», e um sensor
  que o hardware não expõe (temperatura GPU sob WSL) é apresentado como não
  suportado.

## Roadmap depois do MVP (§12)

Proteção em tempo real (fanotify ou equivalente), serviço privilegiado
persistente com contrato próprio, atualizador, integração avançada de firewall,
e equivalentes das proteções de kernel que hoje só existem em Windows. Nada
desto bloqueou a entrega inicial e nada foi começado.
