# Browser dependencies (self-hosted)

| Asset | Version/source | Licence |
|---|---|---|
| MapLibre GL JS | npm `maplibre-gl@6.11.1`, production `.mjs` dist + CSS | BSD-3-Clause, `maplibre/LICENSE.txt` |
| RTL text / ICU shaping | npm `@mapbox/mapbox-gl-rtl-text@0.4.0`, self-contained dist (embedded WASM) | BSD-2-Clause + ICU terms, `rtl/LICENSE.md` |
| Barlow Condensed SemiBold | Google Fonts, `ofl/barlowcondensed/BarlowCondensed-SemiBold.ttf` | SIL OFL 1.1, `fonts/BarlowCondensed-OFL.txt` |
| Vazirmatn | Google Fonts, `ofl/vazirmatn/Vazirmatn[wght].ttf`, instantiated at weight 400 | SIL OFL 1.1, `fonts/Vazirmatn-OFL.txt` |
| Natural Earth land | `nvkelso/natural-earth-vector/geojson/ne_110m_land.geojson`, retrieved 2026-09-23 | Public domain, `natural-earth/LICENSE.md` |
| Leaflet | 1.9.4, existing distribution | BSD-2-Clause, existing licence |

The original font inputs, regular instance, WOFF2s and all 256 BMP glyph ranges
are committed. Missing scripts produce empty ranges, not remote fallback requests.
Latin labels use Barlow; Arabic/Persian glyphs come from Vazirmatn, including
Arabic Presentation Forms A/B. Glyphs form one `LiveGeo` stack. Text spacing is
zero, so joined Persian letters are never separated. Latin text is uppercased
by the style. RTL shaping runs in MapLibre's workers before glyph lookup.

Regenerate the glyphs from the committed font files, with the pinned CLI:

```sh
npm ci
npm run glyphs
# Exactly: node bin/glyphs.mjs
# Calls:
# node node_modules/@sakitam-gis/font-maker-cli/dist/index.js convert \
#   public/vendor/fonts/BarlowCondensed-SemiBold.ttf \
#   public/vendor/fonts/Vazirmatn-Regular.ttf -o /tmp/livegeo-glyphs -j 2
```

`bin/glyphs.mjs` merges glyphs deterministically, preferring Barlow where both
fonts have the same codepoint. The build is an asset maintenance command; the
application has no build step. `npm ci --omit=dev` does not install font-making
or browser-test dependencies in production.

To regenerate the regular font instance / web fonts (Python FontTools plus
Brotli), keeping the inputs in this directory:

```python
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from pathlib import Path
p = Path('public/vendor/fonts')
f = instantiateVariableFont(TTFont(p / 'Vazirmatn.ttf'), {'wght': 400}, inplace=True)
f.save(p / 'Vazirmatn-Regular.ttf')
for name in ['BarlowCondensed-SemiBold', 'Vazirmatn-Regular']:
    f = TTFont(p / (name + '.ttf'))
    f.flavor = 'woff2'
    f.save(p / (name + '.woff2'))
```

Natural Earth is intentionally coarse at 1:110m. It supplies land/coastline at
world zoom and outside the optional import; it does not imply street-level
coverage. No other publisher's artwork, map screenshots, fonts or logos are
included in this product.
