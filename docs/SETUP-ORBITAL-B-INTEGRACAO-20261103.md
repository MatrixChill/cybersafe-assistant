# Setup Orbital B — recuperação e integração (3 novembro 2026)

Worktree `codex-final-v020-20261103/repo`, branch `codex/updater-visual-20261103`.
Base recebida: HEAD `187ce38b081cdbc7a2e4e996684d06a4261a0c01`, 11 ficheiros modificados e 3 não rastreados.

## Onde o Codex parou

O Codex já tinha:

- Movido a grelha de ações do protótipo da coluna esquerda para a coluna de conteúdo.
- Regenerado a arte nativa sem a barra de passos falsa e sem estado de verificação pintado no bitmap.
- Acrescentado `updaterDesign` (layout e progresso nativo real) ao `branding-manifest.json`.
- Acrescentado rótulos opacos no protótipo e o teste correspondente.
- Exportado a cena real do atualizador para `output/setup-updater-alignment/orbital-b-export-v2.png` com `scripts/prototypes/export-installer-orbital.cjs`.

Parou antes de integrar essa exportação na arte do instalador: o gerador continuava a desenhar um orbital vetorial sintético (`orbital()`), pelo que o Setup não mostrava a cena real.

## O que foi feito nesta ronda

1. A exportação real passou a ser um asset versionado: `assets/branding/scene/orbital-b-scene.png`
   (`sha256 b3b218ebd1d16c09054c401fc0db65f1d6c88a532449ed70d7aa8c8b08d68443`).
2. `scene_export()` remove o fundo plano do render por chave de cor, corta pelos limites alfa e reduz
   com preservação de proporção, sem redesenhar geometria. `hero()` compõe essa imagem com um halo
   discreto. Sem o ficheiro, o gerador recai no `orbital()` vetorial anterior.
3. O manifesto declara a proveniência: ficheiro, hash, renderer, `liveAnimation:false` e o método de composição.
4. Layout do protótipo: título e corpo voltam a ser visíveis, grelha 2x2 com "Desinstalar" a ocupar a
   largura útil, estado e "Fechar estudo" dentro do cartão de conteúdo.
5. Causa do título invisível: os labels nasciam com `WS_EX_TRANSPARENT`, e o bitmap esticado cobria o
   texto no primeiro paint. Os três labels passam a opacos (`SetWindowLongW ... -20 0`) e são elevados
   acima do bitmap, por ordem inversa.
6. `scripts/prototypes/capture-installer-preview.ps1` captura a janela nativa via `PrintWindow`, sem
   tocar no resto do ambiente.

## Evidência

- `python scripts/test/installer-branding_test.py` → OK (dimensões, 24 bits, hashes, proveniência da cena).
- `node --test scripts/test/installer-theme.test.mjs` → 14/14.
- `npm run typecheck --workspace @cybersafe/app` → exit 0.
- `makensis` do protótipo → exit 0, apenas o aviso 8000 (protótipo sem secções), esperado.
- Janela 900x600 capturada e inspecionada: rail com cena Orbital B, título, corpo em duas linhas,
  cinco ações alinhadas, estado e fecho dentro do cartão.

## Limitações assumidas

- O NSIS não executa WebGL. O instalador usa uma captura estática da cena, não a cena animada.
  Não existe segundo runtime Electron, plugin WebView nem bootstrapper.
- A captura foi validada a 96 DPI. Não há matriz de DPI/monitores nem ensaio de driver ausente.
- O protótipo não instala, não repara, não desinstala e não tem payload. Os botões só trocam texto.
- `preview.bmp` é arte; o progresso continua a ser o nativo do NSIS, sem percentagem inventada.
- Nada foi assinado, congelado, publicado ou instalado. RC1 LAB `497e634` permanece intacta.

## Próximos passos

1. Revisão visual humana do Setup contra a janela do atualizador.
2. Aplicar a mesma paleta/geometria às páginas MUI reais (welcome/config/finish), não só ao protótipo.
3. Ensaio em DPI 125/150% antes de qualquer candidata.
4. Novo inventário, manifesto e freeze antes de packaging; assinatura e publicação continuam bloqueadas.
