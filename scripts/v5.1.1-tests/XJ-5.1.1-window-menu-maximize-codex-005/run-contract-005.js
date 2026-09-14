'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MAIN = path.join(ROOT, 'main.js');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-window-menu-maximize-codex-005');
const CARD = path.join(ROOT, 'docs', 'agent-coordination', 'v5.1.1', 'tasks', 'XJ-5.1.1-window-menu-maximize-codex-005.md');
const TASK = 'XJ-5.1.1-window-menu-maximize-codex-005';

function helperSource(source) {
  const start = source.indexOf('function getFocusedNormalWindow()');
  const end = source.indexOf('// ---- 主窗口 ----', start);
  if (start < 0 || end < 0) throw new Error('Window helper boundary missing');
  return source.slice(start, end);
}

function makeWindow(options = {}) {
  let maximized = options.maximized === true;
  const destroyed = options.destroyed === true;
  const modal = options.modal === true;
  const parent = options.parent || null;
  const minimized = options.minimized === true;
  const listeners = new Map();
  const calls = { maximize: 0, restore: 0 };
  const windowRef = {
    calls,
    isDestroyed: () => destroyed,
    isModal: () => modal,
    getParentWindow: () => parent,
    isMinimized: () => minimized,
    isMaximized: () => maximized,
    maximize: () => { maximized = true; calls.maximize += 1; (listeners.get('maximize') || []).forEach(fn => fn()); },
    restore: () => { maximized = false; calls.restore += 1; (listeners.get('restore') || []).forEach(fn => fn()); },
    on: (eventName, fn) => { if (!listeners.has(eventName)) listeners.set(eventName, []); listeners.get(eventName).push(fn); }
  };
  return windowRef;
}

function execute(source) {
  let focusedWindow = null;
  let applicationMenu = null;
  let menuTemplate = null;
  let quitCalls = 0;
  const fakeApp = { on: () => {} };
  const fakeMenu = {
    buildFromTemplate: (template) => {
      menuTemplate = template;
      const items = new Map();
      const visit = list => (list || []).forEach(item => {
        if (item && item.id) items.set(item.id, item);
        if (item && Array.isArray(item.submenu)) visit(item.submenu);
      });
      visit(template);
      applicationMenu = { getMenuItemById: id => items.get(id) || null };
      return applicationMenu;
    },
    setApplicationMenu: () => {}
  };
  const context = {
    BrowserWindow: { getFocusedWindow: () => focusedWindow },
    Menu: fakeMenu,
    app: fakeApp,
    process: { platform: 'win32' },
    closeConfirmWin: null,
    activationWindow: null,
    applicationMenu: null,
    windowMenuItem: null,
    windowMenuBound: new WeakSet(),
    windowMenuListenersInstalled: false,
    checkForUpdatesManual: () => {},
    prepareAppQuit: () => { quitCalls += 1; }
  };
  vm.runInNewContext(`${source}\nthis.__xj = { getFocusedNormalWindow, refreshWindowMenuItem, toggleFocusedNormalWindowMaximize, trackWindowForApplicationMenu, createApplicationMenu };`, context, { filename: MAIN });
  context.__xj.createApplicationMenu();
  const item = applicationMenu.getMenuItemById('xj-window-toggle-maximize');
  assert(item, 'Window maximize item missing');
  assert.strictEqual(typeof item.click, 'function', 'Window maximize item must have a real click handler');
  assert.strictEqual(item.enabled, false, 'No focused window must disable maximize item');

  const normal = makeWindow();
  focusedWindow = normal;
  context.__xj.trackWindowForApplicationMenu(normal);
  context.__xj.refreshWindowMenuItem();
  assert.strictEqual(item.enabled, true, 'Focused normal window must enable maximize item');
  assert.strictEqual(item.label, '最大化窗口', 'Unmaximized window label must be maximize');
  item.click();
  assert.strictEqual(normal.calls.maximize, 1, 'Click must maximize the focused window');
  assert.strictEqual(item.label, '还原窗口', 'Maximized window label must change to restore');
  item.click();
  assert.strictEqual(normal.calls.restore, 1, 'Second click must restore the focused window');
  assert.strictEqual(item.label, '最大化窗口', 'Restored window label must return to maximize');

  focusedWindow = makeWindow({ destroyed: true });
  context.__xj.refreshWindowMenuItem();
  assert.strictEqual(item.enabled, false, 'Destroyed window must be unavailable');
  const unavailable = context.__xj.toggleFocusedNormalWindowMaximize();
  assert.strictEqual(unavailable.ok, false, 'Destroyed window must fail closed');
  assert.strictEqual(unavailable.reason, 'no-focused-normal-window', 'Destroyed window failure reason must be explicit');
  focusedWindow = makeWindow({ modal: true });
  context.__xj.refreshWindowMenuItem();
  assert.strictEqual(item.enabled, false, 'Modal window must be unavailable');
  focusedWindow = makeWindow({ parent: normal });
  context.__xj.refreshWindowMenuItem();
  assert.strictEqual(item.enabled, false, 'Child/utility window must be unavailable');
  assert.strictEqual(quitCalls, 0, 'Window menu must not trigger app quit/tray side effects');
  return { menuTemplate, item, quitCalls };
}

function main() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const source = helperSource(fs.readFileSync(MAIN, 'utf8'));
  execute(source);
  const cardSha = require('crypto').createHash('sha256').update(fs.readFileSync(CARD)).digest('hex').toUpperCase();
  const result = { task_id: TASK, card_sha256: cardSha, result: 'PASS', assertions: 11, source_sha256: require('crypto').createHash('sha256').update(source).digest('hex').toUpperCase() };
  fs.writeFileSync(path.join(SCRATCH, 'contract-result-005.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('WINDOW_MENU_005: PASS assertions=11');
}

if (require.main === module) main();
module.exports = { helperSource, execute };
