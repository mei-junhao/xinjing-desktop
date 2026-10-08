'use strict';
// expected-red.js — 018 静态源码变异负向测试（对 billing-calendar.js 副本做单点变异，断言契约不变式被击穿）
// 策略：baseline（原文件）必须全绿；每个变异只破坏一个契约不变式且 node --check 保持通过。
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '../../..');
var TASK = 'XJ-5.1.1-billing-monthly-override-feedback-runtime-closure-018';
var EVIDENCE = path.join(ROOT, 'qa/task-scratch', TASK, 'evidence');
var PROD = path.join(ROOT, 'app/js/billing-calendar.js');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase(); }
function readUtf8(p) { return fs.readFileSync(p, 'utf8'); }

// ---- 契约不变式（对源码做静态断言；运行时行为已由 runtime-electron-cdp.js 实测） ----
var INVARIANTS = {
  'feedback-status-role':        function (s) { return /id="bc-inv-feedback"[^>]*role="status"/.test(s); },
  'feedback-aria-live':          function (s) { return /id="bc-inv-feedback"[^>]*aria-live="polite"/.test(s); },
  'feedback-aria-busy-sync':     function (s) { return /setAttribute\('aria-busy'/.test(s); },
  'toggle-aria-expanded-init':   function (s) { return /id="bc-inv-toggle-override"[^>]*aria-expanded="false"/.test(s); },
  'toggle-aria-expanded-sync':   function (s) { return /setAttribute\('aria-expanded', nowExpanded \? 'true' : 'false'\)/.test(s); },
  'focus-to-amount':             function (s) { return /if \(amtInput\) \{ amtInput\.focus\(\); try \{ amtInput\.select\(\)/.test(s); },
  'await-durable':               function (s) { return /saved = await Store\.updateClientDurable\(/.test(s); },
  'ok-gate':                     function (s) { return /if \(!saved \|\| !saved\.ok\)/.test(s); },
  'fail-keeps-input':            function (s) { return /月结保存失败：本地账务数据未改变，原输入金额已保留；请恢复存储后重试/.test(s); },
  'fail-closed-catch':           function (s) { return /月结保存失败：发生异常，本地账务数据未改变，原输入金额已保留；请重试/.test(s); },
  'replace-filters-month':       function (s) { return /return m\.month !== ym;/.test(s); },
  'push-target-month':           function (s) { return /push\(\{ month: ym, amount: newAmount \}\);/.test(s); },
  'replace-not-add':             function (s) { return /mode === 'add' \? \(prevAmount \+ amount\) : amount/.test(s); },
  'busy-guard-x3':               function (s) { return (s.match(/if \(billingSettleBusy\)/g) || []).length === 3; },
  'busy-feedback-save':          function (s) { return /setBillingFeedback\('正在保存：'/.test(s); },
  'escape-cancel':               function (s) { return /已取消手动覆盖/.test(s); },
  'success-month-amount':        function (s) { return /月结已保存：/.test(s) && /手动覆盖金额已设为/.test(s); },
  'durable-uses-clientId':       function (s) { return /Store\.updateClientDurable\(clientId,/.test(s); }
};

function invariantReport(src) {
  var passed = [], failed = [];
  Object.keys(INVARIANTS).forEach(function (name) {
    if (INVARIANTS[name](src)) passed.push(name); else failed.push(name);
  });
  return { passed: passed, failed: failed };
}

// ---- 变异清单：anchor 必须唯一命中；每例声明期望被击穿的不变式 ----
var MUTATIONS = [
  { id: 'R01', desc: 'delete-feedback-area', anchor: "'<div class=\"bc-inv-feedback\" id=\"bc-inv-feedback\" role=\"status\" aria-live=\"polite\" aria-busy=\"false\" data-state=\"' + billingFeedbackTone + '\">' + App.escapeHtml(billingFeedbackText) + '</div>';", replacement: "'';", expectRed: ['feedback-status-role', 'feedback-aria-live'] },
  { id: 'R02', desc: 'drop-aria-live', anchor: 'role="status" aria-live="polite" aria-busy="false" data-state', replacement: 'role="status" aria-busy="false" data-state', expectRed: ['feedback-aria-live'] },
  { id: 'R03', desc: 'delete-focus-move', anchor: 'if (amtInput) { amtInput.focus(); try { amtInput.select(); } catch (e) {} }', replacement: 'if (amtInput) {}', expectRed: ['focus-to-amount'] },
  { id: 'R04', desc: 'fake-ok-swallow-failure', anchor: 'if (!saved || !saved.ok) {', replacement: 'if (false) {', expectRed: ['ok-gate'] },
  { id: 'R05', desc: 'failure-loses-input', anchor: '月结保存失败：本地账务数据未改变，原输入金额已保留；请恢复存储后重试', replacement: '月结保存失败：本地账务数据未改变，金额已清零；请恢复存储后重试', expectRed: ['fail-keeps-input'] },
  { id: 'R06', desc: 'delete-await', anchor: 'saved = await Store.updateClientDurable(clientId, { billing: billing });', replacement: 'Store.updateClientDurable(clientId, { billing: billing }); saved = { ok: true, value: null };', expectRed: ['await-durable'] },
  { id: 'R07', desc: 'wrong-client-wrapper', anchor: 'saved = await Store.updateClientDurable(clientId, { billing: billing });', replacement: "saved = await Store.updateClientDurable('c_fake_id', { billing: billing });", expectRed: ['durable-uses-clientId'] },
  { id: 'R08', desc: 'wrong-month-push', anchor: 'billing.monthlyPayments.push({ month: ym, amount: newAmount });', replacement: "billing.monthlyPayments.push({ month: '1999-01', amount: newAmount });", expectRed: ['push-target-month'] },
  { id: 'R09', desc: 'replace-becomes-add', anchor: "newAmount = mode === 'add' ? (prevAmount + amount) : amount;", replacement: 'newAmount = prevAmount + amount;', expectRed: ['replace-not-add'] },
  { id: 'R10', desc: 'no-busy-guard-settle-override', anchor: "settleOverrideBtn.addEventListener('click', function () {\n      if (billingSettleBusy) { setBillingFeedback('正在保存本月结算，请稍候…', 'busy'); return; }", replacement: "settleOverrideBtn.addEventListener('click', function () {\n      // mutation R10: busy guard removed", expectRed: ['busy-guard-x3'] },
  { id: 'R11', desc: 'role-status-downgraded', anchor: '<div class="bc-inv-feedback" id="bc-inv-feedback" role="status"', replacement: '<div class="bc-inv-feedback" id="bc-inv-feedback" role="log"', expectRed: ['feedback-status-role'] },
  { id: 'R12', desc: 'no-aria-expanded-init', anchor: 'id="bc-inv-toggle-override" aria-expanded="false"', replacement: 'id="bc-inv-toggle-override" aria-expanded="true"', expectRed: ['toggle-aria-expanded-init'] },
  { id: 'R13', desc: 'no-busy-feedback', anchor: "setBillingFeedback('正在保存：' + (mode === 'add' ? '确认结算' : '手动覆盖')", replacement: "setBillingFeedback('处理中：' + (mode === 'add' ? '确认结算' : '手动覆盖')", expectRed: ['busy-feedback-save'] }
].map(function (m) { return m; });

function checkOnlyOne(src, anchor, id) {
  var idx = src.indexOf(anchor);
  if (idx === -1) throw new Error('[' + id + '] anchor not found: ' + anchor);
  if (src.indexOf(anchor, idx + anchor.length) !== -1) throw new Error('[' + id + '] anchor not unique: ' + anchor);
  return src.slice(0, idx) + '{REPLACED' + id + '}' + src.slice(idx + anchor.length);
}

function nodeCheck(file) {
  var r = cp.spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  return { ok: r.status === 0, exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

try { fs.mkdirSync(EVIDENCE, { recursive: true }); } catch (e) {}
var prodSrc = readUtf8(PROD);
var prodHash = sha256(fs.readFileSync(PROD));
var cases = [];
var allPass = true;

// baseline
var bInv = invariantReport(prodSrc);
var bCheck = nodeCheck(PROD);
var baselineOk = bCheck.ok && bInv.failed.length === 0;
allPass = allPass && baselineOk;
cases.push({
  id: 'BASELINE', desc: 'production billing-calendar.js untouched',
  inputSha256: prodHash, inputBytes: fs.statSync(PROD).size,
  nodeCheck: { command: process.execPath + ' --check ' + PROD, cwd: ROOT.replace(/\\/g, '/'), exit: bCheck.exit, stdout: bCheck.stdout, stderr: bCheck.stderr },
  invariants: bInv, red: !baselineOk, note: baselineOk ? 'PASS' : 'FAIL'
});

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xj018-expected-red-'));
MUTATIONS.forEach(function (m) {
  var src = prodSrc;
  src = checkOnlyOne(src, m.anchor, m.id);
  src = src.replace('{REPLACED' + m.id + '}', m.replacement);
  var tmp = path.join(tmpDir, m.id + '.js');
  fs.writeFileSync(tmp, src);
  var inv = invariantReport(src);
  var chk = nodeCheck(tmp);
  var redOk = inv.failed.length > 0;
  var unexpected = inv.failed.filter(function (n) { return m.expectRed.indexOf(n) === -1; });
  var missed = m.expectRed.filter(function (n) { return inv.failed.indexOf(n) === -1; });
  var ok = redOk && unexpected.length === 0 && missed.length === 0 && chk.ok;
  allPass = allPass && ok;
  cases.push({
    id: m.id, desc: m.desc,
    mutation: { anchor: m.anchor, replacement: m.replacement, expectRed: m.expectRed },
    inputSha256: sha256(fs.readFileSync(tmp)), inputBytes: fs.statSync(tmp).size,
    tmpPath: tmp.replace(/\\/g, '/'),
    nodeCheck: { command: process.execPath + ' --check ' + tmp, cwd: ROOT.replace(/\\/g, '/'), exit: chk.exit, stdout: chk.stdout, stderr: chk.stderr },
    invariants: inv, red: redOk, unexpectedFailed: unexpected, missedExpected: missed,
    note: ok ? 'RED (expected)' : 'NOT-RED (unexpected) ' + JSON.stringify({ unexpected: unexpected, missed: missed })
  });
});

var out = {
  task: TASK,
  production_file: 'app/js/billing-calendar.js',
  production_sha256: prodHash,
  strategy: 'baseline-must-pass + single-point-source-mutation-must-go-RED; node --check per case; raw stdout/stderr/command/cwd/exit/SHA/bytes recorded per case',
  invariantCount: Object.keys(INVARIANTS).length,
  baselineOk: baselineOk,
  mutationCases: MUTATIONS.length,
  cases: cases,
  allExpectedRedConfirmed: allPass
};
fs.writeFileSync(path.join(EVIDENCE, 'expected-red.json'), JSON.stringify(out, null, 2));
console.log('SUMMARY');
console.log(' production sha256:', prodHash, '(' + fs.statSync(PROD).size + ' B)');
console.log(' invariants:', Object.keys(INVARIANTS).length, '| baseline:', baselineOk ? 'PASS' : 'FAIL');
console.log(' cases:', MUTATIONS.length + 1);
cases.forEach(function (c) {
  var failedList = c.invariants.failed.length ? ' [' + c.invariants.failed.join(',') + ']' : '';
  console.log('  ' + c.id.padEnd(9), c.desc.padEnd(36), c.red ? 'RED' : 'GREEN', String(c.nodeCheck.exit).padStart(3), c.inputBytes + 'B', c.inputSha256.slice(0, 12) + failedList);
});
console.log('ALL_EXPECTED_RED:', allPass);
process.exitCode = allPass ? 0 : 1;