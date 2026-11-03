# Páginas reais do Setup NSIS — estado em 3 novembro 2026

Branch `codex/updater-visual-20261103`. Base desta ronda: `31dcb07b`.

## Método

`scripts/prototypes/compile-installer-pages.mjs` compila a MESMA ordem de páginas
do electron-builder (`assistedInstaller.nsh`), com o MESMO `cybersafe-installer.nsh`
e os MESMOS bitmaps do instalador distribuído. A única diferença é a secção:
inerte (`Sleep` + `DetailPrint`), sem `customInstall`, para nunca criar atalhos,
registar desinstaladores ou apagar atalhos reais. `RequestExecutionLevel user`.

`scripts/prototypes/capture-installer-pages.ps1` percorre as páginas por
`WM_COMMAND IDOK` e captura cada uma com `PrintWindow`, sem tocar no resto do ambiente.

As escritas de validação de caminho foram contidas com o `/D=` do NSIS para
`output/installer-pages/installdir`. Numa primeira execução, antes desse ajuste,
a validação correu contra `%LOCALAPPDATA%\Programs\CyberSafe Assistant` (instalação
real já existente): criou e apagou um diretório `.cs-probe-*` e não deixou vestígios
(verificado com `find`). Nenhum ficheiro da instalação foi alterado ou removido.

## Páginas capturadas

- `pages-1-welcome.png` — ecrã 1 real, com a cena Orbital B no rail.
- `pages-2-mode.png` — escolha de modo de instalação (MUI/multiUser).
- `pages-3-config.png` — ecrã 2 real (pasta, atalhos, espaço).
- `pages-4-progress.png` — progresso nativo do NSIS.
- `pages-5-finish.png` — conclusão, com sidebar Orbital B.

## Correções aplicadas nesta ronda

1. `CS_ChooseInstall`/`CS_ChooseRepair` deixaram de fazer `BM_CLICK` no botão Next
   oculto; passam a `PostMessage` de `WM_COMMAND IDOK` (um `SendMessage` reentrante
   era engolido durante o próprio clique).
2. A faixa de branding do MUI foi alvo de `ShowWindow SW_HIDE` e a linha de detalhe
   da extração dos bitmaps de botão passou a `SetDetailsPrint none`.

## Defeitos abertos (com evidência)

- A faixa clara de branding continua visível apesar do `SW_HIDE`: o controlo
  pintado não é o 1256/1028 identificados; falta localizar o static real.
- Página de modo de instalação sem tema: texto de rádio escuro sobre fundo escuro,
  rótulo com sufixo em inglês "(must run as admin)" vindo do `multiUserUi`, e botões
  com placa branca.
- Página de conclusão: o checkbox "Abrir o CyberSafe Assistant." tem pouco contraste
  e os botões do rodapé mantêm placa branca.
- Ecrã 1: o rótulo "01 / BOAS-VINDAS" fica cortado no topo (3% de altura é pouco).
- O clique sintético (`BM_CLICK`) no botão "Instalar" do ecrã 1 não avança a página.
  `WM_COMMAND IDOK` externo avança, pelo que o wizard está saudável. Não foi provado
  se um clique real de rato se comporta como o sintético; requer ensaio manual.
- `Espaço disponível: 10 598 MB` correto no caminho `/D=`; com o caminho por omissão
  a leitura pode devolver desconhecido ("?"), o que é honesto mas pouco claro.

## DPI

Capturas a 96 DPI. Não foi alterada a configuração de DPI do sistema (seria uma
alteração global e não autorizada), pelo que 125%/150% continuam por validar em VM.

## Limites

O NSIS não executa WebGL: a cena é uma captura estática. Nada foi assinado,
congelado, instalado ou publicado. A RC1 LAB `497e634` permanece intacta.
## Atualização — segunda ronda (HEAD seguinte)
### Corrigido e verificado
- Faixa branca: o static visível é o **1028** (483x13, por baixo da página), não o 1256.
  O 1256 já estava oculto; agora ambos são ocultados e a faixa desapareceu nas capturas.
- Rótulo «01 / BOAS-VINDAS»: tinha 6 px de altura (3% da área da página); passou a 6% e já não está cortado.
- Navegação: o clique no botão «Instalar» chega ao handler e avança a página. Prova: marcador
  temporário em `%TEMP%` criado pelo handler + título do cabeçalho a mudar de «Instalação» para
  «Escolha uma opção de instalação». A instrumentação foi removida.
- Progresso: a mudança de pasta e a extração dos bitmaps deixaram de aparecer como etapas.
- Isolamento: cada execução usa `output/installer-pages/run-*` com `/D=` próprio e remove-o no fim;
  o harness recusa caminhos fora de `output/installer-pages` e caminhos `Programs`/`AppData`.
  Última execução: `existed install dir touched: False`.

### Continua aberto
- Botões do rodapé nas páginas MUI (modo, progresso, conclusão) mantêm a placa branca. Já têm
  `SetOutPath "$PLUGINSDIR"` (o `File` escrevia no `$OUTDIR` corrente) e `InvalidateRect` após o
  estilo, mas o `BS_BITMAP` aplicado depois do primeiro paint continua a não ser honrado.
  As capturas de modo e conclusão ficaram byte-idênticas, o que prova que a repintura não bastou.
- Página de modo sem tema e com sufixo inglês `(must run as admin)`. No instalador real o callback
  vem de `customInstallMode` do electron-builder; o preview não o liga. Por validar no fluxo real.
- Checkbox «Abrir o CyberSafe Assistant.» com contraste insuficiente.
## Atualização — terceira ronda
Tentada a estilização no callback **PRE**, antes do primeiro paint. Resultado: os botões das páginas
MUI continuam com a placa do sistema; as capturas de modo, progresso e conclusão mantêm a placa branca.
Conclusão técnica: `BS_BITMAP` + `BM_SETIMAGE` aplicados a botões do wizard que já existem não é
honrado pelo controlo, em nenhuma das fases. A via correta é owner-draw com subclassing seguro e
libertação de recursos GDI, ou manter os botões nativos e tematizar apenas o envolvente.

A alteração do texto de `$RadioButtonLabel1` criou um rótulo duplicado em vez de substituir o texto
do rádio; foi revertida. O sufixo inglês `(must run as admin)` continua aberto.

Mantido: PRE/SHOW callbacks (sem efeito visual nos botões, sem regressão), tematização de
checkboxes nativos via `CS_ThemeCheckboxes`, e os testes 14/14 + 3/3.
