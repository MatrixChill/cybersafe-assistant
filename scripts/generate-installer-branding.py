"""Native NSIS surfaces for CyberSafe Assistant.

The official masters remain the only logo source. This script crops their alpha
bounds, scales them without recolouring, and composes a dark native surface.
Text, focus, hit testing and progress remain NSIS controls at runtime.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "branding" / "source"
BG = (7, 21, 26)
PANEL = (6, 24, 29)
CYAN = (22, 214, 193)
CYAN_SOFT = (16, 155, 151)
VIOLET = (158, 155, 255)
INK = (237, 248, 248)
MUTED = (126, 164, 168)
LINE = (31, 75, 79)
NAMES = ("02_CyberSafe_simbolo.png", "07_CyberSafe_horizontal_lockup.png")
SCENE = ROOT / "assets" / "branding" / "scene" / "orbital-b-scene.png"
SCENE_BG = (16, 35, 49)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    folder = Path("C:/Windows/Fonts")
    candidates = (
        "seguisb.ttf" if bold else "segoeui.ttf",
        "segoeuib.ttf" if bold else "segoeui.ttf",
        "arialbd.ttf" if bold else "arial.ttf",
    )
    for name in candidates:
        try:
            return ImageFont.truetype(str(folder / name), size)
        except OSError:
            continue
    return ImageFont.load_default()


def official(name: str, max_w: int, max_h: int) -> Image.Image:
    image = Image.open(SOURCE / name).convert("RGBA")
    bounds = image.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if bounds:
        image = image.crop(bounds)
    image.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    return image


def linear(w: int, h: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGBA", (w, h), BG + (255,))
    draw = ImageDraw.Draw(image)
    for y in range(h):
        t = y / max(1, h - 1)
        draw.line(
            (0, y, w, y),
            fill=tuple(round(top[i] * (1 - t) + bottom[i] * t) for i in range(3)) + (255,),
        )
    return image


def glow(image: Image.Image, box: tuple[int, int, int, int], color: tuple[int, int, int], alpha: int, blur: int) -> Image.Image:
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(box, fill=color + (alpha,))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    return Image.alpha_composite(image, layer)


def panel(image: Image.Image, box: tuple[int, int, int, int], fill: int = 236) -> Image.Image:
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(box, radius=10, fill=PANEL + (fill,), outline=LINE + (160,), width=1)
    draw.line((x0 + 10, y0 + 1, x1 - 10, y0 + 1), fill=CYAN + (40,), width=1)
    return Image.alpha_composite(image, layer)


def draw_arc(
    layer: Image.Image,
    cx: float,
    cy: float,
    rx: float,
    ry: float,
    tilt: float,
    color: tuple[int, int, int],
    alpha: int,
    width: int,
    start: float = 0,
    end: float = 360,
) -> None:
    points = []
    steps = 181
    for i in range(steps):
        t = math.radians(start + (end - start) * i / (steps - 1))
        x = rx * math.cos(t)
        y = ry * math.sin(t)
        r = math.radians(tilt)
        points.append((cx + x * math.cos(r) - y * math.sin(r), cy + x * math.sin(r) + y * math.cos(r)))
    ImageDraw.Draw(layer).line(points, fill=color + (alpha,), width=width, joint="curve")


def orbital(image: Image.Image, cx: int, cy: int, rx: int, ry: int, symbol_w: int, symbol_h: int) -> Image.Image:
    """Official symbol held inside layered, perspective rings and a soft glass disk."""
    # Glass pedestal and ambient bloom.
    image = glow(image, (cx - rx - 16, cy - ry - 16, cx + rx + 16, cy + ry + 16), CYAN, 15, 34)
    image = glow(image, (cx - rx // 2, cy + ry // 2, cx + rx // 2, cy + ry // 2 + 24), VIOLET, 16, 28)
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.ellipse((cx - rx * 0.82, cy + ry * 0.55, cx + rx * 0.82, cy + ry * 1.22), fill=(11, 64, 69, 40), outline=CYAN + (35,), width=1)
    image = Image.alpha_composite(image, layer)

    # Rear arcs: these sit behind the official symbol.
    rear = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw_arc(rear, cx, cy, rx, ry, -21, VIOLET, 70, 2, 185, 355)
    draw_arc(rear, cx, cy, rx * 1.18, ry * 0.65, 25, CYAN_SOFT, 55, 2, 190, 350)
    # Wide translucent bands give the rings body before the bright core.
    draw_arc(rear, cx, cy, rx, ry, -21, VIOLET, 28, 10, 185, 355)
    draw_arc(rear, cx, cy, rx * 1.18, ry * 0.65, 25, CYAN, 25, 9, 190, 350)
    rear = rear.filter(ImageFilter.GaussianBlur(4))
    image = Image.alpha_composite(image, rear)

    # Drop shadow and cyan rim glow around the untouched master symbol.
    symbol = official(NAMES[0], symbol_w, symbol_h)
    sx = cx - symbol.width // 2
    sy = cy - symbol.height // 2
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 185), (sx + 8, sy + 12), symbol.getchannel("A"))
    shadow = shadow.filter(ImageFilter.GaussianBlur(13))
    image = Image.alpha_composite(image, shadow)
    halo = Image.new("RGBA", image.size, (0, 0, 0, 0))
    halo.paste(CYAN + (55,), (sx, sy), symbol.getchannel("A"))
    halo = halo.filter(ImageFilter.GaussianBlur(18))
    image = Image.alpha_composite(image, halo)
    image.alpha_composite(symbol, (sx, sy))

    # Front arcs pass over the lower half of the symbol: convincing depth without redraw.
    front = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw_arc(front, cx, cy, rx, ry, -21, CYAN, 36, 8, 5, 175)
    draw_arc(front, cx, cy, rx, ry, -21, CYAN, 145, 3, 5, 175)
    draw_arc(front, cx, cy, rx * 0.96, ry * 0.96, -21, (178, 255, 244), 205, 1, 24, 114)
    draw_arc(front, cx, cy, rx * 1.18, ry * 0.65, 25, VIOLET, 42, 6, 5, 165)
    draw_arc(front, cx, cy, rx * 1.18, ry * 0.65, 25, VIOLET, 125, 2, 5, 165)
    front_glow = front.filter(ImageFilter.GaussianBlur(7))
    image = Image.alpha_composite(image, front_glow)
    image = Image.alpha_composite(image, front)

    # Sparse orbital nodes, not a particle field.
    for angle, color, radius in ((-160, CYAN, 3), (-28, VIOLET, 2), (146, CYAN_SOFT, 2)):
        t = math.radians(angle)
        x = cx + rx * math.cos(t)
        y = cy + ry * math.sin(t)
        dot = Image.new("RGBA", image.size, (0, 0, 0, 0))
        ImageDraw.Draw(dot).ellipse((x - radius, y - radius, x + radius, y + radius), fill=color + (220,))
        image = Image.alpha_composite(image, dot.filter(ImageFilter.GaussianBlur(1)))
    return image


def scene_export(max_w: int, max_h: int) -> Image.Image | None:
    """Real static capture of the updater Orbital B WebGL scene.

    The export carries a flat render background. It is keyed against that
    exact colour, cropped to content and scaled without redraw, so it
    composites into the native surface instead of showing a rectangle.
    Returns None when the export is absent; callers keep the vector fallback.
    """
    if not SCENE.exists():
        return None
    source = Image.open(SCENE).convert("RGB")
    pixels = []
    for r, g, b in source.getdata():
        distance = max(abs(r - SCENE_BG[0]), abs(g - SCENE_BG[1]), abs(b - SCENE_BG[2]))
        pixels.append((r, g, b, min(255, distance * 10)))
    keyed = Image.new("RGBA", source.size)
    keyed.putdata(pixels)
    bounds = keyed.getchannel("A").point(lambda a: 255 if a > 24 else 0).getbbox()
    if bounds:
        keyed = keyed.crop(bounds)
    keyed.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    return keyed


def hero(image: Image.Image, cx: int, cy: int, box_w: int, box_h: int) -> Image.Image:
    """Orbital B hero: the real exported scene, or the vector fallback."""
    scene = scene_export(box_w, box_h)
    if scene is None:
        return orbital(image, cx, cy, box_w // 2, box_h // 8, box_w // 3, box_h // 2)
    image = glow(
        image,
        (cx - box_w // 2 - 8, cy - box_h // 2 - 8, cx + box_w // 2 + 8, cy + box_h // 2 + 8),
        CYAN,
        10,
        30,
    )
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    layer.alpha_composite(scene, (cx - scene.width // 2, cy - scene.height // 2))
    return Image.alpha_composite(image, layer)


def step_rail(image: Image.Image, x: int, y: int, labels: list[str], active: int) -> Image.Image:
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    top = y + 5
    bottom = y + 34 * (len(labels) - 1) + 5
    draw.line((x + 7, top, x + 7, bottom), fill=LINE + (190,), width=1)
    for index, label in enumerate(labels):
        cy = y + 34 * index
        is_active = index == active
        color = CYAN if is_active else MUTED
        if is_active:
            draw.ellipse((x, cy, x + 15, cy + 15), fill=(9, 54, 58, 255), outline=CYAN + (255,), width=1)
            draw.ellipse((x + 5, cy + 5, x + 10, cy + 10), fill=CYAN + (255,))
        else:
            draw.ellipse((x + 2, cy + 2, x + 13, cy + 13), fill=(5, 20, 24, 255), outline=LINE + (235,), width=1)
        draw.text((x + 24, cy - 1), label, font=font(11, is_active), fill=(INK if is_active else MUTED) + (255,))
    return Image.alpha_composite(image, layer)


def page_art(active: int) -> Image.Image:
    w, h = 503, 287
    image = linear(w, h, (8, 31, 37), (4, 13, 17))
    image = glow(image, (255, -40, 560, 210), CYAN, 13, 42)
    image = glow(image, (305, 180, 570, 360), VIOLET, 10, 38)
    image = panel(image, (176, 9, 493, 278), 255)
    # Left glass rail, kept darker than the content surface.
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.rectangle((0, 0, 169, h), fill=(5, 17, 22, 225))
    for y in range(h):
        t = y / max(1, h - 1)
        draw.line((0, y, 169, y), fill=(8, 37, 43, int(225 + 18 * (1 - t))))
    for x in range(0, 169, 13):
        draw.line((x, 0, x, h), fill=(19, 90, 91, 8), width=1)
    draw.line((169, 0, 169, h), fill=CYAN + (75,), width=1)
    image = Image.alpha_composite(image, overlay)
    image.alpha_composite(official(NAMES[1], 146, 48), (13, 16))
    draw = ImageDraw.Draw(image)
    draw.text((14, 76), "ASSISTANT / WINDOWS", font=font(9, True), fill=CYAN + (235,))
    draw.text((14, 91), "SETUP  /  2026", font=font(8), fill=MUTED + (220,))
    # Same split composition as UpdaterWindow: brand, orbital hero, content.
    # Do not burn a fake verification/progress state into the artwork.
    image = hero(image, 82, 172, 150, 108)
    draw = ImageDraw.Draw(image)
    draw.text((22, 239), "CYBERSAFE / ORBITAL B", font=font(7, True), fill=MUTED + (220,))
    draw.line((14, 257, 154, 257), fill=LINE + (160,), width=1)
    draw.text((23, 267), "INSTALAÇÃO WINDOWS", font=font(7), fill=CYAN_SOFT + (220,))
    # A restrained hero mark in the content field, behind native controls.
    image = glow(image, (385, 192, 520, 327), CYAN, 12, 34)
    draw = ImageDraw.Draw(image)
    draw.text((190, 259), "CYBERSAFE  /  WINDOWS  SETUP", font=font(7), fill=CYAN_SOFT + (125,))
    image.putpixel((w - 1, h - 1), BG + (255,))
    return image.convert("RGB")


def sidebar_art() -> Image.Image:
    w, h = 164, 314
    image = linear(w, h, (8, 32, 38), (4, 13, 17))
    image = glow(image, (-35, 120, 130, 300), CYAN, 18, 34)
    image = glow(image, (40, 220, 200, 360), VIOLET, 12, 32)
    image.alpha_composite(official(NAMES[1], 138, 46), (13, 16))
    draw = ImageDraw.Draw(image)
    draw.text((14, 74), "ASSISTANT / WINDOWS", font=font(8, True), fill=CYAN + (230,))
    draw.text((14, 88), "SETUP  /  2026", font=font(7), fill=MUTED + (220,))
    image = hero(image, 82, 200, 146, 110)
    draw = ImageDraw.Draw(image)
    draw.line((13, 299, 151, 299), fill=LINE + (130,), width=1)
    draw.text((14, 303), "CYBERSAFE  /  CORE", font=font(6, True), fill=MUTED + (190,))
    image.putpixel((w - 1, h - 1), BG + (255,))
    return image.convert("RGB")


def header_art() -> Image.Image:
    w, h = 150, 57
    image = linear(w, h, (9, 35, 41), (5, 18, 23))
    image = glow(image, (60, -20, 190, 90), CYAN, 18, 25)
    image.alpha_composite(official(NAMES[1], 140, 45), (5, 6))
    draw = ImageDraw.Draw(image)
    draw.line((0, h - 1, w, h - 1), fill=CYAN + (85,), width=1)
    image.putpixel((w - 1, h - 1), BG + (255,))
    return image.convert("RGB")


def preview_art() -> Image.Image:
    w, h = 900, 560
    image = linear(w, h, (8, 31, 38), (3, 11, 16))
    image = glow(image, (430, -80, 1000, 500), CYAN, 18, 70)
    image = glow(image, (450, 260, 1000, 700), VIOLET, 12, 60)
    # The native content surface matches opaque labels so state changes erase cleanly.
    ImageDraw.Draw(image).rectangle((260, 0, w, h), fill=BG + (255,))
    # Left rail and right content field.
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.rectangle((0, 0, 259, h), fill=(5, 17, 22, 238))
    for y in range(h):
        t = y / max(1, h - 1)
        draw.line((0, y, 259, y), fill=(9, 39, 45, int(238 + 12 * (1 - t))))
    for x in range(0, 259, 18):
        draw.line((x, 0, x, h), fill=(19, 90, 91, 7), width=1)
    draw.line((259, 0, 259, h), fill=CYAN + (70,), width=1)
    image = Image.alpha_composite(image, overlay)
    image.alpha_composite(official(NAMES[1], 214, 71), (24, 24))
    draw = ImageDraw.Draw(image)
    draw.text((26, 106), "ASSISTANT  /  WINDOWS", font=font(10, True), fill=CYAN + (240,))
    draw.text((26, 123), "SETUP  /  2026", font=font(8), fill=MUTED + (225,))
    draw.line((25, 146, 233, 146), fill=LINE + (125,), width=1)
    image = hero(image, 130, 300, 226, 170)
    draw = ImageDraw.Draw(image)
    draw.text((42, 435), "CYBERSAFE / ORBITAL B", font=font(9, True), fill=MUTED + (225,))
    draw.line((26, 526, 233, 526), fill=LINE + (100,), width=1)
    draw.text((26, 531), "ESTUDO NATIVO  /  SEM PAYLOAD", font=font(7, True), fill=VIOLET + (170,))
    # Content remains clear for the real native controls, as in the updater.
    # Bottom light sweep, deliberately behind the native footer.
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((292, 255, 886, 555), radius=10, fill=BG + (255,), outline=LINE + (120,), width=1)
    sweep = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ImageDraw.Draw(sweep).arc((380, 340, 1040, 720), 200, 318, fill=CYAN + (50,), width=2)
    image = Image.alpha_composite(image, sweep.filter(ImageFilter.GaussianBlur(2)))
    draw = ImageDraw.Draw(image)
    image.putpixel((w - 1, h - 1), BG + (255,))
    return image.convert("RGB")


def button_surface(primary: bool) -> Image.Image:
    w, h = 240, 48
    top = (25, 189, 174) if primary else (13, 45, 51)
    bottom = (11, 107, 106) if primary else (7, 26, 32)
    image = linear(w, h, top, bottom)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, w - 1, h - 1), radius=8, outline=(CYAN if primary else LINE) + (190,), width=1)
    draw.line((14, 1, w - 14, 1), fill=(255, 255, 255, 32), width=1)
    draw.line((14, h - 2, w - 14, h - 2), fill=(0, 0, 0, 45), width=1)
    return image.convert("RGB")


def render(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)

    def save(image: Image.Image, name: str) -> None:
        image.convert("RGB").save(out / name, "BMP")

    save(page_art(0), "page-welcome.bmp")
    save(page_art(1), "page-config.bmp")
    save(sidebar_art(), "installerSidebar.bmp")
    save(sidebar_art(), "uninstallerSidebar.bmp")
    save(header_art(), "installerHeader.bmp")
    save(preview_art(), "preview.bmp")
    save(button_surface(True), "button-primary.bmp")
    save(button_surface(False), "button-secondary.bmp")
    files = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(out.glob("*.bmp"))}
    manifest = {
        "schema": 1,
        "sources": {name: hashlib.sha256((SOURCE / name).read_bytes()).hexdigest() for name in NAMES},
        "files": files,
        "logoTreatment": "alpha bounds crop, aspect-preserving downscale and composition; no redraw or recolour",
        "orbitalPresentation": {
            "mode": "static-native",
            "webglRuntime": False,
            "description": "Static capture of the updater Orbital B scene, keyed and cropped; no live WebGL in NSIS",
            "sceneExport": {
                "file": SCENE.relative_to(ROOT).as_posix(),
                "sha256": hashlib.sha256(SCENE.read_bytes()).hexdigest(),
                "renderer": "UpdaterScene/CoreScene WebGL, single frame",
                "liveAnimation": False,
                "composition": "background keyed, alpha bounds crop, aspect-preserving downscale; no redraw",
            } if SCENE.exists() else None,
            "sharedSceneSources": {
                name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                for name in [
                    "packages/app/src/v2/dashboard/effects/orbitalBody.ts",
                    "packages/app/src/v2/dashboard/effects/orbitalPose.ts",
                ]
            },
        },
        "paletteSource": "packages/app/src/index.css: CyberSafe Core dark",
        "updaterDesign": {
            "layout": "brand-orbital-left-content-right",
            "progress": "native-real-only",
            "sources": {
                name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                for name in ["packages/app/src/components/updates/UpdaterWindow.tsx",
                             "packages/app/src/components/updates/updater-window.css"]
            },
        },
    }
    (out / "branding-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    render(parser.parse_args().output)
