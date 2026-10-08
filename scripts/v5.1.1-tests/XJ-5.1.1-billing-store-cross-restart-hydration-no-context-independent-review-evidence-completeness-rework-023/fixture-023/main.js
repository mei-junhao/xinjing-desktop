// 023 fixture Electron 壳：加载固定 origin（default_app 不支持 URL 参数——用显式 main）
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.commandLine.appendSwitch('remote-allow-origins', '*');
let win = null;
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1366, height: 768, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: false, webSecurity: true }
  });
  const url = process.env.XJ_FIXTURE_URL || 'http://127.0.0.1:19421/billing-calendar.html';
  win.loadURL(url);
  win.webContents.on('did-fail-load', (e, code, desc) => console.error('LOAD FAIL', code, desc));
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 3) console.error('RENDERER ERR:', msg); });
});
app.on('window-all-closed', () => app.quit());