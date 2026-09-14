'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

var RUNNER = path.join(__dirname, 'run-case-space-view-model.js');
var PROD_MODULE = path.join(__dirname, '..', '..', '..', 'app', 'js', 'case-space-view-model.js');
var TMP_DIR = __dirname;
var results = [];
var tmpFiles = [];

function loadModule() { return fs.readFileSync(PROD_MODULE, 'utf8'); }
function loadRunner() { return fs.readFileSync(RUNNER, 'utf8'); }
function saveModule(src) {
  var tmpFile = path.join(TMP_DIR, 'mutated-module-' + (results.length + 1) + '.js');
  fs.writeFileSync(tmpFile, src, 'utf8');
  tmpFiles.push(tmpFile);
  // Replace the production module with the mutated version for the test
  fs.copyFileSync(PROD_MODULE, PROD_MODULE + '.backup');
  fs.writeFileSync(PROD_MODULE, src, 'utf8');
}
function restoreModule() {
  if (fs.existsSync(PROD_MODULE + '.backup')) {
    fs.copyFileSync(PROD_MODULE + '.backup', PROD_MODULE);
    fs.unlinkSync(PROD_MODULE + '.backup');
  }
}

function runRunner(expectFail) {
  var r = spawnSync('node', [RUNNER], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
  return r;
}

function classify(r, expectFail) {
  if (r.status === null) return 'harness_error';
  var stderr = r.stderr || '';
  var stdout = r.stdout || '';
  if (/Cannot find module|ENOENT|MODULE_NOT_FOUND|SyntaxError|throw new TypeError/i.test(stderr)) return 'harness_error';
  if (r.status === 0 && /\[FAIL\]/.test(stdout) && expectFail) return 'killed';
  if (r.status === 0 && !expectFail) return 'killed';
  if (r.status !== 0 && expectFail) return 'killed';
  if (r.status === 0 && expectFail) return 'survived';
  return 'survived';
}
function record(id, title, expectFail) {
  var r = runRunner(expectFail);
  restoreModule();
  var verdict = classify(r, expectFail);
  var status = verdict === 'killed' ? 'PASS' : (verdict === 'harness_error' ? 'HARNESS_ERROR' : 'FAIL');
  results.push({ id: id, title: title, verdict: verdict, status: status });
  console.log('[' + status + '] ' + id + ' — ' + verdict);
}

try {
  // CAL: healthy runner
  (function cal() {
    var r = spawnSync('node', [RUNNER], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
    var ok = r.status === 0;
    console.log('[' + (ok ? 'OK' : 'ERROR') + '] CAL: healthy runner — ' + (ok ? 'PASS' : 'BROKEN'));
    if (!ok) { console.error('HALT'); process.exit(1); }
  })();

  // M1: Ignore unknown client (remove fail-closed check)
  var src1 = loadModule();
  src1 = src1.replace(
    "if (!client) {\r\n          cleanup();\r\n          resolve(emptyModel('unknown-client'));\r\n          return;\r\n        }",
    "if (!client) {\r\n          cleanup();\r\n          resolve(okModel({ version: 'case-space-v1', clientId: clientId, nodes: Object.freeze([]), edges: Object.freeze([]), rejected: Object.freeze([]), counts: Object.freeze({ sessions: 0, materials: 0, supervisions: 0, actionRuns: 0, rejected: 0 }), sourceStatus: 'unverified' }));\r\n          return;\r\n        } /* MUTANT */"
  );
  saveModule(src1);
  record('M1', 'Ignore unknown client', true);

  // M2: Skip cancelled abort (return okModel instead of emptyModel)
  var src2 = loadModule();
  // Replace pre-Promise check (no cleanup)
  src2 = src2.replace(
    "if (signal && signal.aborted) return Promise.resolve(emptyModel('cancelled'));",
    "if (signal && signal.aborted) return Promise.resolve(okModel({ version: 'case-space-v1', clientId: clientId, nodes: Object.freeze([]), edges: Object.freeze([]), rejected: Object.freeze([]), counts: Object.freeze({ sessions: 0, materials: 0, supervisions: 0, actionRuns: 0, rejected: 0 }), sourceStatus: 'unverified' })); /* MUTANT */"
  );
  // Replace all mid-Promise checks (with cleanup)
  var M2_SEARCH = "if (signal.aborted) { cleanup(); resolve(emptyModel('cancelled')); return; }";
  var M2_REPLACE = "if (signal.aborted) { cleanup(); resolve(okModel({ version: 'case-space-v1', clientId: clientId, nodes: Object.freeze([]), edges: Object.freeze([]), rejected: Object.freeze([]), counts: Object.freeze({ sessions: 0, materials: 0, supervisions: 0, actionRuns: 0, rejected: 0 }), sourceStatus: 'unverified' })); return; } /* MUTANT */";
  var idx = src2.indexOf(M2_SEARCH);
  while (idx !== -1) {
    src2 = src2.substring(0, idx) + M2_REPLACE + src2.substring(idx + M2_SEARCH.length);
    idx = src2.indexOf(M2_SEARCH, idx + M2_REPLACE.length);
  }
  saveModule(src2);
  record('M2', 'Skip cancelled signal', true);

  // M3: Accept cross-session material (remove rejection)
  var src3 = loadModule();
  var crossSessionGate = /if \(!material\.sessionId \|\| !sessionIds\.has\(material\.sessionId\)\) return \{ admitted: false, reason: 'cross-session' \};/;
  if (!crossSessionGate.test(src3)) throw new Error('M3 mutation target missing');
  src3 = src3.replace(crossSessionGate, "if (!material.sessionId || !sessionIds.has(material.sessionId)) return { admitted: true, sourceRef: null }; /* MUTANT */");
  saveModule(src3);
  record('M3', 'Accept cross-session material', true);

  // M4: Accept context mismatch (return okModel instead of emptyModel)
  var src4 = loadModule();
  src4 = src4.replace(
    "if (currentContext && currentContext.clientId && currentContext.clientId !== clientId) {\r\n      return Promise.resolve(emptyModel('context-mismatch'));\r\n    }",
    "if (currentContext && currentContext.clientId && currentContext.clientId !== clientId) {\r\n      return Promise.resolve(okModel({ version: 'case-space-v1', clientId: clientId, nodes: Object.freeze([]), edges: Object.freeze([]), rejected: Object.freeze([]), counts: Object.freeze({ sessions: 0, materials: 0, supervisions: 0, actionRuns: 0, rejected: 0 }), sourceStatus: 'unverified' }));\r\n    } /* MUTANT */"
  );
  saveModule(src4);
  record('M4', 'Accept context mismatch', true);

  // M5: Accept shared references (deep-clone instead of freeze)
  var src5 = loadModule();
  src5 = src5.replace("Object.freeze(model)", "model /* MUTANT: no freeze */");
  saveModule(src5);
  record('M5', 'Accept shared references', true);

  // M6: Mark AI draft as false (remove AI detection)
  var src6 = loadModule();
  src6 = src6.replace("aiDraft: !!(sv.isAiDraft || sv.aiDraft)", "aiDraft: false /* MUTANT */");
  src6 = src6.replace("aiDraft: !!(m.isAiDraft || m.aiDraft)", "aiDraft: false /* MUTANT */");
  src6 = src6.replace("aiDraft: !!(ar.isAiDraft || ar.aiDraft)", "aiDraft: false /* MUTANT */");
  saveModule(src6);
  record('M6', 'Mark AI draft as false', true);

  // M7: Swallow exit code (runner assertion)
  var src7 = loadRunner();
  var tmpFile = path.join(TMP_DIR, 'mutated-runner-' + (results.length + 1) + '.js');
  fs.writeFileSync(tmpFile, src7.replace("process.exit(passed === total ? 0 : 1);", "check('M7_INJECTED', 'injected fail', false); process.exit(0);"), 'utf8');
  tmpFiles.push(tmpFile);
  var r7 = spawnSync('node', [tmpFile], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
  var v7 = classify(r7, true);
  results.push({ id: 'M7', title: 'Swallow exit code', verdict: v7, status: v7 === 'killed' ? 'PASS' : (v7 === 'harness_error' ? 'HARNESS_ERROR' : 'FAIL') });
  console.log('[' + (v7 === 'killed' ? 'PASS' : 'FAIL') + '] M7 — ' + v7);

} finally {
  restoreModule();
  tmpFiles.forEach(function(f) { try { fs.unlinkSync(f); } catch(e) {} });
  var orphans = fs.readdirSync(TMP_DIR).filter(function(f) { return /^mutated/.test(f); });
  orphans.forEach(function(f) { try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch(e) {} });
  var residue = fs.readdirSync(TMP_DIR).filter(function(f) { return /^mutated/.test(f); });
  if (residue.length > 0) console.error('CLEANUP FAIL: ' + residue.length + ' files remain');
  else console.log('[OK] CLEANUP: zero residue');
}

var passed = results.filter(function(r) { return r.status === 'PASS'; }).length;
var failed = results.filter(function(r) { return r.status === 'FAIL'; }).length;
var harnessErrors = results.filter(function(r) { return r.status === 'HARNESS_ERROR'; }).length;
console.log('----------------------------------------');
console.log('Mutant total=' + results.length + '  PASS=' + passed + '  FAIL=' + failed + '  HARNESS_ERROR=' + harnessErrors);
console.log('mutation_phase: ' + (failed === 0 && harnessErrors === 0 ? 'ALL-MUTATIONS-KILLED' : 'CONTRACT-BROKEN'));
process.exit(failed === 0 && harnessErrors === 0 ? 0 : 1);
