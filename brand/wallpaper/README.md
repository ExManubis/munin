# munin wallpapers

Dark, monochrome desktop and phone wallpapers. Each is an abstract light (smoke, aurora, an eclipse) covered in a quiet grid of glyphs whose brightness follows the light. In most of them the munin lockup isn't laid on top: it's drawn with the glyphs themselves, one cell per logo pixel, so it shows on a second look. That's a deliberate exception to the brand rule against effects on the logo.

`wallpaper.html` is the generator: a canvas page that paints a variant from its URL. The mockups are in the Paper file "munin", on the pages "Wallpapers v1", "v2 · hidden lockup" and "v3 · Drift family".

## Render

Needs Google Chrome and Python 3 (for a local web server). PNGs land in `renders/`, which git ignores.

```
./render.sh                       # every variant at 2880×1800
./render.sh 5120 2880 nordlys     # one variant at another size
./devices.sh nordlys              # Studio Display, 16" MacBook Pro, iPad, iPhone, iPhone Duo inner and outer
```

To look at one in a browser, serve `brand/` (`python3 -m http.server -d brand`) and open `/wallpaper/wallpaper.html?v=nordlys`.

## Variants

| Variant | What it is | Glyphs |
|---|---|---|
| `drift2` | Soft smoke ribbons, lockup woven into them | Munin Block |
| `eclipse2` | A soft-edged void with a smoky corona, stacked lockup inside | Munin Block |
| `orbit` | Smoke bent into a tilted ring | Munin Block |
| `nordlys` | Aurora curtains | runes |
| `yggdrasil` | A branching world tree in mist | runes |
| `ginnungagap` | Ice filaments and fire billows with the void between | runes |
| `bifrost` | An arc split three ways like light through a prism | runes |
| `ravens` | Huginn & Muninn: two smoke streams winding round each other | Munin Block |
| `vortex` | A warped smoke spiral | binary digits |
| `shear` | Drift II sliced and slid sideways, lockup torn with it | Munin Block |
| `horizon`, `eclipse`, `wing`, `drift`, `rain` | The first round, with the sharp lockup on top | Munin Block, larger |

The runes are 18 Elder Futhark letters drawn on Munin Block's cap-height grid. Othala, Sowilo, Algiz and Tiwaz are left out because hate groups have taken them up. The hidden line in rune variants spells munin as ᛗᚢᚾᛁᚾ; elsewhere it's "munin remembers", or munin in binary for `vortex`.

## URL parameters

- `v`, `w`, `h`, `seed`: the variant, size and random seed.
- `reveal`: how strongly a hidden lockup shows, 0 to 1.
- `cell`: the exact cell size in px. Keep it a multiple of 16 for Munin Block glyphs so they stay pixel-sharp; the rune variants take any size.
- `logo` (`horizontal` or `stacked`), `ls` (cells per logo unit, 1 or 2), and `x`/`y` (where the lockup's centre sits, 0 to 1): for fitting other screens.
- `glyphs=0`: the base image alone.

Scenes are drawn in units of the screen height around a fixed centre, so other aspect ratios crop or extend the same scene rather than squashing it.
