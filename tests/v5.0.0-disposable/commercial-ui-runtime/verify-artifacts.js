'use strict';
/**
 * Verify commercial-ui-runtime allowlist artifacts.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var TEST_DIR = path.join(ROOT, 'tests', 'v5.0.0-disposable', 'commercial-ui-runtime');
var OUT_DIR = path.join(ROOT, 'qa', 'visual', 'v5.0.0-commercial-runtime');
var REPORT = path.join(ROOT, 'qa', 'agent-reviews', 'XJ-5.0.0-grok-commercial-ui-runtime-a11y-02.md');
var PREVIEW = path.join(ROOT, 'design-previews', '5.0.0-commercial');

var ok = 0;
var fail = 0;

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function check(name, cond, detail) {
  if (cond) {
    ok++;
    console.log('[OK] ' + name + (detail ? ' ' + detail : ''));
  } else {
    fail++;
    console.log('[FAIL] ' + name + (detail ? ' ' + detail : ''));
  }
}

var requiredTests = [
  'run-commercial-ui-runtime.js',
  'mutation-probes.js',
  'verify-artifacts.js'
];
requiredTests.forEach(function (n) {
  var p = path.join(TEST_DIR, n);
  check('exists tests/' + n, fs.existsSync(p), fs.existsSync(p) ? 'sha256=' + sha256(p) : '');
});

check('exists runtime-log.json', fs.existsSync(path.join(OUT_DIR, 'runtime-log.json')));
check('exists capture-manifest.json', fs.existsSync(path.join(OUT_DIR, 'capture-manifest.json')));

var manifest = null;
if (fs.existsSync(path.join(OUT_DIR, 'capture-manifest.json'))) {
  manifest = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'capture-manifest.json'), 'utf8'));
}

check('manifest status ok', !!(manifest && manifest.status === 'ok'));
check(
  'capture count >= 18',
  !!(manifest && manifest.captureCount >= 18),
  manifest ? 'count=' + manifest.captureCount : ''
);

if (manifest && Array.isArray(manifest.captures)) {
  var allExist = manifest.captures.every(function (c) {
    var p = path.join(OUT_DIR, c.file);
    if (!fs.existsSync(p)) return false;
    var st = fs.statSync(p);
    if (st.size < 500) return false;
    var h = sha256(p);
    return h === c.sha256;
  });
  check('all capture png exist and hash-match', allExist, 'n=' + manifest.captures.length);

  var vps = ['1024x700', '1366x768', '1920x1080'];
  var vpOk = vps.every(function (vp) {
    return manifest.captures.some(function (c) { return String(c.id).indexOf(vp) === 0; });
  });
  check('three viewports present', vpOk);
} else {
  check('all capture png exist and hash-match', false, 'no captures');
  check('three viewports present', false);
}

check(
  'assertions all true',
  !!(manifest && manifest.assertions && Object.keys(manifest.assertions).every(function (k) {
    return manifest.assertions[k];
  }))
);

// Preview must still exist and remain untouched by this task's writes (no evil files)
check('preview index present (read-only input)', fs.existsSync(path.join(PREVIEW, 'index.html')));
var previewExtra = fs.readdirSync(PREVIEW).filter(function (n) {
  return n === 'evil.txt' || /^mutated/i.test(n);
});
check('no preview residue from runtime task', previewExtra.length === 0);

// Report may be written after verify in delivery flow; if present, hash it
// and require final artifact hashes appear in the report body (anti-stale).
if (fs.existsSync(REPORT)) {
  var reportBody = fs.readFileSync(REPORT, 'utf8');
  check('delivery report present', true, 'sha256=' + sha256(REPORT));
  var logP = path.join(OUT_DIR, 'runtime-log.json');
  var manP = path.join(OUT_DIR, 'capture-manifest.json');
  if (fs.existsSync(logP) && fs.existsSync(manP)) {
    var logHash = sha256(logP);
    var manHash = sha256(manP);
    check('report cites runtime-log sha256', reportBody.indexOf(logHash) >= 0, logHash.slice(0, 16));
    check('report cites capture-manifest sha256', reportBody.indexOf(manHash) >= 0, manHash.slice(0, 16));
  }
  if (manifest && Array.isArray(manifest.captures)) {
    var missingCite = manifest.captures.filter(function (cap) {
      return reportBody.indexOf(cap.sha256) < 0;
    });
    check(
      'report cites every capture sha256',
      missingCite.length === 0,
      missingCite.length ? 'missing=' + missingCite.map(function (c) { return c.id; }).join(',') : 'n=' + manifest.captures.length
    );
  }
} else {
  check('delivery report optional-before-write', true, 'not yet written');
}

// git diff --check on allowlist paths
var diff = cp.spawnSync(
  'git',
  [
    'diff',
    '--check',
    '--',
    'tests/v5.0.0-disposable/commercial-ui-runtime',
    'qa/visual/v5.0.0-commercial-runtime',
    'qa/agent-reviews/XJ-5.0.0-grok-commercial-ui-runtime-a11y-02.md'
  ],
  { cwd: ROOT, encoding: 'utf8' }
);
check('git diff --check clean', diff.status === 0, diff.stderr || diff.stdout || 'clean');

console.log('VERIFY ' + ok + ' ok, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
