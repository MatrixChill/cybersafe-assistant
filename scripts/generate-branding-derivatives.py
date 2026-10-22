"""Derivados da marca final CyberSafe.

Regra: NENHUM pixel inventado. Tudo o que aqui se produz e reamostragem
LANCZOS da arte final em assets/branding/source/, com o canvas original
respeitado (as margens de ar livre ja vivem na arte). Sem pintura, sem
recoloracao, sem upscale: so se pedem tamanhos <= ao mestre de 1254px.

Ferramenta: Pillow 12.3.0 (Python 3.14), a mesma que scripts/generate-assets.py
ja usa neste repo. Nenhum pacote novo.
"""
from pathlib import Path
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / 'assets' / 'branding' / 'source'
GEN = REPO / 'assets' / 'branding' / 'generated'

SYMBOL = SRC / '03_CyberSafe_monograma_flat.png'      # monograma flat, sem glow
TILE = SRC / '06_CyberSafe_tray_icon_squircle.png'    # monograma em placa propria

SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
ICON_SIZES = [16, 20, 24, 32, 48, 64, 128, 256]

# O mestre 06 traz 13.5-14.3% de margem transparente em cada lado (medido: a
# arte ocupa 72.9% do canvas de 1254). Num ICO de 16 px isso da 12 px de icone,
# e e exatamente o sintoma de "icones visualmente pequenos" na bandeja e na
# barra de tarefas. Para os icones de SO recorta-se o bounding box de alpha e
# re-centra-se com margem pequena. Nao e arte nova: e o mesmo bitmap, recortado.
# A familia `tile-*` (UI) mantem a margem original do designer, porque no
# sidebar o logo tem de ter o mesmo peso visual do monograma flat.
ICON_SAFE_MARGIN = 0.04  # 4% por lado -> a arte passa a preencher ~92%

# Bandeja/tray: os vizinhos (NVIDIA/Razer/Windows Security) desenham a arte
# quase edge-to-edge no popup. A 150% (slot 24 px) os 4% por lado = ~2.3 px
# de glyph perdidos. Para as variantes de bandeja recorta-se ao bbox de alpha e
# re-centra-se com margem de 1% por lado -> glyph ~98% linear do canvas.
# A variante warning é, por agora, idêntica à active: a diferença de estado
# (ativo vs aviso) é tratada pelo produto depois. Arte nova NÃO: é o mesmo
# tile, recortado, exatamente como icon-*.png.
TRAY_SAFE_MARGIN = 0.01  # 1% por lado
TRAY_SIZES = (32, 16)    # main.ts faz o resize para os slots 16/20/24/32

# Badge de estado da bandeja.
#
# Porquê existe: até 2026-10-05 as variantes tray-icon-warning e (a propria)
# tray-icon-critical eram O MESMO bitmap da active — "sem pintura, sem
# recoloracao" era respeitado à letra e o resultado era um tray que não
# distinguia nada. Medido: md5 identico (efa59f0a...) para active e warning.
#
# O que se faz aqui NAO e repintar a marca. A base e o MESMO tile CyberSafe,
# sem um pixel alterado; o que se acrescenta e um badge no canto inferior
# direito — um disco solido na cor semantica com o glifo do estado. A
# identidade (escudo/monograma) fica intacta; o que muda e um elemento novo.
#
# Cores: tokens do tema escuro em packages/app/src/index.css
# (--cyber-green/--cyber-yellow/--cyber-red). A bandeja e uma superficie do
# SO e nao segue o tema, por isso usa-se o valor do tema escuro (a bandeja do
# Windows e escura por omissao).
TRAY_STATE_COLORS = {
    'active':  (0x56, 0xd4, 0x8a),  # --cyber-green
    'warning': (0xff, 0xbf, 0x3e),  # --cyber-yellow
    'critical': (0xff, 0x5c, 0x5c),  # --cyber-red
}
# Slots reais da bandeja do Windows: SM_CXSMICON(16) x scaleFactor.
TRAY_SLOT_SIZES = (16, 20, 24, 32)


def state_badge_layer(kind: str, px: int) -> Image.Image:
    """Disco + glifo do estado, desenhados 8x e reduzidos (supersampling).

    A 16 px um traco de 1 px desaparece. Desenhar 8x e deixar o LANCZOS fazer
    a media da cor da borda e o que mantem o glifo legivel no slot mais pequeno.
    """
    S = 8
    n = px * S
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    color = TRAY_STATE_COLORS[kind] + (255,)
    # Disco solido no canto: a massa de cor e o sinal que se ve a 16 px, mesmo
    # que o glifo interior se tolde. Raio ~21% -> diametro ~42% do slot.
    # Medido: a 52% o badge tapava metade do escudo e o glifo deixava de se
    # ler contra os pixels escuros da marca por baixo.
    r = int(n * 0.21)
    cx, cy = n - r - int(n * 0.02), n - r - int(n * 0.02)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)

    # Glifo em quase-preto: as tres cores do disco sao claras, logo um glifo
    # escuro mantem o contraste DENTRO do disco. O disco e opaco, por isso o
    # glifo nao compete com o escudo — so a antialiasagem da borda toca nele.
    ink = (10, 12, 16, 255)
    w = max(3, int(n * 0.085))   # traço grosso: a 16 px um traço fino evapora-se
    u = r * 0.66  # meia-abertura do glifo

    if kind == 'active':      # check
        # O check é o glifo mais difícil a 16 px (o badge tem ~6 px). Braço
        # esquerdo curto e grosso: medido, um check "bonito" com os dois braços
        # simétricos virava uma mancha a esse tamanho. A cor verde é o sinal
        # primário nesse slot; o glifo afina a partir dos 24 px.
        wc = max(3, int(n * 0.105))
        d.line([(cx - u * 0.92, cy + u * 0.05), (cx - u * 0.30, cy + u * 0.80)], fill=ink, width=wc, joint='curve')
        d.line([(cx - u * 0.30, cy + u * 0.80), (cx + u * 0.98, cy - u * 0.86)], fill=ink, width=wc, joint='curve')
    elif kind == 'warning':   # exclamacao: barra + ponto
        d.line([(cx, cy - u), (cx, cy + u * 0.15)], fill=ink, width=w)
        dr = max(2, int(w * 0.75))
        d.ellipse([cx - dr, cy + u * 0.45 - dr, cx + dr, cy + u * 0.45 + dr], fill=ink)
    else:                     # critical: X
        d.line([(cx - u, cy - u), (cx + u, cy + u)], fill=ink, width=w)
        d.line([(cx + u, cy - u), (cx - u, cy + u)], fill=ink, width=w)

    return img.resize((px, px), Image.LANCZOS)


def tray_state_icon(master_tile: Image.Image, kind: str, size: int) -> Image.Image:
    """Tile CyberSafe (intacto) + badge do estado, para um slot de `size` px."""
    base = tight_icon(master_tile, size, TRAY_SAFE_MARGIN)
    badge = state_badge_layer(kind, size)
    out = base.copy()
    out.alpha_composite(badge)
    return out


def downscale(master: Image.Image, size: int) -> Image.Image:
    """Reduz o canvas quadrado do mestre para `size`, LANCZOS, mantendo alpha."""
    if size > master.size[0]:
        raise SystemExit('pedaco de upscale: %s > %s' % (size, master.size[0]))
    return master.resize((size, size), Image.LANCZOS)


def tight_icon(master: Image.Image, size: int, margin: float = ICON_SAFE_MARGIN) -> Image.Image:
    """Recorta ao bounding box de alpha e re-centra com `margin` por lado."""
    alpha = master.getchannel('A').point(lambda v: 255 if v > 8 else 0)
    art = master.crop(alpha.getbbox())
    inner = round(size * (1 - 2 * margin))
    scale = inner / max(art.size)
    if scale > 1:
        raise SystemExit('upscale nao permitido: %s -> %s' % (art.size, inner))
    resized = art.resize(
        (max(1, round(art.size[0] * scale)), max(1, round(art.size[1] * scale))), Image.LANCZOS
    )
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(resized, ((size - resized.size[0]) // 2, (size - resized.size[1]) // 2), resized)
    return out


LEGACY = REPO / 'assets' / 'branding' / 'legacy'


def write_preserving(dst: Path, data: bytes):
    """Escreve por cima de um asset consumido, mas nunca deita fora o anterior:
    a versão antiga vai para assets/branding/legacy/ com o caminho de origem."""
    if dst.exists() and dst.read_bytes() != data:
        rel = dst.relative_to(REPO).as_posix().replace('/', '__')
        LEGACY.mkdir(parents=True, exist_ok=True)
        (LEGACY / rel).write_bytes(dst.read_bytes())
    dst.write_bytes(data)


def main():
    sym = Image.open(SYMBOL).convert('RGBA')
    tile = Image.open(TILE).convert('RGBA')
    assert sym.size[0] == sym.size[1] and tile.size[0] == tile.size[1]
    GEN.mkdir(parents=True, exist_ok=True)

    made = []
    for size in SIZES:
        for stem, master in (('symbol-flat', sym), ('tile', tile)):
            out = GEN / f'{stem}-{size}.png'
            downscale(master, size).save(out, 'PNG', optimize=True)
            made.append(out)

    # Familia de SO: mesmo tile, recortado ao bounding box de alpha.
    for size in ICON_SIZES:
        out = GEN / f'icon-{size}.png'
        tight_icon(tile, size).save(out, 'PNG', optimize=True)
        made.append(out)

    # favicon e icone de toque: vao para barras de browser/OS, entao usam a
    # versao recortada (a placa escura le-se em fundo claro e escuro)
    for size in (32, 48, 180):
        out = GEN / f'favicon-tile-{size}.png' if size != 180 else GEN / 'apple-touch-icon-180.png'
        tight_icon(tile, size).save(out, 'PNG', optimize=True)
        made.append(out)

    # .ico multi-tamanho para empacotamento Windows (mesma receita de
    # scripts/generate-assets.py: PIL grava ICO com lista de tamanhos)
    ico = GEN / 'cybersafe-icon.ico'
    tight_icon(tile, 256).save(ico, format='ICO',
                               sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    made.append(ico)

    # Variantes de bandeja (tray): mesmo tile, recortado ao bbox de alpha e
    # re-centrado com TRAY_SAFE_MARGIN=0.01 (1% por lado), MAIS o badge do
    # estado. main.ts consome `tray-symbol-<estado>-<slot>.png` (dedicado,
    # 1:1, sem resize — é o que dá nitidez no slot real da bandeja) e cai para
    # `tray-icon-<estado>.png` (32 px) quando o dedicado não existe.
    for kind in TRAY_STATE_COLORS:
        for size in TRAY_SLOT_SIZES:
            out = GEN / f'tray-symbol-{kind}-{size}.png'
            tray_state_icon(tile, kind, size).save(out, 'PNG', optimize=True)
            made.append(out)
        out = GEN / f'tray-icon-{kind}.png'
        tray_state_icon(tile, kind, 32).save(out, 'PNG', optimize=True)
        made.append(out)
    for kind in TRAY_STATE_COLORS:
        for size in TRAY_SIZES:
            out = GEN / f'tray-icon-{kind}-{size}.png'
            tray_state_icon(tile, kind, size).save(out, 'PNG', optimize=True)
            made.append(out)
    print('gerados %d ficheiros em %s' % (len(made), GEN))
    for p in made:
        print('   ', p.name, Image.open(p).size)

    # publica os derivados nos consumidores, cada um só com o que resolve:
    # o renderer usa symbol-flat (temas escuros) + tile (temas claros) + favicon;
    # o shell Electron só precisa do tile (janela, bandeja, splash).
    app_dir = REPO / 'packages' / 'app' / 'public' / 'branding' / 'cybersafe'
    desk_dir = REPO / 'packages' / 'desktop' / 'src' / 'assets' / 'cybersafe'
    app_want = {f'symbol-flat-{s}.png' for s in SIZES} | {f'tile-{s}.png' for s in SIZES} | {
        'favicon-tile-32.png', 'favicon-tile-48.png', 'apple-touch-icon-180.png'}
    # O shell so usa icones de SO: janela, bandeja e o logo do splash.
    desk_want = {f'icon-{s}.png' for s in (16, 24, 32, 48, 256)} | {'tile-128.png'} | {
        'tray-icon-active-32.png', 'tray-icon-active-16.png',
        'tray-icon-warning-32.png', 'tray-icon-warning-16.png',
        'tray-icon-critical-32.png', 'tray-icon-critical-16.png',
        'tray-icon-active.png', 'tray-icon-warning.png', 'tray-icon-critical.png'}
    # Os `tray-symbol-*` sao o que o main.ts consome de facto (PNG dedicado ao
    # slot, 1:1, sem resize). Nao estavam em `want`, portanto o gerador apagava-os
    # como "stale" enquanto o main.ts dependia deles. Registados aqui.
    desk_want |= {f'tray-symbol-{k}-{s}.png'
                  for k in TRAY_STATE_COLORS for s in TRAY_SLOT_SIZES}
    for d, want in ((app_dir, app_want), (desk_dir, desk_want)):
        d.mkdir(parents=True, exist_ok=True)
        for stale in list(d.glob('*.png')) + list(d.glob('*.ico')):
            if stale.name not in want:
                stale.unlink()
        for p in made:
            if p.name in want:
                (d / p.name).write_bytes(p.read_bytes())

    # atalhos com o nome que os consumidores já conhecem, para não inventar
    # caminhos novos em index.html e no package.json do desktop. O que existia
    # antes vai para assets/branding/legacy/, nunca é apagado.
    write_preserving(REPO / 'packages' / 'app' / 'public' / 'favicon.png',
                     (GEN / 'favicon-tile-32.png').read_bytes())
    assets = REPO / 'packages' / 'desktop' / 'src' / 'assets'
    write_preserving(assets / 'icon.ico', ico.read_bytes())
    write_preserving(assets / 'icon.png', (GEN / 'icon-256.png').read_bytes())
    print('publicado em app/public/branding/cybersafe, desktop/src/assets/cybersafe, '
          'favicon.png, icon.ico, icon.png')


if __name__ == '__main__':
    main()
