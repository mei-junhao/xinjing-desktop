#!/usr/bin/env node
'use strict';
/* ============================================================
   XJ-4.2.2-codebuddy-quick-record — 快速记录契约（真实生产模块执行）
   通过 Node vm 执行真实 app/js/quick-record.js，配合可故障注入的合成
   Store fixture 与 App.showToast 间谍，行为级验证：
     - 重复点击幂等、持久化失败保留草稿/旧权威/原上下文并阻断切换、
       延迟落盘、上下文切换、断电/中断、重复预约批量创建停止后续写入、
       四个派生后续动作（账务/下次安排/督导/完整记录）；
     - v4.3 已验收的 durable 完成分支：会谈成功后以真实可故障注入的
       Store 真实 await 并持久化 Free 手动模板与临床任务
       （saveSessionTemplateSelectionDurable / saveClinicalTasksDurable），
       非空任务列表必须真实写入、零任务不得伪造写入、任务失败返回
       ok:false 且保留可恢复完成包、重试不重复已 durable 的 ID。
   所有断言均为行为级（真实执行 + 真实 Store 缓存/写日志校验），
   包含 expected-red（证明朴素/过时边界检查会假绿）与 mutation-sensitive 门。
   ============================================================ */
var fs = require('fs'), path = require('path'), vm = require('vm');

var ROOT = path.join(__dirname, '..', '..');
var QR_PATH = path.join(ROOT, 'app', 'js', 'quick-record.js');
var QR_SRC = fs.readFileSync(QR_PATH, 'utf8');

var passed = 0, failed = 0;
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function expectThrow(fn, label) {
  var err = null;
  try { fn(); } catch (e) { err = e; }
  if (!err) throw new Error(label + ' — expected throw but none occurred');
  return err;
}

// ---- synthetic Store fixture (fault-injectable, writes tracked) ----
function makeStore(opts) {
  opts = opts || {};
  var cfg = { failMode: opts.failMode || 'none', delayMs: (typeof opts.delayMs === 'number' ? opts.delayMs : 0), failNext: false, failFromIndex: (typeof opts.failFromIndex === 'number' ? opts.failFromIndex : null) };
  var sessions = new Map();
  var clients = new Map();
  var supervisions = new Map();
  var writeLog = [];
  function delay() { if (cfg.delayMs > 0) return new Promise(function (r) { setTimeout(r, cfg.delayMs); }); return Promise.resolve(); }
  var api = {
    _sessions: sessions, writeLog: writeLog, cfg: cfg,
    configure: function (o) { if (o.failMode) cfg.failMode = o.failMode; if (typeof o.delayMs === 'number') cfg.delayMs = o.delayMs; if (o.failNext) cfg.failNext = true; },
    getSession: function (id) { return sessions.get(id) || null; },
    getClient: function (id) { return clients.get(id) || null; },
    createSessionDurable: function (payload) {
      var myIdx = writeLog.filter(function (w) { return w.op === 'createSessionDurable'; }).length;
      writeLog.push({ op: 'createSessionDurable', payload: payload });
      if (cfg.failNext) { cfg.failNext = false; return Promise.resolve({ ok: false, error: { code: 'XJ_QR_SIM_FAIL', message: 'simulated failure' } }); }
      if (typeof cfg.failFromIndex === 'number' && myIdx >= cfg.failFromIndex) return Promise.resolve({ ok: false, error: { code: 'XJ_QR_SIM_FAIL', message: 'simulated failure at index ' + myIdx } });
      if (cfg.failMode === 'createFail' || cfg.failMode === 'createThrow') {
        if (cfg.failMode === 'createThrow') return Promise.reject(new Error('simulated store throw'));
        return Promise.resolve({ ok: false, error: { code: 'XJ_QR_SIM_FAIL', message: 'simulated failure' } });
      }
      return delay().then(function () {
        var copy = JSON.parse(JSON.stringify(payload));
        sessions.set(copy.id, copy);
        return { ok: true, value: copy };
      });
    },
    saveSessionDurable: function (s) { writeLog.push({ op: 'saveSessionDurable', payload: s }); var c = JSON.parse(JSON.stringify(s)); sessions.set(c.id, c); return Promise.resolve({ ok: true, value: c }); },
    updateSessionFull: function (s) { writeLog.push({ op: 'updateSessionFull', payload: s }); var c = JSON.parse(JSON.stringify(s)); sessions.set(c.id, c); return Promise.resolve({ ok: true, value: c }); },
    deleteSessionDurable: function (id) { sessions.delete(id); return Promise.resolve({ ok: true }); },
    createSupervisionDurable: function (sv) {
      writeLog.push({ op: 'createSupervisionDurable', payload: sv });
      if (cfg.failMode === 'svFail') return Promise.resolve({ ok: false, error: { code: 'XJ_QR_SV_FAIL', message: 'sim' } });
      var c = JSON.parse(JSON.stringify(sv)); supervisions.set(c.id, c); return Promise.resolve({ ok: true, value: c });
    },
    saveBillingBatchDurable: function (batch) {
      writeLog.push({ op: 'saveBillingBatchDurable', payload: batch });
      if (cfg.failMode === 'billingFail') return Promise.resolve({ ok: false, error: { code: 'XJ_QR_BILL_FAIL', message: 'sim' } });
      return Promise.resolve({ ok: true, value: batch });
    },
    // v4.3 durable completion APIs —— 真实 Store 必须提供，否则生产走 legacy 分支（见 quick-record.js:204）。
    saveSessionTemplateSelectionDurable: function (sessionId, selection) {
      writeLog.push({ op: 'saveSessionTemplateSelectionDurable', payload: { sessionId: sessionId, selection: selection } });
      if (cfg.failMode === 'templateFail') return Promise.resolve({ ok: false, error: { code: 'XJ_QR_TEMPLATE_FAIL', message: 'sim' } });
      return Promise.resolve({ ok: true, value: selection });
    },
    saveClinicalTasksDurable: function (tasks) {
      writeLog.push({ op: 'saveClinicalTasksDurable', payload: tasks });
      if (cfg.failMode === 'taskFail') return Promise.resolve({ ok: false, error: { code: 'XJ_QR_TASK_FAIL', message: 'sim' } });
      return Promise.resolve({ ok: true, value: tasks });
    },
    getSessionRecoveryDraft: function () { return null; },
    canSwitchSession: function () { return { allowed: true }; },
  };
  clients.set('c1', { id: 'c1', name: 'Alice', status: 'active' });
  return api;
}

function makeApp() {
  var calls = [];
  return {
    calls: calls,
    todayStr: function () { return '2026-07-21'; },
    showToast: function (msg, kind) { calls.push({ msg: msg, kind: kind }); },
  };
}

function loadQR(srcOverride, storeOpts) {
  var store = makeStore(storeOpts);
  var app = makeApp();
  var ctx = vm.createContext(Object.create(null));
  Object.assign(ctx, { Store: store, App: app, console: console, Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout, Date: Date, Math: Math, JSON: JSON });
  ctx.window = ctx; // window IS the global, so `window.QuickRecord = ...` lands on ctx.QuickRecord
  vm.runInContext(srcOverride || QR_SRC, ctx);
  return { qr: ctx.QuickRecord, store: store, app: app };
}

// ===================== TESTS =====================
test('S1: module exposes required API surface', function () {
  var lo = loadQR();
  ['createQuickRecord', 'followUpBilling', 'followUpNextSchedule', 'followUpSupervision', 'followUpFullRecord', 'createRecurringSeries', 'canSwitchAway', 'recoverDraft', 'reset']
    .forEach(function (k) { if (typeof lo.qr[k] !== 'function') throw new Error('missing API: ' + k); });
});

test('T1: durable clinical-task persistence — non-empty manual task list is awaited and written via saveClinicalTasksDurable', async function () {
  // 接 v4.3 已验收行为：会谈成功后继续保存 Free 手动模板与临床任务。
  // 旧 S2 仅检查字面 'clinicalTasks'（大小写/字段名敏感），属过时“不持久化”边界，为假绿。
  var lo = loadQR();
  var titles = ['完成家庭作业', '预约复查'];
  var res = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x', taskTitles: titles });
  if (res.ok !== true) throw new Error('expected ok:true, got ' + JSON.stringify(res));
  var writes = lo.store.writeLog.filter(function (w) { return w.op === 'saveClinicalTasksDurable'; });
  if (writes.length !== 1) throw new Error('expected exactly 1 durable clinical-task write, got ' + writes.length);
  var written = writes[0].payload;
  if (!Array.isArray(written) || written.length !== titles.length) throw new Error('task list not durably written as expected');
  written.forEach(function (t, i) {
    if (t.title !== titles[i]) throw new Error('task title mismatch at ' + i);
    if (t.status !== 'open' || !t.id || t.originSessionId !== res.value.id) throw new Error('task object malformed: ' + JSON.stringify(t));
  });
});

test('T2: zero manual tasks must NOT create a fake durable clinical-task write', async function () {
  // 无 taskTitles 时，不应伪造任何 saveClinicalTasksDurable 写入。
  var lo = loadQR();
  var res = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x' });
  if (res.ok !== true) throw new Error('expected ok:true, got ' + JSON.stringify(res));
  var writes = lo.store.writeLog.filter(function (w) { return w.op === 'saveClinicalTasksDurable'; });
  if (writes.length !== 0) throw new Error('zero tasks must not create a durable write, got ' + writes.length);
});

test('B1: happy path — persists session, returns ok:true, success toast after await', async function () {
  var lo = loadQR();
  var res = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'hello', transcript: 't' });
  if (res.ok !== true) throw new Error('expected ok:true');
  if (!lo.store.getSession(res.value.id)) throw new Error('session not in authoritative cache');
  if (!lo.app.calls.some(function (c) { return c.msg === '快速记录、模板和待办已保存'; })) throw new Error('success toast missing');
});

test('B2: failure — no success toast, draft preserved', async function () {
  var lo = loadQR(null, { failMode: 'createFail' });
  var res = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'nope' });
  if (res.ok !== false) throw new Error('expected failure');
  if (lo.app.calls.some(function (c) { return c.msg === '快速记录已保存'; })) throw new Error('success toast must NOT fire on failure');
  if (!lo.qr.recoverDraft()) throw new Error('draft not preserved');
});

test('B3: duplicate-click concurrency — only one durable write', async function () {
  var lo = loadQR(null, { delayMs: 20 });
  var p1 = lo.qr.createQuickRecord({ clientId: 'c1', notes: 'a' });
  var p2 = lo.qr.createQuickRecord({ clientId: 'c1', notes: 'b' }); // pending → rejected, no store call
  var r1 = await p1, r2 = await p2;
  if (r1.ok !== true) throw new Error('first should succeed');
  if (r2.ok !== false) throw new Error('second concurrent should be rejected (pending)');
  var writes = lo.store.writeLog.filter(function (w) { return w.op === 'createSessionDurable'; });
  if (writes.length !== 1) throw new Error('expected exactly 1 durable write, got ' + writes.length);
});

test('B4: duplicate-click after success — idempotent, no new write', async function () {
  var lo = loadQR();
  var r1 = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'a' });
  if (r1.ok !== true) throw new Error('first should succeed');
  var before = lo.store.writeLog.filter(function (w) { return w.op === 'createSessionDurable'; }).length;
  var r2 = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'b' });
  if (!r2.idempotent) throw new Error('second should be idempotent');
  if (r2.ok !== true) throw new Error('second should return ok');
  var after = lo.store.writeLog.filter(function (w) { return w.op === 'createSessionDurable'; }).length;
  if (after !== before) throw new Error('second call must not create a new session');
});

test('B5: persistence failure preserves draft + original context and blocks switch', async function () {
  var lo = loadQR(null, { failMode: 'createFail' });
  var input = { clientId: 'c1', notes: 'draft-text', transcript: 't' };
  var res = await lo.qr.createQuickRecord(input);
  if (res.ok !== false) throw new Error('expected failure');
  var draft = lo.qr.recoverDraft();
  if (!draft || draft.notes !== 'draft-text' || draft.transcript !== 't') throw new Error('draft not preserved: ' + JSON.stringify(draft));
  var ctx = lo.qr.getLastContext();
  if (!ctx || ctx.clientId !== 'c1') throw new Error('original context not preserved');
  if (lo.qr.canSwitchAway().allowed !== false) throw new Error('switch not blocked on failure');
  if (lo.store.getSession(res.value && res.value.id)) throw new Error('failed session must not enter cache');
});

test('B6: delayed flush — switch blocked during pending, allowed after commit', async function () {
  var lo = loadQR(null, { delayMs: 50 });
  var p = lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x' });
  if (lo.qr.canSwitchAway().allowed !== false) throw new Error('switch allowed during pending');
  var res = await p;
  if (res.ok !== true) throw new Error('expected success');
  if (lo.qr.canSwitchAway().allowed !== true) throw new Error('switch blocked after commit');
  if (!lo.store.getSession(res.value.id)) throw new Error('session not in cache after commit');
});

test('B7: power-loss/interrupt — draft recoverable, switch blocked, nothing persisted', async function () {
  var lo = loadQR(null, { failMode: 'createThrow' });
  var input = { clientId: 'c1', notes: 'pl', transcript: 'tt' };
  var res = await lo.qr.createQuickRecord(input);
  if (res.ok !== false) throw new Error('expected failure');
  var draft = lo.qr.recoverDraft();
  if (!draft || draft.transcript !== 'tt') throw new Error('draft not recoverable after power-loss');
  if (lo.qr.canSwitchAway().allowed !== false) throw new Error('switch not blocked after power-loss');
});

test('B8: context switch blocked whenever an unsaved draft exists (negative)', async function () {
  var lo = loadQR(null, { failMode: 'createFail' });
  await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'u' });
  if (lo.qr.canSwitchAway().allowed !== false) throw new Error('switch must be blocked with unsaved draft');
  lo.qr.reset();
  if (lo.qr.canSwitchAway().allowed !== true) throw new Error('switch allowed after reset');
});

test('B9: recurring series stops subsequent writes on first failure', async function () {
  // 第一条成功、第二条起失败：验证“任一失败即停止后续写入”，且已成功的不会回滚。
  var lo = loadQR(null, { failFromIndex: 1 });
  var res = await lo.qr.createRecurringSeries('c1', { startDate: '2026-08-01' }, 3);
  if (res.ok !== false) throw new Error('expected series failure');
  if (res.created.length !== 1) throw new Error('only first should be created, got ' + res.created.length);
  if (res.stoppedAtIndex !== 1) throw new Error('should stop at index 1, got ' + res.stoppedAtIndex);
  var writes = lo.store.writeLog.filter(function (w) { return w.op === 'createSessionDurable'; });
  if (writes.length !== 2) throw new Error('only 2 writes attempted (1 ok,1 fail), got ' + writes.length);
  // 已成功创建的第 0 条必须仍存在于权威缓存（不回滚）。
  if (!lo.store.getSession(res.created[0].id)) throw new Error('already-created session was rolled back');
});

test('B10: recurring series all-success creates N sessions', async function () {
  var lo = loadQR();
  var res = await lo.qr.createRecurringSeries('c1', { startDate: '2026-08-01' }, 3);
  if (res.ok !== true || res.created.length !== 3) throw new Error('expected 3 created, got ' + (res.created && res.created.length));
});

test('B11: followUpBilling — success persists batch + success toast', async function () {
  var lo = loadQR();
  var r = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x' });
  var b = await lo.qr.followUpBilling(r.value, { expenses: [] });
  if (b.ok !== true) throw new Error('billing should succeed');
  if (!lo.store.writeLog.some(function (x) { return x.op === 'saveBillingBatchDurable'; })) throw new Error('saveBillingBatchDurable not called');
  if (!lo.app.calls.some(function (c) { return c.msg === '账务已同步'; })) throw new Error('success toast missing');
});

test('B12: followUpBilling — failure returns ok:false, no success toast', async function () {
  var lo = loadQR(null, { failMode: 'billingFail' });
  var r = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x' });
  var b = await lo.qr.followUpBilling(r.value, {});
  if (b.ok !== false) throw new Error('billing should fail');
  if (lo.app.calls.some(function (c) { return c.msg === '账务已同步'; })) throw new Error('success toast must not fire on failure');
});

test('B13: followUpNextSchedule — success creates appointment session', async function () {
  var lo = loadQR();
  var r = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x' });
  var a = await lo.qr.followUpNextSchedule('c1', {});
  if (a.ok !== true) throw new Error('next schedule should succeed');
  if (!lo.store.getSession(a.value.id)) throw new Error('appointment not in cache');
});

test('B14: followUpNextSchedule — failure returns ok:false', async function () {
  var lo = loadQR(null, { failMode: 'createFail' });
  var a = await lo.qr.followUpNextSchedule('c1', {});
  if (a.ok !== false) throw new Error('should fail');
});

test('B15: followUpSupervision — success persists supervision', async function () {
  var lo = loadQR();
  var s = await lo.qr.followUpSupervision('c1', { sessionIds: [] });
  if (s.ok !== true) throw new Error('supervision should succeed');
  if (!lo.store.writeLog.some(function (x) { return x.op === 'createSupervisionDurable'; })) throw new Error('createSupervisionDurable not called');
});

test('B16: followUpSupervision — failure returns ok:false', async function () {
  var lo = loadQR(null, { failMode: 'svFail' });
  var s = await lo.qr.followUpSupervision('c1', {});
  if (s.ok !== false) throw new Error('should fail');
});

test('B17: followUpFullRecord — success updates session', async function () {
  var lo = loadQR();
  var r = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x' });
  var f = await lo.qr.followUpFullRecord(r.value, { soap: { s: 'subj' } });
  if (f.ok !== true) throw new Error('full record should succeed');
  var stored = lo.store.getSession(r.value.id);
  if (!stored || !stored.soap) throw new Error('full record not updated');
});

test('B18: followUpFullRecord — missing session returns ok:false (negative)', async function () {
  var lo = loadQR();
  var f = await lo.qr.followUpFullRecord(null, {});
  if (f.ok !== false) throw new Error('should fail without session');
});

test('T3: clinical-task persistence failure — ok:false, no success toast, resumable bundle preserved', async function () {
  var lo = loadQR(null, { failMode: 'taskFail' });
  var res = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x', taskTitles: ['随访'] });
  if (res.ok !== false) throw new Error('expected ok:false on task persistence failure');
  if (!res.sessionSaved) throw new Error('session should still be saved (sessionSaved:true)');
  if (!res.completionDraft) throw new Error('resumable completion bundle must be preserved');
  if (!res.recoveredDraft) throw new Error('recovered draft must be preserved');
  // 成功提示（会谈+模板+待办）绝不能出现；失败走错误 toast。
  if (lo.app.calls.some(function (c) { return c.msg === '快速记录、模板和待办已保存'; })) throw new Error('success toast must NOT fire on task failure');
});

test('T3b: retry after task failure does not duplicate already-durable session/template/task IDs', async function () {
  var lo = loadQR(null, { failMode: 'taskFail' });
  var first = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x', taskTitles: ['随访'] });
  if (first.ok !== false) throw new Error('expected first attempt to fail');
  var origIds = lo.qr._state.completionDraft.tasks.map(function (t) { return t.id; });
  // 修复存储（任务写入恢复成功），再次调用同一会谈 → 触发 resumeCompletion 重试。
  lo.store.configure({ failMode: 'none' });
  var retry = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x', taskTitles: ['随访'] });
  if (retry.ok !== true) throw new Error('retry should succeed, got ' + JSON.stringify(retry));
  // 模板只保存一次（已 durable 不重复）。
  var tmplWrites = lo.store.writeLog.filter(function (w) { return w.op === 'saveSessionTemplateSelectionDurable'; });
  if (tmplWrites.length !== 1) throw new Error('template must not be duplicated, writes=' + tmplWrites.length);
  // 任务写入：一次失败 + 一次成功；成功那次 payload 的 id 与原始一致（不生成新重复 id）。
  var taskWrites = lo.store.writeLog.filter(function (w) { return w.op === 'saveClinicalTasksDurable'; });
  if (taskWrites.length < 2) throw new Error('expected failed+successful task writes');
  var finalIds = taskWrites[taskWrites.length - 1].payload.map(function (t) { return t.id; });
  if (JSON.stringify(finalIds) !== JSON.stringify(origIds)) throw new Error('task IDs duplicated/changed on retry');
  if (retry.tasks.length !== origIds.length) throw new Error('retry task count mismatch');
});

// ---- expected-red: a naive string/return-value check would GREEN on the stub-persist mutation ----
test('E1: expected-red — naive check passes on stub-persist mutation (proves behavioral checks required)', function () {
  var mutated = QR_SRC.replace('result = await Store.createSessionDurable(payload);', 'result = await Promise.resolve({ ok: true, value: payload });');
  if (mutated === QR_SRC) throw new Error('E1: no-op');
  function naivePass(src, res) { return src.indexOf('createSessionDurable') >= 0 && res && res.ok === true; }
  var lo = loadQR(mutated);
  return lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x' }).then(function (res) {
    var naive = naivePass(mutated, res); // true → a naive contract would GREEN
    var realWrites = lo.store.writeLog.filter(function (w) { return w.op === 'createSessionDurable'; });
    if (!naive) throw new Error('E1 setup: naive check unexpectedly failed');
    if (realWrites.length !== 0) throw new Error('E1 setup: mutation actually persisted (unexpected)');
    // Proven: naive GREEN while real persistence bypassed. Behavioral tests (M2/B1) instead assert real writeLog.
  });
});

// ---- expected-red: the OLD no-persistence boundary is a false-green against real v4.3 behavior ----
test('E2: expected-red — old /clinicalTasks/ payload check is a false-green against real v4.3 persistence', async function () {
  // 证明旧边界检查（B19 等价逻辑）即便生产真实持久化临床任务仍会 GREEN。
  var lo = loadQR(); // fixture 已含 saveClinicalTasksDurable → 生产走 v4.3 完成分支
  var res = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x', taskTitles: ['随访'] });
  var realTaskWrites = lo.store.writeLog.filter(function (w) { return w.op === 'saveClinicalTasksDurable'; });
  if (realTaskWrites.length === 0) throw new Error('E2 setup: no real durable task write (unexpected)');
  // 旧断言：对 payload 做 /clinicalTasks/ 检查 —— 真实任务对象的字段是 title/id/status 等，不含字面 'clinicalTasks'。
  var oldCheckGreen = !lo.store.writeLog.some(function (w) {
    return /clinicalTasks/.test(JSON.stringify(w.payload)) || (w.op && /clinicalTasks/.test(w.op));
  });
  if (!oldCheckGreen) throw new Error('E2 setup: old check unexpectedly failed');
  // 结论：真实持久化已发生，旧边界检查却仍 GREEN → 假绿确证。行为级测试 T1/T3 取而代之。
});

// ---- mutation-sensitive gates ----
test('M1: mutation-sensitive — removing await before createSessionDurable is detected', async function () {
  var mutated = QR_SRC.replace('result = await Store.createSessionDurable(payload);', 'result = Store.createSessionDurable(payload);');
  if (mutated === QR_SRC) throw new Error('M1: no-op');
  var lo = loadQR(mutated);
  var res = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x' });
  expectThrow(function () {
    if (res.ok !== true) throw new Error('mutation not detected: ok=' + res.ok);
    if (res.value && !lo.store.getSession(res.value.id)) throw new Error('mutation not detected: not persisted');
  }, 'M1');
});

test('M2: mutation-sensitive — stubbing persistence (no real Store write) is detected', async function () {
  var mutated = QR_SRC.replace('result = await Store.createSessionDurable(payload);', 'result = await Promise.resolve({ ok: true, value: payload });');
  if (mutated === QR_SRC) throw new Error('M2: no-op');
  var lo = loadQR(mutated);
  var res = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x' });
  expectThrow(function () {
    if (res.ok !== true) throw new Error('unexpected ok=' + res.ok);
    var realWrites = lo.store.writeLog.filter(function (w) { return w.op === 'createSessionDurable'; });
    if (realWrites.length === 0) throw new Error('mutation not detected: real durable write was bypassed');
  }, 'M2');
});

test('M3: mutation-sensitive — removing failure guard is detected (failure path must be handled)', async function () {
  var reBlock = /if \(!result \|\| !result\.ok\) \{[\s\S]*?recoveredDraft: state\.draft \};\s*\}/;
  if (!reBlock.test(QR_SRC)) throw new Error('M3: failure block not found');
  var mutated = QR_SRC.replace(reBlock, '/* mut: failure-guard removed */');
  if (mutated === QR_SRC) throw new Error('M3: mutation no-op');
  var lo = loadQR(mutated, { failMode: 'createFail' });
  // 未变异时，createFail 会优雅返回 ok:false（不抛、不成功提示）。
  // 删除失败守卫后，v4.3 路径会崩溃（未处理失败），或误走成功提示 —— 任一均证明守卫不可删。
  var err = null;
  try { await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x' }); } catch (e) { err = e; }
  var misHandled = !!err
    || lo.app.calls.some(function (c) { return c.msg === '快速记录、模板和待办已保存' || c.msg === '快速记录已保存'; });
  if (!misHandled) throw new Error('M3: mutation not detected — failure still handled gracefully');
});

test('M4: mutation-sensitive — removing await before saveClinicalTasksDurable is detected', async function () {
  var mutated = QR_SRC.replace('taskResult = await Store.saveClinicalTasksDurable(completion.tasks);', 'taskResult = Store.saveClinicalTasksDurable(completion.tasks);');
  if (mutated === QR_SRC) throw new Error('M4: no-op');
  var lo = loadQR(mutated);
  var res = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x', taskTitles: ['a'] });
  expectThrow(function () {
    if (res.ok !== true) throw new Error('mutation not detected: ok=' + res.ok);
    if (res.value && !lo.store.getSession(res.value.id)) throw new Error('mutation not detected: not persisted');
  }, 'M4');
});

test('M5: mutation-sensitive — stubbing durable task write (no real Store write) is detected', async function () {
  var mutated = QR_SRC.replace('taskResult = await Store.saveClinicalTasksDurable(completion.tasks);', 'taskResult = await Promise.resolve({ ok: true, value: completion.tasks });');
  if (mutated === QR_SRC) throw new Error('M5: no-op');
  var lo = loadQR(mutated);
  var res = await lo.qr.createQuickRecord({ clientId: 'c1', notes: 'x', taskTitles: ['a'] });
  expectThrow(function () {
    if (res.ok !== true) throw new Error('unexpected ok=' + res.ok);
    var realWrites = lo.store.writeLog.filter(function (w) { return w.op === 'saveClinicalTasksDurable'; });
    if (realWrites.length === 0) throw new Error('mutation not detected: real durable task write was bypassed');
  }, 'M5');
});

// ===================== RUN =====================
(async function () {
  console.log('=== XJ-4.2.2 quick-record contract (real module execution) ===\n');
  for (var i = 0; i < tests.length; i++) {
    var t = tests[i];
    try {
      await t.fn();
      passed++;
      console.log('[PASS] ' + t.name);
    } catch (e) {
      failed++;
      console.log('[FAIL] ' + t.name + ' — ' + (e && e.message ? e.message : String(e)).slice(0, 300));
    }
  }
  console.log('\n========================================');
  console.log('Passed: ' + passed + ' | Failed: ' + failed);
  console.log('========================================');
  console.log('注：本测试仅验证契约，不宣称 release-ready。');
  process.exit(failed > 0 ? 1 : 0);
})();
