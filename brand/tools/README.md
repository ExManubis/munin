# brand/tools

Generators for the munin logo, mockup pages and the Munin Block font. Everything is drawn in code, so the outputs can be rebuilt at any time.

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python blockfont.py   # → ../font/MuninBlock-Regular.{otf,ttf,woff2}
.venv/bin/python build3.py      # → ../pixel-r03.html, ../logo/treatments/
.venv/bin/python build2.py      # → ../pixel-r02.html, ../logo/pixel/, ../logo/wordmark/
.venv/bin/python build.py       # → ../mockups.html (round 1), ../logo/
```

- `marks.py`: `PIXEL16` is the master 16 × 16 raven. Round 1's vector concepts are in `raven.py`, `facet.py` and `marks.py`.
- `pixvars.py`: the pixel variants and the Block wordmark letters.
- `treat.py`: the LED, Scanline and Dither renderers, which all share one bitmap.
- `blockfont.py`: the glyph bitmaps for Munin Block and the font builder. Edit a glyph's rows and rerun to rebuild the font.
- `shot.sh in.html out.png W H`: takes a headless Chrome screenshot, used to make the PNG previews.
