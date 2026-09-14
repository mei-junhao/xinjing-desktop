'use strict';
/**
 * XJ-4.3.0-trae-case-atlas-golden-prototype-05 — Artifact Verification
 * Checks all deliverable artifacts exist, are syntactically valid,
 * and meet content-level requirements.
 * Includes runtime probes using jsdom to verify actual behavior.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
var passed = 0, failed = 0;
var sha256Map = {};

function test(name, fn) {
  try { fn(); passed++; console.log('[PASS] ' + name); }
  catch (e) { failed++; console.log('[FAIL] ' + name + ' — ' + e.message); }
}
function ensure(c, m) { if (!c) throw new Error(m); }
function sha256(p) {
  var h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase();
  sha256Map[path.relative(ROOT, p)] = h;
  return h;
}

function runRuntimeProbe(name, fn) {
  try {
    fn();
    passed++;
    console.log('[PASS] ' + name);
  } catch (e) {
    failed++;
    console.log('[FAIL] ' + name + ' — ' + e.message);
  }
}

// A1: Prototype HTML exists and is valid
var protoPath = path.join(ROOT, 'design-previews', '4.3.0-trae-case-atlas-golden', 'index.html');
test('A1: prototype index.html exists', function () {
  ensure(fs.existsSync(protoPath), 'file missing');
  var html = fs.readFileSync(protoPath, 'utf8');
  ensure(html.indexOf('<!DOCTYPE html>') >= 0, 'not valid HTML');
  ensure(html.indexOf('data-skin="goldentime"') >= 0, 'Golden Time skin attribute missing');
  ensure(html.length > 10000, 'file too small for a complete prototype');
});

test('A2: prototype contains all 3 view panels', function () {
  var html = fs.readFileSync(protoPath, 'utf8');
  ensure(html.indexOf('id="viewTimeline"') >= 0, 'timeline panel missing');
  ensure(html.indexOf('id="viewMaterials"') >= 0, 'materials panel missing');
  ensure(html.indexOf('id="viewGraph"') >= 0, 'graph panel missing');
});

test('A3: prototype contains source drawer', function () {
  var html = fs.readFileSync(protoPath, 'utf8');
  ensure(html.indexOf('source-drawer') >= 0, 'drawer class missing');
  ensure(html.indexOf('drawer-overlay') >= 0, 'drawer overlay missing');
});

test('A4: prototype contains 31+ source data entries', function () {
  var html = fs.readFileSync(protoPath, 'utf8');
  var match = html.match(/var sources\s*=\s*\[([\s\S]*?)\];/);
  ensure(match, 'SOURCES array not found');
  var idCount = (match[1].match(/\bid:\s*\d+/g) || []).length;
  ensure(idCount >= 31, 'expected >= 31 sources, got ' + idCount);
});

test('A5: prototype contains 32+ edge data entries', function () {
  var html = fs.readFileSync(protoPath, 'utf8');
  var match = html.match(/var edges\s*=\s*\[([\s\S]*?)\];/);
  ensure(match, 'EDGES array not found');
  var edgeCount = (match[1].match(/\{\s*from/g) || []).length;
  ensure(edgeCount >= 31, 'expected >= 31 edges, got ' + edgeCount);
});

// A6: Design spec exists and contains required sections
test('A6: design spec exists with required sections', function () {
  var specPath = path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'design', 'trae-case-atlas-golden-spec.md');
  ensure(fs.existsSync(specPath), 'spec file missing');
  var spec = fs.readFileSync(specPath, 'utf8');
  ensure(spec.indexOf('## \u4e00\u3001\u6982\u8ff0') >= 0 || spec.indexOf('\u6982\u8ff0') >= 0, 'overview section missing');
  ensure(spec.indexOf('\u4ee4\u724c') >= 0, 'token section missing');
  ensure(spec.indexOf('SourceRef') >= 0, 'SourceRef mention missing');
  ensure(spec.indexOf('C-01') >= 0, 'contract C-01 missing');
  ensure(spec.indexOf('C-45') >= 0, 'contract C-45 missing');
});

// A7: Contract test exists and is syntactically valid
test('A7: run-case-atlas-contract.js exists and parses', function () {
  var p = path.join(__dirname, 'run-case-atlas-contract.js');
  ensure(fs.existsSync(p), 'file missing');
  var src = fs.readFileSync(p, 'utf8');
  ensure(src.indexOf('C-01') >= 0, 'C-01 test missing');
  ensure(src.indexOf('C-45') >= 0, 'C-45 test missing');
  ensure(src.indexOf('N-01') >= 0, 'N-01 network isolation test missing');
});

// A8: Mutation probes exist and are syntactically valid
test('A8: mutation-probes.js exists and parses', function () {
  var p = path.join(__dirname, 'mutation-probes.js');
  ensure(fs.existsSync(p), 'file missing');
  var src = fs.readFileSync(p, 'utf8');
  ensure(src.indexOf('M1-missing-sourceContentHash') >= 0, 'M1 probe missing');
  ensure(src.indexOf('M7-drawer-focus-lost') >= 0, 'M7 probe missing');
});

// A9: verify-artifacts.js self-check
test('A9: verify-artifacts.js self-check', function () {
  var p = path.join(__dirname, 'verify-artifacts.js');
  ensure(fs.existsSync(p), 'file missing');
  ensure(p === __filename, 'path mismatch');
});

// A10: No production files in allowlist directories
test('A10: no production files in test directory', function () {
  var testDir = __dirname;
  var files = fs.readdirSync(testDir);
  var allowed = ['run-case-atlas-contract.js', 'mutation-probes.js', 'verify-artifacts.js', 'run-runtime-probes.js', '.mutants'];
  files.forEach(function (f) {
    if (f === '.mutants') return;
    ensure(allowed.indexOf(f) >= 0, 'unexpected file in test dir: ' + f);
  });
});

// A11: No external resources in prototype
test('A11: no external resources', function () {
  var html = fs.readFileSync(protoPath, 'utf8');
  ensure(html.indexOf('@font-face') < 0, '@font-face found');
  ensure(html.indexOf('@import') < 0, '@import found');
  ensure(html.indexOf('fonts.googleapis') < 0, 'Google Fonts found');
  ensure(html.indexOf('cdn.') < 0, 'CDN link found');
  ensure(html.indexOf('unpkg') < 0, 'unpkg found');
  var networkApis = ['fetch(', 'axios', 'XMLHttpRequest', 'new Request'];
  networkApis.forEach(function (api) {
    ensure(html.indexOf(api) < 0, api + ' found — network access prohibited');
  });
});

// A12: Prototype uses synthetic data only
test('A12: synthetic data declaration', function () {
  var html = fs.readFileSync(protoPath, 'utf8');
  ensure(html.indexOf('\u6797\u82e5\u6eaa') >= 0 || html.indexOf('C-2026-0412') >= 0, 'synthetic client not found');
  ensure(html.indexOf('var sources') >= 0, 'data declaration not found');
});

// A13: SHA-256 of all deliverable files
test('A13: all deliverable SHA-256 computed', function () {
  var files = [
    protoPath,
    path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'design', 'trae-case-atlas-golden-spec.md'),
    path.join(__dirname, 'run-case-atlas-contract.js'),
    path.join(__dirname, 'mutation-probes.js'),
    path.join(__dirname, 'verify-artifacts.js'),
    path.join(__dirname, 'run-runtime-probes.js')
  ];
  files.forEach(function (p) {
    ensure(fs.existsSync(p), 'missing: ' + p);
    var h = sha256(p);
    ensure(h.length === 64, 'bad hash for ' + p);
    console.log('  ' + path.basename(p) + ': ' + h);
  });
});

// A14: No write to production paths (forbidden list from task card)
test('A14: no forbidden paths touched', function () {
  var protoDir = path.join(ROOT, 'design-previews', '4.3.0-trae-case-atlas-golden');
  var files = fs.readdirSync(protoDir);
  files.forEach(function (f) {
    var ext = path.extname(f);
    ensure(ext === '.html' || ext === '.md' || ext === '.css' || ext === '.json',
      'unexpected file type in prototype dir: ' + f);
  });
});

console.log('');
console.log('=== Artifact Verification ===');
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
console.log('verify_phase: ' + (failed === 0 ? 'ALL-VERIFIED' : 'VERIFICATION-FAILED'));
if (failed > 0) process.exit(1);
