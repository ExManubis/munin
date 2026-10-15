"""Final munin raven marks. Every function returns a standalone, transparent-background SVG string."""
import itertools
import numpy as np
from geo import rects_path
from raven import HEAD
from facet import V, FACETS
from tones import tone_at, EYE_C

_ids = itertools.count(1)
VIEW = (6, 22, 102, 86)          # wide crop around the head
SQUARE = (6, 7, 102, 103)        # square crop, same centre

DARK = dict(fg="#f4f4f4", tones=["#f4f4f4", "#c4c4c4", "#8e8e8e", "#5c5c5c", "#363636"])
LIGHT = dict(fg="#0a0a0a", tones=["#8c8c8c", "#6a6a6a", "#4a4a4a", "#2b2b2b", "#0a0a0a"])


def _vb(v):
    return f"{v[0]:g} {v[1]:g} {v[2]-v[0]:g} {v[3]-v[1]:g}"


def _svg(body, view, extra=""):
    return f'<svg viewBox="{_vb(view)}" xmlns="http://www.w3.org/2000/svg"{extra}>{body}</svg>'


# ── 01 CONTOUR ── nested offsets of the head: memory as rings ──────────────────
def contour(theme=DARK, view=VIEW, line=0.9, gap=1.5, rings=12):
    i = next(_ids)
    edges, x = [], 0.0
    for _ in range(rings):
        x += line
        edges.append((x, "#fff"))
        x += gap
        edges.append((x, "#000"))
    strokes = "".join(
        f'<path d="{HEAD}" fill="none" stroke="{c}" stroke-width="{2*w:.2f}" stroke-linejoin="round"/>'
        for w, c in reversed(edges))
    ex, ey = 47.5, 38.5
    mask = (f'<mask id="m{i}" maskUnits="userSpaceOnUse" x="0" y="0" width="110" height="110">'
            f'<path d="{HEAD}" fill="#fff"/>{strokes}'
            f'<circle cx="{ex}" cy="{ey}" r="{gap+line+1.3:.2f}" fill="#000"/>'
            f'<circle cx="{ex}" cy="{ey}" r="1.7" fill="#fff"/></mask>'
            f'<clipPath id="c{i}"><path d="{HEAD}"/></clipPath>')
    body = (f'<defs>{mask}</defs><g clip-path="url(#c{i})">'
            f'<rect x="0" y="0" width="110" height="110" fill="{theme["fg"]}" mask="url(#m{i})"/></g>')
    return _svg(body, view)


# ── 02 FACET ── flat planes toned like the Figment cube ────────────────────────
FACET_OUTLINE = "P0 P1 P2 P3 P4 P5 T1 J1 T2 J2 T3 J3 T4 P15 P16 P17 P18 P19".split()


def _pts(keys):
    return " ".join(f"{V[k][0]:g},{V[k][1]:g}" for k in keys)


def facet(theme=DARK, view=VIEW, mono=False, seam=0.55):
    i = next(_ids)
    ex, ey = EYE_C
    s = 2.9
    eye = f'<polygon points="{ex},{ey-s} {ex+s},{ey} {ex},{ey+s} {ex-s},{ey}" fill="#000"/>'
    if mono:
        # one colour: planes become solid, separated by hairline seams
        seams = "".join(f'<polygon points="{_pts(k.split())}" fill="none" stroke="#000" stroke-width="{seam}" stroke-linejoin="round"/>'
                        for k, _ in FACETS)
        mask = (f'<mask id="m{i}" maskUnits="userSpaceOnUse" x="0" y="0" width="110" height="110">'
                f'<polygon points="{_pts(FACET_OUTLINE)}" fill="#fff"/>{seams}{eye}</mask>')
        return _svg(f'<defs>{mask}</defs><rect width="110" height="110" fill="{theme["fg"]}" mask="url(#m{i})"/>', view)
    planes = "".join(
        f'<polygon points="{_pts(k.split())}" fill="{theme["tones"][t]}" stroke="{theme["tones"][t]}" stroke-width=".3" stroke-linejoin="round"/>'
        for k, t in FACETS)
    mask = (f'<mask id="m{i}" maskUnits="userSpaceOnUse" x="0" y="0" width="110" height="110">'
            f'<rect width="110" height="110" fill="#fff"/>{eye}</mask>')
    return _svg(f'<defs>{mask}</defs><g mask="url(#m{i})">{planes}</g>', view)


# ── 03 HALFTONE ── the facet planes resampled as a dot matrix ──────────────────
def halftone(theme=DARK, view=VIEW, cell=2.2, mono=False, animate=False):
    ex, ey = EYE_C
    x0 = ex - np.floor((ex - view[0]) / cell) * cell
    y0 = ey - np.floor((ey - view[1]) / cell) * cell
    xs, ys = np.arange(x0, view[2], cell), np.arange(y0, view[3], cell)
    X, Y = np.meshgrid(xs, ys)
    T = tone_at(X, Y)
    acc = np.zeros(X.shape)
    for dx in (-1 / 3, 0, 1 / 3):
        for dy in (-1 / 3, 0, 1 / 3):
            acc += tone_at(X + dx * cell, Y + dy * cell) >= 0
    cov = acc / 9
    E = np.hypot(X - ex, Y - ey)
    rmax = cell * 0.42
    dots = []
    for j in range(X.shape[0]):
        for k in range(X.shape[1]):
            t = T[j, k]
            if t < 0 and cov[j, k] < 0.34:
                continue
            t = 2 if t < 0 else t
            x, y = X[j, k], Y[j, k]
            delay = f' style="animation-delay:{(x - view[0]) * 9 + (y - view[1]) * 4:.0f}ms"' if animate else ""
            if E[j, k] < 0.01:  # the eye: one bright glint inside a dark socket
                dots.append(f'<circle class="glint" cx="{x:.2f}" cy="{y:.2f}" r="{rmax:.2f}" fill="{theme["fg"]}"/>')
                continue
            if E[j, k] < cell * 1.05:
                continue
            c = min(cov[j, k] * 1.15, 1)
            if mono:
                r = rmax * [1.0, 0.82, 0.64, 0.47, 0.33][t] * (0.55 + 0.45 * c)
                dots.append(f'<circle{delay} cx="{x:.2f}" cy="{y:.2f}" r="{r:.2f}" fill="{theme["fg"]}"/>')
            else:
                r = rmax * (0.6 + 0.4 * c)
                dots.append(f'<circle{delay} cx="{x:.2f}" cy="{y:.2f}" r="{r:.2f}" fill="{theme["tones"][t]}"/>')
    return _svg("".join(dots), view, ' class="ht"' if animate else "")


# ── 04 PIXEL ── 16×16 bitmap in the same 1-unit-rect idiom as the site icons ───
PIXEL16 = """
................
................
................
..#######.......
.#####.#####....
.#############..
###############.
#########.....##
#############...
.#######........
.######.#.......
..####.#........
...##.#.........
....#...........
................
................
"""


def pixel_grid():
    return [[c == "#" for c in r] for r in PIXEL16.strip("\n").split("\n")]


def pixel(theme=DARK, pad=0):
    g = pixel_grid()
    return (f'<svg viewBox="{-pad} {-pad} {16+2*pad} {16+2*pad}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">'
            f'<path d="{rects_path(g)}" fill="{theme["fg"]}"/></svg>')


# ── terminal splash: facet tones as block elements ─────────────────────────────
def block_text(cols=46, rows=16, view=(9, 26, 99, 84)):
    cw = (view[2] - view[0]) / cols
    ch = (view[3] - view[1]) / rows
    xs = view[0] + (np.arange(cols) + 0.5) * cw
    ys = view[1] + (np.arange(rows) + 0.5) * ch
    X, Y = np.meshgrid(xs, ys)
    T = tone_at(X, Y)
    ex, ey = EYE_C
    eye = (np.abs(X - ex) / cw < 0.75) & (np.abs(Y - ey) / ch < 0.6)
    glyph = {0: "█", 1: "█", 2: "▓", 3: "▒", 4: "░"}
    lines = []
    for j in range(rows):
        s = ""
        for k in range(cols):
            t = T[j, k]
            s += " " if (t < 0 or eye[j, k]) else (f'<i>{glyph[t]}</i>' if t == 4 else glyph[t])
        lines.append(s.rstrip())
    return "\n".join(lines)
