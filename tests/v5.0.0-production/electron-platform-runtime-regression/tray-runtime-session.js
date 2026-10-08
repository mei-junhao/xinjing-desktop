'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const electron = require('electron');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const artifactPath = process.env.XJ_TRAY_ACCEPTANCE_ARTIFACT || path.join(__dirname, 'artifacts', 'tray-runtime-session.json');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-tray-acceptance-'));
const iconPath = path.join(ROOT, 'build', 'icon.png');
const state = {
  task_id: 'XJ-5.0.0-codex-v4.5-electron-platform-runtime-regression-06',
  process_id: process.pid,
  synthetic_profile_only: true,
  temp_root: tempRoot,
  production_main_loaded: false,
  tray_constructed: false,
  tray_constructor_count: 0,
  tray_tooltip: null,
  tray_menu_opened: false,
  login_item_call_intercepted: false,
  login_item_call_count: 0,
  icon_sha256: fs.existsSync(iconPath) ? crypto.createHash('sha256').update(fs.readFileSync(iconPath)).digest('hex').toUpperCase() : null,
  ready_at: null,
  error: null
};

function writeState() {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify(state, null, 2) + '\n');
}

function cleanupTemporaryProfile() {
  const resolved = path.resolve(tempRoot);
  const tempPrefix = path.resolve(tempRoot, '..') + path.sep;
  if (!resolved.toLowerCase().startsWith(tempPrefix.toLowerCase()) || !path.basename(resolved).startsWith('xj-tray-acceptance-')) return;
  try { fs.rmSync(resolved, { recursive: true, force: true }); } catch (_) {}
}

electron.app.setPath('appData', tempRoot);

const OriginalTray = electron.Tray;
const originalSetToolTip = OriginalTray.prototype.setToolTip;
OriginalTray.prototype.setToolTip = function observedSetToolTip(value) {
  state.tray_constructed = true;
  state.tray_constructor_count += 1;
  state.tray_tooltip = String(value || '');
  writeState();
  setTimeout(() => {
    try {
      state.tray_menu_opened = true;
      writeState();
      this.popUpContextMenu();
    } catch (error) {
      state.error = 'tray menu: ' + String(error && error.message || error);
      writeState();
    }
  }, 3000);
  return originalSetToolTip.call(this, value);
};

const interceptedSetLoginItemSettings = function interceptedSetLoginItemSettings() {
  state.login_item_call_intercepted = true;
  state.login_item_call_count += 1;
  writeState();
};
electron.app.setLoginItemSettings = interceptedSetLoginItemSettings;
if (electron.app.setLoginItemSettings !== interceptedSetLoginItemSettings) {
  throw new Error('setLoginItemSettings could not be intercepted safely');
}

delete process.env.XJ_AGENT_ACCEPTANCE;
delete process.env.XJ_AGENT_ACCEPTANCE_USER_DATA;

electron.app.once('ready', () => {
  state.ready_at = new Date().toISOString();
  setTimeout(writeState, 2500);
});

process.once('SIGTERM', () => electron.app.exit(0));
process.once('exit', cleanupTemporaryProfile);
setTimeout(() => electron.app.exit(0), 120000).unref();

try {
  require(path.join(ROOT, 'main.js'));
  state.production_main_loaded = true;
  writeState();
} catch (error) {
  state.error = String(error && error.stack || error);
  writeState();
  throw error;
}
