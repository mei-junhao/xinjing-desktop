'use strict';

// XJ-4.3.0 CodeBuddy Runtime Gate Contract
// Test-only failure gate for 4.3.0 Electron acceptance.
// Invokes the REAL wrapper ONLY via static analysis (no Electron launch) so it
// never hangs and never mutates production. Where the real behavior lacks the
// required predicate, the predicate is EXPECTED-RED (the gap is captured as the
// precise contract for Codex's later production-owned fix).
//
// Acceptance:
//   node --check tests/v4.3.0-disposable/codebuddy-runtime-gate/run-gate-contract.js
//   node tests/v4.3.0-disposable/codebuddy-runtime-gate/run-gate-contract.js
//   node tests/v4.3.0-disposable/codebuddy-runtime-gate/mutation-probes.js

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// SHA-256 of scripts/agent-electron-acceptance.ps1 at base_commit 9971787eb6e443ab5a5c80aee118b9b43285c093.
const KNOWN_WRAPPER_SHA256 = '018AE1401D66890700460FC4639881B1DA92628457F2C9F41A4127BDDC4B1102';
const VISUAL_CELLS_REQUIRED = 18;

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase();
}

// A visual PASS is only valid with exactly 18 named cells, each carrying per-cell
// evidence. Anything else (fewer cells, missing evidence, stale/historical shot,
// fixed-818 viewport shot, absent screenshot, CSS-only reasoning) is rejected.
function assertVisualPassRequires18Cells(cells) {
  if (!Array.isArray(cells)) return false;
  if (cells.length !== VISUAL_CELLS_REQUIRED) return false;
  for (const c of cells) {
    if (!c || typeof c !== 'object') return false;
    if (!c.viewport || !c.theme || !c.mode) return false;
    if (typeof c.evidence !== 'string' || c.evidence.trim().length === 0) return false;
    if (c.evidence.indexOf('placeholder') !== -1) return false;
  }
  return true;
}

function buildFakeCells(n, valid) {
  const out = [];
  const viewports = ['1024x700', '1366x768', '1920x1080'];
  const themes = ['Clinical', 'Theatre', 'Observatory'];
  const modes = ['Light', 'Dark'];
  let i = 0;
  for (let v = 0; v < viewports.length && out.length < n; v++) {
    for (let t = 0; t < themes.length && out.length < n; t++) {
      for (let m = 0; m < modes.length && out.length < n; m++) {
        out.push({
          viewport: viewports[v], theme: themes[t], mode: modes[m],
          evidence: valid ? `qa/acceptance/XJ-4.3.0/visual/${viewports[v]}-${themes[t]}-${modes[m]}.png` : 'placeholder'
        });
        i++;
      }
    }
  }
  return out.slice(0, n);
}

// Runtime behavior evidence loader (rework v3).
// Static source text is NEVER accepted as runtime proof. R1/R2 can only turn
// green when a runtime-evidence JSON exists that is BOUND to the current
// wrapper SHA-256 and records actually-observed subprocess behavior:
//   { wrapperSha256, r1: { outcomes: {normal-exit, timeout-killed,
//     unexpected-exit}, killOnlyOnTimeout }, r2: { abnormalExitCleanupVerified,
//     verifiedByDirectoryAbsence } }
// Such evidence is produced by a production-owned instrumented run (future,
// Codex-owned). None exists today, so R1/R2 are EXPECTED_RED on production.
function loadRuntimeEvidence(projectRoot) {
  const dir = path.join(projectRoot, 'qa', 'acceptance', 'XJ-4.3.0', 'runtime-evidence');
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return null; }
  for (const name of entries) {
    if (!/^wrapper-behavior-.*\.json$/.test(name)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (data && typeof data.wrapperSha256 === 'string') return data;
    } catch (e) { /* malformed evidence is no evidence */ }
  }
  return null;
}

function runtimeR1Verified(evidence, actualWrapperSha) {
  if (!evidence || typeof evidence !== 'object') return false;
  if (String(evidence.wrapperSha256 || '').toUpperCase() !== actualWrapperSha) return false;
  const r1 = evidence.r1;
  if (!r1 || typeof r1 !== 'object' || !r1.outcomes) return false;
  return r1.outcomes['normal-exit'] === true &&
    r1.outcomes['timeout-killed'] === true &&
    r1.outcomes['unexpected-exit'] === true &&
    r1.killOnlyOnTimeout === true;
}

function runtimeR2Verified(evidence, actualWrapperSha) {
  if (!evidence || typeof evidence !== 'object') return false;
  if (String(evidence.wrapperSha256 || '').toUpperCase() !== actualWrapperSha) return false;
  const r2 = evidence.r2;
  if (!r2 || typeof r2 !== 'object') return false;
  return r2.abnormalExitCleanupVerified === true && r2.verifiedByDirectoryAbsence === true;
}

// Bounded search for an 18-cell visual matrix manifest under qa/.
function findVisualManifest(projectRoot) {
  const roots = [path.join(projectRoot, 'qa')];
  const queue = roots.slice();
  let depth = 0;
  while (queue.length && depth < 6) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { queue.push(full); }
      else if (/visual-matrix.*\.json$|visual-18.*\.json$/.test(e.name)) {
        try {
          const data = JSON.parse(fs.readFileSync(full, 'utf8'));
          const cells = (data && data.cells) || (data && data.matrix) || null;
          if (Array.isArray(cells) && cells.length === VISUAL_CELLS_REQUIRED) {
            let ok = true;
            for (const c of cells) {
              if (!c || !c.evidence || typeof c.evidence !== 'string' || c.evidence.indexOf('placeholder') !== -1) { ok = false; break; }
            }
            if (ok) return full;
          }
        } catch (e) { /* ignore malformed */ }
      }
    }
    depth++;
  }
  return null;
}

function evaluateGate(opts) {
  const wrapperSource = opts.wrapperSource || '';
  const mainSource = opts.mainSource || '';
  const allowSynthetic = !!opts.allowSynthetic;
  const skipAssert = opts.skipAssert || {}; // { noTimeout, noCleanup, noVisual, noIdentity }
  const projectRoot = opts.projectRoot || process.cwd();
  const predicates = [];

  // G4 wrapper identity (binds contract to the real wrapper SHA-256)
  const knownSha = opts.knownWrapperSha || KNOWN_WRAPPER_SHA256;
  const actualWrapperSha = sha256(wrapperSource);
  const identityOk = allowSynthetic || skipAssert.noIdentity || (actualWrapperSha === knownSha);
  predicates.push({
    id: 'G4', kind: 'green', title: 'Wrapper identity matches known real wrapper SHA-256',
    expected: 'PASS', actual: identityOk ? 'PASS' : 'FAIL',
    detail: 'actualSHA=' + actualWrapperSha + (allowSynthetic ? ' (synthetic allowed)' : '') + (identityOk ? '' : ' MISMATCH vs known')
  });

  // G1 network default-deny (loopback only)
  const netOk = /onBeforeRequest/.test(mainSource) && /isAgentAcceptanceLoopbackUrl/.test(mainSource);
  predicates.push({
    id: 'G1', kind: 'green', title: 'Network default-deny (loopback only) enforced in main.js',
    expected: 'PASS', actual: netOk ? 'PASS' : 'FAIL',
    detail: netOk ? 'onBeforeRequest + loopback check present' : 'missing'
  });

  // G2 CDP enabled only on loopback and only when a port is requested
  const cdpOk = /--remote-debugging-address=127\.0\.0\.1/.test(wrapperSource) && /RemoteDebuggingPort -gt 0/.test(wrapperSource);
  predicates.push({
    id: 'G2', kind: 'green', title: 'CDP enabled only on loopback and only when port>0',
    expected: 'PASS', actual: cdpOk ? 'PASS' : 'FAIL',
    detail: cdpOk ? 'loopback gated by port>0' : 'missing'
  });

  // G3 userData forced inside system temp (containment)
  const udOk = /GetTempPath/.test(wrapperSource) && /StartsWith\(\s*\$tempRoot/.test(wrapperSource) && /resolveAgentAcceptanceUserData/.test(mainSource);
  predicates.push({
    id: 'G3', kind: 'green', title: 'userData forced inside system temp (containment)',
    expected: 'PASS', actual: udOk ? 'PASS' : 'FAIL',
    detail: udOk ? 'wrapper + main enforce temp containment' : 'missing'
  });

  // R1 P0-1 (rework v3: RUNTIME EVIDENCE ONLY).
  // Static source text is NOT runtime proof: `WaitForExit(5000); Kill(); exit`
  // would kill a normally-exited child too, and text order cannot show that
  // Kill happens ONLY on the timeout branch or that the wait result is checked.
  // R1 turns green ONLY with runtime evidence bound to the CURRENT wrapper
  // SHA-256 that observed all three outcomes (normal-exit / timeout-killed /
  // unexpected-exit) with Kill confined to the timeout branch.
  // No such production evidence exists today -> EXPECTED_RED on production.
  const runtimeEvidence = Object.prototype.hasOwnProperty.call(opts, 'runtimeEvidence')
    ? opts.runtimeEvidence
    : loadRuntimeEvidence(projectRoot);
  const r1Pass = skipAssert.noTimeout ? true : runtimeR1Verified(runtimeEvidence, actualWrapperSha);
  predicates.push({
    id: 'R1', kind: 'red', title: 'P0-1: child without CDP cannot hang; three-outcome runtime evidence required',
    expected: 'FAIL', actual: r1Pass ? 'PASS' : 'FAIL',
    detail: r1Pass ? 'runtime evidence bound to current wrapper SHA proves normal-exit/timeout-killed/unexpected-exit with Kill only on timeout'
                   : 'no SHA-bound runtime evidence of bounded-wait three-outcome classification (static text is not accepted as proof; production gap)'
  });

  // R2 P0-2 (rework v3: RUNTIME EVIDENCE ONLY).
  // A cleanup mechanism appended in source text can be unreachable on the real
  // execution path (e.g. the wrapper `exit`s inside try before reaching it), so
  // presence of Start-Job/Register-EngineEvent text proves nothing. R2 turns
  // green ONLY with runtime evidence bound to the CURRENT wrapper SHA-256 that
  // the temp userData directory was ACTUALLY ABSENT after an abnormal/forced
  // parent exit. No such production evidence exists today -> EXPECTED_RED.
  const r2Pass = skipAssert.noCleanup ? true : runtimeR2Verified(runtimeEvidence, actualWrapperSha);
  predicates.push({
    id: 'R2', kind: 'red', title: 'P0-2: cleanup verified by directory absence after abnormal exit (runtime evidence)',
    expected: 'FAIL', actual: r2Pass ? 'PASS' : 'FAIL',
    detail: r2Pass ? 'runtime evidence bound to current wrapper SHA proves temp userData absent after abnormal exit'
                   : 'no SHA-bound runtime evidence that abnormal-exit cleanup actually removed temp userData (static text is not accepted as proof; production gap)'
  });

  // R3 P0-3: a visual PASS must be gated on 18 named cells with per-cell evidence.
  const visualManifest = findVisualManifest(projectRoot);
  const r3Pass = skipAssert.noVisual ? true : !!visualManifest;
  predicates.push({
    id: 'R3', kind: 'red', title: 'P0-3: visual PASS requires 18 named cells with per-cell evidence',
    expected: 'FAIL', actual: r3Pass ? 'PASS' : 'FAIL',
    detail: r3Pass ? '18-cell manifest present: ' + visualManifest : 'no enforced 18-cell visual gate/manifest (gap)'
  });

  // M1 meta: the gate itself must reject a visual PASS without 18 valid cells.
  const metaVisualOk = assertVisualPassRequires18Cells(buildFakeCells(17, true)) === false &&
    assertVisualPassRequires18Cells(buildFakeCells(18, true)) === true &&
    assertVisualPassRequires18Cells(buildFakeCells(18, false)) === false;
  predicates.push({
    id: 'M1', kind: 'green', title: 'Meta: gate rejects visual PASS without 18 valid cells',
    expected: 'PASS', actual: metaVisualOk ? 'PASS' : 'FAIL',
    detail: metaVisualOk ? 'enforced' : 'NOT enforced'
  });

  const summary = {
    total: predicates.length,
    passed: predicates.filter(p => p.actual === 'PASS').length,
    failed: predicates.filter(p => p.actual === 'FAIL').length,
    expectedRed: predicates.filter(p => p.kind === 'red' && p.actual === 'FAIL').length,
    matched: predicates.every(p => p.actual === p.expected)
  };
  return { predicates, summary, actualWrapperSha };
}

if (require.main === module) {
  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  const wrapperPath = path.join(projectRoot, 'scripts', 'agent-electron-acceptance.ps1');
  const mainPath = path.join(projectRoot, 'main.js');
  const wrapperSource = fs.readFileSync(wrapperPath, 'utf8');
  const mainSource = fs.readFileSync(mainPath, 'utf8');
  const result = evaluateGate({ wrapperSource, mainSource, projectRoot });
  console.log(JSON.stringify(result, null, 2));
  console.log('MATCHED=' + result.summary.matched + ' EXPECTED_RED=' + result.summary.expectedRed);
  process.exit(result.summary.matched ? 0 : 1);
}

module.exports = {
  evaluateGate,
  assertVisualPassRequires18Cells,
  buildFakeCells,
  findVisualManifest,
  loadRuntimeEvidence,
  runtimeR1Verified,
  runtimeR2Verified,
  KNOWN_WRAPPER_SHA256,
  VISUAL_CELLS_REQUIRED,
  sha256
};
