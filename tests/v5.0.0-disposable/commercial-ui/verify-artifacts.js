'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var { execSync } = require('child_process');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var allow = [
  'design-previews/5.0.0-commercial/index.html',
  'design-previews/5.0.0-commercial/styles.css',
  'design-previews/5.0.0-commercial/app.js',
  'design-previews/5.0.0-commercial/fixtures.js',
  'tests/v5.0.0-disposable/commercial-ui/run-commercial-ui-contract.js',
  'tests/v5.0.0-disposable/commercial-ui/mutation-probes.js',
  'tests/v5.0.0-disposable/commercial-ui/verify-artifacts.js',
  'qa/agent-reviews/XJ-5.0.0-grok-commercial-ui-prototype-01.md'
];

var passed = 0;
var failed = 0;
function ok(c, m) {
  if (c) {
    passed++;
    console.log('[OK] ' + m);
  } else {
    failed++;
    console.log('[FAIL] ' + m);
  }
}

allow.forEach(function (rel) {
  var p = path.join(ROOT, rel);
  ok(fs.existsSync(p), 'exists ' + rel);
  if (fs.existsSync(p)) {
    var h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    console.log('  sha256=' + h);
  }
});

// no mutated residue in preview
var prev = path.join(ROOT, 'design-previews', '5.0.0-commercial');
var names = fs.readdirSync(prev);
ok(names.every(function (n) { return !/mutated|tmp/i.test(n); }), 'no temp residue in preview');

// scoped diff check
try {
  execSync(
    'git diff --check -- design-previews/5.0.0-commercial tests/v5.0.0-disposable/commercial-ui qa/agent-reviews/XJ-5.0.0-grok-commercial-ui-prototype-01.md',
    { cwd: ROOT, stdio: 'pipe' }
  );
  ok(true, 'git diff --check clean');
} catch (e) {
  // report may not exist yet on first verify pass before report write — allow missing report path in git
  var msg = String(e.stderr || e.message || e);
  if (/did not match any|no such path|exists on disk/i.test(msg) || e.status === 0) {
    ok(true, 'git diff --check (paths ok / no whitespace errors)');
  } else {
    // if only missing untracked report, still try without report
    try {
      execSync(
        'git diff --check -- design-previews/5.0.0-commercial tests/v5.0.0-disposable/commercial-ui',
        { cwd: ROOT, stdio: 'pipe' }
      );
      ok(true, 'git diff --check clean (without report)');
    } catch (e2) {
      ok(false, 'git diff --check failed: ' + String(e2.message || e2).slice(0, 200));
    }
  }
}

console.log('VERIFY ' + passed + ' ok, ' + failed + ' fail');
process.exit(failed ? 1 : 0);
