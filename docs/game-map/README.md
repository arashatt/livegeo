# Dashboard demo and verification

These images contain invented people and a generated coastal grid. No production
account, address, location, session, token or tile service was used. `startDemo()`
points `TELEGRAM_API` and `TILE_UPSTREAM` at local stubs. All images are JPEGs under
250,000 bytes. The browser requested zero resources from another host and zero
`/tiles/` resources before explicitly opening the separate GPX/Classic view.

| View | Desktop · 1440 × 900 | Phone · 390 × 844 |
|---|---|---|
| World globe | [Globe](desktop-globe.jpg) | [Globe](phone-globe.jpg) |
| Tilted city, day | [Day](desktop-day.jpg) | [Day](phone-day.jpg) |
| Tilted city, night | [Night](desktop-night.jpg) | [Night](phone-night.jpg) |
| Street, golden hour | [Street](desktop-street.jpg) | [Street](phone-street.jpg) |
| Flat Map camera | [Map](desktop-map.jpg) | [Map](phone-map.jpg) |
| Chase and radar | [Chase](desktop-chase.jpg) | [Chase](phone-chase.jpg) |
| Legend open | [Legend](desktop-legend.jpg) | [Legend](phone-legend.jpg) |
| Layers open | [Layers](desktop-layers.jpg) | [Layers](phone-layers.jpg) |

[Estimated trail time](desktop-trail-time.jpg) and [self card](desktop-card.jpg)
complete the state coverage. Alex is self with a current heading; Mina is live;
Noah is not live; Sam has SOS; Jamie is represented only by a private area.
The Home area has a dashed purple rim and the Meeting point is a fence.

Reproduce with `npm ci` and `CHROMIUM_PATH=/path/to/chrome npm run demo:game`.
Chromium uses SwiftShader (`--use-angle=swiftshader --enable-unsafe-swiftshader`).
The script captures all views, checks errors/origins, records real map render
events during motion at 4× CPU throttle, and records idle renders after settling.
Exact outputs, image sizes and asset byte counts are in [measurements.json](measurements.json).

| Measurement | Recorded result |
|---|---|
| p95 gzip MVT, z12 | 811 bytes over 4 tiles |
| p95 gzip MVT, z16 | 637 bytes over 90 tiles; maximum 738 bytes |
| Added JavaScript | 1,291,615 bytes, uncompressed browser libraries/modules |
| Added fonts | 567,500 bytes, including committed source TTFs and WOFF2s |
| Added glyphs | 362,138 bytes across the 256 BMP ranges |
| Added land data | 138,160 bytes |
| Desktop pan/tilt, 4× CPU | 2.8 fps, 13 map frames / 4,704 ms |
| Phone viewport pan/tilt, 4× CPU | 12.8 fps, 52 map frames / 4,069 ms |
| Phone viewport Lite pan, 4× CPU | 19.1 fps, 78 map frames / 4,074 ms |
| Idle map repaint | 0 over 2 seconds after settling |

The tile measurements use actual `ST_AsMVT` output for the invented fixture in
[PostGIS CI](https://github.com/arashatt/livegeo/actions/runs/36002413451), not
production density or the demo server's JavaScript tile encoder. Browser numbers
are single four-second samples on Chrome 153 with a software GPU; shared-runner
contention makes them variable. They do not establish smooth physical-phone
performance. Lite improves this recorded phone sample but needs hardware testing.

## Checks

`npm test` passed: 648 existing application assertions, 36 Node test cases,
and the real Chromium browser suite. The existing branch CI also exercises the
PostGIS suite against disposable PostGIS 16/3.4. No workflow was changed.

| Area | Evidence |
|---|---|
| Rendering and networking | WebGL2 canvas, extrusions, night windows, self-hosted glyphs/RTL, zero browser errors or external requests; no default raster |
| Privacy | Hidden person has no blip or radar point; ground veil at tilt, rim chip; hidden self exits Chase and hides radar; world-scale area count is non-geographic |
| People and safety | State/shape/word cues, accessible person buttons, keyboard card, SOS cancellation and confirmed demo POST, unchanged emergency-number result |
| Interaction parity | Camera modes, unknown-heading north-up, layers/Lite, fence and private-place click placement, Esc, Classic private-person card, GPX preview isolated from the main map |
| Trails | Shared path/time maths and gap rules, rendered glow and fade ends, hover/tap estimated-time screenshot; missing-time output stays literal |
| Text | Markup injection fixture stays text; actual Persian joining/bidi and committed presentation-form glyphs verified |
| Phone and motion | 390px layout reviewed, legend reserves space below map, reduced-motion screenshots, finite camera moves, idle render count checked |
| Fallback | Remembered Classic, disabled 3D APIs, and simulated constructor GPU failure all start the shared Leaflet dashboard |
| Server | Auth/MIME/gzip negotiation/empty tiles, strict coordinates/layer whitelist, static MIME/traversal, cache/feature budgets and real decoded PostGIS tiles |

The desktop and phone screenshots were visually reviewed. Browser interactions
are driven through Chromium with Playwright; this is not a physical-phone field
test. The software-rendering stress measurement must not be read as hardware GPU
performance. Real-device profiling remains necessary before claiming a target FPS.

## Coverage and deliberate limits

The required visual systems are implemented: globe/sky/horizon haze, local solar
lighting and overrides, three cameras, original HUD, blips, radar, legend, labels,
district readout, roads, water, parks and illustrative buildings. Focusable blips,
Lite and CI browser smoke coverage from the optional list are implemented.

Low-poly trees and individual street-light sprites are deferred to preserve the
phone budget; major-road glow is static. No three.js runtime or terrain is added.
Private transitions use a still ground area with finite fade transitions rather
than a breathing blur. Below zoom 8, ground overlays and their labels disappear;
private people remain in People and a non-geographic HUD count. Street detail is
limited to the optional local OSM import; Natural Earth provides coarse global
land outside it. Classic retains the existing worldwide SVG/raster options.

CI ran through the existing pull-request trigger rather than a separate manual
dispatch; it runs the same Node and PostGIS jobs. Existing GPX, district and
worldwide Classic changes on main were integrated before shipping. `live.html`,
the shared Leaflet people drawing files, and CI/Deploy workflows are unchanged.

## Follow-ups

- Profile on a physical mid-range Android phone, then tune the Lite default and
  camera density from measured frame times. Software rendering remains slow.
- Add static low-poly trees/street-light points only after that budget is known.
- Terrain requires an independently hosted DEM tile pyramid, elevation-aware
  overlay projection and privacy/occlusion checks. It is outside this change.
  Hosting depends on coverage, maximum zoom and traffic. As an illustrative
  storage-only estimate, 50 GB in R2 Standard is $0.75/month before the free tier,
  or $0.60 if its 10 GB allowance is unused. Reads beyond the allowance are
  $0.36/million, writes $4.50/million; R2 egress is free. Tile generation, the
  same-origin proxy/Worker and any server transfer charges are additional.
  These assumptions do not estimate the size of a global high-resolution DEM.
  Source: [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/),
  checked 24 September 2026. No terrain service or cost is enabled by this PR.
