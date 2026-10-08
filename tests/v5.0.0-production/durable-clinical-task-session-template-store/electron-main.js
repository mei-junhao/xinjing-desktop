'use strict';

const path = require('path');
const { app, BrowserWindow, session } = require('electron');

const userData = process.env.XJ_SYNTHETIC_USER_DATA;
if (!userData) throw new Error('XJ_SYNTHETIC_USER_DATA is required');
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-background-networking');

function loaded(webContents) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron fixture load timed out')), 20000);
    webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timer);
      reject(new Error('Electron fixture failed to load: ' + code + ' ' + description));
    });
  });
}

async function run() {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true })
  );
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const fixture = path.join(__dirname, 'electron-fixture.html');
  const firstLoad = loaded(win.webContents);
  await win.loadFile(fixture);
  await firstLoad;

  const created = await win.webContents.executeJavaScript(`(async () => {
    await Store.hydrate();
    const client = await Store.createClientDurable({ id: 'electron-client-a', name: 'Synthetic Electron A' });
    const session = await Store.createSessionDurable({ id: 'electron-session-a1', clientId: 'electron-client-a', sessionNumber: 1, marker: 'electron-keep' });
    const task = await Store.createClinicalTaskDurable({
      id: 'electron-task-a1', clientId: 'electron-client-a', originSessionId: 'electron-session-a1',
      title: 'Synthetic Electron follow-up', status: 'open', sourceRefs: ['electron-source-a1'],
      target: 'consult-notes.html', createdBy: 'manual'
    });
    const template = await Store.saveSessionTemplateSelectionDurable('electron-session-a1', {
      templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual'
    });
    let networkDenied = false;
    try { await fetch('https://example.com/xinjing-synthetic-probe'); } catch (_error) { networkDenied = true; }
    return { client: client.ok, session: session.ok, task: task.ok, template: template.ok, networkDenied };
  })()`);
  if (!created.client || !created.session || !created.task || !created.template || !created.networkDenied) {
    throw new Error('Electron create phase failed: ' + JSON.stringify(created));
  }

  const reload = loaded(win.webContents);
  win.webContents.reloadIgnoringCache();
  await reload;
  const verified = await win.webContents.executeJavaScript(`(async () => {
    await Store.hydrate();
    const task = Store.getClinicalTask('electron-task-a1');
    const selection = Store.getSessionTemplateSelection('electron-session-a1');
    const session = Store.getSession('electron-session-a1');
    return {
      taskPersisted: !!task && task.clientId === 'electron-client-a' && task.originSessionId === 'electron-session-a1',
      sourceRefs: task ? task.sourceRefs : [],
      templatePersisted: !!selection && selection.templateId === 'manual-session-v1',
      unrelatedSessionField: session && session.marker,
      diagnostics: Store.getStorageDiagnostics()
    };
  })()`);
  if (!verified.taskPersisted || !verified.templatePersisted || verified.unrelatedSessionField !== 'electron-keep') {
    throw new Error('Electron reload phase failed: ' + JSON.stringify(verified));
  }
  console.log('ELECTRON_RESULT=' + JSON.stringify({ created, verified }));
  win.destroy();
  app.quit();
}

run().catch((error) => {
  console.error(error && error.stack || error);
  app.exit(1);
});
