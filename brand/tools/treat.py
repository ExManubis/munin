"""Round 3: LED / Scanline / Dither treatments of the pixel mark and Block wordmark, on one shared bitmap."""
import random
import numpy as np
from geo import rects_path
from pixvars import P16, tones16, wordmark_grid, BLOCK, BAYER

FG = "#f4f4f4"
GHOST = "#222222"
WB = wordmark_grid(BLOCK)


def word_tones(g):
    """Lit from above, like the raven: top rows bright, lower rows fall into shadow."""
    T = np.full(g.shape, -1)
    h = g.shape[0]
    for r in range(h):
        t = 0 if r < h - 4 else (1 if r < h - 2 else 2)
        T[r][g[r]] = t
    return T


def lockup_grid(gap=5):
    """Mark + wordmark as one bitmap with a matching tone map. Word baseline sits on the raven's chin row."""
    rows = np.nonzero(P16.any(axis=1))[0]
    m = P16[rows[0]:rows[-1] + 1]
    mt = tones16()[rows[0]:rows[-1] + 1]
    wh, ww = WB.shape
    base = 6
    oy = max(0, base - wh)
    mh, mw = m.shape
    H, W = max(mh, oy + wh), mw + gap + ww
    g = np.zeros((H, W), bool)
    T = np.full((H, W), -1)
    g[:mh, :mw] = m
    T[:mh, :mw] = mt
    g[oy:oy + wh, mw + gap:] = WB
    T[oy:oy + wh, mw + gap:] = word_tones(WB)
    return g, T


MARK = (P16, tones16())
WORD = (WB, word_tones(WB))
LOCKUP = lockup_grid()


def _box(g, pad):
    h, w = g.shape
    return f'viewBox="{-pad} {-pad} {w + 2 * pad} {h + 2 * pad}"'


def flat(gt, fg=FG, pad=1):
    g, _ = gt
    return f'<svg {_box(g, pad)} xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><path d="{rects_path(g)}" fill="{fg}"/></svg>'


def scan(gt, fg=FG, pad=1, t=0.6, anim=False):
    g, _ = gt
    h, w = g.shape
    parts = []
    for y in range(h):
        x = 0
        while x < w:
            if g[y, x]:
                x0 = x
                while x < w and g[y, x]:
                    x += 1
                st = f' style="--d:{y * 70 + x0 * 6}ms"' if anim else ""
                parts.append(f'<rect class="s" x="{x0}" y="{y + (1 - t) / 2:.2f}" width="{x - x0}" height="{t}"{st}/>')
            else:
                x += 1
    return f'<svg class="scan" {_box(g, pad)} xmlns="http://www.w3.org/2000/svg" fill="{fg}">{"".join(parts)}</svg>'


def dither(gt, fg=FG, pad=1, anim=False):
    """1-bit Bayer dither at 2×. Each sub-pixel is tagged with its threshold level so it can be revealed in order."""
    g, T = gt
    h, w = g.shape
    keep = {0: 4, 1: 3, 2: 2, 3: 1}
    if not anim:
        U = np.zeros((2 * h, 2 * w), bool)
        for r in range(h):
            for c in range(w):
                if T[r, c] >= 0:
                    for dy in range(2):
                        for dx in range(2):
                            U[2 * r + dy, 2 * c + dx] = BAYER[dy, dx] < keep[T[r, c]]
        return (f'<svg {_box(g, pad)} xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">'
                f'<g transform="scale(.5)"><path d="{rects_path(U)}" fill="{fg}"/></g></svg>')
    levels = [np.zeros((2 * h, 2 * w), bool) for _ in range(4)]
    for r in range(h):
        for c in range(w):
            if T[r, c] >= 0:
                for dy in range(2):
                    for dx in range(2):
                        b = BAYER[dy, dx]
                        if b < keep[T[r, c]]:
                            levels[b][2 * r + dy, 2 * c + dx] = True
    body = "".join(f'<path class="lv lv{i}" d="{rects_path(L)}"/>' for i, L in enumerate(levels))
    return (f'<svg class="dith" {_box(g, pad)} xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" fill="{fg}">'
            f'<g transform="scale(.5)">{body}</g></svg>')


def led(gt, fg=FG, ghost=GHOST, pad=1, r=0.4, anim=False, seed=7):
    g, _ = gt
    h, w = g.shape
    rnd = random.Random(seed)
    off, on = [], []
    for y in range(h):
        for x in range(w):
            if g[y, x]:
                st = f' style="--d:{(x + y) * 12 + rnd.randint(0, 120)}ms"' if anim else ""
                on.append(f'<circle class="o" cx="{x + .5}" cy="{y + .5}" r="{r}"{st}/>')
            elif ghost:
                off.append(f'<circle cx="{x + .5}" cy="{y + .5}" r="{r * .5:.2f}"/>')
    return (f'<svg class="led" {_box(g, pad)} xmlns="http://www.w3.org/2000/svg">'
            f'<g fill="{ghost}">{"".join(off)}</g><g fill="{fg}">{"".join(on)}</g></svg>')


def halfblocks(g):
    """Terminal art: two pixel rows per character cell using ▀ ▄ █."""
    h, w = g.shape
    if h % 2:
        g = np.vstack([g, np.zeros((1, w), bool)])
    lines = []
    for r in range(0, g.shape[0], 2):
        s = ""
        for c in range(w):
            a, b = g[r, c], g[r + 1, c]
            s += "█" if a and b else ("▀" if a else ("▄" if b else " "))
        lines.append(s.rstrip())
    return "\n".join(lines)


if __name__ == "__main__":
    from review import sheet
    print(sheet([("flat", flat(LOCKUP)), ("scan", scan(LOCKUP)), ("dither", dither(LOCKUP)), ("led", led(LOCKUP)),
                 ("dither mark", dither(MARK)), ("dither word", dither(WORD))], "r3_treat", cols=2, cell=560))
    print(halfblocks(LOCKUP[0]))
