'use strict';
const { app, BrowserWindow, session, ipcMain } = require('electron');
const fsz = require('fs');
const pathz = require('path');

// 授权复用投影（083 先例）：从临时 userData 的 license.json 构造 state 投影，不触网
ipcMain.handle('xj:getState', () => {
  try {
    const lic = JSON.parse(fsz.readFileSync(pathz.join(app.getPath('userData'), 'license.json'), 'utf8'));
    const claim = lic && lic.claim || {};
    const notExpired = !claim.expiresAt || new Date(claim.expiresAt) > new Date();
    return {
      mode: 'full', activated: true, tier: notExpired ? (claim.tier || 'pro') : null,
      aiUnlocked: notExpired, aiTrialActive: false, expired: !notExpired,
      expiresAt: claim.expiresAt || 0, daysLeft: 60, identity: null,
    };
  } catch (e) { return { mode: null, tier: null, aiUnlocked: false }; }
});
ipcMain.handle('xj:getVersion', () => '5.1.1-007r-fixture');
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.commandLine.appendSwitch('disable-gpu');
function isAllowed(url) { return String(url || '').startsWith('http://127.0.0.1:19421/'); }
if (process.env.XJ_USER_DATA) { try { app.setPath('userData', process.env.XJ_USER_DATA); fsz.mkdirSync(process.env.XJ_USER_DATA, { recursive: true }); } catch (e) {} }
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (d, cb) => cb({ cancel: !isAllowed(d.url) }));
  const win = new BrowserWindow({
    width: Number(process.env.XJ_W || 1366), height: Number(process.env.XJ_H || 768), show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: true, preload: pathz.join('D:/xinjing-electron', 'preload.js') },
  });
  win.webContents.on('did-fail-load', (_e, c, d2, u) => console.error('007r LOAD FAIL', c, d2, u));
  win.webContents.on('console-message', (_e, _l, m) => console.log(`007r PAGE ${m}`));
  win.webContents.once('did-finish-load', () => console.log('007r READY', win.webContents.getURL()));
  win.loadURL(process.env.XJ_FIXTURE_URL || 'http://127.0.0.1:19421/masters.html');
});
app.on('window-all-closed', () => app.quit());
