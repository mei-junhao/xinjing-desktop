'use strict';

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPiProductionRuntime } = require('../../../app/js/pi/bridge/pi-production-runtime-v1.js');

const TEST_DIR = __dirname;
const requestedUserData = process.env.XJ_AGENT_ACCEPTANCE_USER_DATA || '';
const USER_DATA = path.isAbsolute(requestedUserData)
  ? requestedUserData
  : fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj510-041-electron-'));
app.setPath('userData', USER_DATA);

let mainWindow = null;
let stopped = false;
const membership = process.env.XJ_PI_TEST_MEMBERSHIP === 'unknown' ? null : { tier: 'pro' };

function trusted(event) {
  return !!(mainWindow && !mainWindow.isDestroyed() && event && event.sender
    && event.sender.id === mainWindow.webContents.id);
}

function denyExternalNetwork() {
  try {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['*://*/*', 'ws://*/*', 'wss://*/*'] },
      (details, callback) => {
        const url = String(details && details.url || '');
        callback({ cancel: !(url.startsWith('file://') || url.startsWith('devtools://')) });
      },
    );
  } catch (error) { console.error('[041] network gate install failed:', error && error.message); }
}

app.whenReady().then(() => {
  denyExternalNetwork();
  const runtime = createPiProductionRuntime({
    ipcMain,
    getMainWindow: () => mainWindow,
    isTrustedRendererEvent: trusted,
    userDataDir: USER_DATA,
    serverMembershipProjection: () => membership,
    audit: (entry) => { if (entry && entry.ok === false) console.warn('[041] audit rejected:', String(entry.code || 'unknown')); },
  });
  ipcMain.handle('xj:getState', (event) => trusted(event)
    ? { ok: true, mode: 'trial', tier: membership ? membership.tier : 'free', aiUnlocked: membership !== null, membership: membership ? { tier: membership.tier, status: 'ok', serverAuthoritative: true } : null }
    : { ok: false, errorCode: 'untrusted-renderer' });
  ipcMain.handle('xj:getVersion', (event) => trusted(event) ? '5.1.0-test-041' : '');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(ROOT(), 'preload.js'),
    },
  });
  const page = String(process.env.XJ_PI_TEST_PAGE || 'harness.html').replace(/[^A-Za-z0-9_.-]/g, '');
  mainWindow.loadFile(path.join(TEST_DIR, page || 'harness.html'));
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('closed', () => {
    if (stopped) return;
    stopped = true;
    runtime.stop();
    app.quit();
  });
});

function ROOT() { return path.resolve(TEST_DIR, '../../../'); }
app.on('window-all-closed', () => { if (!stopped) app.quit(); });
