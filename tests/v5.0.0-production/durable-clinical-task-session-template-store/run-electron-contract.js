'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const MAIN = path.join(__dirname, 'electron-main.js');

function main() {
  assert.ok(fs.existsSync(ELECTRON), 'Electron runtime must exist at the project-pinned path');
  const tempRoot = fs.realpathSync(os.tmpdir());
  const userData = fs.mkdtempSync(path.join(tempRoot, 'xj-v43-store-'));
  try {
    const result = childProcess.spawnSync(ELECTRON, [MAIN], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { XJ_SYNTHETIC_USER_DATA: userData }),
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error('Electron contract exited ' + result.status + '\n' + String(result.stderr || result.stdout || ''));
    }
    const line = String(result.stdout || '').split(/\r?\n/).find((item) => item.startsWith('ELECTRON_RESULT='));
    assert.ok(line, 'Electron contract must emit a structured result');
    const payload = JSON.parse(line.slice('ELECTRON_RESULT='.length));
    assert.strictEqual(payload.created.networkDenied, true, 'Electron fixture must deny network');
    assert.strictEqual(payload.verified.taskPersisted, true, 'clinical task must survive a real Electron reload');
    assert.deepStrictEqual(payload.verified.sourceRefs, ['electron-source-a1'], 'real Electron persistence must retain identifier-only source refs');
    assert.strictEqual(payload.verified.templatePersisted, true, 'template selection must survive a real Electron reload');
    assert.strictEqual(payload.verified.unrelatedSessionField, 'electron-keep', 'template persistence must preserve unrelated session fields');
    assert.deepStrictEqual(payload.verified.diagnostics, [], 'healthy Electron persistence must not emit diagnostics');
    console.log('real Electron durable Store contract: PASS 6/6');
  } finally {
    const resolved = path.resolve(userData);
    assert.ok(resolved.startsWith(tempRoot + path.sep), 'cleanup target must remain inside the system temp directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

try { main(); }
catch (error) {
  console.error(error && error.stack || error);
  process.exit(1);
}
