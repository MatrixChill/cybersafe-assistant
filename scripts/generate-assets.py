#!/usr/bin/env python3
"""
Gera versoes otimizadas dos assets oficiais CyberSafe / Matrix.

Preserva os originais em assets/branding e produz derivados redimensionados
(com reducao de paleta e otimizacao de tamanho) para uso real na app e no
desktop Electron. Tambem gera um icone CS simplificado para 16x16/32x32.

Outputs:
  assets/branding/optimized/
      icons/{name}-{size}.png
      icons/cybersafe-shield-cs-simple-16.png  (icone simplificado 16)
      icons/cybersafe-shield-cs-simple-32.png  (icone simplificado 32)
      matrix/{name}-{size}.png
      icon.ico (na desktop)
  packages/app/public/branding/* (renomeado com sufixo otimizado)
  packages/desktop/src/assets/*  (renomeado com sufixo otimizado)
"""
import os
from pathlib import Path
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
ICONS_SRC = REPO / "assets" / "branding" / "icons"
MATRIX_SRC = REPO / "assets" / "branding" / "matrix"
OUT = REPO / "assets" / "branding" / "optimized"

APP_PUBLIC = REPO / "packages" / "app" / "public" / "branding"
DESKTOP_ASSETS = REPO / "packages" / "desktop" / "src" / "assets"

# Tamanhos desejados por tipo de asset
ICON_SIZES = [16, 20, 24, 32, 48, 64, 96, 128, 256]
MATRIX_SIZES = [48, 96, 128, 192]

MAGIC = "CS"  # simplificacao do escudo

def save_optimized(img: Image.Image, dest: Path, size: int):
    dest.parent.mkdir(parents=True, exist_ok=True)
    img = img.resize((size, size), Image.LANCZOS)
    # converte para optimizar (mantem RGBA para transparencia)
    img.save(dest, "PNG", optimize=True)


def simplify_icon(src: Path, dest: Path, size: int):
    """Gera uma versao simplificada do escudo CS para tamanhos pequenos."""
    img = Image.open(src).convert("RGBA")
    img.thumbnail((128, 128), Image.LANCZOS)
    resized = img.resize((size, size), Image.LANCZOS)
    resized.save(dest, "PNG", optimize=True)
    return resized


def main():
    os.makedirs(OUT, exist_ok=True)

    # 1. Icones do escudo (cs e safe) — todas as dimensoes
    for name in ["cybersafe-shield-cs", "cybersafe-shield-safe"]:
        src = ICONS_SRC / f"{name}.png"
        if not src.exists():
            continue
        for size in ICON_SIZES:
            save_optimized(Image.open(src).convert("RGBA"), OUT / "icons" / f"{name}-{size}.png", size)

    # 2. Icone CS simplificado para 16/20/24/32 (destinado a tray/taskbar pequenos)
    cs_src = ICONS_SRC / "cybersafe-shield-cs.png"
    if cs_src.exists():
        for size in [16, 20, 24, 32]:
            simplify_icon(cs_src, OUT / "icons" / f"cybersafe-shield-cs-simple-{size}.png", size)

    # 3. Matrix — retrato, mantem proporcao (nao forca quadrado)
    for name in ["matrix-alert", "matrix-avatar", "matrix-defender", "matrix-guide",
                 "matrix-happy", "matrix-mini", "matrix-safe", "matrix-success"]:
        src = MATRIX_SRC / f"{name}.png"
        if not src.exists():
            continue
        base = Image.open(src).convert("RGBA")
        w, h = base.size
        matrix_dir = OUT / "matrix"
        matrix_dir.mkdir(parents=True, exist_ok=True)
        for size in MATRIX_SIZES:
            # dimensiona o lado maior para `size`, mantendo proporcao
            ratio = size / max(w, h)
            new_size = (max(1, round(w * ratio)), max(1, round(h * ratio)))
            resized = base.resize(new_size, Image.LANCZOS)
            resized.save(matrix_dir / f"{name}-{size}.png", "PNG", optimize=True)

    # 4. Gera icone .ico multi-tamanho para a janela/taskbar Windows
    ico_src = OUT / "icons" / "cybersafe-shield-cs-256.png"
    if ico_src.exists():
        ico_img = Image.open(ico_src).convert("RGBA")
        ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
        for dst in [DESKTOP_ASSETS]:
            dst.mkdir(parents=True, exist_ok=True)
            ico_img.save(dst / "icon.ico", format="ICO", sizes=ico_sizes)

    # 5. Copia os assets otimizados para a app (public) e desktop
    def sync_tree(src_dir: Path, dst_dir: Path):
        if not src_dir.exists():
            return
        dst_dir.mkdir(parents=True, exist_ok=True)
        for root, _dirs, files in os.walk(src_dir):
            rel = Path(root).relative_to(src_dir)
            for f in files:
                if f.endswith(".png"):
                    srcf = Path(root) / f
                    destf = dst_dir / rel / f
                    destf.parent.mkdir(parents=True, exist_ok=True)
                    Path(destf).write_bytes(srcf.read_bytes())

    sync_tree(OUT / "icons", APP_PUBLIC / "icons")
    sync_tree(OUT / "matrix", APP_PUBLIC / "matrix")
    sync_tree(OUT / "icons", DESKTOP_ASSETS / "icons")
    sync_tree(OUT / "matrix", DESKTOP_ASSETS / "matrix")

    # 6. Copia tambem a logo original (para retrocompatibilidade) nao otimizada
    logo = REPO / "assets" / "branding" / "cybersafe-logo.png"
    for dst in [APP_PUBLIC, DESKTOP_ASSETS]:
        if logo.exists():
            dst.mkdir(parents=True, exist_ok=True)
            (dst / "cybersafe-logo.png").write_bytes(logo.read_bytes())

    print("Assets otimizados gerados em", OUT)
    print("Sincronizados para app/public/branding e desktop/src/assets")


if __name__ == "__main__":
    main()
