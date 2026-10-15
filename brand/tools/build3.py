"""Round 3: LED / Scanline / Dither treatments, motion, and the Munin Block font."""
import os
from treat import MARK, WORD, LOCKUP, flat, scan, dither, led, halfblocks
from blockfont import GLYPHS

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
TR = os.path.join(OUT, "logo", "treatments")
os.makedirs(TR, exist_ok=True)
INK = "#0a0a0a"

# ── static exports ────────────────────────────────────────────────────────────
for part, gt in (("mark", MARK), ("wordmark", WORD), ("lockup", LOCKUP)):
    for kind, fn in (("led", led), ("scanline", scan), ("dither", dither)):
        open(os.path.join(TR, f"munin-{part}-{kind}-on-dark.svg"), "w").write(fn(gt))
        kw = {"ghost": "#dcdcdc"} if kind == "led" else {}
        open(os.path.join(TR, f"munin-{part}-{kind}-on-light.svg"), "w").write(fn(gt, fg=INK, **kw))


def column(key, name, fn, text, light_kw=None):
    light_kw = light_kw or {}
    return f"""
    <article class="tc" id="{key}">
      <header><span class="n">{name[0]}</span>{name[1]}</header>
      <div class="big">{fn(MARK)}</div>
      <div class="wm">{fn(WORD)}</div>
      <div class="lt">{fn(LOCKUP, fg=INK, **light_kw)}</div>
      <div class="fav"><div style="width:64px;height:64px">{fn(MARK)}</div><div style="width:32px;height:32px">{fn(MARK)}</div><div style="width:16px;height:16px">{fn(MARK)}</div></div>
      <p>{text}</p>
    </article>"""


COLS = "".join([
    column("led", ("07", "LED"), led, "Dots on a dim matrix. The softest of the three, and it suits a glow, a pulse or a light-up sequence.", {"ghost": "#dcdcdc"}),
    column("scanline", ("08", "SCANLINE"), scan, "Every pixel row as a thin bar. It can draw itself in row by row, which makes a good save or write state."),
    column("dither", ("10", "DITHER"), dither, "Shaded from above with a 1-bit Bayer dither. On the wordmark the dither fades out toward the baseline, like a memory going soft."),
])

glyph_cells = "".join(f'<div class="gc"><span class="g">{(c if c not in "<>&" else {"<": "&lt;", ">": "&gt;", "&": "&amp;"}[c])}</span><span class="u">U+{ord(c):04X}</span></div>'
                      for c in GLYPHS)

html = open(os.path.join(HERE, "page3.html")).read()
html = (html.replace("{{PIX}}", flat(MARK, pad=0))
            .replace("{{L_SCAN}}", scan(LOCKUP, anim=True))
            .replace("{{L_DITH}}", dither(LOCKUP, anim=True))
            .replace("{{L_LED}}", led(LOCKUP, anim=True))
            .replace("{{S_SCAN}}", scan(LOCKUP))
            .replace("{{S_DITH}}", dither(LOCKUP))
            .replace("{{S_LED}}", led(LOCKUP))
            .replace("{{COLS}}", COLS)
            .replace("{{M_LED}}", led(MARK, anim=True))
            .replace("{{M_SCAN}}", scan(MARK, anim=True))
            .replace("{{M_DITH}}", dither(MARK, anim=True))
            .replace("{{TERM}}", halfblocks(LOCKUP[0]))
            .replace("{{LOCK_DITH}}", dither(LOCKUP))
            .replace("{{MARK_DITH}}", dither(MARK))
            .replace("{{LOCK_FLAT}}", flat(LOCKUP))
            .replace("{{LOCK_LED}}", led(LOCKUP))
            .replace("{{GLYPHS}}", glyph_cells)
            .replace("{{NGLYPHS}}", str(len(GLYPHS))))
page = os.path.join(OUT, "pixel-r03.html")
open(page, "w").write(html)
print(page)
