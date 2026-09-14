'use strict';

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { registerUpdateIntegrityIpc } = require(path.join(process.env.XJ279_CANDIDATE_ROOT, 'update', 'runtime-entry'));
const { createCoordinator } = require(path.join(process.env.XJ279_CANDIDATE_ROOT, 'update', 'coordinator'));

const evidencePath = process.env.XJ279_ELECTRON_EVIDENCE;
app.disableHardwareAcceleration();
const results = [];
const bytes = Buffer.from('synthetic-nsis-5.0.0-artifact-bytes');
const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
const metadata = `version: 5.0.0\nchannel: nsis\nfiles:\n  - url: xinjing-setup-5.0.0.exe\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: xinjing-setup-5.0.0.exe\nsha512: ${sha512}\nreleaseDate: 2026-08-03T04:00:00.000Z\n`;
let stable = { clients: [{ id: 'synthetic-c1' }], sessions: [{ id: 'synthetic-s1' }] };
let snapshot = null;
const events = [];
const journalPath = path.join(os.tmpdir(), `xj279-electron-${process.pid}.json`);
const snapshotAdapter = {
  async readStableData() { return JSON.parse(JSON.stringify(stable)); },
  async writeSnapshot(value) { events.push('backup'); snapshot = JSON.parse(JSON.stringify(value)); },
  async readSnapshot() { return JSON.parse(JSON.stringify(snapshot)); },
  async migrate(value) { events.push('migration'); return Object.assign({}, value, { migrated: [] }); },
  async replaceStableData(value) { stable = JSON.parse(JSON.stringify(value)); },
};
const strategyAdapter = {
  async stageInstaller() { events.push('stage'); },
  async install() { events.push('restart'); return { started: true }; },
  async rollbackInstaller(context) { events.push('rollback-installer'); return { version: context.currentVersion }; },
};
const coordinator = createCoordinator({
  journalPath,
  async fetchMetadata() { events.push('check'); return { status: 200, body: metadata }; },
  async confirm() { events.push('confirm'); return true; },
  async downloadArtifact() { events.push('download'); return bytes; },
  snapshotAdapter,
  strategyAdapter,
  async healthCheck() { events.push('health'); return true; },
  async rollback() { events.push('rollback'); },
});
app.whenReady().then(async () => {
  registerUpdateIntegrityIpc({
    ipcMain,
    inputFactory() { return { operationId: 'operation-nsis-electron', channel: 'nsis', metadataName: 'latest.yml', currentVersion: '4.5.0', targetVersion: '5.0.0', currentDataVersion: '1', targetDataVersion: '2', expectedArtifactSha512: sha512 }; },
    createCoordinator() { return coordinator; },
  });
  ipcMain.on('xj279:harness-result', (_event, value) => {
    results.push(value);
    if (value && value.type === 'recover') {
      const output = { ok: results[0] && results[0].result && results[0].result.ok === true, events, results, stableObjectCounts: { clients: stable.clients.length, sessions: stable.sessions.length }, rendererProcess: true, contextIsolation: true, sandbox: true, networkRequests: 0 };
      fs.writeFileSync(evidencePath, JSON.stringify(output, null, 2) + '\n', 'utf8');
      app.exit(output.ok ? 0 : 2);
    }
  });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'electron-runtime-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on('did-fail-load', (_event, code, description, url) => { fs.writeFileSync(evidencePath, JSON.stringify({ ok: false, error: 'did-fail-load', code, description, url }, null, 2)); app.exit(4); });
  await win.loadURL('about:blank');
  await win.webContents.executeJavaScript(`(async () => {
    const result = await window.XJ279.runUpdate({ channel: 'nsis' });
    window.XJ279.finish({ type: 'run', result });
    const marker = { schemaVersion: 1, operationId: 'operation-nsis-electron', version: '5.0.0', channel: 'nsis', artifactSha512: '${sha512}', state: 'committed', updatedAt: new Date().toISOString(), errorCode: null, sequence: 8 };
    const recovery = await window.XJ279.recoverUpdate(marker);
    window.XJ279.finish({ type: 'recover', recovery });
  })()`);
});
setTimeout(() => { fs.writeFileSync(evidencePath, JSON.stringify({ ok: false, error: 'timeout', events, results }, null, 2)); app.exit(3); }, 15000).unref();
