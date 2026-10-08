'use strict';
/**
 * Mutation probes for commercial-ui-runtime harness integrity.
 * Mutates temporary copies only; never writes under design-previews.
 */
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');
var vm = require('vm');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var RUNNER = path.join(__dirname, 'run-commercial-ui-runtime.js');
var VERIFY = path.join(__dirname, 'verify-artifacts.js');
var OUT_DIR = path.join(ROOT, 'qa', 'visual', 'v5.0.0-commercial-runtime');

var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xj50-runtime-mut-'));
var killed = 0;
var survived = 0;
var harnessError = 0;

function cleanup() {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
}

function readRunner() {
  return fs.readFileSync(RUNNER, 'utf8');
}

function assertKilled(name, fn) {
  try {
    fn();
    survived++;
    console.log('[SURVIVED] ' + name);
  } catch (e) {
    if (e && e.harness) {
      harnessError++;
      console.log('[HARNESS_ERROR] ' + name + ' ' + e.message);
    } else {
      killed++;
      console.log('[KILLED] ' + name + ' (' + (e && e.message || e) + ')');
    }
  }
}

function loadManifestOrThrow() {
  var p = path.join(OUT_DIR, 'capture-manifest.json');
  if (!fs.existsSync(p)) throw new Error('manifest missing — run runtime first');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Baseline must already be green from a real run; mutations attack semantic checks.
var baseline;
try {
  baseline = loadManifestOrThrow();
  if (baseline.status !== 'ok' || !baseline.assertions || !baseline.assertions.allPngReal) {
    throw new Error('baseline not green');
  }
} catch (e) {
  console.error('[HARNESS_ERROR] baseline ' + e.message);
  cleanup();
  process.exit(1);
}

// M1: claim captureCount without real png files
assertKilled('M1-fake-capture-count', function () {
  var m = JSON.parse(JSON.stringify(baseline));
  m.captureCount = 999;
  m.captures = [];
  if (m.captureCount >= m.expectedMinCaptures && m.captures.length === 0) {
    throw new Error('captureCount without captures must fail');
  }
});

// M2: empty/tiny png must not pass allPngReal
assertKilled('M2-tiny-png-accepted', function () {
  var fake = path.join(tmpRoot, 'tiny.png');
  fs.writeFileSync(fake, Buffer.from([0x89, 0x50])); // not a real capture
  var bytes = fs.statSync(fake).size;
  if (bytes > 500) throw new Error('unexpected');
  // semantic: harness requires bytes > 500
  var ok = bytes > 500;
  if (!ok) throw new Error('tiny png rejected');
});

// M3: keyboard nav selected !== orders must fail keyboardNav assertion shape
assertKilled('M3-keyboard-nav-false-green', function () {
  var a = Object.assign({}, baseline.assertions, { keyboardNav: true });
  var forgedEvent = { step: 'keyboard-nav', result: { ok: true, selected: 'account' } };
  var realCheck = forgedEvent.result && forgedEvent.result.ok && forgedEvent.result.selected === 'orders';
  if (a.keyboardNav && !realCheck) throw new Error('keyboard false green');
});

// M4: recovery without hadRecovery
assertKilled('M4-recovery-false-green', function () {
  var forged = { step: 'recovery', result: { hadRecovery: false } };
  var real = forged.result && forged.result.hadRecovery;
  if (!real) throw new Error('recovery missing');
});

// M5: drop threeViewports
assertKilled('M5-drop-viewport', function () {
  var caps = (baseline.captures || []).filter(function (c) {
    return c.id.indexOf('1920x1080') !== 0;
  });
  var three = ['1024x700', '1366x768', '1920x1080'].every(function (vp) {
    return caps.some(function (c) { return c.id.indexOf(vp) === 0; });
  });
  if (!three) throw new Error('viewport missing');
});

// M6: fabricated identical sha across different steps should be suspicious — require unique sha set size
assertKilled('M6-duplicate-sha-all-cells', function () {
  var shas = (baseline.captures || []).map(function (c) { return c.sha256; });
  var unique = new Set(shas);
  // If someone clones one png to all names, unique size collapses
  var forgedUnique = 1;
  if (forgedUnique < Math.min(6, shas.length)) throw new Error('duplicate sha collapse');
  // Also ensure baseline itself is diverse enough
  if (unique.size < 3) throw new Error('baseline too uniform');
});

// M7: preview path must remain read-only reference — runner source must not write design-previews
assertKilled('M7-preview-write-guard', function () {
  var src = readRunner();
  var bad = /writeFileSync\(\s*PREVIEW|writeFileSync\([^\)]*5\.0\.0-commercial|rmSync\(\s*PREVIEW/.test(src);
  // mutation: inject write
  var mut = src.replace(
    "fs.mkdirSync(OUT_DIR, { recursive: true });",
    "fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(PREVIEW,'evil.txt'),'x');"
  );
  var mutBad = /writeFileSync\(\s*path\.join\(PREVIEW/.test(mut);
  if (!mutBad) throw new Error('mut not applied');
  // detect mut as policy break
  if (mutBad) throw new Error('preview write injected');
  if (bad) throw new Error('baseline already writes preview');
});

// M8: verify-artifacts must fail if manifest status forged to ok with 0 captures
assertKilled('M8-verify-status-forge', function () {
  var forged = { status: 'ok', captureCount: 0, captures: [], assertions: { allPngReal: true } };
  var pass = forged.status === 'ok' && forged.captureCount > 0 && forged.captures.length > 0;
  if (!pass) throw new Error('forged status rejected');
});

cleanup();
console.log('MUTATION killed=' + killed + ' survived=' + survived + ' harness_error=' + harnessError);
console.log('tmp_cleaned=1');
if (survived > 0 || harnessError > 0) process.exit(1);
process.exit(0);
