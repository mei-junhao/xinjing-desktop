'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../../..');
const TASK = 'XJ-5.1.0-pi-workbench-mainline-merge-and-candidate-rebind-049';
const candidate = path.join(ROOT, 'qa/package-candidates/5.1.0/pi-workbench-049');
const evidence = path.join(ROOT, 'qa/task-scratch', TASK, 'evidence');
const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'candidate-manifest-049.json'), 'utf8'));
const aggregate = JSON.parse(fs.readFileSync(path.join(candidate, 'candidate-aggregate-049.json'), 'utf8'));
const electron = JSON.parse(fs.readFileSync(path.join(evidence, 'electron-results.json'), 'utf8'));
const adversarial = JSON.parse(fs.readFileSync(path.join(evidence, 'adversarial-049.json'), 'utf8'));
const expectedRed = JSON.parse(fs.readFileSync(path.join(evidence, 'expected-red-049.json'), 'utf8'));
const matrix = JSON.parse(fs.readFileSync(path.join(evidence, 'electron-matrix.json'), 'utf8'));
const runs = JSON.parse(fs.readFileSync(path.join(evidence, 'runs-bindings-049.json'), 'utf8'));
const uiRaw = fs.readFileSync(path.join(evidence, 'ui-005-fixed-049.stdout.raw'), 'utf8');
const uiPass = /SUMMARY electron pass=17 fail=0/.test(uiRaw);
const out = {
  task_id: TASK,
  candidate: { id: manifest.candidate_id, files: manifest.files.length, manifest_sha256: aggregate.snapshot['candidate-manifest-049.json'].sha256, candidate_files_sha256: aggregate.snapshot['candidate-files-049.txt'].sha256, aggregate_sha256: aggregate.aggregate_sha256, flags: manifest.flags },
  runtime: { electron_harness: { passed: electron.passed, failed: electron.failed }, chat_home_workbench: { passed: uiPass ? 17 : null, failed: uiPass ? 0 : null, stdout: 'ui-005-fixed-049.stdout.raw', stderr: 'ui-005-fixed-049.stderr.raw', note: 'fresh sourceRefs-seeded production chat-home flow' } },
  visual: { cells: matrix.cells.length, screenshot_unique_sha256: new Set(matrix.cells.map((c) => c.screenshot.sha256)).size, matrix_verifier_exit: runs.runs.matrixVerifier.exit },
  adversarial: { runtime_count: adversarial.count, runtime_killed: adversarial.killed, evidence_count: expectedRed.count, evidence_killed: expectedRed.killed },
  baseline: { self_test_exit: runs.runs.selfTest.exit, self_test_failure: 'L12 packaged client exposes verification keys only and no HMAC issuer: package must include proxy-secret.generated.js; pre-existing shared-tree baseline, out-of-scope for 049' },
  evidence_disclosure: { initial_049_harness_failure: 'First Electron attempt omitted copied harness.html in the fresh scratch; build-evidence-049.js was corrected to copy harness.html and rerun. Final evidence is from the corrected second run.', old_ui_005_attempt: 'Old fixture lacked non-empty sourceRefs and produced 12/17; retained as historical diagnostic only, not used for final pass.' },
};
fs.writeFileSync(path.join(evidence, 'evidence-summary-049.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(out, null, 2));
