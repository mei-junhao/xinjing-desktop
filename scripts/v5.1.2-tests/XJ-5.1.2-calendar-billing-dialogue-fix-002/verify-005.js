'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
const TASK_ID = process.env.XJ_TASK_ID || 'XJ-5.1.2-calendar-billing-evidence-process-cleanup-rework-005';
const HARNESS_TASK_ID = 'XJ-5.1.2-calendar-billing-dialogue-fix-002';
const CARD_SHA = '2222C14D6BD5ECD7A84E10ECCCE706354E14E9289A0ED8FF227115B05873DD99';
const BASE_ROOT = path.join(ROOT, 'qa', 'task-scratch', TASK_ID);
const MANIFEST_FILE = path.resolve(process.env.XJ_EVIDENCE_MANIFEST || path.join(BASE_ROOT, 'latest-manifest.json'));
const DEFAULT_ROOT = path.resolve(process.env.XJ_EVIDENCE_ROOT || BASE_ROOT);
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const EXPECTED_PRODUCTION = {
  'app/session-calendar.html': { sha256: '6703DC3C17E8CC5DEBA7AAD05F4C27917EF5C5EFD23E34D370FE9A65FCE0DEE3', bytes: 18101 },
  'app/js/session-calendar.js': { sha256: '36F547E279BF6FD3BA0F217143EF6346039D3051FF82FC05BFED6D9D168EE8F9', bytes: 44612 },
  'app/billing-shell.html': { sha256: 'D04FC18D675F2179B489593EDC4C96CACEEF6692F0426BE5169DDE7EB5AAFC8F', bytes: 178447 },
  'app/js/billing-calendar.js': { sha256: '48A5B324E0884C1CE97FB2BB138A7A094F0DF391BB08754D68157756FE07FA6C', bytes: 46131 },
};
const EXPECTED_RUNTIME_SCENARIOS = [
  'deletion-trusted-click-cancel-enter-restart',
  'deletion-durable-failure-fail-closed',
  'billing-calendar-free-preview',
  'billing-calendar-authorized-navigation-render',
];
const EXPECTED_MUTATIONS = [
  'ER1-remove-handler',
  'ER2-swallow-durable-failure',
  'ER3-success-ui-first',
  'ER4-billing-no-render',
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizePath(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function isWithin(root, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function isIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function check(checks, label, pass, details) {
  checks.push({ label, pass: !!pass, details: details === undefined ? null : details });
}

function verifyFileDigest(checks, file, expectedBytes, expectedSha, label) {
  const exists = typeof file === 'string' && fs.existsSync(file);
  check(checks, label + ' exists', exists, file);
  if (!exists) return;
  const bytes = fs.readFileSync(file);
  check(checks, label + ' bytes match', bytes.length === expectedBytes, { expected: expectedBytes, actual: bytes.length });
  check(checks, label + ' SHA match', sha256(bytes) === expectedSha, { expected: expectedSha, actual: sha256(bytes) });
}

function verifyRaw(checks, raw, label, evidenceRoot) {
  check(checks, label + ' object', !!raw && typeof raw === 'object', raw);
  if (!raw || typeof raw !== 'object') return;
  check(checks, label + ' task binding', raw.taskId === HARNESS_TASK_ID, raw.taskId);
  check(checks, label + ' runtime run id', typeof raw.runtimeRunId === 'string' && raw.runtimeRunId.length > 0, raw.runtimeRunId);
  check(checks, label + ' root pid', Number.isInteger(raw.rootPid) && raw.rootPid > 0, raw.rootPid);
  check(checks, label + ' port', Number.isInteger(raw.port) && raw.port > 0, raw.port);
  check(checks, label + ' userData absolute', typeof raw.userData === 'string' && path.isAbsolute(raw.userData), raw.userData);
  check(checks, label + ' command exact', Array.isArray(raw.command) && sameJson(raw.command.slice(0, 1), [ELECTRON]) && raw.command.length >= 2, raw.command);
  check(checks, label + ' cwd exact', raw.cwd === ROOT && path.isAbsolute(raw.cwd), raw.cwd);
  check(checks, label + ' exit alias', raw.exit === raw.exitCode && Number.isInteger(raw.exitCode), { exit: raw.exit, exitCode: raw.exitCode });
  check(checks, label + ' stdout/stderr distinct', raw.stdout && raw.stderr && raw.stdout.file !== raw.stderr.file, { stdout: raw.stdout && raw.stdout.file, stderr: raw.stderr && raw.stderr.file });
  for (const stream of ['stdout', 'stderr']) {
    const entry = raw[stream];
    const streamLabel = label + ' ' + stream;
    check(checks, streamLabel + ' metadata', !!entry && typeof entry === 'object', entry);
    if (!entry || typeof entry !== 'object') continue;
    check(checks, streamLabel + ' absolute', path.isAbsolute(entry.file), entry.file);
    check(checks, streamLabel + ' inside fresh evidence', isWithin(evidenceRoot, entry.file), entry.file);
    check(checks, streamLabel + ' not old evidence', !String(entry.file).includes('calendar-billing-dialogue-fix-002\\expected-red-002'), entry.file);
    verifyFileDigest(checks, entry.file, entry.bytes, entry.sha256, streamLabel);
  }
  const cleanup = raw.cleanup;
  check(checks, label + ' cleanup present', !!cleanup && typeof cleanup === 'object', cleanup);
  if (!cleanup || typeof cleanup !== 'object') return;
  check(checks, label + ' cleanup root binding', cleanup.rootPid === raw.rootPid, { raw: raw.rootPid, cleanup: cleanup.rootPid });
  check(checks, label + ' cleanup userData binding', normalizePath(cleanup.userData) === normalizePath(raw.userData), { raw: raw.userData, cleanup: cleanup.userData });
  check(checks, label + ' cleanup port binding', cleanup.port === raw.port, { raw: raw.port, cleanup: cleanup.port });
  check(checks, label + ' cleanup command binding', sameJson(cleanup.command, raw.command), { raw: raw.command, cleanup: cleanup.command });
  check(checks, label + ' cleanup cwd binding', cleanup.cwd === raw.cwd, { raw: raw.cwd, cleanup: cleanup.cwd });
  check(checks, label + ' cleanup tree exited', cleanup.treeExited === true, cleanup.treeExited);
  check(checks, label + ' cleanup child tree exited', cleanup.childTreeExited === true, cleanup.childTreeExited);
  check(checks, label + ' cleanup root confirmed', cleanup.rootConfirmed === true, cleanup.rootConfirmed);
  check(checks, label + ' cleanup inspection available', cleanup.launchProcess && cleanup.launchProcess.inspectionAvailable === true, cleanup.launchProcess && cleanup.launchProcess.inspectionAvailable);
  check(checks, label + ' cleanup no swallowed timeout', cleanup.timedOut === false && cleanup.naturalExitWindowExpired === false && Number.isFinite(cleanup.elapsedMs) && cleanup.elapsedMs <= 10000, { timedOut: cleanup.timedOut, naturalExitWindowExpired: cleanup.naturalExitWindowExpired, elapsedMs: cleanup.elapsedMs });
  check(checks, label + ' cleanup no unsafe/incomplete event', Array.isArray(cleanup.events) && cleanup.events.every((event) => !/timeout|incomplete|unsafe|inspection-failed/i.test(String(event))), cleanup.events);
  check(checks, label + ' cleanup tracked pids', Array.isArray(cleanup.trackedPids) && cleanup.trackedPids.length > 0 && new Set(cleanup.trackedPids).size === cleanup.trackedPids.length && cleanup.trackedPids.includes(raw.rootPid), cleanup.trackedPids);
  check(checks, label + ' cleanup launch root binding', cleanup.launchProcess && cleanup.launchProcess.rootPid === raw.rootPid && cleanup.launchProcess.port === raw.port && normalizePath(cleanup.launchProcess.userData) === normalizePath(raw.userData), cleanup.launchProcess);
  check(checks, label + ' cleanup after tree empty', Array.isArray(cleanup.afterTree) && cleanup.afterTree.length === 0, cleanup.afterTree);
  check(checks, label + ' cleanup exit code binding', Number.isInteger(cleanup.exitCode) && cleanup.exitCode === raw.exitCode, { cleanup: cleanup.exitCode, raw: raw.exitCode });
  if (cleanup.forcedKill) {
    const command = cleanup.termination && cleanup.termination.kill && cleanup.termination.kill.command;
    check(checks, label + ' forced kill confirmed', cleanup.termination && cleanup.termination.attempted === true && cleanup.termination.confirmed === true, cleanup.termination);
    check(checks, label + ' forced kill is recursive', Array.isArray(command) && command.includes('/T') && command.includes('/F') && command.includes(String(raw.rootPid)), command);
  }
  const binding = raw.binding;
  check(checks, label + ' raw binding object', !!binding && typeof binding === 'object', binding);
  if (binding && typeof binding === 'object') {
    check(checks, label + ' raw binding exact', binding.taskId === raw.taskId && binding.runtimeRunId === raw.runtimeRunId && binding.rootPid === raw.rootPid && binding.port === raw.port && normalizePath(binding.userData) === normalizePath(raw.userData) && sameJson(binding.command, raw.command) && binding.cwd === raw.cwd && binding.cleanupRootPid === cleanup.rootPid && binding.cleanupTreeExited === cleanup.treeExited, binding);
  }
}

function verifyRuntimeSummary(checks, summary, evidenceRoot) {
  check(checks, 'runtime summary object', !!summary && typeof summary === 'object', summary);
  if (!summary || typeof summary !== 'object') return;
  check(checks, 'runtime task id', summary.taskId === HARNESS_TASK_ID, summary.taskId);
  check(checks, 'runtime evidence task id', summary.evidenceTaskId === TASK_ID, summary.evidenceTaskId);
  check(checks, 'runtime card sha', summary.cardSha256 === CARD_SHA, summary.cardSha256);
  check(checks, 'runtime evidence root', normalizePath(summary.evidenceRoot) === normalizePath(evidenceRoot), { summary: summary.evidenceRoot, expected: evidenceRoot });
  check(checks, 'runtime status PASS', summary.status === 'PASS', summary.status);
  check(checks, 'runtime elapsed bounded', Number.isFinite(summary.finishedAt && Date.parse(summary.finishedAt)) && Number.isFinite(summary.startedAt && Date.parse(summary.startedAt)), { startedAt: summary.startedAt, finishedAt: summary.finishedAt });
  check(checks, 'runtime scenarios exact', Array.isArray(summary.results) && sameJson(summary.results.map((item) => item.scenario), EXPECTED_RUNTIME_SCENARIOS), summary.results && summary.results.map((item) => item.scenario));
  for (const [rel, expected] of Object.entries(EXPECTED_PRODUCTION)) {
    const actual = summary.productionHashes && summary.productionHashes[rel];
    check(checks, 'production hash ' + rel, !!actual && actual.sha256 === expected.sha256 && actual.bytes === expected.bytes, { expected, actual });
  }
  for (const result of summary.results || []) {
    check(checks, result.scenario + ' PASS', result.status === 'PASS', result.status);
    const rawEntries = [result.raw];
    if (result.restartRaw) rawEntries.push(result.restartRaw);
    for (let index = 0; index < rawEntries.length; index += 1) verifyRaw(checks, rawEntries[index], 'runtime/' + result.scenario + '/' + index, evidenceRoot);
    if (result.scenario === EXPECTED_RUNTIME_SCENARIOS[0]) {
      check(checks, result.scenario + ' restart raw exists', !!result.restartRaw, result.restartRaw);
      check(checks, result.scenario + ' first raw intentionally retains userData', result.raw && result.raw.cleanup && result.raw.cleanup.userDataRemovalRequested === false && result.raw.cleanup.userDataRemoved === false, result.raw && result.raw.cleanup);
    } else {
      check(checks, result.scenario + ' userData removed', result.raw && result.raw.cleanup && result.raw.cleanup.userDataRemovalRequested === true && result.raw.cleanup.userDataRemoved === true, result.raw && result.raw.cleanup);
    }
  }
}

function verifyMutationSummary(checks, summary, evidenceRoot) {
  check(checks, 'mutation summary object', !!summary && typeof summary === 'object', summary);
  if (!summary || typeof summary !== 'object') return;
  check(checks, 'mutation task id', summary.taskId === HARNESS_TASK_ID, summary.taskId);
  check(checks, 'mutation evidence task id', summary.evidenceTaskId === TASK_ID, summary.evidenceTaskId);
  check(checks, 'mutation evidence root', normalizePath(summary.evidenceRoot) === normalizePath(evidenceRoot), { summary: summary.evidenceRoot, expected: evidenceRoot });
  check(checks, 'mutation status PASS', summary.status === 'PASS', summary.status);
  check(checks, 'mutation case count', summary.caseCount === EXPECTED_MUTATIONS.length, summary.caseCount);
  check(checks, 'mutation killed count', summary.killedCount === EXPECTED_MUTATIONS.length, summary.killedCount);
  check(checks, 'mutation cases exact', Array.isArray(summary.cases) && sameJson(summary.cases.map((item) => item.id), EXPECTED_MUTATIONS), summary.cases && summary.cases.map((item) => item.id));
  for (const item of summary.cases || []) {
    check(checks, item.id + ' killed', item.killed === true, item.killed);
    for (const mode of ['baseline', 'mutated']) {
      const record = item[mode];
      check(checks, item.id + '/' + mode + ' record', !!record && typeof record === 'object', record);
      if (!record) continue;
      check(checks, item.id + '/' + mode + ' status', record.status === (mode === 'baseline' ? 'PASS' : 'FAIL'), record.status);
      verifyRaw(checks, record.raw, 'mutation/' + item.id + '/' + mode, evidenceRoot);
    }
  }
}

function main() {
  const checks = [];
  let manifest = null;
  try { manifest = readJson(MANIFEST_FILE); } catch (error) { check(checks, 'manifest readable', false, error.message); }
  const evidenceRoot = manifest && typeof manifest.evidenceRoot === 'string' ? path.resolve(manifest.evidenceRoot) : DEFAULT_ROOT;
  check(checks, 'manifest task id', manifest && manifest.taskId === TASK_ID, manifest && manifest.taskId);
  check(checks, 'manifest evidence root absolute', path.isAbsolute(evidenceRoot), evidenceRoot);
  check(checks, 'manifest evidence root fresh', normalizePath(evidenceRoot).includes(normalizePath(BASE_ROOT)), evidenceRoot);
  check(checks, 'manifest runtime summary path', manifest && typeof manifest.runtimeSummary === 'string' && path.isAbsolute(manifest.runtimeSummary) && isWithin(evidenceRoot, manifest.runtimeSummary), manifest && manifest.runtimeSummary);
  check(checks, 'manifest mutation summary path', manifest && typeof manifest.mutationSummary === 'string' && path.isAbsolute(manifest.mutationSummary) && isWithin(evidenceRoot, manifest.mutationSummary), manifest && manifest.mutationSummary);
  let runtimeSummary = null;
  let mutationSummary = null;
  try { if (manifest && manifest.runtimeSummary) runtimeSummary = readJson(manifest.runtimeSummary); } catch (error) { check(checks, 'runtime summary readable', false, error.message); }
  try { if (manifest && manifest.mutationSummary) mutationSummary = readJson(manifest.mutationSummary); } catch (error) { check(checks, 'mutation summary readable', false, error.message); }
  verifyRuntimeSummary(checks, runtimeSummary, evidenceRoot);
  verifyMutationSummary(checks, mutationSummary, evidenceRoot);
  const result = {
    taskId: TASK_ID,
    verifier: 'verify-005',
    manifest: MANIFEST_FILE,
    evidenceRoot,
    checkCount: checks.length,
    errorCount: checks.filter((item) => !item.pass).length,
    status: checks.every((item) => item.pass) ? 'PASS' : 'FAIL',
    checks,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.status === 'PASS' ? 0 : 2;
}

main();
