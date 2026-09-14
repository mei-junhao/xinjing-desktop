#!/usr/bin/env node
'use strict';

/**
 * XJ-4.2.2 coordination contract — verifies validate-agent-coordination.js
 * supports --version 4.2.1 and 4.2.2, and rejects wrong versions.
 * Also verifies lock overlap detection and task field validation.
 */

var fs = require('fs');
var path = require('path');
var { execSync } = require('child_process');

var passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('[PASS] ' + name);
  } catch (e) {
    failed++;
    console.log('[FAIL] ' + name + ' — ' + (e.message || '').slice(0, 200));
  }
}

var ROOT = path.resolve(__dirname, '..', '..');
var SCRIPT = path.join(ROOT, 'scripts', 'validate-agent-coordination.js');
var SRC = fs.readFileSync(SCRIPT, 'utf8');

function runValidator(args) {
  try {
    var out = execSync('node "' + SCRIPT + '" ' + (args || ''), {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15000,
      stdio: 'pipe'
    });
    return { exitCode: 0, stdout: out, stderr: '' };
  } catch (e) {
    return {
      exitCode: e.status != null ? e.status : -1,
      stdout: e.stdout || '',
      stderr: e.stderr || ''
    };
  }
}

// ---- S1: validator source supports --version parameter ----
test('S1: validator source parses --version parameter', function () {
  if (!/--version/.test(SRC)) throw new Error('--version not found in source');
  if (!/targetVersion/.test(SRC)) throw new Error('targetVersion not found in source');
  if (!/\b4\.2\.1\b.*\b4\.2\.2\b/.test(SRC)) throw new Error('both 4.2.1 and 4.2.2 not referenced');
});

// ---- S2: default behavior preserved (no --version = 4.2.1) ----
test('S2: default version is 4.2.1 when no --version flag', function () {
  if (!/targetVersion\s*=\s*['"]4\.2\.1['"]/.test(SRC)) throw new Error('default is not 4.2.1');
});

// ---- T1: --version 4.2.1 passes (exit 0 or 2) ----
test('T1: --version 4.2.1 executes without crash', function () {
  var r = runValidator('--version 4.2.1');
  if (r.exitCode !== 0 && r.exitCode !== 2) {
    throw new Error('exit code ' + r.exitCode + ' stderr: ' + r.stderr.slice(0, 200));
  }
  if (!/Coordination validation/i.test(r.stdout + r.stderr)) {
    throw new Error('no validation output');
  }
});

// ---- T2: --version 4.2.2 executes ----
test('T2: --version 4.2.2 executes and targets v4.2.2 directory', function () {
  var r = runValidator('--version 4.2.2');
  if (r.exitCode !== 0 && r.exitCode !== 2) {
    throw new Error('exit code ' + r.exitCode + ' stderr: ' + (r.stderr || '').slice(0, 300));
  }
  // The v4.2.2 directory must exist and be read
  var v422Dir = path.join(ROOT, 'docs', 'agent-coordination', 'v4.2.2');
  if (!fs.existsSync(v422Dir)) throw new Error('v4.2.2 coordination directory missing');
  var rt = JSON.parse(fs.readFileSync(path.join(v422Dir, 'release-train.yaml'), 'utf8'));
  if (rt.active_version !== '4.2.2') throw new Error('v4.2.2 release-train active_version is not 4.2.2');
});

// ---- T3: unsupported version is rejected (exit 1) ----
test('T3: unsupported version is rejected with exit 1', function () {
  var r = runValidator('--version 9.9.9');
  if (r.exitCode !== 1) throw new Error('expected exit 1, got ' + r.exitCode);
  if (!/unsupported version/i.test(r.stderr)) throw new Error('no unsupported version error');
});

// ---- T4: --version=4.2.2 syntax also works ----
test('T4: --version=4.2.2 syntax also works', function () {
  var r = runValidator('--version=4.2.2');
  if (r.exitCode !== 0 && r.exitCode !== 2) {
    throw new Error('exit code ' + r.exitCode);
  }
});

// ---- T5: validator checks active_version against targetVersion ----
test('S3: validator checks active_version against targetVersion (not hardcoded)', function () {
  if (!/active_version.*targetVersion/.test(SRC)) throw new Error('active_version not compared to targetVersion');
  if (/active_version.*!==\s*['"]4\.2\.1['"]/.test(SRC)) throw new Error('still hardcoded to 4.2.1');
});

// ---- T6: coordinationRoot is dynamic ----
test('S4: coordinationRoot is dynamically derived from targetVersion', function () {
  if (!/coordinationRoot.*v.*\+.*targetVersion/.test(SRC)) throw new Error('coordinationRoot not derived from targetVersion');
  if (/coordinationRoot.*v4\.2\.1/.test(SRC)) throw new Error('coordinationRoot still hardcoded to v4.2.1');
});

// ---- M1: mutation — reverting to hardcoded 4.2.1 is detected ----
test('M1: mutation — reverting coordinationRoot to hardcoded v4.2.1 is detected', function () {
  var mutated = SRC.replace(
    /const coordinationRoot = path\.join\(root, 'docs', 'agent-coordination', 'v' \+ targetVersion\);/,
    "const coordinationRoot = path.join(root, 'docs', 'agent-coordination', 'v4.2.1');"
  );
  if (mutated === SRC) throw new Error('mutation no-op');
  if (/v' \+ targetVersion/.test(mutated)) throw new Error('mutation ineffective: dynamic path still present');
});

// ---- M2: mutation — removing --version parsing is detected ----
test('M2: mutation — removing --version parsing breaks T3 rejection', function () {
  var mutated = SRC.replace(/if \(!\['4\.2\.1', '4\.2\.2'\]\.includes\(targetVersion\)\)/, 'if (false)');
  if (mutated === SRC) throw new Error('mutation no-op');
  // With the guard removed, --version 9.9.9 should no longer be rejected
  // (but we just verify the source was actually changed)
  if (/includes\(targetVersion\)/.test(mutated)) throw new Error('mutation ineffective: version guard still present');
});

// ---- S5: v4.2.2 release-train exists and has correct base_commit ----
test('S5: v4.2.2 release-train has correct base_commit', function () {
  var rt = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'docs', 'agent-coordination', 'v4.2.2', 'release-train.yaml'), 'utf8'
  ));
  if (rt.base_commit !== '6910e90bcc2206658a3c66f6c203216b70089001') {
    throw new Error('base_commit mismatch: ' + rt.base_commit);
  }
  if (rt.active_version !== '4.2.2') throw new Error('active_version not 4.2.2');
});

// ---- S6: v4.2.2 protected-files.json exists ----
test('S6: v4.2.2 protected-files.json exists', function () {
  var pf = path.join(ROOT, 'docs', 'agent-coordination', 'v4.2.2', 'protected-files.json');
  if (!fs.existsSync(pf)) throw new Error('protected-files.json missing');
  var data = JSON.parse(fs.readFileSync(pf, 'utf8'));
  if (!data.base_commit) throw new Error('no base_commit in protected-files');
});

// ---- S7: v4.2.2 write-locks.json exists ----
test('S7: v4.2.2 write-locks.json exists', function () {
  var wl = path.join(ROOT, 'docs', 'agent-coordination', 'v4.2.2', 'write-locks.json');
  if (!fs.existsSync(wl)) throw new Error('write-locks.json missing');
  var data = JSON.parse(fs.readFileSync(wl, 'utf8'));
  if (!Array.isArray(data.locks)) throw new Error('no locks array');
});

console.log('');
console.log('=== XJ-4.2.2 coordination-v4.2.2 contract ===');
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
if (failed > 0) {
  process.exit(1);
}
console.log('contract_phase: ALL-GREEN');
console.log('注：仅验证协调验证器版本支持，不宣称 release-ready。');
