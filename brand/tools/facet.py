"""Concept: faceted raven, planes toned like the Figment cube's faces."""
V = dict(
    # silhouette
    P0=(58, 33.5), P1=(78, 36.8), P2=(91, 43.5), P3=(97.5, 53), P4=(93, 51.8), P5=(60.5, 56),
    T1=(57.5, 68), J1=(53, 63.5), T2=(50.5, 74.5), J2=(46, 68), T3=(42.5, 79.5), J3=(38.5, 72), T4=(32, 82),
    P15=(13, 71), P16=(11, 53), P17=(16, 39.5), P18=(27, 31.5), P19=(42, 29),
    # interior
    B0=(59.5, 41), G0=(56, 47.2), GE=(93.4, 51.6), M1=(77, 44.2),
    EA=(52.5, 36.5), K=(36, 47.5), Q=(49, 57), N=(24, 59),
)

# tone index: 0 white .. 4 darkest
TONES = ["#f4f4f4", "#c9c9c9", "#959595", "#626262", "#3a3a3a"]

FACETS = [
    # bill
    ("P0 P1 P2 P3 M1 B0", 0),      # culmen plane
    ("B0 M1 P3 GE G0", 1),         # side of upper mandible
    ("G0 GE P4 P5", 3),            # lower mandible
    # head
    ("P18 P19 P0 EA", 0),          # crown
    ("P0 B0 G0 EA", 1),            # lores / bristles
    ("P17 P18 EA K", 1),           # back of head
    ("EA G0 K", 2),                # cheek
    ("K G0 P5 Q", 2),              # chin
    ("P17 K N P16", 2),            # nape
    ("K Q N", 3),                  # side of neck
    ("P16 N P15", 4),              # back of neck
    # hackles fan out from the throat
    ("Q P5 T1 J1", 3),
    ("Q J1 T2 J2", 2),
    ("Q J2 T3 J3 N", 4),
    ("N J3 T4 P15", 3),
]


def facet_svg(eye="diamond", tones=TONES, gap=0.0, bg="#0a0a0a", view=(6, 22, 102, 86), labels=False):
    out = []
    for keys, t in FACETS:
        pts = " ".join(f"{V[k][0]:g},{V[k][1]:g}" for k in keys.split())
        stroke = f' stroke="{bg}" stroke-width="{gap}" stroke-linejoin="round"' if gap else f' stroke="{tones[t]}" stroke-width="0.25" stroke-linejoin="round"'
        out.append(f'<polygon points="{pts}" fill="{tones[t]}"{stroke}/>')
    ex, ey = 47.2, 38.6
    if eye == "diamond":
        s = 2.9
        out.append(f'<polygon points="{ex},{ey-s} {ex+s},{ey} {ex},{ey+s} {ex-s},{ey}" fill="{bg}"/>')
    elif eye == "square":
        s = 2.3
        out.append(f'<rect x="{ex-s}" y="{ey-s}" width="{2*s}" height="{2*s}" fill="{bg}"/>')
    if labels:
        for k, (x, y) in V.items():
            out.append(f'<text x="{x}" y="{y}" font-size="1.8" fill="red">{k}</text>')
    vb = f"{view[0]} {view[1]} {view[2]-view[0]} {view[3]-view[1]}"
    return f'<svg viewBox="{vb}" xmlns="http://www.w3.org/2000/svg">{"".join(out)}</svg>'


if __name__ == "__main__":
    from review import sheet
    print(sheet([("facet", facet_svg()), ("labels", facet_svg(labels=True)),
                 ("gap", facet_svg(gap=0.7)), ("square eye", facet_svg(eye="square"))], "facet", cols=2, cell=560))
