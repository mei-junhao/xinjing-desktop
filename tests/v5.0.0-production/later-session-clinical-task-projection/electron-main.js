'use strict';

const path = require('path');
const { app, BrowserWindow, session } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const appDir = process.env.XJ_APP_DIR || path.join(ROOT, 'app');
if (!process.env.XJ_SYNTHETIC_USER_DATA) throw new Error('XJ_SYNTHETIC_USER_DATA is required');
app.setPath('userData', process.env.XJ_SYNTHETIC_USER_DATA);
app.commandLine.appendSwitch('disable-background-networking');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(win, expression, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (await win.webContents.executeJavaScript('Boolean(' + expression + ')', true)) return;
    } catch (_) {}
    await sleep(50);
  }
  throw new Error('Timed out waiting for ' + expression);
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const errors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1366,
    height: 768,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.webContents.on('console-message', (_event, level, message) => {
    const benignElectronDevWarning = /Electron Security Warning \(Insecure Content-Security-Policy\)/.test(message);
    if (level >= 2 && !/favicon|ERR_FILE_NOT_FOUND/.test(message) && !benignElectronDevWarning) errors.push(message);
  });
  await win.loadFile(path.join(appDir, 'consult-notes.html'));
  await waitFor(win, 'window.Store && Store.isHydrated && Store.isHydrated()', 15000);

  const setup = await win.webContents.executeJavaScript(`(async function () {
    const clientA = await Store.createClientDurable({ id:'SYN-C01', name:'合成来访者甲', status:'active' });
    const clientB = await Store.createClientDurable({ id:'SYN-C02', name:'合成来访者乙', status:'active' });
    if (!clientA.ok || !clientB.ok) return { ok:false, stage:'clients' };
    const s1 = await Store.createSessionDurable({ id:'SYN-SA', clientId:'SYN-C01', sessionNumber:1, date:'2026-07-01', notes:'synthetic-a' });
    const s2 = await Store.createSessionDurable({ id:'SYN-SB', clientId:'SYN-C01', sessionNumber:2, date:'2026-07-15', notes:'synthetic-b' });
    const s3 = await Store.createSessionDurable({ id:'SYN-SC', clientId:'SYN-C02', sessionNumber:1, date:'2026-07-10', notes:'synthetic-c' });
    if (!s1.ok || !s2.ok || !s3.ok) return { ok:false, stage:'sessions' };
    const tasks = [
      { id:'SYN-T-PRIOR', clientId:'SYN-C01', originSessionId:'SYN-SA', title:'跨会谈继续跟进的合成任务', status:'open', sourceRefs:['session:SYN-SA'], target:'consult-notes.html', createdBy:'manual' },
      { id:'SYN-T-CURRENT', clientId:'SYN-C01', originSessionId:'SYN-SB', title:'本节合成任务', status:'open', sourceRefs:['session:SYN-SB'], target:'consult-notes.html', createdBy:'manual' },
      { id:'SYN-T-DRAFT', clientId:'SYN-C01', originSessionId:'SYN-SA', title:'待确认合成任务', status:'ai-draft', sourceRefs:['session:SYN-SA'], target:'consult-notes.html', createdBy:'ai-draft', actionRunId:'SYN-RUN-01' },
      { id:'SYN-T-DONE', clientId:'SYN-C01', originSessionId:'SYN-SA', title:'已完成合成任务', status:'open', sourceRefs:['session:SYN-SA'], target:'consult-notes.html', createdBy:'manual' },
      { id:'SYN-T-OTHER', clientId:'SYN-C02', originSessionId:'SYN-SC', title:'其他来访者合成任务', status:'open', sourceRefs:['session:SYN-SC'], target:'consult-notes.html', createdBy:'manual' },
      { id:'SYN-T-LONG', clientId:'SYN-C01', originSessionId:'SYN-SA', title:'这是一条用于验证很长中文标题能够正常换行且不会造成横向滚动的合成临床任务标题'.repeat(4), status:'open', sourceRefs:['session:SYN-SA'], target:'consult-notes.html', createdBy:'manual' }
    ];
    for (const task of tasks) {
      const saved = task.status === 'ai-draft' ? await Store.createAiDraftClinicalTaskDurable(task) : await Store.createClinicalTaskDurable(task);
      if (!saved.ok) return { ok:false, stage:'task-' + task.id, error:saved.error };
    }
    const done = await Store.transitionClinicalTaskDurable('SYN-T-DONE', 'done');
    return { ok:done.ok === true };
  })()`, true);
  if (!setup || !setup.ok) throw new Error('Synthetic setup failed: ' + JSON.stringify(setup));

  await win.loadFile(path.join(appDir, 'consult-notes.html'), { query: { clientId: 'SYN-C01', sessionId: 'SYN-SB' } });
  await waitFor(win, "document.querySelectorAll('[data-clinical-task-id]').length === 4", 15000);
  const later = await win.webContents.executeJavaScript(`(function () {
    const rows = Array.from(document.querySelectorAll('[data-clinical-task-id]'));
    const ids = rows.map((row) => row.dataset.clinicalTaskId);
    const text = document.getElementById('clinical-task-context').textContent;
    const section = document.getElementById('clinical-task-context');
    return {
      ids, text, hidden:section.hidden,
      overflow:section.scrollWidth > section.clientWidth,
      imageCount:section.querySelectorAll('img').length,
      summary:document.getElementById('clinical-task-summary').textContent
    };
  })()`, true);
  const passLater = !later.hidden && later.ids.length === 4 &&
    later.ids.includes('SYN-T-PRIOR') && later.ids.includes('SYN-T-CURRENT') && later.ids.includes('SYN-T-DRAFT') && later.ids.includes('SYN-T-LONG') &&
    !later.ids.includes('SYN-T-DONE') && !later.ids.includes('SYN-T-OTHER') &&
    /源自第1节/.test(later.text) && /本节创建/.test(later.text) && /待确认/.test(later.text) && !later.overflow && later.imageCount === 0;

  const switched = await win.webContents.executeJavaScript(`(function () {
    const client = document.getElementById('sel-client'); client.value = 'SYN-C02'; onClientChange();
    const session = document.getElementById('sel-session'); session.value = 'SYN-SC'; onSessionChange();
    const ids = Array.from(document.querySelectorAll('[data-clinical-task-id]')).map((row) => row.dataset.clinicalTaskId);
    return { ids, summary:document.getElementById('clinical-task-summary').textContent };
  })()`, true);
  const passSwitch = switched.ids.length === 1 && switched.ids[0] === 'SYN-T-OTHER';

  const invalidSession = await win.webContents.executeJavaScript(`(function () {
    const client = document.getElementById('sel-client'); client.value = 'SYN-C01'; onClientChange();
    const session = document.getElementById('sel-session');
    session.add(new Option('missing synthetic session', 'SYN-MISSING'));
    session.value = 'SYN-MISSING';
    onSessionChange();
    return {
      ids:Array.from(document.querySelectorAll('[data-clinical-task-id]')).map((row) => row.dataset.clinicalTaskId),
      summary:document.getElementById('clinical-task-summary').textContent,
      error:document.querySelector('.clinical-task-error') && document.querySelector('.clinical-task-error').textContent
    };
  })()`, true);
  const passInvalidSession = invalidSession.ids.length === 0 && /会谈不可用/.test(invalidSession.summary || '') && /当前会谈不存在/.test(invalidSession.error || '');

  const failure = await win.webContents.executeJavaScript(`(function () {
    window.ClinicalTaskViewModel = null;
    window.renderClinicalTaskContext();
    return {
      count:document.querySelectorAll('[data-clinical-task-id]').length,
      error:document.querySelector('.clinical-task-error') && document.querySelector('.clinical-task-error').textContent
    };
  })()`, true);
  const passFailure = failure.count === 0 && /暂时不可用/.test(failure.error || '');

  const result = { pass: passLater && passSwitch && passInvalidSession && passFailure && errors.length === 0, later, switched, invalidSession, failure, consoleErrors: errors };
  process.stdout.write('ELECTRON_RESULT=' + JSON.stringify(result) + '\n');
  await win.close();
  app.exit(result.pass ? 0 : 1);
}).catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  app.exit(1);
});
