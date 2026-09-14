'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
const EVIDENCE_ROOT = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.2-masters-fold-fix-003', 'expected-red-003');
const SUMMARY_FILE = path.join(EVIDENCE_ROOT, 'expected-red-summary.json');
const EXPECTED_IDS = [
  'ER1-remove-click-listener', 'ER2-fixed-grid-track', 'ER3-aria-only',
  'ER4-no-restore', 'ER5-horizontal-overflow', 'ER6-keyboard-handler',
];

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function isWithin(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function check(checks, label, pass, details) { checks.push({ label, pass: !!pass, details: details || null }); }
function verifyRaw(checks, meta, fieldPath, hashField, bytesField) {
  const file = meta[fieldPath];
  check(checks, fieldPath + ' is absolute', path.isAbsolute(file), file);
  check(checks, fieldPath + ' remains inside evidence root', isWithin(EVIDENCE_ROOT, file), file);
  const exists = typeof file === 'string' && fs.existsSync(file);
  check(checks, fieldPath + ' exists', exists, file);
  if (!exists) return;
  const bytes = fs.readFileSync(file);
  check(checks, fieldPath + ' byte count matches', bytes.length === meta[bytesField], { expected:meta[bytesField], actual:bytes.length });
  check(checks, fieldPath + ' SHA matches', sha256(bytes) === meta[hashField], { expected:meta[hashField], actual:sha256(bytes) });
}

function main() {
  const checks = [];
  let summary = null;
  try { summary = readJson(SUMMARY_FILE); } catch (error) { check(checks, 'summary readable', false, error.message); }
  check(checks, 'summary version', summary && summary.version === 'expected-red-003-v1', summary && summary.version);
  check(checks, 'summary task id', summary && summary.taskId === 'XJ-5.1.2-masters-fold-fix-003', summary && summary.taskId);
  check(checks, 'summary case count', summary && summary.caseCount === EXPECTED_IDS.length, summary && summary.caseCount);
  check(checks, 'summary unique case ids', summary && Array.isArray(summary.cases) && JSON.stringify(summary.cases.map((item) => item.id)) === JSON.stringify(EXPECTED_IDS), summary && summary.cases && summary.cases.map((item) => item.id));
  const cases = summary && Array.isArray(summary.cases) ? summary.cases : [];
  for (const item of cases) {
    check(checks, item.id + ' baseline/mutated records', !!item.baseline && !!item.mutated, null);
    for (const mode of ['baseline', 'mutated']) {
      const record = item[mode];
      if (!record || !record.meta) continue;
      const meta = record.meta;
      check(checks, item.id + '/' + mode + ' task id', meta.taskId === 'XJ-5.1.2-masters-fold-fix-003', meta.taskId);
      check(checks, item.id + '/' + mode + ' mode', meta.mode === mode, meta.mode);
      check(checks, item.id + '/' + mode + ' case id', meta.caseId === item.id, meta.caseId);
      check(checks, item.id + '/' + mode + ' command/cwd binding', Array.isArray(meta.command) && meta.command.length >= 5 && path.isAbsolute(meta.cwd), { command:meta.command, cwd:meta.cwd });
      check(checks, item.id + '/' + mode + ' exit code', Number.isInteger(meta.exitCode), meta.exitCode);
      check(checks, item.id + '/' + mode + ' raw paths unique', meta.stdoutPath !== meta.stderrPath, { stdout:meta.stdoutPath, stderr:meta.stderrPath });
      verifyRaw(checks, meta, 'stdoutPath', 'stdoutSha256', 'stdoutBytes');
      verifyRaw(checks, meta, 'stderrPath', 'stderrSha256', 'stderrBytes');
      check(checks, item.id + '/' + mode + ' stdout result binding', record.result && record.result.mode === mode && record.result.caseId === item.id, record.result && { mode:record.result.mode, caseId:record.result.caseId });
      check(checks, item.id + '/' + mode + ' expected status', mode === 'baseline' ? (meta.exitCode === 0 && record.result && record.result.status === 'PASS') : (meta.exitCode !== 0 && record.result && record.result.status === 'FAIL'), { exitCode:meta.exitCode, status:record.result && record.result.status });
    }
    check(checks, item.id + ' killed', item.killed === true && item.baseline.meta.exitCode === 0 && item.mutated.meta.exitCode !== 0, { killed:item.killed, baseline:item.baseline.meta.exitCode, mutated:item.mutated.meta.exitCode });
  }
  check(checks, 'summary killed count', summary && summary.killedCount === EXPECTED_IDS.length, summary && summary.killedCount);
  check(checks, 'summary status', summary && summary.status === 'PASS', summary && summary.status);
  const result = { taskId:'XJ-5.1.2-masters-fold-fix-003', verifier:'verify-expected-red-003', checkCount:checks.length, errorCount:checks.filter((item) => !item.pass).length, status:checks.every((item) => item.pass) ? 'PASS' : 'FAIL', checks };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status === 'PASS' ? 0 : 2;
}

main();
