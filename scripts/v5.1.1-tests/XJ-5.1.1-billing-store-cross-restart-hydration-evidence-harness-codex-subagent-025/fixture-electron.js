'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session } = require('electron');

const fixtureUrl = String(process.env.XJ_FIXTURE_URL || '');
const userDataDir = path.resolve(String(process.env.XJ_USER_DATA || path.join(process.cwd(), '.xj-025-user-data')));
const expectedOrigin = (() => {
  try { return new URL(fixtureUrl).origin; } catch (_) { return 'http://127.0.0.1:19421'; }
})();
let windowRef = null;
let finished = false;

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function emitError(error, code) {
  process.stderr.write(JSON.stringify({ type: 'electron-error', message: String(error && error.message || error), stack: String(error && error.stack || '') }) + '\n');
  process.exitCode = code || 2;
}

function closeAndQuit(result) {
  if (finished) return;
  finished = true;
  emit({ type: 'fixture-result', userData: userDataDir, origin: expectedOrigin, result });
  if (result && result.forceExit) {
    // Simulate a process ending before a skipped durable promise can settle.
    // process.exit is intentional here: app.exit still gives Chromium's
    // storage task a chance to flush the tiny synthetic batch.
    process.exit(0);
    return;
  }
  try { if (windowRef && !windowRef.isDestroyed()) windowRef.close(); } catch (_) {}
  app.quit();
}

async function run() {
  if (!fixtureUrl) throw new Error('XJ_FIXTURE_URL is required');
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
  // Keep Chromium's session-backed stores (including IndexedDB) inside this
  // phase's isolated profile. The default sessionData path is shared by
  // concurrent Electron fixtures and can make IndexedDB.open fail transiently.
  app.setPath('sessionData', path.join(userDataDir, 's'));
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  await app.whenReady();

  const defaultSession = session.defaultSession;
  if (typeof defaultSession.setPermissionRequestHandler === 'function') {
    defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  }
  if (typeof defaultSession.setPermissionCheckHandler === 'function') {
    defaultSession.setPermissionCheckHandler(() => false);
  }
  defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    let allowed = false;
    try {
      const parsed = new URL(details.url);
      allowed = parsed.origin === expectedOrigin;
    } catch (_) {}
    callback({ cancel: !allowed });
  });

  windowRef = new BrowserWindow({
    width: 1024,
    height: 700,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      webSecurity: true,
    },
  });
  windowRef.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) process.stderr.write(JSON.stringify({ type: 'renderer-console', level, message: String(message) }) + '\n');
  });
  const failure = new Promise((_, reject) => {
    windowRef.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      reject(new Error('fixture load failed ' + errorCode + ' ' + errorDescription + ' ' + validatedURL));
    });
  });
  const loaded = windowRef.loadURL(fixtureUrl);
  await Promise.race([loaded, failure]);
  const result = await windowRef.webContents.executeJavaScript('window.__XJ_FIXTURE_RUN__()', true);
  closeAndQuit(result || { ok: false, error: 'fixture returned no result' });
}

process.on('uncaughtException', (error) => { emitError(error, 2); try { app.quit(); } catch (_) {} });
process.on('unhandledRejection', (error) => { emitError(error, 2); try { app.quit(); } catch (_) {} });

run().catch((error) => {
  emitError(error, 2);
  try { app.quit(); } catch (_) {}
});
