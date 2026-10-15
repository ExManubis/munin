"""Tiny geometry helpers: parse absolute SVG paths (M L C Q Z), flatten, rasterize."""
import re
import numpy as np

TOK = re.compile(r"[MLCQZHV]|-?\d*\.?\d+(?:e-?\d+)?", re.I)


def parse(d, steps=24):
    """Return list of closed polygons (np arrays Nx2) from an absolute SVG path."""
    toks = TOK.findall(d)
    i, polys, cur, pt, start, cmd = 0, [], [], None, None, None

    def num():
        nonlocal i
        v = float(toks[i]); i += 1
        return v

    while i < len(toks):
        t = toks[i]
        if re.match(r"[A-Za-z]", t):
            cmd = t; i += 1
        if cmd == "M":
            if cur:
                polys.append(np.array(cur))
            pt = (num(), num()); start = pt; cur = [pt]; cmd = "L"
        elif cmd == "L":
            pt = (num(), num()); cur.append(pt)
        elif cmd == "H":
            pt = (num(), pt[1]); cur.append(pt)
        elif cmd == "V":
            pt = (pt[0], num()); cur.append(pt)
        elif cmd == "C":
            c1 = (num(), num()); c2 = (num(), num()); p = (num(), num())
            for s in np.linspace(0, 1, steps)[1:]:
                u = 1 - s
                cur.append((u**3*pt[0] + 3*u*u*s*c1[0] + 3*u*s*s*c2[0] + s**3*p[0],
                            u**3*pt[1] + 3*u*u*s*c1[1] + 3*u*s*s*c2[1] + s**3*p[1]))
            pt = p
        elif cmd == "Q":
            c1 = (num(), num()); p = (num(), num())
            for s in np.linspace(0, 1, steps)[1:]:
                u = 1 - s
                cur.append((u*u*pt[0] + 2*u*s*c1[0] + s*s*p[0], u*u*pt[1] + 2*u*s*c1[1] + s*s*p[1]))
            pt = p
        elif cmd in "Zz":
            if cur:
                polys.append(np.array(cur)); cur = []
            pt = start; cmd = None
        else:
            raise ValueError(f"bad token {t!r} at {i}")
    if cur:
        polys.append(np.array(cur))
    return polys


def inside(polys, x, y):
    """Even-odd point-in-polygon for arrays x, y (same shape)."""
    res = np.zeros(x.shape, bool)
    for P in polys:
        xs, ys = P[:, 0], P[:, 1]
        xe, ye = np.roll(xs, -1), np.roll(ys, -1)
        for x0, y0, x1, y1 in zip(xs, ys, xe, ye):
            if y0 == y1:
                continue
            cond = (y0 > y) != (y1 > y)
            xint = x0 + (y - y0) * (x1 - x0) / (y1 - y0)
            res ^= cond & (x < xint)
    return res


def coverage(polys, n, box=(0, 0, 100, 100), ss=6):
    """Fraction of each of n x n cells covered by polys (supersampled)."""
    x0, y0, x1, y1 = box
    cw, ch = (x1 - x0) / n, (y1 - y0) / n
    o = (np.arange(ss) + 0.5) / ss
    gx = x0 + (np.arange(n)[:, None] + o[None, :]).ravel() * cw
    gy = y0 + (np.arange(n)[:, None] + o[None, :]).ravel() * ch
    X, Y = np.meshgrid(gx, gy)
    m = inside(polys, X, Y).astype(float)
    return m.reshape(n, ss, n, ss).mean(axis=(1, 3))


def rects_path(grid, ox=0, oy=0, s=1):
    """Merge horizontal runs of truthy cells into an SVG path of rects (like the site's pixel icons)."""
    out = []
    for r, row in enumerate(grid):
        c = 0
        while c < len(row):
            if row[c]:
                c0 = c
                while c < len(row) and row[c]:
                    c += 1
                w = c - c0
                out.append(f"M{ox+c0*s:g} {oy+r*s:g}h{w*s:g}v{s:g}h{-w*s:g}z")
            else:
                c += 1
    return "".join(out)


def grid_from_str(s):
    rows = [r for r in s.strip("\n").split("\n")]
    return [[ch for ch in r] for r in rows]
