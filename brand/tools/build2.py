"""Round 2: pixel logo variants + wordmark fonts."""
import os
from pixvars import (P16, P12, P24, solid, outline, badge, leds, scan, shaded, dither, extrude, state, pair,
                     wordmark_grid, lockup, BLOCK, LINE, rects_path)

OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PX = os.path.join(OUT, "logo", "pixel")
WM = os.path.join(OUT, "logo", "wordmark")
HERE = os.path.dirname(os.path.abspath(__file__))
for d in (PX, WM):
    os.makedirs(d, exist_ok=True)

INK = "#0a0a0a"
WB, WL = wordmark_grid(BLOCK), wordmark_grid(LINE)

VARIANTS = [
    ("01", "Base 16", "The 16 × 16 from round 1. Favicon, menu bar, inline UI.", lambda f="#f4f4f4": solid(P16, f), "p16"),
    ("02", "Micro 12", "Redrawn for 12 px, so it doesn't turn to mush in tight UI.", lambda f="#f4f4f4": solid(P12, f), "p12"),
    ("03", "Detail 24", "More room for the hooked bill and a longer run of hackles.", lambda f="#f4f4f4": solid(P24, f), "p24"),
    ("04", "Outline", "1-unit line at 2× resolution. Lighter, more technical.", lambda f="#f4f4f4": outline(P16, f), "outline"),
    ("05", "Outline 24", "The 24 px drawing as a line, for large display use.", lambda f="#f4f4f4": outline(P24, f), "outline-24"),
    ("06", "Badge", "Knocked out of a tile with stepped pixel corners. Avatars, app icons, stickers.", lambda f="#f4f4f4": badge(P16, f), "badge"),
    ("07", "LED", "Pixels as dots on a dim matrix, matching the Bitcount and Doto type.", lambda f="#f4f4f4": leds(P16, f, ghost="#262626" if f != INK else "#d8d8d8"), "led"),
    ("08", "Scanline", "Each row as a thin bar, like an old CRT. Works well animated.", lambda f="#f4f4f4": scan(P16, f), "scanline"),
    ("09", "Shaded", "Lit from above in the cube's tones: white top, grey side, dark throat.", lambda f="#f4f4f4": shaded() if f != INK else shaded(("#9a9a9a", "#6a6a6a", "#3a3a3a", "#0a0a0a")), "shaded"),
    ("10", "Dither", "The same shading in 1-bit, using a Bayer dither at 2×.", lambda f="#f4f4f4": dither(f), "dither"),
    ("11", "Extruded", "Pixels pushed into 3D, the same move as the Figment cube.", lambda f="#f4f4f4": extrude() if f != INK else extrude(face=INK, sides=("#8a8a8a", "#a8a8a8", "#c4c4c4", "#d8d8d8")), "extruded"),
    ("12", "Pair", "Huginn and Muninn back to back. For an org mark or a sibling project.", lambda f="#f4f4f4": pair(fg=f), "pair"),
]


def card(n, name, text, fn, key):
    return f"""
    <article class="v">
      <header><span class="n">{n}</span>{name.upper()}</header>
      <div class="stage">{fn()}</div>
      <div class="row"><div class="lt">{fn(INK)}</div><div class="sm"><div style="width:32px;height:32px">{fn()}</div><div style="width:16px;height:16px">{fn()}</div></div></div>
      <p>{text}</p>
    </article>"""


def states_card():
    idle, blink, caw = solid(P16), solid(state("blink")), solid(state("caw"))
    return f"""
    <article class="v">
      <header><span class="n">13</span>STATES</header>
      <div class="stage live"><div class="f idle">{idle}</div><div class="f blink">{blink}</div></div>
      <div class="row frames"><div>{idle}<span>IDLE</span></div><div>{blink}<span>BLINK</span></div><div>{caw}<span>CAW</span></div></div>
      <p>Expression frames on the same grid: blink for idle or loading, caw for errors and notifications.</p>
    </article>"""


def vf_card():
    return f"""
    <article class="v">
      <header><span class="n">14</span>VIEWFINDER</header>
      <div class="stage"><div class="vfx"><div>{solid(P16)}</div></div></div>
      <div class="row"><div class="lt"><div class="vfx ink"><div>{solid(P16, INK)}</div></div></div><div class="sm"><div class="vfx tiny"><div>{solid(P16)}</div></div></div></div>
      <p>Inside the Figment corner brackets, so it reads as a sibling of the Figment Engineering mark.</p>
    </article>"""


# ── wordmark specimens ────────────────────────────────────────────────────────
FONTS = [
    # name, css family, size(px), extra css, tag
    ("Departure Mono", "'DM'", 46, "", "PIXEL MONO · R01"),
    ("Geist Pixel", "'Geist Pixel'", 52, "", "PIXEL SANS"),
    ("Silkscreen", "'Silkscreen'", 44, "", "PIXEL · 8 PX GRID"),
    ("Pixelify Sans", "'Pixelify Sans'", 52, "font-weight:500", "PIXEL SANS"),
    ("Tiny5", "'Tiny5'", 54, "", "PIXEL · 5 PX"),
    ("Micro 5", "'Micro 5'", 76, "", "PIXEL · CONDENSED"),
    ("Jersey 10", "'Jersey 10'", 72, "", "PIXEL · HEAVY"),
    ("Jersey 15 Charted", "'Jersey 15 Charted'", 64, "", "PIXEL · GRID FILL"),
    ("Sixtyfour", "'Sixtyfour'", 34, "", "PIXEL · WIDE CRT"),
    ("Workbench", "'Workbench'", 50, "", "PIXEL · SCANLINE"),
    ("Press Start 2P", "'Press Start 2P'", 32, "", "8-BIT"),
    ("VT323", "'VT323'", 70, "", "TERMINAL"),
    ("Handjet", "'Handjet'", 70, "font-weight:500", "ELEMENT GRID"),
    ("Bitcount Prop Single", "'Bitcount Prop Single'", 60, "", "DOT MATRIX · R01"),
    ("Bitcount Grid Double", "'Bitcount Grid Double'", 52, "", "DOT MATRIX · DOUBLE"),
    ("Doto", "'Doto'", 58, "font-weight:900", "DOT MATRIX"),
    ("DotGothic16", "'DotGothic16'", 50, "", "DOT GOTHIC"),
    ("Geist Mono", "'Geist Mono'", 50, "font-weight:500", "CLEAN MONO"),
    ("JetBrains Mono", "'JetBrains Mono'", 50, "font-weight:500", "CLEAN MONO"),
    ("Martian Mono", "'Martian Mono'", 40, "font-weight:500", "WIDE MONO"),
    ("Space Grotesk", "'Space Grotesk'", 56, "font-weight:500", "GROTESK"),
    ("Major Mono Display", "'Major Mono Display'", 46, "", "DISPLAY MONO"),
    ("Unbounded", "'Unbounded'", 42, "font-weight:500", "WIDE DISPLAY"),
]
GF = ["Geist+Pixel", "Silkscreen", "Pixelify+Sans:wght@500", "Tiny5", "Micro+5", "Jersey+10", "Jersey+15+Charted", "Sixtyfour",
      "Workbench", "Press+Start+2P", "VT323", "Handjet:wght@500", "Bitcount+Prop+Single", "Bitcount+Grid+Double", "Doto:wght@900",
      "DotGothic16", "Geist+Mono:wght@500", "JetBrains+Mono:wght@500", "Martian+Mono:wght@500", "Space+Grotesk:wght@500",
      "Major+Mono+Display", "Unbounded:wght@500"]
GF_URL = "https://fonts.googleapis.com/css2?" + "&".join("family=" + f for f in GF) + "&display=swap"


def spec(i, name, fam, size, extra, tag):
    mark = solid(P16, pad=0)
    return f"""
    <div class="spec">
      <div class="lk"><span class="m">{mark}</span><span class="w" style="font-family:{fam};font-size:{size}px;{extra}">munin</span></div>
      <div class="meta"><span>{i:02d} {name.upper()}</span><span>{tag}</span></div>
    </div>"""


def custom_words():
    items = [
        ("A", "Block", "2 px stems, the same weight as the raven. Everything sits on one grid.", lockup(P16, WB), solid(WB), lockup(P16, WB, fg=INK)),
        ("B", "Line", "1 px stems with a terminal-style i. Lighter, closer to Departure Mono.", lockup(P16, WL), solid(WL), lockup(P16, WL, fg=INK)),
        ("C", "Dots", "Block drawn as LEDs, so it matches the halftone and dot-matrix pieces.", lockup(P16, WB, dots=True), leds(WB), lockup(P16, WB, dots=True, fg=INK)),
    ]
    out = []
    for k, name, text, lk, word, lk_ink in items:
        out.append(f"""
    <article class="cw">
      <header><span class="n">{k}</span>CUSTOM · {name.upper()}</header>
      <div class="big">{lk}</div>
      <div class="pair2"><div class="lt">{lk_ink}</div><div class="wd">{word}</div></div>
      <p>{text}</p>
    </article>""")
    return "".join(out)


SHORTLIST = [
    ("Custom Block", lockup(P16, WB), lockup(P16, WB, fg=INK), None),
    ("Geist Pixel", None, None, ("'Geist Pixel'", 64, "")),
    ("Doto + LED", None, None, ("'Doto'", 70, "font-weight:900")),
]


def shortlist():
    out = []
    for name, dark, light, font in SHORTLIST:
        if font:
            fam, size, extra = font
            m = leds(P16, pad=0) if "LED" in name else solid(P16, pad=0)
            mi = leds(P16, INK, pad=0) if "LED" in name else solid(P16, INK, pad=0)
            dark = f'<div class="lk xl"><span class="m">{m}</span><span class="w" style="font-family:{fam};font-size:{size}px;{extra}">munin</span></div>'
            light = f'<div class="lk xl"><span class="m">{mi}</span><span class="w" style="font-family:{fam};font-size:{size}px;{extra}">munin</span></div>'
        else:
            dark, light = f'<div class="svgw">{dark}</div>', f'<div class="svgw">{light}</div>'
        out.append(f'<div class="sl"><div class="d">{dark}</div><div class="l">{light}</div><span class="label">{name.upper()}</span></div>')
    return "".join(out)


# ── exports ───────────────────────────────────────────────────────────────────
for n, name, _, fn, key in VARIANTS:
    open(os.path.join(PX, f"munin-pixel-{key}-on-dark.svg"), "w").write(fn())
    open(os.path.join(PX, f"munin-pixel-{key}-on-light.svg"), "w").write(fn(INK))
for kind in ("blink", "caw"):
    open(os.path.join(PX, f"munin-pixel-{kind}-on-dark.svg"), "w").write(solid(state(kind)))
for key, g in (("block", WB), ("line", WL)):
    open(os.path.join(WM, f"munin-wordmark-{key}-on-dark.svg"), "w").write(solid(g))
    open(os.path.join(WM, f"munin-wordmark-{key}-on-light.svg"), "w").write(solid(g, INK))
    open(os.path.join(WM, f"munin-lockup-{key}-on-dark.svg"), "w").write(lockup(P16, g))
    open(os.path.join(WM, f"munin-lockup-{key}-on-light.svg"), "w").write(lockup(P16, g, fg=INK))
open(os.path.join(WM, "munin-lockup-dots-on-dark.svg"), "w").write(lockup(P16, WB, dots=True))

html = open(os.path.join(HERE, "page2.html")).read()
html = (html.replace("{{GF}}", GF_URL)
            .replace("{{PIX}}", solid(P16, pad=0))
            .replace("{{HERO}}", extrude())
            .replace("{{HERO_WORD}}", lockup(P16, WB))
            .replace("{{VARIANTS}}", "".join(card(*v) for v in VARIANTS) + states_card() + vf_card())
            .replace("{{CUSTOM}}", custom_words())
            .replace("{{SPECS}}", "".join(spec(i + 1, *f) for i, f in enumerate(FONTS)))
            .replace("{{SHORTLIST}}", shortlist()))
page = os.path.join(OUT, "pixel-r02.html")
open(page, "w").write(html)
print(page)
