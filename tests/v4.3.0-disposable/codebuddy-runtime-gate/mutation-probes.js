'use strict';

// Mutation probes for the XJ-4.3.0 CodeBuddy runtime gate.
// Proves the gate is LOAD-BEARING and is NOT a false green:
//   - Positive mutation: a semantically-correct minimal fix flips R1/R2 from red to green.
//   - Negative mutation: keeps the keywords but breaks the control flow, and MUST stay red.
//   - Harness/parser failures surface as HARNESS_ERROR and force a non-zero exit.
//
// Acceptance:
//   node --check tests/v4.3.0-disposable/codebuddy-runtime-gate/mutation-probes.js
//   node tests/v4.3.0-disposable/codebuddy-runtime-gate/mutation-probes.js

const fs = require('fs');
const path = require('path');
const gate = require('./run-gate-contract.js');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const wrapperPath = path.join(projectRoot, 'scripts', 'agent-electron-acceptance.ps1');
const mainPath = path.join(projectRoot, 'main.js');
const realWrapper = fs.readFileSync(wrapperPath, 'utf8');
const realMain = fs.readFileSync(mainPath, 'utf8');

const probes = [];
function recordRaw(name, state, detail) {
  // state: 'pass' | 'fail' | 'harness_error'
  probes.push({ name, state, detail });
  const tag = state === 'pass' ? '[PASS] ' : (state === 'harness_error' ? '[HARNESS_ERROR] ' : '[FAIL] ');
  console.log(tag + name + ' — ' + detail);
}
function find(p, id) { return p.predicates.find(x => x.id === id); }

// Rework v3: R1/R2 are runtime-evidence-only. The minimal correct "fix" for
// the gate is therefore VALID runtime evidence bound to the current wrapper
// SHA-256 (as would be produced by a future production-owned instrumented
// run), not any static source text edit.
function buildValidEvidence(sha) {
  return {
    wrapperSha256: sha,
    r1: {
      outcomes: { 'normal-exit': true, 'timeout-killed': true, 'unexpected-exit': true },
      killOnlyOnTimeout: true
    },
    r2: { abnormalExitCleanupVerified: true, verifiedByDirectoryAbsence: true }
  };
}

// --- Probe A: synthetic replacement wrapper is detected via SHA identity ---
try {
  const fake = '# synthetic replacement wrapper\n$process.WaitForExit(5000)\n$process.Kill()\n';
  const r = gate.evaluateGate({ wrapperSource: fake, mainSource: realMain, projectRoot });
  const g4 = find(r, 'G4');
  const ok = g4 && g4.actual === 'FAIL';
  recordRaw('A.synthetic-wrapper-detected', ok ? 'pass' : 'fail',
    ok ? 'synthetic wrapper SHA mismatch flagged (G4=FAIL); not silently accepted as green'
       : 'synthetic wrapper not detected (G4=' + (g4 && g4.actual) + ')');
} catch (e) { recordRaw('A.synthetic-wrapper-detected', 'harness_error', String(e && e.stack || e)); }

// --- Probe B (POSITIVE): valid SHA-bound runtime evidence flips R1/R2 red -> green ---
try {
  const sha = gate.sha256(realWrapper);
  const r = gate.evaluateGate({
    wrapperSource: realWrapper, mainSource: realMain, projectRoot,
    runtimeEvidence: buildValidEvidence(sha)
  });
  const r1 = find(r, 'R1');
  const r2 = find(r, 'R2');
  const ok = r1 && r1.actual === 'PASS' && r2 && r2.actual === 'PASS';
  recordRaw('B.positive-evidence-greens', ok ? 'pass' : 'fail',
    ok ? 'valid runtime evidence bound to current wrapper SHA flips R1/R2 red->green (R1=' + r1.actual + ' R2=' + r2.actual + ')'
       : 'valid evidence did not turn green (R1=' + (r1 && r1.actual) + ' R2=' + (r2 && r2.actual) + ')');
} catch (e) { recordRaw('B.positive-evidence-greens', 'harness_error', String(e && e.stack || e)); }

// --- Probe N0 (NEGATIVE): STATIC SOURCE TEXT must NOT flip R1/R2 green ---
// This is the exact false green CodeX rejected: `WaitForExit(5000); Kill(); exit`
// plus an appended cleanup job in SOURCE TEXT, with NO runtime evidence.
try {
  let textOnly = realWrapper
    .replace('$process.WaitForExit()', '$process.WaitForExit(5000)')
    .replace('exit $process.ExitCode', '$process.Kill(); exit $process.ExitCode');
  textOnly += '\nStart-Job -ScriptBlock { Remove-Item -LiteralPath $tempUserData -Recurse -Force } | Out-Null\n';
  const r = gate.evaluateGate({
    wrapperSource: textOnly, mainSource: realMain, projectRoot,
    allowSynthetic: true, runtimeEvidence: null
  });
  const r1 = find(r, 'R1');
  const r2 = find(r, 'R2');
  const ok = r1 && r1.actual === 'FAIL' && r2 && r2.actual === 'FAIL';
  recordRaw('N0.static-text-not-proof', ok ? 'pass' : 'fail',
    ok ? 'source text with all keywords but NO runtime evidence stays red (static text is not runtime proof)'
       : 'static text wrongly accepted as runtime proof (R1=' + (r1 && r1.actual) + ' R2=' + (r2 && r2.actual) + ')');
} catch (e) { recordRaw('N0.static-text-not-proof', 'harness_error', String(e && e.stack || e)); }

// --- Probe N1 (NEGATIVE R1): evidence keeps keys but kill NOT confined to timeout branch ---
try {
  const sha = gate.sha256(realWrapper);
  const ev = buildValidEvidence(sha);
  ev.r1.killOnlyOnTimeout = false; // branchless kill observed
  const r = gate.evaluateGate({ wrapperSource: realWrapper, mainSource: realMain, projectRoot, runtimeEvidence: ev });
  const r1 = find(r, 'R1');
  const ok = r1 && r1.actual === 'FAIL';
  recordRaw('N1.negative-r1-branchless-kill-rejected', ok ? 'pass' : 'fail',
    ok ? 'evidence recording kill outside the timeout branch stays red'
       : 'branchless-kill evidence wrongly turned green (R1=' + (r1 && r1.actual) + ')');
} catch (e) { recordRaw('N1.negative-r1-branchless-kill-rejected', 'harness_error', String(e && e.stack || e)); }

// --- Probe N1b (NEGATIVE R1): evidence missing one of the three outcomes ---
try {
  const sha = gate.sha256(realWrapper);
  const ev = buildValidEvidence(sha);
  ev.r1.outcomes['unexpected-exit'] = false; // outcome never actually observed
  const r = gate.evaluateGate({ wrapperSource: realWrapper, mainSource: realMain, projectRoot, runtimeEvidence: ev });
  const r1 = find(r, 'R1');
  const ok = r1 && r1.actual === 'FAIL';
  recordRaw('N1b.negative-r1-missing-outcome-rejected', ok ? 'pass' : 'fail',
    ok ? 'evidence missing the unexpected-exit outcome stays red (all three outcomes required)'
       : 'incomplete-outcome evidence wrongly turned green (R1=' + (r1 && r1.actual) + ')');
} catch (e) { recordRaw('N1b.negative-r1-missing-outcome-rejected', 'harness_error', String(e && e.stack || e)); }

// --- Probe N2 (NEGATIVE R2): cleanup claimed but not verified by directory absence ---
try {
  const sha = gate.sha256(realWrapper);
  const ev = buildValidEvidence(sha);
  ev.r2.verifiedByDirectoryAbsence = false; // asserted without on-disk proof
  const r = gate.evaluateGate({ wrapperSource: realWrapper, mainSource: realMain, projectRoot, runtimeEvidence: ev });
  const r2 = find(r, 'R2');
  const ok = r2 && r2.actual === 'FAIL';
  recordRaw('N2.negative-r2-unverified-cleanup-rejected', ok ? 'pass' : 'fail',
    ok ? 'cleanup evidence without directory-absence verification stays red'
       : 'unverified cleanup wrongly turned green (R2=' + (r2 && r2.actual) + ')');
} catch (e) { recordRaw('N2.negative-r2-unverified-cleanup-rejected', 'harness_error', String(e && e.stack || e)); }

// --- Probe N3 (NEGATIVE): evidence bound to a DIFFERENT wrapper SHA is rejected ---
try {
  const ev = buildValidEvidence('AB'.repeat(32));
  const r = gate.evaluateGate({ wrapperSource: realWrapper, mainSource: realMain, projectRoot, runtimeEvidence: ev });
  const r1 = find(r, 'R1');
  const r2 = find(r, 'R2');
  const ok = r1 && r1.actual === 'FAIL' && r2 && r2.actual === 'FAIL';
  recordRaw('N3.negative-stale-sha-evidence-rejected', ok ? 'pass' : 'fail',
    ok ? 'evidence bound to a different wrapper SHA stays red (stale artifact rejected)'
       : 'stale-SHA evidence wrongly turned green (R1=' + (r1 && r1.actual) + ' R2=' + (r2 && r2.actual) + ')');
} catch (e) { recordRaw('N3.negative-stale-sha-evidence-rejected', 'harness_error', String(e && e.stack || e)); }

// --- Probe C: removing each expected-red assertion yields a FALSE GREEN (assertion load-bearing) ---
try {
  const rNoTimeout = gate.evaluateGate({ wrapperSource: realWrapper, mainSource: realMain, projectRoot, skipAssert: { noTimeout: true } });
  const r1 = find(rNoTimeout, 'R1');
  const rNoCleanup = gate.evaluateGate({ wrapperSource: realWrapper, mainSource: realMain, projectRoot, skipAssert: { noCleanup: true } });
  const r2 = find(rNoCleanup, 'R2');
  const rNoVisual = gate.evaluateGate({ wrapperSource: realWrapper, mainSource: realMain, projectRoot, skipAssert: { noVisual: true } });
  const r3 = find(rNoVisual, 'R3');
  const ok = r1 && r1.actual === 'PASS' && r2 && r2.actual === 'PASS' && r3 && r3.actual === 'PASS';
  recordRaw('C.assertions-load-bearing', ok ? 'pass' : 'fail',
    ok ? 'removing R1/R2/R3 assertions each produced a false GREEN (assertions necessary)'
       : 'at least one assertion removal did not change result (R1=' + (r1 && r1.actual) + ' R2=' + (r2 && r2.actual) + ' R3=' + (r3 && r3.actual) + ')');
} catch (e) { recordRaw('C.assertions-load-bearing', 'harness_error', String(e && e.stack || e)); }

// --- Probe D: an old/wrong KNOWN SHA is detected (substitution rejected) ---
try {
  const tamperedSha = 'DEADBEEF'.repeat(8);
  const r = gate.evaluateGate({ wrapperSource: realWrapper, mainSource: realMain, projectRoot, knownWrapperSha: tamperedSha });
  const g4 = find(r, 'G4');
  const ok = g4 && g4.actual === 'FAIL';
  recordRaw('D.old-sha-substitution-detected', ok ? 'pass' : 'fail',
    ok ? 'tampered KNOWN SHA causes identity mismatch (G4=FAIL)'
       : 'old SHA substitution not detected (G4=' + (g4 && g4.actual) + ')');
} catch (e) { recordRaw('D.old-sha-substitution-detected', 'harness_error', String(e && e.stack || e)); }

// --- Probe E: missing/incomplete visual cells are rejected by the meta-rule ---
try {
  const fewer = gate.assertVisualPassRequires18Cells(gate.buildFakeCells(17, true)) === false;
  const placeholder = gate.assertVisualPassRequires18Cells(gate.buildFakeCells(18, false)) === false;
  const full = gate.assertVisualPassRequires18Cells(gate.buildFakeCells(18, true)) === true;
  const ok = fewer && placeholder && full;
  recordRaw('E.visual-cells-rejected', ok ? 'pass' : 'fail',
    ok ? '17 cells rejected, placeholder evidence rejected, 18 valid cells accepted'
       : 'visual cell rule inconsistent (fewer=' + fewer + ' placeholder=' + placeholder + ' full=' + full + ')');
} catch (e) { recordRaw('E.visual-cells-rejected', 'harness_error', String(e && e.stack || e)); }

// --- Probe F: a hung child must NOT be treated as complete (R1 semantics) ---
try {
  const r = gate.evaluateGate({ wrapperSource: realWrapper, mainSource: realMain, projectRoot });
  const r1 = find(r, 'R1');
  const ok = r1 && r1.actual === 'FAIL';
  recordRaw('F.hung-child-not-complete', ok ? 'pass' : 'fail',
    ok ? 'hung child (no bounded wait, no reachable Kill) reported as FAIL, not complete'
       : 'hung child incorrectly treated as complete (R1=' + (r1 && r1.actual) + ')');
} catch (e) { recordRaw('F.hung-child-not-complete', 'harness_error', String(e && e.stack || e)); }

const passCount = probes.filter(p => p.state === 'pass').length;
const harnessErrors = probes.filter(p => p.state === 'harness_error').length;
const allPass = passCount === probes.length;
console.log('\nMUTATION_PROBES_PASS=' + allPass + ' (' + passCount + '/' + probes.length + (harnessErrors ? ', harness_errors=' + harnessErrors : '') + ')');
// HARNESS_ERROR or any failure => non-zero exit (never a false green).
process.exit(allPass ? 0 : 1);
