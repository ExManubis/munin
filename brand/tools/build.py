"""Export munin logo SVGs and build the mockup sheet."""
import os
import subprocess
from marks import contour, facet, halftone, pixel, block_text, DARK, LIGHT, VIEW, SQUARE

OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO = os.path.join(OUT, "logo")
HERE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(LOGO, exist_ok=True)

HT_DARK = dict(DARK, tones=["#f6f6f6", "#dadada", "#adadad", "#808080", "#585858"])

# ── export ────────────────────────────────────────────────────────────────────
exports = {
    "munin-contour": (lambda t: contour(t), True),
    "munin-contour-square": (lambda t: contour(t, view=SQUARE), True),
    "munin-facet": (lambda t: facet(t), True),
    "munin-facet-1colour": (lambda t: facet(t, mono=True), True),
    "munin-halftone": (lambda t: halftone(HT_DARK if t is DARK else t), True),
    "munin-halftone-1colour": (lambda t: halftone(t, mono=True), True),
    "munin-pixel-16": (lambda t: pixel(t), True),
}
for name, (fn, _) in exports.items():
    for tag, theme in (("on-dark", DARK), ("on-light", LIGHT)):
        with open(os.path.join(LOGO, f"{name}-{tag}.svg"), "w") as f:
            f.write(fn(theme))

# ── page ──────────────────────────────────────────────────────────────────────
CONCEPTS = [
    dict(n="01", key="contour", name="Contour", kind="1-COLOUR · VECTOR",
         big=contour(), light=contour(LIGHT), mono=contour(),
         small=lambda: contour(view=SQUARE),
         text="The head drawn as nested offsets, like growth rings or the groove of a record. "
              "Memory as layers laid down over time. The throat hackles turn into a run of chevrons."),
    dict(n="02", key="facet", name="Facet", kind="GREYSCALE · 1-COLOUR FALLBACK",
         big=facet(), light=facet(LIGHT), mono=facet(mono=True),
         small=lambda: facet(view=SQUARE),
         text="Cut into flat planes lit from above, using the same three-face shading as the Figment cube. "
              "The 1-colour fallback keeps the planes as hairline seams."),
    dict(n="03", key="halftone", name="Halftone", kind="DOT MATRIX · MOTION-READY",
         big=halftone(HT_DARK, animate=True), light=halftone(LIGHT), mono=halftone(mono=True),
         small=lambda: halftone(HT_DARK, view=SQUARE, cell=3.2),
         text="The facet planes resampled onto the site's dot grid. The eye is a single lit dot in a dark socket, "
              "so it can blink or pulse as a loading state."),
    dict(n="04", key="pixel", name="Pixel", kind="16 × 16 BITMAP",
         big=pixel(pad=3), light=pixel(LIGHT, pad=2), mono=pixel(pad=2),
         small=lambda: pixel(pad=1),
         text="Hand-placed on a 16 px grid, drawn the same way as the site's icons (one path of 1-unit rects). "
              "The checkered throat stands in for the hackles. Built for favicons and the terminal."),
]


def concept_card(c):
    sizes = "".join(f'<div class="sz" style="width:{s}px;height:{s}px">{c["small"]()}</div>' for s in (64, 32, 16))
    return f"""
    <article class="card" id="{c['key']}">
      <header><span class="n">{c['n']}</span><span class="t">{c['name'].upper()}</span><span class="k">{c['kind']}</span></header>
      <div class="stage vf">{c['big']}</div>
      <p>{c['text']}</p>
      <footer>
        <div class="tile light">{c['light']}<span>LIGHT</span></div>
        <div class="tile">{c['mono']}<span>1-COLOUR</span></div>
        <div class="tile sizes">{sizes}<span>64 · 32 · 16</span></div>
      </footer>
    </article>"""


def size_row(c):
    cells = "".join(f'<td><div style="width:{s}px;height:{s}px;margin:auto">{c["small"]()}</div></td>' for s in (128, 64, 32, 24, 16))
    return f'<tr><th>{c["n"]} {c["name"].upper()}</th>{cells}</tr>'


hero = halftone(HT_DARK, cell=1.9, animate=True, view=(4, 20, 104, 88))
pix_icon = pixel()
term = block_text()

html = open(os.path.join(HERE, "page.html")).read()
html = (html.replace("{{HERO}}", hero)
            .replace("{{PIX}}", pix_icon)
            .replace("{{CARDS}}", "".join(concept_card(c) for c in CONCEPTS))
            .replace("{{SIZES}}", "".join(size_row(c) for c in CONCEPTS))
            .replace("{{TERM}}", term)
            .replace("{{ICON_CONTOUR}}", contour(view=(-2, 6, 110, 106)))
            .replace("{{ICON_FACET}}", facet(view=(-2, 6, 110, 106)))
            .replace("{{ICON_HALFTONE}}", halftone(HT_DARK, view=(-2, 6, 110, 106), cell=2.6))
            .replace("{{FACET}}", facet())
            .replace("{{FACET_LIGHT}}", facet(LIGHT))
            .replace("{{CONTOUR}}", contour())
            .replace("{{CONTOUR_LIGHT}}", contour(LIGHT))
            .replace("{{HALFTONE_CARD}}", halftone(HT_DARK, cell=2.0, view=(0, 16, 108, 92))))
page = os.path.join(OUT, "mockups.html")
with open(page, "w") as f:
    f.write(html)
print(page)
