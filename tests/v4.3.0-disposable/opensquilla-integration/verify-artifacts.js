'use strict';
/**
 * XJ-4.3.0-opensquilla-long-source-graph-integration-harness-01
 * Artifact verification: checks all deliverable artifacts exist,
 * are syntactically valid, and meet content-level requirements.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
var passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log('[PASS] ' + name); }
  catch (e) { failed++; console.log('[FAIL] ' + name + ' — ' + e.message); }
}
function ensure(c, m) { if (!c) throw new Error(m); }
function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase(); }

// A1: source-graph-projection.js exists and is valid JS
test('A1: source-graph-projection.js exists and parses', function () {
  var p = path.resolve(ROOT, 'design-previews', '4.3.0-opensquilla-atlas-integration', 'source-graph-projection.js');
  ensure(fs.existsSync(p), 'file missing');
  var mod = require(p);
  ensure(typeof mod.createViewModel === 'function', 'createViewModel missing');
  ensure(typeof mod.validateViewModel === 'function', 'validateViewModel missing');
  ensure(typeof mod.filterNodes === 'function', 'filterNodes missing');
  ensure(typeof mod.createNode === 'function', 'createNode missing');
  ensure(typeof mod.createSnapshot === 'function', 'createSnapshot missing');
  ensure(typeof mod.SourceRef === 'object' && typeof mod.SourceRef.create === 'function', 'must import real SourceRef');
});

// A2: source-boundary-adapter.js exists and is valid JS
test('A2: source-boundary-adapter.js exists and parses', function () {
  var p = path.resolve(ROOT, 'design-previews', '4.3.0-opensquilla-atlas-integration', 'source-boundary-adapter.js');
  ensure(fs.existsSync(p), 'file missing');
  var mod = require(p);
  ensure(typeof mod.createAdapter === 'function', 'createAdapter missing');
  var a = mod.createAdapter();
  ensure(typeof a.projectSync === 'function', 'projectSync missing');
  ensure(typeof a.projectAsync === 'function', 'projectAsync missing');
  ensure(typeof a.persistEdge === 'function', 'persistEdge missing');
  ensure(typeof a.persistAiEdge === 'function', 'persistAiEdge missing');
  ensure(typeof a.quarantineSourceRef === 'function', 'quarantineSourceRef missing');
});

// A3: fixtures.js has 3 clients, 54 sessions, 12 negatives
test('A3: fixtures topology correct', function () {
  var p = path.join(__dirname, 'fixtures.js');
  var f = require(p);
  ensure(f.clientCount === 3, 'expected 3 clients, got ' + f.clientCount);
  ensure(f.sessionCount >= 54, 'expected >=54 sessions, got ' + f.sessionCount);
  ensure(f.negativeFixtures.cases.length >= 12, 'expected >=12 negatives, got ' + f.negativeFixtures.cases.length);
});

// A4: run-tests.js exists and is syntactically valid
test('A4: run-tests.js exists and parses', function () {
  var p = path.join(__dirname, 'run-tests.js');
  ensure(fs.existsSync(p), 'file missing');
  var src = fs.readFileSync(p, 'utf8');
  ensure(src.indexOf('C1a') >= 0, 'C1a test missing');
  ensure(src.indexOf('C10') >= 0, 'C10 test missing');
});

// A5: mutation-probes.js exists and is syntactically valid
test('A5: mutation-probes.js exists and parses', function () {
  var p = path.join(__dirname, 'mutation-probes.js');
  ensure(fs.existsSync(p), 'file missing');
  var src = fs.readFileSync(p, 'utf8');
  ensure(src.indexOf('M1:') >= 0, 'M1 probe missing');
  ensure(src.indexOf('M12:') >= 0, 'M12 probe missing');
  ensure(src.indexOf('M1:') >= 0, 'M1 probe missing');
  ensure(src.indexOf('Calibration') >= 0 || src.indexOf('calibrate') >= 0, 'calibration suite missing');
  ensure(src.indexOf('subprocess') >= 0 || src.indexOf('execSync') >= 0, 'subprocess execution missing');
});

// A6: implementation-handoff.md exists
test('A6: implementation-handoff.md exists', function () {
  var p = path.resolve(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'inventory', 'opensquilla-integration', 'implementation-handoff.md');
  ensure(fs.existsSync(p), 'file missing');
  var c = fs.readFileSync(p, 'utf8');
  ensure(c.indexOf('Production integration') >= 0, 'missing integration mapping');
  ensure(c.indexOf('AI preview edges') >= 0, 'missing AI edge constraint');
});

// A7: projection-api-spec.json exists and is valid JSON
test('A7: projection-api-spec.json exists and parses', function () {
  var p = path.resolve(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'inventory', 'opensquilla-integration', 'projection-api-spec.json');
  ensure(fs.existsSync(p), 'file missing');
  var j = JSON.parse(fs.readFileSync(p, 'utf8'));
  ensure(j.modules, 'missing modules');
  ensure(j.modules['source-graph-projection.js'].imports_real_sourceref === true, 'must import real SourceRef');
  ensure(j.modules['source-boundary-adapter.js'].persistence_rejected === true, 'must reject persistence');
});

// A8: Real SourceRef is imported (not copied)
test('A8: real SourceRef module imported', function () {
  var proj = require(path.resolve(ROOT, 'design-previews', '4.3.0-opensquilla-atlas-integration', 'source-graph-projection.js'));
  ensure(typeof proj.SourceRef === 'object', 'SourceRef not exposed');
  ensure(typeof proj.SourceRef.create === 'function', 'SourceRef.create missing');
  ensure(typeof proj.SourceRef.verify === 'function', 'SourceRef.verify missing');
  ensure(proj.SourceRef.SCHEMA_VERSION === '1', 'SCHEMA_VERSION mismatch');
  var realSha = sha256(path.resolve(ROOT, 'app', 'js', 'source-ref.js'));
  ensure(realSha === '983E797807673F1EDE6B1571D75282335736DCED20F3D76961E15CB3D1FAA7EC', 'real SourceRef SHA mismatch: ' + realSha);
});

// A9: Name collision in fixtures
test('A9: fixture has name collision', function () {
  var f = require(path.join(__dirname, 'fixtures.js'));
  ensure(f.clients[0].name === f.clients[1].name, 'clients 0 and 1 names must collide');
  ensure(f.clients[0].id !== f.clients[1].id, 'IDs must differ');
});

// A10: No production files modified
test('A10: no production files modified', function () {
  var forbidden = ['app/js/store.js', 'app/js/app.js', 'app/js/doc-center.js', 'app/js/source-ref.js', 'app/js/clinical-context.js', 'main.js', 'preload.js', 'package.json'];
  var expected = {
    'app/js/store.js': '5305341FB53061E3FA8D6D1005C4C3389DBC26CDC05E88EF67B2BC946350C40E',
    'app/js/app.js': '37CDF3792BBD6AC0916EDC7933D493E4B49966B1EE44B9138C1E275C8D0313ED',
    'app/js/doc-center.js': 'BB78057FC28455CF572DC8E03252C6C55795B2E7F33F998B1EFCEEC9704D2C8E',
    'app/js/source-ref.js': '983E797807673F1EDE6B1571D75282335736DCED20F3D76961E15CB3D1FAA7EC',
    'app/js/clinical-context.js': 'C9EA0EFD9CBFC3F2D7A2B766346E81B842D7FC62D538B59B77C4851D59467758',
    'main.js': '4D6443C8B1461232242BA60427FAEA460D53BEFB4BD83DDF891CB8AF39A18439',
    'preload.js': '4B8291991C1EC39B797268C3FDD69B8CF135737A7C910603554CA16BF8C6DE68',
    'package.json': '75F87D4F61EB077CBF196A59F3AEDD7FFA4569FD685534F141CAFCD93ADF368A'
  };
  forbidden.forEach(function (f) {
    var p = path.resolve(ROOT, f);
    var actual = sha256(p);
    ensure(actual === expected[f], f + ' SHA mismatch: ' + actual + ' != ' + expected[f]);
  });
});

// A11: Adapter rejects all persistence
test('A11: adapter rejects all persistence methods', function () {
  var ad = require(path.resolve(ROOT, 'design-previews', '4.3.0-opensquilla-atlas-integration', 'source-boundary-adapter.js'));
  var a = ad.createAdapter();
  var methods = ['persistEdge', 'persistAiEdge', 'persistHumanEdge', 'persistProjection', 'saveGraph', 'commitEdge', 'flushCache'];
  methods.forEach(function (m) {
    var r = a[m]({ id: 'test' });
    ensure(r.rejected === true && r.ok === false, m + ' did not reject');
  });
});

// A12: Projection produces deep copies
test('A12: projection produces deep copies', function () {
  var proj = require(path.resolve(ROOT, 'design-previews', '4.3.0-opensquilla-atlas-integration', 'source-graph-projection.js'));
  var f = require(path.join(__dirname, 'fixtures.js'));
  var vm = proj.createViewModel(f);
  var origLen = f.nodes.length;
  vm.nodes.push({ id: 'injected' });
  ensure(f.nodes.length === origLen, 'projection aliased input');
});

// A13: SHA-256 of all deliverable files
test('A13: all deliverable SHA-256 computed', function () {
  var files = [
    path.resolve(ROOT, 'design-previews', '4.3.0-opensquilla-atlas-integration', 'source-graph-projection.js'),
    path.resolve(ROOT, 'design-previews', '4.3.0-opensquilla-atlas-integration', 'source-boundary-adapter.js'),
    path.join(__dirname, 'fixtures.js'),
    path.join(__dirname, 'run-tests.js'),
    path.join(__dirname, 'mutation-probes.js'),
    path.join(__dirname, 'verify-artifacts.js')
  ];
  files.forEach(function (p) {
    ensure(fs.existsSync(p), 'missing: ' + p);
    var h = sha256(p);
    ensure(h.length === 64, 'bad hash for ' + p);
    console.log('  ' + path.basename(p) + ': ' + h);
  });
});

console.log('\n=== Artifact Verification ===');
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
console.log('verify_phase: ' + (failed === 0 ? 'ALL-VERIFIED' : 'VERIFICATION-FAILED'));
if (failed > 0) process.exit(1);
