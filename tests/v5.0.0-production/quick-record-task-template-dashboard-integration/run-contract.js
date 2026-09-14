'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SOURCE = process.env.XJ_QR_SOURCE || path.join(ROOT, 'app', 'js', 'quick-record.js');
const source = fs.readFileSync(SOURCE, 'utf8');
const dashboardSource = fs.readFileSync(process.env.XJ_DASHBOARD_SOURCE || path.join(ROOT, 'app', 'js', 'dashboard.js'), 'utf8');
const indexSource = fs.readFileSync(process.env.XJ_INDEX_SOURCE || path.join(ROOT, 'app', 'index.html'), 'utf8');
const cssSource = fs.readFileSync(process.env.XJ_CSS_SOURCE || path.join(ROOT, 'app', 'css', 'workbench-home.css'), 'utf8');

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function makeHarness(options) {
  options = options || {};
  const calls = { sessions: 0, templates: 0, tasks: 0 };
  const sessions = [];
  const tasks = [];
  const selections = new Map();
  let templateFailures = Number(options.templateFailures || 0);
  let taskFailures = Number(options.taskFailures || 0);
  let releaseSession;
  const sessionGate = options.blockSession ? new Promise((resolve) => { releaseSession = resolve; }) : null;

  const store = {
    getSession(id) { return sessions.find((item) => item.id === id) || null; },
    getClient(id) { return id === 'c1' ? { id: 'c1', name: 'Synthetic Client' } : null; },
    async createSessionDurable(payload) {
      calls.sessions += 1;
      if (sessionGate) await sessionGate;
      const value = Object.assign({ sessionNumber: sessions.length + 1 }, payload);
      sessions.push(value);
      return { ok: true, value };
    },
    async saveSessionTemplateSelectionDurable(sessionId, selection) {
      calls.templates += 1;
      if (templateFailures > 0) {
        templateFailures -= 1;
        return { ok: false, error: { code: 'TEST_TEMPLATE_FAILURE', message: 'template failed' } };
      }
      selections.set(sessionId, JSON.parse(JSON.stringify(selection)));
      return { ok: true, value: selection };
    },
    async saveClinicalTasksDurable(batch) {
      calls.tasks += 1;
      if (taskFailures > 0) {
        taskFailures -= 1;
        return { ok: false, error: { code: 'TEST_TASK_FAILURE', message: 'task failed' } };
      }
      batch.forEach((task) => {
        const index = tasks.findIndex((item) => item.id === task.id);
        if (index >= 0) tasks[index] = JSON.parse(JSON.stringify(task));
        else tasks.push(JSON.parse(JSON.stringify(task)));
      });
      return { ok: true, value: batch };
    },
    async saveBillingBatchDurable(data) { return { ok: true, value: data }; },
    async createSupervisionDurable(data) { return { ok: true, value: data }; },
    async updateSessionFull(data) { return { ok: true, value: data }; }
  };
  const app = {
    todayStr() { return '2026-07-27'; },
    showToast() {}
  };
  const context = vm.createContext({
    window: null,
    Store: store,
    App: app,
    console,
    Date,
    Math,
    JSON,
    setTimeout,
    clearTimeout
  });
  context.window = context;
  vm.runInContext(source, context, { filename: SOURCE });
  return { qr: context.QuickRecord, store, calls, sessions, tasks, selections, releaseSession };
}

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write('PASS ' + name + '\n');
  } catch (error) {
    process.stderr.write('FAIL ' + name + ': ' + error.message + '\n');
    failures += 1;
  }
}

let failures = 0;

(async function run() {
  await test('exports completion-bundle state', async () => {
    const h = makeHarness();
    check(h.qr && typeof h.qr.createQuickRecord === 'function', 'QuickRecord missing');
    check(Object.prototype.hasOwnProperty.call(h.qr._state, 'completionDraft'), 'completionDraft state missing');
  });

  await test('persists session, Free manual template and bounded manual tasks', async () => {
    const h = makeHarness();
    const result = await h.qr.createQuickRecord({
      clientId: 'c1', notes: 'synthetic note', templateId: 'manual-session-v1',
      taskTitles: ['  synthetic follow-up  ', '', 'second follow-up']
    });
    check(result.ok === true, 'bundle should succeed');
    check(h.calls.sessions === 1 && h.calls.templates === 1 && h.calls.tasks === 1, 'all durable stages must run once');
    check(h.selections.get(result.value.id).templateId === 'manual-session-v1', 'manual template missing');
    check(h.tasks.length === 2, 'empty task lines must be ignored');
    check(h.tasks.every((task) => task.status === 'open' && task.createdBy === 'manual'), 'manual tasks must start open');
    check(h.tasks.every((task) => task.clientId === 'c1' && task.originSessionId === result.value.id), 'task trace mismatch');
    check(h.tasks.every((task) => task.sourceRefs.length === 1 && /^session:/.test(task.sourceRefs[0])), 'identifier-only session ref required');
    check(h.qr.recoverDraft() === null, 'draft must clear after complete success');
  });

  await test('template failure keeps session and resumes without duplicate session or IDs', async () => {
    const h = makeHarness({ templateFailures: 1 });
    const input = { clientId: 'c1', notes: 'synthetic', taskTitles: ['follow-up'] };
    const first = await h.qr.createQuickRecord(input);
    check(first.ok === false && first.sessionSaved === true, 'template failure must expose partial durable state');
    check(first.error && first.error.code === 'XJ_QR_TEMPLATE_SAVE_FAILED', 'wrong template stage error');
    check(h.calls.sessions === 1 && h.calls.tasks === 0, 'tasks must not run after template failure');
    const firstIds = h.qr._state.completionDraft.tasks.map((task) => task.id);
    const second = await h.qr.createQuickRecord(input);
    check(second.ok === true, 'retry should resume');
    check(h.calls.sessions === 1, 'retry must not create a second session');
    check(JSON.stringify(h.tasks.map((task) => task.id)) === JSON.stringify(firstIds), 'retry must keep task IDs');
  });

  await test('task failure resumes same completion bundle without duplicate task', async () => {
    const h = makeHarness({ taskFailures: 1 });
    const input = { clientId: 'c1', taskTitles: ['one'] };
    const first = await h.qr.createQuickRecord(input);
    check(first.ok === false && first.error.code === 'XJ_QR_TASK_SAVE_FAILED', 'wrong task stage error');
    check(h.calls.sessions === 1 && h.calls.templates === 1 && h.calls.tasks === 1, 'first stage counts mismatch');
    const id = h.qr._state.completionDraft.tasks[0].id;
    const second = await h.qr.createQuickRecord(input);
    check(second.ok === true, 'task retry should succeed');
    check(h.calls.sessions === 1 && h.calls.templates === 1 && h.calls.tasks === 2, 'retry must resume only task stage');
    check(h.tasks.length === 1 && h.tasks[0].id === id, 'task retry duplicated or changed ID');
  });

  await test('zero-task bundle persists template without task batch', async () => {
    const h = makeHarness();
    const result = await h.qr.createQuickRecord({ clientId: 'c1', taskTitles: [] });
    check(result.ok === true, 'zero-task save failed');
    check(h.calls.templates === 1 && h.calls.tasks === 0, 'zero-task path must skip task batch');
  });

  await test('rejects overlong or excessive task input before session write', async () => {
    const h1 = makeHarness();
    const long = await h1.qr.createQuickRecord({ clientId: 'c1', taskTitles: ['x'.repeat(161)] });
    check(long.ok === false && long.error.code === 'XJ_QR_TASK_INPUT_INVALID', 'long title must fail');
    check(h1.calls.sessions === 0, 'invalid title must fail before session write');
    const h2 = makeHarness();
    const many = await h2.qr.createQuickRecord({ clientId: 'c1', taskTitles: ['1', '2', '3', '4', '5', '6'] });
    check(many.ok === false && h2.calls.sessions === 0, 'more than five tasks must fail before write');
  });

  await test('pending save rejects duplicate click and blocks navigation', async () => {
    const h = makeHarness({ blockSession: true });
    const pending = h.qr.createQuickRecord({ clientId: 'c1', taskTitles: [] });
    const duplicate = await h.qr.createQuickRecord({ clientId: 'c1', taskTitles: [] });
    check(duplicate.ok === false && duplicate.error.code === 'XJ_QR_PENDING', 'pending duplicate must fail');
    check(h.qr.canSwitchAway().allowed === false, 'pending save must block switching');
    h.releaseSession();
    await pending;
  });

  await test('homepage loads task/template ViewModels before QuickRecord', async () => {
    const taskPos = indexSource.indexOf('js/clinical-task-view-model.js');
    const templatePos = indexSource.indexOf('js/session-template-view-model.js');
    const quickPos = indexSource.indexOf('js/quick-record.js');
    check(taskPos >= 0 && templatePos >= 0 && quickPos > taskPos && quickPos > templatePos, 'script order is incomplete');
  });

  await test('QuickRecord UI exposes manual template/tasks and removes inert fee input', async () => {
    check(/id="qr-template"/.test(dashboardSource), 'template control missing');
    check(/id="qr-task-titles"/.test(dashboardSource), 'task input missing');
    check(!/id="qr-fee"/.test(dashboardSource), 'inert fee control remains');
    check(/qr-field-wide/.test(cssSource) && /qr-task-titles/.test(cssSource), 'task UI styles missing');
  });

  await test('dashboard projects durable tasks and awaits completion before rerender', async () => {
    check(/Store\.getClinicalTasks\(\)/.test(dashboardSource), 'durable task projection missing');
    check(/task\.target === 'consult-notes\.html'/.test(dashboardSource), 'unsafe target must fail closed');
    check(/await Store\.transitionClinicalTaskDurable\(id, 'done'\)/.test(dashboardSource), 'task completion must be awaited');
    const completion = dashboardSource.slice(dashboardSource.indexOf("await Store.transitionClinicalTaskDurable(id, 'done')"));
    check(completion.indexOf('if (!result || !result.ok)') >= 0, 'completion failure guard missing');
    check(completion.indexOf('renderTodo();') > completion.indexOf('if (!result || !result.ok)'), 'rerender must follow durable success');
  });

  await test('dialog Escape and close checks use gate.allowed', async () => {
    check(/e\.key === 'Escape'/.test(dashboardSource), 'Escape handler missing');
    check(/gate\.allowed !== false/.test(dashboardSource), 'close guard must inspect allowed');
    check(/pending-completion/.test(source), 'completion draft must block switching');
  });

  if (failures) {
    process.stderr.write('quick-record task/template contract: FAIL ' + failures + '\n');
    process.exit(1);
  }
  process.stdout.write('quick-record task/template contract: PASS 11/11\n');
})().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exit(1);
});
