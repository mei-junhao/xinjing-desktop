'use strict';

const { app, BrowserWindow, session } = require('electron');

app.commandLine.appendSwitch('remote-allow-origins', '*');
app.commandLine.appendSwitch('disable-gpu');

function isAllowed(url) {
  return String(url || '').startsWith('http://127.0.0.1:19421/');
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    callback({ cancel: !isAllowed(details.url) });
  });
  const win = new BrowserWindow({
    width: Number(process.env.XJ_W || 1024),
    height: Number(process.env.XJ_H || 700),
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: false, webSecurity: true },
  });
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error('049 LOAD FAIL', code, description, url);
  });
  win.webContents.on('console-message', (_e, _l, message) => {
    console.log(`049 PAGE ${message}`);
  });
  win.loadURL(process.env.XJ_FIXTURE_URL || 'http://127.0.0.1:19421/index.html');
  const { CDP_READY } = process.env;
  win.webContents.once('did-finish-load', () => console.log('049 READY', win.webContents.getURL()));
});

app.on('window-all-closed', () => app.quit());
