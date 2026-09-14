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
    width: 1024,
    height: 700,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      webSecurity: true,
    },
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('047 LOAD FAIL', code, description, url);
  });
  win.webContents.on('console-message', (_event, _level, message) => {
    console.log(`047 PAGE ${message}`);
  });
  win.loadURL(process.env.XJ_FIXTURE_URL || 'http://127.0.0.1:19421/fixture-047/store-fixture.html');
});

app.on('window-all-closed', () => app.quit());




