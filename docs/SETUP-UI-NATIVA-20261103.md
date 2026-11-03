# Setup - camada de apresentacao nativa

Data: 2026-11-03 - Branch: `codex/updater-visual-20261103`

## 1. Decisao de arquitetura

O MUI classico nao permite a fidelidade pedida: os controlos sao desenhados pelo
comctl32, os botoes nao aceitam owner-draw sem subclassing e as imagens BMP eram
ampliadas com perda visivel. Em vez de continuar a disfarcar o MUI, a camada de
apresentacao passa a ser uma janela Win32 + GDI+.

- Um unico exe, sem runtime adicional, sem segundo Electron.
- 177 KB compilado; liga apenas `user32`, `gdi32`, `gdiplus`.
- O motor NSIS permanece intacto e continua a ser o unico que instala, regista,
  cria atalhos e desinstala.

Esta entrega e a **camada de apresentacao**. O handoff com o motor ainda nao esta
ligado (ver seccao 3).

## 2. Implementado

- Janela 1120x720 escalada por DPI, sem moldura nativa, cantos arredondados por
  regiao, barra de titulo desenhada e controlos minimizar/maximizar/fechar.
- Cinco paginas: boas-vindas, modo de instalacao, configuracao, progresso e
  conclusao.
- Botoes 2x2 com gradiente, icones vetoriais, hover, foco por teclado
  (Tab/setas), ativacao com Enter/Espaco e Escape para fechar.
- Reparar e Desinstalar aparecem desativados quando nao ha instalacao detetada.
- Cena Orbital B original (`assets/branding/scene/orbital-b-scene.png`) desenhada
  com mascara alfa de 18% para eliminar o retangulo visivel; lockup oficial
  (`assets/branding/source/07_CyberSafe_horizontal_lockup.png`) no cabecalho.
- Todo o texto e renderizado por GDI+ com ClearType; nada de texto pintado em
  imagens.
- A barra de progresso da pagina 4 e uma simulacao de temporizacao do prototipo,
  nao uma medicao real.

## 3. Nao implementado (estado honesto)

- **Handoff para o NSIS**: nao existe protocolo (pipe nomeado + nonce) nem
  arranque do motor. Os botoes navegam entre paginas, nao instalam.
- Reparar/Desinstalar estao desativados porque a detecao de instalacao ainda nao
  esta ligada a esta camada.
- Icone oficial do executavel/janela: ainda `IDI_APPLICATION`; nao existe `.ico`
  nos assets do repositorio.
- DPI 125/150: o codigo usa `PER_MONITOR_AWARE_V2` e o helper `S()`, mas so foi
  validado a 100%.
- Assinatura Authenticode, ensaio de atualizacao e freeze continuam fora do
  ambito desta ronda.

## 4. Compilar e capturar

O `vcvars64.bat` nao e utilizavel neste shell (lento e o seu redireccionamento
`>/dev/null` e reescrito para `/dev/null` pela camada MSYS). O ambiente e fixado
diretamente:

```bash
export MSYS2_ARG_CONV_EXCL='*'
export PATH="/c/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51.36231/bin/Hostx64/x64:$PATH"
export INCLUDE='C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.51.36231\include;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\um;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\shared'
export LIB='C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.51.36231\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64'
cl.exe /nologo /EHsc /O2 /std:c++17 main.cpp /link user32.lib gdi32.lib gdiplus.lib /SUBSYSTEM:WINDOWS /OUT:CyberSafeSetupUI.exe
```

Captura das cinco paginas (cliques reais via `PostMessage`, imagem via
`PrintWindow`):

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-ui/capture-pages.ps1 -ExePath scripts/setup-ui/CyberSafeSetupUI.exe -OutDir output/setup-ui-pages
```

O exe tem de ser lancado com o diretorio de trabalho na raiz do repositorio,
porque carrega a cena e o lockup por caminho relativo.

## 5. Corrigido nesta ronda

1. A cena aparecia como retangulo solido sobre o cartao; passou a ter mascara
   alfa suave nas quatro margens.
2. O titulo da pagina 1 era cortado com reticencias; reduzido para 28 px e
   largura da coluna corrigida.
3. A caixa de espaco da pagina 3 sobrepunha os botoes; subiu 18 px.

## 6. Limites do prototipo

- E inerte: nao escreve no registo, nao cria atalhos, nao toca em
  `%LOCALAPPDATA%\Programs`.
- As capturas sao da janela real, com cliques reais, nao de uma maquete.

## 7. Proximo passo

Definir o contrato de handoff (pipe nomeado, nonce, verificacao de assinatura do
motor) e so depois substituir a navegacao por operacoes reais. Sem esse contrato
o prototipo nao pode ser ligado ao NSIS sem abrir uma superficie de ataque.
