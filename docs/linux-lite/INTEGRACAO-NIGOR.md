# Integração experimental Arch / Nigor OS

O alvo Arch reutiliza o renderer, a API local e o serviço que o Electron já inicia na edição Linux Lite. Não introduz um daemon root, portas novas, Wine ou dependência do shell Nigor. A receita destina-se a ensaios internos; o âmbito da licença global continua por clarificar.

## Construir e ensaiar

Num Arch x86_64 descartável, com sessão gráfica normal, Git, Node/npm e base-devel, faça checkout da branch aprovada e execute como utilizador normal:

```bash
bash scripts/linux-lite/arch/prepare-recipe.sh "$HOME/cybersafe-arch-build"
cd "$HOME/cybersafe-arch-build"
makepkg --syncdeps
pacman -Qlp ./cybersafe-assistant-linux-lite-*.pkg.tar.zst
sha256sum ./*.pkg.tar.zst
```

A receita contém um SHA-256 do arquivo de fontes e grava o commit em SOURCE-IDENTITY. É uma receita local, não uma submissão AUR. Depois de verificar a lista, instale no ambiente de ensaio com pacman -U, nunca execute Electron como root e não use --no-sandbox. Se a política do sistema não permitir o sandbox, registe a falha. O pacote não ativa serviços, não altera firewalls, nem remove dados de utilizador. Antes de ensaiar upgrade ou remoção, feche a aplicação e guarde cópia fria do perfil. Use pacman para gerir os ficheiros instalados.

## Ligação ao Nigor

- Entrada do menu: cybersafe-assistant-linux-lite.desktop.
- Ícone: cybersafe-assistant-linux-lite, no tema hicolor (PNG oficial).
- Ação Abrir CyberSafe: lançar cybersafe-assistant-linux-lite na sessão do utilizador, sem argumentos privados.
- Diagnóstico: cybersafe-linux-diagnose emite JSON schemaVersion 1 com sessão e presença de comandos. launchable apenas descreve pré-requisitos básicos; não confirma arranque. health permanece unknown porque isto não interroga o serviço.
- Use `cybersafe-nigor-status` para JSON v1 e `cybersafe-nigor-panel` para texto. Execute na sessão do utilizador, com uma consulta de cada vez. O cliente usa o socket Unix autenticado e devolve código diferente de zero se o serviço estiver indisponível.

## Evidência e estado

| Área | Estado desta entrega |
|---|---|
| Receita, checksum de fontes e preparação Electron | Construídos com makepkg sem privilégios em Arch/WSL2; Node 24 LTS e Electron 33.4.11 |
| Pacote .pkg.tar.zst, instalação e renderer X11 | Validados em Arch/WSL2 com Xvfb. Sessão Nigor e Wayland nativo pendentes |
| Scanner, ClamAV/YARA, HashDB, processos, volumes, quarentena, MATRIX | Scanner benigno, histórico, processos e C++ nativo executados no pacote Arch instalado. USB físico e fornecedores MATRIX continuam por validar |
| Monitorização | Parcial; observação não prova deteção ou prevenção. Sem novo bloqueio preventivo |
| Serviço systemd e integração Nigor | Arranque, reinício, recuperação após falha e paragem verificados em Arch/WSL2. Cliente JSON, ações consentidas e painel gráfico implementados |
| Firewall Linux | Diagnóstico de leitura no CLI e no painel rápido. Integração nos cartões da aplicação principal pendente |

No Ubuntu 26.04/WSL2, com Node 22.23.4 e fontes de a75fc29, passaram npm ci, npm run build:all, o gate SQLite/Electron ABI 130 e o alvo --arch-stage. Os guardas verificaram o renderer 0.2.4, entrada da API, executável ELF e app.asar. Isso não prova arranque gráfico ou funcionamento dos motores. Em Windows/Node 24.13.0 passaram 15 testes dirigidos de packaging, diagnóstico e bindings Linux/Windows.

O próximo ensaio precisa de Arch x86_64 descartável com X11 ou Wayland: instalar, abrir sem elevar, conferir renderer/login/SQLite, analisar uma pasta de texto benigno, confirmar histórico e estado dos motores, testar quarentena/restauro com fixtures, observar criação de ficheiros, fechar e verificar processos. Só depois rever integração e distribuição Nigor.

## Continuação: serviço de utilizador, sandbox e firewall

O pacote inclui `cybersafe-linux.service` como unidade opcional de utilizador.
Depois de instalar num ambiente de teste, abrir e fechar normalmente a aplicação
para gerar a credencial privada. Com a aplicação fechada, executar
`systemctl --user daemon-reload`, `systemctl --user start cybersafe-linux.service`
e consultar `journalctl --user -u cybersafe-linux.service`. Reabrir a aplicação
e verificar a reutilização autenticada do serviço. Para reverter, parar e,
se tiver sido ativada no arranque, desativar a unidade. O pacote não a ativa.
O ciclo de vida instalado foi validado no laboratório Arch/WSL2.

O renderer pede sandbox no Linux e recebe a configuração do preload por
argumentos explícitos. O teste de fonte não substitui um arranque Electron real.

O JSON de `cybersafe-linux-diagnose` inclui estados independentes de firewalld,
UFW e nftables. Não eleva permissões, não publica regras nem modifica o sistema.
Um backend ausente ou sem permissão não significa proteção desativada. O ensaio
WSL real encontrou os três comandos ausentes; os estados conhecidos e a recusa
de permissão foram testados com respostas controladas.

## Aceitação no Arch/WSL2

O pacote de ensaio `cybersafe-assistant-linux-lite-0.2.4-1-x86_64.pkg.tar.zst` foi construído com `makepkg` sem privilégios a partir de `f2d1f061b55fbf8b77d10fd145afa9720eeae86d`. Tamanho 111695351 bytes. SHA-256 `6c4a54c346889d5ff543283ebedd6279eb72bf906e4f8fac54c03c69a990f4ce`. O ensaio usou Arch/WSL2, Node 24.22.3, Electron 33.4.11 e a imagem WSL oficial com SHA-256 conferido. O pacote está reservado para testes.

- `pacman -Qlp` confirmou o payload e `pacman -Qkk` confirmou 173 ficheiros sem alterações após a instalação.
- Xvfb abriu a aplicação instalada sem flags que desativem o sandbox. A prova confirmou o renderer React montado, a bridge preload e a resposta de `/health` com `databaseReady: true`.
- `verify-installed.sh --disposable-profile` validou a unidade de utilizador, a consulta autenticada, o painel e a paragem. Um segundo ensaio comprovou recuperação automática após terminar exclusivamente o filho de serviço identificado no laboratório.
- O motor C++ analisou uma fixture e devolveu o SHA-256 esperado. ClamAV e YARA detetaram fixtures benignas com definições próprias de teste. ClamAV apareceu degradado no serviço instalado. Uma análise do serviço de um ficheiro registou 1/1 analisado, 1 inconclusivo e 0 ameaças.
- Os testes dirigidos Arch/WSL2 tiveram 123 passes e 1 TODO no core e 82 passes no serviço. Incluíram regressões de POSIX, USB, quarentena, fila em tempo real, histórico e HashDB. USB físico, Wayland nativo, sessão Nigor e os fornecedores MATRIX continuam por validar.

O contrato JSON v1 de estado contém `serviceRunning`, `protection`, `engines`, `latestScan`, `history`, `alerts` e `metrics`. Use `null` como estado sem leitura. Histórico e alertas têm no máximo cinco entradas e omitem caminhos e mensagens livres. As operações consentidas e a consulta de processos estão descritas abaixo. Eventos contínuos e integração específica do shell Nigor continuam pendentes.

## Cliente e painel funcionais

O transporte é o socket Unix autenticado existente, não um novo servidor HTTP.
A credencial é lida do perfil privado e nunca é passada pela linha de comando.
Os comandos seguintes executam-se como o mesmo utilizador do serviço:

```bash
cybersafe-nigor-status
cybersafe-nigor-status processes
cybersafe-nigor-panel --dialog
cybersafe-nigor-status scan --consent /caminho/absoluto/para/pasta-de-teste
cybersafe-nigor-status cancel --consent ID_DEVOLVIDO_PELO_SCAN
```

`processes` devolve no máximo 50 linhas com PID, nome limitado, CPU e memória,
total e frescura fornecida pelo serviço. Não exporta comandos, caminhos ou
nomes de contas. Cache após falha continua identificado como cache/falha.
Os valores desconhecidos permanecem `null`.

As ações reutilizam `scan.start` e `scan.cancel`. Sem `--consent`, sem destino
absoluto, perante symlink ou com autenticação errada, o pedido é recusado.
Aceitação do pedido não significa análise concluída: consulte o histórico.

O painel gráfico usa Zenity, opcional no pacote, e contém Atualizar, Abrir
CyberSafe e Fechar. Também abre com o serviço parado, mostrando indisponível
sem inventar saúde. A entrada desktop inclui a ação Estado de proteção.
Não altera firewalls, não inicia proteção automaticamente e não pede root.

## Pacote e validação de 13/11/2026

Fontes do pacote de encerramento: `8a05d7b0637d9fb6fc66e4716c03635e38c51877`.
Artefacto interno: `output/arch-closing-8a05d7b/cybersafe-assistant-linux-lite-0.2.4-1-x86_64.pkg.tar.zst`.
Tamanho: **111698686 bytes**.
SHA-256: `b4ee707908fdd8e54851879f590ae3303f9763073993ad88db4e21908e53fed5`.
`SOURCE-IDENTITY`, receita, SHA256SUMS e log de build acompanham o pacote.
Não é um pacote publicado, assinado ou aprovado para distribuição geral.

- Build completo dos oito workspaces, typecheck desktop e makepkg/check passaram.
- Instalação no laboratório Arch/WSL2; `pacman -Qkk`: 173 ficheiros, zero alterações.
- Aplicação instalada em X11/Xvfb, sem desativar o sandbox: login real com conta
  sintética, Dashboard, histórico, bridge e API com SQLite pronto verificados.
- Consulta instalada de processos: dados reais e estado `ok`. Análise pelo
  cliente instalado: 1/1 ficheiro benigno, zero falhas, zero inconclusivos.
- O renderer reutilizou o serviço autenticado. Após terminar esse processo
  gráfico de ensaio por SIGTERM, a unidade persistente continuou ativa.
  Isto não substitui a aceitação manual do menu da tray num desktop Nigor.
- Depois de parar aplicação e serviço, `quick_check` read-only aprovou as quatro
  bases SQLite encontradas no perfil do laboratório. Não são as 13 bases Windows.
- Painel Zenity abriu e fechou em X11 com serviço disponível e indisponível.
- Módulos de quarentena do pacote instalado: isolamento confirmado, recusa de
  sobrescrita no restauro, preservação do substituto e restauro posterior com
  SHA-256 e modo POSIX conferidos. Resultado positivo sintético sobre ficheiro
  benigno; não é deteção de malware nem prova do percurso completo pela UI.
- Regressão desktop final em Arch: **692 passes, seis skips, zero falhas**.
- Regressão ampla inicial do serviço em Arch: **892 passes, 130 falhas, um skip**.
  Não está aprovada. Entre as causas comprovadas estão fixtures de caminhos
  Windows, uso do provider Windows em testes de cache e interferência de bases
  ClamAV do host. A incompatibilidade de sintaxe TypeScript introduzida no
  logger foi corrigida: os nove testes de autenticação passaram. As fixtures
  corrigidas de cache, binário ausente e walk passaram em 39 testes dirigidos.
  As restantes falhas precisam de triagem; não foram apagadas ou desativadas.
- A correção do cooldown e as regressões do gate/recarga passaram em **51 testes**.
- CI Linux adicionada: build, ELF, IPC e regressões aprovados. A CI Windows
  revelou uma corrida de criação da credencial: o leitor podia apanhar o ficheiro
  exclusivo ainda vazio. Foi corrigida com espera limitada a 100 ms apenas nesse
  estado, sem rotação ou sobrescrita. Os 16 testes de credencial passaram,
  incluindo dois processos concorrentes e recusa de ficheiro permanentemente vazio.
  Nas fontes finais `8a05d7b`, os jobs Linux e Windows passaram nas duas runs
  remotas (push e PR): `43509183249` e `43509191170`.
- O pacote final foi instalado no laboratório: 173 entradas verificadas pelo
  pacman; SHA-256 de 131 ficheiros regulares em `PAYLOAD-SHA256.json`, incluindo
  ELF e app.asar, sem executáveis Windows. Serviço, motores e painel responderam.

O ensaio de quarentena é reproduzível apenas num laboratório descartável:

```bash
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 /usr/bin/cybersafe-assistant-linux-lite \
  scripts/linux-lite/arch/verify-quarantine-installed.mjs --disposable-fixture
```

O script recusa root e outras plataformas, cria exclusivamente uma fixture
temporária e preserva os resultados e a auditoria. Não usa dados existentes.

### ClamAV: diagnóstico e limite do ensaio

O perfil de ensaio tinha apenas `bytecode.cvd`; por isso o serviço reportou
degradado por falta da base diária. FreshClam confirmou cooldown do CDN. Não
foram repetidos downloads nem alterado o controlo do fornecedor. Bases oficiais
já obtidas e verificadas em `/var/lib/clamav` foram copiadas e comparadas byte a
byte no perfil descartável; depois da prova de carga o ClamAV apareceu ativo.
Isso não demonstra que a atualização automática online tenha sido concluída.

Foi reproduzido um defeito: FreshClam 1.5.4 pode sair com código zero durante o
cooldown sem verificar definições. O serviço agora recusa esse resultado,
preservando erro/backoff em vez de avançar a confirmação. O teste cobre stdout,
stderr e um aviso antigo seguido de uma verificação bem-sucedida.

As regras YARA e HashDB têm cobertura limitada; carregar motores não comprova
proteção integral. Não houve novo ensaio EICAR nesta sessão.

### Pendências de aceitação

Sessão Nigor real, Wayland nativo, USB físico, notificações e tray na sessão do
utilizador, percurso UI/IPC da quarentena/restauro e fornecedores MATRIX
online continuam por validar. O painel não substitui uma extensão do shell.
O updater Windows continua indisponível no Linux. A licença global permanece
pendente. A branch e o PR #5 continuam experimentais e sem merge.

## Decisão de distribuição desta fase

**Sem publicação pública do binário nesta sessão.** O gate pedido para as
permissões de distribuição não ficou fechado: não há texto global aprovado e o
artefacto declara `LicenseRef-Pending`. Os avisos históricos dos motores estão
orientados ao payload Windows e não constituem, por si, o inventário completo do
Linux, incluindo o renderer incorporado. Não foi inventada uma licença MIT.

O inventário técnico local identificou 157 pacotes de runtime no ASAR e preservou
os avisos encontrados, além de `LICENSE.electron.txt` e `LICENSES.chromium.html`.
Isso não é uma aprovação jurídica nem uma verificação integral das obrigações.
A aprovação do titular e o fecho dos avisos aplicáveis são necessários para dar
o gate como satisfeito. Código e testes ficam no PR; pacote, receita, proveniência,
hashes, logs e notas de pré-release ficam preservados localmente.

As falhas restantes da regressão ampla impedem declarar a edição pronta para
produção. Parte foi comprovadamente atribuída a fixtures/ambiente; o restante
continua por triar. Não houve falha crítica de integridade, arranque ou perda de
dados nos ensaios instalados executados. Esses resultados não autorizam prometer
proteção integral ou estabilidade de todos os percursos.
