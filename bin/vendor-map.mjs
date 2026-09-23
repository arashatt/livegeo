#!/usr/bin/env node
// vendor-map.mjs — fetch what the 3D map needs into public/vendor/.
//
// Run by hand, and the result committed: the browser loads these from this
// service and nowhere else, and the server needs no npm packages for them.
// Every version is pinned here, so running it again gives the same files.
//
//   node bin/vendor-map.mjs
//
// Needs network access to registry.npmjs.org and raw.githubusercontent.com,
// and `npm` and `tar` on the path.

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'public', 'vendor');

// MapLibre GL JS (BSD-3-Clause): v6 is ES modules only, and needs WebGL2.
const MAPLIBRE = 'maplibre-gl@6.11.1';
// The HUD's condensed type (SIL OFL 1.1), Latin only: it is for fixed English
// words, never for anybody's name.
const OSWALD = '@fontsource/oswald@5.3.0';
// Natural Earth land (public domain) as TopoJSON, and what reads it (ISC).
const WORLD = 'world-atlas@2.0.2';
const TOPOJSON = 'topojson-client@3.1.0';
// Glyphs for map labels: Noto Sans (SIL OFL 1.1), built by MapLibre's
// font-maker and kept by Protomaps. Pinned to a commit.
const GLYPHS = 'https://raw.githubusercontent.com/protomaps/basemaps-assets/028c18f713baecad011301ff7a69acc39bcc2ae7/fonts';
const FONTSTACKS = ['Noto Sans Regular', 'Noto Sans Medium'];
// Latin, Greek and Cyrillic; Arabic and its supplements (Persian included);
// punctuation, including the zero-width non-joiner Persian relies on; and the
// presentation forms Arabic script is shaped into. MapLibre 6 shapes and
// orders right-to-left text itself, so no plugin is needed for Persian.
const RANGES = [
  '0-255', '256-511', '512-767', '768-1023', '1024-1279',
  '1536-1791', '1792-2047', '2048-2303',
  '8192-8447', '8448-8703',
  '64256-64511', '64512-64767', '64768-65023', '65024-65279', '65280-65535',
];

async function unpack(spec, into) {
  const name = execFileSync('npm', ['pack', spec, '--silent', '--pack-destination', into], { encoding: 'utf8' }).trim().split('\n').pop();
  const dir = join(into, name.replace(/\.tgz$/, ''));
  await mkdir(dir, { recursive: true });
  execFileSync('tar', ['-xzf', join(into, name), '-C', dir]);
  return join(dir, 'package');
}

async function put(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  console.log('  ', to.slice(ROOT.length + 1));
}

async function fetchTo(url, to) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, Buffer.from(await res.arrayBuffer()));
}

const work = await mkdtemp(join(tmpdir(), 'vendor-map-'));
try {
  console.log(MAPLIBRE);
  const ml = await unpack(MAPLIBRE, work);
  for (const f of ['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css']) {
    await put(join(ml, 'dist', f), join(VENDOR, 'maplibre', f));
  }
  await put(join(ml, 'LICENSE.txt'), join(VENDOR, 'maplibre', 'LICENSE.txt'));

  console.log(OSWALD);
  const osw = await unpack(OSWALD, work);
  for (const w of ['500', '600', '700']) {
    await put(join(osw, 'files', `oswald-latin-${w}-normal.woff2`), join(VENDOR, 'fonts', `oswald-latin-${w}-normal.woff2`));
  }
  await put(join(osw, 'LICENSE'), join(VENDOR, 'fonts', 'OFL-oswald.txt'));

  console.log(WORLD, TOPOJSON);
  const world = await unpack(WORLD, work);
  const topo = await unpack(TOPOJSON, work);
  const { feature } = createRequire(import.meta.url)(join(topo, 'dist', 'topojson-client.js'));
  const land = JSON.parse(await readFile(join(world, 'land-110m.json'), 'utf8'));
  const geojson = feature(land, land.objects.land);
  // Five decimals is a metre; 110m data has nothing finer to say.
  const text = JSON.stringify(geojson, (k, v) => (typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v));
  await mkdir(join(VENDOR, 'world'), { recursive: true });
  await writeFile(join(VENDOR, 'world', 'land-110m.json'), text);
  await writeFile(join(VENDOR, 'world', 'SOURCE.txt'),
    'Natural Earth 1:110m land (public domain, naturalearthdata.com), via world-atlas 2.0.2, converted to GeoJSON by bin/vendor-map.mjs.\n');
  console.log('   public/vendor/world/land-110m.json');

  console.log('glyphs');
  for (const stack of FONTSTACKS) {
    for (const range of RANGES) {
      await fetchTo(`${GLYPHS}/${encodeURIComponent(stack)}/${range}.pbf`, join(VENDOR, 'glyphs', stack, `${range}.pbf`));
    }
    console.log(`   public/vendor/glyphs/${stack}/ (${RANGES.length} ranges)`);
  }
  await fetchTo(`${GLYPHS}/OFL.txt`, join(VENDOR, 'glyphs', 'OFL.txt'));
} finally {
  await rm(work, { recursive: true, force: true });
}
