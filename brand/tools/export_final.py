"""Final asset pack: the 16 × 16 pixel raven + the Block wordmark, dithered.

Everything is rendered straight from the master bitmaps at whole-number scales, so every PNG is pixel-exact.
The logo is shaded from above with a 1-bit Bayer dither: each grid unit becomes 2 × 2 sub-pixels, so it needs
at least 2 px per unit. Below that (the 16 and 32 px favicons, favicon.svg) the solid raven is used.
Run: .venv/bin/python export_final.py  →  ../final/
"""
import json
import os
import shutil
import subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from geo import rects_path
from pixvars import P16, P12, P24, BAYER, tones16
from treat import WB, lockup_grid, word_tones
import blockfont

HERE = os.path.dirname(os.path.abspath(__file__))
BRAND = os.path.dirname(HERE)
OUT = os.path.join(BRAND, "final")

DITHER = True                               # False rebuilds the solid kit
INK, PAPER = (10, 10, 10), (244, 244, 244)
INK_HEX, PAPER_HEX = "#0a0a0a", "#f4f4f4"
DOT, RULE = (30, 30, 30), (78, 78, 78)
CLEAR = 4                                   # minimum clear space, in grid units


def crop(g, T=None):
    r = np.nonzero(g.any(axis=1))[0]
    c = np.nonzero(g.any(axis=0))[0]
    box = np.s_[r[0]:r[-1] + 1, c[0]:c[-1] + 1]
    return g[box] if T is None else (g[box], T[box])


MARK = crop(P16, tones16())                 # 16 × 11
WORD = crop(WB, word_tones(WB))             # 38 × 11
H_LOCK = crop(*lockup_grid())               # mark · 5 · word, shared cap and baseline


def stacked(gap=4):
    (mg, mt), (wg, wt) = MARK, WORD
    w = max(mg.shape[1], wg.shape[1])
    h = mg.shape[0] + gap + wg.shape[0]
    g, T = np.zeros((h, w), bool), np.full((h, w), -1)
    x = (w - mg.shape[1]) // 2
    g[:mg.shape[0], x:x + mg.shape[1]], T[:mg.shape[0], x:x + mg.shape[1]] = mg, mt
    x = (w - wg.shape[1]) // 2
    g[mg.shape[0] + gap:, x:x + wg.shape[1]], T[mg.shape[0] + gap:, x:x + wg.shape[1]] = wg, wt
    return g, T


V_LOCK = stacked()


def dithered(gt):
    """1-bit Bayer dither at 2×: tone 0–3 keeps 4, 3, 2 or 1 of each unit's 2 × 2 sub-pixels."""
    _, T = gt
    keep = np.kron(np.where(T >= 0, 4 - np.clip(T, 0, 3), 0), np.ones((2, 2), int))
    return np.tile(BAYER, T.shape) < keep


def art(gt, scale):
    """The bitmap to stamp for a shape at `scale` px per grid unit, and its px per cell.
    Dithered when every sub-pixel lands on whole pixels, solid otherwise."""
    if DITHER and scale % 2 == 0:
        return dithered(gt), scale // 2
    return gt[0], scale


def logo_scale(target, units):
    """Whole-number px per unit closest to `target` px wide, kept even so the dither stays pixel-exact."""
    s = target / units
    if DITHER and s >= 1.5:
        return 2 * max(1, int(round(s / 2)))
    return max(1, int(round(s)))


def text(s):
    """Set a string in Munin Block straight from the glyph bitmaps (14 rows: cap line → descender)."""
    parts = []
    for ch in s:
        if ch == " ":
            parts.append(np.zeros((14, blockfont.SPACE), bool))
        else:
            g = blockfont.bitmap(ch)
            pad = np.zeros((14, blockfont.SIDE), bool)
            parts += [pad, g, pad]
    return np.hstack(parts)


# ── vector ────────────────────────────────────────────────────────────────────
def trace(g):
    """Union outline of the filled cells as axis-aligned loops (y down)."""
    h, w = g.shape
    f = lambda r, c: 0 <= r < h and 0 <= c < w and g[r, c]
    edges = {}
    for r in range(h):
        for c in range(w):
            if not g[r, c]:
                continue
            if not f(r - 1, c): edges.setdefault((c, r), []).append((c + 1, r))
            if not f(r + 1, c): edges.setdefault((c + 1, r + 1), []).append((c, r + 1))
            if not f(r, c - 1): edges.setdefault((c, r + 1), []).append((c, r))
            if not f(r, c + 1): edges.setdefault((c + 1, r), []).append((c + 1, r + 1))
    loops = []
    while edges:
        start = next(iter(edges))
        loop, prev, cur = [start], None, start
        while True:
            outs = edges[cur]
            if len(outs) > 1 and prev:
                outs.sort(key=lambda n: -((cur[0] - prev[0]) * (n[1] - cur[1]) - (cur[1] - prev[1]) * (n[0] - cur[0])))
            nxt = outs.pop(0)
            if not outs:
                del edges[cur]
            if nxt == start:
                break
            loop.append(nxt)
            prev, cur = cur, nxt
        n = len(loop)
        loops.append([loop[i] for i in range(n)
                      if (loop[i][0] - loop[i - 1][0]) * (loop[(i + 1) % n][1] - loop[i][1])
                      != (loop[i][1] - loop[i - 1][1]) * (loop[(i + 1) % n][0] - loop[i][0])])
    return loops


def path_d(g):
    out = []
    for loop in trace(g):
        s = f"M{loop[0][0]} {loop[0][1]}"
        for (x0, y0), (x1, y1) in zip(loop, loop[1:] + loop[:1]):
            if (x1, y1) == loop[0]:
                break
            s += f"H{x1}" if y1 == y0 else f"V{y1}"
        out.append(s + "Z")
    return "".join(out)


def svg(gt, fill="currentColor", scale=8, title="munin", solid=False):
    """viewBox is in cells: grid units when solid, 2× sub-pixels when dithered."""
    g, cell = (gt[0], scale) if solid else art(gt, scale)
    h, w = g.shape
    d = path_d(g) if cell == scale else rects_path(g)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w * cell}" height="{h * cell}" '
            f'shape-rendering="crispEdges" role="img" aria-label="{title}"><path fill="{fill}" d="{d}"/></svg>\n')


# ── raster ────────────────────────────────────────────────────────────────────
def img(g, scale, fg, bg=None, pad=0):
    """Pixel-exact PNG: each grid unit becomes a scale × scale block."""
    g = np.pad(g, pad)
    big = np.kron(g, np.ones((scale, scale), bool))
    h, w = big.shape
    if bg is None:
        a = np.zeros((h, w, 4), np.uint8)
        a[big] = (*fg, 255)
        return Image.fromarray(a, "RGBA")
    a = np.empty((h, w, 3), np.uint8)
    a[:] = bg
    a[big] = fg
    return Image.fromarray(a, "RGB")


def paste_bitmap(im, g, scale, cx, cy, color=PAPER):
    """Stamp a bitmap centred on (cx, cy) at whole-pixel positions."""
    tile = img(g, scale, color)
    x = int(round(cx - tile.width / 2))
    y = int(round(cy - tile.height / 2))
    im.alpha_composite(tile, (x, y)) if im.mode == "RGBA" else im.paste(tile, (x, y), tile)
    return x, y


def paste_logo(im, gt, scale, cx, cy):
    """Stamp a logo shape at `scale` px per grid unit, dithered when the scale allows."""
    g, cell = art(gt, scale)
    return paste_bitmap(im, g, cell, cx, cy)


def dots(draw, w, h, step, r, color, x0=0, y0=0, x1=None, y1=None):
    x1, y1 = x1 or w, y1 or h
    for y in np.arange(y0 + step / 2, y1, step):
        for x in np.arange(x0 + step / 2, x1, step):
            draw.ellipse([x - r, y - r, x + r, y + r], fill=color)


def corners(draw, box, arm, t, color):
    x0, y0, x1, y1 = box
    for (x, y, sx, sy) in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)):
        draw.rectangle(sorted([x, x + sx * arm])[0:1] + [min(y, y + sy * t)] + sorted([x, x + sx * arm])[1:] + [max(y, y + sy * t)], fill=color)
        draw.rectangle([min(x, x + sx * t), min(y, y + sy * arm), max(x, x + sx * t), max(y, y + sy * arm)], fill=color)


def tile_icon(size):
    """Favicon tile: ink square with stepped pixel corners, paper raven knocked in."""
    cut = {16: 1, 32: 2, 48: 3}[size]
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    a = np.zeros((size, size), bool)
    a[:] = True
    for i in range(cut):
        for j in range(cut - i):
            for r, c in ((i, j), (i, size - 1 - j), (size - 1 - i, j), (size - 1 - i, size - 1 - j)):
                a[r, c] = False
    im = img(a, 1, INK)
    if size == 48:
        paste_logo(im, MARK, 2, size / 2, size / 2)
    else:                                   # too small to dither: the hand-drawn 12 and 24 px ravens
        paste_bitmap(im, crop({16: P12, 32: P24}[size]), 1, size / 2, size / 2 + (0.5 if size == 16 else 0))
    return im


def app_icon(size, rounded=True, detail=None):
    """Dark tile, dot grid, viewfinder corners, raven. rounded=True → macOS squircle with shadow on transparent."""
    if size <= 16:
        return tile_icon(16).resize((size, size), Image.NEAREST)
    detail = size >= 256 if detail is None else detail
    ss = 4
    S = size * ss
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(base)
    if rounded:
        m, rad = S * 100 / 1024, S * 185 / 1024
        box = [m, m, S - m, S - m]
        shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle([box[0], box[1] + S * 12 / 1024, box[2], box[3] + S * 12 / 1024], rad, fill=(0, 0, 0, 110))
        base = Image.alpha_composite(base, shadow.filter(ImageFilter.GaussianBlur(S * 14 / 1024)))
        d = ImageDraw.Draw(base)
        d.rounded_rectangle(box, rad, fill=(*INK, 255))
        inner = box
    else:
        d.rectangle([0, 0, S, S], fill=(*INK, 255))
        inner = [0, 0, S, S]
    if detail:
        step = S * 24 / 1024
        dot = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        dots(ImageDraw.Draw(dot), S, S, step, S * 2.6 / 1024, (*DOT, 255), *inner)
        mask = Image.new("L", (S, S), 0)
        (ImageDraw.Draw(mask).rounded_rectangle(inner, S * 185 / 1024, fill=255) if rounded else ImageDraw.Draw(mask).rectangle(inner, fill=255))
        base.paste(dot, (0, 0), Image.composite(dot.getchannel("A"), Image.new("L", (S, S), 0), mask))
        inset = (inner[2] - inner[0]) * 0.17
        corners(ImageDraw.Draw(base), [inner[0] + inset, inner[1] + inset, inner[2] - inset, inner[3] - inset],
                S * 54 / 1024, S * 6 / 1024, (*RULE, 255))
    im = base.resize((size, size), Image.LANCZOS)
    face = (size * 824 / 1024) if rounded else size
    paste_logo(im, MARK, logo_scale(face * 0.5, MARK[0].shape[1]), size / 2, size / 2)
    return im if rounded else im.convert("RGB")


def card(w, h, tagline=None):
    """Social card: ink, dot grid, viewfinder, lockup (and optional tagline in Munin Block)."""
    ss = 3
    base = Image.new("RGB", (w * ss, h * ss), INK)
    d = ImageDraw.Draw(base)
    dots(d, w * ss, h * ss, 14 * ss, 1.3 * ss, DOT)
    m = 44 * ss
    corners(d, [m, m, w * ss - m, h * ss - m], 28 * ss, 2 * ss, RULE)
    im = base.resize((w, h), Image.LANCZOS).convert("RGBA")
    if tagline:
        scale = 10
        lh = H_LOCK[0].shape[0] * scale
        t = crop(text(tagline))
        gap = 56
        total = lh + gap + t.shape[0] * 2
        top = (h - total) / 2
        paste_logo(im, H_LOCK, scale, w / 2, top + lh / 2)
        paste_bitmap(im, t, 2, w / 2, top + lh + gap + t.shape[0], color=(150, 150, 150))
    else:
        paste_logo(im, H_LOCK, 12, w / 2, h / 2)
    return im.convert("RGB")


# ── export ────────────────────────────────────────────────────────────────────
def save(im, *parts):
    p = os.path.join(OUT, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    im.save(p, optimize=True)
    return p


def write(text_, *parts):
    p = os.path.join(OUT, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write(text_)
    return p


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    shapes = {"mark": MARK, "wordmark": WORD, "lockup-horizontal": H_LOCK, "lockup-stacked": V_LOCK}

    # SVG: currentColor master + fixed-colour versions, plus solid ones for anything smaller than 2×
    for name, gt in shapes.items():
        write(svg(gt), "svg", f"munin-{name}.svg")
        write(svg(gt, PAPER_HEX), "svg", f"munin-{name}-white.svg")
        write(svg(gt, INK_HEX), "svg", f"munin-{name}-black.svg")
        if DITHER:
            write(svg(gt, solid=True), "svg", "solid", f"munin-{name}.svg")
            write(svg(gt, PAPER_HEX, solid=True), "svg", "solid", f"munin-{name}-white.svg")
            write(svg(gt, INK_HEX, solid=True), "svg", "solid", f"munin-{name}-black.svg")

    # PNG: transparent at whole-number scales + padded on-dark / on-light tiles
    small = () if DITHER else (1,)
    scales = {"mark": (*small, 2, 4, 8, 16, 32), "wordmark": (2, 4, 8, 16), "lockup-horizontal": (2, 4, 8, 16), "lockup-stacked": (2, 4, 8, 16)}
    for name, gt in shapes.items():
        for s in scales[name]:
            g, cell = art(gt, s)
            save(img(g, cell, PAPER), "png", name, f"munin-{name}-white@{s}x.png")
            save(img(g, cell, INK), "png", name, f"munin-{name}-black@{s}x.png")
        g, cell = art(gt, 8)
        pad = (CLEAR + 2) * 8 // cell
        save(img(g, cell, PAPER, INK, pad=pad), "png", name, f"munin-{name}-on-dark@8x.png")
        save(img(g, cell, INK, PAPER, pad=pad), "png", name, f"munin-{name}-on-light@8x.png")

    # Favicons
    fav = os.path.join(OUT, "favicon")
    p16 = path_d(P16)
    write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">'
          f'<style>path{{fill:{INK_HEX}}}@media (prefers-color-scheme:dark){{path{{fill:{PAPER_HEX}}}}}</style>'
          f'<path d="{p16}"/></svg>\n', "favicon", "favicon.svg")
    tiles = {s: tile_icon(s) for s in (16, 32, 48)}
    for s, t in tiles.items():
        save(t, "favicon", f"favicon-{s}.png")
    tiles[48].save(os.path.join(fav, "favicon.ico"), format="ICO", sizes=[(16, 16), (32, 32), (48, 48)],
                   append_images=[tiles[16], tiles[32]])
    save(app_icon(180, rounded=False, detail=False), "favicon", "apple-touch-icon.png")
    save(app_icon(192, rounded=False, detail=False), "favicon", "android-chrome-192.png")
    save(app_icon(512, rounded=False, detail=True), "favicon", "android-chrome-512.png")
    save(app_icon(512, rounded=False, detail=False), "favicon", "maskable-512.png")
    write(json.dumps({
        "name": "munin", "short_name": "munin",
        "icons": [{"src": "/android-chrome-192.png", "sizes": "192x192", "type": "image/png"},
                  {"src": "/android-chrome-512.png", "sizes": "512x512", "type": "image/png"},
                  {"src": "/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}],
        "theme_color": INK_HEX, "background_color": INK_HEX, "display": "standalone"}, indent=2) + "\n", "favicon", "site.webmanifest")
    write("""<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#0a0a0a">
<meta property="og:image" content="/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
""", "favicon", "head.html")

    # App icons
    iconset = os.path.join(OUT, "app-icon", "macos", "AppIcon.iconset")
    os.makedirs(iconset)
    for pt in (16, 32, 128, 256, 512):
        for k in (1, 2):
            px = pt * k
            app_icon(px).save(os.path.join(iconset, f"icon_{pt}x{pt}{'@2x' if k == 2 else ''}.png"))
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(OUT, "app-icon", "macos", "AppIcon.icns")], check=True)
    save(app_icon(1024), "app-icon", "macos", "app-icon-macos-1024.png")
    save(app_icon(1024, rounded=False), "app-icon", "ios", "app-icon-ios-1024.png")

    # Social
    save(card(1200, 630), "social", "og-image.png")
    save(card(1200, 630, "Huginn thinks. Munin remembers."), "social", "og-image-tagline.png")
    save(card(1280, 640), "social", "github-social-preview.png")
    shutil.copy(os.path.join(OUT, "social", "og-image.png"), os.path.join(fav, "og-image.png"))

    # Font
    for f in os.listdir(os.path.join(BRAND, "font")):
        os.makedirs(os.path.join(OUT, "font"), exist_ok=True)
        shutil.copy(os.path.join(BRAND, "font", f), os.path.join(OUT, "font", f))

    # Docs
    shutil.copy(os.path.join(HERE, "final_README.md"), os.path.join(OUT, "README.md"))
    shutil.copy(os.path.join(HERE, "final_index.html"), os.path.join(OUT, "index.html"))

    n = sum(len(fs) for _, _, fs in os.walk(OUT))
    print(f"{n} files → {OUT}")


if __name__ == "__main__":
    main()
