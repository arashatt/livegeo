import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'acorn';

// The classic map is what a web view too old for the 3D map gets
// (map-bootstrap.js), and the ones that old are in cars: head units ship an
// Android web view that is never updated, Chrome 74 on Android 10. One piece
// of newer syntax (?., ??, a class field) anywhere in a script the page runs
// and that browser throws the whole script away, leaving an empty page. So
// everything the page runs before the 3D map is parsed here as ES2019, about
// what Chrome 74 reads. The Android workflow opens the page on such a web
// view for real; this catches it on every push.

const PUBLIC = new URL('../public/', import.meta.url);
const html = readFileSync(new URL('index.html', PUBLIC), 'utf8');

// The page's own classic scripts, in the order it runs them: every <script>
// but modules, which an old browser does not run at all.
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(([, attrs]) => !/type=["']?module/.test(attrs))
  .map(([whole, attrs, body]) => {
    const src = /src=["']([^"']+)["']/.exec(attrs);
    if (src) return { name: src[1], code: readFileSync(new URL(src[1].slice(1), PUBLIC), 'utf8') };
    const line = html.slice(0, html.indexOf(whole)).split('\n').length;
    return { name: `index.html, the script at line ${line}`, code: body };
  });

test('the page runs its classic scripts, and the bootstrap that chooses', () => {
  const names = scripts.map((s) => s.name);
  for (const name of ['/lib/map-bootstrap.js', '/lib/app-bridge.js', '/vendor/leaflet/leaflet.js', '/lib/people-map.js']) {
    assert.ok(names.includes(name), `${name} is loaded by the page`);
  }
  assert.ok(names.some((n) => n.startsWith('index.html')), 'and its own inline script');
});

test('every classic script parses on a Chrome 74 web view', () => {
  for (const { name, code } of scripts) {
    try {
      parse(code, { ecmaVersion: 2019, sourceType: 'script' });
    } catch (e) {
      assert.fail(`${name}: ${e.message}. Write it as ES2019 (no ?., ??, class fields): an old web view would drop the whole script.`);
    }
  }
});

test('the check tells an old web view apart, and is itself old enough to run on one', () => {
  const bootstrap = scripts.find((s) => s.name === '/lib/map-bootstrap.js').code;
  const probe = /new Function\('([^']+)'\)/.exec(bootstrap)?.[1];
  assert.ok(probe, 'map-bootstrap.js tries the 3D map\'s syntax before loading it');
  // A function's body, so a return at the top of it is its own.
  const as = (ecmaVersion) => () => parse(probe, { ecmaVersion, allowReturnOutsideFunction: true });
  assert.throws(as(2019), SyntaxError, 'what it tries is what an old web view cannot read');
  assert.doesNotThrow(as(2022), 'and what the 3D map needs');
  assert.doesNotThrow(() => new Function(probe), 'which this Node reads, as a current browser does');
});
