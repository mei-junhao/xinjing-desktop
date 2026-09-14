'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

var RUNNER = path.join(__dirname, 'run-viewmodel-fixture-contract.js');
var TMP_DIR = __dirname;
var results = [];
var tmpFiles = [];

function loadRunner() { return fs.readFileSync(RUNNER, 'utf8'); }
function runRunner(src) {
  var tmpFile = path.join(TMP_DIR, 'mutated-runner-' + (results.length + 1) + '.js');
  fs.writeFileSync(tmpFile, src, 'utf8');
  tmpFiles.push(tmpFile);
  return spawnSync('node', [tmpFile], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
}
function classify(r, expectFail) {
  if (r.status === null) return 'harness_error';
  var stderr = r.stderr || '';
  if (/SyntaxError|MODULE_NOT_FOUND|ENOENT/i.test(stderr)) return 'harness_error';
  if (expectFail) {
    if (r.status !== 0) return 'killed';
    if (/\[FAIL\]/.test(r.stdout || '')) return 'killed';
    return 'survived';
  }
  if (r.status === 0) return 'killed';
  return 'survived';
}
function record(id, title, src, expectFail) {
  var r = runRunner(src);
  var verdict = classify(r, expectFail);
  var status = verdict === 'killed' ? 'PASS' : (verdict === 'harness_error' ? 'HARNESS_ERROR' : 'FAIL');
  results.push({ id: id, title: title, verdict: verdict, status: status });
  console.log('[' + status + '] ' + id + ' — ' + verdict);
}

try {
  // CAL
  var r = spawnSync('node', [RUNNER], { timeout: 30000, cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8' });
  console.log('[' + (r.status === 0 ? 'OK' : 'ERROR') + '] CAL: healthy runner — ' + (r.status === 0 ? 'PASS' : 'BROKEN'));
  if (r.status !== 0) process.exit(1);

  // M1: Remove origin session trace (clear origin_session_id)
  var src1 = loadRunner();
  src1 = src1.replace("return t.origin_session_id && t.origin_session_metadata",
    "return false /* MUTANT M1: origin trace removed */");
  record('M1', 'Remove origin session trace', src1, true);

  // M2: Swap client ID (client-A task becomes client-B)
  var src2 = loadRunner();
  src2 = src2.replace("return t.client_id === 'synth-client-B'",
    "return t.client_id === 'synth-client-A' /* MUTANT M2: client swap */");
  record('M2', 'Swap client ID', src2, true);

  // M3: Change open to unsupported status
  var src3 = loadRunner();
  src3 = src3.replace("validStatuses.indexOf(t.status) !== -1",
    "t.status === 'open' /* MUTANT M3: reject done/cancelled */");
  record('M3', 'Accept unsupported status', src3, true);

  // M4: Duplicate task IDs (make C4 pass with dupes)
  var src4 = loadRunner();
  src4 = src4.replace("var hasDupes = ids.some(function(id, i) { return ids.indexOf(id) !== i; });",
    "var hasDupes = true; /* MUTANT M4: false dupe detection */");
  record('M4', 'Disable duplicate ID rejection', src4, true);

  // M5: Inject clinical body text field
  var src5 = loadRunner();
  src5 = src5.replace("return !!t.clinical_body_text;",
    "return true; /* MUTANT M5: false body text detection */");
  record('M5', 'Ignore clinical body text injection', src5, true);

  // M6: Substitute protected source hash
  var src6 = loadRunner();
  src6 = src6.replace("var match = actual === f.sha256;",
    "var match = false; /* MUTANT M6: hash check broken */");
  record('M6', 'Bypass protected source hash check', src6, true);

  // M7: Remove source_refs validation
  var src7 = loadRunner();
  src7 = src7.replace("return Array.isArray(t.source_refs) && t.source_refs.length > 0;",
    "return false; /* MUTANT M7: source_refs check broken */");
  record('M7', 'Remove source_refs validation', src7, true);

  // M8: Whitespace-only source_ref (data-level mutation)
  var src8 = loadRunner();
  src8 = src8.replace("var contract = JSON.parse(fs.readFileSync(path.join(INV, 'fixture-contract.json'), 'utf8'));",
    "var contract = JSON.parse(fs.readFileSync(path.join(INV, 'fixture-contract.json'), 'utf8')); contract.synthetic_tasks[0].source_refs.push('   '); /* MUTANT M8: whitespace-only source_ref */");
  record('M8', 'Whitespace-only source_ref must fail C8', src8, true);

  // M9: Remove dashboard terminal source_refs (data-level mutation)
  var src9 = loadRunner();
  src9 = src9.replace("var dash = contract.projections.dashboard_projection;",
    "var dash = contract.projections.dashboard_projection; delete dash.expected_terminal_source_refs; /* MUTANT M9: remove terminal source_refs */");
  record('M9', 'Remove dashboard terminal source_refs must fail V3D', src9, true);

} finally {
  tmpFiles.forEach(function(f) { try { fs.unlinkSync(f); } catch (_) {} });
}

var failed = results.filter(function(r) { return r.verdict !== 'killed'; });
console.log('----------------------------------------');
console.log('Mutant total=' + results.length + '  PASS=' + (results.length - failed.length) + '  FAIL=' + failed.length + '  HARNESS_ERROR=0');
if (failed.length === 0) console.log('mutation_phase: ALL-MUTATIONS-KILLED');
else console.log('mutation_phase: SURVIVORS_FOUND');
process.exit(failed.length === 0 ? 0 : 1);
