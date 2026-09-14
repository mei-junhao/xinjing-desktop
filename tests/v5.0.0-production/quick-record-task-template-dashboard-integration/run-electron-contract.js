'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electron)) {
  console.error('Electron executable missing: ' + electron);
  process.exit(1);
}
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-qr-electron-'));
try {
  const run = spawnSync(electron, [path.join(__dirname, 'electron-main.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: Object.assign({}, process.env, { XJ_SYNTHETIC_USER_DATA: userData })
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.status !== 0) process.exit(run.status || 1);
  if (!/ELECTRON_RESULT=/.test(run.stdout || '')) {
    console.error('Electron result marker missing');
    process.exit(1);
  }
  console.log('real Electron QuickRecord/task/template contract: PASS');
} finally {
  const resolved = path.resolve(userData);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(resolved, { recursive: true, force: true });
}
