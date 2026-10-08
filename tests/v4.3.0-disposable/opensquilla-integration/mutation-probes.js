'use strict';
/**
 * XJ-4.3.0-opensquilla-source-graph-harness-rework-02
 * REAL mutation probes: each mutant writes a real file next to its original
 * (so require() resolves correctly), passes syntax check, loads correctly,
 * then runs a contract test in a subprocess. Only contract FAILURE (non-zero
 * exit with CONTRACT_FAIL) counts as KILLED.
 * Syntax-error, no-op, module-load-error, harness-error are classified as ERROR.
 *
 * Anti-patterns eliminated:
 *   - probe() counting any throw as KILLED (now uses subprocess exit code)
 *   - String-existence checks instead of behavioral validation
 *   - Active throw in callback instead of contract execution
 *   - Bare return inside contract runner (now uses IIFE + Promise detection)
 *   - Mutant files in subdirectory that break require() resolution
 *   - CRLF causing no-op replacements (now uses readNormalized)
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROJ_PATH = path.resolve(ROOT, 'design-previews', '4.3.0-opensquilla-atlas-integration', 'source-graph-projection.js');
const ADAPTER_PATH = path.resolve(ROOT, 'design-previews', '4.3.0-opensquilla-atlas-integration', 'source-boundary-adapter.js');
const FIXTURES_PATH = path.join(__dirname, 'fixtures.js');

function readNormalized(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }
var PROJ_SRC = readNormalized(PROJ_PATH);
var ADAPTER_SRC = readNormalized(ADAPTER_PATH);
var FIXTURES_SRC = readNormalized(FIXTURES_PATH);

var killed = 0, survived = 0, errors = 0;
var errorDetails = [];
var writtenPaths = [];

function writeMutant(originalPath, mutantSrc, label) {
  var mutantPath = originalPath.replace(/\.js$/, '.mutated.' + label + '.js');
  fs.writeFileSync(mutantPath, mutantSrc, 'utf8');
  writtenPaths.push(mutantPath);
  return mutantPath;
}

function syntaxCheck(filePath) {
  try { execSync('node --check "' + filePath + '"', { stdio: 'pipe', timeout: 5000 }); return true; }
  catch (_) { return false; }
}

function runContract(runnerPath) {
  try {
    var out = execSync('node "' + runnerPath + '"', { stdio: 'pipe', timeout: 15000, cwd: ROOT });
    return { status: 'pass', exitCode: 0, output: out.toString() };
  } catch (e) {
    return { status: 'fail', exitCode: e.status || 1, output: ((e.stdout || '').toString() + (e.stderr || '').toString()) };
  }
}

function cleanup() {
  writtenPaths.forEach(function (p) { try { fs.unlinkSync(p); } catch (_) {} });
  var dirs = [path.dirname(PROJ_PATH), __dirname];
  dirs.forEach(function (d) {
    try { fs.readdirSync(d).forEach(function (f) {
      if (f.indexOf('.mutated.') >= 0 || f.indexOf('runner_') >= 0 || f.indexOf('calibrate_') >= 0) {
        try { fs.unlinkSync(path.join(d, f)); } catch (_) {}
      }
    }); } catch (_) {}
  });
}
process.on('exit', cleanup);
process.on('SIGINT', function () { cleanup(); process.exit(1); });

// ── Unified runner: handles both sync and async assertions ──
function makeRunner(mutantPath, assertions, moduleType) {
  var requires = "var FIXTURES = require(" + JSON.stringify(FIXTURES_PATH) + ");";
  if (moduleType === 'adapter') {
    requires += "\nvar ADAPTER_FACTORY = require(" + JSON.stringify(mutantPath) + ");";
    requires += "\nvar PROJ = require(" + JSON.stringify(PROJ_PATH) + ");";
  } else if (moduleType === 'fixtures') {
    requires = "var FIXTURES = require(" + JSON.stringify(mutantPath) + ");";
  } else {
    requires += "\nvar PROJ = require(" + JSON.stringify(mutantPath) + ");";
  }
  return [
    "'use strict';",
    requires,
    "function ensure(c, m) { if (!c) throw new Error(m); }",
    "try {",
    "  var __r = (function() { " + assertions + " })();",
    "  if (__r && typeof __r.then === 'function') {",
    "    __r.then(function() { console.log('CONTRACT_PASS'); process.exit(0); })",
    "    .catch(function(e) { console.log('CONTRACT_FAIL: ' + (e.message || '').slice(0, 200)); process.exit(1); });",
    "  } else {",
    "    console.log('CONTRACT_PASS'); process.exit(0);",
    "  }",
    "} catch (e) { console.log('CONTRACT_FAIL: ' + (e.message || '').slice(0, 200)); process.exit(1); }"
  ].join('\n');
}

function runMutant(label, originalPath, mutatedSrc, assertions, moduleType) {
  var origSrc = readNormalized(originalPath);

  // Step 0: no-op check
  if (mutatedSrc === origSrc) {
    errors++; errorDetails.push(label + ':no-op');
    console.log('  [ERROR:noop] ' + label);
    return;
  }

  // Step 1: write mutant next to original
  var mutantPath = writeMutant(originalPath, mutatedSrc, label.replace(/[^a-zA-Z0-9]/g, '_'));

  // Step 2: syntax check mutant
  if (!syntaxCheck(mutantPath)) {
    errors++; errorDetails.push(label + ':syntax-error');
    console.log('  [ERROR:syntax] ' + label);
    return;
  }

  // Step 3: build and syntax-check runner
  var runnerCode = makeRunner(mutantPath, assertions, moduleType);
  var runnerPath = path.join(__dirname, 'runner_' + label.replace(/[^a-zA-Z0-9]/g, '_') + '.js');
  fs.writeFileSync(runnerPath, runnerCode, 'utf8');
  writtenPaths.push(runnerPath);
  if (!syntaxCheck(runnerPath)) {
    errors++; errorDetails.push(label + ':runner-syntax-error');
    console.log('  [ERROR:harness] ' + label);
    return;
  }

  // Step 4: run contract in subprocess
  var result = runContract(runnerPath);
  if (result.status === 'pass') {
    survived++; console.log('  [SURVIVED] ' + label);
    return;
  }

  // Step 5: classify failure
  if (result.output.indexOf('Cannot find module') >= 0 || result.output.indexOf('MODULE_NOT_FOUND') >= 0) {
    errors++; errorDetails.push(label + ':module-load-error');
    console.log('  [ERROR:load] ' + label);
    return;
  }
  if (result.output.indexOf('CONTRACT_FAIL') < 0 && result.output.indexOf('CONTRACT_PASS') < 0) {
    errors++; errorDetails.push(label + ':harness-error');
    console.log('  [ERROR:harness] ' + label + ' — ' + result.output.slice(0, 80).replace(/\n/g, ' '));
    return;
  }

  killed++;
  var failLines = result.output.split('\n').filter(function (l) {
    return l.indexOf('CONTRACT_FAIL') >= 0;
  }).slice(0, 2);
  console.log('  [KILLED] ' + label + ' — ' + (failLines.join(' | ') || ('exit=' + result.exitCode)).slice(0, 120));
}

// ── Calibration suite ──
function calibrate() {
  console.log('--- Calibration ---');

  // C1: Healthy projection must pass
  var h1 = makeRunner(PROJ_PATH, "var vm = PROJ.createViewModel(FIXTURES); ensure(vm.nodes.length > 0, 'no nodes'); var val = PROJ.validateViewModel(vm); ensure(val.ok, 'validation failed: ' + (val.issues||[]).join(','))", 'projection');
  var p1 = path.join(__dirname, 'calibrate_healthy_proj.js'); fs.writeFileSync(p1, h1, 'utf8'); writtenPaths.push(p1);
  var r1 = runContract(p1);
  if (r1.status === 'pass') console.log('  [OK] Healthy projection PASS');
  else { console.log('  [FATAL] Healthy projection failed: ' + r1.output.slice(0, 200)); process.exit(1); }

  // C2: Healthy adapter must pass
  var h2 = makeRunner(ADAPTER_PATH, "var a = ADAPTER_FACTORY.createAdapter(); var r = a.projectSync('synth-client-alpha', FIXTURES); ensure(r.ok, 'projection failed')", 'adapter');
  var p2 = path.join(__dirname, 'calibrate_healthy_adapt.js'); fs.writeFileSync(p2, h2, 'utf8'); writtenPaths.push(p2);
  var r2 = runContract(p2);
  if (r2.status === 'pass') console.log('  [OK] Healthy adapter PASS');
  else { console.log('  [FATAL] Healthy adapter failed: ' + r2.output.slice(0, 200)); process.exit(1); }

  // C3: Known mutant must fail
  var h3 = makeRunner(PROJ_PATH, "PROJ.createViewModel(null)", 'projection');
  var p3 = path.join(__dirname, 'calibrate_mutant.js'); fs.writeFileSync(p3, h3, 'utf8'); writtenPaths.push(p3);
  var r3 = runContract(p3);
  if (r3.status === 'fail' && r3.output.indexOf('CONTRACT_FAIL') >= 0) console.log('  [OK] Known mutant KILLED (exit ' + r3.exitCode + ')');
  else { console.log('  [FATAL] Known mutant should have failed'); process.exit(1); }

  // C4: No-op detection
  if (PROJ_SRC === readNormalized(PROJ_PATH)) console.log('  [OK] No-op detection: identical source identified');
  else { console.log('  [FATAL] No-op detection broken'); process.exit(1); }

  // C5: Syntax-error detection
  var p5 = path.join(__dirname, 'calibrate_syntax.js'); fs.writeFileSync(p5, 'var x = {', 'utf8'); writtenPaths.push(p5);
  if (!syntaxCheck(p5)) console.log('  [OK] Syntax-error detection: caught');
  else { console.log('  [FATAL] Syntax error should have been caught'); process.exit(1); }

  console.log('');
}

// ══════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════
console.log('\n--- Mutation Probes ---');
calibrate();

// M1: Remove await from projectAsync
runMutant('M1:remove-await', ADAPTER_PATH,
  ADAPTER_SRC.replace('await Promise.all', 'Promise.all'),
  "var a = ADAPTER_FACTORY.createAdapter(); " +
  "var resolvers = [function() { return new Promise(function(r) { setTimeout(function(){ r({nodeId:'n1'}); }, 50); }); }]; " +
  "return a.projectAsync('synth-client-alpha', FIXTURES, resolvers).then(function(r) { " +
  "  ensure(r.resolverCount === 1, 'resolver not counted: ' + r.resolverCount); " +
  "})",
  'adapter');

// M2: Early partial return — bypass fixture validation
runMutant('M2:early-partial', PROJ_PATH,
  PROJ_SRC.replace(
    "if (!fixtures || !fixtures.clients || !fixtures.sessions) throw new Error('createViewModel: invalid fixtures');",
    "if (!fixtures || !fixtures.clients || !fixtures.sessions) return { nodes: [], edges: [], aiPreviewEdges: [], timeline: [], clientProjections: {}, stats: { totalNodes:0, totalEdges:0, aiPreviewCount:0, clientCount:0, sessionCount:0 } };"
  ),
  "try { PROJ.createViewModel(null); ensure(false, 'null input should throw'); } catch(e) { ensure(e.message.indexOf('createViewModel') >= 0 || e.message.indexOf('invalid') >= 0, 'wrong error: ' + e.message); }",
  'projection');

// M3: Skip sourceContentHash validation
runMutant('M3:drop-source-hash', PROJ_PATH,
  PROJ_SRC.replace(
    "if (!isString(node.sourceRef.sourceContentHash)) issues.push('node[' + i + '].sourceRef.sourceContentHash missing');",
    "// M3: sourceContentHash check removed"
  ),
  "var vm = PROJ.createViewModel(FIXTURES); " +
  "vm.nodes.push({ id: 'bad', type: 'quote', clientId: 'c', sessionId: 's', " +
  "  sourceRef: { id: 'sr:bad', sourceContentHash: '', anchorContentHash: 'h', normalizationVersion: '1', sourceVersion: '1' }, " +
  "  label: 'b', summary: 'b', truncated: false, isAiDraft: false, isConfirmed: true }); " +
  "var val = PROJ.validateViewModel(vm); ensure(!val.ok, 'hashless node should fail validation')",
  'projection');

// M4: Skip anchorContentHash validation
runMutant('M4:drop-anchor-hash', PROJ_PATH,
  PROJ_SRC.replace(
    "if (!isString(node.sourceRef.anchorContentHash)) issues.push('node[' + i + '].sourceRef.anchorContentHash missing');",
    "// M4: anchorContentHash check removed"
  ),
  "var vm = PROJ.createViewModel(FIXTURES); " +
  "vm.nodes.push({ id: 'bad2', type: 'quote', clientId: 'c', sessionId: 's', " +
  "  sourceRef: { id: 'sr:bad2', sourceContentHash: 'h', anchorContentHash: '', normalizationVersion: '1', sourceVersion: '1' }, " +
  "  label: 'b', summary: 'b', truncated: false, isAiDraft: false, isConfirmed: true }); " +
  "var val = PROJ.validateViewModel(vm); ensure(!val.ok, 'anchorless node should fail validation')",
  'projection');

// M5: Permit cross-client material — remove clientId filter
runMutant('M5:cross-client-permit', ADAPTER_PATH,
  ADAPTER_SRC.replace("return n.clientId === clientId;", "return true; // M5: cross-client filter removed"),
  "var a = ADAPTER_FACTORY.createAdapter(); " +
  "var projA = a.projectSync('synth-client-alpha', FIXTURES); " +
  "var leaked = projA.nodes.filter(function(n) { return n.clientId === 'synth-client-beta'; }); " +
  "ensure(leaked.length === 0, 'cross-client data leaked: ' + leaked.length)",
  'adapter');

// M6: Allow stale override — remove newer-projection check
runMutant('M6:stale-override', ADAPTER_PATH,
  ADAPTER_SRC.replace(
    "if (externalSnapshot && externalSnapshot.generation && externalSnapshot.generation > generation) {",
    "if (false) { // M6: stale check disabled"
  ),
  "var a = ADAPTER_FACTORY.createAdapter(); " +
  "var externalSnapshot = { generation: 999 }; " +
  "var slowResolver = function() { return new Promise(function(r) { setTimeout(function(){ r({ ok: true }); }, 30); }); }; " +
  "return a.projectAsync('synth-client-alpha', FIXTURES, [slowResolver], externalSnapshot).then(function(r) { " +
  "  ensure(r.status === 'stale', 'expected stale, got ' + r.status); " +
  "})",
  'adapter');

// M7: Allow persistence — flip rejected/ok
runMutant('M7:allow-persistence', ADAPTER_PATH,
  ADAPTER_SRC.replace("rejected: true,\n      ok: false,", "rejected: false,\n      ok: true,"),
  "var a = ADAPTER_FACTORY.createAdapter(); " +
  "var r = a.persistEdge({ id: 'test-edge' }); " +
  "ensure(r.rejected === true, 'persistEdge was allowed'); " +
  "ensure(r.ok === false, 'persistEdge should not be ok')",
  'adapter');

// M8: Confirm AI edge — remove isConfirmed check
runMutant('M8:ai-edge-confirmed', PROJ_PATH,
  PROJ_SRC.replace(
    "if (e.isConfirmed) issues.push('AI edge ' + e.id + ' marked confirmed — must remain preview-only');",
    "// M8: AI edge confirmed check removed"
  ),
  "var vm = PROJ.createViewModel(FIXTURES); " +
  "var aiEdges = vm.edges.filter(function(e) { return e.isAi || e.previewOnly; }); " +
  "if (aiEdges.length < 1) { console.log('CONTRACT_FAIL: no AI edges to test'); process.exit(1); } " +
  "aiEdges[0].isConfirmed = true; " +
  "var val = PROJ.validateViewModel(vm); ensure(!val.ok, 'AI edge confirmed should fail validation')",
  'projection');

// M9: Skip quarantine — make quarantine return verified:true
runMutant('M9:skip-quarantine', ADAPTER_PATH,
  ADAPTER_SRC.replace("quarantined: true,\n      verified: false,", "quarantined: true,\n      verified: true,"),
  "var a = ADAPTER_FACTORY.createAdapter(); " +
  "var q = a.quarantineSourceRef({ id: 'sr:t', clientId: 'c', sessionId: 's' }, 'test'); " +
  "ensure(q.quarantined === true, 'must be quarantined'); " +
  "ensure(q.verified === false, 'quarantined must not be verified')",
  'adapter');

// M10: Input alias — replace deepCopy with slice
runMutant('M10:alias-fixture', PROJ_PATH,
  PROJ_SRC.replace(
    "var nodes = fixtures.nodes ? fixtures.nodes.map(deepCopy) : [];",
    "var nodes = fixtures.nodes ? fixtures.nodes.slice() : []; // M10: shallow copy"
  ),
  "var origLabel = FIXTURES.nodes[0].label; " +
  "var vm = PROJ.createViewModel(FIXTURES); " +
  "vm.nodes[0].label = 'MUTATED_BY_PROBE'; " +
  "ensure(FIXTURES.nodes[0].label !== 'MUTATED_BY_PROBE', 'input fixture node aliased: label=' + FIXTURES.nodes[0].label)",
  'projection');

// M11: Delete negative fixtures — empty the cases array
runMutant('M11:delete-negative', FIXTURES_PATH,
  FIXTURES_SRC.replace("negativeFixtures = {\n  cases: [", "negativeFixtures = {\n  cases: [], _extra: ["),
  "ensure(FIXTURES.negativeFixtures.cases.length >= 12, 'negatives below 12: ' + FIXTURES.negativeFixtures.cases.length)",
  'fixtures');

// M12: Reduce fixture below 54 sessions
runMutant('M12:reduce-fixture', FIXTURES_PATH,
  FIXTURES_SRC.replace("sessionCount: allSessions.length,", "sessionCount: 40, // M12: reduced"),
  "ensure(FIXTURES.sessionCount >= 54, 'sessions below 54: ' + FIXTURES.sessionCount)",
  'fixtures');

// ── Summary ──
console.log('\n=== Mutation Summary ===');
console.log('Mutations killed: ' + killed);
console.log('Mutations survived: ' + survived);
console.log('Errors: ' + errors + (errorDetails.length > 0 ? ' (' + errorDetails.join(', ') + ')' : ''));
console.log('mutation_phase: ' + (survived === 0 && errors === 0 ? 'ALL-MUTATIONS-KILLED' : 'CONTRACT-BROKEN'));
if (survived > 0 || errors > 0) process.exit(1);
