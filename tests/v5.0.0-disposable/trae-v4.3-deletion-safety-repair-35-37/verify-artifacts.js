'use strict';
/**
 * XJ-5.0.0 v4.3 Deletion-Safety Expected-Red — Artifact Verifier (task-35-37)
 * Rebound by Trae under task
 * XJ-5.0.0-trae-v4.3-deletion-safety-repair-35-37.
 *
 * Verifies the contract-result.json produced by run-contract.js and checks
 * task_id alignment, classification distribution, absence of stale old-agent
 * path references, and file existence.
 */
const path = require('path');
const fs = require('fs');

var ROOT = path.resolve('D:\\xinjing-electron');
var INV = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'trae-v4.3-deletion-safety-repair-35-37');
var TST = path.join(ROOT, 'tests', 'v5.0.0-disposable', 'trae-v4.3-deletion-safety-repair-35-37');
var REPORT = path.join(ROOT, 'qa', 'agent-reviews', 'XJ-5.0.0-trae-v4.3-deletion-safety-repair-35-37.md');
var EXPECTED_TASK_ID = 'XJ-5.0.0-trae-v4.3-deletion-safety-repair-35-37';

var errors = [];
var warnings = [];

function err(msg) { errors.push(msg); console.error('[ERR] ' + msg); }
function warn(msg) { warnings.push(msg); console.warn('[WARN] ' + msg); }
function info(msg) { console.log('[INFO] ' + msg); }

info('verify-artifacts.js — Trae task-35-37 rebound');
info('INV: ' + INV);
info('TST: ' + TST);
info('REPORT: ' + REPORT);

// 1. File existence
var requiredFiles = [
  path.join(TST, 'run-contract.js'),
  path.join(TST, 'mutation-probes.js'),
  path.join(TST, 'verify-artifacts.js'),
  path.join(INV, 'protected-files-manifest.json'),
  path.join(INV, 'contract-result.json')
];
requiredFiles.forEach(function(f) {
  if (!fs.existsSync(f)) err('missing required file: ' + f);
});

// 2. No stale old-agent references in runner source
var runnerSrc = fs.readFileSync(path.join(TST, 'run-contract.js'), 'utf8');
var stalePatterns = [
  { re: /agent-a-v4\.3-deletion-safety-repair-35/, label: 'stale agent-a task-35 dir' },
  { re: /agent-a-v4\.3-deletion-safety-expected-red/, label: 'stale agent-a task-26 dir' },
  { re: /agent-workbuddy/, label: 'stale WorkBuddy agent reference' },
  { re: /repair-16/, label: 'stale repair-16 inventory reference' },
  { re: /artifact-rebind-26/, label: 'stale artifact-rebind-26 reference' },
  { re: /XJ-5\.0\.0-trae-v4\.3-deletion-safety-expected-red/, label: 'stale task-26 task_id' }
];
stalePatterns.forEach(function(p) {
  if (runnerSrc.match(p.re)) err('runner contains ' + p.label);
});

// 3. runner must contain the new task_id and new path roots
if (runnerSrc.indexOf(EXPECTED_TASK_ID) < 0) err('runner missing new task_id: ' + EXPECTED_TASK_ID);
if (runnerSrc.indexOf('trae-v4.3-deletion-safety-repair-35-37') < 0) err('runner missing new inventory/test path fragment');

// 4. Contract result shape
var resultPath = path.join(INV, 'contract-result.json');
if (fs.existsSync(resultPath)) {
  var result;
  try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8')); }
  catch (e) { err('contract-result.json is not valid JSON: ' + e.message); result = null; }
  if (result) {
    if (result.task_id !== EXPECTED_TASK_ID) err('result.task_id mismatch: got "' + result.task_id + '", expected "' + EXPECTED_TASK_ID + '"');
    if (typeof result.confirmed !== 'number') err('result.confirmed must be a number');
    if (typeof result.expected_red !== 'number') err('result.expected_red must be a number');
    if (typeof result.failed !== 'number') err('result.failed must be a number');
    if (!Array.isArray(result.checks)) err('result.checks must be an array');
    if (result.failed !== 0) err('result.failed must be 0 (all non-EXPECTED_RED checks must pass); got ' + result.failed);
    if (result.base_commit !== '9971787eb6e443ab5a5c80aee118b9b43285c093') warn('base_commit mismatch from expected base (acceptable if you intentionally rebased, but check)');

    // Validate every check
    var cCount = 0, erCount = 0;
    result.checks.forEach(function(c) {
      if (c.classification === 'CONFIRMED') { cCount++; if (!c.pass) err('CONFIRMED check failed: ' + c.id); }
      else if (c.classification === 'EXPECTED_RED') { erCount++; }
      else err('unknown classification for check ' + c.id + ': ' + c.classification);
    });
    if (cCount !== result.confirmed) err('CONFIRMED count mismatch: counted ' + cCount + ' vs declared ' + result.confirmed);
    if (erCount !== result.expected_red) err('EXPECTED_RED count mismatch: counted ' + erCount + ' vs declared ' + result.expected_red);
    info('checks: confirmed=' + result.confirmed + ' expected_red=' + result.expected_red + ' failed=' + result.failed);

    // Spot-check: R10 and R11 must be CONFIRMED PASS (origin preservation + import quarantine)
    var r10 = result.checks.find(function(c) { return c.id === 'R10'; });
    var r11 = result.checks.find(function(c) { return c.id === 'R11'; });
    if (!r10 || r10.pass !== true || r10.classification !== 'CONFIRMED') err('R10 must be CONFIRMED PASS (real origin preservation probe)');
    if (!r11 || r11.pass !== true || r11.classification !== 'CONFIRMED') err('R11 must be CONFIRMED PASS (real import quarantine probe)');

    // R1-R9: deletion-safety APIs are implemented at base_commit; these are now real behavior probes
    ['R1','R2','R3','R4','R5','R6','R7','R8','R9'].forEach(function(id) {
      var c = result.checks.find(function(x) { return x.id === id; });
      if (!c) err('missing required check ' + id);
      else if (c.classification !== 'CONFIRMED' || c.pass !== true) err(id + ' must be CONFIRMED PASS (implemented deletion-safety API), got classification=' + c.classification + ' pass=' + c.pass);
    });

    // R12-R15: persistence-failure safety, batch auditability, read-projection filtering
    ['R12','R13','R14','R15'].forEach(function(id) {
      var c = result.checks.find(function(x) { return x.id === id; });
      if (!c) err('missing required check ' + id);
      else if (c.classification !== 'CONFIRMED' || c.pass !== true) err(id + ' must be CONFIRMED PASS, got classification=' + c.classification + ' pass=' + c.pass);
    });

    // ER1-ER4: policy requirements confirmed implemented (no purge, concurrency guard, restore quarantine, export coverage)
    ['ER1','ER2','ER3','ER4'].forEach(function(id) {
      var c = result.checks.find(function(x) { return x.id === id; });
      if (!c) err('missing required check ' + id);
      else if (c.classification !== 'CONFIRMED' || c.pass !== true) err(id + ' must be CONFIRMED PASS, got classification=' + c.classification + ' pass=' + c.pass);
    });

    // ER5: UI success-before-persistence guard is a UI-layer concern and remains EXPECTED_RED
    var er5 = result.checks.find(function(x) { return x.id === 'ER5'; });
    if (!er5) err('missing required check ER5');
    else if (er5.classification !== 'EXPECTED_RED') err('ER5 must remain EXPECTED_RED (UI-layer guard not in Store)');
  }
}

// 5. Mutation probes source must not contain stale references either
if (fs.existsSync(path.join(TST, 'mutation-probes.js'))) {
  var mutSrc = fs.readFileSync(path.join(TST, 'mutation-probes.js'), 'utf8');
  if (mutSrc.match(/agent-workbuddy/)) err('mutation-probes.js contains stale WorkBuddy reference');
  if (mutSrc.match(/repair-16/)) err('mutation-probes.js contains stale repair-16 reference');
  if (mutSrc.match(/artifact-rebind-26/)) err('mutation-probes.js contains stale artifact-rebind-26 reference');
}

// 6. Report existence check (advisory — written later in the flow)
if (!fs.existsSync(REPORT)) warn('delivery report not yet written (expected before final delivery): ' + REPORT);

console.log('----------------------------------------');
console.log('Errors: ' + errors.length + ' | Warnings: ' + warnings.length);
if (errors.length > 0) {
  errors.forEach(function(e) { console.error('  - ' + e); });
  process.exit(1);
} else {
  info('verify-artifacts.js: ALL CHECKS PASSED');
  process.exit(0);
}
