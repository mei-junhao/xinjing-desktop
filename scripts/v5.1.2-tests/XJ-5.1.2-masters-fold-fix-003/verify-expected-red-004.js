'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
const TASK_ID = process.env.XJ_TASK_ID || 'XJ-5.1.2-masters-fold-evidence-process-cleanup-rework-004';
const EVIDENCE_ROOT = path.resolve(process.env.XJ_EXPECTED_RED_ROOT || path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.2-masters-fold-evidence-process-cleanup-rework-004', 'expected-red'));
const SUMMARY_FILE = path.join(EVIDENCE_ROOT, 'expected-red-summary.json');
const EXPECTED_IDS = [
  'ER1-remove-click-listener', 'ER2-fixed-grid-track', 'ER3-aria-only',
  'ER4-no-restore', 'ER5-horizontal-overflow', 'ER6-keyboard-handler',
];
const EXPECTED_SOURCE = {
  'app/masters.html': { sha256:'78A43F422CDCE6902AF78E6F2D48642D42D138C5E485E5DF7C18E8084DF4EA9F', bytes:11748 },
  'app/js/masters.js': { sha256:'6FC8C2A6EBF8B32C635FAE79427EEE8E7219211FBC9EFC0193B63FA139A4495E', bytes:52371 },
  'app/css/masters-clinical.css': { sha256:'2563CF6C266BFAF9DF554645642E23690378A1DB7A4286C49B980BCDADED09CA', bytes:24469 },
};

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function isWithin(root, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function isIso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function check(checks, label, pass, details) { checks.push({ label, pass:!!pass, details:details === undefined ? null : details }); }
function verifyRaw(checks, meta, fieldPath, hashField, bytesField) {
  const file = meta[fieldPath];
  check(checks, fieldPath + ' absolute', path.isAbsolute(file), file);
  check(checks, fieldPath + ' inside fresh evidence root', isWithin(EVIDENCE_ROOT, file), file);
  check(checks, fieldPath + ' does not reuse 003 evidence', typeof file === 'string' && !file.includes('XJ-5.1.2-masters-fold-fix-003'), file);
  const exists = typeof file === 'string' && fs.existsSync(file);
  check(checks, fieldPath + ' exists', exists, file);
  if (!exists) return;
  const bytes = fs.readFileSync(file);
  const actualSha = sha256(bytes);
  check(checks, fieldPath + ' bytes match', bytes.length === meta[bytesField], { expected:meta[bytesField], actual:bytes.length });
  check(checks, fieldPath + ' SHA match', actualSha === meta[hashField], { expected:meta[hashField], actual:actualSha });
}
function verifyCleanup(checks, item, mode, record) {
  const cleanup = record && record.cleanup;
  check(checks, item.id + '/' + mode + ' cleanup object', !!cleanup && typeof cleanup === 'object', cleanup);
  check(checks, item.id + '/' + mode + ' cleanup bounded success', cleanup && cleanup.ok === true, cleanup && cleanup.ok);
  check(checks, item.id + '/' + mode + ' cleanup tree exited', cleanup && cleanup.treeExited === true, cleanup && cleanup.treeExited);
  check(checks, item.id + '/' + mode + ' cleanup userData removed', cleanup && cleanup.userDataRemoved === true, cleanup && cleanup.userDataRemoved);
  check(checks, item.id + '/' + mode + ' cleanup did not timeout', cleanup && cleanup.events && !cleanup.events.includes('cleanup-incomplete') && cleanup.events.every((entry) => !String(entry).includes('timeout')), cleanup && cleanup.events);
  check(checks, item.id + '/' + mode + ' cleanup root confirmed', cleanup && cleanup.rootConfirmed === true, cleanup && cleanup.rootConfirmed);
  check(checks, item.id + '/' + mode + ' cleanup target evidence', cleanup && typeof cleanup.userData === 'string' && cleanup.userData.length > 0 && Number.isInteger(cleanup.rootPid) && cleanup.rootPid > 0, cleanup && { userData:cleanup.userData, rootPid:cleanup.rootPid });
}

function main() {
  const checks = [];
  let summary = null;
  try { summary = readJson(SUMMARY_FILE); } catch (error) { check(checks, 'summary readable', false, error.message); }
  check(checks, 'summary version', summary && summary.version === 'expected-red-004-v1', summary && summary.version);
  check(checks, 'summary task id', summary && summary.taskId === TASK_ID, summary && summary.taskId);
  check(checks, 'summary case count', summary && summary.caseCount === EXPECTED_IDS.length, summary && summary.caseCount);
  check(checks, 'summary killed count', summary && summary.killedCount === EXPECTED_IDS.length, summary && summary.killedCount);
  check(checks, 'summary bounded elapsed time', summary && Number.isFinite(summary.elapsedMs) && summary.elapsedMs <= 180000, summary && summary.elapsedMs);
  const cases = summary && Array.isArray(summary.cases) ? summary.cases : [];
  check(checks, 'summary unique case ids', cases.length === EXPECTED_IDS.length && JSON.stringify(cases.map((item) => item.id)) === JSON.stringify(EXPECTED_IDS), cases.map((item) => item.id));
  const seenRaw = new Set();
  for (const item of cases) {
    check(checks, item.id + ' baseline/mutated records', !!item.baseline && !!item.mutated, null);
    for (const mode of ['baseline', 'mutated']) {
      const record = item[mode];
      const meta = record && record.meta;
      check(checks, item.id + '/' + mode + ' metadata present', !!meta, null);
      if (!meta) continue;
      check(checks, item.id + '/' + mode + ' task id', meta.taskId === TASK_ID, meta.taskId);
      check(checks, item.id + '/' + mode + ' mode', meta.mode === mode, meta.mode);
      check(checks, item.id + '/' + mode + ' case id', meta.caseId === item.id, meta.caseId);
      check(checks, item.id + '/' + mode + ' command exact child binding', Array.isArray(meta.command) && meta.command.length === 5 && meta.command[1] === path.join(ROOT, 'scripts', 'v5.1.2-tests', 'XJ-5.1.2-masters-fold-fix-003', 'expected-red-003.js') && meta.command[2] === '--child' && meta.command[3] === item.id && meta.command[4] === mode, meta.command);
      check(checks, item.id + '/' + mode + ' cwd binding', meta.cwd === ROOT && path.isAbsolute(meta.cwd), meta.cwd);
      check(checks, item.id + '/' + mode + ' timestamps', isIso(meta.startedAt) && isIso(meta.finishedAt) && Date.parse(meta.finishedAt) >= Date.parse(meta.startedAt), { startedAt:meta.startedAt, finishedAt:meta.finishedAt });
      check(checks, item.id + '/' + mode + ' exit code integer', Number.isInteger(meta.exitCode), meta.exitCode);
      check(checks, item.id + '/' + mode + ' pid integer', Number.isInteger(meta.pid) && meta.pid > 0, meta.pid);
      check(checks, item.id + '/' + mode + ' no timeout', meta.timedOut === false, meta.timedOut);
      check(checks, item.id + '/' + mode + ' child tree exited', meta.childTreeExited === true, meta.childTreeExited);
      check(checks, item.id + '/' + mode + ' raw paths distinct', meta.stdoutPath !== meta.stderrPath, { stdout:meta.stdoutPath, stderr:meta.stderrPath });
      for (const field of ['stdoutPath', 'stderrPath']) {
        if (typeof meta[field] === 'string') seenRaw.add(meta[field]);
      }
      verifyRaw(checks, meta, 'stdoutPath', 'stdoutSha256', 'stdoutBytes');
      verifyRaw(checks, meta, 'stderrPath', 'stderrSha256', 'stderrBytes');
      check(checks, item.id + '/' + mode + ' result binding', record.result && record.result.taskId === TASK_ID && record.result.caseId === item.id && record.result.mode === mode, record.result && { taskId:record.result.taskId, caseId:record.result.caseId, mode:record.result.mode });
      check(checks, item.id + '/' + mode + ' expected status', mode === 'baseline' ? meta.exitCode === 0 && record.result && record.result.status === 'PASS' : meta.exitCode !== 0 && record.result && record.result.status === 'FAIL', { exitCode:meta.exitCode, status:record.result && record.result.status });
      verifyCleanup(checks, item, mode, record && record.result);
      if (mode === 'baseline') {
        const hashes = record.result && record.result.productionHashes;
        for (const [rel, expected] of Object.entries(EXPECTED_SOURCE)) {
          if (rel === 'app/masters.html') continue;
          const actual = hashes && hashes[rel];
          check(checks, item.id + '/baseline ' + rel + ' source binding', !!actual && actual.sha256 === expected.sha256 && actual.bytes === expected.bytes, { expected, actual });
        }
      }
    }
    check(checks, item.id + ' killed', item.killed === true && item.baseline && item.mutated && item.baseline.meta.exitCode === 0 && item.mutated.meta.exitCode !== 0, { killed:item.killed, baseline:item.baseline && item.baseline.meta.exitCode, mutated:item.mutated && item.mutated.meta.exitCode });
  }
  check(checks, 'raw files unique', seenRaw.size === EXPECTED_IDS.length * 2 * 2, { expected:EXPECTED_IDS.length * 2 * 2, actual:seenRaw.size });
  check(checks, 'summary status', summary && summary.status === 'PASS', summary && summary.status);
  const result = { taskId:TASK_ID, verifier:'verify-expected-red-004', evidenceRoot:EVIDENCE_ROOT, checkCount:checks.length, errorCount:checks.filter((item) => !item.pass).length, status:checks.every((item) => item.pass) ? 'PASS' : 'FAIL', checks };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status === 'PASS' ? 0 : 2;
}

main();
