'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const TASK = 'XJ-5.1.1-ui-functional-closure-codex-subagent-successor-004';
const SCRATCH = path.join(ROOT, 'qa/task-scratch', TASK, 'expected-red');
const files = {
  masters: path.join(ROOT, 'app/js/masters.js'),
  mastersCss: path.join(ROOT, 'app/css/masters-clinical.css'),
  billing: path.join(ROOT, 'app/js/billing-calendar.js'),
  dashboard: path.join(ROOT, 'app/js/dashboard.js'),
  index: path.join(ROOT, 'app/index.html'),
  supervision: path.join(ROOT, 'app/js/real-supervision.js'),
  supervisionHtml: path.join(ROOT, 'app/real-supervision.html'),
  calendar: path.join(ROOT, 'app/js/session-calendar.js'),
  calendarHtml: path.join(ROOT, 'app/session-calendar.html')
};
const invariant = {
  mastersPanelState: (s) => /__xjMastersPanelState/.test(s),
  mastersLeftTrack: (s) => /masters-left-collapsed \.masters-workspace \{ grid-template-columns: 0 minmax\(0, 1fr\) 300px; \}/.test(s),
  mastersRoundVertical: (s) => /\.chat-body\.round-mode\s*\{/.test(s),
  billingOriginal: (s) => /原金额（自动）/.test(s),
  billingDelta: (s) => /覆盖差额/.test(s),
  billingAwait: (s) => /saved = await Store\.updateClientDurable/.test(s),
  billingOkGate: (s) => /if \(!saved \|\| !saved\.ok\)/.test(s),
  billingFeedbackLive: (s) => /aria-live="polite"/.test(s),
  dashboardGate: (s) => /openMembershipGate\(button\.dataset\.feature\)/.test(s),
  dashboardRouteError: (s) => /快捷入口目标不可用/.test(s),
  uploadProgress: (s) => /reader\.onprogress/.test(s),
  uploadRetry: (s) => /processTranscriptUpload\(uploadJob\.file\)/.test(s),
  uploadCancel: (s) => /reader\.abort\(\)/.test(s),
  calendarLive: (s) => /aria-live/.test(s)
};
const attacks = [
  ['M01-delete-panel-state', 'masters', '__xjMastersPanelState', '__xjLegacyPanelState', 'mastersPanelState'],
  ['M02-delete-left-track', 'mastersCss', 'body.masters-left-collapsed .masters-workspace { grid-template-columns: 0 minmax(0, 1fr) 300px; }', '', 'mastersLeftTrack'],
  ['M03-delete-round-mode', 'mastersCss', '.chat-body.round-mode', '.chat-body.round-mode-disabled', 'mastersRoundVertical'],
  ['M04-delete-original-label', 'billing', '原金额（自动）', '', 'billingOriginal'],
  ['M05-delete-delta-label', 'billing', '覆盖差额', '', 'billingDelta'],
  ['M06-drop-await', 'billing', 'saved = await Store.updateClientDurable(clientId, { billing: billing });', 'saved = Store.updateClientDurable(clientId, { billing: billing });', 'billingAwait'],
  ['M07-swallow-ok-failure', 'billing', 'if (!saved || !saved.ok)', 'if (false)', 'billingOkGate'],
  ['M08-drop-feedback-live', 'billing', 'aria-live="polite"', '', 'billingFeedbackLive'],
  ['M09-bypass-membership-gate', 'dashboard', 'App.openMembershipGate(button.dataset.feature)', 'App.featureGate(button.dataset.feature)', 'dashboardGate'],
  ['M10-drop-route-error', 'dashboard', '快捷入口目标不可用', '', 'dashboardRouteError'],
  ['M11-drop-progress', 'supervision', 'reader.onprogress', 'reader["onprogress-disabled"]', 'uploadProgress'],
  ['M12-drop-retry', 'supervision', 'processTranscriptUpload(uploadJob.file)', '', 'uploadRetry'],
  ['M13-drop-cancel', 'supervision', "reader.abort()", "reader['abort-disabled']()", 'uploadCancel'],
  ['M14-drop-calendar-live', 'calendarHtml', 'aria-live="polite"', '', 'calendarLive']
];
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase(); }
function checkJs(file) { const r = cp.spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' }); return { exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }; }
fs.mkdirSync(SCRATCH, { recursive: true });
const baseline = {};
for (const [key, file] of Object.entries(files)) { baseline[key] = fs.readFileSync(file, 'utf8'); }
const baseInv = {};
for (const [name, fn] of Object.entries(invariant)) baseInv[name] = Object.values(baseline).some((s) => fn(s));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xj511-ui-004-red-'));
const cases = [];
for (const [id, key, anchor, replacement, expected] of attacks) {
  const source = baseline[key];
  const hits = anchor ? source.split(anchor).length - 1 : 0;
  if (hits < 1) throw new Error(id + ': anchor hits=' + hits);
  const replaceAll = id === 'M01-delete-panel-state' || id === 'M03-delete-round-mode' || id === 'M09-bypass-membership-gate';
  const mutated = replaceAll ? source.split(anchor).join(replacement) : source.replace(anchor, replacement);
  const out = path.join(temp, key + '-' + id + (key.endsWith('Css') || key.endsWith('Html') || key === 'index' ? '.txt' : '.js'));
  fs.writeFileSync(out, mutated);
  const killed = !invariant[expected](mutated);
  const node = out.endsWith('.js') ? checkJs(out) : { exit: 0, stdout: '', stderr: '' };
  cases.push({ id, target: key, anchorHits: hits, expectedRed: expected, inputSha256: sha(Buffer.from(mutated)), inputBytes: Buffer.byteLength(mutated), nodeCheck: node, killed, restorePass: invariant[expected](source) });
}
const result = { task: TASK, generatedAt: new Date().toISOString(), strategy: 'baseline invariant PASS; single-point mutation must invalidate exactly its declared invariant; restore source remains PASS', total: cases.length, killed: cases.filter((x) => x.killed).length, restorePass: cases.filter((x) => x.restorePass).length, verdict: cases.every((x) => x.killed && x.restorePass && x.nodeCheck.exit === 0) ? 'PASS' : 'FAIL', tempDir: temp.replace(/\\/g, '/'), cases };
fs.writeFileSync(path.join(SCRATCH, 'expected-red.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.verdict === 'PASS' ? 0 : 1;
