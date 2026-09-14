'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electron)) {
  process.stderr.write('Electron executable missing: ' + electron + '\n');
  process.exit(1);
}
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-later-session-electron-'));
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
  const marker = String(run.stdout || '').split(/\r?\n/).find((line) => line.startsWith('ELECTRON_RESULT='));
  if (!marker) throw new Error('Electron result marker missing');
  const result = JSON.parse(marker.slice('ELECTRON_RESULT='.length));
  if (!result.pass) throw new Error('Electron assertions failed');
  process.stdout.write('real Electron later-session projection: PASS\n');
} finally {
  const resolved = path.resolve(userData);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(resolved, { recursive: true, force: true });
}
