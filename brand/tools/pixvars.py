"""Round 2: pixel raven variants + custom pixel wordmarks, all on one pixel grid."""
import numpy as np
from geo import rects_path
from marks import PIXEL16

FG = "#f4f4f4"


def G(s):
    rows = s.strip("\n").split("\n")
    w = max(len(r) for r in rows)
    return np.array([[c == "#" for c in r.ljust(w, ".")] for r in rows])


P16 = G(PIXEL16)

P12 = G("""
............
............
..#####.....
.###.####...
##########..
######...###
#########...
.######.....
.#####.#....
..###.#.....
...#.#......
............
""")

P24 = G("""
........................
........................
........................
........................
...##########...........
..###############.......
.#######..##########....
.#######..############..
#######################.
#######################.
########################
############.........###
#####################.#.
##################......
##############..........
.#############.#........
.############.#.........
..##########.#.#........
..#########.#.#.........
...#######.#.#..........
....#####.#.#...........
.....###.#.#............
......#.#...............
........................
""")

# bust: taller crop with a neck, for square avatars
BUST16 = G("""
................
..#######.......
.#####.#####....
.#############..
###############.
#########.....##
#############...
########........
#######.#.......
#######..#......
######.#.#......
#######.#.......
#######..#......
########.#......
#########.......
##########......
""")


def svg(body, w, h, pad=0, extra=""):
    return (f'<svg viewBox="{-pad} {-pad} {w+2*pad} {h+2*pad}" xmlns="http://www.w3.org/2000/svg" '
            f'shape-rendering="crispEdges"{extra}>{body}</svg>')


def solid(g, fg=FG, pad=1):
    h, w = g.shape
    return svg(f'<path d="{rects_path(g)}" fill="{fg}"/>', w, h, pad)


def up(g, k):
    return np.kron(g, np.ones((k, k), bool))


def outline(g, fg=FG, k=2, pad=1):
    """1-unit line drawing at k× resolution, eye kept as a solid pixel."""
    u = up(g, k)
    p = np.pad(u, 1)
    inner = p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    edge = u & ~inner
    h, w = edge.shape
    return svg(f'<path d="{rects_path(edge)}" fill="{fg}"/>', w, h, pad * k)


def badge(g, fg=FG, pad=2, cut=2):
    """Raven knocked out of a solid tile with stepped pixel corners."""
    h, w = g.shape
    H, W = h + 2 * pad, w + 2 * pad
    tile = np.ones((H, W), bool)
    for i in range(cut):
        for j in range(cut - i):
            for (r, c) in ((i, j), (i, W - 1 - j), (H - 1 - i, j), (H - 1 - i, W - 1 - j)):
                tile[r, c] = False
    tile[pad:pad + h, pad:pad + w] &= ~g
    return svg(f'<path d="{rects_path(tile)}" fill="{fg}"/>', W, H, 0)


def leds(g, fg=FG, pad=1, r=0.42, ghost=None):
    h, w = g.shape
    dots = []
    for y in range(h):
        for x in range(w):
            if g[y, x]:
                dots.append(f'<circle cx="{x+.5}" cy="{y+.5}" r="{r}" fill="{fg}"/>')
            elif ghost:
                dots.append(f'<circle cx="{x+.5}" cy="{y+.5}" r="{r*0.55}" fill="{ghost}"/>')
    return f'<svg viewBox="{-pad} {-pad} {w+2*pad} {h+2*pad}" xmlns="http://www.w3.org/2000/svg">{"".join(dots)}</svg>'


def scan(g, fg=FG, pad=1, t=0.62):
    """CRT scanlines: every pixel row drawn as a thinner bar."""
    h, w = g.shape
    out = []
    for y in range(h):
        x = 0
        while x < w:
            if g[y, x]:
                x0 = x
                while x < w and g[y, x]:
                    x += 1
                out.append(f"M{x0} {y+(1-t)/2:.2f}h{x-x0}v{t}h{-(x-x0)}z")
            else:
                x += 1
    return f'<svg viewBox="{-pad} {-pad} {w+2*pad} {h+2*pad}" xmlns="http://www.w3.org/2000/svg"><path d="{"".join(out)}" fill="{fg}"/></svg>'


TONE16 = """
................
................
................
..0000000.......
.00000.00000....
.1111100000000..
11111111111110..
111111111.....00
2222222221111...
.2222222........
.222222.3.......
..3333.3........
...33.3.........
....3...........
................
................
"""


def tones16():
    rows = TONE16.strip("\n").split("\n")
    T = np.array([[int(c) if c.isdigit() else -1 for c in r] for r in rows])
    return T


def shaded(fg_tones=("#f4f4f4", "#b4b4b4", "#747474", "#444444"), pad=1):
    T = tones16()
    body = "".join(f'<path d="{rects_path(T == t)}" fill="{c}"/>' for t, c in enumerate(fg_tones))
    return svg(body, 16, 16, pad)


BAYER = np.array([[0, 2], [3, 1]])


def dither(fg=FG, pad=1):
    """1-bit: the shaded planes dithered at 2× with a Bayer matrix."""
    T = tones16()
    keep = {0: 4, 1: 3, 2: 2, 3: 1}           # how many of 4 subpixels stay on
    U = np.zeros((32, 32), bool)
    for r in range(16):
        for c in range(16):
            t = T[r, c]
            if t < 0:
                continue
            for dy in range(2):
                for dx in range(2):
                    U[2 * r + dy, 2 * c + dx] = BAYER[dy, dx] < keep[t]
    return svg(f'<path d="{rects_path(U)}" fill="{fg}"/>', 32, 32, pad * 2)


def extrude(g=P16, depth=3, step=0.34, face=FG, sides=("#7a7a7a", "#5a5a5a", "#3e3e3e", "#2c2c2c"), pad=1):
    """Pixels pushed out into 3D, like the Figment cube."""
    h, w = g.shape
    d = rects_path(g)
    layers = []
    for k in range(depth * 3, 0, -1):
        o = k * step / 3
        col = sides[min((k - 1) * len(sides) // (depth * 3), len(sides) - 1)]
        layers.append(f'<path d="{d}" fill="{col}" transform="translate({o:.3f} {o:.3f})"/>')
    layers.append(f'<path d="{d}" fill="{face}"/>')
    return f'<svg viewBox="{-pad} {-pad} {w+2*pad+1} {h+2*pad+1}" xmlns="http://www.w3.org/2000/svg">{"".join(layers)}</svg>'


def glitch(g=P16, fg=FG, pad=2):
    """Corrupted memory: a few rows slip sideways."""
    h, w = g.shape
    shifts = {5: 2, 6: 2, 9: -1, 11: 1}
    out = np.zeros((h, w + 4), bool)
    for r in range(h):
        s = shifts.get(r, 0)
        out[r, 2 + s:2 + s + w] = g[r]
    ghost = np.zeros_like(out)
    ghost[5:7, 2:2 + w] = g[5:7] & ~out[5:7, 2:2 + w]
    body = f'<path d="{rects_path(ghost)}" fill="#5a5a5a"/><path d="{rects_path(out)}" fill="{fg}"/>'
    return svg(body, w + 4, h, pad)


def frame(inner_svg, fg="#9a9a9a"):
    """FE-style viewfinder corners around a mark."""
    return (f'<div class="vfx">{inner_svg}<i></i><i></i><i></i><i></i></div>')


def state(kind):
    g = P16.copy()
    if kind == "blink":
        g[4, 5:8] = False                    # eye shut: a 3-px slit
    elif kind == "caw":
        g[8, 9:13] = False                   # lower mandible drops open
        g[9, 8:11] = True
        g[10, 10:13] = True
    return g


def pair(gap=2, fg=FG, pad=1):
    """Huginn & Muninn back to back."""
    left = P16[:, ::-1]
    h = 16
    out = np.zeros((h, 32 + gap), bool)
    out[:, :16] = left
    out[:, 16 + gap:] = P16
    return svg(f'<path d="{rects_path(out)}" fill="{fg}"/>', 32 + gap, h, pad)


# ── custom pixel wordmarks ────────────────────────────────────────────────────
BLOCK = {  # 2-px stems, x-height 8, i-dot sits three rows up
    "m": ["#########.", "##########"] + ["##..##..##"] * 6,
    "u": ["##..##"] * 6 + ["######", ".#####"],
    "n": ["#####.", "######"] + ["##..##"] * 6,
    "i": ["##"] * 8,
}
LINE = {  # 1-px stems, x-height 7, terminal-style i
    "m": ["######.", "#..#..#"] + ["#..#..#"] * 5,
    "u": ["#...#"] * 6 + [".####"],
    "n": ["####.", "#...#"] + ["#...#"] * 5,
    "i": ["##.", ".#.", ".#.", ".#.", ".#.", ".#.", "###"],
}


def wordmark_grid(font, word="munin", track=2, dot_gap=1, dot_h=None):
    xh = len(font["m"])
    dot_h = dot_h or (2 if font is BLOCK else 1)
    top = dot_h + dot_gap
    widths = [len(font[ch][0]) for ch in word]
    W = sum(widths) + track * (len(word) - 1)
    g = np.zeros((xh + top, W), bool)
    x = 0
    for ch, w in zip(word, widths):
        for r, row in enumerate(font[ch]):
            for c, v in enumerate(row):
                if v == "#":
                    g[top + r, x + c] = True
        if ch == "i":
            dx = x + (1 if font is LINE else 0)
            dw = 1 if font is LINE else 2
            g[0:dot_h, dx:dx + dw] = True
        x += w + track
    return g


def lockup(mark, word, gap=4, fg=FG, pad=1, align="chin", dots=False):
    """Mark and wordmark on one pixel grid."""
    mh, mw = mark.shape
    rows = np.nonzero(mark.any(axis=1))[0]
    m = mark[rows[0]:rows[-1] + 1]
    mh = m.shape[0]
    wh, ww = word.shape
    H = max(mh, wh)
    # baseline of the word sits on the raven's chin row (row 8 of P16 → index 5 after crop)
    base = 6 if align == "chin" else mh
    oy = max(0, base - wh)
    H = max(mh, oy + wh)
    out = np.zeros((H, mw + gap + ww), bool)
    out[:mh, :mw] = m
    out[oy:oy + wh, mw + gap:] = word
    h, w = out.shape
    if dots:
        return leds(out, fg, pad)
    return svg(f'<path d="{rects_path(out)}" fill="{fg}"/>', w, h, pad)


if __name__ == "__main__":
    from review import sheet
    items = [("P16", solid(P16)), ("P12", solid(P12)), ("P24", solid(P24)), ("bust", solid(BUST16)),
             ("outline", outline(P16)), ("outline 24", outline(P24, k=2)), ("badge", badge(P16)), ("leds", leds(P16, ghost="#222")),
             ("scan", scan(P16)), ("shaded", shaded()), ("dither", dither()), ("extrude", extrude()),
             ("glitch", glitch()), ("blink", solid(state("blink"))), ("caw", solid(state("caw"))), ("pair", pair())]
    print(sheet(items, "r2_variants", cols=4, cell=300))
    wb, wl = wordmark_grid(BLOCK), wordmark_grid(LINE)
    print(sheet([("block", solid(wb)), ("line", solid(wl)), ("lockup block", lockup(P16, wb)), ("lockup line", lockup(P16, wl)),
                 ("lockup dots", lockup(P16, wb, dots=True)), ("block dots", leds(wb))], "r2_words", cols=3, cell=400))
