'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SOURCE_PATH = process.env.XJ_DASHBOARD_SOURCE || path.join(ROOT, 'app', 'js', 'dashboard.js');
const RESULT_PATH = process.env.XJ_CONTRACT_RESULT || path.join(__dirname, 'contract-result.json');
const TASK_ID = 'XJ-5.0.0-codex-v4.3-ai-draft-confirmation-dashboard-30';
const dashboardSource = fs.readFileSync(SOURCE_PATH, 'utf8');

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function makeElement(id) {
  return {
    id,
    dataset: {},
    style: {},
    innerHTML: '',
    textContent: '',
    disabled: false,
    listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    setAttribute(name, value) { this[name] = String(value); },
    getAttribute(name) { return this[name] === undefined ? null : this[name]; },
    hasAttribute(name) { return this[name] !== undefined && this[name] !== null; },
  };
}

function exposeRenderTodo(source) {
  const marker = '\n})();';
  const markerAt = source.lastIndexOf(marker);
  check(markerAt >= 0, 'dashboard IIFE tail missing');
  return source.slice(0, markerAt) + '\nwindow.__xjRenderTodo = renderTodo;' + source.slice(markerAt);
}

function makeHarness(options) {
  options = options || {};
  const container = makeElement('todo-list');
  const welDate = makeElement('wel-date');
  const elements = { 'todo-list': container, 'wel-date': welDate };
  const task = {
    id: 'task-synthetic-1',
    clientId: 'client-synthetic-1',
    originSessionId: 'session-synthetic-1',
    title: '整理合成跟进事项',
    status: options.status || 'ai-draft',
    due: '',
    sourceRefs: ['session:synthetic-1', 'action:synthetic-1'],
    target: 'consult-notes.html',
    createdBy: 'ai-draft',
    actionRunId: 'run-synthetic-1',
  };
  const calls = { confirm: 0, transition: 0 };
  const toasts = [];
  let releaseConfirm = null;
  const store = {
    getSessions() { return []; },
    getClients() { return []; },
    getClient(id) { return id === task.clientId ? { id, name: '合成来访者' } : null; },
    getSessionsByClient() { return []; },
    getClinicalTasks() { return [Object.assign({}, task, { sourceRefs: task.sourceRefs.slice() })]; },
    confirmClinicalTaskDurable(id) {
      calls.confirm += 1;
      check(id === task.id, 'confirmation must target the rendered task');
      if (options.confirmBehavior === 'pending') {
        return new Promise((resolve) => {
          releaseConfirm = () => {
            task.status = 'open';
            resolve({ ok: true, value: Object.assign({}, task) });
          };
        });
      }
      if (options.confirmBehavior === 'failure') return Promise.resolve({ ok: false, error: { code: 'SYNTHETIC_CONFIRM_FAILED' } });
      if (options.confirmBehavior === 'throw') return Promise.reject(new Error('synthetic confirm exception'));
      task.status = 'open';
      return Promise.resolve({ ok: true, value: Object.assign({}, task) });
    },
    transitionClinicalTaskDurable(id, status) {
      calls.transition += 1;
      check(id === task.id && status === 'done', 'completion transition arguments mismatch');
      check(task.status === 'open', 'only a confirmed draft may be completed');
      task.status = 'done';
      return Promise.resolve({ ok: true, value: Object.assign({}, task) });
    },
  };
  const app = {
    todayFullCN() { return '合成日期'; },
    escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); },
    todayStr() { return '2026-07-28'; },
    formatDate(value) { return String(value || ''); },
    showToast(message, kind) { toasts.push({ message, kind }); },
    initPage(options) { this.ready = options.onReady; },
  };
  const document = {
    body: makeElement('body'),
    getElementById(id) { return elements[id] || makeElement(id); },
    querySelectorAll() { return []; },
  };
  const context = vm.createContext({
    App: app,
    Store: store,
    document,
    console,
    Date,
    Math,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    WorkbenchReadonly: {
      buildDeepLink(page, params) { return page + '?clientId=' + params.clientId + '&sessionId=' + params.sessionId; },
    },
    routeFor() { return 'consult-notes.html?clientId=client-synthetic-1&sessionId=session-synthetic-1'; },
    renderIcons() {},
  });
  context.window = context;
  vm.runInContext(exposeRenderTodo(dashboardSource), context, { filename: SOURCE_PATH });
  check(typeof context.__xjRenderTodo === 'function', 'real dashboard renderTodo was not exposed');
  return {
    context, container, store, task, calls, toasts, renderTodo: context.__xjRenderTodo,
    get releaseConfirm() { return releaseConfirm; },
  };
}

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    process.stdout.write('PASS ' + name + '\n');
  } catch (error) {
    failures += 1;
    process.stderr.write('FAIL ' + name + ': ' + error.message + '\n');
  }
}

(async function run() {
  await test('executes the real dashboard and renders draft provenance', async () => {
    const h = makeHarness();
    h.renderTodo();
    check(h.container.innerHTML.includes('data-task-confirm="task-synthetic-1"'), 'AI draft confirm button missing');
    check(h.container.innerHTML.includes('待人工确认'), 'human confirmation state missing');
    check(h.container.innerHTML.includes('run-synthetic-1'), 'action run identifier missing');
    check(h.container.innerHTML.includes('session:synthetic-1'), 'source identifier missing');
    check(!h.container.innerHTML.includes('data-task-complete="task-synthetic-1"'), 'AI draft must not expose completion action');
  });

  await test('awaits durable confirmation and exposes completion only after success', async () => {
    const h = makeHarness({ confirmBehavior: 'pending' });
    h.renderTodo();
    const button = { disabled: false, getAttribute() { return h.task.id; }, hasAttribute(name) { return name === 'data-task-confirm'; } };
    const event = { target: { closest() { return button; } } };
    const pending = h.container.listeners.click(event);
    check(button.disabled === true, 'confirm button must disable while persistence is pending');
    check(h.calls.confirm === 1 && h.calls.transition === 0, 'confirm path must call only confirm API');
    check(typeof h.releaseConfirm === 'function', 'confirm promise was not retained');
    h.releaseConfirm();
    await pending;
    check(h.container.innerHTML.includes('data-task-complete="task-synthetic-1"'), 'confirmed task must expose completion action');
    check(!h.container.innerHTML.includes('data-task-confirm="task-synthetic-1"'), 'confirmed task must leave draft state');
    check(h.toasts.some((toast) => toast.kind === 'success' && toast.message.includes('已确认')), 'confirmation success toast missing');
  });

  await test('keeps draft and restores control on durable failure', async () => {
    const h = makeHarness({ confirmBehavior: 'failure' });
    h.renderTodo();
    const button = { disabled: false, getAttribute() { return h.task.id; }, hasAttribute(name) { return name === 'data-task-confirm'; } };
    await h.container.listeners.click({ target: { closest() { return button; } } });
    check(button.disabled === false, 'failed confirmation must re-enable the button');
    check(h.task.status === 'ai-draft', 'failed confirmation must preserve draft status');
    check(h.calls.transition === 0, 'failed confirmation must not complete the task');
    check(h.container.innerHTML.includes('data-task-confirm="task-synthetic-1"'), 'failed confirmation must keep the draft action');
    check(h.toasts.some((toast) => toast.kind === 'error' && toast.message.includes('草稿未确认')), 'failure recovery toast missing');
  });

  await test('converts thrown confirmation into a recoverable UI error', async () => {
    const h = makeHarness({ confirmBehavior: 'throw' });
    h.renderTodo();
    const button = { disabled: false, getAttribute() { return h.task.id; }, hasAttribute(name) { return name === 'data-task-confirm'; } };
    await h.container.listeners.click({ target: { closest() { return button; } } });
    check(button.disabled === false, 'exception path must re-enable the button');
    check(h.task.status === 'ai-draft', 'exception path must preserve draft status');
    check(h.toasts.some((toast) => toast.kind === 'error'), 'exception path must show an error');
  });

  await test('allows completion only after an open task is rendered', async () => {
    const h = makeHarness();
    h.task.status = 'open';
    h.renderTodo();
    check(h.container.innerHTML.includes('data-task-complete="task-synthetic-1"'), 'open task completion button missing');
    check(!h.container.innerHTML.includes('data-task-confirm="task-synthetic-1"'), 'open task must not expose draft confirmation');
    const button = { disabled: false, getAttribute() { return h.task.id; }, hasAttribute(name) { return name === 'data-task-complete'; } };
    await h.container.listeners.click({ target: { closest() { return button; } } });
    check(h.calls.transition === 1 && h.task.status === 'done', 'open task should complete through durable transition');
  });

  await test('keeps terminal tasks out of the pending projection', async () => {
    const h = makeHarness();
    h.task.status = 'done';
    h.renderTodo();
    check(!h.container.innerHTML.includes('整理合成跟进事项'), 'terminal task must not be projected into pending list');
  });

  if (failures) process.exit(1);
  const result = {
    schema_version: 1,
    task_id: TASK_ID,
    overall: 'PASS',
    tests: 6,
    passed: 6,
    failed: 0,
    real_entry: 'app/js/dashboard.js::renderTodo',
    synthetic_data_only: true,
  };
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');
  process.stdout.write('AI draft confirmation dashboard contract: PASS 6/6\n');
})().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.exit(1);
});
