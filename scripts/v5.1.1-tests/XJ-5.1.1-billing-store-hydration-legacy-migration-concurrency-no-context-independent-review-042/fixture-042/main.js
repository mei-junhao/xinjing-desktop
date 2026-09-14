const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('remote-allow-origins', '*');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1024, height: 700, show: false, webPreferences: { nodeIntegration: false, contextIsolation: false, webSecurity: true } });
  win.loadURL(process.env.XJ_FIXTURE_URL || 'http://127.0.0.1:19421/fixture-042/store-fixture.html');
  win.webContents.on('did-fail-load', (e, code, desc) => console.error('LOAD FAIL', code, desc));
});
app.on('window-all-closed', () => app.quit());