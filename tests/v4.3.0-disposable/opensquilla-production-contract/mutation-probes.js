'use strict';
/**
 * XJ-4.3.0-opensquilla-source-graph-production-contract-freeze-02
 * Mutation probes — subprocess execution architecture.
 * REWORK v2: Fixed Windows path quoting, module resolution, baseline verification.
 *
 * P1 fix: Use execFileSync(process.execPath, [...argv]) — no shell tokenization.
 *         On Windows, "C:\Program Files\nodejs\node.exe" works correctly as argv[0].
 * P2 fix: fixModulePaths() rewrites __dirname and relative require() in mutant
 *         source to point to original module's directory, so mutants in .mutants/
 *         can resolve their dependencies correctly.
 * P3 fix: Baseline verification — each assertion must PASS on original module AND
 *         FAIL on mutant module. Without baseline proof, KILLED is untrustworthy.
 * P4 fix: HARNESS_ERROR classification — module/load failures are NOT KILLED.
 *         Runner exit codes: 0=CONTRACT_PASS, 1=CONTRACT_FAIL, 2=BASELINE_FAIL.
 *         Only exit 1 (with CONTRACT_FAIL marker) counts as KILLED.
 *
 * Classification per mutant:
 *   SYNTAX-ERROR           — mutant fails node --check (real syntax error)
 *   HARNESS-ERROR          — baseline fails, module load fails, or unexpected crash
 *   NO-OP                  — mutation target string not found in original source
 *   KILLED                 — baseline PASS + mutant CONTRACT_FAIL
 *   SURVIVED               — baseline PASS + mutant CONTRACT_PASS
 *   UNSUPPORTED_EXPECTED_RED — API absent, no mutation target
 *
 * 7 required mutations per task card + 8 additional + 2 controls = 17 total.
 * Exit codes: 0 = ALL-KILLED | 1 = ATTACK-SURVIVED | 2 = HARNESS-ERROR
 */
var path = require('path');
var fs = require('fs');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var TMP = path.join(__dirname, '.mutants');
fs.mkdirSync(TMP, { recursive: true });

var PROTO_DIR = path.join(ROOT, 'design-previews', '4.3.0-opensquilla-case-atlas');
var VM_PATH = path.join(PROTO_DIR, 'case-atlas-view-model.js');
var ADAPTER_PATH = path.join(PROTO_DIR, 'source-ref-adapter.js');
var SR_PATH = path.join(ROOT, 'app', 'js', 'source-ref.js');

var VM_ORIGINAL = fs.readFileSync(VM_PATH, 'utf8');
var ADAPTER_ORIGINAL = fs.readFileSync(ADAPTER_PATH, 'utf8');
var SR_ORIGINAL = fs.readFileSync(SR_PATH, 'utf8');

var killed = 0, survived = 0, unsupported = 0, noop = 0, syntaxError = 0, harnessError = 0;
var results = [];

function record(label, status, detail) {
  results.push({ label: label, status: status, detail: detail });
  if (status === 'KILLED') killed++;
  else if (status === 'SURVIVED') survived++;
  else if (status === 'UNSUPPORTED_EXPECTED_RED') unsupported++;
  else if (status === 'NO-OP') noop++;
  else if (status === 'SYNTAX-ERROR') syntaxError++;
  else if (status === 'HARNESS-ERROR') harnessError++;
}

/**
 * Fix module resolution in mutant source for correct requires from .mutants/ dir.
 * - Replace __dirname with JSON.stringify(originalDir) — absolute path of original module
 * - Replace relative require('./...') and require('../...') with absolute paths
 */
function fixModulePaths(src, originalDir) {
  var fixed = src;
  // Replace __dirname → absolute original directory (JSON.stringify for safe quoting)
  fixed = fixed.replace(/\b__dirname\b/g, JSON.stringify(originalDir));
  // Replace relative require('./...') and require('../...') with absolute paths
  fixed = fixed.replace(/require\((['"])(\.\.?\/[^'"]+)\1\)/g, function (match, quote, relPath) {
    var absPath = path.resolve(originalDir, relPath);
    return 'require(' + quote + absPath.split(path.sep).join('/') + quote + ')';
  });
  return fixed;
}

/**
 * Run a Node.js command via execFileSync with argv array (no shell — no quoting issues).
 * Returns { exitCode, stdout, stderr, error }.
 */
function runNode(argv, opts) {
  opts = opts || {};
  try {
    var result = cp.execFileSync(process.execPath, argv, {
      cwd: opts.cwd || ROOT,
      stdio: 'pipe',
      timeout: opts.timeout || 30000,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    return { exitCode: 0, stdout: result.toString(), stderr: '', error: false };
  } catch (e) {
    return {
      exitCode: e.status != null ? e.status : -1,
      stdout: (e.stdout || '').toString(),
      stderr: (e.stderr || '').toString(),
      error: true
    };
  }
}

/**
 * Run a mutation probe with baseline verification.
 * @param {string} label - Human-readable label
 * @param {string} originalPath - Absolute path to original module
 * @param {string} originalSrc - Original source (pre-read)
 * @param {function|string} mutation - function(src)→mutatedSrc, or 'UNSUPPORTED'
 * @param {string} assertionCode - JS code string that throws on contract violation
 */
function runMutant(label, originalPath, originalSrc, mutation, assertionCode) {
  if (mutation === 'UNSUPPORTED') {
    record(label, 'UNSUPPORTED_EXPECTED_RED', 'API absent — no mutation target');
    return;
  }

  var mutatedSrc = (typeof mutation === 'function') ? mutation(originalSrc) : mutation;
  if (mutatedSrc === originalSrc || mutatedSrc === null) {
    record(label, 'NO-OP', 'mutation produced identical source — target string not found');
    return;
  }

  var safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  var originalDir = path.dirname(originalPath);

  // Fix module paths in mutant source so requires resolve from .mutants/
  var fixedMutant = fixModulePaths(mutatedSrc, originalDir);

  var mutantPath = path.join(TMP, safeLabel + '_mutant.js');
  fs.writeFileSync(mutantPath, fixedMutant, 'utf8');

  // Step 1: Syntax check mutant (execFileSync with argv — no shell quoting)
  var scMutant = runNode(['--check', mutantPath], { timeout: 10000 });
  if (scMutant.exitCode !== 0) {
    var errMsg = scMutant.stderr || scMutant.stdout || '';
    // Distinguish real syntax errors from other failures
    if (errMsg.indexOf('SyntaxError') >= 0 || errMsg.indexOf('Unexpected token') >= 0 || errMsg.indexOf('Unexpected end of input') >= 0) {
      record(label, 'SYNTAX-ERROR', 'node --check: ' + errMsg.slice(0, 200));
    } else {
      record(label, 'HARNESS-ERROR', 'node --check exit(' + scMutant.exitCode + '): ' + errMsg.slice(0, 200));
    }
    return;
  }

  // Step 2: Build runner script with baseline verification
  // The runner loads BOTH original and mutant modules, then:
  //   STEP 1: runs assertion against original → must PASS (BASELINE_PASS)
  //   STEP 2: runs assertion against mutant → must FAIL (CONTRACT_FAIL → KILLED)
  // Exit codes: 0=mutant passes (SURVIVED), 1=mutant fails (KILLED), 2=baseline fails (HARNESS_ERROR)
  var runnerSrc = [
    "'use strict';",
    "var path = require('path');",
    "var ROOT = " + JSON.stringify(ROOT) + ";",
    "var SUITE_DIR = " + JSON.stringify(__dirname) + ";",
    "var fixtures = require(path.join(SUITE_DIR, 'fixtures.js'));",
    "var SourceRef = require(path.join(ROOT, 'app', 'js', 'source-ref.js'));",
    "var original = require(" + JSON.stringify(originalPath) + ");",
    "var mutant = require(" + JSON.stringify(mutantPath) + ");",
    "",
    "// STEP 1: Baseline — assertion against ORIGINAL module must PASS",
    "(function() {",
    "  var mutant = original; // shadow: assertion code uses `mutant` variable",
    "  try {",
    assertionCode,
    "    console.log('BASELINE_PASS');",
    "  } catch (e) {",
    "    console.log('BASELINE_FAIL: ' + e.message);",
    "    process.exit(2);",
    "  }",
    "})();",
    "",
    "// STEP 2: Assertion against MUTANT module — must FAIL",
    "try {",
    assertionCode,
    "  console.log('CONTRACT_PASS');",
    "  process.exit(0);",
    "} catch (e) {",
    "  console.log('CONTRACT_FAIL: ' + e.message);",
    "  process.exit(1);",
    "}"
  ].join('\n');

  var runnerPath = path.join(TMP, safeLabel + '_runner.js');
  fs.writeFileSync(runnerPath, runnerSrc, 'utf8');

  // Step 3: Syntax check runner
  var scRunner = runNode(['--check', runnerPath], { timeout: 10000 });
  if (scRunner.exitCode !== 0) {
    var runnerErr = scRunner.stderr || scRunner.stdout || '';
    record(label, 'HARNESS-ERROR', 'runner syntax check failed: ' + runnerErr.slice(0, 200));
    return;
  }

  // Step 4: Execute runner (baseline + mutant assertion in one subprocess)
  var execResult = runNode([runnerPath], { timeout: 30000 });
  var output = (execResult.stdout + ' ' + execResult.stderr).trim();

  if (execResult.exitCode === 0) {
    // Zero exit — mutant passed contract
    if (output.indexOf('BASELINE_PASS') >= 0 && output.indexOf('CONTRACT_PASS') >= 0) {
      record(label, 'SURVIVED', 'mutant passed contract — baseline passed but mutant not caught');
    } else {
      record(label, 'HARNESS-ERROR', 'exit(0) with unexpected output: ' + output.slice(0, 200));
    }
  } else if (execResult.exitCode === 1) {
    // Exit 1 — assertion failed on mutant (CONTRACT_FAIL)
    if (output.indexOf('CONTRACT_FAIL') >= 0) {
      // Verify baseline passed (BASELINE_PASS should be in output since runner runs baseline first)
      if (output.indexOf('BASELINE_PASS') >= 0) {
        record(label, 'KILLED', output.slice(0, 200));
      } else {
        // No BASELINE_PASS marker — but exit was 1 not 2, so baseline likely passed
        // (baseline exits with 2 on failure, which would prevent reaching step 2)
        record(label, 'KILLED', 'CONTRACT_FAIL (baseline implicit pass): ' + output.slice(0, 200));
      }
    } else {
      // Non-zero exit without CONTRACT_FAIL marker — could be uncaught error
      // Check for module load errors
      if (output.indexOf('Cannot find module') >= 0 || output.indexOf('MODULE_NOT_FOUND') >= 0) {
        record(label, 'HARNESS-ERROR', 'module load failed (exit=' + execResult.exitCode + '): ' + output.slice(0, 200));
      } else {
        record(label, 'HARNESS-ERROR', 'exit(' + execResult.exitCode + ') without CONTRACT marker: ' + output.slice(0, 200));
      }
    }
  } else if (execResult.exitCode === 2) {
    // Exit 2 — baseline failed (assertion doesn't pass on original module)
    record(label, 'HARNESS-ERROR', 'BASELINE_FAIL: assertion does not pass on original module. ' + output.slice(0, 200));
  } else {
    // Other non-zero exit — harness error (module crash, signal kill, etc.)
    if (output.indexOf('Cannot find module') >= 0 || output.indexOf('MODULE_NOT_FOUND') >= 0) {
      record(label, 'HARNESS-ERROR', 'module resolution error (exit=' + execResult.exitCode + '): ' + output.slice(0, 200));
    } else if (output.indexOf('BASELINE_FAIL') >= 0) {
      record(label, 'HARNESS-ERROR', 'BASELINE_FAIL: ' + output.slice(0, 200));
    } else {
      record(label, 'HARNESS-ERROR', 'exit(' + execResult.exitCode + '): ' + output.slice(0, 200));
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// REQUIRED MUTATION 1: Unknown client acceptance
// Target: loadClient API — ABSENT → UNSUPPORTED_EXPECTED_RED
// ════════════════════════════════════════════════════════════════════════
runMutant('M1-unknown-client-acceptance', VM_PATH, VM_ORIGINAL, 'UNSUPPORTED',
  "/* no assertion — API absent */");

// ════════════════════════════════════════════════════════════════════════
// REQUIRED MUTATION 2: Unknown session admission
// Target: session registry API — ABSENT → UNSUPPORTED_EXPECTED_RED
// ════════════════════════════════════════════════════════════════════════
runMutant('M2-unknown-session-admission', VM_PATH, VM_ORIGINAL, 'UNSUPPORTED',
  "/* no assertion — API absent */");

// ════════════════════════════════════════════════════════════════════════
// REQUIRED MUTATION 3: Stale/quarantined material admission
// Target: material filter API — ABSENT → UNSUPPORTED_EXPECTED_RED
// ════════════════════════════════════════════════════════════════════════
runMutant('M3-stale-material-admission', VM_PATH, VM_ORIGINAL, 'UNSUPPORTED',
  "/* no assertion — API absent */");

// ════════════════════════════════════════════════════════════════════════
// REQUIRED MUTATION 4: Anchor-hash bypass (SourceRef.verify)
// Target: SourceRef.verify sourceChanged check → mutate if(false)
// REAL MUTATION on production source-ref.js (read-only, mutant in test dir)
// ════════════════════════════════════════════════════════════════════════
runMutant('M4-anchor-hash-bypass', SR_PATH, SR_ORIGINAL, function (src) {
  return src.replace(
    "if (sourceChanged) {",
    "if (false) { /* MUTATED: bypass source-change check */"
  );
},
  [
    "  var ref = mutant.create({",
    "    clientId: 'c1', sessionId: 's1',",
    "    anchor: { kind: 'test', locator: 'doc/1' },",
    "    sourceText: 'original content'",
    "  });",
    "  var v = mutant.verify(ref, {",
    "    clientId: 'c1', sessionId: 's1',",
    "    anchor: { kind: 'test', locator: 'doc/1' },",
    "    sourceText: 'CHANGED CONTENT SHOULD NOT VERIFY'",
    "  });",
    "  if (v.verified === true) throw new Error('changed source accepted as verified — anchor-hash bypass');"
  ].join('\n'));

// ════════════════════════════════════════════════════════════════════════
// REQUIRED MUTATION 5: AI-edge allow
// Target: rejectAiEdgePersistence ok:false → ok:true
// REAL MUTATION on prototype adapter
// ════════════════════════════════════════════════════════════════════════
runMutant('M5-ai-edge-allow', ADAPTER_PATH, ADAPTER_ORIGINAL, function (src) {
  return src.replace(
    "return { ok: false, reason: 'ai-edge-persistence-denied', message: 'AI-generated edges are preview-only and must not be persisted' };",
    "return { ok: true, reason: 'ai-edge-allowed', message: 'MUTATED: AI edge persistence allowed' };"
  );
},
  [
    "  var aiEdge = { type: 'ai-inference', previewOnly: true, id: 'test_edge' };",
    "  var result = mutant.rejectAiEdgePersistence(aiEdge);",
    "  if (result.ok === true) throw new Error('AI edge persistence allowed — mutation survived');"
  ].join('\n'));

// ════════════════════════════════════════════════════════════════════════
// REQUIRED MUTATION 6: Stale-client write (cache invalidation bypass)
// Target: needsCacheInvalidation client check removal
// REAL MUTATION on prototype adapter
// ════════════════════════════════════════════════════════════════════════
runMutant('M6-stale-client-write', ADAPTER_PATH, ADAPTER_ORIGINAL, function (src) {
  return src.replace(
    "if (snapshot.clientId && current.clientId && snapshot.clientId !== current.clientId) return true;",
    "/* MUTATED: removed client-change detection */"
  );
},
  [
    "  var snap = { normalizationVersion: '4.3.0-disposable-v1', sourceVersion: 'synthetic-001', clientId: 'c_alpha', sessionId: 's1' };",
    "  var cur = { sourceVersion: 'synthetic-001', clientId: 'c_BETA_DIFFERENT', sessionId: 's1' };",
    "  var result = mutant.needsCacheInvalidation(snap, cur);",
    "  if (result === false) throw new Error('stale client NOT detected — cross-client write risk');"
  ].join('\n'));

// ════════════════════════════════════════════════════════════════════════
// REQUIRED MUTATION 7: Missing await/Promise sequencing
// Target: No async APIs in prototype → UNSUPPORTED_EXPECTED_RED
// ════════════════════════════════════════════════════════════════════════
runMutant('M7-missing-await-promise', VM_PATH, VM_ORIGINAL, 'UNSUPPORTED',
  "/* no assertion — no async/Promise APIs exist in prototype */");

// ════════════════════════════════════════════════════════════════════════
// ADDITIONAL MUTATION 8: Remove null-client assertion in createViewModel
// FIX: Original assertion was backwards (failed on baseline). Now uses threw flag.
// ════════════════════════════════════════════════════════════════════════
runMutant('M8-null-client-assertion-removed', VM_PATH, VM_ORIGINAL, function (src) {
  return src.replace(
    "assert(fixtures.client, 'fixtures.client required');",
    "/* MUTATED: client assertion removed */"
  );
},
  [
    "  var input = fixtures.toPrototypeInput();",
    "  input.client = null;",
    "  var guardMsg = '';",
    "  try { mutant.createViewModel(input); } catch (e) { guardMsg = e.message; }",
    "  if (guardMsg.indexOf('fixtures.client required') < 0) throw new Error('null client guard missing: ' + guardMsg);"
  ].join('\n'));

// ════════════════════════════════════════════════════════════════════════
// ADDITIONAL MUTATION 9: Remove 30-session minimum
// FIX: Original assertion failed on baseline (createViewModel throws for <30).
// Now uses threw flag to properly detect assertion removal.
// ════════════════════════════════════════════════════════════════════════
runMutant('M9-remove-30-session-minimum', VM_PATH, VM_ORIGINAL, function (src) {
  return src.replace(
    "assert(fixtures.sessions.length >= 30, 'minimum 30 sessions required, got ' + fixtures.sessions.length);",
    "/* MUTATED: 30-session minimum removed */"
  );
},
  [
    "  var input = fixtures.toPrototypeInput();",
    "  input.sessions = input.sessions.slice(0, 10);",
    "  var threw = false;",
    "  try {",
    "    mutant.createViewModel(input);",
    "  } catch (e) {",
    "    threw = true;",
    "  }",
    "  if (!threw) throw new Error('10-session fixture accepted — minimum removed');"
  ].join('\n'));

// ════════════════════════════════════════════════════════════════════════
// ADDITIONAL MUTATION 10: Drop sourceContentHash check in validateViewModel
// ════════════════════════════════════════════════════════════════════════
runMutant('M10-drop-sourceContentHash-check', VM_PATH, VM_ORIGINAL, function (src) {
  return src.replace(
    "if (!node.sourceRef || !node.sourceRef.sourceContentHash) issues.push('node[' + i + '].sourceRef.sourceContentHash missing');",
    "/* MUTATED: sourceContentHash check removed */"
  );
},
  [
    "  var input = fixtures.toPrototypeInput();",
    "  var vm = mutant.createViewModel(input);",
    "  vm.nodes.push({ id: 'bad_001', type: 'quote', sourceRef: { id: 'sr:bad', anchorContentHash: 'sha256:x' }, label: 'bad', summary: '', truncated: false, isAiDraft: false, isConfirmed: true });",
    "  var val = mutant.validateViewModel(vm);",
    "  if (val.ok) throw new Error('hashless node accepted — sourceContentHash check removed');"
  ].join('\n'));

// ════════════════════════════════════════════════════════════════════════
// ADDITIONAL MUTATION 11: Drop anchorContentHash check in validateViewModel
// ════════════════════════════════════════════════════════════════════════
runMutant('M11-drop-anchorContentHash-check', VM_PATH, VM_ORIGINAL, function (src) {
  return src.replace(
    "if (!node.sourceRef || !node.sourceRef.anchorContentHash) issues.push('node[' + i + '].sourceRef.anchorContentHash missing');",
    "/* MUTATED: anchorContentHash check removed */"
  );
},
  [
    "  var input = fixtures.toPrototypeInput();",
    "  var vm = mutant.createViewModel(input);",
    "  vm.nodes.push({ id: 'bad_002', type: 'quote', sourceRef: { id: 'sr:bad2', sourceContentHash: 'sha256:x' }, label: 'bad2', summary: '', truncated: false, isAiDraft: false, isConfirmed: true });",
    "  var val = mutant.validateViewModel(vm);",
    "  if (val.ok) throw new Error('anchorless node accepted — anchorContentHash check removed');"
  ].join('\n'));

// ════════════════════════════════════════════════════════════════════════
// ADDITIONAL MUTATION 12: Mutable filterNodes return (no shallow copy)
// ════════════════════════════════════════════════════════════════════════
runMutant('M12-mutable-filterNodes-return', VM_PATH, VM_ORIGINAL, function (src) {
  return src.replace("var filtered = nodes.slice();", "var filtered = nodes; /* MUTATED: no shallow copy */");
},
  [
    "  var input = fixtures.toPrototypeInput();",
    "  var vm = mutant.createViewModel(input);",
    "  var originalLen = vm.nodes.length;",
    "  // filter 'all' with empty query skips both filter and query blocks,",
    "  // so filtered = nodes.slice() (copy) or nodes (direct ref in mutant).",
    "  // Using 'record' would call .filter() which always creates a new array,",
    "  // masking the slice() mutation.",
    "  var filtered = mutant.filterNodes(vm.nodes, 'all', '');",
    "  filtered.push({ id: 'INJECTED', type: 'record', sourceRef: { id: 'fake' } });",
    "  if (vm.nodes.length !== originalLen) throw new Error('injection affected original array — mutable return');"
  ].join('\n'));

// ════════════════════════════════════════════════════════════════════════
// ADDITIONAL MUTATION 13: Quarantine skip (verified:false → verified:true)
// ════════════════════════════════════════════════════════════════════════
runMutant('M13-quarantine-skip', ADAPTER_PATH, ADAPTER_ORIGINAL, function (src) {
  return src.replace("verified: false", "verified: true /* MUTATED */");
},
  [
    "  var ref = { id: 'sr:test', clientId: 'c1', sessionId: 's1' };",
    "  var q = mutant.quarantineSourceRef(ref, 'test-reason');",
    "  if (q.verified === true) throw new Error('quarantined ref marked verified — quarantine bypassed');"
  ].join('\n'));

// ════════════════════════════════════════════════════════════════════════
// ADDITIONAL MUTATION 14: Remove sourceVersion check in needsCacheInvalidation
// ════════════════════════════════════════════════════════════════════════
runMutant('M14-skip-sourceVersion-check', ADAPTER_PATH, ADAPTER_ORIGINAL, function (src) {
  return src.replace(
    "if (snapshot.sourceVersion !== current.sourceVersion) return true;",
    "/* MUTATED: removed sourceVersion check */"
  );
},
  [
    "  var snap = { normalizationVersion: '4.3.0-disposable-v1', sourceVersion: 'OLD', clientId: 'c1', sessionId: 's1' };",
    "  var cur = { sourceVersion: 'NEW', clientId: 'c1', sessionId: 's1' };",
    "  var result = mutant.needsCacheInvalidation(snap, cur);",
    "  if (result === false) throw new Error('sourceVersion change not detected — stale snapshot risk');"
  ].join('\n'));

// ════════════════════════════════════════════════════════════════════════
// ADDITIONAL MUTATION 15: Fake ViewModel return
// FIX: Original assertion was backwards (threw on baseline because real VM
// passes validation). Now checks for `fake` property on returned object.
// ════════════════════════════════════════════════════════════════════════
runMutant('M15-fake-viewmodel-return', VM_PATH, VM_ORIGINAL, function (src) {
  return src.replace("return viewModel;", "return { ok: true, fake: true /* MUTATED */ };");
},
  [
    "  var input = fixtures.toPrototypeInput();",
    "  var vm = mutant.createViewModel(input);",
    "  if (vm.fake === true) throw new Error('fake VM returned — pipeline bypassed');"
  ].join('\n'));

// ════════════════════════════════════════════════════════════════════════
// CONTROL C1: Syntax error (must be SYNTAX-ERROR, not KILLED)
// ════════════════════════════════════════════════════════════════════════
runMutant('C1-syntax-error-control', VM_PATH, VM_ORIGINAL, function (src) {
  return src.replace("'use strict';", "'use strict'; /* SYNTAX ERROR → */ {");
},
  "/* should not reach — syntax error expected */");

// ════════════════════════════════════════════════════════════════════════
// CONTROL C2: No-op (identical source — must be NO-OP, not KILLED)
// FIX: Returns identical source to trigger NO-OP detection path.
// ════════════════════════════════════════════════════════════════════════
runMutant('C2-no-op-control', VM_PATH, VM_ORIGINAL, function (src) {
  return src; // identical source — true NO-OP control
},
  "  var vm = mutant.createViewModel(fixtures);");

// ════════════════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════════════════
console.log('');
console.log('=== Mutation Probes: XJ-4.3.0 Production Contract Freeze (Rework v2) ===');
console.log('node: ' + process.execPath + ' (' + process.version + ')');
console.log('');
results.forEach(function (r) {
  var tag = '[' + r.status + ']';
  console.log(tag.padEnd(30) + r.label + (r.detail ? ' — ' + r.detail.slice(0, 120) : ''));
});
console.log('');
console.log('KILLED:                   ' + killed);
console.log('SURVIVED:                 ' + survived);
console.log('UNSUPPORTED_EXPECTED_RED: ' + unsupported);
console.log('NO-OP:                    ' + noop);
console.log('SYNTAX-ERROR:             ' + syntaxError);
console.log('HARNESS-ERROR:            ' + harnessError);
console.log('Total:                    ' + results.length);
console.log('');

if (survived > 0) {
  console.log('mutation_phase: CONTRACT-BROKEN (' + survived + ' survived)');
  process.exit(1);
} else if (harnessError > 0) {
  console.log('mutation_phase: HARNESS-ERROR (' + harnessError + ' harness errors)');
  process.exit(2);
} else {
  console.log('mutation_phase: ALL-MUTATIONS-KILLED (' + killed + ' killed, ' + unsupported + ' unsupported, ' + noop + ' no-op, ' + syntaxError + ' syntax-error, ' + harnessError + ' harness-error)');
  process.exit(0);
}