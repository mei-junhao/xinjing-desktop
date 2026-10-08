'use strict';

// XJ-4.3.0 rework v3 — fully ISOLATED synthetic PowerShell behavior fixtures.
//
// Scope guard: this file NEVER touches the production wrapper
// (scripts/agent-electron-acceptance.ps1), main.js, real userData or the
// network. It only creates temp directories under os.tmpdir() and short-lived
// pwsh child processes, and deletes its own temp dirs afterwards.
//
// WHAT IT PROVES (with real subprocess behavior, not source text):
//   FIX-1 three-outcome supervisor: normal-exit / timeout-killed /
//         unexpected-exit are distinct observed results; Kill is attempted
//         ONLY on the timeout branch (recorded behaviorally per run).
//   FIX-2 cleanup supervisor: after the parent process exits ABNORMALLY
//         (exit 99, skipping its own cleanup), an independent watchdog
//         ACTUALLY removes the fixture temp userData; asserted by directory
//         absence on disk, not by source text.
//
// NEGATIVE MUTANTS (keywords kept, control flow broken) MUST FAIL:
//   MUT-1 branchless Kill: `.Kill(` retained but attempted regardless of the
//         wait result -> kill observed on a normally-exited child -> FAIL.
//   MUT-2 unreachable cleanup: Start-Process watchdog line retained but the
//         parent exits before reaching it -> temp userData survives -> FAIL.
//   MUT-3 wrong-path cleanup: watchdog removes `<dir>-wrong` -> the real temp
//         userData survives -> FAIL.
//
// Any spawn/parse/unexpected error is HARNESS_ERROR and forces non-zero exit.
//
// EVIDENCE CLASS: FIXTURE-ONLY. This validates the FUTURE production predicate
// semantics. It is NOT production runtime evidence and must never be fed into
// qa/acceptance/XJ-4.3.0/runtime-evidence/ as wrapper evidence.
//
// Acceptance:
//   node --check tests/v4.3.0-disposable/codebuddy-runtime-gate/behavior-fixture.js
//   node tests/v4.3.0-disposable/codebuddy-runtime-gate/behavior-fixture.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const results = [];
function recordRaw(name, state, detail) {
  // state: 'pass' | 'fail' | 'harness_error'
  results.push({ name, state, detail });
  const tag = state === 'pass' ? '[PASS] ' : (state === 'harness_error' ? '[HARNESS_ERROR] ' : '[FAIL] ');
  console.log(tag + name + ' — ' + detail);
}

const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-cb-fixture-'));

const SUPERVISOR_PS1 = `param(
  [Parameter(Mandatory=$true)][string]$Mode,
  [Parameter(Mandatory=$true)][string]$ResultPath,
  [int]$TimeoutMs = 1500,
  [switch]$BranchlessKill
)
$ErrorActionPreference = 'Stop'
switch ($Mode) {
  'normal'     { $childCmd = 'Start-Sleep -Milliseconds 200; exit 0' }
  'timeout'    { $childCmd = 'Start-Sleep -Seconds 30' }
  'unexpected' { $childCmd = 'exit 7' }
  default      { throw ('unknown mode: ' + $Mode) }
}
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'pwsh'
$psi.Arguments = '-NoProfile -Command "' + $childCmd + '"'
$psi.UseShellExecute = $false
$process = [System.Diagnostics.Process]::Start($psi)
$killAttempted = $false
$exited = $process.WaitForExit($TimeoutMs)
if ($BranchlessKill) {
  # MUT-1: keyword .Kill( kept, but no timeout-branch guard around it.
  try { $process.Kill() } catch { }
  $killAttempted = $true
  if (-not $exited) { $process.WaitForExit() }
  if ($exited) {
    if ($process.ExitCode -eq 0) { $outcome = 'normal-exit' } else { $outcome = 'unexpected-exit' }
  } else { $outcome = 'timeout-killed' }
} else {
  if ($exited) {
    if ($process.ExitCode -eq 0) { $outcome = 'normal-exit' } else { $outcome = 'unexpected-exit' }
  } else {
    try { $process.Kill() } catch { }
    $killAttempted = $true
    $process.WaitForExit()
    $outcome = 'timeout-killed'
  }
}
$exitCode = $null
try { $exitCode = $process.ExitCode } catch { }
$record = @{
  mode = $Mode
  outcome = $outcome
  waitReturned = [bool]$exited
  killAttempted = [bool]$killAttempted
  childExitCode = $exitCode
}
$record | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultPath -Encoding utf8
exit 0
`;

const CLEANUP_PARENT_PS1 = `param(
  [Parameter(Mandatory=$true)][string]$TempUserData,
  [Parameter(Mandatory=$true)][string]$Variant
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $TempUserData | Out-Null
Set-Content -LiteralPath (Join-Path $TempUserData 'marker.txt') -Value 'fixture' -Encoding utf8
$watchTarget = $TempUserData
if ($Variant -eq 'wrongpath') { $watchTarget = $TempUserData + '-wrong' }
$watchCmd = 'Wait-Process -Id ' + $PID + ' -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ''' + $watchTarget + ''' -Recurse -Force -ErrorAction SilentlyContinue'
if ($Variant -eq 'unreachable') {
  # MUT-2: abnormal exit happens BEFORE the watchdog registration below; the
  # Start-Process cleanup line keeps its keywords but is unreachable.
  exit 99
}
Start-Process pwsh -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',$watchCmd | Out-Null
Start-Sleep -Milliseconds 300
# Abnormal exit: intentionally skip any of the parent's own cleanup.
exit 99
`;

const supervisorPath = path.join(FIXTURE_ROOT, 'supervisor.ps1');
const cleanupParentPath = path.join(FIXTURE_ROOT, 'cleanup-parent.ps1');
fs.writeFileSync(supervisorPath, SUPERVISOR_PS1, 'utf8');
fs.writeFileSync(cleanupParentPath, CLEANUP_PARENT_PS1, 'utf8');

function runPwsh(args, timeoutMs) {
  const r = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass'].concat(args), {
    encoding: 'utf8',
    timeout: timeoutMs || 60000,
    windowsHide: true
  });
  if (r.error) throw new Error('pwsh spawn failed: ' + r.error.message);
  return r;
}

function runSupervisor(mode, branchless) {
  const resultPath = path.join(FIXTURE_ROOT, 'result-' + mode + (branchless ? '-mut1' : '') + '-' + crypto.randomBytes(4).toString('hex') + '.json');
  const args = ['-File', supervisorPath, '-Mode', mode, '-ResultPath', resultPath, '-TimeoutMs', '1500'];
  if (branchless) args.push('-BranchlessKill');
  const proc = runPwsh(args, 60000);
  if (proc.status !== 0) {
    throw new Error('supervisor exited ' + proc.status + ' stderr=' + String(proc.stderr).slice(0, 300));
  }
  if (!fs.existsSync(resultPath)) throw new Error('supervisor produced no result JSON');
  const parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  console.log('  raw result JSON (' + mode + (branchless ? ', MUT-1' : '') + '): ' + JSON.stringify(parsed));
  return parsed;
}

function sleep(ms) {
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, ms);
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function runCleanupScenario(variant) {
  const tempUserData = path.join(FIXTURE_ROOT, 'ud-' + variant + '-' + crypto.randomBytes(4).toString('hex'));
  const proc = runPwsh(['-File', cleanupParentPath, '-TempUserData', tempUserData, '-Variant', variant], 60000);
  const parentExit = proc.status;
  let removed = false;
  if (variant === 'good') {
    // Poll up to 15s for the watchdog to actually delete the directory.
    for (let i = 0; i < 30; i++) {
      if (!dirExists(tempUserData)) { removed = true; break; }
      sleep(500);
    }
  } else {
    // Negative variants: give any (wrong) watchdog 5s, then check survival.
    sleep(5000);
    removed = !dirExists(tempUserData);
  }
  console.log('  cleanup scenario ' + variant + ': parentExit=' + parentExit + ' dirRemoved=' + removed + ' dir=' + tempUserData);
  return { parentExit, removed, tempUserData };
}

// ---------- FIX-1: three-outcome supervisor (positive) ----------
const observedOutcomes = {};
try {
  const rNormal = runSupervisor('normal', false);
  const ok = rNormal.outcome === 'normal-exit' && rNormal.waitReturned === true &&
    rNormal.killAttempted === false && rNormal.childExitCode === 0;
  observedOutcomes['normal-exit'] = ok;
  recordRaw('FIX1.normal-exit', ok ? 'pass' : 'fail',
    ok ? 'child exit 0 classified normal-exit; Kill NOT attempted'
       : 'unexpected record: ' + JSON.stringify(rNormal));
} catch (e) { recordRaw('FIX1.normal-exit', 'harness_error', String(e && e.stack || e)); }

try {
  const rTimeout = runSupervisor('timeout', false);
  const ok = rTimeout.outcome === 'timeout-killed' && rTimeout.waitReturned === false &&
    rTimeout.killAttempted === true && rTimeout.childExitCode !== 0;
  observedOutcomes['timeout-killed'] = ok;
  recordRaw('FIX1.timeout-killed', ok ? 'pass' : 'fail',
    ok ? 'bounded wait timed out; Kill attempted ONLY here; child exit nonzero after kill'
       : 'unexpected record: ' + JSON.stringify(rTimeout));
} catch (e) { recordRaw('FIX1.timeout-killed', 'harness_error', String(e && e.stack || e)); }

try {
  const rUnexpected = runSupervisor('unexpected', false);
  const ok = rUnexpected.outcome === 'unexpected-exit' && rUnexpected.waitReturned === true &&
    rUnexpected.killAttempted === false && rUnexpected.childExitCode === 7;
  observedOutcomes['unexpected-exit'] = ok;
  recordRaw('FIX1.unexpected-exit', ok ? 'pass' : 'fail',
    ok ? 'child exit 7 classified unexpected-exit (distinct from normal and timeout); Kill NOT attempted'
       : 'unexpected record: ' + JSON.stringify(rUnexpected));
} catch (e) { recordRaw('FIX1.unexpected-exit', 'harness_error', String(e && e.stack || e)); }

// ---------- MUT-1: branchless Kill must FAIL validation ----------
try {
  const rMut = runSupervisor('normal', true);
  // Keyword retained, branch removed: kill observed on a normally-exited child.
  // The killOnlyOnTimeout predicate must therefore REJECT this mutant.
  const mutantRejected = !(rMut.killAttempted === false) || rMut.outcome !== 'normal-exit';
  recordRaw('MUT1.branchless-kill-rejected', mutantRejected ? 'pass' : 'fail',
    mutantRejected ? 'kill attempted despite normal exit -> killOnlyOnTimeout violated -> mutant FAILS as required'
                   : 'branchless Kill was NOT detected (false green)');
} catch (e) { recordRaw('MUT1.branchless-kill-rejected', 'harness_error', String(e && e.stack || e)); }

// ---------- FIX-2: cleanup after abnormal parent exit (positive) ----------
let cleanupVerified = false;
try {
  const g = runCleanupScenario('good');
  const ok = g.parentExit === 99 && g.removed === true;
  cleanupVerified = ok;
  recordRaw('FIX2.abnormal-exit-cleanup', ok ? 'pass' : 'fail',
    ok ? 'parent exited abnormally (99) skipping own cleanup; watchdog ACTUALLY removed temp userData (directory absent on disk)'
       : 'parentExit=' + g.parentExit + ' removed=' + g.removed);
} catch (e) { recordRaw('FIX2.abnormal-exit-cleanup', 'harness_error', String(e && e.stack || e)); }

// ---------- MUT-2: unreachable cleanup must FAIL validation ----------
try {
  const u = runCleanupScenario('unreachable');
  // Cleanup line kept but unreachable -> dir must SURVIVE -> mutant fails.
  const mutantRejected = u.parentExit === 99 && u.removed === false;
  recordRaw('MUT2.unreachable-cleanup-rejected', mutantRejected ? 'pass' : 'fail',
    mutantRejected ? 'unreachable watchdog left temp userData behind -> directory-absence check FAILS the mutant as required'
                   : 'unreachable cleanup not detected (parentExit=' + u.parentExit + ' removed=' + u.removed + ')');
} catch (e) { recordRaw('MUT2.unreachable-cleanup-rejected', 'harness_error', String(e && e.stack || e)); }

// ---------- MUT-3: wrong-path cleanup must FAIL validation ----------
try {
  const w = runCleanupScenario('wrongpath');
  const mutantRejected = w.parentExit === 99 && w.removed === false;
  recordRaw('MUT3.wrongpath-cleanup-rejected', mutantRejected ? 'pass' : 'fail',
    mutantRejected ? 'watchdog removed the WRONG path; real temp userData survived -> directory-absence check FAILS the mutant as required'
                   : 'wrong-path cleanup not detected (parentExit=' + w.parentExit + ' removed=' + w.removed + ')');
} catch (e) { recordRaw('MUT3.wrongpath-cleanup-rejected', 'harness_error', String(e && e.stack || e)); }

// ---------- summary + fixture-only evidence statement ----------
const passCount = results.filter(r => r.state === 'pass').length;
const harnessErrors = results.filter(r => r.state === 'harness_error').length;
const allPass = passCount === results.length;

console.log('\nFIXTURE_EVIDENCE (fixture-only, NOT production wrapper evidence): ' + JSON.stringify({
  evidenceClass: 'isolated-synthetic-fixture',
  appliesToProductionWrapper: false,
  r1SemanticsValidated: observedOutcomes['normal-exit'] === true &&
    observedOutcomes['timeout-killed'] === true &&
    observedOutcomes['unexpected-exit'] === true,
  r2SemanticsValidated: cleanupVerified === true
}));
console.log('BEHAVIOR_FIXTURE_PASS=' + allPass + ' (' + passCount + '/' + results.length +
  (harnessErrors ? ', harness_errors=' + harnessErrors : '') + ')');

// Self cleanup of fixture temp dirs (best effort).
try { fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }); } catch (e) { /* best effort */ }

process.exit(allPass ? 0 : 1);
