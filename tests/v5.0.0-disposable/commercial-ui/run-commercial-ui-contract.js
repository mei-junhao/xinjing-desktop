'use strict';
/**
 * XJ-5.0.0-grok-commercial-ui-prototype-01 — contract runner
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var PREVIEW = path.join(ROOT, 'design-previews', '5.0.0-commercial');
var FILES = {
  html: path.join(PREVIEW, 'index.html'),
  css: path.join(PREVIEW, 'styles.css'),
  app: path.join(PREVIEW, 'app.js'),
  fixtures: path.join(PREVIEW, 'fixtures.js')
};

var passed = 0;
var failed = 0;

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function ensure(c, m) { if (!c) throw new Error(m); }
function test(id, title, fn) {
  try {
    fn();
    passed++;
    console.log('[CONFIRMED] ' + id + ' ' + title);
  } catch (e) {
    failed++;
    console.log('[FAIL] ' + id + ' ' + title + ' — ' + e.message);
  }
}

Object.keys(FILES).forEach(function (k) {
  ensure(fs.existsSync(FILES[k]), 'missing ' + FILES[k]);
});

var html = fs.readFileSync(FILES.html, 'utf8');
var css = fs.readFileSync(FILES.css, 'utf8');
var app = fs.readFileSync(FILES.app, 'utf8');
var fixturesSrc = fs.readFileSync(FILES.fixtures, 'utf8');
var fixtures = require(FILES.fixtures);

test('C-01', 'local multi-file bundle without network', function () {
  ensure(html.indexOf('fixtures.js') >= 0 && html.indexOf('app.js') >= 0 && html.indexOf('styles.css') >= 0, 'scripts/styles missing');
  ensure(html.indexOf('http://') < 0 && html.indexOf('https://') < 0, 'remote URL in html');
  ensure(css.indexOf('http://') < 0 && css.indexOf('https://') < 0, 'remote URL in css');
  ensure(app.indexOf('fetch(') < 0 && app.indexOf('XMLHttpRequest') < 0, 'network API in app');
});

test('C-02', 'Clinical/Theatre/Observatory skins distinct', function () {
  ensure(css.indexOf('[data-skin="clinical"]') >= 0, 'clinical');
  ensure(css.indexOf('[data-skin="theatre"]') >= 0, 'theatre');
  ensure(css.indexOf('[data-skin="observatory"]') >= 0, 'observatory');
  var c = css.match(/\[data-skin="clinical"\][\s\S]*?--accent:\s*([^;]+);/);
  var o = css.match(/\[data-skin="observatory"\][\s\S]*?--accent:\s*([^;]+);/);
  ensure(c && o && c[1].trim() !== o[1].trim(), 'observatory accent must differ');
});

test('C-03', 'light/dark without page duplication', function () {
  ensure(html.indexOf('data-theme="light"') >= 0, 'light default');
  ensure(html.indexOf('id="themeSelect"') >= 0, 'theme select');
  ensure(css.indexOf('[data-theme="dark"]') >= 0, 'dark rules');
});

test('C-04', 'three interactive segments with handlers', function () {
  ensure(html.indexOf('data-segment="account"') >= 0, 'account seg');
  ensure(html.indexOf('data-segment="orders"') >= 0, 'orders seg');
  ensure(html.indexOf('data-segment="device"') >= 0, 'device seg');
  ensure(app.indexOf('switchSegment') >= 0, 'switchSegment handler');
  ensure(app.indexOf('onPrimary') >= 0 || app.indexOf('primaryAction') >= 0, 'primary handler');
  ensure(app.indexOf('onSegmentKeydown') >= 0, 'keyboard segment nav');
});

test('C-05', 'synthetic scenarios cover empty/error/expired/revoked/offline/loading/ready', function () {
  var need = ['ready', 'empty', 'loading', 'error', 'expired', 'revoked', 'offline'];
  need.forEach(function (id) {
    ensure(fixtures.SCENARIOS[id], 'missing scenario ' + id);
  });
  ensure(fixtures.SCENARIOS.empty.orders && fixtures.SCENARIOS.empty.orders.length === 0, 'empty orders');
  ensure(fixtures.SCENARIOS.error.degraded && fixtures.SCENARIOS.error.degraded.kind === 'error', 'error degraded');
  ensure(fixtures.SCENARIOS.expired.account.status === 'expired', 'expired status');
  ensure(fixtures.SCENARIOS.revoked.account.status === 'revoked', 'revoked status');
  ensure(fixtures.SCENARIOS.offline.account.status === 'offline-grace', 'offline-grace');
});

test('C-06', 'commercial state machine tokens present', function () {
  var sm = fixtures.STATE_MACHINE.join(',');
  ['created', 'pending', 'active', 'expired', 'revoked', 'offline-grace', 'blocked', 'unknown'].forEach(function (s) {
    ensure(sm.indexOf(s) >= 0, 'missing state ' + s);
  });
  ensure(app.indexOf('STATE_MACHINE') >= 0 || fixturesSrc.indexOf('STATE_MACHINE') >= 0, 'state machine export');
});

test('C-07', 'tiers Free/Pro/Flagship represented in fixtures', function () {
  var tiers = {};
  Object.keys(fixtures.SCENARIOS).forEach(function (k) {
    var a = fixtures.SCENARIOS[k].account;
    if (a && a.tier) tiers[a.tier] = true;
  });
  ensure(tiers.Free && tiers.Pro && tiers.Flagship, 'missing tier coverage');
});

test('C-08', 'fail-closed copy for signature/revoke without inventing production routes', function () {
  ensure(fixturesSrc.indexOf('fail-closed') >= 0 || fixtures.SCENARIOS.error.degraded.message.indexOf('fail-closed') >= 0, 'fail-closed missing');
  ensure(html.indexOf('app/') < 0, 'must not deep-link production app paths as required runtime');
  ensure(app.indexOf('require(') < 0, 'no node require in browser app');
});

test('C-09', 'accessibility: live region, focus-visible, reduced-motion', function () {
  ensure(html.indexOf('aria-live') >= 0, 'live region');
  ensure(css.indexOf(':focus-visible') >= 0, 'focus-visible');
  ensure(css.indexOf('prefers-reduced-motion') >= 0, 'prefers-reduced-motion');
  ensure(app.indexOf('reduce-motion') >= 0 || app.indexOf('reduceMotion') >= 0, 'reduce motion toggle');
});

test('C-10', 'long Chinese label ellipsis style present', function () {
  ensure(css.indexOf('.long-label') >= 0, 'long-label class');
  ensure(css.indexOf('text-overflow: ellipsis') >= 0, 'ellipsis');
});

test('C-11', 'recovery action for degraded scenarios', function () {
  ensure(app.indexOf('recovery') >= 0 || app.indexOf('recoveryBtn') >= 0, 'recovery wiring');
  ensure(fixtures.SCENARIOS.error.degraded.recovery, 'error recovery');
  ensure(fixtures.SCENARIOS.expired.degraded.recovery, 'expired recovery');
});

test('C-12', 'isolation allowlist paths only referenced', function () {
  ensure(PREVIEW.indexOf('design-previews' + path.sep + '5.0.0-commercial') >= 0, 'preview path');
  // no writes to app/**
  ensure(app.indexOf('app/js') < 0 && app.indexOf('main.js') < 0, 'production paths in app');
});

console.log('---');
console.log('hashes:');
Object.keys(FILES).forEach(function (k) {
  console.log(k + '=' + sha256(FILES[k]));
});
console.log('RESULT ' + passed + '/' + (passed + failed) + ' failed=' + failed);
process.exit(failed ? 1 : 0);
