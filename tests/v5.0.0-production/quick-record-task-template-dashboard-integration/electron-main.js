'use strict';

const path = require('path');
const { app, BrowserWindow, session } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const userData = process.env.XJ_SYNTHETIC_USER_DATA;
if (!userData) throw new Error('XJ_SYNTHETIC_USER_DATA is required');
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-background-networking');

function waitForLoad(webContents) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron page load timed out')), 30000);
    webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timer);
      reject(new Error('Electron page failed to load: ' + code + ' ' + description));
    });
  });
}

async function reload(win) {
  const ready = waitForLoad(win.webContents);
  win.webContents.reloadIgnoringCache();
  await ready;
}

async function run() {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true })
  );
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 700,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const index = path.join(ROOT, 'app', 'index.html');
  const loaded = waitForLoad(win.webContents);
  await win.loadFile(index);
  await loaded;

  const seed = await win.webContents.executeJavaScript(`(async () => {
    await Store.hydrate();
    if (!Store.getClient('electron-qr-client')) {
      const created = await Store.createClientDurable({ id: 'electron-qr-client', name: '合成来访者甲' });
      if (!created.ok) return { ok: false, stage: 'client', created };
    }
    if (App.setActiveClientId) App.setActiveClientId('electron-qr-client');
    return { ok: true };
  })()`);
  if (!seed.ok) throw new Error('Electron seed failed: ' + JSON.stringify(seed));
  await reload(win);

  const success = await win.webContents.executeJavaScript(`(async () => {
    await Store.hydrate();
    if (App.setActiveClientId) App.setActiveClientId('electron-qr-client');
    if (typeof openQuickRecord !== 'function') return { ok: false, stage: 'open-missing' };
    openQuickRecord();
    const overlay = document.getElementById('qr-overlay');
    const panel = overlay && overlay.querySelector('.qr-panel');
    const taskInput = document.getElementById('qr-task-titles');
    const notes = document.getElementById('qr-notes');
    const template = document.getElementById('qr-template');
    if (!overlay || !panel || !taskInput || !notes || !template) return { ok: false, stage: 'controls' };
    const longTitle = '合成后续任务'.repeat(12);
    notes.value = '合成会谈备注';
    taskInput.value = longTitle + '\\n第二条合成任务';
    document.getElementById('qr-submit').click();
    const until = Date.now() + 10000;
    while (Date.now() < until && !document.querySelector('#qr-result .qr-success')) await new Promise((resolve) => setTimeout(resolve, 25));
    const result = window.QuickRecord._state;
    const sessions = Store.getSessionsByClient('electron-qr-client');
    const saved = sessions[sessions.length - 1];
    const tasks = Store.getClinicalTasksByClient('electron-qr-client');
    let networkDenied = false;
    try { await fetch('https://example.com/xinjing-qr-probe'); } catch (_error) { networkDenied = true; }
    return {
      ok: !!document.querySelector('#qr-result .qr-success'),
      sessionId: saved && saved.id,
      taskIds: tasks.map((task) => task.id),
      titles: tasks.map((task) => task.title),
      selection: saved && saved.templateSelection,
      noFee: !document.getElementById('qr-fee'),
      notesFocusedInitially: document.activeElement === notes || !!notes,
      switchAllowed: QuickRecord.canSwitchAway().allowed,
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      networkDenied,
      completionCleared: result.completionDraft === null
    };
  })()`);
  if (!success.ok || !success.sessionId || success.taskIds.length !== 2 || !success.selection || !success.noFee || !success.switchAllowed || !success.noHorizontalOverflow || !success.networkDenied || !success.completionCleared) {
    throw new Error('Electron success flow failed: ' + JSON.stringify(success));
  }

  await reload(win);
  const reloadAndComplete = await win.webContents.executeJavaScript(`(async () => {
    await Store.hydrate();
    const before = Store.getClinicalTask(${JSON.stringify(success.taskIds[0])});
    const selection = Store.getSessionTemplateSelection(${JSON.stringify(success.sessionId)});
    const button = document.querySelector('[data-task-complete="' + ${JSON.stringify(success.taskIds[0])} + '"]');
    if (!button) return { ok: false, stage: 'task-button', before, selection };
    button.click();
    const until = Date.now() + 10000;
    while (Date.now() < until && Store.getClinicalTask(${JSON.stringify(success.taskIds[0])}).status !== 'done') await new Promise((resolve) => setTimeout(resolve, 25));
    const after = Store.getClinicalTask(${JSON.stringify(success.taskIds[0])});
    return { ok: !!before && !!selection && after && after.status === 'done', beforeStatus: before && before.status, afterStatus: after && after.status };
  })()`);
  if (!reloadAndComplete.ok) throw new Error('Electron reload/completion failed: ' + JSON.stringify(reloadAndComplete));

  const failureRetry = await win.webContents.executeJavaScript(`(async () => {
    QuickRecord.reset();
    const original = Store.saveClinicalTasksDurable;
    let failOnce = true;
    Store.saveClinicalTasksDurable = async function (tasks) {
      if (failOnce) { failOnce = false; return { ok: false, error: { code: 'SYNTHETIC_TASK_FAILURE', message: 'synthetic task failure' } }; }
      return original.call(Store, tasks);
    };
    openQuickRecord();
    const taskInput = document.getElementById('qr-task-titles');
    taskInput.value = '失败后保留的合成任务';
    document.getElementById('qr-submit').click();
    let until = Date.now() + 10000;
    while (Date.now() < until && !document.querySelector('#qr-result .qr-error')) await new Promise((resolve) => setTimeout(resolve, 25));
    const firstSessionId = QuickRecord._state.lockedSessionId;
    const retained = taskInput.value;
    const draft = QuickRecord.recoverDraft();
    document.getElementById('qr-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const blockedEscape = document.getElementById('qr-overlay').style.display !== 'none';
    document.getElementById('qr-submit').click();
    until = Date.now() + 10000;
    while (Date.now() < until && !document.querySelector('#qr-result .qr-success')) await new Promise((resolve) => setTimeout(resolve, 25));
    const secondSessionId = QuickRecord._state.lockedSessionId;
    Store.saveClinicalTasksDurable = original;
    return {
      ok: !!document.querySelector('#qr-result .qr-success'),
      retained,
      draftTitles: draft && draft.taskTitles,
      blockedEscape,
      sameSession: firstSessionId === secondSessionId,
      matchingTasks: Store.getClinicalTasksByClient('electron-qr-client').filter((task) => task.title === '失败后保留的合成任务').length
    };
  })()`);
  if (!failureRetry.ok || failureRetry.retained !== '失败后保留的合成任务' || !failureRetry.draftTitles || !failureRetry.blockedEscape || !failureRetry.sameSession || failureRetry.matchingTasks !== 1) {
    throw new Error('Electron failure/retry failed: ' + JSON.stringify(failureRetry));
  }

  await win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  });
  const reducedMotion = await win.webContents.executeJavaScript(`({
    matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
    transition: getComputedStyle(document.querySelector('.qr-followup')).transitionDuration
  })`);
  win.webContents.debugger.detach();
  if (!reducedMotion.matches || !/^0s/.test(reducedMotion.transition)) {
    throw new Error('Reduced-motion check failed: ' + JSON.stringify(reducedMotion));
  }

  console.log('ELECTRON_RESULT=' + JSON.stringify({ success, reloadAndComplete, failureRetry, reducedMotion }));
  win.destroy();
  app.quit();
}

run().catch((error) => {
  console.error(error && error.stack || error);
  app.exit(1);
});
