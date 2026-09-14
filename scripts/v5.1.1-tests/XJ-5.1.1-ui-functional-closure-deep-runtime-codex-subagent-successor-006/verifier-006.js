'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
const TASK = 'XJ-5.1.1-ui-functional-closure-deep-runtime-codex-subagent-successor-006';
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', TASK);
const LEDGER = path.join(SCRATCH, 'expected-red', 'ledger-006.json');
const CARD_SHA = 'AB7E0CD30CDE71CCA189C12A7A5F41A8CFBA9E76A3835960115DE69064F3E735';
const EXPECTED_IDS = [
  'B1-delete-feedback', 'B2-drop-aria-live', 'B3-delete-focus', 'B4-swallow-ok',
  'B5-drop-await', 'B6-wrong-client', 'B7-wrong-month', 'B8-replace-add',
  'B9-drop-busy-guard', 'B10-drop-failure-copy',
  'S1-delete-failure-branch', 'S2-retry-new-file', 'S3-delete-cancel-abort',
  'S4-drop-docx-await', 'S5-drop-draft-copy',
];
const EXPECTED_TOP = ['schemaVersion', 'taskId', 'cardSha256', 'generatedAt', 'cwd', 'caseCount', 'cases', 'verdict', 'failureCount'];
const EXPECTED_CASE = ['caseId', 'kind', 'sourcePath', 'productionSha256', 'stages'];
const EXPECTED_STAGE = ['caseId', 'stage', 'expectedExit', 'exitCode', 'verdict', 'meta', 'invariants'];
const EXPECTED_META = ['taskId', 'caseId', 'stage', 'command', 'argv', 'cwd', 'startedAt', 'endedAt', 'exitCode', 'stdoutPath', 'stderrPath', 'stdoutSha256', 'stdoutBytes', 'stderrSha256', 'stderrBytes', 'sourcePath', 'sourceSha256', 'sourceBytes', 'invariants'];
const EXPECTED_INVARIANTS = ['failed', 'passed'];

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
const fail = (errors, message) => errors.push(message);
const keysExactly = (object, expected, label, errors) => {
  if (!object || typeof object !== 'object' || Array.isArray(object)) { fail(errors, label + ': not an object'); return; }
  const actual = Object.keys(object).sort();
  const wanted = expected.slice().sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(errors, label + ': field set mismatch');
};
const isUtc = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));
const contained = (candidate, root) => {
  const absolute = path.resolve(candidate);
  const base = path.resolve(root);
  const relative = path.relative(base, absolute);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
const realContained = (candidate, root) => {
  try { return contained(fs.realpathSync.native(candidate), fs.realpathSync.native(root)); } catch (_) { return false; }
};
const readJson = (file, errors, label) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { fail(errors, label + ': invalid JSON ' + error.message); return null; }
};
const rawCheck = (meta, errors, label) => {
  for (const field of ['stdoutPath', 'stderrPath']) {
    const rawPath = meta[field];
    if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath) || !contained(rawPath, SCRATCH) || !realContained(rawPath, SCRATCH)) {
      fail(errors, label + '.' + field + ': path outside task scratch');
      continue;
    }
    if (!fs.existsSync(rawPath)) { fail(errors, label + '.' + field + ': missing'); continue; }
    const raw = fs.readFileSync(rawPath, 'utf8');
    const hashField = field === 'stdoutPath' ? 'stdoutSha256' : 'stderrSha256';
    const bytesField = field === 'stdoutPath' ? 'stdoutBytes' : 'stderrBytes';
    if (sha256(raw) !== meta[hashField]) fail(errors, label + '.' + hashField + ': mismatch');
    if (Buffer.byteLength(raw) !== meta[bytesField]) fail(errors, label + '.' + bytesField + ': mismatch');
  }
};

const runtimeRawCheck = (record, errors, label) => {
  if (!record || typeof record !== 'object') { fail(errors, label + ': missing record'); return; }
  const rawPath = String(record.path || '');
  if (!path.isAbsolute(rawPath) || !contained(rawPath, SCRATCH) || !realContained(rawPath, SCRATCH)) { fail(errors, label + ': raw path outside task scratch'); return; }
  if (!fs.existsSync(rawPath)) { fail(errors, label + ': raw missing'); return; }
  const raw = fs.readFileSync(rawPath);
  if (sha256(raw) !== String(record.sha256 || '').toUpperCase()) fail(errors, label + ': SHA mismatch');
  if (raw.length !== Number(record.bytes)) fail(errors, label + ': bytes mismatch');
  if (record.exit !== 0 || record.cwd !== ROOT.replace(/\\/g, '/')) fail(errors, label + ': process envelope mismatch');
  if (typeof record.command !== 'string' || !record.command.length) fail(errors, label + ': command missing');
};

function verifyRuntimeEvidence(errors) {
  const upload = readJson(path.join(SCRATCH, 'upload-runtime-result.json'), errors, 'upload-runtime-result');
  if (upload) {
    if (upload.task !== TASK || upload.ok !== true || !Array.isArray(upload.scenarios) || upload.scenarios.length !== 3) fail(errors, 'upload-runtime: top-level contract');
    const scenarios = new Map((upload.scenarios || []).map((item) => [item.scenario, item]));
    for (const name of ['success', 'retry', 'cancel']) {
      const item = scenarios.get(name);
      if (!item || item.ok !== true || item.mutation !== 'none' || !item.runtime) { fail(errors, 'upload-runtime.' + name + ': missing PASS'); continue; }
      const states = (item.after && Array.isArray(item.after.trace) ? item.after.trace : []).map((entry) => entry.state);
      const runtime = item.runtime;
      if (!Array.isArray(runtime.unexpectedConsoleErrors) || runtime.unexpectedConsoleErrors.length !== 0) fail(errors, 'upload-runtime.' + name + ': unexpected console errors');
      if (!Array.isArray(runtime.pageErrors) || runtime.pageErrors.length !== 0) fail(errors, 'upload-runtime.' + name + ': page errors');
      if (runtime.reducedMotion !== true) fail(errors, 'upload-runtime.' + name + ': reduced motion not enabled');
      if (!Array.isArray(runtime.clickLog) || !runtime.clickLog.some((entry) => entry.selector === '#sup-report-upload-trigger')) fail(errors, 'upload-runtime.' + name + ': real trigger click missing');
      if (!Array.isArray(runtime.viewportEvidence) || runtime.viewportEvidence.length !== 3) fail(errors, 'upload-runtime.' + name + ': viewport matrix incomplete');
      for (const cell of (runtime.viewportEvidence || [])) {
        if (!cell.viewport || cell.scrollWidth > cell.clientWidth) fail(errors, 'upload-runtime.' + name + ': horizontal overflow');
        if (!cell.screenshot) { fail(errors, 'upload-runtime.' + name + ': screenshot missing'); continue; }
        runtimeRawCheck({ path: cell.screenshot.path, sha256: cell.screenshot.sha256, bytes: cell.screenshot.bytes, exit: 0, cwd: ROOT.replace(/\\/g, '/'), command: 'Page.captureScreenshot' }, errors, 'upload-runtime.' + name + '.screenshot');
      }
      if (name === 'success') {
        if (item.expected !== 'idle→uploading→progress→success' || item.after.state !== 'success' || states.indexOf('success') < 0 || !(item.after.material || '').includes('合成报告文本') || item.after.draft !== item.after.material) fail(errors, 'upload-runtime.success: state/draft contract');
      }
      if (name === 'retry') {
        const failed = item.failed || {};
        if (item.expected !== 'failure→retry→success' || item.after.state !== 'success' || states.indexOf('failure') < 0 || item.after.calls !== 2 || !Array.isArray(item.after.sizes) || item.after.sizes.length !== 2 || item.after.sizes[0] !== item.after.sizes[1] || !Array.isArray(runtime.clickLog) || !runtime.clickLog.some((entry) => entry.selector === '#sup-upload-retry') || !item.before || failed.material !== item.before.material || failed.draft !== item.before.draft) fail(errors, 'upload-runtime.retry: state/retry contract');
      }
      if (name === 'cancel') {
        if (item.expected !== 'cancel→idle' || item.after.state !== 'idle' || states.indexOf('progress') < 0 || states.indexOf('cancel') < 0 || states.indexOf('success') >= 0 || item.after.material !== item.before.material || item.after.draft !== item.before.draft) fail(errors, 'upload-runtime.cancel: state/cancel contract');
      }
    }
  }

  const billing = readJson(path.join(SCRATCH, 'billing-runtime-result.json'), errors, 'billing-runtime-result');
  if (billing) {
    const names = ['success-replace', 'add-accumulates', 'double-click-guard', 'ime-enter-safe', 'blur-safe', 'escape-cancel', 'restart-readback'];
    if (!Array.isArray(billing.scenarios) || billing.scenarios.length !== names.length || names.some((name) => !billing.scenarios.some((item) => item.name === name && item.ok === true))) fail(errors, 'billing-runtime: scenario closure');
    for (const group of ['raw', 'relaunch_raw']) {
      const bundle = billing[group];
      if (!bundle || bundle.exit !== 0 || bundle.cwd !== ROOT.replace(/\\/g, '/')) { fail(errors, 'billing-runtime.' + group + ': envelope'); continue; }
      runtimeRawCheck(bundle.stdout, errors, 'billing-runtime.' + group + '.stdout');
      runtimeRawCheck(bundle.stderr, errors, 'billing-runtime.' + group + '.stderr');
    }
    if (!billing.ids || !billing.ym) fail(errors, 'billing-runtime: seeded IDs/month missing');
  }

  const calendar = readJson(path.join(SCRATCH, 'calendar-runtime-result.json'), errors, 'calendar-runtime-result');
  if (calendar) {
    if (calendar.task !== TASK || calendar.ok !== true || !Array.isArray(calendar.steps)) fail(errors, 'calendar-runtime: top-level contract');
    const byName = new Map((calendar.steps || []).map((step) => [step.name, step]));
    const initial = byName.get('initial-month'); const next = byName.get('next-month'); const detail = byName.get('date-detail');
    if (!initial || initial.ok !== true || !initial.state || !/^\d{4}年\d{1,2}月$/.test(initial.state.label || '') || initial.state.days < 28 || initial.state.errors !== 0) fail(errors, 'calendar-runtime: initial month');
    if (!next || next.ok !== true || !next.label || next.label === (initial && initial.state && initial.state.label)) fail(errors, 'calendar-runtime: month switch');
    if (!detail || detail.ok !== true || !detail.detail || !String(detail.detail.date || '').includes(calendar.ym + '-10') || !String(detail.detail.text || '').includes('QA合成Pro来访者A-018')) fail(errors, 'calendar-runtime: date detail');
  }
}

function verify() {
  const errors = [];
  if (!fs.existsSync(LEDGER)) { fail(errors, 'ledger missing'); return errors; }
  const ledger = readJson(LEDGER, errors, 'ledger');
  if (!ledger) return errors;
  keysExactly(ledger, EXPECTED_TOP, 'ledger', errors);
  if (ledger.schemaVersion !== 1) fail(errors, 'schemaVersion must be 1');
  if (ledger.taskId !== TASK) fail(errors, 'taskId mismatch');
  if (ledger.cardSha256 !== CARD_SHA) fail(errors, 'cardSha256 mismatch');
  if (!isUtc(ledger.generatedAt)) fail(errors, 'generatedAt invalid UTC');
  if (ledger.cwd !== ROOT.replace(/\\/g, '/')) fail(errors, 'cwd mismatch');
  if (ledger.caseCount !== EXPECTED_IDS.length || !Array.isArray(ledger.cases)) fail(errors, 'caseCount/cases mismatch');
  if (ledger.verdict !== 'PASS' || ledger.failureCount !== 0) fail(errors, 'ledger verdict not PASS');
  const seen = new Set();
  for (const item of (Array.isArray(ledger.cases) ? ledger.cases : [])) {
    keysExactly(item, EXPECTED_CASE, 'case', errors);
    if (seen.has(item.caseId)) fail(errors, 'duplicate caseId ' + item.caseId);
    seen.add(item.caseId);
    if (!EXPECTED_IDS.includes(item.caseId)) fail(errors, 'unexpected caseId ' + item.caseId);
    if (item.kind !== 'source-mutation') fail(errors, item.caseId + ': kind mismatch');
    const sourcePath = String(item.sourcePath || '').replace(/\\/g, '/');
    if (!path.isAbsolute(sourcePath) || !realContained(sourcePath, ROOT)) fail(errors, item.caseId + ': source path outside project');
    if (!fs.existsSync(sourcePath)) fail(errors, item.caseId + ': source missing');
    if (!/\/app\/js\/(billing-calendar|supervision)\.js$/.test(sourcePath)) fail(errors, item.caseId + ': source not allowlisted');
    if (fs.existsSync(sourcePath) && sha256(fs.readFileSync(sourcePath)) !== item.productionSha256) fail(errors, item.caseId + ': production SHA mismatch');
    const stages = Array.isArray(item.stages) ? item.stages : [];
    if (stages.length !== 3) fail(errors, item.caseId + ': stage count');
    const stageNames = stages.map((s) => s.stage).sort();
    if (JSON.stringify(stageNames) !== JSON.stringify(['baseline', 'mutated', 'restored'])) fail(errors, item.caseId + ': stage set');
    for (const stage of stages) {
      const label = item.caseId + '.' + stage.stage;
      keysExactly(stage, EXPECTED_STAGE, label, errors);
      if (stage.caseId !== item.caseId) fail(errors, label + ': caseId mismatch');
      if (stage.expectedExit !== 0 || stage.exitCode !== 0 || stage.verdict !== 'PASS') fail(errors, label + ': execution verdict');
      if (!stage.invariants || !Array.isArray(stage.invariants.failed) || !Array.isArray(stage.invariants.passed)) fail(errors, label + ': invariants shape');
      keysExactly(stage.meta, EXPECTED_META, label + '.meta', errors);
      const meta = stage.meta || {};
      if (meta.taskId !== TASK || meta.caseId !== item.caseId || meta.stage !== stage.stage) fail(errors, label + ': meta identity');
      if (!Array.isArray(meta.argv) || meta.argv.length < 3 || meta.argv[1] !== '--check') fail(errors, label + ': argv mismatch');
      if (!isUtc(meta.startedAt) || !isUtc(meta.endedAt) || Date.parse(meta.startedAt) >= Date.parse(meta.endedAt)) fail(errors, label + ': UTC order');
      if (meta.cwd !== ROOT.replace(/\\/g, '/')) fail(errors, label + ': meta cwd mismatch');
      if (meta.exitCode !== 0) fail(errors, label + ': meta exit mismatch');
      if (typeof meta.command !== 'string' || !meta.command.includes('--check')) fail(errors, label + ': command mismatch');
      const caseScratch = path.join(SCRATCH, 'expected-red', item.caseId);
      if (!path.isAbsolute(String(meta.sourcePath || '')) || !contained(meta.sourcePath, caseScratch) || !realContained(meta.sourcePath, caseScratch)) fail(errors, label + ': source raw path outside case');
      if (!fs.existsSync(meta.sourcePath)) fail(errors, label + ': source raw missing');
      if (fs.existsSync(meta.sourcePath)) {
        const source = fs.readFileSync(meta.sourcePath);
        if (sha256(source) !== meta.sourceSha256) fail(errors, label + ': source SHA mismatch');
        if (source.length !== meta.sourceBytes) fail(errors, label + ': source bytes mismatch');
        if (stage.stage !== 'mutated' && meta.sourceSha256 !== item.productionSha256) fail(errors, label + ': baseline/restored source drift');
        if (stage.stage === 'mutated' && meta.sourceSha256 === item.productionSha256) fail(errors, label + ': mutated source unchanged');
      }
      keysExactly(meta.invariants, EXPECTED_INVARIANTS, label + '.meta.invariants', errors);
      rawCheck(meta, errors, label);
      if (stage.stage === 'mutated' && (!meta.invariants || meta.invariants.failed.length === 0)) fail(errors, label + ': mutation survived');
      if (stage.stage !== 'mutated' && meta.invariants && meta.invariants.failed.length !== 0) fail(errors, label + ': baseline/restore invariant failure');
    }
  }
  if (seen.size !== EXPECTED_IDS.length) fail(errors, 'case closure mismatch');
  verifyRuntimeEvidence(errors);
  return errors;
}

const errors = verify();
const result = { ok: errors.length === 0, verdict: errors.length === 0 ? 'PASS' : 'FAIL', taskId: TASK, caseCount: EXPECTED_IDS.length, errorCount: errors.length, errors };
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = errors.length ? 1 : 0;
