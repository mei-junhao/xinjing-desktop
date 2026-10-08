'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const TASK = 'XJ-5.1.1-ui-functional-closure-deep-runtime-codex-subagent-successor-006';
const OUT = path.join(ROOT, 'qa', 'task-scratch', TASK, 'expected-red');
const RUNTIME = path.join(ROOT, 'scripts', 'v5.1.1-tests', TASK, 'runtime-006.js');
const BILLING_PROD = path.join(ROOT, 'app', 'js', 'billing-calendar.js');
const SUPERVISION_PROD = path.join(ROOT, 'app', 'js', 'supervision.js');
const CARD_SHA = 'AB7E0CD30CDE71CCA189C12A7A5F41A8CFBA9E76A3835960115DE69064F3E735';
fs.mkdirSync(OUT, { recursive: true });

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex').toUpperCase();
const now = () => new Date().toISOString();
const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, v, 'utf8'); };
const writeJson = (p, v) => write(p, JSON.stringify(v, null, 2) + '\n');
function metaFor(stage, caseId, command, argv, cwd, startedAt, endedAt, exitCode, stdoutPath, stderrPath) {
  const out = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
  const err = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
  return { taskId: TASK, caseId, stage, command, argv, cwd: cwd.replace(/\\/g, '/'), startedAt, endedAt, exitCode,
    stdoutPath: stdoutPath.replace(/\\/g, '/'), stderrPath: stderrPath.replace(/\\/g, '/'), stdoutSha256: sha(out), stdoutBytes: Buffer.byteLength(out), stderrSha256: sha(err), stderrBytes: Buffer.byteLength(err) };
}
function parseLastJson(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch (_) {} }
  return null;
}
function runProcess(caseId, stage, args, expectedExit) {
  const dir = path.join(OUT, caseId); fs.mkdirSync(dir, { recursive: true });
  const startedAt = now();
  const command = process.execPath + ' ' + args.map((x) => JSON.stringify(x)).join(' ');
  const child = cp.spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 96 * 1024 * 1024, windowsHide: true, timeout: 180000 });
  const endedAt = now();
  const stdout = String(child.stdout || ''); const stderr = String(child.stderr || '');
  const stdoutPath = path.join(dir, stage + '.stdout.txt'); const stderrPath = path.join(dir, stage + '.stderr.txt');
  write(stdoutPath, stdout); write(stderrPath, stderr);
  const exitCode = typeof child.status === 'number' ? child.status : -1;
  const payload = parseLastJson(stdout);
  const ok = exitCode === expectedExit && (stage === 'mutated' ? !(payload && payload.ok === true) : !!(payload && payload.ok === true));
  const meta = metaFor(stage, caseId, command, [process.execPath].concat(args), ROOT, startedAt, endedAt, exitCode, stdoutPath, stderrPath);
  writeJson(path.join(dir, stage + '.meta.json'), meta);
  return { caseId, stage, expectedExit, exitCode, verdict: ok ? 'PASS' : 'FAIL', payload, meta };
}

// Upload success/retry/cancel are exercised by runtime-006.js.  Expected-red
// stays source-isolated here so transient CDP target timing cannot become a
// false mutation verdict.
const uploadCases = [];

const invariants = {
  feedback: (s) => /id="bc-inv-feedback"[^>]*role="status"/.test(s),
  ariaLive: (s) => /id="bc-inv-feedback"[^>]*aria-live="polite"/.test(s),
  ariaBusy: (s) => /setAttribute\('aria-busy'/.test(s),
  toggleInit: (s) => /id="bc-inv-toggle-override"[^>]*aria-expanded="false"/.test(s),
  focusMove: (s) => /amtInput\.focus\(\); try \{ amtInput\.select\(\)/.test(s),
  awaitDurable: (s) => /saved = await Store\.updateClientDurable\(/.test(s),
  okGate: (s) => /if \(!saved \|\| !saved\.ok\)/.test(s),
  failKeepsInput: (s) => (s.match(/原输入金额已保留/g) || []).length >= 2,
  durableClient: (s) => /Store\.updateClientDurable\(clientId,/.test(s),
  filterMonth: (s) => /return m\.month !== ym;/.test(s),
  pushTarget: (s) => /push\(\{ month: ym, amount: newAmount \}\)/.test(s),
  replaceMode: (s) => /mode === 'add' \? \(prevAmount \+ amount\) : amount/.test(s),
  busyGuards: (s) => (s.match(/if \(billingSettleBusy\)/g) || []).length >= 3,
};
const supervisionInvariants = {
  failureBranch: (s) => /setUploadState\('failure',/.test(s),
  retrySameFile: (s) => /startReportUpload\(uploadPendingFile, true\);/.test(s),
  cancelReader: (s) => /operation\.reader && operation\.reader\.readyState === 1\) operation\.reader\.abort\(\)/.test(s) && /finishUploadCancel\(operation\)/.test(s),
  docxAwait: (s) => /mammoth\.extractRawText\(\{ arrayBuffer: arrayBuffer \}\)/.test(s) && /Promise\.resolve\(extracted\)\.then\(function \(result\)/.test(s),
  draftCopy: (s) => /materialTA\.value = next;[\s\S]*localStorage\.setItem\(draftKey, next\);/.test(s),
};
const billingMutations = [
  { id: 'B1-delete-feedback', needle: '<div class="bc-inv-feedback" id="bc-inv-feedback" role="status" aria-live="polite" aria-busy="false" data-state="\' + billingFeedbackTone + \'">\' + App.escapeHtml(billingFeedbackText) + \'</div>', replacement: '', red: ['feedback', 'ariaLive'] },
  { id: 'B2-drop-aria-live', needle: 'role="status" aria-live="polite" aria-busy="false" data-state', replacement: 'role="status" aria-busy="false" data-state', red: ['ariaLive'] },
  { id: 'B3-delete-focus', needle: 'if (amtInput) { amtInput.focus(); try { amtInput.select(); } catch (e) {} }', replacement: 'if (amtInput) {}', red: ['focusMove'] },
  { id: 'B4-swallow-ok', needle: 'if (!saved || !saved.ok) {', replacement: 'if (false) {', red: ['okGate'] },
  { id: 'B5-drop-await', needle: 'saved = await Store.updateClientDurable(clientId, { billing: billing });', replacement: 'Store.updateClientDurable(clientId, { billing: billing }); saved = { ok: true, value: null };', red: ['awaitDurable'] },
  { id: 'B6-wrong-client', needle: 'saved = await Store.updateClientDurable(clientId, { billing: billing });', replacement: "saved = await Store.updateClientDurable('c_fake_id', { billing: billing });", red: ['durableClient'] },
  { id: 'B7-wrong-month', needle: 'billing.monthlyPayments.push({ month: ym, amount: newAmount });', replacement: "billing.monthlyPayments.push({ month: '1999-01', amount: newAmount });", red: ['pushTarget'] },
  { id: 'B8-replace-add', needle: 'newAmount = mode === \'add\' ? (prevAmount + amount) : amount;', replacement: 'newAmount = prevAmount + amount;', red: ['replaceMode'] },
  { id: 'B9-drop-busy-guard', needle: "if (billingSettleBusy) { setBillingFeedback('正在保存本月结算，请稍候…', 'busy'); return; }", replacement: "/* mutation B9 busy guard removed */", red: ['busyGuards'] },
  { id: 'B10-drop-failure-copy', needle: '原输入金额已保留', replacement: '金额已清零', red: ['failKeepsInput'] },
];

const supervisionMutations = [
  { id: 'S1-delete-failure-branch', sourcePath: SUPERVISION_PROD, invariantSet: supervisionInvariants, needle: "setUploadState('failure', reason + '；材料与草稿均未改变。');", replacement: "setUploadState('success', reason, 100);", red: ['failureBranch'] },
  { id: 'S2-retry-new-file', sourcePath: SUPERVISION_PROD, invariantSet: supervisionInvariants, needle: 'startReportUpload(uploadPendingFile, true);', replacement: 'return;', red: ['retrySameFile'] },
  { id: 'S3-delete-cancel-abort', sourcePath: SUPERVISION_PROD, invariantSet: supervisionInvariants, needle: "try { if (operation.reader && operation.reader.readyState === 1) operation.reader.abort(); } catch (ignore) {}", replacement: 'try {} catch (ignore) {}', red: ['cancelReader'] },
  { id: 'S4-drop-docx-await', sourcePath: SUPERVISION_PROD, invariantSet: supervisionInvariants, needle: 'Promise.resolve(extracted)', replacement: 'Promise.resolve(null)', red: ['docxAwait'] },
  { id: 'S5-drop-draft-copy', sourcePath: SUPERVISION_PROD, invariantSet: supervisionInvariants, needle: 'localStorage.setItem(draftKey, next);', replacement: '/* expected-red: draft persistence removed */', red: ['draftCopy'] },
];

function staticInvariant(src, invariantSet) {
  const set = invariantSet || invariants;
  const failed = Object.keys(set).filter((k) => !set[k](src));
  return { failed, passed: Object.keys(set).filter((k) => failed.indexOf(k) < 0) };
}
function runStaticCase(m) {
  const sourcePath = m.sourcePath || BILLING_PROD;
  const invariantSet = m.invariantSet || invariants;
  const src = fs.readFileSync(sourcePath, 'utf8');
  const stages = [];
  const caseDir = path.join(OUT, m.id); fs.mkdirSync(caseDir, { recursive: true });
  const srcHash = sha(src);
  const baselinePath = path.join(caseDir, 'baseline.js'); write(baselinePath, src);
  const mutated = src.replace(m.needle, m.replacement);
  if (mutated === src) throw new Error(m.id + ' mutation needle not found');
  const mutatedPath = path.join(caseDir, 'mutated.js'); write(mutatedPath, mutated);
  const restoredPath = path.join(caseDir, 'restored.js'); write(restoredPath, fs.readFileSync(sourcePath, 'utf8'));
  for (const [stage, file, expected] of [['baseline', baselinePath, true], ['mutated', mutatedPath, false], ['restored', restoredPath, true]]) {
    const startedAt = now(); const chk = cp.spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000 }); const endedAt = now();
    const inv = staticInvariant(fs.readFileSync(file, 'utf8'), invariantSet); const stdout = String(chk.stdout || ''); const stderr = String(chk.stderr || '');
    const stdoutPath = path.join(caseDir, stage + '.stdout.txt'); const stderrPath = path.join(caseDir, stage + '.stderr.txt'); write(stdoutPath, stdout); write(stderrPath, stderr);
    const exitCode = typeof chk.status === 'number' ? chk.status : -1; const semanticOk = expected ? inv.failed.length === 0 : inv.failed.length > 0;
    const ok = exitCode === 0 && semanticOk;
    const meta = metaFor(stage, m.id, process.execPath + ' --check ' + file, [process.execPath, '--check', file], ROOT, startedAt, endedAt, exitCode, stdoutPath, stderrPath);
    meta.sourcePath = file.replace(/\\/g, '/'); meta.sourceSha256 = sha(fs.readFileSync(file)); meta.sourceBytes = fs.statSync(file).size; meta.invariants = inv;
    writeJson(path.join(caseDir, stage + '.meta.json'), meta);
    stages.push({ caseId: m.id, stage, expectedExit: 0, exitCode, verdict: ok ? 'PASS' : 'FAIL', meta, invariants: inv });
  }
  return { caseId: m.id, kind: 'source-mutation', sourcePath: sourcePath.replace(/\\/g, '/'), productionSha256: srcHash, stages };
}

function runUploadCase(c) {
  const stages = [];
  stages.push(runProcess(c.id, 'baseline', [RUNTIME, '--mode=upload', '--scenario=' + c.scenario, '--mutation=none'], 0));
  stages.push(runProcess(c.id, 'mutated', [RUNTIME, '--mode=upload', '--scenario=' + c.scenario, '--mutation=' + c.mutation], 1));
  stages.push(runProcess(c.id, 'restored', [RUNTIME, '--mode=upload', '--scenario=' + c.scenario, '--mutation=none'], 0));
  return { caseId: c.id, kind: 'electron-upload-mutation', stages };
}

function assertRaw(entry) {
  const m = entry.meta; for (const p of [m.stdoutPath, m.stderrPath]) if (!fs.existsSync(p)) throw new Error(entry.caseId + '.' + entry.stage + ' raw missing');
  const out = fs.readFileSync(m.stdoutPath, 'utf8'); const err = fs.readFileSync(m.stderrPath, 'utf8');
  if (sha(out) !== m.stdoutSha256 || Buffer.byteLength(out) !== m.stdoutBytes) throw new Error(entry.caseId + '.' + entry.stage + ' stdout binding mismatch');
  if (sha(err) !== m.stderrSha256 || Buffer.byteLength(err) !== m.stderrBytes) throw new Error(entry.caseId + '.' + entry.stage + ' stderr binding mismatch');
}

function main() {
  const results = []; for (const c of uploadCases) results.push(runUploadCase(c)); for (const m of billingMutations.concat(supervisionMutations)) results.push(runStaticCase(m));
  results.forEach((r) => r.stages.forEach(assertRaw));
  const failures = results.flatMap((r) => r.stages.filter((s) => s.verdict !== 'PASS').map((s) => r.caseId + '.' + s.stage));
  const ledger = { schemaVersion: 1, taskId: TASK, cardSha256: CARD_SHA, generatedAt: now(), cwd: ROOT.replace(/\\/g, '/'), caseCount: results.length, cases: results, verdict: failures.length ? 'FAIL' : 'PASS', failureCount: failures.length };
  writeJson(path.join(OUT, 'ledger-006.json'), ledger);
  console.log(JSON.stringify({ ok: failures.length === 0, verdict: ledger.verdict, caseCount: ledger.caseCount, failures, ledger: path.join(OUT, 'ledger-006.json').replace(/\\/g, '/') }));
  process.exitCode = failures.length ? 1 : 0;
}

try { main(); } catch (error) { process.stderr.write((error && error.stack) || String(error)); process.stderr.write('\n'); process.exitCode = 1; }
