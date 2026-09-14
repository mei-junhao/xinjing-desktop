'use strict';
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPiProductionRuntime } = require('../../../app/js/pi/bridge/pi-production-runtime-v1.js');
const requested = process.env.XJ_AGENT_ACCEPTANCE_USER_DATA || '';
const userData = path.isAbsolute(requested) ? requested : fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-013-electron-'));
app.setPath('userData', userData);
let mainWindow = null;
let runtime = null;
function trusted(event) { return !!(mainWindow && !mainWindow.isDestroyed() && event && event.sender && event.sender.id === mainWindow.webContents.id); }
function denyNetwork() {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const url = String(details && details.url || '');
    callback({ cancel: !(url.startsWith('file://') || url.startsWith('devtools://')) });
  });
}
app.whenReady().then(() => {
  denyNetwork();
  runtime = createPiProductionRuntime({
    ipcMain,
    getMainWindow: () => mainWindow,
    isTrustedRendererEvent: trusted,
    userDataDir: userData,
    serverMembershipProjection: () => process.env.XJ_PI_TEST_MEMBERSHIP === 'unknown' ? null : { tier: 'pro' },
  });
  ipcMain.handle('xj:getState', (event) => trusted(event) ? { ok: true, tier: process.env.XJ_PI_TEST_MEMBERSHIP === 'unknown' ? 'free' : 'pro' } : { ok: false, code: 'untrusted' });
  mainWindow = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, preload: path.join(__dirname, '../../../preload.js') } });
  mainWindow.loadFile(path.join(__dirname, 'harness-clinical.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { if (runtime) runtime.stop(); runtime = null; app.quit(); });
});
app.on('window-all-closed', () => app.quit());
